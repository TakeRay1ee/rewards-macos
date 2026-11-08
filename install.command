#!/bin/bash
# 首次安装 / 重装。可反复执行，不会覆盖已有 .env 账号。
set -uo pipefail

cd "$(dirname "$0")" || exit 1

echo "=============================================="
echo " Microsoft Rewards macOS 本机安装"
echo "=============================================="
echo

# ---------- 1. 基础环境 ----------
if ! command -v brew >/dev/null 2>&1; then
    echo "✗ 未检测到 Homebrew。请先安装：https://brew.sh"
    exit 1
fi
echo "✓ Homebrew $(brew --version | head -1 | awk '{print $2}')"

BREW_NODE="/opt/homebrew/bin/node"
if [[ ! -x "$BREW_NODE" ]]; then
    echo "→ 安装 Node.js（Homebrew）"
    brew install node || { echo "✗ Node.js 安装失败"; exit 1; }
fi
NODE_VER="$("$BREW_NODE" -v)"
NODE_MAJOR="$("$BREW_NODE" -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 24 )); then
    echo "✗ $BREW_NODE 版本为 ${NODE_VER}，上游要求 >=24。请执行 brew upgrade node"
    exit 1
fi
echo "✓ Node.js ${NODE_VER}（${BREW_NODE}）"
export PATH="/opt/homebrew/bin:$PATH"

# ---------- 2. 依赖 ----------
echo
echo "→ 安装上游依赖"
npm ci --no-audit --no-fund || { echo "✗ 依赖安装失败"; exit 1; }

echo "→ 安装 Patchright Chromium"
npx patchright install chromium || { echo "✗ Chromium 安装失败"; exit 1; }
echo "✓ Chromium 就绪"

# ---------- 3. 配置 ----------
if [[ ! -f config.json ]]; then
    echo "→ 生成 config.json（基于上游示例，并应用 macOS 默认值）"
    "$BREW_NODE" -e '
        const fs=require("fs");
        const c=JSON.parse(fs.readFileSync("config.example.json","utf8"));
        c.clusters=1;                     // 每轮由调度器按实测内存重写，这里只是兜底
        c.headless=true;
        c.accountDelay={min:"20sec",max:"40sec"};
        c.searchSettings.queryEngines=["china","local"];
        c.humanize.enabled=false;
        c.debugLogs=true;
        c.errorDiagnostics=false;
        c.sessionPath="sessions";
        fs.writeFileSync("config.json",JSON.stringify(c,null,4));
    '
else
    echo "✓ config.json 已存在，保持不变"
fi

if [[ ! -f .env ]]; then
    echo "→ 生成 .env（含随机 API_TOKEN）"
    TOKEN="$("$BREW_NODE" -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
    cat > .env <<EOF
# Microsoft Rewards —— macOS 本机运行环境
# 权限 600，已在 .gitignore 中，严禁提交或分享

# --- Control API ---
API_HOST=127.0.0.1
API_PORT=3010
API_TOKEN=$TOKEN
API_ALLOW_ENV_OVERRIDES=true
API_LOG_BUFFER=5000
API_RUN_HISTORY=50

# --- 账号（编号可跳号，无需连续；由 Codex 维护）---
# ACCOUNT_1_EMAIL=
# ACCOUNT_1_PASSWORD=
# ACCOUNT_1_GEO_LOCALE=CN
# ACCOUNT_1_LANG_CODE=zh-CN
EOF
    chmod 600 .env
else
    echo "✓ .env 已存在，保留现有账号"
    chmod 600 .env
fi

mkdir -p sessions logs data

# ---------- 4. 构建 ----------
echo
echo "→ 构建自动化引擎"
npm run build || { echo "✗ 引擎构建失败"; exit 1; }

echo "→ 安装并构建监控界面"
npm --prefix monitor/web install --no-audit --no-fund || { echo "✗ 监控依赖安装失败"; exit 1; }
npm --prefix monitor/web run build || { echo "✗ 监控界面构建失败"; exit 1; }

# ---------- 5. launchd ----------
echo
echo "→ 注册 launchd 常驻服务与每日定时"
bash scripts/macos/install-launchd.sh

# ---------- 6. 结果 ----------
ACCOUNTS="$(grep -cE '^ACCOUNT_[0-9]+_EMAIL=.' .env 2>/dev/null || echo 0)"
echo
echo "=============================================="
echo " 安装完成"
echo "=============================================="
echo "  已识别账号：$ACCOUNTS 个"
if [[ "$ACCOUNTS" == "0" ]]; then
    echo "  ⚠ .env 里还没有账号，请让 Codex 添加后再运行"
fi
echo "  GUI：http://127.0.0.1:3000"
echo "  API：http://127.0.0.1:3010"
echo
echo "  下一步："
echo "    1) 让 Codex 配置账号（或直接编辑 .env）"
echo "    2) 首次登录：npm run manual-login（需在有终端窗口的环境执行）"
echo "    3) 打开 start.command，或访问 GUI"
echo
