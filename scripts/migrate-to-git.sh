#!/usr/bin/env bash
# Migrate an existing package-installed Client losslessly to a Git working copy.

set -Eeuo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
ENV_FILE="$APP_DIR/.env"

usage() {
  cat <<'EOF'
Usage: ./scripts/migrate-to-git.sh

The migration keeps .env, data, logs and tasks,
and makes a full backup of the original install next to the project directory.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    *) printf 'Error: unknown argument %s\n' "$1" >&2; usage >&2; exit 1 ;;
  esac
done

[ -f "$ENV_FILE" ] || { printf 'Error: %s not found\n' "$ENV_FILE" >&2; exit 1; }
[ ! -e "$APP_DIR/.git" ] || { printf 'The current install is already a Git working copy.\n'; exit 0; }
command -v git >/dev/null 2>&1 || { printf 'Error: please install Git first.\n' >&2; exit 1; }

INSTALLED_MODE="$(sed -n 's/^T_AGENT_MODE=//p' "$ENV_FILE" | tail -n 1)"
[ -z "$INSTALLED_MODE" ] || [ "$INSTALLED_MODE" = "client" ] || { printf 'Error: standalone Engine has been removed; the component mode in .env is %s, so it cannot be migrated.\n' "$INSTALLED_MODE" >&2; exit 1; }

REPOSITORY="${T_AGENT_REPOSITORY:-$(sed -n 's/^UPDATE_GITHUB_REPOSITORY=//p' "$ENV_FILE" | tail -n 1)}"
REF="${T_AGENT_REF:-$(sed -n 's/^UPDATE_GIT_BRANCH=//p' "$ENV_FILE" | tail -n 1)}"
REPOSITORY="${REPOSITORY:-TorinMars/t-agent}"
REF="${REF:-main}"
[[ "$REPOSITORY" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || { printf 'Error: invalid repository name.\n' >&2; exit 1; }
[[ "$REF" =~ ^[A-Za-z0-9._/-]+$ ]] && [[ "$REF" != *..* ]] || { printf 'Error: invalid branch name.\n' >&2; exit 1; }

PARENT_DIR="$(dirname "$APP_DIR")"
APP_NAME="$(basename "$APP_DIR")"
STAGING_DIR="$(mktemp -d "$PARENT_DIR/.${APP_NAME}.git-migration.XXXXXX")"
BACKUP_DIR="$PARENT_DIR/${APP_NAME}.pre-git-$(date +%Y%m%d-%H%M%S)"
SWAPPED=0

cleanup() {
  if [ "$SWAPPED" -eq 0 ] && [ -d "$STAGING_DIR" ]; then rm -rf "$STAGING_DIR"; fi
}
trap cleanup EXIT

SERVICE_NAME="t-agent.service"
LAUNCH_LABEL="com.tagent.client"
PROCESS_PATTERN='[n]ode .*/server\.js'

SYSTEMD_AVAILABLE=0
if [ "$(uname -s)" = "Linux" ] && command -v systemctl >/dev/null 2>&1 \
  && [ -d /run/systemd/system ] && systemctl show-environment >/dev/null 2>&1; then
  SYSTEMD_AVAILABLE=1
fi

run_as_root() {
  if [ "${EUID:-$(id -u)}" -eq 0 ]; then "$@"
  elif command -v sudo >/dev/null 2>&1; then sudo "$@"
  else printf 'Error: administrator rights are needed to run %s\n' "$1" >&2; return 1
  fi
}

printf 'Cloning %s (branch %s)……\n' "$REPOSITORY" "$REF"
git clone --branch "$REF" --single-branch "https://github.com/$REPOSITORY.git" "$STAGING_DIR"

case "$(uname -s)" in
  Darwin)
    launchctl bootout "gui/$UID" "$HOME/Library/LaunchAgents/$LAUNCH_LABEL.plist" 2>/dev/null || true
    ;;
  Linux)
    if [ "$SYSTEMD_AVAILABLE" -eq 1 ]; then
      run_as_root systemctl stop "$SERVICE_NAME" || true
    elif pgrep -f "$PROCESS_PATTERN" >/dev/null 2>&1; then
      printf 'Error: a running %s process was detected. Stop it and run the migration again.\n' client >&2
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

T_AGENT_REPOSITORY="$REPOSITORY" T_AGENT_REF="$REF" "$APP_DIR/install.sh" --mode client

printf '\nMigration complete.\nGit branch: %s\n' "$(git -C "$APP_DIR" branch --show-current)"
printf 'The original install is kept in full at: %s\n' "$BACKUP_DIR"
printf 'Once you have confirmed that configuration, tasks and remote connections work, deal with that backup yourself.\n'
