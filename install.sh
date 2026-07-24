#!/usr/bin/env bash
# 一键安装脚本：兼容 macOS（LaunchAgent）和 Linux（systemd）。
# 示例：
#   ./install.sh
#   ./install.sh --port 13148 --username admin --tasks-dir /srv/t-agent-tasks

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ENV_FILE="$APP_DIR/.env"
PORT=""
USERNAME=""
PASSWORD=""
TASKS_DIR=""
INSTALL_SERVICE=1

usage() {
  cat <<'EOF'
用法：./install.sh [选项]

选项：
  --port PORT          服务端口（默认 3000）
  --username NAME      首个本地登录账号
  --password PASSWORD  首个本地登录账号的密码（不建议在共享终端中使用）
  --tasks-dir PATH     任务 Markdown 文件保存目录（默认：项目目录/tasks）
  --no-service         只安装依赖和配置，不注册开机服务
  -h, --help           显示帮助

首次运行会交互询问未提供的账号和密码。已有 .env 不会被覆盖。
EOF
}

fail() {
  printf '错误：%s\n' "$*" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --port) PORT="${2:-}"; shift 2 ;;
    --username) USERNAME="${2:-}"; shift 2 ;;
    --password) PASSWORD="${2:-}"; shift 2 ;;
    --tasks-dir) TASKS_DIR="${2:-}"; shift 2 ;;
    --no-service) INSTALL_SERVICE=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "未知选项：$1（使用 --help 查看用法）" ;;
  esac
done

if [ -n "$PORT" ] && ! [[ "$PORT" =~ ^[1-9][0-9]{0,4}$ ]] || { [ -n "$PORT" ] && [ "$PORT" -gt 65535 ]; }; then
  fail "端口必须是 1-65535 的整数"
fi

case "$(uname -s)" in
  Darwin) PLATFORM="macOS" ;;
  Linux) PLATFORM="Linux" ;;
  *) fail "暂不支持的系统：$(uname -s)" ;;
esac

run_as_root() {
  if [ "${EUID}" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    fail "需要管理员权限，请以 root 运行或安装 sudo"
  fi
}

install_system_dependencies() {
  if command -v node >/dev/null 2>&1; then
    return
  fi

  printf '未检测到 Node.js，正在安装……\n'
  if [ "$PLATFORM" = "macOS" ]; then
    command -v brew >/dev/null 2>&1 || fail "请先安装 Homebrew：https://brew.sh/"
    brew install node
  elif command -v apt-get >/dev/null 2>&1; then
    run_as_root apt-get update
    run_as_root apt-get install -y nodejs npm python3 build-essential
  elif command -v dnf >/dev/null 2>&1; then
    run_as_root dnf install -y nodejs npm python3 make gcc-c++
  elif command -v yum >/dev/null 2>&1; then
    run_as_root yum install -y nodejs npm python3 make gcc-c++
  else
    fail "未识别的包管理器；请先安装 Node.js 18+、Python 3 和 C/C++ 编译工具"
  fi
}

install_system_dependencies
command -v node >/dev/null 2>&1 || fail "Node.js 安装失败"
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
[ "$NODE_MAJOR" -ge 18 ] || fail "需要 Node.js 18+，当前为 $(node --version)"

if [ "$PLATFORM" = "macOS" ] && ! xcode-select -p >/dev/null 2>&1; then
  printf '提示：未检测到 Xcode Command Line Tools。node-pty 编译失败时，请运行：xcode-select --install\n' >&2
fi

mkdir -p "$APP_DIR/logs" "$APP_DIR/data"

update_env_value() {
  local key="$1"
  local value="$2"
  node - "$ENV_FILE" "$key" "$value" <<'NODE'
const fs = require('fs');
const [file, key, value] = process.argv.slice(2);
let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pattern = new RegExp(`^${escaped}=.*$`, 'm');
const entry = `${key}=${value}`;
text = pattern.test(text) ? text.replace(pattern, entry) : `${text.replace(/\n?$/, '\n')}${entry}\n`;
fs.writeFileSync(file, text, { mode: 0o600 });
NODE
}

if [ ! -f "$ENV_FILE" ]; then
  [ -n "$PORT" ] || PORT=3000
  [ -n "$TASKS_DIR" ] || TASKS_DIR="$APP_DIR/tasks"

  if [ -z "$USERNAME" ]; then
    [ -t 0 ] || fail "首次安装请通过 --username 和 --password 指定登录账号"
    read -r -p '设置登录用户名: ' USERNAME
  fi
  [[ "$USERNAME" =~ ^[a-zA-Z0-9_-]{2,32}$ ]] || fail "用户名只能包含字母、数字、下划线、连字符，且为 2-32 位"

  if [ -z "$PASSWORD" ]; then
    [ -t 0 ] || fail "首次安装请通过 --password 指定登录密码"
    read -r -s -p '设置登录密码（至少 6 位）: ' PASSWORD
    printf '\n'
  fi
  [ "${#PASSWORD}" -ge 6 ] || fail "密码至少需要 6 位"

  SESSION_SECRET="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")"
  AUTH_USER="$(node "$APP_DIR/scripts/gen-password.js" "$USERNAME" "$PASSWORD")"
  umask 077
  cat > "$ENV_FILE" <<EOF
PORT=$PORT
SESSION_SECRET=$SESSION_SECRET
AUTH_USERS=$AUTH_USER
TASKS_BASE_DIR=$TASKS_DIR
EOF
  unset PASSWORD
  printf '已创建 %s\n' "$ENV_FILE"
else
  printf '保留现有 %s（不会覆盖账号和密钥）。\n' "$ENV_FILE"
  [ -n "$PORT" ] && update_env_value PORT "$PORT"
  [ -n "$TASKS_DIR" ] && update_env_value TASKS_BASE_DIR "$TASKS_DIR"
fi

TASKS_DIR="$(sed -n 's/^TASKS_BASE_DIR=//p' "$ENV_FILE" | tail -n 1)"
[ -n "$TASKS_DIR" ] && mkdir -p "$TASKS_DIR"

printf '安装 Node.js 依赖……\n'
if [ -f "$APP_DIR/package-lock.json" ]; then
  npm ci --omit=dev --prefix "$APP_DIR"
else
  npm install --omit=dev --prefix "$APP_DIR"
fi

NODE_BIN="$(command -v node)"
if [ "$INSTALL_SERVICE" -eq 1 ] && [ "$PLATFORM" = "macOS" ]; then
  [ "${EUID}" -ne 0 ] || fail "macOS 请以实际登录用户运行本脚本，不能以 root 运行 LaunchAgent"
  PLIST_DIR="$HOME/Library/LaunchAgents"
  PLIST_FILE="$PLIST_DIR/com.tagent.web.plist"
  mkdir -p "$PLIST_DIR"
  cat > "$PLIST_FILE" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.tagent.web</string>
  <key>ProgramArguments</key><array><string>$NODE_BIN</string><string>$APP_DIR/server.js</string></array>
  <key>WorkingDirectory</key><string>$APP_DIR</string>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$APP_DIR/logs/stdout.log</string>
  <key>StandardErrorPath</key><string>$APP_DIR/logs/stderr.log</string>
</dict></plist>
EOF
  launchctl bootout "gui/$UID" "$PLIST_FILE" 2>/dev/null || true
  launchctl bootstrap "gui/$UID" "$PLIST_FILE"
  launchctl kickstart -k "gui/$UID/com.tagent.web"
  SERVICE_HINT="launchctl kickstart -k gui/$UID/com.tagent.web"
elif [ "$INSTALL_SERVICE" -eq 1 ] && [ "$PLATFORM" = "Linux" ] && command -v systemctl >/dev/null 2>&1; then
  SERVICE_USER="${SUDO_USER:-$USER}"
  SERVICE_FILE="/etc/systemd/system/t-agent.service"
  SERVICE_CONTENT="[Unit]
Description=T-Agent web service
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN $APP_DIR/server.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
"
  printf '%s' "$SERVICE_CONTENT" | run_as_root tee "$SERVICE_FILE" >/dev/null
  run_as_root systemctl daemon-reload
  run_as_root systemctl enable --now t-agent.service
  SERVICE_HINT="systemctl status t-agent.service"
elif [ "$INSTALL_SERVICE" -eq 1 ] && [ "$PLATFORM" = "Linux" ]; then
  printf '提示：未检测到 systemd，未注册开机服务；请使用以下命令手动启动。\n' >&2
  SERVICE_HINT="cd $APP_DIR && npm start"
else
  SERVICE_HINT="cd $APP_DIR && npm start"
fi

ACTIVE_PORT="$(sed -n 's/^PORT=//p' "$ENV_FILE" | tail -n 1)"
printf '\n安装完成。\n访问地址：http://127.0.0.1:%s\n服务检查：%s\n' "${ACTIVE_PORT:-3000}" "$SERVICE_HINT"
