#!/usr/bin/env bash
# 代理安装与订阅配置（macOS / Linux）。
#
#   macOS：把订阅导入已安装的 Clash Verge（先用 install-claude-code.sh --with-apps 安装应用）
#   Linux：安装 mihomo 内核，拉取订阅生成配置，以用户级服务运行（不需要 sudo）
#
# 用法：
#   curl -fsSL <脚本地址> | bash                 # 按提示输入订阅链接
#   curl -fsSL <脚本地址> | bash -s -- --status  # 查看运行状态
#
# 订阅链接属于私密信息：只从终端隐藏输入（或读取环境变量 T_AGENT_PROXY_SUB_URL），
# 只保存到权限为 600 的文件，不会打印，也不会出现在进程参数里。

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

  # EXIT 陷阱在 main 返回后才执行，所以临时目录变量必须是全局的
  TMP_DIR=""
  cleanup() { [ -n "${TMP_DIR:-}" ] && rm -rf "$TMP_DIR"; return 0; }
  trap cleanup EXIT

  usage() {
    cat <<'USAGE'
用法：curl -fsSL <脚本地址> | bash -s -- [参数]
  （无参数）           安装并按提示输入订阅链接
  --update            用已保存的订阅链接重新拉取配置并重启（仅内核模式）
  --status            查看内核、服务和代理端口状态
  --core              在 macOS 上也安装 mihomo 内核，而不是使用 Clash Verge
  --reconfigure       忽略已保存的订阅链接，重新输入
  --upgrade           重新下载最新的 mihomo 内核
  --port N            代理端口（默认 7890，HTTP/SOCKS 混合端口）
  --controller-port N 控制接口端口（默认 9090，只监听 127.0.0.1）
  --no-service        不创建服务，只在后台启动进程
  -h, --help          显示帮助
环境变量 T_AGENT_PROXY_SUB_URL 可在无终端时提供订阅链接。
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
          ''|*[!0-9]*) fail "${flag} 需要数字端口"; return 2 ;;
        esac
        if [ "$1" -lt 1024 ] || [ "$1" -gt 65535 ]; then fail "${flag} 需要 1024-65535 之间的端口"; return 2; fi
        if [ "$flag" = "--port" ]; then PORT="$1"; else CONTROLLER_PORT="$1"; fi ;;
      -h|--help) usage; return 0 ;;
      *) fail "未知参数：$1（使用 --help 查看用法）"; return 2 ;;
    esac
    shift
  done

  # ---------- 通用 ----------
  detect_platform() {
    case "$(uname -s)" in
      Darwin) OS="macos" ;;
      Linux) OS="linux" ;;
      *) fail "不支持的系统：$(uname -s)"; return 1 ;;
    esac
    case "$(uname -m)" in
      arm64|aarch64) ARCH="arm64" ;;
      x86_64|amd64) ARCH="amd64" ;;
      *) fail "不支持的 CPU 架构：$(uname -m)"; return 1 ;;
    esac
    have curl || { fail "需要 curl"; return 1; }
  }

  # 隐藏输入订阅链接；已保存的链接默认复用
  read_subscription() {
    SUB_URL=""
    if [ "$RECONFIGURE" -eq 0 ] && [ -f "$SUB_FILE" ]; then
      SUB_URL="$(cat "$SUB_FILE")"
      ok "使用已保存的订阅链接（加 --reconfigure 可重新输入）"
      return 0
    fi
    if [ -n "${T_AGENT_PROXY_SUB_URL:-}" ]; then
      SUB_URL="$T_AGENT_PROXY_SUB_URL"
      validate_subscription_url || { SUB_URL=""; return 1; }
    else
      if ! have_tty; then
        fail "没有可交互的终端；请设置环境变量 T_AGENT_PROXY_SUB_URL 后重试"
        return 1
      fi
      local attempt=0
      while [ "$attempt" -lt 3 ]; do
        attempt=$((attempt + 1))
        printf '  请粘贴订阅链接（输入时不显示，粘贴后回车）：' >/dev/tty
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
      *) fail "订阅链接必须以 http:// 或 https:// 开头"; return 1 ;;
    esac
    case "$SUB_URL" in
      *[[:space:]]*|*\"*|*\\*|*\'*) fail "订阅链接包含空白或引号等非法字符"; return 1 ;;
    esac
    local host="${SUB_URL#*://}"; host="${host%%[/?#]*}"
    ok "已读取订阅链接（主机：${host}，共 ${#SUB_URL} 个字符）"
  }

  # 拉取订阅内容到文件。链接通过 curl 的配置输入，避免出现在进程参数里
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

  # 纯 bash 的 URL 编码
  urlencode() {
    local LC_ALL=C s="$1" i c out=""
    for ((i = 0; i < ${#s}; i++)); do
      c="${s:i:1}"
      case "$c" in
        [a-zA-Z0-9.~_-]) out+="$c" ;;
        # 非 ASCII 字节的 printf '%d' 会被符号扩展，必须只取低 8 位
        *) out+="$(printf '%%%02X' $(( $(printf '%d' "'$c") & 255 )))" ;;
      esac
    done
    printf '%s' "$out"
  }

  # /dev/tty 文件总是存在，必须真正打开一次才能判断有没有可交互终端
  have_tty() { ( : </dev/tty ) 2>/dev/null; }

  port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

  # ---------- macOS：导入 Clash Verge ----------
  import_into_clash_verge() {
    step "1/3" "检查 Clash Verge"
    local app=""
    for app in "/Applications/Clash Verge.app" "$HOME/Applications/Clash Verge.app"; do
      [ -d "$app" ] && break
      app=""
    done
    if [ -z "$app" ]; then
      fail "未找到 Clash Verge。请先运行主脚本安装：curl -fsSL <脚本地址> | bash -s -- --with-apps"
      return 1
    fi
    ok "已安装：$app"

    step "2/3" "订阅链接"
    read_subscription || return 1
    TMP_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t install-proxy)"
    if fetch_subscription "$TMP_DIR/sub"; then
      if looks_like_clash_config "$TMP_DIR/sub"; then ok "订阅可访问，内容是 Clash 配置"
      else warn "订阅可访问，但内容看起来不是 Clash 配置（可能需要机场提供的 Clash/mihomo 格式链接）"; fi
    else
      warn "暂时无法拉取订阅内容；仍会交给 Clash Verge 导入，由它重试"
    fi

    step "3/3" "导入到 Clash Verge"
    # url= 必须放在最后：Clash Verge 会把 url= 之后的全部内容当作订阅地址
    open "clash://install-config?name=t-agent&url=$(urlencode "$SUB_URL")" \
      && ok "已发出导入请求，请在 Clash Verge 窗口中确认" \
      || { fail "无法打开 Clash Verge"; return 1; }
    info ""
    info "  接下来请在 Clash Verge 中手动完成："
    info "    1. 在“订阅”页确认名为 t-agent 的配置已导入并选中"
    info "    2. 在“设置”里打开“系统代理”（首次会请求授权）"
    info "  之后更新订阅在“订阅”页点刷新即可。"
  }

  # ---------- mihomo 内核 ----------
  latest_tag() {
    local url
    url="$(curl -fsSL --connect-timeout 15 -o /dev/null -w '%{url_effective}' "https://github.com/MetaCubeX/mihomo/releases/latest" </dev/null)" || return 1
    printf '%s\n' "${url##*/}"
  }

  install_core() {
    step "1/4" "安装 mihomo 内核"
    if [ -x "$CORE_BIN" ] && [ "$UPGRADE" -eq 0 ]; then
      ok "已安装：$("$CORE_BIN" -v 2>/dev/null | head -n1)"
      return 0
    fi
    local tag asset
    tag="$(latest_tag)" || { fail "无法获取 mihomo 最新版本（能否访问 github.com？）"; return 1; }
    case "$OS-$ARCH" in
      linux-amd64) asset="mihomo-linux-amd64-compatible-$tag.gz" ;;
      linux-arm64) asset="mihomo-linux-arm64-$tag.gz" ;;
      macos-amd64) asset="mihomo-darwin-amd64-compatible-$tag.gz" ;;
      macos-arm64) asset="mihomo-darwin-arm64-$tag.gz" ;;
    esac
    info "  正在下载 $asset …"
    TMP_DIR="${TMP_DIR:-$(mktemp -d 2>/dev/null || mktemp -d -t install-proxy)}"
    if ! curl -fsSL --connect-timeout 15 --retry 2 -o "$TMP_DIR/core.gz" "https://github.com/MetaCubeX/mihomo/releases/download/$tag/$asset" </dev/null; then
      fail "下载失败"; return 1
    fi
    mkdir -p "$BIN_DIR"
    if ! gzip -dc "$TMP_DIR/core.gz" > "$TMP_DIR/mihomo" || ! install -m 755 "$TMP_DIR/mihomo" "$CORE_BIN"; then
      fail "解压或安装失败"; return 1
    fi
    ok "已安装：$("$CORE_BIN" -v 2>/dev/null | head -n1)"
  }

  # 覆盖订阅配置里的监听相关项，保证只在本机监听
  patch_config() {
    local src="$1" dst="$2"
    {
      printf 'mixed-port: %s\nallow-lan: false\nbind-address: 127.0.0.1\nexternal-controller: 127.0.0.1:%s\n' "$PORT" "$CONTROLLER_PORT"
      grep -Ev '^(mixed-port|port|socks-port|redir-port|tproxy-port|allow-lan|bind-address|external-controller|external-controller-tls|external-ui):' "$src"
    } > "$dst"
  }

  write_config() {
    step "2/4" "订阅与配置"
    if [ "$MODE" = "update" ]; then
      [ -f "$SUB_FILE" ] || { fail "没有已保存的订阅链接，请先不带参数运行一次"; return 1; }
      SUB_URL="$(cat "$SUB_FILE")"
      ok "使用已保存的订阅链接"
    else
      read_subscription || return 1
    fi
    TMP_DIR="${TMP_DIR:-$(mktemp -d 2>/dev/null || mktemp -d -t install-proxy)}"
    if ! fetch_subscription "$TMP_DIR/sub"; then
      fail "拉取订阅失败（链接是否有效？能否访问订阅服务器？）"; return 1
    fi
    if ! looks_like_clash_config "$TMP_DIR/sub"; then
      fail "订阅内容不是 Clash/mihomo 配置（缺少 proxies），请向服务商获取 Clash 格式的订阅链接"; return 1
    fi
    ok "订阅拉取成功"
    save_subscription
    patch_config "$TMP_DIR/sub" "$TMP_DIR/config.yaml"
    if ! "$CORE_BIN" -t -d "$CONF_DIR" -f "$TMP_DIR/config.yaml" >"$TMP_DIR/test.log" 2>&1; then
      fail "配置校验失败："
      grep -iE 'error|fatal' "$TMP_DIR/test.log" | head -3 | sed 's/^/    /' >&2
      return 1
    fi
    ok "配置校验通过"
    [ -f "$CONF_DIR/config.yaml" ] && cp -p "$CONF_DIR/config.yaml" "$CONF_DIR/config.yaml.bak"
    ( umask 077; cp "$TMP_DIR/config.yaml" "$CONF_DIR/config.yaml" ) && chmod 600 "$CONF_DIR/config.yaml"
    ok "配置已写入 $CONF_DIR/config.yaml"
  }

  # ---------- 服务管理 ----------
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
    step "3/4" "启动服务"
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
        ok "已创建并启动用户级服务 mihomo.service"
      else
        fail "systemd 用户服务启动失败，可查看：journalctl --user -u mihomo"; return 1
      fi
      # 让服务在退出登录、重启后仍能运行；没有权限时只提示
      if have loginctl && ! loginctl show-user "$(id -un)" 2>/dev/null | grep -q '^Linger=yes'; then
        if loginctl enable-linger "$(id -un)" >/dev/null 2>&1; then ok "已启用开机自启（linger）"
        else warn "未能启用开机自启，如需退出登录后继续运行，请执行：sudo loginctl enable-linger $(id -un)"; fi
      fi
    else
      [ "$NO_SERVICE" -eq 1 ] || warn "当前环境没有可用的 systemd 用户服务，改为后台进程运行（重启后需重新运行本脚本）"
      start_background
      ok "已在后台启动（日志：$CONF_DIR/mihomo.log）"
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
# 在当前终端启用/关闭代理：source $CONF_DIR/proxy-env.sh
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
    step "4/4" "验证"
    local i=0
    while [ "$i" -lt 20 ] && ! port_open "$PORT"; do sleep 0.5; i=$((i + 1)); done
    if ! port_open "$PORT"; then
      fail "代理端口 $PORT 没有启动，请查看日志：$CONF_DIR/mihomo.log 或 journalctl --user -u mihomo"; return 1
    fi
    ok "代理端口 127.0.0.1:$PORT 已监听"
    local code
    code="$(curl -s -o /dev/null -m 15 -w '%{http_code}' --proxy "http://127.0.0.1:$PORT" https://www.gstatic.com/generate_204 </dev/null || true)"
    if [ "$code" = "204" ]; then ok "通过代理访问外网成功"
    else warn "代理已启动，但访问外网未成功（HTTP ${code:-无响应}）；可能是节点不可用，请检查订阅或稍后重试"; fi
    write_env_helper
    info ""
    info "  在终端里使用代理：source $CONF_DIR/proxy-env.sh && proxy_on   （关闭：proxy_off）"
    info "  更新订阅：curl -fsSL <脚本地址> | bash -s -- --update"
  }

  show_status() {
    info "${C_BOLD}mihomo 状态${C_RESET}"
    if [ -x "$CORE_BIN" ]; then ok "内核：$("$CORE_BIN" -v 2>/dev/null | head -n1)"; else warn "内核未安装"; fi
    if [ -f "$SUB_FILE" ]; then ok "已保存订阅链接（${SUB_FILE}，权限 $(stat -c '%a' "$SUB_FILE" 2>/dev/null || stat -f '%Lp' "$SUB_FILE")）"; else warn "没有保存的订阅链接"; fi
    if have systemctl && systemctl --user is-active mihomo.service >/dev/null 2>&1; then ok "服务：运行中（systemd 用户服务）"
    elif [ -f "$(pid_file)" ] && kill -0 "$(cat "$(pid_file)")" 2>/dev/null; then ok "进程：运行中（后台，pid $(cat "$(pid_file)")）"
    else warn "服务未运行"; fi
    if port_open "$PORT"; then ok "端口 127.0.0.1:$PORT 已监听"; else warn "端口 127.0.0.1:$PORT 未监听"; fi
  }

  # ---------- 主流程 ----------
  detect_platform || return 1
  if [ "$MODE" = "status" ]; then show_status; return 0; fi
  if [ "$OS" = "macos" ] && [ "$USE_CORE" -eq 0 ]; then
    [ "$MODE" = "update" ] && { fail "Clash Verge 请在其“订阅”页刷新；--update 仅用于 mihomo 内核模式（加 --core）"; return 2; }
    import_into_clash_verge
    return $?
  fi
  if [ "$MODE" = "update" ]; then
    [ -x "$CORE_BIN" ] || { fail "mihomo 尚未安装，请先不带参数运行一次"; return 1; }
    write_config || return 1
    step "3/4" "重启服务"
    restart_service || return 1
    ok "已重启"
    verify_proxy
    return $?
  fi
  install_core || return 1
  write_config || return 1
  start_service || return 1
  verify_proxy
}

main "$@"
