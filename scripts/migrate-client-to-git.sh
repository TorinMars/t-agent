#!/usr/bin/env bash
# 兼容旧命令；通用迁移逻辑位于 migrate-to-git.sh。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
exec "$SCRIPT_DIR/migrate-to-git.sh" --mode client "$@"
