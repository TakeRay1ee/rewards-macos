#!/bin/bash
# 按正确顺序重启：先 API（自动化控制器），再监控（只读层）。
# 不会触发新的自动化批次。
set -uo pipefail

cd "$(dirname "$0")" || exit 1
source scripts/macos/lib.sh
require_node

STATE="$(api_curl /status 2>/dev/null | python3 -c 'import sys,json
try:
    print(json.load(sys.stdin).get("state",""))
except Exception:
    print("")' 2>/dev/null)"

if [[ -n "$STATE" && "$STATE" != "idle" ]]; then
    echo "⚠ 有一轮批次正在 ${STATE}。重启 API 会打断控制接口。"
    read -r -p "仍然重启？[y/N] " ans
    [[ "$ans" == "y" || "$ans" == "Y" ]] || { echo "已取消"; exit 0; }
fi

echo "→ 重新注册 launchd 配置（幂等）"
bash scripts/macos/install-launchd.sh >/dev/null 2>&1 || true

echo "→ 重启 Control API"
launchctl kickstart -k "gui/$(id -u)/local.rewards.api" 2>/dev/null || echo "  API 未加载"

for _ in $(seq 1 30); do
    api_curl /health >/dev/null 2>&1 && break
    sleep 0.5
done
api_curl /health >/dev/null 2>&1 && echo "  ✓ API 就绪" || echo "  ✗ API 未响应"

echo "→ 重启监控服务"
launchctl kickstart -k "gui/$(id -u)/local.rewards.monitor" 2>/dev/null || echo "  监控未加载"

for _ in $(seq 1 30); do
    curl -sf --max-time 2 "http://127.0.0.1:${MONITOR_PORT:-3000}/api/health" >/dev/null 2>&1 && break
    sleep 0.5
done
curl -sf --max-time 2 "http://127.0.0.1:${MONITOR_PORT:-3000}/api/health" >/dev/null 2>&1 \
    && echo "  ✓ 监控就绪" || echo "  ✗ 监控未响应"

echo
echo "重启完成。GUI：http://127.0.0.1:${MONITOR_PORT:-3000}/"
