#!/usr/bin/env bash
# t-agent:ta
# ta — 统一启动 Claude Code 和 Codex，只需要记一个命令。
#
#   ta [工具] [参数…]        工具：claude（c）或 codex（x）；省略时用默认工具（默认 claude）
#
# 统一的常用参数（写在 -- 之前才会被翻译）：
#   -c, --continue          继续当前目录最近一次会话
#   -p, --prompt 提示词      非交互执行一次并输出结果
#   -m, --model 模型         指定模型
# 其余参数原样透传给底层工具；-- 之后的内容也原样透传（用于两边同名但含义不同的参数，
# 例如 codex 的 -p 是 --profile：ta codex -- -p 名称）。
#
#   --dry-run               只打印将要执行的命令，不执行
#   --set-default 工具       设置默认工具（claude 或 codex）
#   -h, --help              显示帮助
#
# 启动前会先同步远程的用户级规则与默认配置（失败或没有 Python 都不影响启动）。

main() {
  local config_root="${XDG_CONFIG_HOME:-$HOME/.config}/t-agent"
  local default_file="$config_root/default-tool"
  local sync_script="$HOME/.local/share/t-agent/agent-sync.py"
  local tool="" dry=0 cont=0 prompt="" has_prompt=0 model=""
  local -a rest=()

  usage() {
    sed -n '3,/^$/p' "${BASH_SOURCE[0]}" 2>/dev/null | sed 's/^# \{0,1\}//'
  }
  die() { printf 'ta: %s\n' "$*" >&2; exit 2; }

  while [ "${1:-}" = "--dry-run" ]; do dry=1; shift; done
  case "${1:-}" in
    claude|c) tool="claude"; shift ;;
    codex|x) tool="codex"; shift ;;
  esac

  while [ $# -gt 0 ]; do
    case "$1" in
      --) shift; rest+=("$@"); break ;;
      -c|--continue) cont=1 ;;
      -p|--prompt) [ $# -ge 2 ] || die "$1 需要提示词"; prompt="$2"; has_prompt=1; shift ;;
      -m|--model) [ $# -ge 2 ] || die "$1 需要模型名"; model="$2"; shift ;;
      --dry-run) dry=1 ;;
      --set-default)
        case "${2:-}" in
          claude|codex) ;;
          *) die "--set-default 只支持 claude 或 codex" ;;
        esac
        mkdir -p "$config_root" && printf '%s\n' "$2" > "$default_file" && printf '默认工具已设为 %s\n' "$2"
        exit 0 ;;
      -h|--help) usage; exit 0 ;;
      *) rest+=("$1") ;;
    esac
    shift
  done

  if [ -z "$tool" ]; then
    tool="${TA_DEFAULT_TOOL:-}"
    [ -n "$tool" ] || tool="$(head -n1 "$default_file" 2>/dev/null)"
    case "$tool" in claude|codex) ;; *) tool="claude" ;; esac
  fi

  local -a cmd=()
  if [ "$tool" = "claude" ]; then
    cmd=(claude)
    [ "$cont" -eq 1 ] && cmd+=(-c)
    [ -n "$model" ] && cmd+=(--model "$model")
    [ "$has_prompt" -eq 1 ] && cmd+=(-p "$prompt")
    [ ${#rest[@]} -gt 0 ] && cmd+=("${rest[@]}")
  else
    cmd=(codex)
    [ "$has_prompt" -eq 1 ] && cmd+=(exec)
    [ "$cont" -eq 1 ] && cmd+=(resume --last)
    [ -n "$model" ] && cmd+=(-m "$model")
    [ ${#rest[@]} -gt 0 ] && cmd+=("${rest[@]}")
    [ "$has_prompt" -eq 1 ] && cmd+=("$prompt")
  fi

  if [ "$dry" -eq 1 ]; then
    # bash 3.2 的 printf %q 会弄坏中文，这里自己加引号，仅用于显示
    local arg out="" sq="'" rep
    rep="'\\''"
    for arg in "${cmd[@]}"; do
      case "$arg" in
        ''|*[!A-Za-z0-9_./:=@%+,-]*) out="$out '${arg//$sq/$rep}'" ;;
        *) out="$out $arg" ;;
      esac
    done
    printf '%s\n' "${out# }"
    exit 0
  fi

  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'ta: 未找到 %s，请先运行安装脚本。\n' "$tool" >&2
    exit 127
  fi
  if [ -f "$sync_script" ] && command -v python3 >/dev/null 2>&1; then
    python3 "$sync_script" "$tool" || true
  fi
  exec "${cmd[@]}"
}

main "$@"
