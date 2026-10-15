#!/usr/bin/env bash
# One-step install script: the service is managed by PM2 by default; old installs already registered as a macOS LaunchAgent / Linux systemd service keep using it (--pm2 can migrate).
# Example:
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
Usage: ./install.sh [options]

Options:
  --port PORT          service port (default 3000)
  --tasks-dir PATH     directory for task Markdown files (default: project directory/tasks)
  --pm2                manage the service with PM2 (default; older installs registered as a system service use it to switch to PM2)
  --system-service     keep using a system service (macOS LaunchAgent / Linux systemd) instead of PM2
  --no-service         only install dependencies and configuration; do not start the service
  --access-mode MODE   access mode: remote = authenticator + external access allowed; local = local access only, no verification.
                       When omitted, choose it the first time you open the page in a browser on this machine after installation; you can switch later under Settings → Access mode
  -h, --help           show this help

The Client is a single-user application. Pick one of two access modes: authenticator login with external access, or local access only without verification.
EOF
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --mode) MODE="${2:-}"; shift 2 ;; # kept for compatibility with old automation arguments; the standalone Engine has been removed.
    --port) PORT="${2:-}"; shift 2 ;;
    --username|--password) shift 2 ;; # kept for compatibility with old automation arguments; single-user mode no longer uses them.
    --tasks-dir) TASKS_DIR="${2:-}"; shift 2 ;;
    --pm2) SERVICE_MANAGER="pm2"; PM2_EXPLICIT=1; shift ;;
    --system-service) SERVICE_MANAGER="system"; shift ;;
    --no-service) INSTALL_SERVICE=0; shift ;;
    --access-mode) ACCESS_MODE_ARG="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown option: $1 (use --help for usage)" ;;
  esac
done

[ "$MODE" = "client" ] || fail "Standalone Engine installation has been removed; only client is supported (the Client includes the Engine)"
[[ "$UPDATE_REPOSITORY" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] && [[ "$UPDATE_REPOSITORY" != ../* ]] && [[ "$UPDATE_REPOSITORY" != */.. ]] || fail "T_AGENT_REPOSITORY has an invalid format"
[[ "$UPDATE_REF" =~ ^[A-Za-z0-9._/-]+$ ]] && [[ "$UPDATE_REF" != *..* ]] || fail "T_AGENT_REF has an invalid format"

case "$ACCESS_MODE_ARG" in
  ""|local|remote) ;;
  *) fail "--access-mode must be local or remote" ;;
esac

if [ -n "$PORT" ] && ! [[ "$PORT" =~ ^[1-9][0-9]{0,4}$ ]] || { [ -n "$PORT" ] && [ "$PORT" -gt 65535 ]; }; then
  fail "Port must be an integer between 1 and 65535"
fi

case "$(uname -s)" in
  Darwin) PLATFORM="macOS" ;;
  Linux) PLATFORM="Linux" ;;
  *) fail "Unsupported system: $(uname -s)" ;;
esac

run_as_root() {
  if [ "${EUID}" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    fail "Administrator rights are required; run as root or install sudo"
  fi
}

systemd_is_available() {
  command -v systemctl >/dev/null 2>&1 \
    && [ -d /run/systemd/system ] \
    && systemctl show-environment >/dev/null 2>&1
}

install_system_dependencies() {
  if ! command -v node >/dev/null 2>&1; then
    printf 'Node.js not found; installing……\n'
    if [ "$PLATFORM" = "macOS" ]; then
      command -v brew >/dev/null 2>&1 || fail "Please install Homebrew first: https://brew.sh/"
      brew install node
    elif command -v apt-get >/dev/null 2>&1; then
      run_as_root apt-get update
      run_as_root apt-get install -y nodejs npm
    elif command -v dnf >/dev/null 2>&1; then
      run_as_root dnf install -y nodejs npm
    elif command -v yum >/dev/null 2>&1; then
      run_as_root yum install -y nodejs npm
    else
      fail "Unrecognized package manager; install Node.js 20+, Python 3 and a C++20 compiler toolchain first"
    fi
  fi

  if [ "$PLATFORM" = "Linux" ] && { ! command -v python3 >/dev/null 2>&1 || ! command -v make >/dev/null 2>&1 || ! command -v g++ >/dev/null 2>&1; }; then
    printf 'Installing native module build tools……\n'
    if command -v apt-get >/dev/null 2>&1; then
      run_as_root apt-get update
      run_as_root apt-get install -y python3 build-essential
    elif command -v dnf >/dev/null 2>&1; then
      run_as_root dnf install -y python3 make gcc gcc-c++
    elif command -v yum >/dev/null 2>&1; then
      run_as_root yum install -y python3 make gcc gcc-c++
    else
      fail "Unrecognized package manager; install Python 3, make and a C++20-capable g++ first"
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
    printf 'The current g++ does not support -std=c++20; building native modules with %s instead.\n' "$(clang++ --version | head -n 1)"
    return
  fi

  if command -v apt-get >/dev/null 2>&1; then
    printf 'The current C++ compiler does not support -std=c++20; installing Clang……\n'
    run_as_root apt-get update
    if run_as_root apt-get install -y clang && compiler_supports_cxx20 clang++; then
      clang_c="$(command -v clang)"
      clang_cxx="$(command -v clang++)"
      export CC="$clang_c"
      export CXX="$clang_cxx"
      printf 'Building native modules with %s.\n' "$(clang++ --version | head -n 1)"
      return
    fi
  elif command -v dnf >/dev/null 2>&1; then
    printf 'The current C++ compiler does not support -std=c++20; looking for a GCC Toolset……\n'
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
        printf 'Building native modules with GCC Toolset %s.\n' "$toolset"
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
        printf 'Building native modules with Developer Toolset %s.\n' "$toolset"
        return
      fi
    done
  fi

  fail "No C++ compiler supporting -std=c++20 found. On Ubuntu/Debian install clang; on CentOS/RHEL 8+ install gcc-toolset-12; then run the install script again"
}

install_system_dependencies
command -v node >/dev/null 2>&1 || fail "Node.js installation failed"
command -v npm >/dev/null 2>&1 || fail "npm not found; install the npm that matches your Node.js and retry"
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
[ "$NODE_MAJOR" -ge 20 ] && [ "$NODE_MAJOR" -ne 21 ] || fail "The dependencies need Node.js 20 or 22+ (22 LTS recommended); the current version is $(node --version)"

if [ "$PLATFORM" = "macOS" ] && ! xcode-select -p >/dev/null 2>&1; then
  printf 'Note: Xcode Command Line Tools not found. If building node-pty fails, run: xcode-select --install\n' >&2
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

  # Listen address: when "local access only" is chosen listen on loopback only; otherwise listen on all interfaces, and whether external access is allowed is decided by the in-app access mode
  # (the app refuses non-local requests when no mode is chosen or in local-only mode), so choosing for the first time and switching later in settings need no config change or restart.
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
  printf 'Created %s\n' "$ENV_FILE"
else
  printf 'Keeping the existing %s (data ownership and keys are not overwritten).\n' "$ENV_FILE"
  [ -n "$PORT" ] && update_env_value PORT "$PORT"
  if [ -n "$TASKS_DIR" ]; then
    update_env_value TASKS_BASE_DIR "$TASKS_DIR"
  fi
  update_env_value T_AGENT_MODE "$MODE"
  [ -n "$ACCESS_MODE_ARG" ] && update_env_value ACCESS_MODE "$ACCESS_MODE_ARG"
  # Listen on this machine only by default; keep the LAN listen address the user configured for phone access.
  ensure_env_value HOST 127.0.0.1
fi

# Old archive installs have no Git metadata; once the update source is filled in they can also check and upgrade automatically from the button.
ensure_env_value GITHUB_VERSION_URL "https://api.github.com/repos/$UPDATE_REPOSITORY/contents/VERSION.json?ref=$UPDATE_REF"
ensure_env_value UPDATE_GITHUB_REPOSITORY "$UPDATE_REPOSITORY"
ensure_env_value UPDATE_GITHUB_REF "$UPDATE_REF"
ensure_env_value UPDATE_GIT_BRANCH "$UPDATE_REF"
ensure_env_value UPDATE_CHECK_ENABLED true
ensure_env_value UPDATE_CHECK_INTERVAL_SECONDS 1800

# A Git working copy uses its current branch as the only update source, so an old config pointing at another branch is not kept.
if git -C "$APP_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  update_env_value UPDATE_GITHUB_REPOSITORY "$UPDATE_REPOSITORY"
  update_env_value UPDATE_GITHUB_REF "$UPDATE_REF"
  update_env_value UPDATE_GIT_REMOTE origin
  update_env_value UPDATE_GIT_BRANCH "$UPDATE_REF"
fi

TASKS_DIR="$(sed -n 's/^TASKS_BASE_DIR=//p' "$ENV_FILE" | tail -n 1)"
[ -n "$TASKS_DIR" ] && mkdir -p "$TASKS_DIR"

# When the service runs as root on Linux, the web terminal drops to an ordinary user (default dev): Claude Code refuses the "skip permission prompts" mode as root.
# A TERMINAL_USER already configured in .env keeps its value (empty means no privilege drop); macOS and non-root installs are left alone.
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
    printf 'Terminal user: privileges are not dropped, so the web terminal runs as root (Claude Code cannot use its skip-permission-prompts mode as root).\n'
    return 0
  fi
  if ! id "$user" >/dev/null 2>&1; then
    if command -v useradd >/dev/null 2>&1; then
      useradd -m -s "$(command -v bash || echo /bin/sh)" "$user" || { printf 'Warning: cannot create user %s; the web terminal will run as root.\n' "$user" >&2; return 0; }
      printf 'Created terminal user: %s (home /home/%s, no password).\n' "$user" "$user"
    else
      printf 'Warning: useradd is missing, so user %s cannot be created; the web terminal will run as root.\n' "$user" >&2
      return 0
    fi
  fi
  # The terminal must read and write inside the task directory; only the default task directory inside the install directory is handled, a custom directory's owner is never changed on our own.
  if [ -n "$TASKS_DIR" ]; then
    case "$TASKS_DIR" in
      "$APP_DIR"/*) chown -R "$user" "$TASKS_DIR" && printf 'Gave the tasks directory %s to %s.\n' "$TASKS_DIR" "$user" ;;
      *) printf 'Note: the tasks directory %s is outside the install directory and its owner was not changed; make sure %s can read and write it, for example: chown -R %s %s\n' "$TASKS_DIR" "$user" "$user" "$TASKS_DIR" ;;
    esac
  fi
  printf 'The web terminal will run as %s; open a separate root session for operations that need root.\n' "$user"
}
setup_terminal_user

printf 'Installing Node.js dependencies……\n'
if [ -f "$APP_DIR/package-lock.json" ]; then
  npm ci --omit=dev --ignore-scripts=false --prefix "$APP_DIR"
else
  npm install --omit=dev --ignore-scripts=false --prefix "$APP_DIR"
fi

verify_node_pty() {
  node "$APP_DIR/scripts/verify-node-pty.js" >/dev/null 2>&1
}

if ! verify_node_pty; then
  printf 'The node-pty native module is not ready; rebuilding……\n'
  npm rebuild node-pty --ignore-scripts=false --foreground-scripts --prefix "$APP_DIR"
  verify_node_pty || fail "node-pty cannot be loaded; on macOS run xcode-select --install first, then run the install script again"
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

# When PM2 is chosen explicitly, first stop and remove the old system service so two instances do not fight over the same port.
migrate_legacy_client_service() {
  printf 'Disabling the old system service; PM2 will manage it instead……\n'
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
  printf 'Installing PM2……\n'
  prefix="$(npm config get prefix 2>/dev/null || true)"
  if [ -n "$prefix" ] && [ -w "$prefix" ]; then
    npm install -g pm2 || return 1
  else
    npm install -g --prefix "$HOME/.local" pm2 || return 1
  fi
  command -v pm2 >/dev/null 2>&1
}

port_in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# Managed by PM2 by default; old installs that already registered a system service (LaunchAgent / systemd) keep using it, so a silent switch does not leave two instances fighting over the port.
if [ -z "$SERVICE_MANAGER" ]; then
  if legacy_client_service_present; then
    SERVICE_MANAGER="system"
    printf 'Note: a registered system service was detected and will keep being used; add --pm2 and run again to switch to PM2.\n'
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
    printf 'Warning: cannot install or find PM2, so the service was not started. Install PM2 manually, then run: pm2 start %s --name %s --cwd %s\n' "$ENTRY_SCRIPT" "$SERVICE_BASENAME" "$APP_DIR" >&2
    SERVICE_HINT="$MANUAL_START"
  elif ! pm2 describe "$SERVICE_BASENAME" >/dev/null 2>&1 && port_in_use "$APP_PORT"; then
    printf 'Warning: port %s is used by another process, so the service was not started. Change the port (edit PORT in .env) or stop the other process, then run: pm2 start %s --name %s --cwd %s\n' "$APP_PORT" "$ENTRY_SCRIPT" "$SERVICE_BASENAME" "$APP_DIR" >&2
    SERVICE_HINT="$MANUAL_START"
  else
    if pm2 describe "$SERVICE_BASENAME" >/dev/null 2>&1; then
      pm2 restart "$SERVICE_BASENAME" --update-env
    else
      pm2 start "$ENTRY_SCRIPT" --name "$SERVICE_BASENAME" --cwd "$APP_DIR"
    fi
    pm2 save >/dev/null 2>&1 || true
    SERVICE_STARTED=1
    SERVICE_HINT="pm2 status $SERVICE_BASENAME (logs: pm2 logs $SERVICE_BASENAME; for start on boot run pm2 startup, follow its prompt, then pm2 save)"
  fi
elif [ "$INSTALL_SERVICE" -eq 1 ] && [ "$PLATFORM" = "macOS" ]; then
  [ "${EUID}" -ne 0 ] || fail "On macOS run this script as the actual login user; a LaunchAgent cannot be installed as root"
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
  printf 'Note: this Linux environment is not running systemd, so no boot service was registered; start it with the commands below, or let a container/process manager host it.\n' >&2
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
printf '\n%s installed.\n' "$MODE"
case "${ACCESS_MODE_ARG:-}" in
  local) printf 'Access mode: local access only, no verification. You can switch to authenticator + external access later under Settings → Access mode.\n' ;;
  remote) printf 'Access mode: authenticator + external access. Bind the authenticator the first time you open the page; you can switch to local access only later under Settings → Access mode.\n' ;;
  *) printf 'Access mode: choose it the first time you open the page in a browser on this machine — authenticator + external access, or local access only (no verification); you can switch later under Settings → Access mode.\n' ;;
esac
if [ "$SERVICE_STARTED" -eq 1 ]; then
  printf 'Service check: %s\n' "$SERVICE_HINT"
else
  printf 'The service is not running yet; run this first:\nStart command: %s\n' "$MANUAL_START"
fi
[ "$SERVICE_STARTED" -eq 1 ] || printf '\nAfter it starts,'
printf 'open this in a browser: %s\n' "$ACCESS_HINT"
