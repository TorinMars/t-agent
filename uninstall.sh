#!/usr/bin/env bash
# 完整卸载 T-Agent（项目文件、数据库、任务目录和开机启动项）。
# 用法：curl -fsSL https://raw.githubusercontent.com/TorinMars/t-agent/main/uninstall.sh | bash

set -euo pipefail

APP_DIR="${T_AGENT_DIR:-$PWD/t-agent}"
SERVICE_NAME='t-agent.service'
LAUNCH_LABEL='com.tagent.client'
LAUNCH_PLIST=""
TASKS_PATH=""
APP_PORT=""

fail() {
  printf '错误：%s\n' "$*" >&2
  exit 1
}

run_as_root() {
  if [ "${EUID}" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    fail "需要管理员权限，请以 root 运行或安装 sudo"
  fi
}

safe_delete_target() {
  local target="$1"
  [ -n "$target" ] || return
  case "$target" in
    /|"$HOME"|"$PWD") fail "拒绝删除不安全的目标：$target" ;;
  esac
  rm -rf "$target"
}

[ -r /dev/tty ] || fail "需要可交互终端来确认卸载"
case "$APP_DIR" in
  /|"$HOME"|"$PWD") fail "安装目录不安全：$APP_DIR；请通过 T_AGENT_DIR 指定准确的项目目录" ;;
esac

if [ -f "$APP_DIR/.env" ]; then
  APP_PORT="$(sed -n 's/^PORT=//p' "$APP_DIR/.env" | tail -n 1)"
  TASKS_PATH="$(sed -n 's/^TASKS_BASE_DIR=//p' "$APP_DIR/.env" | tail -n 1)"
  INSTALL_MODE="$(sed -n 's/^T_AGENT_MODE=//p' "$APP_DIR/.env" | tail -n 1)"
  if [ "$INSTALL_MODE" = "engine" ]; then
    SERVICE_NAME='t-agent-engine.service'
    LAUNCH_LABEL='com.tagent.engine'
  fi
fi
LAUNCH_PLIST="$HOME/Library/LaunchAgents/$LAUNCH_LABEL.plist"

printf '\n将完全卸载 T-Agent。以下内容会永久删除：\n'
printf '  - 项目目录：%s\n' "$APP_DIR"
printf '  - 数据库、日志、配置和项目内任务文件\n'
[ -n "$TASKS_PATH" ] && printf '  - 任务工作目录：%s\n' "$TASKS_PATH"
printf '  - macOS LaunchAgent 或 Linux systemd 开机启动项\n\n'
read -r -p '输入 UNINSTALL 以确认永久删除：' CONFIRMATION </dev/tty
[ "$CONFIRMATION" = 'UNINSTALL' ] || { printf '已取消卸载。\n'; exit 0; }

case "$(uname -s)" in
  Darwin)
    launchctl bootout "gui/$UID" "$LAUNCH_PLIST" 2>/dev/null || true
    rm -f "$LAUNCH_PLIST"
    # 清理早期版本的 LaunchAgent 名称。
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

# TASKS_BASE_DIR 若位于项目目录内，会随项目一起删除；外部路径单独清理。
if [ -n "$TASKS_PATH" ] && [ "$TASKS_PATH" != "$APP_DIR" ] && [[ "$TASKS_PATH" != "$APP_DIR/"* ]]; then
  safe_delete_target "$TASKS_PATH"
fi
safe_delete_target "$APP_DIR"

printf '\nT-Agent 已完全卸载：启动项、服务进程、项目数据和任务目录均已清除。\n'
