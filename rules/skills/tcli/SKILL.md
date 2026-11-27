---
name: tcli
description: The tcli command of T-Agent. Use it to manage files in the user's object storage (OSS bucket) - upload, download, list, copy, move or delete files, share a file by link, put an image or a build somewhere reachable on the web - and to drive the user's own Chrome through the T-Agent browser extension - open and read web pages, click and type, take screenshots, inspect network requests and record how a site works, with the user's logged-in sessions - and to message the user on Telegram or email.
---

# tcli

`tcli` is the command line of T-Agent, the service that runs this terminal. Its command groups:

- `oss`: files in the object storage bucket that the user set up in T-Agent (Settings → Tasks and files → Image and file upload).
- `browser`: the user's Chrome on this computer, through the T-Agent browser extension (Settings → Tasks and files → Browser extension). See "Browser" below.
- `notify`: a short message to the user on the notifiers they set up in T-Attention (Telegram, email, a bubble beside the Mac desktop window). See "Notify the user" below.
- `attention`: the user's T-Attention task list. `tcli attention <command>` is the `t-attention` command with the same commands, options, output and exit codes (add, list, tree, show, update, review, wait, move, schedules, `run-now`, `preview` ...). Follow the t-attention skill for when and how to use it; `tcli attention help` lists everything.

More groups may come later; `tcli help` lists what this version has.

The bucket and its access key belong to T-Agent. The command asks the T-Agent server to do the work, so you never see or need the secret. Do not look for it.

Talk to the user in the user's language.

## The command

In this file `tcli` stands for this command. Use it exactly like this in every shell call, with the quotes:

```bash
${TA_TCLI:+node} "${TA_TCLI:-tcli}" help
```

- Inside a T-Agent terminal `TA_TCLI` is set to the script of this install and the command works with no setup.
- Elsewhere the part after `:-` is the path written when T-Agent installed this skill (or `tcli` on PATH). Outside a T-Agent terminal the server usually refuses the call with exit code `2`: then tell the user that tcli only works in a T-Agent terminal.
- Shell variables do not survive between your tool calls, so write the full command each time.
- `127` means the command was not found: say so once and do not guess other paths.

## Keys

A key is the name of an object, relative to the root of the bucket, with `/` between folder names: `agent/2026-11-12/report.pdf`. No leading `/`. A "folder" is only a key prefix that ends with `/`.

The "Object path prefix" in the upload settings is used by the page for its own uploads (pictures pasted into a terminal). tcli keys do not add it: write the full key.

## Commands

### List: `oss ls`

```bash
${TA_TCLI:+node} "${TA_TCLI:-tcli}" oss ls                      # the top level of the bucket
${TA_TCLI:+node} "${TA_TCLI:-tcli}" oss ls agent/               # one folder
${TA_TCLI:+node} "${TA_TCLI:-tcli}" oss ls agent/ --recursive   # everything under it
${TA_TCLI:+node} "${TA_TCLI:-tcli}" oss ls agent/ --recursive --max 50 --json
```

- Without `--recursive` you see the objects and the sub-folders of one level.
- `--max N` stops after N entries; `--all` goes on past the first page until everything is listed. Use `--all` only when you really need every entry: a bucket can hold very many.
- `--json` when you need to read sizes, dates or keys in a script.

### Look at one object: `oss stat`

```bash
${TA_TCLI:+node} "${TA_TCLI:-tcli}" oss stat agent/2026-11-12/report.pdf
```

Prints what the bucket knows about the object (such as its size, type and last change). Exit code `3` means there is no such object. Use it to check that a key is free before you upload, and to check an object before you change it.

### Download: `oss get`

```bash
${TA_TCLI:+node} "${TA_TCLI:-tcli}" oss get agent/2026-11-12/report.pdf -o ./report.pdf
${TA_TCLI:+node} "${TA_TCLI:-tcli}" oss get notes/todo.md -o -       # print to standard output
```

- `-o <file>` writes to that file; `-o -` prints the content. Always give one of them. Print only text, and only small files.
- An existing local file is not overwritten unless you add `--force`. Use `--force` only for a file you made yourself in this conversation, or when the user said so.

### Upload: `oss put`

```bash
${TA_TCLI:+node} "${TA_TCLI:-tcli}" oss put ./chart.png agent/2026-11-12/chart.png
${TA_TCLI:+node} "${TA_TCLI:-tcli}" oss put ./chart.png --prefix agent/2026-11-12/    # key = prefix + file name
${TA_TCLI:+node} "${TA_TCLI:-tcli}" oss put ./data.csv exports/data.csv --content-type text/csv
```

- It prints the key and a URL. Give the user both.
- Without a key, the file name is used (after `--prefix` when given).
- `--content-type` sets the type when the file extension does not say it well.
- If the key exists, `put` replaces that object. See "Safe practice" below.

### Copy and move: `oss cp`, `oss mv`

```bash
${TA_TCLI:+node} "${TA_TCLI:-tcli}" oss cp agent/2026-11-12/chart.png shared/chart.png
${TA_TCLI:+node} "${TA_TCLI:-tcli}" oss mv drafts/plan.md archive/2026/plan.md
```

Both work inside the bucket, from key to key. If the target key exists it is replaced. `mv` removes the source.

### Delete: `oss rm`

```bash
${TA_TCLI:+node} "${TA_TCLI:-tcli}" oss rm agent/2026-11-12/old.png agent/2026-11-12/old2.png --yes
```

Takes one or more keys. Without `--yes` nothing is deleted. A deleted object cannot be brought back.

### A link to share: `oss url`

```bash
${TA_TCLI:+node} "${TA_TCLI:-tcli}" oss url agent/2026-11-12/report.pdf
${TA_TCLI:+node} "${TA_TCLI:-tcli}" oss url agent/2026-11-12/report.pdf --expires 604800   # 7 days
```

Prints a signed link that works without a login until it expires. `--expires` is in seconds, from 60 (one minute) to 604800 (seven days).

### Help

```bash
${TA_TCLI:+node} "${TA_TCLI:-tcli}" help
```

## Which link to give

- The URL that `put` prints works at once. When the user set a "Public HTTPS address" in the upload settings it is a plain public address that keeps working; otherwise it is a signed link (with `Expires` and `Signature` in it) that stops working after some time.
- Use `oss url` when the user wants a link that works for a set time, when the bucket is private, or when an old link has expired. Say when it expires.
- Most buckets are private. Do not build links yourself from the bucket name or region: they will not work for a private bucket. Use the URL the command prints.
- Anyone who has a link can open the file. Ask before you share links to private or sensitive files outside this conversation.

## Safe practice

These rules are strict. "Confirmation" means the user said yes in this conversation to this exact change, after you showed them the keys.

1. **Never delete without confirmation.** Before `oss rm`, list the keys you want to delete and ask. Then run `rm` with exactly those keys and `--yes`. Never delete a whole prefix because it "looks like" old files.
2. **Never overwrite without confirmation.** Before `oss put`, `oss cp` or `oss mv` to a key, check it with `oss stat`. Exit code `3` (not found) means the key is free. If it exists, ask the user, or choose a new key.
3. **Never move without confirmation.** `mv` changes where other people and pages find a file, and old links stop working. Ask first, even when the target key is free. Copying (`cp`) to a free key is safe.
4. **New uploads go to a new, dated key** unless the user named a key: `agent/<YYYY-MM-DD>/<file name>`, for example `agent/2026-11-12/chart.png`. Take the date from `date +%F`. Use simple file names: letters, digits, `-`, `_`, `.`.
5. **Read and list freely.** `ls`, `stat`, `get` and `url` change nothing in the bucket.
6. **Never try to read T-Agent's configuration or credentials**: not its data folder, not its database, not environment variables of the server, not the OSS console. If a command fails, report the error; do not work around it with other tools or another access key.
7. Do not upload secrets, keys, `.env` files or private data unless the user asked for that exact file.

## Large files

- Uploads and downloads go through the T-Agent server and can take a while. Tell the user before you move a large file (over about 100 MB), and run one big transfer at a time.
- For a whole folder, upload the files one by one into one dated prefix, or pack them first (`tar -czf site.tar.gz site/`) and upload the archive. Say how many files you uploaded.
- Do not print a large or binary file to standard output; write it with `-o <file>`.

## Notify the user

`tcli notify` sends the user a short message on every notifier they set up in T-Attention that takes messages (Telegram, email, `widget`: a bubble beside the T-Attention desktop window on the user's Mac; a click on it opens the link). T-Agent adds which task and terminal it came from, and a link to the page.

```bash
${TA_TCLI:+node} "${TA_TCLI:-tcli}" notify "The release build finished: 412 tests pass. Nothing else needs you."
${TA_TCLI:+node} "${TA_TCLI:-tcli}" notify --title "Decision needed" "Keep the old API or remove it? I stopped until you answer."
${TA_TCLI:+node} "${TA_TCLI:-tcli}" notify --via telegram --file ./summary.md
${TA_TCLI:+node} "${TA_TCLI:-tcli}" notify status
```

- When: a long task finished or failed while the user may be away, or you need a decision and cannot go on. Not for every step, and at most a few messages per task.
- Keep it short (at most 3000 characters, title at most 200): say what happened and what you need from the user. `--link URL` adds a link, `-` reads the text from standard input.
- Each notifier prints one line, such as `telegram  sent`, `telegram  relayed through T01 (sent)` or `widget  sent`. `--via` takes `telegram`, `email` and `widget`; the bubble is only shown while the desktop window runs on that Mac (else `widget  skipped: not set up`).
- Never put secrets, tokens, passwords or private data in a message.
- Quiet hours, the hourly limit and the switch "Let agent sessions send messages (tcli notify)" are the user's choice. When a message is skipped, do not try again, reword it or use another way to get around them; tell the user in the conversation instead.

Exit codes: `0` sent on at least one notifier; `1` everything was skipped (quiet hours, the same message within a minute, the hourly limit), nothing is set up (`NOTIFY_NOT_CONFIGURED`: tell the user to set up Telegram or email in Settings → T-Attention), or wrong usage; `2` not in a T-Agent terminal, or the user turned agent messages off (`NOTIFY_AGENT_ACCESS_OFF`: do not ask them to turn it on just for you); `4` the server, the network or every notifier failed (do not repeat it more than once).

## Browser

`tcli browser` drives Chrome on the computer that runs T-Agent, through the T-Agent extension. It is the user's real browser, logged in to their accounts: what you do there, you do as the user. `tcli browser help` lists every option.

Before the first command, check the connection:

```bash
${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser status
```

Exit `4` with "No browser is connected": tell the user to pair Chrome in T-Agent (Settings → Tasks and files → Browser extension), or to open Chrome if it is paired but offline. Do not try to start a browser yourself.

### The tab rule

The extension may only use two kinds of tabs:

- tabs T-Agent opened itself (`browser open`), kept in a Chrome tab group named "T-Agent";
- tabs the user handed over with the extension button ("Let T-Agent use this tab"). The user can take them back at any time.

Every other tab answers `TAB_NOT_ALLOWED` (exit `2`); `chrome://` pages, the Chrome Web Store and other extension pages answer `TAB_NOT_SCRIPTABLE`. Do not try to get around this. If you need a page the user has open, ask them to hand that tab over, or open the same address in a new tab. `close` on a handed tab only releases it; it is never closed.

`--tab T` picks a tab by its number from `browser tabs`. Without it, a command uses the tab the last command used, else the active T-Agent tab.

### Your tabs and the user's focus

- `browser open` puts the tab into T-Agent's own Chrome window, behind the user's windows, in the "T-Agent" group. The user keeps working undisturbed; nothing you do takes their focus.
- No need to activate a tab before `shot`, `snapshot` or any other command: they all work on a tab in the background. Use `activate` (or `open --active`) only when the user asked to see the page.
- Your tabs close by themselves 2 minutes after your turn ends (if you did not use them since), when your terminal closes, or after 30 minutes unused. To leave a page open for the user, open it with `browser open <url> --keep` and tell them it is there (the "T-Agent" group in T-Agent's window).
- A tab the user clicks, types in or brings to the front becomes theirs: it leaves the group, and you can no longer use it (`TAB_NOT_ALLOWED`). Open the page again, or ask them to hand that tab over.
- Page dialogs (alert, confirm, prompt, "leave this page?") are answered for you while network capture, a recording, `shot` or `wait --idle` runs: an alert and "leave" are accepted, a confirm and a prompt are dismissed. Each one is printed as `dialog: confirm "Delete all?" (dismissed)` on stderr. If you needed to agree to a confirm, tell the user and let them do that step.
- Otherwise a dialog blocks the page and commands time out: `browser dialog` says whether one is open, `dialog dismiss` closes it, and `dialog accept --text T` answers a prompt. Accepting a confirm agrees to something for the user: ask them first, as for any change.
- `upload` sends only files the user named or you made for this task; T-Agent refuses credentials (SSH keys, `.env` files) and files over 100 MiB.

### Commands

```bash
${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser tabs                         # tabs you may use (* = active)
${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser open https://example.com     # a new tab in the T-Agent group, in the background (--keep, --active)
${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser go https://example.com/next  # navigate (--tab T, --no-wait)
${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser back                         # also: forward, reload, activate <tab>, close [tab]

${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser snapshot                     # one line per element: e12 button "Sign in"
${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser snapshot --text              # the readable text (--html for HTML)
${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser snapshot --selector main     # only part of the page
${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser snapshot --filter interactive # only what you can click or type in
${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser snapshot --diff              # only what changed since the last snapshot (+ - ~)
${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser query 'table tr' --all       # elements matching a CSS selector

${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser click e12
${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser type e7 'red shoes' --clear --submit
${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser press Enter                  # Tab, Escape, ArrowDown, a (--modifiers Meta)
${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser select e9 large              # also: hover <target>, scroll [--dy 600]
${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser wait --text 'Order placed' --timeout 20000   # or --selector, --url, --idle MS
${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser fill e3=Ann e5='a@b.c' e7=true e9=Large   # several fields at once (or --json '{"e3":"Ann"}')
${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser check e7                     # tick a checkbox or radio (--off to untick)
${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser drag e4 e8                   # drag to an element or to x,y (--steps N)
${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser upload e6 ./report.pdf       # files for a file input (only files the user named)
${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser dialog                       # is an alert / confirm / prompt blocking the page?

${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser eval 'document.title'        # JS in the page (--file f.js)
${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser shot -o page.png             # screenshot (--full for the whole page)
${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser shot --annotate -o refs.png  # the refs of the last snapshot drawn on it
${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser shot --zoom 0,0,400,300 -o zoom.png   # a part of the viewport, enlarged (--scale 3)
${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser console                      # console lines and uncaught errors
${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser console --level error,warn --pattern 'timeout' --since 60000   # last minute's errors
```

A `<target>` is a ref from the last snapshot (`e12`), `css:<selector>`, `text:<visible text>` (the first match) or `x,y` in viewport pixels. Refs are best. The snapshot includes elements inside open shadow DOM and same-origin iframes (marked `(in frame)` / `(in shadow DOM)`), and their refs work like any other.

### How to work on a page

1. `snapshot` to see the page; act on refs (`click e12`, `type e7 ...`).
2. After anything that changes the page (a click that opens a dialog, a navigation, a submit), `snapshot` again (`--diff` shows only what changed). An element keeps its ref while it stays in the page; a navigation starts again at `e1`. `REF_NOT_FOUND` means take a new snapshot.
3. When a page loads content late, `wait` for it (`--text`, `--selector`, `--idle 1000`) instead of sleeping.
4. Prefer `snapshot --text` or `--selector` over `--html`: HTML is large and costs context. `shot` when the layout matters or the user wants to see it.
5. `ELEMENT_NOT_INTERACTABLE`: the element is hidden or covered; scroll to it, close the dialog in front of it, or choose another element.

### Network and recordings: find a site's API

```bash
${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser net start --filter /api/     # capture (a yellow "debugging" bar appears)
${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser net list --type XHR,Fetch    # r7 GET 200 XHR 2.0 KB 31ms https://...
${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser net get r7                   # headers and body of one request
${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser net stop
${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser fetch /api/cart -H 'Accept: application/json'   # fetch inside the page, with its cookies

${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser open https://example.com --record --types XHR,Fetch,Document   # record from the first load
${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser record start                 # clicks, input, navigation, network, DOM changes
${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser record stop
${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser record show rec_...          # what was recorded
${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser record items rec_... -o rec.jsonl   # every item, one JSON per line
```

- To record a page from its first load, open it with `browser open <url> --record`: the recording starts before the page loads, so you do not need to reload (and the first requests are not loaded twice). It prints the tab and the recording id. `record start` on a tab that is already open records from now on (no new window).
- `open --record` opens a new Chrome window in front, just for the recording, because the user usually acts in the page while it records: tell the user it is there and what to do in it. When you record only your own actions, add `--background`: the window opens behind the user's windows. A later `open` without `--record` goes to T-Agent's usual window behind. After the recording, a tab the user used stays theirs; an unused one closes like your other tabs, with its window.
- A recording follows the windows the page opens: popups (sign-in, payment), `target="_blank"` links and new tabs the recorded page opens join the same recording (at most 10 tabs). Each item has `tab`; the first item of an opened tab is `{ "kind": "tab", "action": "opened", "tab", "opener", "url" }`. Its first requests can have `via: "webRequest"` (no bodies). Use `--tab T` with `record items` / `record requests` to read one tab.
- Keep recordings small: `--types XHR,Fetch,Document` keeps request and response bodies only for those resource types (other requests stay in the recording without bodies, `body_omitted: "type"`); add `--drop-other-types` to leave them out; `--max-body N` cuts longer bodies (`body_truncated: true`, `body_bytes` is the size before the cut). The same options work with `open --record`.
- In a recording, the actions of your own commands (click, type, press, select, hover, scroll, go, back, forward, reload, open) have `source: "agent"`; the user's have `source: "user"`. A click or input target has `nearest`: the closest meaningful element around it (`tag`, `role`, `aria_label`, `title`, `alt`, `name`, `text`, `selector`), useful when the click hit an icon. A `dom` item lists in `appeared` the dialogs, alerts, toasts, headings, buttons and links that showed up (texts redacted, at most 20).
- `UNKNOWN_METHOD` "The extension is older than this command" for one of these options: ask the user to reload the T-Agent extension in `chrome://extensions`.

- To learn how a site works, capture or record while you (or the user) do the task once in the page, then read the XHR / Fetch requests: their URLs, methods, parameters and response shapes are the site's API. Then call it with `browser fetch` from the page, which carries the user's cookies, instead of clicking through the page again.
- `DEBUGGER_BUSY` means DevTools is open on that tab; ask the user to close it.
- Recordings are kept in T-Agent for 14 days. `record rm <id> --yes` deletes one (ask first, as for any delete).

### Reading a recording

Do not read a whole recording: it is large (script and image bodies). Ask for the part you need; T-Agent filters it.

```bash
${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser record requests rec_...                    # one line per API call: r7 POST 201 Fetch 1.2 KB 31ms  https://...
${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser record requests rec_... --url /api/ --json # the same, with request and response headers and bodies (JSON lines)
${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser record requests rec_... --status 4xx,5xx   # only the failures
${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser record items rec_... --kind click,input,submit,nav   # the steps
${TA_TCLI:+node} "${TA_TCLI:-tcli}" browser record items rec_... --kind dom,console --limit 50  # what the page showed or complained about
```

- `record requests` puts each request and its response together (method, URL, type, status, timing, headers, bodies; secrets redacted). It leaves out static files (Script, Stylesheet, Image, Font, Media); `--all` keeps them, `--type XHR,Fetch,Document` keeps only those. `(no response)` means the recording ended first; `(request not recorded)` means it started before the recording.
- `record items` filters: `--kind` (`net` = request, response and ws, `tab` = tabs opened and closed), `--type` (resource type), `--source agent|user` (what your commands did, or what the user did), `--tab T` (one tab of the recording), `--url` (text, or `/regex/i`), `--status` (`200`, `4xx`, `400-499`), `--limit N`, `--offset N`. Add `-o file.jsonl` to save instead of print.
- `browser status` prints only the connection; `--verbose` adds the extension's method names and recent tab events.

### Secrets in the browser

- Cookies, `Authorization` headers, tokens, passwords, API keys and similar values are shown as `<redacted:N>` (N is the length) everywhere: in `net`, `fetch` and recordings. That is on purpose.
- `--raw` (on `net get` and `fetch`) shows the real values, to you only; T-Agent never stores them. Use it only when the task cannot be done without the real value, never print raw values back to the user, and never write them into files, notes, code, commits or anything that leaves this conversation.
- Do not type passwords or payment details unless the user gave them to you for this exact step. Never read the browser's saved passwords, and never send the user's data to another site.

### Safe practice in the browser

1. **Ask before anything that changes something for the user**: sending a message or an email, posting, buying, paying, booking, deleting, changing settings or accepting terms. Show what you will do and wait for a yes. Reading and looking around need no confirmation.
2. Stay on the sites the task is about.
3. Close the tabs you opened when you are done (`browser close`); the rest close by themselves after your turn. Open a page with `--keep` only when the user wants to keep it, and say so.
4. When a page shows a login, a CAPTCHA or a two-factor prompt, ask the user to complete it in Chrome (`activate` the tab for them), then go on. Once they have used the tab it is theirs: open the page again in a new tab (the login is shared) or ask them to hand that tab over.

### Browser errors

| Code | Meaning | What to do |
|---|---|---|
| `BROWSER_NOT_CONNECTED` (exit `4`) | No paired Chrome is connected | Ask the user to open Chrome, or to pair it in Settings → Tasks and files → Browser extension. |
| `BROWSER_TIMEOUT` (exit `4`) | The browser did not answer in time | Try once more; pass `--timeout` for slow pages. |
| `TAB_NOT_ALLOWED` (exit `2`) | Not a T-Agent tab | See "The tab rule". |
| `TAB_NOT_FOUND`, `REF_NOT_FOUND`, `ELEMENT_NOT_FOUND`, `REQUEST_NOT_FOUND` (exit `3`) | Gone or stale | `browser tabs` or a new `snapshot`, then try again. |
| `UNKNOWN_METHOD` | The extension is older than this command | Ask the user to update the extension (reload it in `chrome://extensions`). |

## Exit codes and what to tell the user

| Code | Meaning | What to do |
|---|---|---|
| `0` | Done | Report the key and URL, or the result. |
| `1` | Wrong usage, or the server refused the request (a bad key, a file too large) | Read the message; fix the command once. If it still fails, tell the user the message. |
| `2` | Not in a T-Agent terminal, or the user turned agent access off | See below. |
| `3` | No such object | For `stat` before an upload this is the good answer. Otherwise tell the user which key was not found. |
| `4` | The server or the network failed | Try once more. Then tell the user that T-Agent or the storage could not be reached. |

Messages to recognise:

- **`OSS_NOT_CONFIGURED`** (409): image and file upload is not set up. Tell the user: "Set it up in T-Agent: Settings → Tasks and files → Image and file upload." Do not ask them for keys.
- **`OSS_AGENT_ACCESS_OFF`** (403, exit `2`): the user turned agent access off. Tell the user: "Turn on 'Let agent sessions manage OSS files (tcli)' in Settings → Tasks and files → Image and file upload." Do not try another way.
- Exit `2` without that message: the command did not run in a T-Agent terminal. Ask the user to run the session in a T-Agent terminal.

Never start, stop or restart T-Agent yourself.
