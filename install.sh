#!/usr/bin/env bash
# 一键安装脚本：服务默认由 PM2 管理；已注册 macOS LaunchAgent / Linux systemd 的老安装继续沿用（--pm2 可迁移）。
# 示例：
#   ./install.sh
#   ./install.sh --port 13148 --tasks-dir /srv/t-agent-tasks

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ENV_FILE="$APP_DIR/.env"
PORT=""
TASKS_DIR=""
INSTALL_SERVICE=1
ACCESS_MODE_ARG=
SERVICE_MANAGER=""
PM2_EXPLICIT=0
SERVICE_STARTED=0
MODE="client"
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
  --port PORT          服务端口（默认 3000）
  --tasks-dir PATH     任务 Markdown 文件保存目录（默认：项目目录/tasks）
  --pm2                用 PM2 管理服务（默认方式；已注册系统服务的老安装用它改为 PM2）
  --system-service     沿用系统服务（macOS LaunchAgent / Linux systemd）而不是 PM2
  --no-service         只安装依赖和配置，不启动服务
  --access-mode MODE   访问方式：remote = 身份验证器 + 允许外网访问；local = 仅本机访问、无需验证。
                       不指定时，安装后第一次在本机浏览器打开页面再选择；之后可在 设置 → 访问模式 切换
  -h, --help           显示帮助

Client 是单用户应用。访问方式二选一：身份验证器登录并允许外网访问，或仅本机访问且无需验证。
EOF
}

fail() {
  printf '错误：%s\n' "$*" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --mode) MODE="${2:-}"; shift 2 ;; # 兼容旧自动化参数；独立 Engine 已移除。
    --port) PORT="${2:-}"; shift 2 ;;
    --username|--password) shift 2 ;; # 兼容旧自动化参数，单用户模式不再使用。
    --tasks-dir) TASKS_DIR="${2:-}"; shift 2 ;;
    --pm2) SERVICE_MANAGER="pm2"; PM2_EXPLICIT=1; shift ;;
    --system-service) SERVICE_MANAGER="system"; shift ;;
    --no-service) INSTALL_SERVICE=0; shift ;;
    --access-mode) ACCESS_MODE_ARG="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "未知选项：$1（使用 --help 查看用法）" ;;
  esac
done

[ "$MODE" = "client" ] || fail "独立 Engine 安装已移除，只支持 client（Client 已内置 Engine）"
[[ "$UPDATE_REPOSITORY" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] && [[ "$UPDATE_REPOSITORY" != ../* ]] && [[ "$UPDATE_REPOSITORY" != */.. ]] || fail "T_AGENT_REPOSITORY 格式不正确"
[[ "$UPDATE_REF" =~ ^[A-Za-z0-9._/-]+$ ]] && [[ "$UPDATE_REF" != *..* ]] || fail "T_AGENT_REF 格式不正确"

case "$ACCESS_MODE_ARG" in
  ""|local|remote) ;;
  *) fail "--access-mode 只能是 local 或 remote" ;;
esac

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

systemd_is_available() {
  command -v systemctl >/dev/null 2>&1 \
    && [ -d /run/systemd/system ] \
    && systemctl show-environment >/dev/null 2>&1
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
  local clang_c
  local clang_cxx
  local toolset
  local toolset_root
  if compiler_supports_cxx20 "$compiler"; then
    return
  fi

  # Ubuntu 20.04 ships GCC 9, which only understands the older c++2a spelling.
  # Clang 10+ accepts c++20 and can compile the native modules with libstdc++.
  if command -v clang++ >/dev/null 2>&1 && compiler_supports_cxx20 clang++; then
    clang_c="$(command -v clang)"
    clang_cxx="$(command -v clang++)"
    export CC="$clang_c"
    export CXX="$clang_cxx"
    printf '当前 g++ 不支持 -std=c++20，改用 %s 编译原生模块。\n' "$(clang++ --version | head -n 1)"
    return
  fi

  if command -v apt-get >/dev/null 2>&1; then
    printf '当前 C++ 编译器不支持 -std=c++20，正在安装 Clang……\n'
    run_as_root apt-get update
    if run_as_root apt-get install -y clang && compiler_supports_cxx20 clang++; then
      clang_c="$(command -v clang)"
      clang_cxx="$(command -v clang++)"
      export CC="$clang_c"
      export CXX="$clang_cxx"
      printf '使用 %s 编译原生模块。\n' "$(clang++ --version | head -n 1)"
      return
    fi
  elif command -v dnf >/dev/null 2>&1; then
    printf '当前 C++ 编译器不支持 -std=c++20，正在查找 GCC Toolset……\n'
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

  fail "未找到支持 -std=c++20 的 C++ 编译器。Ubuntu/Debian 请安装 clang；CentOS/RHEL 8+ 请安装 gcc-toolset-12，然后重新运行安装脚本"
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
  [ -n "$PORT" ] || PORT=3000
  [ -n "$TASKS_DIR" ] || TASKS_DIR="$APP_DIR/tasks"

  # 监听地址：选择“仅本机访问”时只监听回环地址；否则监听所有网卡，是否允许外部访问由应用内的访问模式决定
  # （未选择或仅本机模式下，应用会拒绝非本机请求），这样首次选择和之后在设置里切换都不需要改配置、重启。
  if [ "$ACCESS_MODE_ARG" = "local" ]; then NEW_HOST=127.0.0.1; else NEW_HOST=0.0.0.0; fi
  SESSION_SECRET="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")"
  umask 077
  cat > "$ENV_FILE" <<EOF
PORT=$PORT
T_AGENT_MODE=$MODE
SESSION_SECRET=$SESSION_SECRET
SINGLE_USER_ID=local
AUTH_USERS=
TASKS_BASE_DIR=$TASKS_DIR
ENGINE_OWNER_ID=local
HOST=$NEW_HOST
ACCESS_MODE=$ACCESS_MODE_ARG
GITHUB_VERSION_URL=https://api.github.com/repos/$UPDATE_REPOSITORY/contents/VERSION.json?ref=$UPDATE_REF
UPDATE_GITHUB_REPOSITORY=$UPDATE_REPOSITORY
UPDATE_GITHUB_REF=$UPDATE_REF
UPDATE_GIT_BRANCH=$UPDATE_REF
UPDATE_CHECK_ENABLED=true
UPDATE_CHECK_INTERVAL_SECONDS=1800
EOF
  printf '已创建 %s\n' "$ENV_FILE"
else
  printf '保留现有 %s（不会覆盖数据归属和密钥）。\n' "$ENV_FILE"
  [ -n "$PORT" ] && update_env_value PORT "$PORT"
  if [ -n "$TASKS_DIR" ]; then
    update_env_value TASKS_BASE_DIR "$TASKS_DIR"
  fi
  update_env_value T_AGENT_MODE "$MODE"
  [ -n "$ACCESS_MODE_ARG" ] && update_env_value ACCESS_MODE "$ACCESS_MODE_ARG"
  # 默认仅监听本机；保留用户为手机访问配置的局域网监听地址。
  ensure_env_value HOST 127.0.0.1
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

# Linux 上服务以 root 运行时，网页终端降权到普通用户（默认 dev）：Claude Code 在 root 下拒绝“跳过权限确认”的模式。
# 已在 .env 配置 TERMINAL_USER 的沿用原值（留空表示不降权）；macOS 或非 root 安装不处理。
setup_terminal_user() {
  [ "$PLATFORM" = "Linux" ] && [ "${EUID}" -eq 0 ] || return 0
  local user
  if grep -q '^TERMINAL_USER=' "$ENV_FILE" 2>/dev/null; then
    user="$(sed -n 's/^TERMINAL_USER=//p' "$ENV_FILE" | tail -n 1)"
  else
    user=dev
    update_env_value TERMINAL_USER "$user"
  fi
  if [ -z "$user" ] || [ "$user" = "root" ]; then
    printf '终端用户：不降权，网页终端以 root 运行（Claude Code 在 root 下无法使用跳过权限确认的模式）。\n'
    return 0
  fi
  if ! id "$user" >/dev/null 2>&1; then
    if command -v useradd >/dev/null 2>&1; then
      useradd -m -s "$(command -v bash || echo /bin/sh)" "$user" || { printf '警告：无法创建用户 %s，网页终端将以 root 运行。\n' "$user" >&2; return 0; }
      printf '已创建终端用户：%s（家目录 /home/%s，无密码）。\n' "$user" "$user"
    else
      printf '警告：没有 useradd，无法创建用户 %s，网页终端将以 root 运行。\n' "$user" >&2
      return 0
    fi
  fi
  # 终端要在任务目录里读写；只处理位于安装目录内的默认任务目录，自定义目录不擅自改属主。
  if [ -n "$TASKS_DIR" ]; then
    case "$TASKS_DIR" in
      "$APP_DIR"/*) chown -R "$user" "$TASKS_DIR" && printf '已把任务目录 %s 交给 %s。\n' "$TASKS_DIR" "$user" ;;
      *) printf '提示：任务目录 %s 不在安装目录内，未改属主；请确保 %s 能读写它，例如：chown -R %s %s\n' "$TASKS_DIR" "$user" "$user" "$TASKS_DIR" ;;
    esac
  fi
  printf '网页终端将以 %s 身份运行；需要 root 操作请另开 root 会话。\n' "$user"
}
setup_terminal_user

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

NODE_BIN="$(command -v node)"
SERVICE_PATH="$(dirname "$NODE_BIN"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
ENTRY_SCRIPT="$APP_DIR/server.js"
SERVICE_BASENAME="t-agent"
SERVICE_DESCRIPTION="T-Agent Client with embedded Engine"
LAUNCH_LABEL="com.tagent.client"
MANUAL_START="cd $APP_DIR && npm start"
legacy_client_service_present() {
  if [ "$PLATFORM" = "macOS" ]; then
    [ -f "$HOME/Library/LaunchAgents/com.tagent.client.plist" ] || [ -f "$HOME/Library/LaunchAgents/com.tagent.web.plist" ]
  else
    [ -f /etc/systemd/system/t-agent.service ]
  fi
}

# 显式改用 PM2 时，先停用并移除旧的系统服务，避免两个实例抢同一个端口。
migrate_legacy_client_service() {
  printf '正在停用旧的系统服务，改由 PM2 管理……\n'
  if [ "$PLATFORM" = "macOS" ]; then
    launchctl bootout "gui/$UID" "$HOME/Library/LaunchAgents/com.tagent.client.plist" 2>/dev/null || true
    launchctl bootout "gui/$UID" "$HOME/Library/LaunchAgents/com.tagent.web.plist" 2>/dev/null || true
    rm -f "$HOME/Library/LaunchAgents/com.tagent.client.plist" "$HOME/Library/LaunchAgents/com.tagent.web.plist"
  else
    run_as_root systemctl disable --now t-agent.service 2>/dev/null || true
    run_as_root rm -f /etc/systemd/system/t-agent.service
    run_as_root systemctl daemon-reload || true
  fi
}

ensure_pm2() {
  local prefix
  export PATH="$HOME/.local/bin:$PATH"
  command -v pm2 >/dev/null 2>&1 && return 0
  printf '正在安装 PM2……\n'
  prefix="$(npm config get prefix 2>/dev/null || true)"
  if [ -n "$prefix" ] && [ -w "$prefix" ]; then
    npm install -g pm2 || return 1
  else
    npm install -g --prefix "$HOME/.local" pm2 || return 1
  fi
  command -v pm2 >/dev/null 2>&1
}

port_in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# 默认由 PM2 管理；已经注册了系统服务（LaunchAgent / systemd）的老安装继续沿用，避免悄悄切换造成两个实例抢端口。
if [ -z "$SERVICE_MANAGER" ]; then
  if legacy_client_service_present; then
    SERVICE_MANAGER="system"
    printf '提示：检测到已注册的系统服务，继续沿用它；需要改用 PM2 管理请加 --pm2 重新运行。\n'
  else
    SERVICE_MANAGER="pm2"
  fi
fi

if [ "$INSTALL_SERVICE" -eq 1 ] && [ "$SERVICE_MANAGER" = "pm2" ]; then
  if [ "$PM2_EXPLICIT" -eq 1 ] && legacy_client_service_present; then
    migrate_legacy_client_service
  fi
  APP_PORT="$(sed -n 's/^PORT=//p' "$ENV_FILE" | tail -n 1 | tr -d "\"' ")"
  APP_PORT="${APP_PORT:-3000}"
  if ! ensure_pm2; then
    printf '警告：无法安装或找到 PM2，未启动服务。请手动安装 PM2 后执行：pm2 start %s --name %s --cwd %s\n' "$ENTRY_SCRIPT" "$SERVICE_BASENAME" "$APP_DIR" >&2
    SERVICE_HINT="$MANUAL_START"
  elif ! pm2 describe "$SERVICE_BASENAME" >/dev/null 2>&1 && port_in_use "$APP_PORT"; then
    printf '警告：端口 %s 已被其他进程占用，未启动服务。请换端口（编辑 .env 的 PORT）或停掉占用者后执行：pm2 start %s --name %s --cwd %s\n' "$APP_PORT" "$ENTRY_SCRIPT" "$SERVICE_BASENAME" "$APP_DIR" >&2
    SERVICE_HINT="$MANUAL_START"
  else
    if pm2 describe "$SERVICE_BASENAME" >/dev/null 2>&1; then
      pm2 restart "$SERVICE_BASENAME" --update-env
    else
      pm2 start "$ENTRY_SCRIPT" --name "$SERVICE_BASENAME" --cwd "$APP_DIR"
    fi
    pm2 save >/dev/null 2>&1 || true
    SERVICE_STARTED=1
    SERVICE_HINT="pm2 status $SERVICE_BASENAME（日志：pm2 logs $SERVICE_BASENAME；开机自启请执行 pm2 startup，按提示运行后再 pm2 save）"
  fi
elif [ "$INSTALL_SERVICE" -eq 1 ] && [ "$PLATFORM" = "macOS" ]; then
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
  SERVICE_STARTED=1
  SERVICE_HINT="launchctl kickstart -k gui/$UID/$LAUNCH_LABEL"
elif [ "$INSTALL_SERVICE" -eq 1 ] && [ "$PLATFORM" = "Linux" ] && systemd_is_available; then
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
  SERVICE_STARTED=1
  SERVICE_HINT="systemctl status $SERVICE_BASENAME.service"
elif [ "$INSTALL_SERVICE" -eq 1 ] && [ "$PLATFORM" = "Linux" ]; then
  printf '提示：当前 Linux 环境没有运行 systemd，未注册开机服务；请使用以下命令启动，或交给容器/进程管理器托管。\n' >&2
  SERVICE_HINT="$MANUAL_START"
else
  SERVICE_HINT="$MANUAL_START"
fi

# Installation summary.
ACCESS_HINT="$(node - "$APP_DIR" "$ENV_FILE" "$MODE" <<'NODE'
const fs = require('fs');
const path = require('path');
const [appDir, envFile, mode] = process.argv.slice(2);
const env = require(path.join(appDir, 'node_modules/dotenv')).parse(fs.readFileSync(envFile));
const port = parseInt(env.PORT || '3000', 10);
let host = env.HOST || '127.0.0.1';
if (host === '0.0.0.0') host = '127.0.0.1';
if (host === '::') host = '::1';
if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
process.stdout.write(`http://${host}:${port}`);
NODE
)"
printf '\n%s 安装完成。\n' "$MODE"
case "${ACCESS_MODE_ARG:-}" in
  local) printf '访问方式：仅本机访问，无需验证。之后可在 设置 → 访问模式 改为身份验证器 + 允许外网访问。\n' ;;
  remote) printf '访问方式：身份验证器 + 允许外网访问。第一次打开页面时绑定身份验证器；之后可在 设置 → 访问模式 改为仅本机访问。\n' ;;
  *) printf '访问方式：第一次在本机浏览器打开页面时选择——身份验证器 + 允许外网访问，或仅本机访问（无需验证）；之后可在 设置 → 访问模式 切换。\n' ;;
esac
if [ "$SERVICE_STARTED" -eq 1 ]; then
  printf '服务检查：%s\n' "$SERVICE_HINT"
else
  printf '服务尚未启动，请先执行：\n启动命令：%s\n' "$MANUAL_START"
fi
[ "$SERVICE_STARTED" -eq 1 ] || printf '\n启动后，'
printf '请在浏览器打开：%s\n' "$ACCESS_HINT"
