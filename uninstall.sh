#!/usr/bin/env bash
# Uninstall T-Agent (project files, task directory and startup entries). The data folder (~/.tagent: database, keys, backups)
# is shared by every installed version, so it is kept unless --purge-data is given (with its own confirmation).
# Usage: curl -fsSL https://raw.githubusercontent.com/TorinMars/t-agent/main/uninstall.sh | bash
#        curl -fsSL https://raw.githubusercontent.com/TorinMars/t-agent/main/uninstall.sh | bash -s -- --purge-data

set -euo pipefail

APP_DIR="${T_AGENT_DIR:-$PWD/t-agent}"
SERVICE_NAME='t-agent.service'
LAUNCH_LABEL='com.tagent.client'
LAUNCH_PLIST=""
TASKS_PATH=""
APP_PORT=""
DATA_PATH=""
PURGE_DATA=0
# The terminal the confirmations are read from (the override is for the test).
TTY="${T_AGENT_UNINSTALL_TTY:-/dev/tty}"

for arg in "$@"; do
  case "$arg" in
    --purge-data) PURGE_DATA=1 ;;
    -h|--help) printf 'Usage: uninstall.sh [--purge-data]\n  --purge-data  also delete the data folder (~/.tagent), which every installed version shares\n'; exit 0 ;;
    *) printf 'Error: unknown option %s\n' "$arg" >&2; exit 1 ;;
  esac
done

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

run_as_root() {
  if [ "${EUID}" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    fail "Administrator rights are required; run as root or install sudo"
  fi
}

safe_delete_target() {
  local target="$1"
  [ -n "$target" ] || return
  case "$target" in
    /|"$HOME"|"$PWD") fail "Refusing to delete an unsafe target: $target" ;;
  esac
  rm -rf "$target"
}

[ -r "$TTY" ] || fail "An interactive terminal is needed to confirm the uninstall"
case "$APP_DIR" in
  /|"$HOME"|"$PWD") fail "Unsafe install directory: $APP_DIR; set T_AGENT_DIR to the exact project directory" ;;
esac

if [ -f "$APP_DIR/.env" ]; then
  APP_PORT="$(sed -n 's/^PORT=//p' "$APP_DIR/.env" | tail -n 1)"
  TASKS_PATH="$(sed -n 's/^TASKS_BASE_DIR=//p' "$APP_DIR/.env" | tail -n 1)"
  DATA_PATH="$(sed -n 's/^TAGENT_HOME=//p; s/^T_AGENT_DATA_DIR=//p' "$APP_DIR/.env" | tail -n 1)"
fi
# The data folder (database, session secret, backups) is outside the project: ~/.tagent unless .env names another one.
[ -n "$DATA_PATH" ] || DATA_PATH="$HOME/.tagent"
LAUNCH_PLIST="$HOME/Library/LaunchAgents/$LAUNCH_LABEL.plist"

printf '\nThis will uninstall T-Agent. The following will be permanently deleted:\n'
printf '  - Project directory: %s\n' "$APP_DIR"
printf '  - Logs, configuration and old data inside the project\n'
if [ "$PURGE_DATA" -eq 1 ] && [ -d "$DATA_PATH" ]; then
  printf '  - Data folder (database, keys, backups; shared by every installed version): %s\n' "$DATA_PATH"
fi
[ -n "$TASKS_PATH" ] && printf '  - Task working directory: %s\n' "$TASKS_PATH"
printf '  - The PM2 process named t-agent, and the macOS LaunchAgent or Linux systemd startup entry\n\n'
exec 3<"$TTY"
read -r -p 'Type UNINSTALL to confirm permanent deletion:' CONFIRMATION <&3
[ "$CONFIRMATION" = 'UNINSTALL' ] || { printf 'Uninstall cancelled.\n'; exit 0; }
if [ "$PURGE_DATA" -eq 1 ] && [ -d "$DATA_PATH" ]; then
  printf '\nThe data folder %s is used by every installed version of T-Agent on this machine.\n' "$DATA_PATH"
  read -r -p 'Type DELETE DATA to delete it as well (anything else keeps it):' DATA_CONFIRMATION <&3 || DATA_CONFIRMATION=''
  [ "$DATA_CONFIRMATION" = 'DELETE DATA' ] || { PURGE_DATA=0; printf 'The data folder is kept.\n'; }
fi

# The Client is managed by PM2 by default: delete the process and save the list, so a later pm2 resurrect does not bring it back.
if command -v pm2 >/dev/null 2>&1 && pm2 describe t-agent >/dev/null 2>&1; then
  pm2 delete t-agent >/dev/null 2>&1 || true
  pm2 save >/dev/null 2>&1 || true
fi

case "$(uname -s)" in
  Darwin)
    launchctl bootout "gui/$UID" "$LAUNCH_PLIST" 2>/dev/null || true
    rm -f "$LAUNCH_PLIST"
    # Clean up the LaunchAgent name of early versions.
    launchctl bootout "gui/$UID" "$HOME/Library/LaunchAgents/com.tagent.web.plist" 2>/dev/null || true
    rm -f "$HOME/Library/LaunchAgents/com.tagent.web.plist"
    ;;
  Linux)
    if command -v systemctl >/dev/null 2>&1; then
      run_as_root systemctl disable --now "$SERVICE_NAME" 2>/dev/null || true
      run_as_root rm -f "/etc/systemd/system/$SERVICE_NAME"
      run_as_root systemctl daemon-reload
    fi
    ;;
esac

if [[ "$APP_PORT" =~ ^[1-9][0-9]{0,4}$ ]] && [ "$APP_PORT" -le 65535 ] && command -v fuser >/dev/null 2>&1; then
  run_as_root fuser -k "$APP_PORT/tcp" 2>/dev/null || true
fi

# If TASKS_BASE_DIR lies inside the project directory it is removed with the project; an external path is cleaned separately.
if [ -n "$TASKS_PATH" ] && [ "$TASKS_PATH" != "$APP_DIR" ] && [[ "$TASKS_PATH" != "$APP_DIR/"* ]]; then
  safe_delete_target "$TASKS_PATH"
fi
if [ "$PURGE_DATA" -eq 1 ] && [ -d "$DATA_PATH" ]; then
  safe_delete_target "$DATA_PATH"
fi
safe_delete_target "$APP_DIR"

printf '\nT-Agent is uninstalled: startup entries, service process, project and task directory are removed.\n'
if [ -d "$DATA_PATH" ]; then
  printf 'The data folder is kept: %s (database, keys, backups; other installed versions use it too).\n' "$DATA_PATH"
  printf 'To delete it by hand: rm -rf "%s"   (or run this script again with --purge-data)\n' "$DATA_PATH"
elif [ "$PURGE_DATA" -eq 1 ]; then
  printf 'The data folder %s was deleted.\n' "$DATA_PATH"
fi
