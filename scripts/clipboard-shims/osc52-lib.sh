# Shared code of the T-Agent clipboard shims (pbcopy, xclip, xsel, wl-copy). POSIX sh, sourced, not run.
# TA-CLIPBOARD-SHIM
#
# routes/terminal.js puts this folder first in PATH of every terminal it spawns and sets TA_CLIPBOARD_OSC52=1. A copy made
# by a program in that terminal (`cmd | pbcopy`, Neovim's "+ register, Claude Code's copy) is then sent to the browser as
# OSC 52 (ESC ] 52 ; c ; <base64> BEL on /dev/tty, or through tmux / GNU screen), and the real command found later in PATH
# still runs so the server clipboard keeps working. Paste / output modes and anything unclear go to the real command
# untouched. See "Clipboard (OSC 52)" in DESIGN.md.
#
# Every shim has the marker line `# TA-CLIPBOARD-SHIM` as its second line: the search for the real command skips any file
# with that marker, so two copies of this folder in PATH (a server started inside a T-Agent terminal) never call each other.

TA_SHIM_LIMIT=65536

ta_shim_dir() {
  CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd -P
}

ta_is_shim() {
  [ "$(sed -n '2{p;q;}' "$1" 2>/dev/null)" = '# TA-CLIPBOARD-SHIM' ]
}

# Prints the first executable `$1` in PATH that is not one of these shims.
ta_find_real() {
  _name=$1
  _self=$(ta_shim_dir)
  _old_ifs=$IFS
  IFS=:
  for _dir in $PATH; do
    IFS=$_old_ifs
    [ -n "$_dir" ] || _dir=.
    _cand=$_dir/$_name
    if [ -f "$_cand" ] && [ -x "$_cand" ]; then
      _real_dir=$(CDPATH= cd -- "$_dir" 2>/dev/null && pwd -P)
      if [ "$_real_dir" != "$_self" ] && ! ta_is_shim "$_cand"; then
        printf '%s\n' "$_cand"
        return 0
      fi
    fi
  done
  IFS=$_old_ifs
  return 1
}

# Hands the call to the real command unchanged (paste, unknown flags, outside a T-Agent terminal).
ta_exec_real() {
  _name=$1
  shift
  _real=$(ta_find_real "$_name") || { printf '%s: command not found\n' "$_name" >&2; exit 127; }
  exec "$_real" "$@"
}

ta_base64() {
  if command -v base64 >/dev/null 2>&1; then
    base64 < "$1" | tr -d '\r\n'
  elif command -v openssl >/dev/null 2>&1; then
    openssl base64 -A < "$1"
  else
    return 1
  fi
}

# Writes to the controlling terminal; silently does nothing when there is none.
ta_tty_write() {
  ( printf '%s' "$1" > /dev/tty ) 2>/dev/null
}

ta_emit_osc52() {
  _file=$1
  _b64=$(ta_base64 "$_file") || return 1
  _esc=$(printf '\033')
  _bel=$(printf '\007')
  if [ -n "$TMUX" ] && command -v tmux >/dev/null 2>&1; then
    # tmux sends the buffer to the outer terminal as OSC 52 when set-clipboard is on or external (the default).
    _mode=$(tmux show-options -gv set-clipboard 2>/dev/null)
    if [ "$_mode" != off ] && tmux load-buffer -w - < "$_file" >/dev/null 2>&1; then
      return 0
    fi
    # Passthrough (needs allow-passthrough on in tmux 3.3+): every ESC inside is doubled.
    ta_tty_write "${_esc}Ptmux;${_esc}${_esc}]52;c;${_b64}${_bel}${_esc}\\"
    return 0
  fi
  if [ -n "$STY" ]; then
    # GNU screen limits the length of a DCS string, so the sequence goes out in chunks of 512.
    _out="${_esc}P${_esc}]52;c;"
    _first=1
    set -f
    for _chunk in $(printf '%s\n' "$_b64" | fold -w 512); do
      if [ "$_first" = 1 ]; then _out=$_out$_chunk; _first=0; else _out="${_out}${_esc}\\${_esc}P${_chunk}"; fi
    done
    set +f
    ta_tty_write "${_out}${_bel}${_esc}\\"
    return 0
  fi
  ta_tty_write "${_esc}]52;c;${_b64}${_bel}"
}

# Copy flow shared by all shims. Arguments: the command name, whether the real command may run (1 / 0), whether
# stdout must echo the input when no real command runs (xclip -filter), then the original arguments. The data is in
# $TA_SHIM_DATA (a temporary file the caller filled).
ta_copy() {
  _name=$1
  _may_run=$2
  _echo=$3
  shift 3
  _status=0
  _size=$(wc -c < "$TA_SHIM_DATA" | tr -d ' ')
  if [ "$_size" -gt "$TA_SHIM_LIMIT" ]; then
    printf '%s: %s bytes is over the 64 KiB limit of the browser clipboard; not sent to the browser\n' "$_name" "$_size" >&2
    _status=1
  elif [ "$_size" -gt 0 ]; then
    ta_emit_osc52 "$TA_SHIM_DATA"
  fi
  _ran=0
  if [ "$_may_run" = 1 ] && _real=$(ta_find_real "$_name"); then
    "$_real" "$@" < "$TA_SHIM_DATA"
    _ran=1
  fi
  if [ "$_ran" = 0 ] && [ "$_echo" = 1 ]; then
    cat "$TA_SHIM_DATA"
  fi
  rm -f "$TA_SHIM_DATA"
  exit "$_status"
}

ta_tempfile() {
  TA_SHIM_DATA=$(mktemp "${TMPDIR:-/tmp}/ta-clip.XXXXXX") || exit 1
  trap 'rm -f "$TA_SHIM_DATA"' EXIT HUP INT TERM
}

# Drops one trailing newline of the data file (xclip -rmlastnl, wl-copy -n).
ta_trim_newline() {
  _size=$(wc -c < "$1" | tr -d ' ')
  [ "$_size" -gt 0 ] || return 0
  [ "$(tail -c 1 "$1" | od -An -c | tr -d ' ')" = '\n' ] || return 0
  head -c "$((_size - 1))" "$1" > "$1.trim" && mv -f "$1.trim" "$1"
}

# Text targets / MIME types; anything else (image/png ...) is not sent to the browser.
ta_text_type() {
  case $1 in
    ''|text/*|UTF8_STRING|STRING|TEXT|COMPOUND_TEXT) return 0 ;;
    *) return 1 ;;
  esac
}

# Leaves a copy invocation that turned out not to be one: the real command gets the original arguments and stdin.
ta_pass() {
  rm -f "$TA_SHIM_DATA"
  trap - EXIT HUP INT TERM
  ta_exec_real "$@"
}
