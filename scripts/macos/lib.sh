#!/bin/bash
# 公共环境：所有 macOS 脚本 source 本文件。
# 关键点：系统 PATH 里排第一的 node 可能是 Python/WorkBuddy 自带的 v22，
# 不满足上游 engines>=24，因此这里强制使用 Homebrew 的 node。

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BREW_PREFIX="${BREW_PREFIX:-/opt/homebrew}"
NODE_BIN="${NODE_BIN:-$BREW_PREFIX/bin/node}"
NPM_BIN="${NPM_BIN:-$BREW_PREFIX/bin/npm}"

LOG_DIR="$PROJECT_ROOT/logs"
RUN_DIR="$PROJECT_ROOT/run"
DATA_DIR="$PROJECT_ROOT/data"

mkdir -p "$LOG_DIR" "$RUN_DIR" "$DATA_DIR"

# 把一个 .env 里的键值安全地注入当前进程环境。
# 只接受 KEY=VALUE 形式，跳过注释与空行，不 eval，避免命令注入。
load_env() {
    local env_file="${1:-$PROJECT_ROOT/.env}"
    [[ -f "$env_file" ]] || return 0
    while IFS= read -r line || [[ -n "$line" ]]; do
        line="${line%%$'\r'}"
        [[ -z "${line// }" ]] && continue
        [[ "$line" =~ ^[[:space:]]*# ]] && continue
        [[ "$line" != *=* ]] && continue
        local key="${line%%=*}"
        local value="${line#*=}"
        key="$(printf '%s' "$key" | tr -d '[:space:]')"
        [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
        value="$(printf '%s' "$value" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
        if [[ "$value" =~ ^\"(.*)\"$ ]] || [[ "$value" =~ ^\'(.*)\'$ ]]; then
            value="${BASH_REMATCH[1]}"
        fi
        export "$key=$value"
    done < "$env_file"
}

require_node() {
    if [[ ! -x "$NODE_BIN" ]]; then
        echo "错误：找不到 Node 可执行文件 $NODE_BIN" >&2
        echo "请执行：brew install node" >&2
        exit 1
    fi
    local major
    major="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
    if (( major < 24 )); then
        echo "错误：Node 版本 $("$NODE_BIN" -v) 不满足上游要求 >=24" >&2
        exit 1
    fi
}

api_base() {
    echo "http://${API_HOST:-127.0.0.1}:${API_PORT:-3010}"
}

# 带鉴权的 curl 包装，token 只从环境读取，不出现在命令行参数里
api_curl() {
    local path="$1"; shift
    local -a auth=()
    if [[ -n "${API_TOKEN:-}" ]]; then
        auth=(-H "Authorization: Bearer $API_TOKEN")
    fi
    curl -sS --max-time "${API_TIMEOUT:-10}" "${auth[@]}" "$@" "$(api_base)$path"
}

load_env
