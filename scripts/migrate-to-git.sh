#!/usr/bin/env bash
# 将现有安装包 Client 或 Engine 无损迁移为 Git 工作副本。

set -Eeuo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
ENV_FILE="$APP_DIR/.env"
REQUESTED_MODE=""

usage() {
  cat <<'EOF'
用法：./scripts/migrate-to-git.sh [--mode client|engine]

默认从 .env 的 T_AGENT_MODE 自动识别组件类型。迁移会保留 .env、data、logs、tasks，
并将原安装完整备份到项目同级目录。
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --mode) REQUESTED_MODE="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) printf '错误：未知参数 %s\n' "$1" >&2; usage >&2; exit 1 ;;
  esac
done

[ -f "$ENV_FILE" ] || { printf '错误：未找到 %s\n' "$ENV_FILE" >&2; exit 1; }
[ ! -e "$APP_DIR/.git" ] || { printf '当前安装已经是 Git 工作副本。\n'; exit 0; }
command -v git >/dev/null 2>&1 || { printf '错误：请先安装 Git。\n' >&2; exit 1; }

INSTALLED_MODE="$(sed -n 's/^T_AGENT_MODE=//p' "$ENV_FILE" | tail -n 1)"
MODE="${REQUESTED_MODE:-${T_AGENT_MODE:-$INSTALLED_MODE}}"
MODE="${MODE:-client}"
[ "$MODE" = "client" ] || [ "$MODE" = "engine" ] || { printf '错误：模式只能是 client 或 engine。\n' >&2; exit 1; }
if [ -n "$INSTALLED_MODE" ] && [ "$INSTALLED_MODE" != "$MODE" ]; then
  printf '错误：.env 中的组件模式是 %s，不能按 %s 迁移。\n' "$INSTALLED_MODE" "$MODE" >&2
  exit 1
fi

REPOSITORY="${T_AGENT_REPOSITORY:-$(sed -n 's/^UPDATE_GITHUB_REPOSITORY=//p' "$ENV_FILE" | tail -n 1)}"
REF="${T_AGENT_REF:-$(sed -n 's/^UPDATE_GIT_BRANCH=//p' "$ENV_FILE" | tail -n 1)}"
REPOSITORY="${REPOSITORY:-TorinMars/t-agent}"
REF="${REF:-main}"
[[ "$REPOSITORY" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || { printf '错误：仓库名不合法。\n' >&2; exit 1; }
[[ "$REF" =~ ^[A-Za-z0-9._/-]+$ ]] && [[ "$REF" != *..* ]] || { printf '错误：分支名不合法。\n' >&2; exit 1; }

PARENT_DIR="$(dirname "$APP_DIR")"
APP_NAME="$(basename "$APP_DIR")"
STAGING_DIR="$(mktemp -d "$PARENT_DIR/.${APP_NAME}.git-migration.XXXXXX")"
BACKUP_DIR="$PARENT_DIR/${APP_NAME}.pre-git-$(date +%Y%m%d-%H%M%S)"
SWAPPED=0

cleanup() {
  if [ "$SWAPPED" -eq 0 ] && [ -d "$STAGING_DIR" ]; then rm -rf "$STAGING_DIR"; fi
}
trap cleanup EXIT

if [ "$MODE" = "engine" ]; then
  SERVICE_NAME="t-agent-engine.service"
  LAUNCH_LABEL="com.tagent.engine"
  PROCESS_PATTERN='[n]ode .*apps/engine/server\.js'
else
  SERVICE_NAME="t-agent.service"
  LAUNCH_LABEL="com.tagent.client"
  PROCESS_PATTERN='[n]ode .*/server\.js'
fi

SYSTEMD_AVAILABLE=0
if [ "$(uname -s)" = "Linux" ] && command -v systemctl >/dev/null 2>&1 \
  && [ -d /run/systemd/system ] && systemctl show-environment >/dev/null 2>&1; then
  SYSTEMD_AVAILABLE=1
fi

run_as_root() {
  if [ "${EUID:-$(id -u)}" -eq 0 ]; then "$@"
  elif command -v sudo >/dev/null 2>&1; then sudo "$@"
  else printf '错误：需要管理员权限执行 %s\n' "$1" >&2; return 1
  fi
}

printf '正在克隆 %s（分支 %s）……\n' "$REPOSITORY" "$REF"
git clone --branch "$REF" --single-branch "https://github.com/$REPOSITORY.git" "$STAGING_DIR"

case "$(uname -s)" in
  Darwin)
    launchctl bootout "gui/$UID" "$HOME/Library/LaunchAgents/$LAUNCH_LABEL.plist" 2>/dev/null || true
    ;;
  Linux)
    if [ "$SYSTEMD_AVAILABLE" -eq 1 ]; then
      run_as_root systemctl stop "$SERVICE_NAME" || true
    elif pgrep -f "$PROCESS_PATTERN" >/dev/null 2>&1; then
      printf '错误：检测到仍在运行的 %s 进程。请先停止进程后重新执行迁移。\n' "$MODE" >&2
      exit 1
    fi
    ;;
esac

mv "$APP_DIR" "$BACKUP_DIR"
mv "$STAGING_DIR" "$APP_DIR"
SWAPPED=1

for entry in .env data logs tasks; do
  if [ -e "$BACKUP_DIR/$entry" ]; then
    rm -rf "$APP_DIR/$entry"
    cp -Rp "$BACKUP_DIR/$entry" "$APP_DIR/$entry"
  fi
done

T_AGENT_REPOSITORY="$REPOSITORY" T_AGENT_REF="$REF" "$APP_DIR/install.sh" --mode "$MODE"

printf '\n迁移完成。组件：%s\nGit 分支：%s\n' "$MODE" "$(git -C "$APP_DIR" branch --show-current)"
printf '原安装完整保留在：%s\n' "$BACKUP_DIR"
printf '确认配置、任务和远程连接正常后，再自行处理该备份。\n'
