#!/usr/bin/env bash
# 一键安装脚本：兼容 macOS（LaunchAgent）和 Linux（systemd）。
# 示例：
#   ./install.sh
#   ./install.sh --mode engine --port 3100 --tasks-dir /srv/t-agent-tasks
#   ./install.sh --port 13148 --username admin --tasks-dir /srv/t-agent-tasks

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ENV_FILE="$APP_DIR/.env"
PORT=""
USERNAME=""
PASSWORD=""
TASKS_DIR=""
INSTALL_SERVICE=1
MODE="client"
CREATED_USERNAME=""
CREATED_PASSWORD=""
CREATED_ENGINE_TOKEN=""
UPDATE_REPOSITORY="${T_AGENT_REPOSITORY:-TorinMars/t-agent}"
DETECTED_UPDATE_REF="main"
if command -v git >/dev/null 2>&1 && git -C "$APP_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  DETECTED_UPDATE_REF="$(git -C "$APP_DIR" branch --show-current 2>/dev/null || printf 'main')"
  [ -n "$DETECTED_UPDATE_REF" ] || DETECTED_UPDATE_REF="main"
fi
UPDATE_REF="${T_AGENT_REF:-$DETECTED_UPDATE_REF}"

usage() {
  cat <<'EOF'
用法：./install.sh [选项]

选项：
  --mode MODE          安装模式：client（默认，内含本地 Engine）或 engine
  --port PORT          服务端口（默认 3000）
  --username NAME      首个本地登录账号
  --password PASSWORD  首个本地登录账号的密码（不建议在共享终端中使用）
  --tasks-dir PATH     任务 Markdown 文件保存目录（默认：项目目录/tasks）
  --no-service         只安装依赖和配置，不注册开机服务
  -h, --help           显示帮助

Client 模式首次运行会询问本地登录账号。
Engine 模式不创建账号，而是生成一个只显示一次的访问 Token。
EOF
}

fail() {
  printf '错误：%s\n' "$*" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --mode) MODE="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --username) USERNAME="${2:-}"; shift 2 ;;
    --password) PASSWORD="${2:-}"; shift 2 ;;
    --tasks-dir) TASKS_DIR="${2:-}"; shift 2 ;;
    --no-service) INSTALL_SERVICE=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "未知选项：$1（使用 --help 查看用法）" ;;
  esac
done

[ "$MODE" = "client" ] || [ "$MODE" = "engine" ] || fail "--mode 只能是 client 或 engine"
[[ "$UPDATE_REPOSITORY" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] && [[ "$UPDATE_REPOSITORY" != ../* ]] && [[ "$UPDATE_REPOSITORY" != */.. ]] || fail "T_AGENT_REPOSITORY 格式不正确"
[[ "$UPDATE_REF" =~ ^[A-Za-z0-9._/-]+$ ]] && [[ "$UPDATE_REF" != *..* ]] || fail "T_AGENT_REF 格式不正确"

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
  if ! command -v node >/dev/null 2>&1; then
    printf '未检测到 Node.js，正在安装……\n'
    if [ "$PLATFORM" = "macOS" ]; then
      command -v brew >/dev/null 2>&1 || fail "请先安装 Homebrew：https://brew.sh/"
      brew install node
    elif command -v apt-get >/dev/null 2>&1; then
      run_as_root apt-get update
      run_as_root apt-get install -y nodejs npm
    elif command -v dnf >/dev/null 2>&1; then
      run_as_root dnf install -y nodejs npm
    elif command -v yum >/dev/null 2>&1; then
      run_as_root yum install -y nodejs npm
    else
      fail "未识别的包管理器；请先安装 Node.js 20+、Python 3 和支持 C++20 的编译工具"
    fi
  fi

  if [ "$PLATFORM" = "Linux" ] && { ! command -v python3 >/dev/null 2>&1 || ! command -v make >/dev/null 2>&1 || ! command -v g++ >/dev/null 2>&1; }; then
    printf '正在安装原生模块构建工具……\n'
    if command -v apt-get >/dev/null 2>&1; then
      run_as_root apt-get update
      run_as_root apt-get install -y python3 build-essential
    elif command -v dnf >/dev/null 2>&1; then
      run_as_root dnf install -y python3 make gcc gcc-c++
    elif command -v yum >/dev/null 2>&1; then
      run_as_root yum install -y python3 make gcc gcc-c++
    else
      fail "未识别的包管理器；请先安装 Python 3、make 和支持 C++20 的 g++"
    fi
  fi
}

compiler_supports_cxx20() {
  local compiler="$1"
  local probe_dir
  command -v "$compiler" >/dev/null 2>&1 || return 1
  probe_dir="$(mktemp -d)"
  if printf 'int main() { return 0; }\n' | "$compiler" -std=c++20 -x c++ -c -o "$probe_dir/probe.o" - >/dev/null 2>&1; then
    rm -rf "$probe_dir"
    return 0
  fi
  rm -rf "$probe_dir"
  return 1
}

configure_linux_cxx20_compiler() {
  local compiler="${CXX:-g++}"
  local toolset
  local toolset_root
  if compiler_supports_cxx20 "$compiler"; then
    return
  fi

  printf '当前 C++ 编译器不支持 -std=c++20，正在查找 GCC Toolset……\n'
  if command -v dnf >/dev/null 2>&1; then
    for toolset in 14 13 12 11 10; do
      toolset_root="/opt/rh/gcc-toolset-$toolset/root/usr/bin"
      if [ ! -x "$toolset_root/g++" ]; then
        if ! dnf -q list --available "gcc-toolset-$toolset-gcc-c++" >/dev/null 2>&1; then
          continue
        fi
        run_as_root dnf install -y "gcc-toolset-$toolset-gcc" "gcc-toolset-$toolset-gcc-c++" || continue
      fi
      if compiler_supports_cxx20 "$toolset_root/g++"; then
        export CC="$toolset_root/gcc"
        export CXX="$toolset_root/g++"
        printf '使用 GCC Toolset %s 编译原生模块。\n' "$toolset"
        return
      fi
    done
  elif command -v yum >/dev/null 2>&1; then
    run_as_root yum install -y centos-release-scl >/dev/null 2>&1 || true
    for toolset in 11 10; do
      toolset_root="/opt/rh/devtoolset-$toolset/root/usr/bin"
      if [ ! -x "$toolset_root/g++" ]; then
        run_as_root yum install -y "devtoolset-$toolset-gcc" "devtoolset-$toolset-gcc-c++" || continue
      fi
      if compiler_supports_cxx20 "$toolset_root/g++"; then
        export CC="$toolset_root/gcc"
        export CXX="$toolset_root/g++"
        printf '使用 Developer Toolset %s 编译原生模块。\n' "$toolset"
        return
      fi
    done
  fi

  fail "当前 g++ 不支持 C++20。CentOS/RHEL 8+ 请安装 gcc-toolset-12，并设置 CC=/opt/rh/gcc-toolset-12/root/usr/bin/gcc、CXX=/opt/rh/gcc-toolset-12/root/usr/bin/g++ 后重试"
}

install_system_dependencies
command -v node >/dev/null 2>&1 || fail "Node.js 安装失败"
command -v npm >/dev/null 2>&1 || fail "未检测到 npm，请安装与当前 Node.js 配套的 npm 后重试"
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
[ "$NODE_MAJOR" -ge 20 ] && [ "$NODE_MAJOR" -ne 21 ] || fail "当前依赖需要 Node.js 20 或 22+（推荐 22 LTS），当前为 $(node --version)"

if [ "$PLATFORM" = "macOS" ] && ! xcode-select -p >/dev/null 2>&1; then
  printf '提示：未检测到 Xcode Command Line Tools。node-pty 编译失败时，请运行：xcode-select --install\n' >&2
fi
if [ "$PLATFORM" = "Linux" ]; then
  configure_linux_cxx20_compiler
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

ensure_env_value() {
  local key="$1"
  local value="$2"
  if ! grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    update_env_value "$key" "$value"
  fi
}

if [ ! -f "$ENV_FILE" ]; then
  if [ -z "$PORT" ]; then
    [ "$MODE" = "engine" ] && PORT=3100 || PORT=3000
  fi
  [ -n "$TASKS_DIR" ] || TASKS_DIR="$APP_DIR/tasks"

  AUTH_USER=""
  if [ "$MODE" = "client" ]; then
    if [ -z "$USERNAME" ]; then
      [ -t 0 ] || fail "Client 首次安装请通过 --username 和 --password 指定本地登录账号"
      read -r -p '设置登录用户名: ' USERNAME
    fi
    [[ "$USERNAME" =~ ^[a-zA-Z0-9_-]{2,32}$ ]] || fail "用户名只能包含字母、数字、下划线、连字符，且为 2-32 位"

    if [ -z "$PASSWORD" ]; then
      [ -t 0 ] || fail "Client 首次安装请通过 --password 指定本地登录密码"
      read -r -s -p '设置登录密码（至少 6 位）: ' PASSWORD
      printf '\n'
    fi
    [ "${#PASSWORD}" -ge 6 ] || fail "密码至少需要 6 位"
    AUTH_USER="$(node "$APP_DIR/scripts/gen-password.js" "$USERNAME" "$PASSWORD")"
    CREATED_USERNAME="$USERNAME"
    CREATED_PASSWORD="$PASSWORD"
  fi

  SESSION_SECRET="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")"
  umask 077
  cat > "$ENV_FILE" <<EOF
PORT=$PORT
T_AGENT_MODE=$MODE
SESSION_SECRET=$SESSION_SECRET
AUTH_USERS=$AUTH_USER
TASKS_BASE_DIR=$TASKS_DIR
ENGINE_OWNER_ID=${USERNAME:-engine}
ENGINE_WORKSPACE_ROOTS=$TASKS_DIR
ENGINE_HOST=$([ "$MODE" = "engine" ] && printf '0.0.0.0' || printf '127.0.0.1')
GITHUB_VERSION_URL=https://api.github.com/repos/$UPDATE_REPOSITORY/contents/VERSION.json?ref=$UPDATE_REF
UPDATE_GITHUB_REPOSITORY=$UPDATE_REPOSITORY
UPDATE_GITHUB_REF=$UPDATE_REF
UPDATE_GIT_BRANCH=$UPDATE_REF
UPDATE_CHECK_ENABLED=true
UPDATE_CHECK_INTERVAL_SECONDS=1800
EOF
  printf '已创建 %s\n' "$ENV_FILE"
else
  printf '保留现有 %s（不会覆盖账号和密钥）。\n' "$ENV_FILE"
  [ -n "$PORT" ] && update_env_value PORT "$PORT"
  if [ -n "$TASKS_DIR" ]; then
    update_env_value TASKS_BASE_DIR "$TASKS_DIR"
    update_env_value ENGINE_WORKSPACE_ROOTS "$TASKS_DIR"
  fi
  update_env_value T_AGENT_MODE "$MODE"
  if [ "$MODE" = "engine" ]; then
    update_env_value ENGINE_HOST 0.0.0.0
  fi
fi

# 旧版压缩包安装没有 Git 元数据；补齐更新来源后也能自动检查和按钮升级。
ensure_env_value GITHUB_VERSION_URL "https://api.github.com/repos/$UPDATE_REPOSITORY/contents/VERSION.json?ref=$UPDATE_REF"
ensure_env_value UPDATE_GITHUB_REPOSITORY "$UPDATE_REPOSITORY"
ensure_env_value UPDATE_GITHUB_REF "$UPDATE_REF"
ensure_env_value UPDATE_GIT_BRANCH "$UPDATE_REF"
ensure_env_value UPDATE_CHECK_ENABLED true
ensure_env_value UPDATE_CHECK_INTERVAL_SECONDS 1800

# Git 工作副本以当前分支为唯一更新来源，避免旧配置仍指向其他分支。
if git -C "$APP_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  update_env_value UPDATE_GITHUB_REPOSITORY "$UPDATE_REPOSITORY"
  update_env_value UPDATE_GITHUB_REF "$UPDATE_REF"
  update_env_value UPDATE_GIT_REMOTE origin
  update_env_value UPDATE_GIT_BRANCH "$UPDATE_REF"
fi

TASKS_DIR="$(sed -n 's/^TASKS_BASE_DIR=//p' "$ENV_FILE" | tail -n 1)"
[ -n "$TASKS_DIR" ] && mkdir -p "$TASKS_DIR"

printf '安装 Node.js 依赖……\n'
if [ -f "$APP_DIR/package-lock.json" ]; then
  npm ci --omit=dev --ignore-scripts=false --prefix "$APP_DIR"
else
  npm install --omit=dev --ignore-scripts=false --prefix "$APP_DIR"
fi

verify_node_pty() {
  node "$APP_DIR/scripts/verify-node-pty.js" >/dev/null 2>&1
}

if ! verify_node_pty; then
  printf 'node-pty 原生模块未就绪，正在重新编译……\n'
  npm rebuild node-pty --ignore-scripts=false --foreground-scripts --prefix "$APP_DIR"
  verify_node_pty || fail "node-pty 无法加载；macOS 请先运行 xcode-select --install，再重新执行安装脚本"
fi

if [ "$MODE" = "engine" ]; then
  # 首次 npm 安装若在原生模块编译阶段失败，.env 已存在但 Token 尚未创建。
  # 只在数据库历史上从未出现过 Engine Token 时补发，避免升级或全部撤销后意外生成 owner Token。
  ENGINE_TOKEN_COUNT="$(node - "$APP_DIR" <<'NODE'
const path = require('path');
const appDir = process.argv[2];
const db = require(path.join(appDir, 'db'));
const row = db.prepare('SELECT COUNT(*) count FROM engine_access_tokens').get();
process.stdout.write(String(row.count));
NODE
)"
  if [ "$ENGINE_TOKEN_COUNT" = "0" ]; then
    CREATED_ENGINE_TOKEN="$(node "$APP_DIR/scripts/create-engine-token.js" owner 'Initial Client')"
  fi
fi

NODE_BIN="$(command -v node)"
SERVICE_PATH="$(dirname "$NODE_BIN"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
if [ "$MODE" = "engine" ]; then
  ENTRY_SCRIPT="$APP_DIR/apps/engine/server.js"
  SERVICE_BASENAME="t-agent-engine"
  SERVICE_DESCRIPTION="T-Agent Engine"
  LAUNCH_LABEL="com.tagent.engine"
  MANUAL_START="cd $APP_DIR && npm run start:engine"
else
  ENTRY_SCRIPT="$APP_DIR/server.js"
  SERVICE_BASENAME="t-agent"
  SERVICE_DESCRIPTION="T-Agent Client with embedded Engine"
  LAUNCH_LABEL="com.tagent.client"
  MANUAL_START="cd $APP_DIR && npm start"
fi
if [ "$INSTALL_SERVICE" -eq 1 ] && [ "$PLATFORM" = "macOS" ]; then
  [ "${EUID}" -ne 0 ] || fail "macOS 请以实际登录用户运行本脚本，不能以 root 运行 LaunchAgent"
  PLIST_DIR="$HOME/Library/LaunchAgents"
  PLIST_FILE="$PLIST_DIR/$LAUNCH_LABEL.plist"
  mkdir -p "$PLIST_DIR"
  cat > "$PLIST_FILE" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LAUNCH_LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE_BIN</string><string>$ENTRY_SCRIPT</string></array>
  <key>WorkingDirectory</key><string>$APP_DIR</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$SERVICE_PATH</string></dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$APP_DIR/logs/stdout.log</string>
  <key>StandardErrorPath</key><string>$APP_DIR/logs/stderr.log</string>
</dict></plist>
EOF
  launchctl bootout "gui/$UID" "$PLIST_FILE" 2>/dev/null || true
  if [ "$MODE" = "client" ]; then
    launchctl bootout "gui/$UID" "$HOME/Library/LaunchAgents/com.tagent.web.plist" 2>/dev/null || true
  fi
  launchctl bootstrap "gui/$UID" "$PLIST_FILE"
  launchctl kickstart -k "gui/$UID/$LAUNCH_LABEL"
  SERVICE_HINT="launchctl kickstart -k gui/$UID/$LAUNCH_LABEL"
elif [ "$INSTALL_SERVICE" -eq 1 ] && [ "$PLATFORM" = "Linux" ] && command -v systemctl >/dev/null 2>&1; then
  SERVICE_USER="${SUDO_USER:-$USER}"
  SERVICE_FILE="/etc/systemd/system/$SERVICE_BASENAME.service"
  SERVICE_CONTENT="[Unit]
Description=$SERVICE_DESCRIPTION
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN $ENTRY_SCRIPT
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
"
  printf '%s' "$SERVICE_CONTENT" | run_as_root tee "$SERVICE_FILE" >/dev/null
  run_as_root systemctl daemon-reload
  run_as_root systemctl enable --now "$SERVICE_BASENAME.service"
  SERVICE_HINT="systemctl status $SERVICE_BASENAME.service"
elif [ "$INSTALL_SERVICE" -eq 1 ] && [ "$PLATFORM" = "Linux" ]; then
  printf '提示：未检测到 systemd，未注册开机服务；请使用以下命令手动启动。\n' >&2
  SERVICE_HINT="$MANUAL_START"
else
  SERVICE_HINT="$MANUAL_START"
fi

ACTIVE_PORT="$(sed -n 's/^PORT=//p' "$ENV_FILE" | tail -n 1)"
if [ "$MODE" = "engine" ]; then
  ACCESS_HINT="http://<服务器IP>:${ACTIVE_PORT:-3100}"
else
  ACCESS_HINT="http://127.0.0.1:${ACTIVE_PORT:-3000}"
fi
printf '\n%s 安装完成。\n访问地址：%s\n服务检查：%s\n' "$MODE" "$ACCESS_HINT" "$SERVICE_HINT"
if [ -n "$CREATED_USERNAME" ]; then
  printf '\n请使用以下账号登录：\n用户名：%s\n密码：%s\n' "$CREATED_USERNAME" "$CREATED_PASSWORD"
  printf '请妥善保存账号信息；网页端不提供注册功能。\n'
fi
if [ -n "$CREATED_ENGINE_TOKEN" ]; then
  printf '\nEngine 访问 Token（只显示这一次）：\n%s\n' "$CREATED_ENGINE_TOKEN"
  printf '在 Client 中填写引擎地址和此 Token 即可完成连接。\n'
fi
