#!/usr/bin/env bash
# Download the full project from GitHub, then call install.sh.
# Usage: curl -fsSL https://raw.githubusercontent.com/TorinMars/t-agent/main/bootstrap.sh | bash

set -euo pipefail

REPOSITORY="${T_AGENT_REPOSITORY:-TorinMars/t-agent}"
REPOSITORY_REF="${T_AGENT_REF:-main}"
REPOSITORY_GIT_URL="https://github.com/$REPOSITORY.git"
TARGET_DIR="${T_AGENT_DIR:-$PWD/t-agent}"

command -v curl >/dev/null 2>&1 || { printf 'Error: please install curl first.\n' >&2; exit 1; }
[ -n "$REPOSITORY" ] && [[ "$REPOSITORY" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] && [[ "$REPOSITORY" != ../* ]] && [[ "$REPOSITORY" != */.. ]] || { printf 'Error: T_AGENT_REPOSITORY has an invalid format.\n' >&2; exit 1; }
[ -n "$REPOSITORY_REF" ] && [[ "$REPOSITORY_REF" =~ ^[A-Za-z0-9._/-]+$ ]] && [[ "$REPOSITORY_REF" != *..* ]] || { printf 'Error: T_AGENT_REF has an invalid format.\n' >&2; exit 1; }
[ "${T_AGENT_MODE:-client}" = "client" ] || { printf 'Error: standalone Engine installation has been removed; only client is supported (the Client includes the Engine).\n' >&2; exit 1; }
[ -r /dev/tty ] || { printf 'Error: an interactive terminal is needed to set the install options.\n' >&2; exit 1; }

if [ -e "$TARGET_DIR" ]; then
  printf 'Error: the install directory already exists: %s\n' "$TARGET_DIR" >&2
  printf 'Set T_AGENT_DIR to choose a new directory, or enter the existing project and run ./install.sh.\n' >&2
  exit 1
fi

printf '\nT-Agent will be installed to: %s\n' "$TARGET_DIR"
printf 'Do not delete this directory casually; the service, configuration, database and task files all depend on it.\n\n'

DEFAULT_PORT=3000
read -r -p "Service port [$DEFAULT_PORT]: " SETUP_PORT </dev/tty
SETUP_PORT="${SETUP_PORT:-$DEFAULT_PORT}"
if ! [[ "$SETUP_PORT" =~ ^[1-9][0-9]{0,4}$ ]] || [ "$SETUP_PORT" -gt 65535 ]; then
  printf 'Error: the port must be an integer between 1 and 65535.\n' >&2
  exit 1
fi

DEFAULT_TASKS_DIR="$TARGET_DIR/tasks"
read -r -p "Task working path [$DEFAULT_TASKS_DIR]: " SETUP_TASKS_DIR </dev/tty
SETUP_TASKS_DIR="${SETUP_TASKS_DIR:-$DEFAULT_TASKS_DIR}"

command -v git >/dev/null 2>&1 || { printf 'Error: the Client is installed with Git, so please install Git first. On macOS you can run xcode-select --install.\n' >&2; exit 1; }
printf 'Downloading the T-Agent Client with Git……\n'
git clone --branch "$REPOSITORY_REF" --single-branch "$REPOSITORY_GIT_URL" "$TARGET_DIR"

printf 'Source downloaded to: %s\n' "$TARGET_DIR"
INSTALL_ARGS=(
  --mode client
  --port "$SETUP_PORT"
  --tasks-dir "$SETUP_TASKS_DIR"
)
exec "$TARGET_DIR/install.sh" "${INSTALL_ARGS[@]}" "$@" < /dev/tty
