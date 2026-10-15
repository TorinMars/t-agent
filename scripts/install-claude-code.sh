#!/usr/bin/env bash
# Dev environment install script (macOS / Linux): Claude Code, Codex, SSH key, remote sync of user-level rules and default config, the unified command ta, and PM2 (installed to the user directory when Node.js is missing).
#
# Usage:
# curl -fsSL <script-url> | bash
# curl -fsSL <script-url> | bash -s -- --check
#
# Options:
# --check             only check the environment and what is installed; install nothing and generate no keys
# --upgrade           reinstall already installed tools at their latest versions
# --no-modify-path    do not modify shell config files (no PATH entry and no claude/codex sync function)
# --passphrase        set a passphrase interactively when generating the SSH key (needs a terminal)
# --skip NAME         skip one item; NAME is claude, codex, ssh, sync, ta or pm2; may be repeated
# --with-apps         also install the Mac desktop apps: Maccy, Snipaste, Clash Verge (macOS only)
# --apps-dir DIR      install directory for the desktop apps (default /Applications, ~/Applications when not writable)
# -h, --help          show this help
#
# Does not use Homebrew, does not run sudo and does not change system-level config; everything is installed in the current user's directory.
# The whole script is wrapped in a main function so that with curl | bash it is read completely before it runs.

main() {
  set -uo pipefail

  local CHECK_ONLY=0 UPGRADE=0 MODIFY_PATH=1 PASSPHRASE=0
  local SKIP_CLAUDE=0 SKIP_CODEX=0 SKIP_SSH=0 SKIP_SYNC=0 SKIP_TA=0 SKIP_PM2=0 WITH_APPS=0 APPS_DIR=""
  local STEP_NO=0 STEP_TOTAL=8
  local SCRIPTS_BASE="${T_AGENT_SCRIPTS_BASE:-https://raw.githubusercontent.com/TorinMars/t-agent/main/scripts}"
  local BIN_DIR="$HOME/.local/bin"
  local OS="" ARCH="" FETCH=""
  local SUMMARY="" FAILED=0

  # ---------- Output ----------
  local C_RESET="" C_GREEN="" C_YELLOW="" C_RED="" C_BOLD=""
  if [ -t 1 ]; then
    C_RESET=$'\033[0m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_BOLD=$'\033[1m'
  fi
  info() { printf '%s\n' "$*"; }
  step() { STEP_NO=$((STEP_NO + 1)); printf '\n%s[%s/%s]%s %s\n' "$C_BOLD" "$STEP_NO" "$STEP_TOTAL" "$C_RESET" "$1"; }
  ok()   { printf '  %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
  warn() { printf '  %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
  fail() { printf '  %s✗%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; }
  # Record the result of each item and summarize at the end: record name status note
  record() {
    SUMMARY="${SUMMARY}$1|$2|$3"$'\n'
    [ "$2" = "failed" ] && FAILED=1
    return 0
  }

  usage() {
    cat <<'USAGE'
Usage: curl -fsSL <script-url> | bash -s -- [options]
  --check             only check the environment and what is installed; install nothing and generate no keys
  --upgrade           reinstall already installed tools at their latest versions
  --no-modify-path    do not modify shell config files (no PATH entry and no claude/codex sync function)
  --passphrase        set a passphrase interactively when generating the SSH key (needs a terminal)
  --skip NAME         skip one item: claude, codex, ssh, sync, ta or pm2; may be repeated
  --with-apps         also install the Mac desktop apps: Maccy, Snipaste, Clash Verge (macOS only)
  --apps-dir DIR      install directory for the desktop apps (default /Applications, ~/Applications when not writable)
  -h, --help          show this help
USAGE
  }

  # The EXIT trap only runs after main returns, so the temporary directory variable must be global
  TMP_DIR=""
  cleanup() { [ -n "${TMP_DIR:-}" ] && rm -rf "$TMP_DIR"; return 0; }
  trap cleanup EXIT

  # ---------- Arguments ----------
  while [ $# -gt 0 ]; do
    case "$1" in
      --check) CHECK_ONLY=1 ;;
      --upgrade) UPGRADE=1 ;;
      --no-modify-path) MODIFY_PATH=0 ;;
      --passphrase) PASSPHRASE=1 ;;
      --skip)
        shift
        case "${1:-}" in
          claude) SKIP_CLAUDE=1 ;;
          codex) SKIP_CODEX=1 ;;
          ssh) SKIP_SSH=1 ;;
          sync) SKIP_SYNC=1 ;;
          ta) SKIP_TA=1 ;;
          pm2) SKIP_PM2=1 ;;
          *) fail "--skip only supports claude, codex, ssh, sync, ta, pm2"; return 2 ;;
        esac ;;
      --with-apps) WITH_APPS=1; STEP_TOTAL=9 ;;
      --apps-dir)
        shift
        if [ -z "${1:-}" ]; then fail "--apps-dir needs a directory"; return 2; fi
        APPS_DIR="$1" ;;
      -h|--help) usage; return 0 ;;
      *) fail "Unknown option: $1 (use --help for usage)"; return 2 ;;
    esac
    shift
  done

  # ---------- Common helpers ----------
  have() { command -v "$1" >/dev/null 2>&1; }

  # Unified download: download URL target-file. No child process reads standard input, so none swallows the script coming through the pipe.
  download() {
    case "$FETCH" in
      curl) curl -fsSL --connect-timeout 15 --retry 2 -o "$2" "$1" </dev/null ;;
      wget) wget -q --timeout=15 --tries=3 -O "$2" "$1" </dev/null ;;
    esac
  }

  reachable() {
    case "$FETCH" in
      curl) curl -fsSI --connect-timeout 8 -m 15 -o /dev/null "$1" </dev/null ;;
      wget) wget -q --spider --timeout=8 --tries=1 "$1" </dev/null ;;
    esac
  }

  path_has_bin_dir() { case ":$PATH:" in *":$BIN_DIR:"*) return 0 ;; *) return 1 ;; esac; }

  # The config file for the current shell
  shell_rc_file() {
    case "$(basename "${SHELL:-}")" in
      zsh) printf '%s\n' "$HOME/.zshrc" ;;
      bash) if [ "$OS" = "macos" ]; then printf '%s\n' "$HOME/.bash_profile"; else printf '%s\n' "$HOME/.bashrc"; fi ;;
      *) printf '%s\n' "$HOME/.profile" ;;
    esac
  }

  # Install hint when a dependency is missing, per system
  install_hint() {
    local tool="$1"
    if [ "$OS" = "macos" ]; then
      case "$tool" in
        git|make|tar) printf 'Run xcode-select --install to install the Xcode command line tools' ;;
        *) printf 'Please install %s first' "$tool" ;;
      esac
      return
    fi
    if have apt-get; then printf 'sudo apt-get install -y %s' "$tool"
    elif have dnf; then printf 'sudo dnf install -y %s' "$tool"
    elif have yum; then printf 'sudo yum install -y %s' "$tool"
    elif have apk; then printf 'sudo apk add %s' "$tool"
    elif have pacman; then printf 'sudo pacman -S %s' "$tool"
    else printf 'Please install %s with your system package manager' "$tool"
    fi
  }

  # ---------- Step 1: environment check ----------
  check_environment() {
    step "Checking the environment"
    case "$(uname -s)" in
      Darwin) OS="macos" ;;
      Linux) OS="linux" ;;
      *) fail "Unsupported system: $(uname -s) (only macOS and Linux are supported)"; return 1 ;;
    esac
    case "$(uname -m)" in
      arm64|aarch64) ARCH="aarch64" ;;
      x86_64|amd64) ARCH="x86_64" ;;
      *) fail "Unsupported CPU architecture: $(uname -m)"; return 1 ;;
    esac
    ok "System: $OS / $ARCH"

    if have curl; then FETCH="curl"
    elif have wget; then FETCH="wget"
    else
      fail "curl or wget is required. $(install_hint curl)"
      return 1
    fi
    ok "Download tool: $FETCH"

    if have tar; then ok "tar is available"; else warn "tar is missing, so the Codex binary cannot be extracted. $(install_hint tar)"; fi
    if have git; then ok "git is available"; else warn "git is not installed (Claude Code and Codex use it in projects). $(install_hint git)"; fi
    if [ "$OS" = "linux" ] && [ ! -w "$HOME" ]; then fail "HOME directory is not writable: $HOME"; return 1; fi

    if reachable "https://claude.ai/install.sh"; then ok "claude.ai is reachable"
    else warn "Cannot reach claude.ai; if you need a proxy, set https_proxy and run again"; fi
    if reachable "https://github.com"; then ok "github.com is reachable"
    else warn "Cannot reach github.com; if you need a proxy, set https_proxy and run again"; fi

    if path_has_bin_dir; then ok "PATH already contains $BIN_DIR"
    else warn "PATH does not contain $BIN_DIR yet"; fi
    return 0
  }

  # Make tools in ~/.local/bin findable in this run and in future terminals
  ensure_path() {
    mkdir -p "$BIN_DIR"
    if ! path_has_bin_dir; then export PATH="$BIN_DIR:$PATH"; fi
    [ "$MODIFY_PATH" -eq 1 ] || return 0
    local rc line
    rc="$(shell_rc_file)"
    line='export PATH="$HOME/.local/bin:$PATH"'
    if [ -f "$rc" ] && grep -Fq '.local/bin' "$rc"; then return 0; fi
    printf '\n# Added by install-claude-code.sh\n%s\n' "$line" >> "$rc" \
      && ok "Added ~/.local/bin to ${rc} (takes effect in new terminals)" \
      || warn "Cannot write ${rc}; add it manually: $line"
  }

  # ---------- Step 2: Claude Code ----------
  install_claude() {
    step "Claude Code"
    if [ "$SKIP_CLAUDE" -eq 1 ]; then record "Claude Code" "skipped" "--skip claude was used"; return; fi
    if have claude && [ "$UPGRADE" -eq 0 ]; then
      ok "Installed: $(claude --version 2>/dev/null | head -n1)"
      record "Claude Code" "installed" "$(claude --version 2>/dev/null | head -n1)"
      return
    fi
    if [ "$CHECK_ONLY" -eq 1 ]; then
      warn "not installed"; record "Claude Code" "not installed" "not installed in --check mode"; return
    fi
    local installer="$TMP_DIR/claude-install.sh"
    if ! download "https://claude.ai/install.sh" "$installer"; then
      fail "Failed to download the official installer"; record "Claude Code" "failed" "Cannot download https://claude.ai/install.sh"; return
    fi
    if ! bash "$installer" </dev/null; then
      fail "The official installer failed"; record "Claude Code" "failed" "The official installer returned an error"; return
    fi
    ensure_path
    if have claude; then
      ok "Installed: $(claude --version 2>/dev/null | head -n1)"
      record "Claude Code" "installed" "$(claude --version 2>/dev/null | head -n1)"
    else
      fail "The installer finished, but the claude command cannot be found"; record "Claude Code" "failed" "claude not found after installation"
    fi
  }

  # ---------- Step 3: Codex ----------
  codex_target() {
    if [ "$OS" = "macos" ]; then printf '%s-apple-darwin' "$ARCH"
    else printf '%s-unknown-linux-musl' "$ARCH"; fi
  }

  install_codex_binary() {
    have tar || return 1
    local target archive
    target="$(codex_target)"
    archive="$TMP_DIR/codex.tar.gz"
    download "https://github.com/openai/codex/releases/latest/download/codex-$target.tar.gz" "$archive" || return 1
    mkdir -p "$TMP_DIR/codex" && tar -xzf "$archive" -C "$TMP_DIR/codex" || return 1
    [ -f "$TMP_DIR/codex/codex-$target" ] || return 1
    mkdir -p "$BIN_DIR"
    install -m 755 "$TMP_DIR/codex/codex-$target" "$BIN_DIR/codex"
  }

  install_codex_npm() {
    have npm || return 1
    npm install -g --prefix "$HOME/.local" @openai/codex </dev/null
  }

  install_codex() {
    step "Codex"
    if [ "$SKIP_CODEX" -eq 1 ]; then record "Codex" "skipped" "--skip codex was used"; return; fi
    if have codex && [ "$UPGRADE" -eq 0 ]; then
      ok "Installed: $(codex --version 2>/dev/null | head -n1)"
      record "Codex" "installed" "$(codex --version 2>/dev/null | head -n1)"
      return
    fi
    if [ "$CHECK_ONLY" -eq 1 ]; then
      warn "not installed"; record "Codex" "not installed" "not installed in --check mode"; return
    fi
    ensure_path
    if install_codex_binary; then
      info "  Installed the prebuilt binary from the GitHub release page"
    elif install_codex_npm; then
      info "  The prebuilt binary is unavailable; installed through npm into ~/.local"
    else
      fail "Installation failed (GitHub download failed and npm is not available)"
      record "Codex" "failed" "Cannot download the prebuilt binary and there is no npm to fall back to"
      return
    fi
    if have codex; then
      ok "Installed: $(codex --version 2>/dev/null | head -n1)"
      record "Codex" "installed" "$(codex --version 2>/dev/null | head -n1); run codex to log in on first use"
    else
      fail "The installation finished, but the codex command cannot be found"; record "Codex" "failed" "codex not found after installation"
    fi
  }

  # ---------- Step 4: SSH key ----------
  existing_ssh_key() {
    local name
    for name in id_ed25519 id_rsa id_ecdsa id_dsa; do
      [ -f "$HOME/.ssh/$name" ] && { printf '%s\n' "$HOME/.ssh/$name"; return 0; }
    done
    return 1
  }

  setup_ssh_key() {
    step "SSH key"
    if [ "$SKIP_SSH" -eq 1 ]; then record "SSH key" "skipped" "--skip ssh was used"; return; fi
    local existing
    if existing="$(existing_ssh_key)"; then
      ok "An existing key is kept and not overwritten: $existing"
      record "SSH key" "Exists" "$existing"
      return
    fi
    if [ "$CHECK_ONLY" -eq 1 ]; then
      warn "No SSH key"; record "SSH key" "not generated" "not generated in --check mode"; return
    fi
    if ! have ssh-keygen; then
      fail "ssh-keygen not found. $(install_hint openssh-client)"
      record "SSH key" "failed" "ssh-keygen is missing"; return
    fi
    local key="$HOME/.ssh/id_ed25519" comment type_args
    comment="$(id -un)@$(hostname 2>/dev/null | cut -d. -f1)"
    mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
    type_args=(-t ed25519)
    if [ "$PASSPHRASE" -eq 1 ]; then
      if [ ! -r /dev/tty ]; then
        warn "No interactive terminal, so a passphrase cannot be set; continuing without a passphrase"
        PASSPHRASE=0
      fi
    fi
    if [ "$PASSPHRASE" -eq 1 ]; then
      ssh-keygen "${type_args[@]}" -C "$comment" -f "$key" </dev/tty
    else
      ssh-keygen "${type_args[@]}" -C "$comment" -f "$key" -N "" -q </dev/null
    fi
    if [ ! -f "$key" ]; then
      # a very old OpenSSH does not support ed25519; fall back to RSA
      key="$HOME/.ssh/id_rsa"
      if [ "$PASSPHRASE" -eq 1 ]; then
        ssh-keygen -t rsa -b 4096 -C "$comment" -f "$key" </dev/tty
      else
        ssh-keygen -t rsa -b 4096 -C "$comment" -f "$key" -N "" -q </dev/null
      fi
    fi
    if [ ! -f "$key" ]; then
      fail "Failed to generate the key"; record "SSH key" "failed" "ssh-keygen did not produce a key"; return
    fi
    chmod 600 "$key"
    ok "Generated key: $key"
    # When a passphrase is set, let the macOS keychain remember it so it is not typed every time
    if [ "$OS" = "macos" ] && [ "$PASSPHRASE" -eq 1 ]; then
      local config="$HOME/.ssh/config"
      if ! grep -Fq 'UseKeychain yes' "$config" 2>/dev/null; then
        printf '\n# Added by install-claude-code.sh\nHost *\n  AddKeysToAgent yes\n  UseKeychain yes\n  IdentityFile %s\n' "$key" >> "$config"
        chmod 600 "$config"
      fi
      ssh-add --apple-use-keychain "$key" </dev/tty 2>/dev/null || true
    fi
    info ""
    info "  The public key follows (only the public key is shown; add it to GitHub: https://github.com/settings/ssh/new):"
    info ""
    sed 's/^/    /' "$key.pub"
    if [ "$OS" = "macos" ] && have pbcopy; then
      pbcopy < "$key.pub" && ok "The public key was copied to the clipboard"
    fi
    record "SSH key" "generated" "$key.pub (add it to GitHub)"
  }



  # ---------- Step: Claude / Codex user-level rules and config sync ----------
  SYNC_DIR="$HOME/.local/share/t-agent"
  SYNC_SCRIPT="$SYNC_DIR/agent-sync.py"
  SYNC_BEGIN="# >>> t-agent agent-sync >>>"
  SYNC_END="# <<< t-agent agent-sync <<<"

  python_ok() {
    have python3 && python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 6) else 1)' 2>/dev/null
  }

  # Write claude / codex wrapper functions into the shell config: sync before starting; a failure or timeout does not block starting
  write_sync_hook() {
    local rc="$1" work="$TMP_DIR/rc.work"
    if [ -f "$rc" ]; then
      awk -v b="$SYNC_BEGIN" -v e="$SYNC_END" '$0==b{skip=1} !skip{print} $0==e{skip=0}' "$rc" > "$work" || return 1
    else
      : > "$work"
    fi
    {
      cat "$work"
      printf '\n%s\n' "$SYNC_BEGIN"
      cat <<'HOOK'
# Sync the remote user-level rules and default config before claude / codex start (a failure or timeout does not block starting)
claude() { [ -f "$HOME/.local/share/t-agent/agent-sync.py" ] && command -v python3 >/dev/null 2>&1 && python3 "$HOME/.local/share/t-agent/agent-sync.py" claude; command claude "$@"; }
codex() {
  [ -f "$HOME/.local/share/t-agent/agent-sync.py" ] && command -v python3 >/dev/null 2>&1 && python3 "$HOME/.local/share/t-agent/agent-sync.py" codex
  # Same as claude: codex -c / --continue resumes the latest session in the current directory. codex -c key=value is still a config override.
  case "${1:-}" in
    --continue) shift; command codex resume --last "$@"; return ;;
    -c) case "${2:-}" in *=*) ;; *) shift; command codex resume --last "$@"; return ;; esac ;;
  esac
  command codex "$@"
}
HOOK
      printf '%s\n' "$SYNC_END"
    } > "$work.out" && cat "$work.out" > "$rc"
  }

  setup_agent_sync() {
    step "Rules and config sync"
    if [ "$SKIP_SYNC" -eq 1 ]; then record "Rule sync" "skipped" "--skip sync was used"; return; fi
    if ! python_ok; then
      warn "python3 (3.6+) is required for syncing; $(install_hint python3)"
      record "Rule sync" "skipped" "python3 is missing"; return
    fi
    local rc
    rc="$(shell_rc_file)"
    if [ "$CHECK_ONLY" -eq 1 ]; then
      if [ -f "$SYNC_SCRIPT" ] && grep -Fq "$SYNC_BEGIN" "$rc" 2>/dev/null; then
        ok "Configured: sync automatically before starting claude / codex"; record "Rule sync" "installed" "$SYNC_SCRIPT"
      else
        warn "Not configured"; record "Rule sync" "not installed" "not installed in --check mode"
      fi
      return
    fi
    mkdir -p "$SYNC_DIR"
    if ! download "$SCRIPTS_BASE/agent-sync.py" "$SYNC_DIR/agent-sync.py.new"; then
      fail "Failed to download the sync program"; record "Rule sync" "failed" "Cannot download agent-sync.py"; return
    fi
    chmod 755 "$SYNC_DIR/agent-sync.py.new" && mv "$SYNC_DIR/agent-sync.py.new" "$SYNC_SCRIPT"
    ok "Sync program: $SYNC_SCRIPT"
    python3 "$SYNC_SCRIPT" all --verbose </dev/null 2>&1 | sed 's/^/  /'
    if [ "$MODIFY_PATH" -eq 1 ]; then
      if write_sync_hook "$rc"; then
        ok "Added a pre-start sync for claude / codex to $rc (takes effect in new terminals)"
        record "Rule sync" "installed" "Syncs automatically before claude / codex start; configuration is in the repository’s rules/"
      else
        fail "Cannot write $rc"; record "Rule sync" "failed" "Cannot write $rc"
      fi
    else
      warn "--no-modify-path was used, so the pre-start sync was not written; run it manually: python3 $SYNC_SCRIPT all"
      record "Rule sync" "installed" "Synced once; the shell config was not modified"
    fi
  }


  # ---------- Step: unified command ta ----------
  install_ta() {
    step "Unified command ta"
    if [ "$SKIP_TA" -eq 1 ]; then record "Unified command ta" "skipped" "--skip ta was used"; return; fi
    local target="$BIN_DIR/ta" other
    if [ -e "$target" ] && ! grep -q '^# t-agent:ta' "$target" 2>/dev/null; then
      warn "$target already exists and was not installed by this script; not overwritten"
      record "Unified command ta" "skipped" "$target is already used by another program"; return
    fi
    other="$(command -v ta 2>/dev/null || true)"
    if [ -n "$other" ] && [ "$other" != "$target" ] && ! grep -q '^# t-agent:ta' "$other" 2>/dev/null; then
      warn "Another ta (${other}) is on PATH and may take precedence over the one installed by this script"
    fi
    if [ "$CHECK_ONLY" -eq 1 ]; then
      if [ -x "$target" ]; then ok "Installed: $target"; record "Unified command ta" "installed" "$target"
      else warn "not installed"; record "Unified command ta" "not installed" "not installed in --check mode"; fi
      return
    fi
    mkdir -p "$BIN_DIR"
    if ! download "$SCRIPTS_BASE/ta.sh" "$target.new"; then
      fail "Failed to download ta"; record "Unified command ta" "failed" "Cannot download ta.sh"; return
    fi
    chmod 755 "$target.new" && mv "$target.new" "$target"
    ensure_path
    ok "Installed: ${target} (usage: ta opens Claude, ta x opens Codex, ta -h lists everything)"
    record "Unified command ta" "installed" "${target}; defaults to claude, ta x is codex"
  }


  # ---------- Step: PM2 (install Node.js into the user directory first when missing) ----------
  NODE_HOME="$HOME/.local/node"
  NODE_MAJOR="22"

  # Write ~/.local/node/bin into the shell config (appended only once)
  ensure_node_path() {
    case ":$PATH:" in *":$NODE_HOME/bin:"*) ;; *) export PATH="$NODE_HOME/bin:$PATH" ;; esac
    [ "$MODIFY_PATH" -eq 1 ] || return 0
    local rc
    rc="$(shell_rc_file)"
    if [ -f "$rc" ] && grep -Fq '.local/node/bin' "$rc"; then return 0; fi
    printf '\n# Added by install-claude-code.sh (Node.js)\nexport PATH="$HOME/.local/node/bin:$PATH"\n' >> "$rc" \
      && ok "Added ~/.local/node/bin to ${rc} (takes effect in new terminals)" \
      || warn "Cannot write ${rc}; add it manually: export PATH=\"\$HOME/.local/node/bin:\$PATH\""
  }

  sha256_of() {
    if have shasum; then shasum -a 256 "$1" | cut -d' ' -f1
    elif have sha256sum; then sha256sum "$1" | cut -d' ' -f1
    else return 1; fi
  }

  # Download the official prebuilt Node.js LTS to ~/.local/node and verify it with the official SHASUMS256.txt
  install_node() {
    if [ "$OS" = "linux" ] && { ldd --version 2>&1 | grep -qi musl || [ -e /lib/ld-musl-x86_64.so.1 ] || [ -e /lib/ld-musl-aarch64.so.1 ]; }; then
      fail "This is a musl system (such as Alpine) and the official prebuilt Node.js does not apply; run this first: sudo apk add nodejs npm"
      return 1
    fi
    local node_os node_arch mirror index line sum file archive
    [ "$OS" = "macos" ] && node_os="darwin" || node_os="linux"
    [ "$ARCH" = "aarch64" ] && node_arch="arm64" || node_arch="x64"
    mirror="${T_AGENT_NODE_MIRROR:-https://nodejs.org/dist}"
    index="$TMP_DIR/node-shasums.txt"
    info "  Node.js not found; installing Node ${NODE_MAJOR} LTS to ${NODE_HOME} …"
    if ! download "$mirror/latest-v${NODE_MAJOR}.x/SHASUMS256.txt" "$index"; then
      fail "Cannot get the Node.js version info (is ${mirror} reachable? In China you can set T_AGENT_NODE_MIRROR=https://npmmirror.com/mirrors/node)"
      return 1
    fi
    line="$(grep -E " node-v${NODE_MAJOR}\.[0-9.]+-${node_os}-${node_arch}\.tar\.gz\$" "$index" | head -n1)"
    sum="${line%% *}"; file="${line##* }"
    if [ -z "$line" ] || [ -z "$sum" ] || [ -z "$file" ]; then
      fail "No package for ${node_os}-${node_arch} found in SHASUMS256.txt"; return 1
    fi
    archive="$TMP_DIR/$file"
    if ! download "$mirror/latest-v${NODE_MAJOR}.x/$file" "$archive"; then fail "Failed to download Node.js"; return 1; fi
    if [ "$(sha256_of "$archive" 2>/dev/null)" != "$sum" ]; then
      fail "The Node.js package failed verification (SHA-256 mismatch); installation aborted"; return 1
    fi
    rm -rf "$TMP_DIR/node-extract" && mkdir -p "$TMP_DIR/node-extract"
    if ! tar -xzf "$archive" -C "$TMP_DIR/node-extract" --strip-components 1; then fail "Failed to extract Node.js"; return 1; fi
    [ -x "$TMP_DIR/node-extract/bin/node" ] || { fail "The package contains no node executable"; return 1; }
    mkdir -p "$(dirname "$NODE_HOME")"
    rm -rf "$NODE_HOME" && mv "$TMP_DIR/node-extract" "$NODE_HOME" || { fail "Cannot write $NODE_HOME"; return 1; }
    ensure_node_path
    ok "Node.js installed: $("$NODE_HOME/bin/node" --version 2>/dev/null)"
  }

  install_pm2() {
    step "PM2"
    if [ "$SKIP_PM2" -eq 1 ]; then record "PM2" "skipped" "--skip pm2 was used"; return; fi
    case ":$PATH:" in *":$NODE_HOME/bin:"*) ;; *) [ -x "$NODE_HOME/bin/node" ] && export PATH="$NODE_HOME/bin:$PATH" ;; esac
    if have pm2 && [ "$UPGRADE" -eq 0 ]; then
      ok "Installed: pm2 $(pm2 --version 2>/dev/null | tail -n1)"
      record "PM2" "installed" "pm2 $(pm2 --version 2>/dev/null | tail -n1)"; return
    fi
    if [ "$CHECK_ONLY" -eq 1 ]; then
      have node && ok "Node.js: $(node --version 2>/dev/null)" || warn "Node.js is not installed (it is installed to ~/.local/node automatically during installation)"
      warn "pm2 is not installed"; record "PM2" "not installed" "not installed in --check mode"; return
    fi
    if ! have node || ! have npm; then
      if ! install_node; then record "PM2" "failed" "Cannot install Node.js"; return; fi
    else
      ok "Node.js: $(node --version 2>/dev/null)"
    fi
    have npm || { fail "npm not found"; record "PM2" "failed" "no npm"; return; }
    # If the global directory is writable install to the default location (nvm and ~/.local/node both count), otherwise install to ~/.local
    local prefix
    prefix="$(npm config get prefix 2>/dev/null)"
    if [ -n "$prefix" ] && [ -w "$prefix" ]; then
      npm install -g pm2 </dev/null >"$TMP_DIR/npm-pm2.log" 2>&1
    else
      ensure_path
      npm install -g --prefix "$HOME/.local" pm2 </dev/null >"$TMP_DIR/npm-pm2.log" 2>&1
    fi
    if ! have pm2; then
      tail -n 5 "$TMP_DIR/npm-pm2.log" | sed 's/^/    /' >&2
      fail "Failed to install pm2"; record "PM2" "failed" "npm install -g pm2 failed"; return
    fi
    ok "pm2 installed: $(pm2 --version 2>/dev/null | tail -n1)"
    info "  Start on boot is up to you (the sudo command is printed by pm2): pm2 startup ; after starting your services run: pm2 save"
    record "PM2" "installed" "pm2 $(pm2 --version 2>/dev/null | tail -n1); run pm2 startup to start on boot"
  }

  # ---------- Mac desktop apps ----------
  apps_target_dir() {
    if [ -n "$APPS_DIR" ]; then printf '%s\n' "$APPS_DIR"
    elif [ -w /Applications ]; then printf '/Applications\n'
    else printf '%s\n' "$HOME/Applications"; fi
  }

  # Path of an installed app; when --apps-dir is given only that directory is looked at
  app_installed() {
    local dir
    if [ -n "$APPS_DIR" ]; then
      [ -d "$APPS_DIR/$1" ] && { printf '%s\n' "$APPS_DIR/$1"; return 0; }
      return 1
    fi
    for dir in /Applications "$HOME/Applications"; do
      [ -d "$dir/$1" ] && { printf '%s\n' "$dir/$1"; return 0; }
    done
    return 1
  }

  # $1 >= $2 (compared as major.minor.patch)
  ver_ge() {
    local IFS=.
    local -a a b
    local i x y
    a=($1); b=($2)
    for i in 0 1 2; do
      x="${a[i]:-0}"; y="${b[i]:-0}"
      [ "$x" -gt "$y" ] && return 0
      [ "$x" -lt "$y" ] && return 1
    done
    return 0
  }

  latest_github_tag() {
    local url
    url="$(curl -fsSL --connect-timeout 15 -o /dev/null -w '%{url_effective}' "https://github.com/$1/releases/latest" </dev/null)" || return 1
    printf '%s\n' "${url##*/}"
  }

  # Extract the app from the downloaded zip/dmg into a temporary directory; on success STAGED is the app path
  STAGED=""
  stage_app() {
    local label="$1" app="$2" kind="$3" file="$4" work mnt
    work="$TMP_DIR/stage-$label"; rm -rf "$work"; mkdir -p "$work"
    STAGED=""
    case "$kind" in
      zip)
        ditto -x -k "$file" "$work" || return 1 ;;
      dmg)
        mnt="$TMP_DIR/mnt-$label"; mkdir -p "$mnt"
        hdiutil attach -nobrowse -readonly -noverify -mountpoint "$mnt" "$file" >/dev/null 2>&1 || return 1
        if [ -d "$mnt/$app" ]; then ditto "$mnt/$app" "$work/$app"; fi
        hdiutil detach "$mnt" >/dev/null 2>&1 || hdiutil detach -force "$mnt" >/dev/null 2>&1 || true ;;
    esac
    [ -d "$work/$app" ] || return 1
    STAGED="$work/$app"
  }

  # install_mac_app display-name app-file-name zip|dmg download-url
  install_mac_app() {
    local label="$1" app="$2" kind="$3" url="$4"
    local existing dest_dir file minver sysver
    if existing="$(app_installed "$app")"; then
      if [ "$UPGRADE" -eq 0 ]; then
        ok "$label installed: $existing"; record "$label" "installed" "$existing"; return
      fi
      if pgrep -f "$existing/Contents/MacOS" >/dev/null 2>&1; then
        warn "$label is running; quit it before upgrading"; record "$label" "skipped" "running, not upgraded"; return
      fi
    fi
    if [ "$CHECK_ONLY" -eq 1 ]; then
      warn "$label is not installed"; record "$label" "not installed" "not installed in --check mode"; return
    fi
    dest_dir="$(apps_target_dir)"
    if ! mkdir -p "$dest_dir" 2>/dev/null || [ ! -w "$dest_dir" ]; then
      fail "${label}: directory not writable $dest_dir"; record "$label" "failed" "directory not writable: $dest_dir"; return
    fi
    file="$TMP_DIR/$label.$kind"
    info "  Downloading $label …"
    if ! download "$url" "$file"; then
      fail "$label download failed"; record "$label" "failed" "Cannot download $url"; return
    fi
    if ! stage_app "$label" "$app" "$kind" "$file"; then
      fail "$label failed to unpack"; record "$label" "failed" "$app not found in the package"; return
    fi
    minver="$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$STAGED/Contents/Info.plist" 2>/dev/null || true)"
    sysver="$(sw_vers -productVersion 2>/dev/null || true)"
    if [ -n "$minver" ] && [ -n "$sysver" ] && ! ver_ge "$sysver" "$minver"; then
      fail "$label needs macOS $minver or later (current ${sysver})"; record "$label" "failed" "macOS version too old; macOS $minver+ is required"; return
    fi
    if ! codesign --verify --deep --strict "$STAGED" >/dev/null 2>&1; then
      fail "$label failed signature verification; installation aborted"; record "$label" "failed" "code signature verification failed"; return
    fi
    rm -rf "${dest_dir:?}/$app"
    if ! ditto "$STAGED" "$dest_dir/$app"; then
      fail "Copying $label to $dest_dir failed"; record "$label" "failed" "copying to $dest_dir failed"; return
    fi
    APPS_INSTALLED="${APPS_INSTALLED}${label} "
    ok "$label installed to $dest_dir/$app"
    record "$label" "installed" "$dest_dir/$app"
  }

  APPS_INSTALLED=""
  install_mac_apps() {
    step "Mac apps"
    if [ "$OS" != "macos" ]; then
      warn "Desktop apps are only supported on macOS; skipped"; record "Mac apps" "skipped" "macOS only"; return
    fi
    if [ -n "${SSH_CONNECTION:-}" ] && [ -z "$APPS_DIR" ]; then
      warn "This is a remote SSH login without a desktop session; desktop apps were skipped"; record "Mac apps" "skipped" "SSH session"; return
    fi
    if [ "$FETCH" != "curl" ]; then
      fail "curl is required"; record "Mac apps" "failed" "curl is missing"; return
    fi
    install_mac_app "Maccy" "Maccy.app" zip "https://github.com/p0deje/Maccy/releases/latest/download/Maccy.app.zip"
    install_mac_app "Snipaste" "Snipaste.app" dmg "https://dl.snipaste.com/mac"
    local tag arch
    case "$ARCH" in aarch64) arch="aarch64" ;; *) arch="x64" ;; esac
    if tag="$(latest_github_tag clash-verge-rev/clash-verge-rev)" && [ -n "$tag" ]; then
      install_mac_app "Clash Verge" "Clash Verge.app" dmg \
        "https://github.com/clash-verge-rev/clash-verge-rev/releases/download/$tag/Clash.Verge_${tag#v}_${arch}.dmg"
    else
      fail "Cannot get the latest Clash Verge version"; record "Clash Verge" "failed" "Cannot get the latest version number"
    fi
    case "$APPS_INSTALLED" in
      *Maccy*|*Snipaste*)
        info ""
        info "  On first launch you must grant permissions under System Settings → Privacy & Security (the script cannot click for you):"
        case "$APPS_INSTALLED" in *Maccy*) info "    Maccy: Accessibility (for auto-paste)" ;; esac
        case "$APPS_INSTALLED" in *Snipaste*) info "    Snipaste: Screen Recording and Accessibility (for screenshots and pinning)" ;; esac ;;
    esac
  }

  # ---------- Final step: summary ----------
  print_summary() {
    step "Summary"
    local line name status note
    while IFS='|' read -r name status note; do
      [ -n "$name" ] || continue
      case "$status" in
        failed) printf '  %s✗%s %-12s %s  %s\n' "$C_RED" "$C_RESET" "$name" "$status" "$note" ;;
        "not installed"|"not generated") printf '  %s!%s %-12s %s  %s\n' "$C_YELLOW" "$C_RESET" "$name" "$status" "$note" ;;
        *) printf '  %s✓%s %-12s %s  %s\n' "$C_GREEN" "$C_RESET" "$name" "$status" "$note" ;;
      esac
    done <<EOF
$SUMMARY
EOF
    if [ "$CHECK_ONLY" -eq 0 ] && [ "$MODIFY_PATH" -eq 1 ]; then
      info ""
      info "  Tip: open a new terminal, or run source $(shell_rc_file), so the PATH takes effect."
    fi
  }

  # ---------- Main flow ----------
  if ! check_environment; then return 1; fi
  TMP_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t install-claude-code)"
  # --check changes nothing; existing tools must still be found
  path_has_bin_dir || export PATH="$BIN_DIR:$PATH"
  install_claude
  install_codex
  setup_ssh_key
  setup_agent_sync
  install_ta
  install_pm2
  if [ "$WITH_APPS" -eq 1 ]; then install_mac_apps; fi
  print_summary
  return "$FAILED"
}

main "$@"
