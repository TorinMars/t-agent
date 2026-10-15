#!/usr/bin/env bash
# t-agent:ta
# ta — start Claude Code and Codex in a unified way, so you only need to remember one command.
#
# ta [tool] [args…]        tool: claude (c) or codex (x); defaults to the default tool when omitted (claude by default)
#
# Unified common options (only translated when written before --):
# -c, --continue          resume the latest session in the current directory
# -p, --prompt PROMPT     run once non-interactively and print the result
# -m, --model MODEL       choose the model
# All other arguments are passed through to the underlying tool unchanged; what follows -- is also passed through unchanged (for arguments with the same name but different meaning on the two sides,
# for example codex's -p is --profile: ta codex -- -p NAME).
#
# --dry-run               only print the command that would run; do not run it
# --set-default TOOL      set the default tool (claude or codex)
# -h, --help              show this help
#
# The remote user-level rules and default config are synced before starting (a failure or a missing Python does not block starting).

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
      -p|--prompt) [ $# -ge 2 ] || die "$1 needs a prompt"; prompt="$2"; has_prompt=1; shift ;;
      -m|--model) [ $# -ge 2 ] || die "$1 needs a model name"; model="$2"; shift ;;
      --dry-run) dry=1 ;;
      --set-default)
        case "${2:-}" in
          claude|codex) ;;
          *) die "--set-default only supports claude or codex" ;;
        esac
        mkdir -p "$config_root" && printf '%s\n' "$2" > "$default_file" && printf 'Default tool set to %s\n' "$2"
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
    # bash 3.2's printf %q mangles CJK text, so quotes are added by hand here, for display only
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
    printf 'ta: %s not found; run the install script first.\n' "$tool" >&2
    exit 127
  fi
  if [ -f "$sync_script" ] && command -v python3 >/dev/null 2>&1; then
    python3 "$sync_script" "$tool" || true
  fi
  exec "${cmd[@]}"
}

main "$@"
