# T-Agent Browser

A local Manifest V3 bridge from your own T-Agent sessions to tabs in your own Chrome browser. It implements all 25 v1 command methods. Plain JavaScript ES modules, no build step, no remote code, no static content scripts. Requires Chrome 116 or newer (WebSocket activity keeps the service worker alive).

## Load and pair

1. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select this `extensions/chrome` folder.
2. In T-Agent Settings → **Browser extension**, choose **Pair a browser** and copy the one-time code.
3. Open this extension's **Pair / settings** page. Enter the server URL, browser name, and code. Choose **Pair browser**.

The default URL is `http://127.0.0.1:3000`. Only loopback HTTP(S) URLs (`127.0.0.1`, `localhost`, `[::1]`) are accepted. The extension POSTs the exact v1 pairing payload and keeps the returned token in `chrome.storage.local`; it never puts it in a URL or log. Codes are not saved. The options form restores the current URL and name. The server bridge, Settings UI, CLI and site library are separate parts of T-Agent and are not supplied here.

## Tabs and the debugging bar

The agent can use only tabs opened by this extension in a group titled **T-Agent**, or tabs you explicitly hand over using **Let T-Agent use this tab** in the popup. Other tabs return `TAB_NOT_ALLOWED`, including unrelated tabs manually added to a similarly named group. **Take back** immediately stops capture and recording and releases the tab. Closing a handed tab through the agent releases it without closing your page. Handed tabs show `ON`; recording tabs show `REC`.

Chrome internal pages, extension pages, DevTools and the Chrome Web Store are never scriptable. Version 1 supports HTTP(S) pages only. File URLs and other schemes return `TAB_NOT_SCRIPTABLE`.

Capture and recording use Chrome's debugger API and show Chrome's yellow debugging bar. Opening DevTools may displace capture. Choosing Cancel on the bar stops capture and emits `record.stopped` for a recording. A debugger already owned by DevTools or another extension returns `DEBUGGER_BUSY`. Full-page/element screenshots and network-idle waits are short captures: they attach only for the operation, then detach unless an explicit capture or recording still needs the connection. Visible screenshots use `captureVisibleTab` and require an active tab; an active-tab change discards the result.

Tab IDs and handover state survive service-worker restarts through `chrome.storage.session`, not a full Chrome session restart. Removing a tab from the T-Agent group, renaming its group, closing it or taking it back removes capture access. Merely navigating to another HTTP(S) origin does not stop a recording.

## Privacy and redaction

Redaction runs before results or events leave the extension. Sensitive header names, URL parameters, recursive JSON/form keys, JWT-like values and bearer headers follow contract section 5. Reapplying redaction preserves `<redacted:N>` lengths. Duplicate query/form keys are retained. Text bodies are redacted before being cut, so a truncated JSON document cannot reveal a partial secret. Password input values are omitted from snapshots and recording fields, including HTML snapshots. Sensitive non-password form values are masked using name, id and autocomplete.

Only **`net.get` with `raw:true`** bypasses redaction for that answer. Raw capture buffers exist only in worker memory; they are not written to extension storage or recording events. `page.fetch` remains redacted even with `raw:true`, following the contract's explicit “only net.get” rule. Screenshots are images of the page; redaction does not inspect image pixels. Arbitrary page text is not semantically classified as a secret: the specified key, JWT and bearer rules apply.

The shared server vector file did not exist at implementation time. `redact-vectors.json` supplies local vectors for reconciliation with `test/fixtures/browser-redact-vectors.json` when core supplies it.

## Command details left open by v1

- Tab fallback uses the last tab used by a command, otherwise the active allowed tab in the last focused window. Explicit tab IDs are always checked. Open defaults to inactive. A person-created tab cannot become agent-owned merely by joining the group.
- Outline elements also include a stable `selector`. Refs belong to one document and last snapshot; queries add refs without resetting existing ones. Snapshot text/HTML defaults to 200,000 bytes, capped at 1 MiB. Truncated eval values are a UTF-8 prefix of their JSON representation, returned as a string with `truncated:true`. Non-serializable evaluations return `EVAL_FAILED`. `await_promise:false` serializes an unresolved Promise as an object without waiting. A page CSP may reject `eval` in the MAIN world; that is reported as `EVAL_FAILED`, not bypassed. With capture active, evaluation uses CDP.
- Input without capture uses native setters and synthetic DOM events, which update controlled inputs. Such events have `isTrusted:false`. Keyboard fallback covers text editing, basic caret movement, select-all, Tab and form Enter; browser-reserved shortcuts depend on Chrome. With capture active, mouse/keyboard use CDP and text uses `Input.insertText`. Select changes use native DOM options plus input/change events.
- Only the top-level document is targeted; iframe and shadow-root traversal are not part of this version. Target text matches the first visible exact text, preferring the deepest matching element. Hidden, disabled, read-only text inputs and stale refs return explicit errors.
- `net.start` and `record.start` share one attachment. `net.stop` releases the manual capture claim; a recording retains the attachment. `record.stop` retains an explicit manual capture. Full detach discards the in-memory request and console buffers; list/get after detach return `NOT_CAPTURING`. `debug.detach` stops both. Repeating `net.start` updates capture options. A second recording on the same tab returns `BAD_PARAMS`.
- Capture keeps at most 2,000 requests and 2,000 console entries per tab, 1,000 frames per WebSocket, and about 32 MiB of request/response text bodies (raw plus separately redacted representations add overhead). Old bodies may be dropped with truncation flags. Per-body limits default to and are capped at 2 MiB. Binary bodies use base64. Missing CDP bodies are omitted. Redirects share CDP's request ID; recording emits the previous response before replacement. Network-idle waits include all HTTP requests, even those excluded by the capture filter, and do not wait for open WebSockets.
- Recording `dom:false` disables mutation summaries; click, input, change, submit and selected keys remain enabled. `network:false` suppresses request/response/WebSocket recording items; Runtime console collection continues. Mutations are aggregated every 500 ms. Top-level tab URL changes record full navigation and SPA history changes; a page-side poll also invalidates refs after SPA URL changes. New documents receive recorder listeners on load completion. Events during the gap before listener installation cannot be recorded. Record batches flush at one second, 200 items, or the wire byte budget. Sequence numbers are per recording across navigation.
- Revocation (4401) persists “needs pairing” and suppresses both backoff and alarm reconnects until pairing changes. Other close codes use the specified 1/2/5/10/30-second backoff. A minute alarm retries disconnected workers. Commands have bounded response deadlines; Chrome operations already dispatched cannot always be canceled after a timeout. Disconnected recording batches are not replayed; use recording while T-Agent is connected.
- Results larger than the 32 MiB wire limit shorten large string fields and set `truncated:true`. Binary screenshot truncation may make an oversized image undecodable; request an element or JPEG image instead.

## Tests

From the repository root, using the repository's existing Playwright/Chromium and `ws` dependencies:

```sh
node --test extensions/chrome/test/redact.test.cjs extensions/chrome/test/page.test.cjs extensions/chrome/test/worker.test.cjs
node --test extensions/chrome/test/extension.test.cjs
```

The first command is network-free. It tests redaction, native page input and password exclusion, worker protocol and tab scope, recording order, raw-answer boundaries and debugger cleanup using in-process API fixtures. The second launches an unpacked extension in a fresh temporary headless Chromium profile and uses only a local HTTP/WebSocket fixture. It covers tab scope, snapshots and refs, controlled inputs, MAIN eval, page fetch, network redaction and short recordings through navigation. It does not access the real T-Agent server or real user configuration directories. Temporary profiles, servers and browsers are cleaned up. No background service or visible window is left running; no full-screen screenshot is taken.

Implementation verification: the network-free command passed 19 tests. The headless command was attempted but stopped before browser launch because this execution environment denies local listening (`listen EPERM`, `127.0.0.1`). Its browser assertions remain unverified and must run in an environment that permits the local fixture listener. No full repository test suite was run.
