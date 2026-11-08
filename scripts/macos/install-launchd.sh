#!/bin/bash
# 生成并加载 launchd LaunchAgent。
#
# 为什么直接 exec node 而不是 /bin/bash 包一层：
#   1. macOS 的 TCC 按「可执行文件」授权。走 bash 就要给 /bin/bash 完全磁盘访问，
#      那等于给所有脚本放行；直接跑 node 只需要给一个二进制授权。
#   2. launchd 环境里 bash 的 getcwd 在受保护目录下会直接被拒，
#      node 配合 WorkingDirectory 更稳定。
#
# 三个代理互相独立：
#   local.rewards.api      常驻，KeepAlive
#   local.rewards.monitor  常驻，KeepAlive
#   local.rewards.daily    每天 00:00 触发一次，不 KeepAlive（时间取 .env 的 REWARDS_DAILY_*）

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1
source scripts/macos/lib.sh

require_node

AGENT_DIR="$HOME/Library/LaunchAgents"
mkdir -p "$AGENT_DIR" "$LOG_DIR"

HOUR="${REWARDS_DAILY_HOUR:-0}"
MINUTE="${REWARDS_DAILY_MINUTE:-0}"
if [[ ! "$HOUR" =~ ^[0-9]{1,2}$ ]] || [[ ! "$MINUTE" =~ ^[0-9]{1,2}$ ]] || \
    (( 10#$HOUR > 23 || 10#$MINUTE > 59 )); then
    echo "错误：REWARDS_DAILY_HOUR / MINUTE 必须在 00:00–23:59 内" >&2
    exit 1
fi
HOUR="$((10#$HOUR))"
MINUTE="$((10#$MINUTE))"
SCHEDULE_TIME_ZONE="Asia/Shanghai"
HOST_TIME_ZONE="$(/usr/bin/env -u TZ "$NODE_BIN" -p 'Intl.DateTimeFormat().resolvedOptions().timeZone')"
if [[ "$HOST_TIME_ZONE" != "$SCHEDULE_TIME_ZONE" ]]; then
    echo "提示：launchd 日历按系统时区 $HOST_TIME_ZONE 触发；每日补跑按 $SCHEDULE_TIME_ZONE 检查。精确上海零点触发需系统时区保持上海。" >&2
fi

# --only <label>  只重新生成并加载指定的一个代理，不影响其它服务
ONLY=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --only)
            ONLY="${2:-}"
            shift 2
            ;;
        *)
            shift
            ;;
    esac
done

want() {
    [[ -z "$ONLY" ]] || [[ "$ONLY" == "$1" ]]
}

load_agent() {
    local label="$1" plist="$2" target="gui/$(id -u)/$1" attempt
    if launchctl print "$target" >/dev/null 2>&1; then
        launchctl bootout "$target" || return 1
    fi
    for attempt in {1..25}; do
        if ! launchctl print "$target" >/dev/null 2>&1; then break; fi
        sleep 0.2
    done
    if launchctl print "$target" >/dev/null 2>&1; then
        echo "卸载 ${label} 超时，未覆盖仍在注册的代理" >&2
        return 1
    fi
    local error_file
    error_file="$(mktemp)"
    for attempt in {1..25}; do
        launchctl bootstrap "gui/$(id -u)" "$plist" 2>"$error_file" || true
        if launchctl print "$target" >/dev/null 2>&1; then
            rm -f "$error_file"
            echo "已加载 ${label}"
            return 0
        fi
        sleep 0.2
    done
    cat "$error_file" >&2
    rm -f "$error_file"
    echo "加载 ${label} 失败，未报告成功" >&2
    return 1
}

# $1=label  $2=keepalive(true/false)  $3=hour  $4=minute  $5..=node 参数
write_plist() {
    local label="$1" keepalive="$2" hour="$3" minute="$4"
    shift 4
    local -a node_args=("$@")
    local plist="$AGENT_DIR/$label.plist"

    {
        echo '<?xml version="1.0" encoding="UTF-8"?>'
        echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
        echo '<plist version="1.0">'
        echo '<dict>'
        echo "    <key>Label</key><string>$label</string>"
        echo '    <key>ProgramArguments</key>'
        echo '    <array>'
        echo "        <string>$NODE_BIN</string>"
        for a in "${node_args[@]}"; do
            echo "        <string>$a</string>"
        done
        echo '    </array>'
        echo "    <key>WorkingDirectory</key><string>$PROJECT_ROOT</string>"
        echo '    <key>EnvironmentVariables</key>'
        echo '    <dict>'
        echo "        <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>"
        echo "        <key>HOME</key><string>$HOME</string>"
        echo "        <key>TZ</key><string>$SCHEDULE_TIME_ZONE</string>"
        echo '    </dict>'
        if [[ "$keepalive" == "true" ]]; then
            echo '    <key>RunAtLoad</key><true/>'
            echo '    <key>KeepAlive</key>'
            echo '    <dict>'
            echo '        <key>SuccessfulExit</key><false/>'
            echo '    </dict>'
        else
            echo '    <key>RunAtLoad</key><false/>'
            echo '    <key>StartCalendarInterval</key>'
            echo '    <dict>'
            echo "        <key>Hour</key><integer>$hour</integer>"
            echo "        <key>Minute</key><integer>$minute</integer>"
            echo '    </dict>'
        fi
        echo "    <key>StandardOutPath</key><string>$LOG_DIR/$label.out.log</string>"
        echo "    <key>StandardErrorPath</key><string>$LOG_DIR/$label.err.log</string>"
        echo '    <key>ProcessType</key><string>Background</string>'
        echo '</dict>'
        echo '</plist>'
    } > "$plist"

    load_agent "$label" "$plist"
}

ENV_FILE="$PROJECT_ROOT/.env"

if want "local.rewards.api"; then
    write_plist "local.rewards.api" true 0 0 \
        "--env-file=$ENV_FILE" "$PROJECT_ROOT/scripts/api/server.js"
fi

if want "local.rewards.monitor"; then
    write_plist "local.rewards.monitor" true 0 0 \
        "$PROJECT_ROOT/monitor/server/index.mjs"
fi

if want "local.rewards.daily"; then
    write_plist "local.rewards.daily" false "$HOUR" "$MINUTE" \
        "$PROJECT_ROOT/monitor/server/scheduler.mjs" "run" "--reason" "daily" "--wait-min" "${WAIT_MIN:-60}" "--refresh-api"
fi

# 常醒代理：caffeinate -s 在交流电下阻止整机睡眠（不影响息屏）。
# 不修改系统 pmset 设置，也不需要 sudo；断开电源后自动失效，电池模式仍会正常睡眠。
# 每日补跑守卫：每 10 分钟检查一次，若今天该跑却还没跑成功，就自动补一次。
# 解决 launchd 日历任务"错过就永远不补"的问题（睡眠、服务未起、上一轮未结束、改时间）。
if want "local.rewards.dailyguard"; then
    GUARD_PLIST="$AGENT_DIR/local.rewards.dailyguard.plist"
    {
        echo '<?xml version="1.0" encoding="UTF-8"?>'
        echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
        echo '<plist version="1.0"><dict>'
        echo '    <key>Label</key><string>local.rewards.dailyguard</string>'
        echo '    <key>ProgramArguments</key><array>'
        echo "        <string>$NODE_BIN</string>"
        echo "        <string>$PROJECT_ROOT/monitor/server/dailyGuard.mjs</string>"
        echo '    </array>'
        echo "    <key>WorkingDirectory</key><string>$PROJECT_ROOT</string>"
        echo '    <key>StartInterval</key><integer>600</integer>'
        echo '    <key>RunAtLoad</key><true/>'
        echo '    <key>EnvironmentVariables</key><dict>'
        echo "        <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>"
        echo "        <key>HOME</key><string>$HOME</string>"
        echo "        <key>TZ</key><string>$SCHEDULE_TIME_ZONE</string>"
        echo '    </dict>'
        echo "    <key>StandardOutPath</key><string>$LOG_DIR/local.rewards.dailyguard.out.log</string>"
        echo "    <key>StandardErrorPath</key><string>$LOG_DIR/local.rewards.dailyguard.err.log</string>"
        echo '    <key>ProcessType</key><string>Background</string>'
        echo '</dict></plist>'
    } > "$GUARD_PLIST"

    load_agent "local.rewards.dailyguard" "$GUARD_PLIST"
fi

if want "local.rewards.keepawake"; then
    KEEP_PLIST="$AGENT_DIR/local.rewards.keepawake.plist"
    {
        echo '<?xml version="1.0" encoding="UTF-8"?>'
        echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
        echo '<plist version="1.0"><dict>'
        echo '    <key>Label</key><string>local.rewards.keepawake</string>'
        echo '    <key>ProgramArguments</key><array>'
        echo '        <string>/usr/bin/caffeinate</string>'
        echo '        <string>-s</string>'
        echo '    </array>'
        echo '    <key>RunAtLoad</key><true/>'
        echo '    <key>KeepAlive</key><true/>'
        echo "    <key>StandardOutPath</key><string>$LOG_DIR/local.rewards.keepawake.out.log</string>"
        echo "    <key>StandardErrorPath</key><string>$LOG_DIR/local.rewards.keepawake.err.log</string>"
        echo '    <key>ProcessType</key><string>Background</string>'
        echo '</dict></plist>'
    } > "$KEEP_PLIST"

    load_agent "local.rewards.keepawake" "$KEEP_PLIST"
fi

cat <<EOF

launchd 配置完成：
  API       http://127.0.0.1:${API_PORT:-3010}   （常驻）
  监控/控制 http://127.0.0.1:${MONITOR_PORT:-3000}   （常驻，控制台需密钥）
  每日运行  每天 $(printf '%02d:%02d' "$HOUR" "$MINUTE")（上海；系统时区 ${HOST_TIME_ZONE}）
  常醒      local.rewards.keepawake（仅交流电，息屏照常）
  补跑守卫  local.rewards.dailyguard（每 10 分钟检查，错过自动补）

查看状态：launchctl list | grep local.rewards
查看日志：$LOG_DIR/

说明：plist 直接 exec node（不经过 /bin/bash），实测可正常读取 ~/Documents，
不需要授予「完全磁盘访问」。如果将来用 bash 包一层，会因 TCC 报
"Operation not permitted"，此时才需要考虑授权。
EOF
