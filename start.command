#!/bin/bash
# 启动常驻服务并打开监控界面。
# 只启动 API 与监控服务；不会自动触发一轮自动化任务。
set -uo pipefail

cd "$(dirname "$0")" || exit 1
source scripts/macos/lib.sh
require_node

echo "→ 启动 Control API 与监控服务"
for label in local.rewards.api local.rewards.monitor; do
    if launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then
        launchctl kickstart "gui/$(id -u)/$label"
        echo "  已确认运行 $label"
    else
        bash scripts/macos/install-launchd.sh >/dev/null 2>&1
        echo "  已注册并启动 $label"
        break
    fi
done

echo "→ 等待服务就绪"
for _ in $(seq 1 20); do
    if api_curl /health >/dev/null 2>&1; then break; fi
    sleep 0.5
done

if api_curl /health >/dev/null 2>&1; then
    echo "  ✓ Control API 正常"
else
    echo "  ✗ Control API 未响应，请执行 doctor.command 诊断"
fi

for _ in $(seq 1 20); do
    if curl -sf --max-time 2 "http://127.0.0.1:${MONITOR_PORT:-3000}/api/health" >/dev/null 2>&1; then break; fi
    sleep 0.5
done

if curl -sf --max-time 2 "http://127.0.0.1:${MONITOR_PORT:-3000}/api/health" >/dev/null 2>&1; then
    echo "  ✓ 监控服务正常"
else
    echo "  ✗ 监控服务未响应（GUI 可能尚未构建）"
fi

echo "→ 打开监控界面"
open "http://127.0.0.1:${MONITOR_PORT:-3000}/" 2>/dev/null || echo "  请手动在浏览器打开 http://127.0.0.1:${MONITOR_PORT:-3000}/"

echo
echo "服务已在后台常驻，关闭终端不影响运行。"
echo "停止服务请执行 stop.command。"
