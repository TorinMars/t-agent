#!/usr/bin/env bash
# Copy credentials/config once; never mount the host's active ~/.codex directly.
set -euo pipefail
DESTINATION="${1:?Usage: docker-client-copy-codex.sh DESTINATION [SOURCE]}"
SOURCE="${2:-$HOME/.codex}"
if [ -L "$DESTINATION" ]; then
  printf '错误：Client Codex 目录不能是符号链接。\n' >&2
  exit 1
fi
umask 077
mkdir -p "$DESTINATION"
DESTINATION="$(cd "$DESTINATION" && pwd -P)"
if [ ! -d "$SOURCE" ]; then
  printf '未找到宿主机 Codex 目录；已创建独立目录：%s\n请在容器内登录 Codex。\n' "$DESTINATION"
  exit 0
fi
SOURCE="$(cd "$SOURCE" && pwd -P)"
case "$DESTINATION/" in
  "$SOURCE/"*) printf '错误：目标必须是宿主机 Codex 目录以外的独立目录。\n' >&2; exit 1 ;;
esac
if [ -n "$(ls -A "$DESTINATION")" ]; then
  printf 'Client Codex 目录已有数据，保留现有登录和配置，不重复复制：%s\n' "$DESTINATION"
  exit 0
fi
# Stage the full snapshot so an interrupted copy never marks the target complete.
COPY_STAGE="$(mktemp -d "$(dirname "$DESTINATION")/.t-agent-codex-copy.XXXXXX")"
trap '[ -z "$COPY_STAGE" ] || rm -rf "$COPY_STAGE"' EXIT
cp -RpL "$SOURCE/." "$COPY_STAGE/"
chmod 700 "$COPY_STAGE"
rmdir "$DESTINATION"
mv "$COPY_STAGE" "$DESTINATION"
COPY_STAGE=""
printf '已复制宿主机 Codex 数据到独立目录：%s\n后续镜像更新继续使用此副本，不覆盖宿主机配置。\n' "$DESTINATION"
