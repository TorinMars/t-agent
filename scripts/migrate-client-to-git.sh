#!/usr/bin/env bash
# Kept for the old command; the general migration logic lives in migrate-to-git.sh.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
exec "$SCRIPT_DIR/migrate-to-git.sh" --mode client "$@"
