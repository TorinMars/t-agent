#!/usr/bin/env bash
# Installs Claude Code CLI with the official native installer (macOS / Linux).
set -euo pipefail
curl -fsSL https://claude.ai/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
claude --version
