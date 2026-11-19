# Shared code of the T-Agent link shims (open, xdg-open, ta-browser). POSIX sh, sourced after osc52-lib.sh, not run.
# TA-CLIPBOARD-SHIM
#
# A program in a T-Agent terminal that opens a web link (Claude Code runs `open <url>` / `$BROWSER <url>`, a Linux program
# `xdg-open <url>`) used to open it in the browser of the engine machine. These shims hand a clear web link to this engine's
# T-Agent server instead (POST /api/tcli/open-link with the terminal's hook token, routes/open-link.js), which shows it on the
# page that shows this terminal. When no page takes it (nobody looks at the terminal, the server refuses it, no curl), the
# real command found later in PATH runs as before. Anything that is not exactly one http(s) URL goes to the real command
# untouched. See "Links opened by programs" in docs/design/terminals.md and docs/design/open-links.md.

TA_LINK_LIMIT=4096

# Whether the one argument is a web link this terminal may hand to the page: inside a T-Agent terminal (the markers and the hook
# variables are set), http:// or https://, at most TA_LINK_LIMIT characters, printable ASCII only (no space, quote or backslash,
# so it goes into the JSON body and the curl config as it is). The server checks it again.
ta_link_candidate() {
  [ "$TA_CLIPBOARD_OSC52" = 1 ] && [ -n "$TA_HOOK_URL" ] && [ -n "$TA_HOOK_TOKEN" ] || return 1
  case $1 in
    http://?*|https://?*) ;;
    *) return 1 ;;
  esac
  [ "${#1}" -le "$TA_LINK_LIMIT" ] || return 1
  case $1 in *'
'*) return 1 ;; esac
  [ -z "$(printf '%s' "$1" | LC_ALL=C tr -d '\041\043-\133\135-\176')" ]
}

# Hands the link to the T-Agent server of this engine. Succeeds only when a page showing this terminal took it.
# The token goes to curl in a config read from stdin (-K -), so it never shows in the process list; -q skips ~/.curlrc and
# --noproxy keeps the loopback call away from any proxy of the environment.
ta_link_deliver() {
  command -v curl >/dev/null 2>&1 || return 1
  _origin=$(printf '%s' "$TA_HOOK_URL" | sed -n 's#^\(http://[^/?]*\).*#\1#p')
  [ -n "$_origin" ] || return 1
  _task=
  _term=
  _rest=${TA_HOOK_URL#*\?}
  while [ -n "$_rest" ]; do
    _pair=${_rest%%&*}
    case $_pair in
      task=*) _task=${_pair#task=} ;;
      terminal=*) _term=${_pair#terminal=} ;;
    esac
    [ "$_rest" != "$_pair" ] || break
    _rest=${_rest#*&}
  done
  case $_task in ''|*[!0-9]*) return 1 ;; esac
  case $_term in ''|*[!A-Za-z0-9_-]*) return 1 ;; esac
  _answer=$(printf 'header = "X-T-Agent-Token: %s"\n' "$TA_HOOK_TOKEN" | curl -q -s -m 6 --noproxy '*' -K - -X POST \
    -H "X-T-Agent-Task: $_task" -H "X-T-Agent-Terminal: $_term" -H 'Content-Type: application/json' \
    --data-binary "{\"url\":\"$1\"}" "$_origin/api/tcli/open-link" 2>/dev/null) || return 1
  case $_answer in
    *'"delivered":true'*) return 0 ;;
  esac
  return 1
}

# open / xdg-open: exactly one web link goes to the page; everything else, and a link no page took, runs the real command.
ta_open_link() {
  _name=$1
  shift
  if [ "$#" = 1 ] && ta_link_candidate "$1" && ta_link_deliver "$1"; then
    exit 0
  fi
  ta_exec_real "$_name" "$@"
}
