#!/usr/bin/env bash
# Proxy install and subscription setup (macOS / Linux).
#
# macOS: import the subscription into an installed Clash Verge (install the app first with install-claude-code.sh --with-apps)
# Linux: install the mihomo core, fetch the subscription to build the configuration, and run it as a user-level service (no sudo needed)
#
# Usage:
# curl -fsSL <script-url> | bash                 # enter the subscription link when prompted
# curl -fsSL <script-url> | bash -s -- --status  # show the run status
#
# The subscription link is private: it is only read as hidden input from the terminal (or from the environment variable T_AGENT_PROXY_SUB_URL),
# only saved to a file with mode 600, never printed and never shown in process arguments.

main() {
  set -uo pipefail

  local MODE="install" USE_CORE=0 UPGRADE=0 RECONFIGURE=0 NO_SERVICE=0
  local PORT=7890 CONTROLLER_PORT=9090
  local OS="" ARCH="" TMP_DIR_LOCAL=""
  local CONF_DIR="$HOME/.config/mihomo"
  local BIN_DIR="$HOME/.local/bin"
  local CORE_BIN="$BIN_DIR/mihomo"
  local SUB_FILE="$CONF_DIR/subscription.url"
  local UNIT_DIR="$HOME/.config/systemd/user"
  local SUB_URL=""

  local C_RESET="" C_GREEN="" C_YELLOW="" C_RED="" C_BOLD=""
  if [ -t 1 ]; then
    C_RESET=$'\033[0m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_BOLD=$'\033[1m'
  fi
  info() { printf '%s\n' "$*"; }
  step() { printf '\n%s[%s]%s %s\n' "$C_BOLD" "$1" "$C_RESET" "$2"; }
  ok()   { printf '  %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
  warn() { printf '  %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
  fail() { printf '  %s✗%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; }
  have() { command -v "$1" >/dev/null 2>&1; }

  # The EXIT trap only runs after main returns, so the temporary directory variable must be global
  TMP_DIR=""
  cleanup() { [ -n "${TMP_DIR:-}" ] && rm -rf "$TMP_DIR"; return 0; }
  trap cleanup EXIT

  usage() {
    cat <<'USAGE'
Usage: curl -fsSL <script-url> | bash -s -- [options]
  (no arguments)      install and prompt for the subscription link
  --update            re-fetch the configuration from the saved subscription link and restart (core mode only)
  --status            show the core, service and proxy port status
  --core              also install the mihomo core on macOS instead of using Clash Verge
  --reconfigure       ignore the saved subscription link and enter it again
  --upgrade           download the latest mihomo core again
  --port N            proxy port (default 7890, mixed HTTP/SOCKS port)
  --controller-port N controller port (default 9090, listens on 127.0.0.1 only)
  --no-service        do not create a service, just start the process in the background
  -h, --help          show this help
The environment variable T_AGENT_PROXY_SUB_URL can provide the subscription link when there is no terminal.
USAGE
  }

  while [ $# -gt 0 ]; do
    case "$1" in
      --update) MODE="update" ;;
      --status) MODE="status" ;;
      --core) USE_CORE=1 ;;
      --reconfigure) RECONFIGURE=1 ;;
      --upgrade) UPGRADE=1 ;;
      --no-service) NO_SERVICE=1 ;;
      --port|--controller-port)
        local flag="$1"; shift
        case "${1:-}" in
          ''|*[!0-9]*) fail "${flag} needs a numeric port"; return 2 ;;
        esac
        if [ "$1" -lt 1024 ] || [ "$1" -gt 65535 ]; then fail "${flag} needs a port between 1024 and 65535"; return 2; fi
        if [ "$flag" = "--port" ]; then PORT="$1"; else CONTROLLER_PORT="$1"; fi ;;
      -h|--help) usage; return 0 ;;
      *) fail "Unknown option: $1 (use --help for usage)"; return 2 ;;
    esac
    shift
  done

  # ---------- Common ----------
  detect_platform() {
    case "$(uname -s)" in
      Darwin) OS="macos" ;;
      Linux) OS="linux" ;;
      *) fail "Unsupported system: $(uname -s)"; return 1 ;;
    esac
    case "$(uname -m)" in
      arm64|aarch64) ARCH="arm64" ;;
      x86_64|amd64) ARCH="amd64" ;;
      *) fail "Unsupported CPU architecture: $(uname -m)"; return 1 ;;
    esac
    have curl || { fail "curl is required"; return 1; }
  }

  # Enter the subscription link as hidden input; a saved link is reused by default
  read_subscription() {
    SUB_URL=""
    if [ "$RECONFIGURE" -eq 0 ] && [ -f "$SUB_FILE" ]; then
      SUB_URL="$(cat "$SUB_FILE")"
      ok "Using the saved subscription link (add --reconfigure to enter it again)"
      return 0
    fi
    if [ -n "${T_AGENT_PROXY_SUB_URL:-}" ]; then
      SUB_URL="$T_AGENT_PROXY_SUB_URL"
      validate_subscription_url || { SUB_URL=""; return 1; }
    else
      if ! have_tty; then
        fail "No interactive terminal; set the environment variable T_AGENT_PROXY_SUB_URL and retry"
        return 1
      fi
      local attempt=0
      while [ "$attempt" -lt 3 ]; do
        attempt=$((attempt + 1))
        printf '  Paste the subscription link (input is hidden; press Enter after pasting):' >/dev/tty
        IFS= read -rs SUB_URL </dev/tty || { printf '\n' >/dev/tty; return 1; }
        printf '\n' >/dev/tty
        SUB_URL="$(printf '%s' "$SUB_URL" | tr -d '\r\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
        validate_subscription_url && break
        SUB_URL=""
      done
    fi
    [ -n "$SUB_URL" ]
  }

  validate_subscription_url() {
    case "$SUB_URL" in
      http://*|https://*) ;;
      *) fail "The subscription link must start with http:// or https://"; return 1 ;;
    esac
    case "$SUB_URL" in
      *[[:space:]]*|*\"*|*\\*|*\'*) fail "The subscription link contains whitespace, quotes or other illegal characters"; return 1 ;;
    esac
    local host="${SUB_URL#*://}"; host="${host%%[/?#]*}"
    ok "Subscription link read (host: ${host}, ${#SUB_URL} characters)"
  }

  # Fetch the subscription content into a file. The link is passed through curl's config input so it does not appear in process arguments
  fetch_subscription() {
    local out="$1"
    printf 'url = "%s"\n' "$SUB_URL" | curl -fsSL --connect-timeout 15 -m 60 -A "clash.meta" -K - -o "$out"
  }

  looks_like_clash_config() {
    grep -Eq '^(proxies|proxy-providers):' "$1" 2>/dev/null
  }

  save_subscription() {
    mkdir -p "$CONF_DIR" && chmod 700 "$CONF_DIR"
    ( umask 077; printf '%s' "$SUB_URL" > "$SUB_FILE" ) && chmod 600 "$SUB_FILE"
  }

  # URL encoding in pure bash
  urlencode() {
    local LC_ALL=C s="$1" i c out=""
    for ((i = 0; i < ${#s}; i++)); do
      c="${s:i:1}"
      case "$c" in
        [a-zA-Z0-9.~_-]) out+="$c" ;;
        # printf '%d' on a non-ASCII byte is sign-extended, so only the low 8 bits must be taken
        *) out+="$(printf '%%%02X' $(( $(printf '%d' "'$c") & 255 )))" ;;
      esac
    done
    printf '%s' "$out"
  }

  # The /dev/tty file always exists; it must really be opened once to tell whether an interactive terminal exists
  have_tty() { ( : </dev/tty ) 2>/dev/null; }

  port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

  # ---------- macOS: import into Clash Verge ----------
  import_into_clash_verge() {
    step "1/3" "Checking Clash Verge"
    local app=""
    for app in "/Applications/Clash Verge.app" "$HOME/Applications/Clash Verge.app"; do
      [ -d "$app" ] && break
      app=""
    done
    if [ -z "$app" ]; then
      fail "Clash Verge not found. Run the main script to install it first: curl -fsSL <script-url> | bash -s -- --with-apps"
      return 1
    fi
    ok "Installed: $app"

    step "2/3" "Subscription link"
    read_subscription || return 1
    TMP_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t install-proxy)"
    if fetch_subscription "$TMP_DIR/sub"; then
      if looks_like_clash_config "$TMP_DIR/sub"; then ok "The subscription is reachable and contains a Clash configuration"
      else warn "The subscription is reachable, but the content does not look like a Clash configuration (you may need a Clash/mihomo format link from your provider)"; fi
    else
      warn "Cannot fetch the subscription content right now; it is still handed to Clash Verge to import, which will retry"
    fi

    step "3/3" "Import into Clash Verge"
    # url= must come last: Clash Verge treats everything after url= as the subscription address
    open "clash://install-config?name=t-agent&url=$(urlencode "$SUB_URL")" \
      && ok "Import request sent; confirm it in the Clash Verge window" \
      || { fail "Cannot open Clash Verge"; return 1; }
    info ""
    info "  Next, finish these steps manually in Clash Verge:"
    info "    1. On the “Profiles” page confirm that the profile named t-agent has been imported and selected"
    info "    2. In “Settings” turn on “System Proxy” (it asks for permission the first time)"
    info "  To update the subscription later, click refresh on the “Profiles” page."
  }

  # ---------- mihomo core ----------
  latest_tag() {
    local url
    url="$(curl -fsSL --connect-timeout 15 -o /dev/null -w '%{url_effective}' "https://github.com/MetaCubeX/mihomo/releases/latest" </dev/null)" || return 1
    printf '%s\n' "${url##*/}"
  }

  install_core() {
    step "1/4" "Install the mihomo core"
    if [ -x "$CORE_BIN" ] && [ "$UPGRADE" -eq 0 ]; then
      ok "Installed: $("$CORE_BIN" -v 2>/dev/null | head -n1)"
      return 0
    fi
    local tag asset
    tag="$(latest_tag)" || { fail "Cannot get the latest mihomo version (is github.com reachable?)"; return 1; }
    case "$OS-$ARCH" in
      linux-amd64) asset="mihomo-linux-amd64-compatible-$tag.gz" ;;
      linux-arm64) asset="mihomo-linux-arm64-$tag.gz" ;;
      macos-amd64) asset="mihomo-darwin-amd64-compatible-$tag.gz" ;;
      macos-arm64) asset="mihomo-darwin-arm64-$tag.gz" ;;
    esac
    info "  Downloading $asset …"
    TMP_DIR="${TMP_DIR:-$(mktemp -d 2>/dev/null || mktemp -d -t install-proxy)}"
    if ! curl -fsSL --connect-timeout 15 --retry 2 -o "$TMP_DIR/core.gz" "https://github.com/MetaCubeX/mihomo/releases/download/$tag/$asset" </dev/null; then
      fail "Download failed"; return 1
    fi
    mkdir -p "$BIN_DIR"
    if ! gzip -dc "$TMP_DIR/core.gz" > "$TMP_DIR/mihomo" || ! install -m 755 "$TMP_DIR/mihomo" "$CORE_BIN"; then
      fail "Extraction or installation failed"; return 1
    fi
    ok "Installed: $("$CORE_BIN" -v 2>/dev/null | head -n1)"
  }

  # Override the listen-related items in the subscription config so it only listens on this machine
  patch_config() {
    local src="$1" dst="$2"
    {
      printf 'mixed-port: %s\nallow-lan: false\nbind-address: 127.0.0.1\nexternal-controller: 127.0.0.1:%s\n' "$PORT" "$CONTROLLER_PORT"
      grep -Ev '^(mixed-port|port|socks-port|redir-port|tproxy-port|allow-lan|bind-address|external-controller|external-controller-tls|external-ui):' "$src"
    } > "$dst"
  }

  write_config() {
    step "2/4" "Subscription and configuration"
    if [ "$MODE" = "update" ]; then
      [ -f "$SUB_FILE" ] || { fail "No saved subscription link; run once without arguments first"; return 1; }
      SUB_URL="$(cat "$SUB_FILE")"
      ok "Using the saved subscription link"
    else
      read_subscription || return 1
    fi
    TMP_DIR="${TMP_DIR:-$(mktemp -d 2>/dev/null || mktemp -d -t install-proxy)}"
    if ! fetch_subscription "$TMP_DIR/sub"; then
      fail "Failed to fetch the subscription (is the link valid? is the subscription server reachable?)"; return 1
    fi
    if ! looks_like_clash_config "$TMP_DIR/sub"; then
      fail "The subscription is not a Clash/mihomo configuration (no proxies); get a Clash format subscription link from your provider"; return 1
    fi
    ok "Subscription fetched"
    save_subscription
    patch_config "$TMP_DIR/sub" "$TMP_DIR/config.yaml"
    if ! "$CORE_BIN" -t -d "$CONF_DIR" -f "$TMP_DIR/config.yaml" >"$TMP_DIR/test.log" 2>&1; then
      fail "Configuration validation failed:"
      grep -iE 'error|fatal' "$TMP_DIR/test.log" | head -3 | sed 's/^/    /' >&2
      return 1
    fi
    ok "Configuration validated"
    [ -f "$CONF_DIR/config.yaml" ] && cp -p "$CONF_DIR/config.yaml" "$CONF_DIR/config.yaml.bak"
    ( umask 077; cp "$TMP_DIR/config.yaml" "$CONF_DIR/config.yaml" ) && chmod 600 "$CONF_DIR/config.yaml"
    ok "Configuration written to $CONF_DIR/config.yaml"
  }

  # ---------- Service management ----------
  systemd_user_ok() {
    [ "$OS" = "linux" ] && have systemctl && systemctl --user show-environment >/dev/null 2>&1
  }

  pid_file() { printf '%s\n' "$CONF_DIR/mihomo.pid"; }

  stop_background() {
    local pf pid
    pf="$(pid_file)"
    [ -f "$pf" ] || return 0
    pid="$(cat "$pf" 2>/dev/null)"
    if [ -n "$pid" ] && ps -p "$pid" -o command= 2>/dev/null | grep -q mihomo; then
      kill "$pid" 2>/dev/null
      local i=0
      while [ "$i" -lt 10 ] && kill -0 "$pid" 2>/dev/null; do sleep 0.3; i=$((i + 1)); done
    fi
    rm -f "$pf"
  }

  start_background() {
    stop_background
    nohup "$CORE_BIN" -d "$CONF_DIR" >>"$CONF_DIR/mihomo.log" 2>&1 </dev/null &
    echo $! > "$(pid_file)"
    disown 2>/dev/null || true
  }

  start_service() {
    step "3/4" "Start the service"
    if [ "$NO_SERVICE" -eq 0 ] && systemd_user_ok; then
      stop_background
      mkdir -p "$UNIT_DIR"
      cat > "$UNIT_DIR/mihomo.service" <<UNIT
[Unit]
Description=mihomo proxy (installed by install-proxy.sh)
After=network-online.target

[Service]
ExecStart=$CORE_BIN -d $CONF_DIR
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
UNIT
      systemctl --user daemon-reload
      if systemctl --user enable mihomo.service >/dev/null 2>&1 && systemctl --user restart mihomo.service; then
        ok "Created and started the user-level service mihomo.service"
      else
        fail "The systemd user service failed to start; check: journalctl --user -u mihomo"; return 1
      fi
      # Keep the service running after logout and reboot; if there is no permission only a hint is shown
      if have loginctl && ! loginctl show-user "$(id -un)" 2>/dev/null | grep -q '^Linger=yes'; then
        if loginctl enable-linger "$(id -un)" >/dev/null 2>&1; then ok "Start on boot (linger) enabled"
        else warn "Could not enable start on boot; to keep running after logout, run: sudo loginctl enable-linger $(id -un)"; fi
      fi
    else
      [ "$NO_SERVICE" -eq 1 ] || warn "No systemd user service is available here, so it runs as a background process (run this script again after a reboot)"
      start_background
      ok "Started in the background (log: $CONF_DIR/mihomo.log)"
    fi
  }

  restart_service() {
    if systemctl --user is-enabled mihomo.service >/dev/null 2>&1; then
      systemctl --user restart mihomo.service
    else
      start_background
    fi
  }

  write_env_helper() {
    cat > "$CONF_DIR/proxy-env.sh" <<ENVSH
# Enable/disable the proxy in the current terminal: source $CONF_DIR/proxy-env.sh
proxy_on() {
  export http_proxy="http://127.0.0.1:$PORT" https_proxy="http://127.0.0.1:$PORT" all_proxy="socks5://127.0.0.1:$PORT"
  export HTTP_PROXY="\$http_proxy" HTTPS_PROXY="\$https_proxy" ALL_PROXY="\$all_proxy"
  export no_proxy="localhost,127.0.0.1,::1" NO_PROXY="localhost,127.0.0.1,::1"
}
proxy_off() {
  unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY no_proxy NO_PROXY
}
ENVSH
  }

  verify_proxy() {
    step "4/4" "Verify"
    local i=0
    while [ "$i" -lt 20 ] && ! port_open "$PORT"; do sleep 0.5; i=$((i + 1)); done
    if ! port_open "$PORT"; then
      fail "Proxy port $PORT is not up; check the log: $CONF_DIR/mihomo.log or journalctl --user -u mihomo"; return 1
    fi
    ok "Proxy port 127.0.0.1:$PORT is listening"
    local code
    code="$(curl -s -o /dev/null -m 15 -w '%{http_code}' --proxy "http://127.0.0.1:$PORT" https://www.gstatic.com/generate_204 </dev/null || true)"
    if [ "$code" = "204" ]; then ok "Reaching the internet through the proxy works"
    else warn "The proxy started, but reaching the internet failed (HTTP ${code:-no response}); the node may be unavailable, check the subscription or retry later"; fi
    write_env_helper
    info ""
    info "  Use the proxy in a terminal: source $CONF_DIR/proxy-env.sh && proxy_on   (turn off: proxy_off)"
    info "  Update the subscription: curl -fsSL <script-url> | bash -s -- --update"
  }

  show_status() {
    info "${C_BOLD}mihomo status${C_RESET}"
    if [ -x "$CORE_BIN" ]; then ok "Core: $("$CORE_BIN" -v 2>/dev/null | head -n1)"; else warn "Core not installed"; fi
    if [ -f "$SUB_FILE" ]; then ok "Subscription link saved (${SUB_FILE}, permissions $(stat -c '%a' "$SUB_FILE" 2>/dev/null || stat -f '%Lp' "$SUB_FILE"))"; else warn "No saved subscription link"; fi
    if have systemctl && systemctl --user is-active mihomo.service >/dev/null 2>&1; then ok "Service: running (systemd user service)"
    elif [ -f "$(pid_file)" ] && kill -0 "$(cat "$(pid_file)")" 2>/dev/null; then ok "Process: running (background, pid $(cat "$(pid_file)"))"
    else warn "Service not running"; fi
    if port_open "$PORT"; then ok "Port 127.0.0.1:$PORT is listening"; else warn "Port 127.0.0.1:$PORT is not listening"; fi
  }

  # ---------- Main flow ----------
  detect_platform || return 1
  if [ "$MODE" = "status" ]; then show_status; return 0; fi
  if [ "$OS" = "macos" ] && [ "$USE_CORE" -eq 0 ]; then
    [ "$MODE" = "update" ] && { fail "For Clash Verge refresh on its “Profiles” page; --update is only for mihomo core mode (add --core)"; return 2; }
    import_into_clash_verge
    return $?
  fi
  if [ "$MODE" = "update" ]; then
    [ -x "$CORE_BIN" ] || { fail "mihomo is not installed yet; run once without arguments first"; return 1; }
    write_config || return 1
    step "3/4" "Restart the service"
    restart_service || return 1
    ok "Restarted"
    verify_proxy
    return $?
  fi
  install_core || return 1
  write_config || return 1
  start_service || return 1
  verify_proxy
}

main "$@"
