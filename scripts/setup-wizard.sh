#!/usr/bin/env bash
# 启动本地安装向导（macOS / Linux）：在浏览器里安装开发环境、Mac 应用并配置代理。
#
#   curl -fsSL <脚本地址> | bash
#   curl -fsSL <脚本地址> | bash -s -- --port 9000 --no-browser
#
# 向导只监听 127.0.0.1；远程服务器请按提示用 SSH 端口转发访问。
# 需要 Python 3.6+（仅用标准库）。所有文件下载到临时目录，退出后自动删除。

main() {
  set -uo pipefail
  local BASE="${T_AGENT_SCRIPTS_BASE:-https://raw.githubusercontent.com/TorinMars/t-agent/main/scripts}"
  local FILES="setup-wizard.py setup-wizard.html install-claude-code.sh install-proxy.sh"
  TMP_DIR=""
  cleanup() { [ -n "${TMP_DIR:-}" ] && rm -rf "$TMP_DIR"; return 0; }
  trap cleanup EXIT

  if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
    echo "用法：curl -fsSL <脚本地址> | bash -s -- [--port N] [--no-browser] [--idle-timeout 秒]"
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
    echo "✗ 需要 Python 3.6 或更高版本。" >&2
    if [ "$(uname -s)" = "Darwin" ]; then
      echo "  macOS：运行 xcode-select --install 安装命令行工具（自带 python3）后重试。" >&2
    elif command -v apt-get >/dev/null 2>&1; then echo "  sudo apt-get install -y python3" >&2
    elif command -v dnf >/dev/null 2>&1; then echo "  sudo dnf install -y python3" >&2
    elif command -v yum >/dev/null 2>&1; then echo "  sudo yum install -y python3" >&2
    elif command -v apk >/dev/null 2>&1; then echo "  sudo apk add python3" >&2
    else echo "  请用系统包管理器安装 python3。" >&2; fi
    return 1
  fi
  command -v curl >/dev/null 2>&1 || { echo "✗ 需要 curl。" >&2; return 1; }
  command -v bash >/dev/null 2>&1 || { echo "✗ 需要 bash。" >&2; return 1; }

  TMP_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t setup-wizard)"
  local file
  for file in $FILES; do
    if ! curl -fsSL --connect-timeout 15 --retry 2 -o "$TMP_DIR/$file" "$BASE/$file" </dev/null; then
      echo "✗ 下载失败：${BASE}/${file}（能否访问 github.com？）" >&2
      return 1
    fi
  done
  chmod +x "$TMP_DIR"/*.sh

  "$py" "$TMP_DIR/setup-wizard.py" --scripts-dir "$TMP_DIR" "$@" </dev/null
}

main "$@"
