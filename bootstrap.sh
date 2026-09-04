#!/usr/bin/env bash
# 从 GitHub 下载完整项目后调用 install.sh。
# 用法：curl -fsSL https://raw.githubusercontent.com/TorinMars/t-agent/main/bootstrap.sh | bash

set -euo pipefail

REPOSITORY_REF="${T_AGENT_REF:-main}"
REPOSITORY_ARCHIVE="https://github.com/TorinMars/t-agent/archive/refs/heads/$REPOSITORY_REF.tar.gz"
TARGET_DIR="${T_AGENT_DIR:-$PWD/t-agent}"
INSTALL_MODE="${T_AGENT_MODE:-client}"
TEMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

command -v curl >/dev/null 2>&1 || { printf '错误：请先安装 curl。\n' >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { printf '错误：请先安装 tar。\n' >&2; exit 1; }
[ "$INSTALL_MODE" = "client" ] || [ "$INSTALL_MODE" = "engine" ] || { printf '错误：T_AGENT_MODE 只能是 client 或 engine。\n' >&2; exit 1; }
[ -r /dev/tty ] || { printf '错误：需要可交互终端来设置安装参数。\n' >&2; exit 1; }

if [ -e "$TARGET_DIR" ]; then
  printf '错误：安装目录已存在：%s\n' "$TARGET_DIR" >&2
  printf '请设置 T_AGENT_DIR 指定新目录，或进入现有项目后执行 ./install.sh。\n' >&2
  exit 1
fi

printf '\nT-Agent 将安装到：%s\n' "$TARGET_DIR"
printf '请勿随意删除此目录；服务、配置、数据库和任务文件都依赖它。\n\n'

if [ "$INSTALL_MODE" = "engine" ]; then DEFAULT_PORT=3100; else DEFAULT_PORT=3000; fi
read -r -p "服务端口 [$DEFAULT_PORT]: " SETUP_PORT </dev/tty
SETUP_PORT="${SETUP_PORT:-$DEFAULT_PORT}"
if ! [[ "$SETUP_PORT" =~ ^[1-9][0-9]{0,4}$ ]] || [ "$SETUP_PORT" -gt 65535 ]; then
  printf '错误：端口必须是 1-65535 的整数。\n' >&2
  exit 1
fi

SETUP_USERNAME=""
SETUP_PASSWORD=""
if [ "$INSTALL_MODE" = "client" ]; then
  read -r -p '登录用户名: ' SETUP_USERNAME </dev/tty
  if ! [[ "$SETUP_USERNAME" =~ ^[a-zA-Z0-9_-]{2,32}$ ]]; then
    printf '错误：用户名只能包含字母、数字、下划线、连字符，且为 2-32 位。\n' >&2
    exit 1
  fi
  read -r -s -p '登录密码（至少 6 位）: ' SETUP_PASSWORD </dev/tty
  printf '\n'
  if [ "${#SETUP_PASSWORD}" -lt 6 ]; then
    printf '错误：密码至少需要 6 位。\n' >&2
    exit 1
  fi
fi

DEFAULT_TASKS_DIR="$TARGET_DIR/tasks"
read -r -p "任务工作路径 [$DEFAULT_TASKS_DIR]: " SETUP_TASKS_DIR </dev/tty
SETUP_TASKS_DIR="${SETUP_TASKS_DIR:-$DEFAULT_TASKS_DIR}"

printf '正在下载 T-Agent 源码……\n'
curl -fsSL "$REPOSITORY_ARCHIVE" -o "$TEMP_DIR/t-agent.tar.gz"
tar -xzf "$TEMP_DIR/t-agent.tar.gz" -C "$TEMP_DIR"
SOURCE_DIR="$(find "$TEMP_DIR" -mindepth 1 -maxdepth 1 -type d -name 't-agent-*' | head -n 1)"
[ -n "$SOURCE_DIR" ] || { printf '错误：下载包结构不正确。\n' >&2; exit 1; }
mv "$SOURCE_DIR" "$TARGET_DIR"

printf '源码已下载到：%s\n' "$TARGET_DIR"
INSTALL_ARGS=(
  --mode "$INSTALL_MODE"
  --port "$SETUP_PORT"
  --tasks-dir "$SETUP_TASKS_DIR"
)
if [ "$INSTALL_MODE" = "client" ]; then
  INSTALL_ARGS+=(--username "$SETUP_USERNAME" --password "$SETUP_PASSWORD")
fi
exec "$TARGET_DIR/install.sh" "${INSTALL_ARGS[@]}" "$@" < /dev/tty
