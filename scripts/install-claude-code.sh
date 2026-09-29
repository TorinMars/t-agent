#!/usr/bin/env bash
# 开发环境安装脚本（macOS / Linux）：Claude Code、Codex、SSH 密钥，以及用户级规则与默认配置的远程同步。
#
# 用法：
#   curl -fsSL <脚本地址> | bash
#   curl -fsSL <脚本地址> | bash -s -- --check
#
# 参数：
#   --check             只检查环境和已安装状态，不安装、不生成密钥
#   --upgrade           已安装的工具也重新安装为最新版本
#   --no-modify-path    不修改 shell 配置文件（不写 PATH，也不写 claude/codex 同步函数）
#   --passphrase        生成 SSH 密钥时交互设置密码短语（需要终端）
#   --skip NAME         跳过某一项，NAME 为 claude、codex、ssh 或 sync，可重复使用
#   --with-apps         同时安装 Mac 桌面应用：Maccy、Snipaste、Clash Verge（仅 macOS）
#   --apps-dir DIR      桌面应用的安装目录（默认 /Applications，不可写时用 ~/Applications）
#   -h, --help          显示帮助
#
# 不使用 Homebrew、不执行 sudo、不修改系统级配置；所有内容装在当前用户目录。
# 整个脚本包在 main 函数中，保证 curl | bash 时先完整读入再执行。

main() {
  set -uo pipefail

  local CHECK_ONLY=0 UPGRADE=0 MODIFY_PATH=1 PASSPHRASE=0
  local SKIP_CLAUDE=0 SKIP_CODEX=0 SKIP_SSH=0 SKIP_SYNC=0 WITH_APPS=0 APPS_DIR=""
  local STEP_NO=0 STEP_TOTAL=6
  local SCRIPTS_BASE="${T_AGENT_SCRIPTS_BASE:-https://raw.githubusercontent.com/TorinMars/t-agent/main/scripts}"
  local BIN_DIR="$HOME/.local/bin"
  local OS="" ARCH="" FETCH=""
  local SUMMARY="" FAILED=0

  # ---------- 输出 ----------
  local C_RESET="" C_GREEN="" C_YELLOW="" C_RED="" C_BOLD=""
  if [ -t 1 ]; then
    C_RESET=$'\033[0m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_BOLD=$'\033[1m'
  fi
  info() { printf '%s\n' "$*"; }
  step() { STEP_NO=$((STEP_NO + 1)); printf '\n%s[%s/%s]%s %s\n' "$C_BOLD" "$STEP_NO" "$STEP_TOTAL" "$C_RESET" "$1"; }
  ok()   { printf '  %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
  warn() { printf '  %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
  fail() { printf '  %s✗%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; }
  # 记录每一项的结果，最后统一汇总：record 名称 状态 说明
  record() {
    SUMMARY="${SUMMARY}$1|$2|$3"$'\n'
    [ "$2" = "失败" ] && FAILED=1
    return 0
  }

  usage() {
    cat <<'USAGE'
用法：curl -fsSL <脚本地址> | bash -s -- [参数]
  --check             只检查环境和已安装状态，不安装、不生成密钥
  --upgrade           已安装的工具也重新安装为最新版本
  --no-modify-path    不修改 shell 配置文件（不写 PATH，也不写 claude/codex 同步函数）
  --passphrase        生成 SSH 密钥时交互设置密码短语（需要终端）
  --skip NAME         跳过某一项：claude、codex、ssh 或 sync，可重复使用
  --with-apps         同时安装 Mac 桌面应用：Maccy、Snipaste、Clash Verge（仅 macOS）
  --apps-dir DIR      桌面应用的安装目录（默认 /Applications，不可写时用 ~/Applications）
  -h, --help          显示帮助
USAGE
  }

  # EXIT 陷阱在 main 返回后才执行，所以临时目录变量必须是全局的
  TMP_DIR=""
  cleanup() { [ -n "${TMP_DIR:-}" ] && rm -rf "$TMP_DIR"; return 0; }
  trap cleanup EXIT

  # ---------- 参数 ----------
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
          *) fail "--skip 只支持 claude、codex、ssh、sync"; return 2 ;;
        esac ;;
      --with-apps) WITH_APPS=1; STEP_TOTAL=7 ;;
      --apps-dir)
        shift
        if [ -z "${1:-}" ]; then fail "--apps-dir 需要指定目录"; return 2; fi
        APPS_DIR="$1" ;;
      -h|--help) usage; return 0 ;;
      *) fail "未知参数：$1（使用 --help 查看用法）"; return 2 ;;
    esac
    shift
  done

  # ---------- 通用工具 ----------
  have() { command -v "$1" >/dev/null 2>&1; }

  # 统一下载：download URL 目标文件。所有子进程不读取标准输入，避免吞掉管道里的脚本。
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

  # 当前 shell 对应的配置文件
  shell_rc_file() {
    case "$(basename "${SHELL:-}")" in
      zsh) printf '%s\n' "$HOME/.zshrc" ;;
      bash) if [ "$OS" = "macos" ]; then printf '%s\n' "$HOME/.bash_profile"; else printf '%s\n' "$HOME/.bashrc"; fi ;;
      *) printf '%s\n' "$HOME/.profile" ;;
    esac
  }

  # 缺少依赖时的安装提示，按系统区分
  install_hint() {
    local tool="$1"
    if [ "$OS" = "macos" ]; then
      case "$tool" in
        git|make|tar) printf '运行 xcode-select --install 安装 Xcode 命令行工具' ;;
        *) printf '请先安装 %s' "$tool" ;;
      esac
      return
    fi
    if have apt-get; then printf 'sudo apt-get install -y %s' "$tool"
    elif have dnf; then printf 'sudo dnf install -y %s' "$tool"
    elif have yum; then printf 'sudo yum install -y %s' "$tool"
    elif have apk; then printf 'sudo apk add %s' "$tool"
    elif have pacman; then printf 'sudo pacman -S %s' "$tool"
    else printf '请使用系统包管理器安装 %s' "$tool"
    fi
  }

  # ---------- 步骤 1：环境检查 ----------
  check_environment() {
    step "检查环境"
    case "$(uname -s)" in
      Darwin) OS="macos" ;;
      Linux) OS="linux" ;;
      *) fail "不支持的系统：$(uname -s)（仅支持 macOS 和 Linux）"; return 1 ;;
    esac
    case "$(uname -m)" in
      arm64|aarch64) ARCH="aarch64" ;;
      x86_64|amd64) ARCH="x86_64" ;;
      *) fail "不支持的 CPU 架构：$(uname -m)"; return 1 ;;
    esac
    ok "系统：$OS / $ARCH"

    if have curl; then FETCH="curl"
    elif have wget; then FETCH="wget"
    else
      fail "需要 curl 或 wget。$(install_hint curl)"
      return 1
    fi
    ok "下载工具：$FETCH"

    if have tar; then ok "tar 可用"; else warn "缺少 tar，Codex 二进制无法解压。$(install_hint tar)"; fi
    if have git; then ok "git 可用"; else warn "未安装 git（Claude Code 和 Codex 在项目中会用到）。$(install_hint git)"; fi
    if [ "$OS" = "linux" ] && [ ! -w "$HOME" ]; then fail "HOME 目录不可写：$HOME"; return 1; fi

    if reachable "https://claude.ai/install.sh"; then ok "可访问 claude.ai"
    else warn "无法访问 claude.ai；如需代理，请先设置 https_proxy 后重新运行"; fi
    if reachable "https://github.com"; then ok "可访问 github.com"
    else warn "无法访问 github.com；如需代理，请先设置 https_proxy 后重新运行"; fi

    if path_has_bin_dir; then ok "PATH 已包含 $BIN_DIR"
    else warn "PATH 尚未包含 $BIN_DIR"; fi
    return 0
  }

  # 让本次运行和以后的终端都能找到 ~/.local/bin 中的工具
  ensure_path() {
    mkdir -p "$BIN_DIR"
    if ! path_has_bin_dir; then export PATH="$BIN_DIR:$PATH"; fi
    [ "$MODIFY_PATH" -eq 1 ] || return 0
    local rc line
    rc="$(shell_rc_file)"
    line='export PATH="$HOME/.local/bin:$PATH"'
    if [ -f "$rc" ] && grep -Fq '.local/bin' "$rc"; then return 0; fi
    printf '\n# 由 install-claude-code.sh 添加\n%s\n' "$line" >> "$rc" \
      && ok "已把 ~/.local/bin 写入 ${rc}（新开的终端生效）" \
      || warn "无法写入 ${rc}，请手动添加：$line"
  }

  # ---------- 步骤 2：Claude Code ----------
  install_claude() {
    step "Claude Code"
    if [ "$SKIP_CLAUDE" -eq 1 ]; then record "Claude Code" "跳过" "使用了 --skip claude"; return; fi
    if have claude && [ "$UPGRADE" -eq 0 ]; then
      ok "已安装：$(claude --version 2>/dev/null | head -n1)"
      record "Claude Code" "已安装" "$(claude --version 2>/dev/null | head -n1)"
      return
    fi
    if [ "$CHECK_ONLY" -eq 1 ]; then
      warn "未安装"; record "Claude Code" "未安装" "--check 模式不安装"; return
    fi
    local installer="$TMP_DIR/claude-install.sh"
    if ! download "https://claude.ai/install.sh" "$installer"; then
      fail "下载官方安装器失败"; record "Claude Code" "失败" "无法下载 https://claude.ai/install.sh"; return
    fi
    if ! bash "$installer" </dev/null; then
      fail "官方安装器执行失败"; record "Claude Code" "失败" "官方安装器返回错误"; return
    fi
    ensure_path
    if have claude; then
      ok "安装完成：$(claude --version 2>/dev/null | head -n1)"
      record "Claude Code" "已安装" "$(claude --version 2>/dev/null | head -n1)"
    else
      fail "安装器已结束，但找不到 claude 命令"; record "Claude Code" "失败" "安装后找不到 claude"
    fi
  }

  # ---------- 步骤 3：Codex ----------
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
    if [ "$SKIP_CODEX" -eq 1 ]; then record "Codex" "跳过" "使用了 --skip codex"; return; fi
    if have codex && [ "$UPGRADE" -eq 0 ]; then
      ok "已安装：$(codex --version 2>/dev/null | head -n1)"
      record "Codex" "已安装" "$(codex --version 2>/dev/null | head -n1)"
      return
    fi
    if [ "$CHECK_ONLY" -eq 1 ]; then
      warn "未安装"; record "Codex" "未安装" "--check 模式不安装"; return
    fi
    ensure_path
    if install_codex_binary; then
      info "  已从 GitHub 发布页安装预编译二进制"
    elif install_codex_npm; then
      info "  预编译二进制不可用，已通过 npm 安装到 ~/.local"
    else
      fail "安装失败（GitHub 下载失败，且没有可用的 npm）"
      record "Codex" "失败" "无法下载预编译二进制，也没有 npm 可回退"
      return
    fi
    if have codex; then
      ok "安装完成：$(codex --version 2>/dev/null | head -n1)"
      record "Codex" "已安装" "$(codex --version 2>/dev/null | head -n1)；首次使用请运行 codex 登录"
    else
      fail "安装已结束，但找不到 codex 命令"; record "Codex" "失败" "安装后找不到 codex"
    fi
  }

  # ---------- 步骤 4：SSH 密钥 ----------
  existing_ssh_key() {
    local name
    for name in id_ed25519 id_rsa id_ecdsa id_dsa; do
      [ -f "$HOME/.ssh/$name" ] && { printf '%s\n' "$HOME/.ssh/$name"; return 0; }
    done
    return 1
  }

  setup_ssh_key() {
    step "SSH 密钥"
    if [ "$SKIP_SSH" -eq 1 ]; then record "SSH 密钥" "跳过" "使用了 --skip ssh"; return; fi
    local existing
    if existing="$(existing_ssh_key)"; then
      ok "已有密钥，不会覆盖：$existing"
      record "SSH 密钥" "已存在" "$existing"
      return
    fi
    if [ "$CHECK_ONLY" -eq 1 ]; then
      warn "没有 SSH 密钥"; record "SSH 密钥" "未生成" "--check 模式不生成"; return
    fi
    if ! have ssh-keygen; then
      fail "找不到 ssh-keygen。$(install_hint openssh-client)"
      record "SSH 密钥" "失败" "缺少 ssh-keygen"; return
    fi
    local key="$HOME/.ssh/id_ed25519" comment type_args
    comment="$(id -un)@$(hostname 2>/dev/null | cut -d. -f1)"
    mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
    type_args=(-t ed25519)
    if [ "$PASSPHRASE" -eq 1 ]; then
      if [ ! -r /dev/tty ]; then
        warn "没有可交互的终端，无法设置密码短语，改为不设密码短语"
        PASSPHRASE=0
      fi
    fi
    if [ "$PASSPHRASE" -eq 1 ]; then
      ssh-keygen "${type_args[@]}" -C "$comment" -f "$key" </dev/tty
    else
      ssh-keygen "${type_args[@]}" -C "$comment" -f "$key" -N "" -q </dev/null
    fi
    if [ ! -f "$key" ]; then
      # 很旧的 OpenSSH 不支持 ed25519，回退到 RSA
      key="$HOME/.ssh/id_rsa"
      if [ "$PASSPHRASE" -eq 1 ]; then
        ssh-keygen -t rsa -b 4096 -C "$comment" -f "$key" </dev/tty
      else
        ssh-keygen -t rsa -b 4096 -C "$comment" -f "$key" -N "" -q </dev/null
      fi
    fi
    if [ ! -f "$key" ]; then
      fail "生成密钥失败"; record "SSH 密钥" "失败" "ssh-keygen 未生成密钥"; return
    fi
    chmod 600 "$key"
    ok "已生成密钥：$key"
    # 设置了密码短语时，让 macOS 钥匙串记住它，避免每次输入
    if [ "$OS" = "macos" ] && [ "$PASSPHRASE" -eq 1 ]; then
      local config="$HOME/.ssh/config"
      if ! grep -Fq 'UseKeychain yes' "$config" 2>/dev/null; then
        printf '\n# 由 install-claude-code.sh 添加\nHost *\n  AddKeysToAgent yes\n  UseKeychain yes\n  IdentityFile %s\n' "$key" >> "$config"
        chmod 600 "$config"
      fi
      ssh-add --apple-use-keychain "$key" </dev/tty 2>/dev/null || true
    fi
    info ""
    info "  公钥如下（只显示公钥，请添加到 GitHub：https://github.com/settings/ssh/new）："
    info ""
    sed 's/^/    /' "$key.pub"
    if [ "$OS" = "macos" ] && have pbcopy; then
      pbcopy < "$key.pub" && ok "公钥已复制到剪贴板"
    fi
    record "SSH 密钥" "已生成" "$key.pub（请添加到 GitHub）"
  }



  # ---------- 步骤：Claude / Codex 用户级规则与配置同步 ----------
  SYNC_DIR="$HOME/.local/share/t-agent"
  SYNC_SCRIPT="$SYNC_DIR/agent-sync.py"
  SYNC_BEGIN="# >>> t-agent agent-sync >>>"
  SYNC_END="# <<< t-agent agent-sync <<<"

  python_ok() {
    have python3 && python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 6) else 1)' 2>/dev/null
  }

  # 在 shell 配置里写入 claude / codex 包装函数：启动前先同步，失败或超时都不影响启动
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
# 启动 claude / codex 前同步远程的用户级规则与默认配置（失败或超时不影响启动）
claude() { [ -f "$HOME/.local/share/t-agent/agent-sync.py" ] && command -v python3 >/dev/null 2>&1 && python3 "$HOME/.local/share/t-agent/agent-sync.py" claude; command claude "$@"; }
codex() { [ -f "$HOME/.local/share/t-agent/agent-sync.py" ] && command -v python3 >/dev/null 2>&1 && python3 "$HOME/.local/share/t-agent/agent-sync.py" codex; command codex "$@"; }
HOOK
      printf '%s\n' "$SYNC_END"
    } > "$work.out" && cat "$work.out" > "$rc"
  }

  setup_agent_sync() {
    step "规则与配置同步"
    if [ "$SKIP_SYNC" -eq 1 ]; then record "规则同步" "跳过" "使用了 --skip sync"; return; fi
    if ! python_ok; then
      warn "需要 python3（3.6+）才能同步；$(install_hint python3)"
      record "规则同步" "跳过" "缺少 python3"; return
    fi
    local rc
    rc="$(shell_rc_file)"
    if [ "$CHECK_ONLY" -eq 1 ]; then
      if [ -f "$SYNC_SCRIPT" ] && grep -Fq "$SYNC_BEGIN" "$rc" 2>/dev/null; then
        ok "已配置：启动 claude / codex 前自动同步"; record "规则同步" "已安装" "$SYNC_SCRIPT"
      else
        warn "尚未配置"; record "规则同步" "未安装" "--check 模式不安装"
      fi
      return
    fi
    mkdir -p "$SYNC_DIR"
    if ! download "$SCRIPTS_BASE/agent-sync.py" "$SYNC_DIR/agent-sync.py.new"; then
      fail "下载同步程序失败"; record "规则同步" "失败" "无法下载 agent-sync.py"; return
    fi
    chmod 755 "$SYNC_DIR/agent-sync.py.new" && mv "$SYNC_DIR/agent-sync.py.new" "$SYNC_SCRIPT"
    ok "同步程序：$SYNC_SCRIPT"
    python3 "$SYNC_SCRIPT" all --verbose </dev/null 2>&1 | sed 's/^/  /'
    if [ "$MODIFY_PATH" -eq 1 ]; then
      if write_sync_hook "$rc"; then
        ok "已在 $rc 写入 claude / codex 启动前同步（新开的终端生效）"
        record "规则同步" "已安装" "启动 claude / codex 前自动同步；配置见仓库 rules/"
      else
        fail "无法写入 $rc"; record "规则同步" "失败" "无法写入 $rc"
      fi
    else
      warn "使用了 --no-modify-path，未写入启动前同步；可手动运行：python3 $SYNC_SCRIPT all"
      record "规则同步" "已安装" "已同步一次，未写入 shell 配置"
    fi
  }

  # ---------- Mac 桌面应用 ----------
  apps_target_dir() {
    if [ -n "$APPS_DIR" ]; then printf '%s\n' "$APPS_DIR"
    elif [ -w /Applications ]; then printf '/Applications\n'
    else printf '%s\n' "$HOME/Applications"; fi
  }

  # 已安装的应用路径；指定了 --apps-dir 时只看该目录
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

  # $1 >= $2（按 主.次.修订 比较）
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

  # 把下载的 zip/dmg 中的应用解出到临时目录，成功后 STAGED 为应用路径
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

  # install_mac_app 显示名 应用文件名 zip|dmg 下载地址
  install_mac_app() {
    local label="$1" app="$2" kind="$3" url="$4"
    local existing dest_dir file minver sysver
    if existing="$(app_installed "$app")"; then
      if [ "$UPGRADE" -eq 0 ]; then
        ok "$label 已安装：$existing"; record "$label" "已安装" "$existing"; return
      fi
      if pgrep -f "$existing/Contents/MacOS" >/dev/null 2>&1; then
        warn "$label 正在运行，请先退出后再升级"; record "$label" "跳过" "正在运行，未升级"; return
      fi
    fi
    if [ "$CHECK_ONLY" -eq 1 ]; then
      warn "$label 未安装"; record "$label" "未安装" "--check 模式不安装"; return
    fi
    dest_dir="$(apps_target_dir)"
    if ! mkdir -p "$dest_dir" 2>/dev/null || [ ! -w "$dest_dir" ]; then
      fail "${label}：目录不可写 $dest_dir"; record "$label" "失败" "目录不可写：$dest_dir"; return
    fi
    file="$TMP_DIR/$label.$kind"
    info "  正在下载 $label …"
    if ! download "$url" "$file"; then
      fail "$label 下载失败"; record "$label" "失败" "无法下载 $url"; return
    fi
    if ! stage_app "$label" "$app" "$kind" "$file"; then
      fail "$label 解包失败"; record "$label" "失败" "安装包中找不到 $app"; return
    fi
    minver="$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$STAGED/Contents/Info.plist" 2>/dev/null || true)"
    sysver="$(sw_vers -productVersion 2>/dev/null || true)"
    if [ -n "$minver" ] && [ -n "$sysver" ] && ! ver_ge "$sysver" "$minver"; then
      fail "$label 需要 macOS $minver 或更高（当前 ${sysver}）"; record "$label" "失败" "系统版本过低，需要 macOS $minver+"; return
    fi
    if ! codesign --verify --deep --strict "$STAGED" >/dev/null 2>&1; then
      fail "$label 签名校验失败，已放弃安装"; record "$label" "失败" "代码签名校验失败"; return
    fi
    rm -rf "${dest_dir:?}/$app"
    if ! ditto "$STAGED" "$dest_dir/$app"; then
      fail "$label 复制到 $dest_dir 失败"; record "$label" "失败" "复制到 $dest_dir 失败"; return
    fi
    APPS_INSTALLED="${APPS_INSTALLED}${label} "
    ok "$label 已安装到 $dest_dir/$app"
    record "$label" "已安装" "$dest_dir/$app"
  }

  APPS_INSTALLED=""
  install_mac_apps() {
    step "Mac 应用"
    if [ "$OS" != "macos" ]; then
      warn "桌面应用只支持 macOS，已跳过"; record "Mac 应用" "跳过" "仅支持 macOS"; return
    fi
    if [ -n "${SSH_CONNECTION:-}" ] && [ -z "$APPS_DIR" ]; then
      warn "当前是 SSH 远程登录，没有桌面会话，已跳过桌面应用"; record "Mac 应用" "跳过" "SSH 会话"; return
    fi
    if [ "$FETCH" != "curl" ]; then
      fail "需要 curl"; record "Mac 应用" "失败" "缺少 curl"; return
    fi
    install_mac_app "Maccy" "Maccy.app" zip "https://github.com/p0deje/Maccy/releases/latest/download/Maccy.app.zip"
    install_mac_app "Snipaste" "Snipaste.app" dmg "https://dl.snipaste.com/mac"
    local tag arch
    case "$ARCH" in aarch64) arch="aarch64" ;; *) arch="x64" ;; esac
    if tag="$(latest_github_tag clash-verge-rev/clash-verge-rev)" && [ -n "$tag" ]; then
      install_mac_app "Clash Verge" "Clash Verge.app" dmg \
        "https://github.com/clash-verge-rev/clash-verge-rev/releases/download/$tag/Clash.Verge_${tag#v}_${arch}.dmg"
    else
      fail "无法获取 Clash Verge 的最新版本"; record "Clash Verge" "失败" "无法获取最新版本号"
    fi
    case "$APPS_INSTALLED" in
      *Maccy*|*Snipaste*)
        info ""
        info "  首次打开需要在 系统设置 → 隐私与安全性 中授权（脚本无法代为点击）："
        case "$APPS_INSTALLED" in *Maccy*) info "    Maccy：辅助功能（用于自动粘贴）" ;; esac
        case "$APPS_INSTALLED" in *Snipaste*) info "    Snipaste：屏幕录制、辅助功能（用于截图和贴图）" ;; esac ;;
    esac
  }

  # ---------- 最后一步：汇总 ----------
  print_summary() {
    step "汇总"
    local line name status note
    while IFS='|' read -r name status note; do
      [ -n "$name" ] || continue
      case "$status" in
        失败) printf '  %s✗%s %-12s %s  %s\n' "$C_RED" "$C_RESET" "$name" "$status" "$note" ;;
        未安装|未生成) printf '  %s!%s %-12s %s  %s\n' "$C_YELLOW" "$C_RESET" "$name" "$status" "$note" ;;
        *) printf '  %s✓%s %-12s %s  %s\n' "$C_GREEN" "$C_RESET" "$name" "$status" "$note" ;;
      esac
    done <<EOF
$SUMMARY
EOF
    if [ "$CHECK_ONLY" -eq 0 ] && [ "$MODIFY_PATH" -eq 1 ]; then
      info ""
      info "  提示：新开一个终端，或运行 source $(shell_rc_file)，让 PATH 生效。"
    fi
  }

  # ---------- 主流程 ----------
  if ! check_environment; then return 1; fi
  TMP_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t install-claude-code)"
  # --check 不改动任何东西；已有工具也要能被找到
  path_has_bin_dir || export PATH="$BIN_DIR:$PATH"
  install_claude
  install_codex
  setup_ssh_key
  setup_agent_sync
  if [ "$WITH_APPS" -eq 1 ]; then install_mac_apps; fi
  print_summary
  return "$FAILED"
}

main "$@"
