#!/usr/bin/env bash
# Completely uninstall T-Agent (project files, database, task directory and startup entries).
# Usage: curl -fsSL https://raw.githubusercontent.com/TorinMars/t-agent/main/uninstall.sh | bash

set -euo pipefail

APP_DIR="${T_AGENT_DIR:-$PWD/t-agent}"
SERVICE_NAME='t-agent.service'
LAUNCH_LABEL='com.tagent.client'
LAUNCH_PLIST=""
TASKS_PATH=""
APP_PORT=""

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

[ -r /dev/tty ] || fail "An interactive terminal is needed to confirm the uninstall"
case "$APP_DIR" in
  /|"$HOME"|"$PWD") fail "Unsafe install directory: $APP_DIR; set T_AGENT_DIR to the exact project directory" ;;
esac

if [ -f "$APP_DIR/.env" ]; then
  APP_PORT="$(sed -n 's/^PORT=//p' "$APP_DIR/.env" | tail -n 1)"
  TASKS_PATH="$(sed -n 's/^TASKS_BASE_DIR=//p' "$APP_DIR/.env" | tail -n 1)"
fi
LAUNCH_PLIST="$HOME/Library/LaunchAgents/$LAUNCH_LABEL.plist"

printf '\nThis will completely uninstall T-Agent. The following will be permanently deleted:\n'
printf '  - Project directory: %s\n' "$APP_DIR"
printf '  - Database, logs, configuration and task files inside the project\n'
[ -n "$TASKS_PATH" ] && printf '  - Task working directory: %s\n' "$TASKS_PATH"
printf '  - The PM2 process named t-agent, and the macOS LaunchAgent or Linux systemd startup entry\n\n'
read -r -p 'Type UNINSTALL to confirm permanent deletion:' CONFIRMATION </dev/tty
[ "$CONFIRMATION" = 'UNINSTALL' ] || { printf 'Uninstall cancelled.\n'; exit 0; }

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
safe_delete_target "$APP_DIR"

printf '\nT-Agent is completely uninstalled: startup entries, service process, project data and task directory are all removed.\n'
