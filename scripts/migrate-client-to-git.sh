#!/usr/bin/env bash
# 将现有安装包 Client 无损迁移为 Git 工作副本。

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
ENV_FILE="$APP_DIR/.env"
REPOSITORY="${T_AGENT_REPOSITORY:-$(sed -n 's/^UPDATE_GITHUB_REPOSITORY=//p' "$ENV_FILE" 2>/dev/null | tail -n 1)}"
REF="${T_AGENT_REF:-$(sed -n 's/^UPDATE_GIT_BRANCH=//p' "$ENV_FILE" 2>/dev/null | tail -n 1)}"
REPOSITORY="${REPOSITORY:-TorinMars/t-agent}"
REF="${REF:-main}"
PARENT_DIR="$(dirname "$APP_DIR")"
APP_NAME="$(basename "$APP_DIR")"
STAGING_DIR="$(mktemp -d "$PARENT_DIR/.${APP_NAME}.git-migration.XXXXXX")"
BACKUP_DIR="$PARENT_DIR/${APP_NAME}.pre-git-$(date +%Y%m%d-%H%M%S)"

cleanup() {
  [ ! -d "$STAGING_DIR" ] || rm -rf "$STAGING_DIR"
}
trap cleanup EXIT

[ ! -e "$APP_DIR/.git" ] || { printf '当前客户端已经是 Git 工作副本。\n'; exit 0; }
[ -f "$ENV_FILE" ] || { printf '错误：未找到 %s\n' "$ENV_FILE" >&2; exit 1; }
grep -q '^T_AGENT_MODE=client$' "$ENV_FILE" || { printf '错误：此脚本只迁移 Client。\n' >&2; exit 1; }
command -v git >/dev/null 2>&1 || { printf '错误：请先安装 Git；macOS 可执行 xcode-select --install。\n' >&2; exit 1; }
[[ "$REPOSITORY" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || { printf '错误：仓库名不合法。\n' >&2; exit 1; }
[[ "$REF" =~ ^[A-Za-z0-9._/-]+$ ]] && [[ "$REF" != *..* ]] || { printf '错误：分支名不合法。\n' >&2; exit 1; }

printf '正在克隆 %s（分支 %s）……\n' "$REPOSITORY" "$REF"
git clone --branch "$REF" --single-branch "https://github.com/$REPOSITORY.git" "$STAGING_DIR"

case "$(uname -s)" in
  Darwin)
    launchctl bootout "gui/$UID" "$HOME/Library/LaunchAgents/com.tagent.client.plist" 2>/dev/null || true
    ;;
  Linux)
    if command -v systemctl >/dev/null 2>&1; then
      if [ "${EUID:-$(id -u)}" -eq 0 ]; then systemctl stop t-agent.service || true
      elif command -v sudo >/dev/null 2>&1; then sudo systemctl stop t-agent.service || true
      fi
    fi
    ;;
esac

mv "$APP_DIR" "$BACKUP_DIR"
mv "$STAGING_DIR" "$APP_DIR"

for entry in .env data logs tasks; do
  if [ -e "$BACKUP_DIR/$entry" ]; then
    rm -rf "$APP_DIR/$entry"
    cp -Rp "$BACKUP_DIR/$entry" "$APP_DIR/$entry"
  fi
done

T_AGENT_REPOSITORY="$REPOSITORY" T_AGENT_REF="$REF" "$APP_DIR/install.sh" --mode client

printf '\n迁移完成。Git 分支：%s\n' "$(git -C "$APP_DIR" branch --show-current)"
printf '原安装完整保留在：%s\n' "$BACKUP_DIR"
printf '确认任务和远程连接正常后，可自行删除该备份。\n'
