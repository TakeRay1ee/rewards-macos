#!/bin/bash
# 停止服务。默认只停 GUI 监控；Control API（自动化引擎的控制器）需要单独确认。
# 这是刻意的：GUI 是只读观测层，关掉它不应该影响任务运行。
set -uo pipefail

cd "$(dirname "$0")" || exit 1
source scripts/macos/lib.sh

STATE=""
STATE="$(api_curl /status 2>/dev/null | python3 -c 'import sys,json
try:
    print(json.load(sys.stdin).get("state",""))
except Exception:
    print("")' 2>/dev/null)"

# 1) 监控服务
if launchctl print "gui/$(id -u)/local.rewards.monitor" >/dev/null 2>&1; then
    launchctl bootout "gui/$(id -u)/local.rewards.monitor" 2>/dev/null && echo "已停止监控服务（GUI）"
else
    echo "监控服务未在运行"
fi

# 2) Control API
echo
if [[ -n "$STATE" && "$STATE" != "idle" ]]; then
    echo "⚠ Control API 当前有一个批次处于 $STATE 状态。"
fi
read -r -p "是否同时停止 Control API（停止后将无法再启动/控制自动化任务）？[y/N] " ans
if [[ "$ans" == "y" || "$ans" == "Y" ]]; then
    if launchctl print "gui/$(id -u)/local.rewards.api" >/dev/null 2>&1; then
        launchctl bootout "gui/$(id -u)/local.rewards.api" 2>/dev/null && echo "已停止 Control API"
    else
        echo "Control API 未在运行"
    fi
    echo
    echo "Control API 正常退出时会先停止其控制的批次；异常退出的存活任务会由新版 API 按登记身份恢复控制。"
    echo "      查看状态请重新启动 API 后查询 /status，勿按进程名批量结束浏览器。"
else
    echo "Control API 保持运行，自动化任务不受影响。"
    echo "重新打开 GUI：执行 start.command"
fi

echo
echo "每日定时任务（local.rewards.daily）未受影响，仍会按设定时间触发。"
