#!/bin/bash
# 环境体检。只读：不修改任何配置、不启动或停止任何服务。
# 退出码：0 全通过；1 存在致命问题；2 只有警告。
set -uo pipefail

cd "$(dirname "$0")" || exit 1
source scripts/macos/lib.sh

PASS=0
FAIL=0
WARN=0

ok()   { echo "  ✓ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ✗ $1"; FAIL=$((FAIL+1)); }
warn() { echo "  ⚠ $1"; WARN=$((WARN+1)); }
sec()  { echo; echo "$1"; }

echo "=============================================="
echo " Microsoft Rewards macOS 环境体检"
echo " $(date '+%Y-%m-%d %H:%M:%S')"
echo "=============================================="

sec "1. 系统"
ARCH="$(uname -m)"
[[ "$ARCH" == "arm64" ]] && ok "架构 ${ARCH}（Apple Silicon）" || warn "架构 ${ARCH}，非 Apple Silicon"
ok "$(sw_vers -productName) $(sw_vers -productVersion) (build $(sw_vers -buildVersion))"
ok "内存 $(( $(sysctl -n hw.memsize) / 1073741824 )) GB · $(( $(sysctl -n hw.ncpu) )) 核"

sec "2. Node 运行时"
if [[ -x "$NODE_BIN" ]]; then
    VER="$("$NODE_BIN" -v)"
    MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
    if (( MAJOR >= 24 )); then ok "Homebrew Node ${VER}（${NODE_BIN}）"
    else bad "Node $VER 不满足上游 engines>=24"; fi
else
    bad "找不到 ${NODE_BIN}，请 brew install node"
fi
if command -v node >/dev/null 2>&1; then
    PATH_NODE="$(node -v)"
    if [[ "$PATH_NODE" != "$("$NODE_BIN" -v 2>/dev/null)" ]]; then
        warn "PATH 里的 node 是 ${PATH_NODE}，与 Homebrew 版本不同；脚本已强制使用绝对路径"
    fi
fi

sec "3. 依赖与构建"
[[ -d node_modules ]] && ok "上游依赖已安装" || bad "缺少 node_modules，请执行 install.command"
[[ -f dist/index.js ]] && ok "引擎已构建（dist/index.js）" || bad "缺少 dist，请执行 npm run build"
if grep -q "no-proxy-server" src/browser/Browser.ts 2>/dev/null; then
    ok "已应用 macOS 代理适配补丁"
else
    warn "未检测到代理适配补丁（若系统代理正常则无影响）"
fi
[[ -d monitor/web/dist ]] && ok "监控界面已构建" || bad "缺少 monitor/web/dist，请执行 npm --prefix monitor/web run build"
[[ -d monitor/node_modules || -f monitor/server/index.mjs ]] && ok "监控后端代码就位" || bad "监控后端缺失"

sec "4. 浏览器"
CHROME_EXE="$("$NODE_BIN" -e 'try{const{chromium}=require("patchright");console.log(chromium.executablePath())}catch(e){console.log("")}' 2>/dev/null)"
if [[ -n "$CHROME_EXE" && -x "$CHROME_EXE" ]]; then
    ok "Chromium 可执行文件存在"
    if "$NODE_BIN" -e '
        const {chromium}=require("patchright");
        (async()=>{const b=await chromium.launch({headless:true,args:["--no-proxy-server"]});await b.close();process.exit(0)})()
            .catch(()=>process.exit(1))' >/dev/null 2>&1; then
        ok "Chromium 可实际启动"
    else
        bad "Chromium 启动失败"
    fi
else
    bad "未安装 Chromium，请执行 npx patchright install chromium"
fi

sec "5. 配置"
if [[ -f .env ]]; then
    PERM="$(stat -f '%Lp' .env)"
    [[ "$PERM" == "600" ]] && ok ".env 权限 $PERM" || warn ".env 权限为 ${PERM}，建议 chmod 600 .env"
    ACC_COUNT="$(grep -cE '^ACCOUNT_[0-9]+_EMAIL=.' .env 2>/dev/null || echo 0)"
    if (( ACC_COUNT > 0 )); then ok "识别到 $ACC_COUNT 个账号"
        IDX_LIST="$(grep -oE '^ACCOUNT_[0-9]+_EMAIL=' .env | grep -oE '[0-9]+' | sort -n | tr '\n' ' ')"
        ok "账号槽位：${IDX_LIST}（允许跳号）"
        while IFS= read -r line; do
            idx="$(echo "$line" | grep -oE '[0-9]+' | head -1)"
            grep -qE "^ACCOUNT_${idx}_PASSWORD=.+" .env || warn "ACCOUNT_${idx} 没有 PASSWORD（无密码账号需先 manual-login）"
        done < <(grep -E '^ACCOUNT_[0-9]+_EMAIL=.' .env)
    else
        warn ".env 里没有账号（ACCOUNT_N_EMAIL）"
    fi
    grep -qE '^API_TOKEN=.+' .env && ok "API_TOKEN 已配置" || warn "未配置 API_TOKEN，Control API 将无鉴权"
    grep -qE '^API_ALLOW_ENV_OVERRIDES=true' .env && ok "允许 per-request 环境变量覆盖" || warn "未开启 API_ALLOW_ENV_OVERRIDES（不影响本方案，本方案改写 config.json）"
else
    bad "缺少 .env，请执行 install.command"
fi

if [[ -f config.json ]]; then
    if "$NODE_BIN" -e 'JSON.parse(require("fs").readFileSync("config.json","utf8"))' 2>/dev/null; then
        ok "config.json 是合法 JSON"
        CL="$("$NODE_BIN" -e 'console.log(JSON.parse(require("fs").readFileSync("config.json","utf8")).clusters)')"
        HD="$("$NODE_BIN" -e 'console.log(JSON.parse(require("fs").readFileSync("config.json","utf8")).headless)')"
        ok "clusters=${CL}（每轮由调度器重写）· headless=${HD}"
    else
        bad "config.json 解析失败"
    fi
else
    bad "缺少 config.json"
fi

sec "6. 端口与服务"
API_PORT_USE="${API_PORT:-3010}"
MON_PORT_USE="${MONITOR_PORT:-3000}"
for p in "$API_PORT_USE" "$MON_PORT_USE"; do
    if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
        OWNER="$(lsof -nP -iTCP:"$p" -sTCP:LISTEN | awk 'NR==2{print $1" pid="$2}')"
        ok "端口 ${p} 监听中（${OWNER}）"
    else
        if [[ "$p" == "$API_PORT_USE" ]]; then bad "端口 $p 未监听（Control API 未启动）"
        else bad "端口 $p 未监听（监控服务未启动）"; fi
    fi
done

if api_curl /health >/dev/null 2>&1; then
    H="$(api_curl /health)"
    ok "Control API 健康：$H"
    S="$(api_curl /status | "$NODE_BIN" -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);console.log("state="+j.state+" pid="+(j.pid??"-"))}catch{console.log("解析失败")}})' 2>/dev/null)"
    ok "API 状态：$S"
else
    bad "Control API 无响应"
fi

if curl -sf --max-time 3 "http://127.0.0.1:$MON_PORT_USE/api/health" >/dev/null 2>&1; then
    ok "监控服务健康"
    SNAP="$(curl -sf --max-time 3 "http://127.0.0.1:$MON_PORT_USE/api/snapshot" 2>/dev/null)"
    if [[ -n "$SNAP" ]]; then
        echo "$SNAP" | "$NODE_BIN" -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);console.log("  · 账号 "+j.accounts.length+" 个，上游在线="+j.controlApi.online+"，批次="+j.run.state)}catch{}})' 2>/dev/null
    fi
else
    bad "监控服务无响应"
fi

sec "7. launchd"
for label in local.rewards.api local.rewards.monitor local.rewards.daily; do
    if launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then
        PID="$(launchctl list | awk -v l="$label" '$3==l{print $1}')"
        ok "$label 已加载（pid=${PID}）"
    else
        warn "$label 未加载"
    fi
done

sec "8. 数据与日志"
mkdir -p sessions 2>/dev/null
SESS_COUNT="$(find sessions -maxdepth 2 -type f -name "*.json" 2>/dev/null | wc -l | tr -d ' ')"
[[ "$SESS_COUNT" -gt 0 ]] && ok "已保存会话文件 $SESS_COUNT 个" || warn "尚未保存任何会话（首次运行前正常）"
RUNS_COUNT="$(find monitor/data/runs -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
ok "本地批次存档 $RUNS_COUNT 个"
if [[ -f monitor/data/last-run.json ]]; then
    ok "最近调度记录：$(cat monitor/data/last-run.json | tr -d '\n' | cut -c1-150)"
else
    warn "尚无调度记录"
fi
if [[ -d "$LOG_DIR" ]]; then
    LAST_LOG="$(ls -t "$LOG_DIR" 2>/dev/null | head -1)"
    [[ -n "$LAST_LOG" ]] && ok "日志目录最新文件：$LAST_LOG" || warn "日志目录为空"
fi

echo
echo "=============================================="
echo " 通过 $PASS · 警告 $WARN · 失败 $FAIL"
echo "=============================================="
if (( FAIL > 0 )); then exit 1
elif (( WARN > 0 )); then exit 2
else exit 0
fi
