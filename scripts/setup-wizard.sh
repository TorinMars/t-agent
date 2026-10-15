#!/usr/bin/env bash
# Start the local install wizard (macOS / Linux): install the dev environment, Mac apps and configure the proxy in a browser.
#
# curl -fsSL <script-url> | bash
# curl -fsSL <script-url> | bash -s -- --port 9000 --no-browser
#
# The wizard only listens on 127.0.0.1; for a remote server use SSH port forwarding as prompted.
# Requires Python 3.6+ (standard library only). All files are downloaded into a temporary directory and removed automatically on exit.

main() {
  set -uo pipefail
  local BASE="${T_AGENT_SCRIPTS_BASE:-https://raw.githubusercontent.com/TorinMars/t-agent/main/scripts}"
  local FILES="setup-wizard.py setup-wizard.html install-claude-code.sh install-proxy.sh"
  TMP_DIR=""
  cleanup() { [ -n "${TMP_DIR:-}" ] && rm -rf "$TMP_DIR"; return 0; }
  trap cleanup EXIT

  if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
    echo "Usage: curl -fsSL <script-url> | bash -s -- [--port N] [--no-browser] [--idle-timeout seconds]"
    return 0
  fi

  local py=""
  local candidate
  for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 6) else 1)' 2>/dev/null; then
      py="$candidate"; break
    fi
  done
  if [ -z "$py" ]; then
    echo "✗ Python 3.6 or later is required." >&2
    if [ "$(uname -s)" = "Darwin" ]; then
      echo "  macOS: run xcode-select --install to install the command line tools (which include python3) and retry." >&2
    elif command -v apt-get >/dev/null 2>&1; then echo "  sudo apt-get install -y python3" >&2
    elif command -v dnf >/dev/null 2>&1; then echo "  sudo dnf install -y python3" >&2
    elif command -v yum >/dev/null 2>&1; then echo "  sudo yum install -y python3" >&2
    elif command -v apk >/dev/null 2>&1; then echo "  sudo apk add python3" >&2
    else echo "  Install python3 with your system package manager." >&2; fi
    return 1
  fi
  command -v curl >/dev/null 2>&1 || { echo "✗ curl is required." >&2; return 1; }
  command -v bash >/dev/null 2>&1 || { echo "✗ bash is required." >&2; return 1; }

  TMP_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t setup-wizard)"
  local file
  for file in $FILES; do
    if ! curl -fsSL --connect-timeout 15 --retry 2 -o "$TMP_DIR/$file" "$BASE/$file" </dev/null; then
      echo "✗ Download failed: ${BASE}/${file} (is github.com reachable?)" >&2
      return 1
    fi
  done
  chmod +x "$TMP_DIR"/*.sh

  "$py" "$TMP_DIR/setup-wizard.py" --scripts-dir "$TMP_DIR" "$@" </dev/null
}

main "$@"
