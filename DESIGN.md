# Personal Home Page Design Document

> Date: 2026-07-15

> v2.84.15 Agent chat icons: the attach, microphone and send icons are sized in CSS too (`.agent-chat svg:not(.agent-logo)`, 18px; the rules for the stop button and the chevrons are later in the file and still win). On an iPhone (WebKit) they were drawn as specks inside their 36px buttons while the chevrons, which already had a CSS size, were fine, so the width / height attributes alone were not enough there. Chromium always drew them at 18px, so the cause is inferred, not reproduced: Playwright has no WebKit for this macOS. Regression: `scripts/test-agent-chat-browser.cjs` (18px in Chromium).
> v2.84.14 Phone voice input looks and works like a chat app's hold-to-talk screen. Pressing the 🎤 button dims the page and shows a green bubble with a live level meter (`public/js/voice-overlay.js`, styles `.vo-*` in `h5.css`) and three zones: the bottom arc "Release to send" (default), a left "Cancel" pill and a right "Convert to Text" pill. Sliding the finger onto a pill picks what letting go does (`zoneAt`, the pills react 28px outside their edges): over the arc the recognition ends and the text is translated and sent at once (`onSend` submits the translate form), over Convert to Text it only fills the Chinese input box (the behaviour before), over Cancel the recognition is thrown away and the box is as before. A press shorter than 350 ms is a tap and is cancelled. The meter is the RMS of the audio blocks the microphone already delivers, nothing extra is recorded. The desktop button is unchanged. Regression: `test/speech.test.js` (the three zones with a fake overlay); the overlay was also rendered in Chromium at phone size. Not tried with a real microphone or finger.
> v2.84.13 Agent chat footer: the plan usage (`5h 98% · 3h  7d 96% · 6.7d`) is its own row directly below the input box, above the footer row that holds the access level on the left and the model and the context ring on the right (before, it shared the right side with the model and wrapped beside it on a phone). `Limits` moved out of `.ac-status` in `scripts/agent-chat/ui.jsx`; `public/js/agent-chat-ui.js` was rebuilt. Applies to the phone and the desktop page. Regression: `scripts/test-agent-chat-browser.cjs`.
> v2.84.12 Phone task sheet: a terminal and an agent chat are never both highlighted. While a chat is open its row is the current one and the terminal row is not (before, the terminal the task had selected stayed highlighted under the chat); going back to a terminal highlights that terminal and clears the chat row. The sheet is redrawn as soon as a chat opens or closes. Regression: `scripts/test-h5-browser.cjs`.
> v2.84.11 Phone task sheet: each agent chat row has the same `⋯` button as a terminal row, which opens the same bottom sheet with the actions of a chat: Rename (`PATCH …/agent/conversations/:cid { title }`), Open and Delete (`DELETE …/agent/conversations/:cid`, after a confirmation; if that chat is open it is closed first). Both calls are proxied for remote Engines already. The rename the title menu used to offer is back this way. Regression: `scripts/test-h5-browser.cjs` (rename, declined and confirmed delete).
> v2.84.10 Codex warnings in the chat (for example "Under-development features enabled…") are left-aligned with an orange bar at the left instead of centred like a plain notice. The Codex adapter marks them `level: 'warn'` (the item keeps `kind: 'notice'`, so history and older pages are unaffected), `toMessages` passes the level on and `Notice` uses the class `ac-warn`. `public/js/agent-chat-ui.js` was rebuilt with `npm run build:agent-chat`. Regression: `test/agent-chat-view.test.js`.
> v2.84.9 Phone agent chat: the `←` close button added in v2.84.8 is gone, so a chat looks like a terminal (page header on top, nothing else). A chat is left by going to a terminal (a terminal row in the task sheet, a new terminal or a restart): that closes the chat the way the old back arrow did (the open flag is cleared) and the chat stays listed in the task sheet to be opened again. The task sheet and the settings sheet now sit above the chat (`z-index` 109 over 108), so the ☰ and ⚙ buttons of the page header work while a chat is open. Regression: `scripts/test-h5-browser.cjs`. Not tried on a real phone.
> v2.84.8 Phone agent chat: the chat no longer has its own header (back arrow, agent icon, title menu). The page header (task name and settings) stays on top as in the terminal and the chat starts right below it (`fitAgentView`); a `←` button at the left of that header (`#h5-close-chat`, shown only while a chat is open) closes the chat. Renaming a chat from the phone page is gone with the title menu. Regression: `scripts/test-h5-browser.cjs`. Not tried on a real phone.
> v2.84.6 Phone settings: the ↻ button checks for an update and, when a newer version exists, starts the update at once (`POST /api/system/apply-update`), without the earlier "Update and restart" confirmation; only the update administrator can run it, and the page reloads when the PC service is back. Because the PC service restarts, terminals running on it are interrupted. Regression: `scripts/test-h5-browser.cjs`.
> v2.84.5 Phone voice input is hold to speak: pressing the microphone next to the Chinese input box starts recording at once (inside the touch, so iOS lets the audio context run) and releasing it ends the recognition and keeps the text; a press shorter than 350 ms is a tap and is discarded; keyboard Enter/Space still toggles. The desktop button is still click to start / click to stop (`hold` option of `VoiceInput.attach`). Regression: `test/speech.test.js`. Not tried on a real phone.
> v2.84.4 Pasting an image on the phone page: a paste event with an image on the terminal input (long-press paste) and the Paste key (it reads the clipboard with `navigator.clipboard.read()` first) now upload the image to OSS like the Image key and type the link with a trailing space and no Enter; text pastes are unchanged. Regression: `scripts/test-h5-browser.cjs` (paste event with an image file). The Paste key needs a secure context and clipboard permission; a real phone was not tried.
> v2.82.1 Voice input on the phone page: the microphone button on `/h5` failed because the token request used the global `API` helper, which only `app.js` (desktop page) defines. `voice-input.js` now makes the token request with its own `fetch`; the settings dialog still uses `API` and `Modal` because it exists on the desktop page only. Regression: `test/speech.test.js` runs the script on a page without `API` and `Modal`. Verified in a real Chromium on `/h5` with a fake microphone; a real phone was not tried.

> v2.82.0 Voice input: a 🎤 button next to the Chinese input box (desktop and `/h5`) fills the box with live speech recognition. The browser captures the microphone with an `AudioWorklet`, resamples it to 16 kHz mono 16-bit PCM (`createResampler` in `public/js/voice-input.js`) and sends 100 ms frames over its own WebSocket straight to Alibaba Cloud Model Studio Fun-ASR (`wss://dashscope.aliyuncs.com/api-ws/v1/inference`, Singapore `dashscope-intl`), speaking the documented task protocol itself (`run-task` → `task-started` → audio → `finish-task` → `task-finished`; `result-generated` with `sentence_end` false is the live text, true is the finished sentence; heartbeats are ignored). No audio passes through the Client server, which was a requirement (bandwidth). A browser WebSocket cannot set an `Authorization` header, so the server mints a temporary token (`POST /api/speech/token` → `POST https://<host>/api/v1/tokens?expire_in_seconds=60` with the real key) and the browser puts it in `?api_key=`; both facts were checked against the real service (the plain key and the temporary token both open the connection with the query parameter, `api-key=`, `token=` and a subprotocol do not). The real key never reaches the browser. The configuration (key, region, endpoint, model, language) is stored encrypted per user in `system_state` under `speech:<owner>` (`services/speech.js`, `routes/speech.js`: `GET/PUT/DELETE /api/speech/config`); an empty key on save keeps the stored key, a blank endpoint means the region default and the dialog shows the address really in effect; `DASHSCOPE_API_KEY` is the fallback when no key is saved. The token is fetched after the microphone permission is granted (it lives one minute); audio produced before `task-started` is buffered (at most 10 s); a recording ends after 5 minutes, 8 s after `finish-task` without an answer the session fails, and 10 s after the click the text recognized so far is kept. The microphone needs a secure context (HTTPS or localhost). Tests: `test/speech.test.js` (service, routes, resampler, the protocol against a fake socket). Known limitations: audio is sent to Alibaba Cloud; a temporary token is not limited to one model; browsers cannot show the HTTP status of a refused WebSocket handshake, so such a failure is reported generically (the token request itself reports 401/403 clearly); no hotwords (`vocabulary_id`) or sensitive-word filter yet; Safari/iOS was not tried on a real device.

> v2.83.0 Phone and desktop share the task's terminals and each terminal has one attached client at a time: a second client gets "This terminal is in use on another device" with a button to take it over (see "Single-owner terminals"). The phone-only `h5-` shells and the `surface` parameter are gone.

> v2.65.0 Phone page `/h5`, separate from the desktop page `/web`: see "Phone page (/h5)" at the end of this document. Phone and desktop share the task's terminals, and each terminal has one attached client at a time (see "Single-owner terminals").

> v2.45.0 Agent config: the main navigation gained an "Agent config" page for several servers. The Client stores the global default and the per-server overrides in `system_state` (`agent-config:<owner>`; a key present in an override, including an empty string, wins over the default, and an empty string means that server is left alone). The field table is `SCHEMA` in `services/agent-config.js`; values are always strings and are validated as enum / number / list. `POST /api/agent-config/push` writes files directly on this machine and calls `PUT /v1/agent-config` (`engine:admin`, capability `agent-config:manage`) on remote Engines. A write only changes the keys that were filled in: Claude uses recursive JSON value setting, Codex uses single-line TOML key/value editing (comments and other tables are kept, and top-level keys are written before the first table); nothing is written when the config file is invalid. The local override file is also written, so it is not overwritten by the remote defaults from `agent-sync.py`.

> v2.54.0 Access mode: a fresh install lets the user choose, the first time the page is opened on this machine, "Authenticator + allow external access (remote)" or "Local access only, no verification (local)", and Settings → Access mode can switch it at any time. `services/client-auth.js` gained the `client_access_mode` table and `accessMode()` (saved choice > already bound counts as remote > initial `ACCESS_MODE` > `unset`), `setAccessMode()` and `ready(session)` (pages / endpoints use it to decide "must bind / must log in"; local needs no binding); under local, `authenticated()` only recognizes `session.localTrusted`, that mark is void after switching back to remote, and the 30-second sweep of `sessionActive()` disconnects the existing terminals. `lib/access-gate.js` sits after the session and before the login gate: local / unset only let direct local access through (reusing `isLocalInitialization`: loopback address + loopback Host + no forwarding headers) and answer 404 to everything else (including `/v1`, `/share` and WebSocket upgrades), and under local it marks local sessions as trusted. `POST {loginPath|/auth}/mode`: when unset, local must come from this machine and remote only enters the binding flow (remote is written only after `confirmSetup` succeeds); once chosen, the user must be logged in, remote→local disconnects all terminals, local→remote without a binding returns 409 `AUTHENTICATOR_BINDING_REQUIRED`, and when already bound one code is verified. `GET /auth/me` gained `access_mode` and `listen_host`, and `/auth/status` gained `mode`. `install.sh --access-mode local|remote` (local writes `HOST=127.0.0.1`, otherwise a new install writes `HOST=0.0.0.0`; the `HOST` of an existing `.env` is not changed). **Behavior change**: an instance that has neither bound nor chosen yet can no longer be bound for the first time from a non-local address (it gets 404); a remote server uses `node scripts/client-auth-setup.js`; a new install listens on 0.0.0.0 by default. Tests: `test/access-mode.test.js` (including starting a real service to verify the first choice, local-only without verification, 404 for DNS rebinding / forwarding, and opening external access after binding and switching back) and `test/access-mode-page.test.js`. Known limitations: in local-only mode other users / processes on the same machine can reach it; the `HOOK` reports inside the terminal go over loopback and are unaffected; switching to external access was not verified between two real machines.

> v2.53.0 Terminal Chinese-to-English input: below the terminal (above the function-key row) a new input box; Enter → `POST /api/translate` (`routes/translate.js`, `services/translator.js`, calling DeepSeek's OpenAI-compatible endpoint `/chat/completions` with `temperature: 0` and a prompt that only translates and never executes the message content) → `public/js/terminal-translate.js` types the translation into the current terminal through `Tasks.sendTerminalInput`, sending `\r` after a 120 ms delay (so a TUI does not treat it as a newline inside a paste). The configuration (API key / endpoint / model) is stored encrypted per user in `system_state` under `translator:<owner>`; the read endpoint never returns the key; the endpoint must be an HTTPS URL without credentials. Translation happens only on the local Client, so terminals of remote engines work too and the Engine is unchanged. Input without Chinese does not call the endpoint; before the translation enters the terminal all control characters (including ESC) are removed and it is collapsed into one line; when the terminal is not connected nothing is sent and the input is kept, and `sendTerminalInput` now returns whether it was sent. When the file drawer is open it is hidden together with the function-key row. Tests: `test/translator.test.js`, `test/terminal-translate.test.js`, `scripts/test-terminal-translate-browser.cjs`. v2.53.1 changed the default model to `deepseek-flash` (configurations that already saved a model name keep their value and must be changed by hand under ⚙). v2.54.1 no longer shows "Sent: translation" under the input after a successful send (it is already visible in the terminal) and only shows error hints. v2.54.2 "Translating" no longer takes a line of text of its own: the input box itself pulses (`.terminal-translate-input.translating`, read-only while keeping focus; cyan on the futuristic theme, a static glow under reduced motion) and the send button is disabled at the same time. v2.54.3 after pasting / uploading an image in the terminal finishes, a space is added by default after the inserted link (still no Enter) so you can keep typing; a link copied by hand because the original terminal was switched carries no space. v2.54.4 fixed "after a refresh, switching back to local, all tasks are gone and only appear after another refresh": after getting the task list, `reloadSource` still waits for the groups endpoint, and in that time Engines had already switched the UI to the saved remote Engine, so `activateSource` wrote the then still empty `tasks` array back to the local data source and overwrote the list just received. Now the `tasks` of the current view are updated synchronously when the list arrives. Regression: `test/remote-active-engine.test.js` (slow local groups endpoint). v2.55.0 translation gained Zhipu GLM: the configuration became `{enabled, provider, providers:{deepseek,glm}}`, each provider stores its own `{apiKey, baseUrl, model}`, saving only changes the selected provider, `provider` points at the one in use, and switching never overwrites the other provider's key; an old flat DeepSeek configuration is migrated automatically when read. GLM goes to `https://open.bigmodel.cn/api/paas/v4/chat/completions`, and models `glm-4.5` and above automatically carry `thinking: {type:'disabled'}` (translation does not need deep thinking). `GET /api/translate/config` gained `provider` and `providers` (only `hasApiKey/baseUrl/model/label`), keeping the old top-level fields for the current provider; the settings dialog gained a "Translation service" dropdown that keeps unsaved input when switching. Regression: `test/translator.test.js`. v2.55.1 changed the default GLM model to `glm-5.3-flash` (`glm-4-flash` timed out; the GLM-5 series think by default, so the request automatically carries `thinking: disabled`; configurations that already saved a model name keep their value and must be changed by hand under ⚙). v2.55.2 when the endpoint returns a non-2xx status, the provider's `error.message` and error code are shown first (such as GLM `1113 insufficient balance or no available resource package`), falling back to the generic message by status code only when there is none. v2.55.3/v2.55.4 (3 regression cases of 2.55.3 failed and were fixed in 2.55.4: an empty JSON body still falls back to the status-code message, and only plain text reports the raw text) when the error body is not in the `error.message` shape (flat `{code,msg}` or plain text), the reason / a raw snippet (≤200 characters) is reported too. v2.55.5 fixed the default GLM model `glm-5.3-flash` failing with HTTP 400 (1210 "this model always thinks and cannot turn thinking off"): v2.55.1 sent it `thinking:{type:'disabled'}`, which was rejected. `glm-5.3` and above now send `reasoning_effort:'low'` (measured on the real endpoint: 0 reasoning tokens, about 0.7 s), while `glm-4.5` to `glm-5.2` still send `thinking:disabled`. Known limitations: every input containing Chinese sends the original text to the selected provider; GLM was not verified against a real account (it follows Zhipu's public OpenAI-compatible documentation and stub tests); the Enter used to pick an IME candidate does not submit, but there is no history or translation preview confirmation; DeepSeek was not verified against a real account (the endpoint behavior follows its public OpenAI-compatible documentation and stub tests).

> v2.52.0 Links in the terminal can be opened in a new tab with Cmd (macOS) / Ctrl + click: before, the xterm links addon was not loaded and a URL was just ordinary text. Added the self-hosted `@xterm/addon-web-links` 0.11.0 (`public/vendor/xterm/`, manifest and SHA-256 in `scripts/vendor-libs.json`), registered in `tasks.js` when the terminal is created; the handler only calls `window.open(uri, '_blank', 'noopener,noreferrer')` when Cmd/Ctrl is held, a plain click is still text selection, and only http(s) links are recognized. Verified by `scripts/test-terminal-links-browser.cjs` (real Chromium). v2.52.1 hyperlinks printed by programs with OSC 8 (Claude Code and others, where the visible text can differ from the real address): xterm supports them itself but pops a confirm box on a single click by default; they now use `linkHandler`, likewise handled only on Cmd/Ctrl-click, which first asks for confirmation of the real address and only opens http(s). Known limitations: a long link broken across lines is only recognized as a whole by xterm when the break is a soft wrap; when a program in the terminal has enabled mouse reporting, whether a click is forwarded is decided by that program.

> v2.51.0 Theme switch: the top bar gained "🎨 Theme" with Light / Dark / Futuristic (deep-space blue background, neon cyan glow, grid background). `public/js/theme.js` runs synchronously in `<head>`, writes the choice (`localStorage` key `ta-theme`, effective in this browser only) to `<html data-theme>` to avoid a flash, and keeps Monaco (`vs` / `vs-dark` / custom `ta-tech`), mermaid (diagrams rendered later) and `theme-color` in sync; `public/css/themes.css` loads last and implements the dark themes with variable overrides plus a few overrides of hard-coded colors, while light stays the default of `style.css`. The terminal was already dark and is unchanged. No backend change. Verified by `scripts/test-theme-browser.cjs` (real Chromium; set `THEME_SHOT_DIR` to save screenshots). v2.51.1 fixed diagrams on the dark themes: the light-yellow `rect` highlight blocks hard-coded in the diagram source made light text invisible and were changed to a translucent dark tone (`themes.css`); when the theme switches, diagrams already shown are redrawn with the new theme (the source is kept in `data-mermaid-source`, `rerenderMermaid` in `tasks.js`). v2.51.3 fixed the terminal "running" shimmer being invisible on the dark / futuristic themes: the futuristic theme's selected item cleared the `background-image` shimmer with the `background` shorthand; brighter beams and outlines were added for the dark (bright blue) and futuristic (cyan glow) themes in `themes.css`. v2.51.4 reverted the "in-progress task highlight" (`is-doing`) of v2.51.2, and the task list is back to normal. Known limitations: the share page and login page do not follow the theme; screenshot comparison was only done for the empty state of the main UI, and the dark details of the sub-pages (utilities, apps, file sync, Agent config) were not checked one by one.

> v2.50.0 The sidebar gained an "Update all" button (⬆️, `public/js/batch-update.js`): after confirmation it checks and upgrades all connected remote engines in parallel (reusing `/api/remote-servers/:id/check-update|apply-update|update-status`, showing the result item by item and waiting after the restart until the version is in place, for at most 5 minutes), and updates this machine's Client last (updating it restarts the service and refreshes the page automatically, so it goes last and is handed to `Updates.apply()`). Items that are already up to date, blocked or failed are only summarized and not updated; `restart_pending` items that need a restart hint at restarting by hand. No backend change. Test `test/batch-update.test.js`.

> v2.49.0 The sidebar's "Import directories from the workspace" (📁) and "Clean up code directories" (🧹) follow the current engine: before, they still operated on this machine when a remote Engine was selected. The Engine gained `GET /v1/workspace/unmanaged`, `POST /v1/workspace/import`, `GET|POST /v1/workspace/cleanup` and `POST /v1/workspace/restore` (capability `workspace:manage`, reusing `services/workspace-tools`, with the directory base being that Engine's `TASKS_BASE_DIR` and the token subject being the owner), the Client proxies `/api/remote-servers/:id/workspace/*`, an old Engine returns `501 WORKSPACE_UNSUPPORTED`, and the frontend tells the user to update that engine first; when the engine is switched the unmanaged directories and the badge are checked again. Test `test/workspace-engine.test.js`.

> v2.48.0 File sync now has the master generate a connection string and the slave connect out (replacing v2.47.0's "the slave shows a pairing code and the master links it": the master has a fixed public IP while slaves are usually on an internal network, so the master cannot reach the slave): `POST /file-sync/invite` (`master_url`) generates a one-time sync pairing code on the master (in memory, 10 minutes, single use) and returns `TAFS1:` + base64url(`{v:1,u:<normalized master address>,c:<pairing code>}`); the slave's `POST /file-sync/join` (`connection_string`; whitespace picked up when pasting is removed) parses it and exchanges it for a `tfs_` token through the master's unauthenticated, rate-limited `POST /v1/file-sync/pair`, and is only allowed when `mode=slave`. Removed v2.47.0's `adopt`, `associate`, `refresh-code` and `status().pairing`; kept v2.47.0's role `mode`, `state.link`, `state.tokens`, the sync token scope and the old engine token compatibility.

> v2.47.0 File sync now has the slave initiate pairing and no longer borrows engine connections: `state.mode` (`master`/`slave`; old data infers it from whether a master is connected) records the role explicitly, `PUT /file-sync/role` switches it (which clears the list) and `POST /file-sync/unpair` unlinks. When a slave is not linked, `status().pairing` returns the in-memory pairing code (10 minutes, invalidated after 5 wrong guesses, regenerated on restart). The master's `POST /file-sync/associate` (slave address, pairing code, own address) calls the slave's unauthenticated `POST /v1/file-sync/adopt`; the slave then uses the master's one-time sync pairing code to call the master's unauthenticated `POST /v1/file-sync/pair` and exchange for a `tfs_` token (the master only stores the hash in `state.tokens` and revokes it by instance ID when the heartbeat deregisters). The master address and token are stored as ciphertext in `state.link` and no longer written to `remote_servers`, and no engine token is used; `manifest/file/heartbeat` accept the sync token and also stay compatible with the old engine token; the old `masterId` is still read from `remote_servers`. Removed `/pairing`, `/join`, `/connect` and `/servers`.

> v2.35.1 File sync node visibility: after a slave node connects for the first time and after every sync round, it uses the existing Engine Token to `POST /v1/file-sync/heartbeat` to the master to register its stable instance ID, name, last sync time and error; the master stores the latest heartbeat in `file_sync_v1.children` and shows it offline after 15 seconds. A normal disconnect deregisters with `DELETE /v1/file-sync/heartbeat`. The master's status endpoint returns the slave list and the page shows the online state and times; an old node needs no reconnection after upgrading and registers automatically in the next sync round.

> v2.36.0 Node path mapping: the master still owns the file list exclusively; a slave's `pathOverrides` stores local paths keyed by the master's path. `PUT /v1/file-sync/path` only changes the local mapping, is refused when the target path conflicts with another synced file, and deletes the override value when the default is restored. Switching a mapping clears that file's observed version, and an existing file at the target is backed up before the first write. The state returns the default path, the actual path and the override path together. A short-lived `.t-agent-file-sync-managed` marker is written next to a synced file for the new `agent-sync.py` to recognize, so the startup script and node sync do not rewrite the Claude/Codex configuration twice; the marker is refreshed with the 3-second poll, cleaned up on disconnect or path change, and expires after 60 seconds if the process stops abnormally. The time on the status page is renamed "Last check", so a periodic check is not mistaken for a content change.

> File sync service: its navigation entry sits next to "App list" and is shown per current engine. Every node starts as a master with an empty list; after choosing an existing remote connection, this node becomes a slave and the master node owns the path list exclusively. Paths support a home-directory alias and absolute paths, resolved separately on each machine; the service persists the role, file versions, the master generation, observed versions and backup paths in `system_state.file_sync_v1`. The master scans file hashes every 3 seconds and raises versions; a slave polls `GET /v1/file-sync/manifest`, submits local edits through `PUT /v1/file-sync/file` carrying `generation` and `base_revision`, and the master rejects concurrent writes by comparing versions. On conflict the local file is kept and the UI says so, and the user can explicitly choose to back up and pull the master version. The original file is backed up before the first overwrite as well. It reuses the Engine owner Token and the Client's remote connection proxy, and declares the capability `file-sync:manage`; a new node can recognize that an old node lacks the capability and prompts for an upgrade.

> v2.30.5 Fixed the content tab bar disappearing: after the v2.29.0 refactor the tab bar (design doc / README / AGENTS.md / to-do / terminal) was only shown when a document was rendered; when a task last stayed on the "terminal" tab, start-up went straight to the terminal without rendering a document and the tab bar stayed hidden, so the design doc, AGENTS and to-do could not be seen. Now the tab bar is always shown when a task is selected.

> v2.30.4 Terminal mouse garbage fix: a service restart, crash or manual close kills the running TUI (such as Claude Code), which has no chance to turn off the mouse / focus reporting modes, and this "enabled" state was saved in the output history; after a new shell replayed the history, the browser terminal kept feeding mouse movement to the shell as input, so characters like `35;39;58M` appeared after the prompt and were even run as commands. Now, when a session is created from history restored from the database, the input modes are always reset (and written into the history, so later replays do not turn them on again). The existing mechanism of "reset when the foreground program exits back to the shell" is kept.

> v2.30.3 Update progress is visible: while installing dependencies and building the frontend, "elapsed time + the latest npm output line" is updated every 2 seconds, with a hint after a long time without output; the npm used by the update has short retries and timeouts and fails fast when the network is down.

> v2.30.1 Third-party frontend libraries (marked, mermaid, xterm) are pinned and self-hosted in `public/vendor`, no longer depend on a runtime CDN, and mermaid is loaded on demand; foreground process detection on macOS uses a shared asynchronous `ps`; added CI that runs only the unit tests.

> v2.30.0 Engine and navigation swapped: the engine switch is at the top and Tasks / Utilities are on the left; Utilities belong to the current engine (PM2 manages the remote machine through the Engine's `/v1/pm2`, which needs the `pm2:manage` capability); all engine connections have admin rights and view / operate / manage are no longer distinguished.

> v2.29.4 Fixed the terminal tab group rendering twice when the state of the current terminal becomes finished (acknowledging completion triggered a redraw synchronously; it now finishes rendering first and then acknowledges); the marquee highlight is shorter and thinner, clipped by the tab and has a faint track.

> v2.29.2 The terminal state marquee became a highlight that moves at constant speed along the border path (`offset-path`), with the same speed at corners and on long and short sides, no longer using the angle-rotating `conic-gradient`.

> v2.29.1 Removed all Docker deployment and image builds (Dockerfile, Compose, `docker-client.sh`, the GitHub Actions image release and the related tests and docs), leaving only native, Git and archive installs; if a remote Engine reports a Docker install type, the Client still only shows it and does not trigger an update.

> v2.29.0 Remote Engines behave like the local one: the Client frontend became "data source" based, the local Engine and every remote Engine share one task UI (`tasks.js`), and connection management was split into `engines.js` (replacing `remote-tasks.js`). Remote tasks now support in-page document editing, adding / editing / deleting to-dos, the outline, relative-path images, automatic refresh on document changes, full task editing and deletion, drag-and-drop ordering, group management and terminal run state; Finder / VS Code / share links are hidden for remote tasks because they depend on this machine's file system. The Engine gained `/v1` endpoints: `PUT /tasks/reorder`, `GET /tasks/:id/file`, `GET /tasks/:id/document/:kind/watch` (SSE), `POST /tasks/:id/document/:kind`, `POST /tasks/validate-path`, `GET /terminal-activity` and `POST /tasks/:id/terminal/ack`, declared in `capabilities` of `/v1/info` (`tasks:reorder`, `documents:create`, `documents:watch`, `files:assets`, `paths:validate`, `terminal:activity`) with the API version still 1; the Client proxy gained the matching forwarding (including unbuffered streaming forwarding and `GET /api/remote-servers/:id/info`), and remote file responses carry `Content-Security-Policy: sandbox`. The frontend enables features by role and capability, and `readonly` connections and old Engines degrade automatically.

> v2.28.3 Engine connection failure handling: when a remote Engine is offline, its authentication has expired or loading tasks failed, the task list, documents and terminals are no longer shown; a "cannot connect" hint is shown instead (the reason for the failure, the service address and the steps to check the service status) together with retry / edit / remove connection buttons; when authentication has expired it asks the user to pair again. The sidebar under that Engine only shows "Service unavailable, please check its status".

> v2.28.2 Corrected the over-deletion of v2.28.0: v2.28.0 deleted by mistake the Client's feature of connecting to other Engines (`/api/remote-servers`, `/api/remote-tokens`, the `/v1` endpoints, the frontend engine bar and remote task UI, and remote Engine updates); all of it is now restored, Client A can keep connecting to Client B, and every Client still includes and exposes the same Engine endpoints. What was really removed is only the standalone Engine service: `apps/engine`, `compose.engine.yml`, the Engine update script and environment file, `--mode engine` of `install.sh`/`bootstrap.sh`, `start:engine`, the Docker engine image target and the matching release workflow. `--mode engine` now fails with a clear error.

> v2.28.1 Removed the "Client switch" entry button from the page header; the `/clients` workspace page and route were kept and can be opened by typing the address.

> v2.27.0 Agent hook reporting: the terminal PTY gets `TA_HOOK_URL` / `TA_HOOK_TOKEN` injected (the token is an HMAC of task + terminal and only exists in that PTY's environment), and the hooks of Claude Code and Codex (`UserPromptSubmit`→start, `Stop`→finished, permission-confirmation events→waiting for confirmation, `SessionEnd`→end) report through `POST /hooks/terminal-activity`; once a hook has been received, the hook wins; Esc/Ctrl+C interruptions do not trigger Stop and are treated as finished after 20 seconds of silence; an Agent without hooks is still decided by output. The hook configuration lives in `rules/claude/settings.json` and the newly added `rules/codex/hooks.json`, and `agent-sync.py` merges it into the machine when `ta` starts (hooks that already exist locally are kept and syncing again produces no duplicates). Codex must trust it once in `/hooks`.

> v2.26.1 Terminal state fix: Agents such as Claude Code and Codex, and interactive programs such as ssh, tmux and vim, hold the foreground forever, so looking only at the foreground process always showed running. For these programs the decision is now by output: only 4 or more outputs within about 1.5 seconds count as running, and about 3 seconds of silence is treated as waiting for the user and turns into finished-awaiting-review; the echo of the user's own typing and the redraw after a window resize do not count. Ordinary commands such as make and npm test are still decided by the foreground process, and stay running when the command is silent.

> v2.26.0 Terminal run state: the server decides each terminal's state from the PTY foreground process (the foreground not being a shell for about 1 second is running, returning to the shell is done, and it goes back to idle after the user opens that terminal to acknowledge), no longer depending on the rhythm of output, so it stays running while a command is silent and is not lost on a page refresh. `GET /api/tasks/terminal-activity` returns the terminal states of the tasks and `POST /api/tasks/:id/terminal/ack` acknowledges completion; the frontend polls every 1.5 seconds. The task item on the left aggregates all terminals of that task, and each terminal tab shows its own: running is an outer-ring marquee and finished-awaiting-review is a green breathing light, replacing the old dot badge. Remote Engine tasks are not wired in yet.

> v2.14.0 Multi-Client: (the `/clients` workspace was removed in v2.34.0) added the `/clients` workspace, where the browser stores Client names, addresses and the selected item, and switches between them in independent iframes while keeping the opened pages. Clients do not share sessions or proxy credentials; login and binding are completed in a separate window. The target Client explicitly allows the workspace origin through `CLIENT_FRAME_ORIGINS`, and pages uniformly restrict CSP frame-ancestors; a configured HTTPS session uses SameSite=None + Secure, HTTP stays Strict, and the same-origin checks of the browser API and WebSocket stay in force. Cross-site embedding is subject to the third-party cookie policy. Client authentication actually uses TOTP and the current session has a rolling 30-day lifetime; the OAuth part below is a historical design.

> v2.7.5 Terminal copy: local and remote terminals share a selection-copy module that explicitly enables the Mac Option forced selection; OSC 52 write requests are written to the clipboard only after a size limit, UTF-8 validation and a user preview confirmation. Read requests are refused, hidden instances and history replays are ignored, pending requests are cleaned up when an instance is released, and Ctrl+C keeps its interrupt meaning.

> v2.33.0 Removed the standalone PM2 process management panel from the "Utilities" page: the PM2 status, start / stop / restart / reload and logs are all in the "App list". The backend `/api/pm2`, the Engine `/v1/pm2` and the `pm2:manage` capability are kept (the PM2 actions of the app list use them); `tools.js` only keeps page switching and the app list's engine adaptation.

> v2.32.0 Service management: a new install of `install.sh` manages the Client with PM2 by default (`ensure_pm2` installs it with npm when missing; a busy port does not start; if `pm2 describe t-agent` exists it runs `restart --update-env`, otherwise `start`). An existing LaunchAgent / `t-agent.service` is kept to avoid two instances fighting over the port; `--pm2` first stops and removes the old service and then migrates; `uninstall.sh` deletes `t-agent` from PM2 and runs `pm2 save`.

> v2.31.1 Update check: added the `restart_pending` state. `services/update-manager.js` records `runningVersion` at process start (keeping the existing `runningCommit`), and when checking for updates, if the remote version equals the disk version but there are changes needing a restart between "start commit → HEAD" (the rules of `lib/update-impact.js`), or for a package install the start-up version differs from the disk version, it returns `restart_pending` instead of `current`; with a higher remote version it is still `available`. Extra fields `restart_pending` and `running_version`; the persisted state is cleared when the process restarts.

> v2.31.0 App list: the engine's own SQLite gained an `apps` table (`db/schema.sql`), `services/apps-registry.js` handles validation and idempotent registration, `services/port-detector.js` detects listening ports on the PM2 process tree, and `services/apps-service.js` auto-registers PM2 processes and merges run state and access addresses; the local `/api/apps`, the Engine's `/v1/apps` (capability `apps:manage`, program self-registration goes through `POST /v1/apps/register`) and the Client's proxy to remote engines share `routes/apps.js`, and the frontend `public/js/apps.js` is dispatched by `Tools` for the current engine.

> v2.7.3 Update protection: a Git update supports an explicit forced update, which backs uncommitted changes up to a Git stash and then fast-forwards. Ignored runtime data is kept, merging over ignored files is forbidden, committed divergence and Git-tracked runtime data are refused; when switching the update branch the remote tracking refs are fetched explicitly.

> v2.7.2 Reading experience: local documents, remote read-only documents and the share page uniformly use an isolated Markdown style and locally bundled Highlight.js syntax highlighting. Code blocks keep the original whitespace and offer a language label and a copy button; unknown languages are shown as plain text, and Mermaid keeps using diagram rendering. The terminal and the Monaco editor are unaffected by this style.

> Current implementation note (v2.7.1): this document keeps the early design record; the current architecture is split into Client and Engine. The Client runs as a single-user application and builds a local user context automatically at start-up, with no username, password, login page or logout entry; on upgrade the existing user in the database and its task ownership are kept first. The Client listens on `127.0.0.1` only by default. A standalone Engine always listens on `0.0.0.0`, serves the remote API and terminal connections to the Client through a Bearer Token, allows a Client holding an owner Token to trigger a controlled self-update, and provides control endpoints to close a terminal and to rebuild one from the task working directory. A task can use any absolute working directory on the Engine server, and the design doc defaults to `DESIGN.md` in the working directory. A standalone Engine supports Docker image deployment with a pinned Node/C++ toolchain, with the host updating the image, and persists data, tasks and the independent Codex configuration under `~/.torin/t-agent-data`; the Engine image includes the Codex CLI. The installed-app mode uses a dynamic viewport and flex height constraints and recomputes the terminal rows and columns automatically when the terminal container changes size, so the bottom input row is not clipped by the window edge. The complete current architecture and deployment are described in `README.md` and `docs/ARCHITECTURE.md`.

---

## 1. Goals

Build a private task management page with:
- **Task list** (left navigation): add, edit and delete tasks, and move them through statuses
- **MD file preview** (main area on the right): clicking a task shows its linked `.md` file, with Mermaid rendering

Authentication is by GitHub OAuth, and only configured GitHub users are allowed in.

---

## 2. Technology stack

| Layer | Technology |
|------|------|
| Frontend | Plain HTML + CSS + Vanilla JS (no framework) |
| Backend | Node.js + Express |
| Database | SQLite (better-sqlite3) |
| Authentication | GitHub OAuth 2.0 + Express Session |
| Session persistence | connect-better-sqlite3 |
| MD rendering | marked.js (CDN) |
| Diagram rendering | mermaid.js (CDN) |

---

## 3. Project structure

```
torin-x-web/
├── server.js              # Entry point, Express service
├── config.js              # Configuration (GitHub OAuth, allowed usernames, port and so on)
├── .env                   # Environment variables (not committed to git)
├── .env.example           # Example environment variables
├── db/
│   ├── index.js           # SQLite connection & initialization
│   └── schema.sql         # Table definitions
├── routes/
│   ├── auth.js            # GitHub OAuth routes
│   └── tasks.js           # Task list API
├── middleware/
│   └── auth.js            # Login-state check middleware
├── public/
│   ├── index.html         # Home page (visible after login)
│   ├── login.html         # Login page
│   ├── css/
│   │   └── style.css
│   └── js/
│       ├── app.js         # Home page logic (task list + MD preview)
│       └── tasks.js       # Task module
└── data/
    └── db.sqlite          # SQLite database file (not committed to git)
```

---

## 4. Data model

### tasks (task list)

```sql
CREATE TABLE tasks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT    NOT NULL,
  status     TEXT    DEFAULT 'todo',   -- todo | doing | done
  priority   TEXT    DEFAULT 'normal', -- low | normal | high
  due_date   TEXT,                     -- YYYY-MM-DD
  md_path    TEXT,                     -- absolute path of the linked local .md file (may be NULL)
  work_dir   TEXT,                     -- working directory, defaults to the directory of md_path (may be NULL)
  sort_order INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

**Notes:**
- When creating a task: only `md_path` may be filled in, and the title is taken from the file name (without the `.md` suffix)
- `md_path` must be an absolute path with the extension `.md`, strictly validated on the server
- If `work_dir` is not passed and there is an `md_path`, the server uses `path.dirname(md_path)` as the default

### sessions (managed automatically by connect-better-sqlite3)

---

## 5. Authentication flow

```
User visits any page
      │
      ▼
Middleware checks session.user
      │
  Not logged in ──► redirect to /login
      │
  Logged in
      │
      ▼
  Is the GitHub username in the ALLOWED_USERS allowlist?
      │
    No ──► return a 403 page
      │
    Yes ──► let through
```

**OAuth callback flow:**
1. The user clicks "Log in with GitHub" → redirected to `GET /auth/github`
2. Redirect to the GitHub authorization page
3. GitHub calls back `GET /auth/github/callback?code=xxx`
4. The backend exchanges the code for an access_token and then gets the user information
5. Check whether the `login` field is on the allowlist and write it to the session
6. Redirect to the home page

---

## 6. API design

All APIs need a login state, otherwise they return `401`.

### Authentication

| Method | Path | Description |
|--------|------|------|
| GET | `/auth/github` | Redirect to GitHub OAuth |
| GET | `/auth/github/callback` | OAuth callback |
| POST | `/auth/logout` | Log out |
| GET | `/auth/me` | Get the current user information |

### Tasks

| Method | Path | Description |
|--------|------|------|
| GET | `/api/tasks` | Get all tasks (supports the `?status=todo` filter) |
| POST | `/api/tasks` | Create a task |
| PUT | `/api/tasks/:id` | Update a task (title, status, priority, due_date) |
| DELETE | `/api/tasks/:id` | Delete a task |
| GET | `/api/tasks/:id/md` | Read the content of the task's linked `.md` file (plain text) |

---

## 7. Page layout

### Login page (`/login.html`)

A centered card with a GitHub icon + a "Log in with GitHub" button.

### Home page (`/`) — three-column layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│  📋 Tasks                                  [avatar] matonglin  [Log out] │
├─────────────────┬───────────────────────────────────────┬────────────────┤
│                 │                                       │                │
│  [+ New task]   │   # Design document                   │  Outline       │
│                 │                                       │  ─────────     │
│  ● In progress  │   ## 1. Goals                         │  # Design doc  │
│  ─────────────  │   ...                                 │  ├ 1. Goals    │
│  ▶ design       │                                       │  ├ 2. Architec │
│  ▶ plan         │   ## 2. Architecture                  │  │ ├ Diagram   │
│                 │   ```mermaid                          │  │ └ Modules   │
│  ○ To do        │   graph TD                            │  └ 3. Deploy   │
│  ─────────────  │     A --> B                           │                │
│    task-a       │   ```                                 │                │
│    task-b       │   [mermaid rendering result]          │                │
│                 │                                       │                │
│  ✓ Done         │   ## 3. Deployment                    │                │
│  ─────────────  │   ...                                 │                │
│    old-task     │                                       │                │
│                 │                                       │                │
└─────────────────┴───────────────────────────────────────┴────────────────┘

Left (task navigation): fixed 280px
Middle (MD preview): flex: 1, adaptive, scrollable
Right (MD outline): fixed 220px, shown only when there is an md_path
```

---

## 8. Frontend interaction

### Left navigation bar

- Tasks are grouped by status into three groups: **In progress / To do / Done**, and each group can be collapsed
- A task with an `md_path` shows a `▶` arrow icon, and a task without md shows an ordinary dot
- Clicking a task → highlights it as selected and loads the MD preview on the right
- Right-clicking a task → context menu (change status / delete)
- Clicking the status circle → quick status switch (todo → doing → done → todo)

### New-task dialog

```
┌─────────────────────────────┐
│  New task                 ✕ │
├─────────────────────────────┤
│  Title [___________________] │
│  MD path[__________________] │  ← the title is filled in automatically after entering it
│  Priority ○Low  ●Medium  ○High │
│  Due date [____-__-__]       │
│                             │
│           [Cancel]  [Create] │
└─────────────────────────────┘
```

- When the `md_path` input loses focus:
  1. Check that the extension is `.md`
  2. Request `POST /api/tasks/validate-path` to verify that the file exists
  3. If valid and the title is empty, fill in the file name as the title automatically
- The title is required (it can be changed by hand) and the path is optional
- **Automatic creation mode**: if only the title is filled in and `md_path` is not, clicking Create:
  1. The server creates a directory under `/Users/torin/main-kuaishou/02_agent/<task title>/`
  2. It creates the file `<task title>.md` whose content is `# <task title>\n`
  3. It sets `work_dir` to that directory and `md_path` to the path of that md file
  4. The directory / file name is taken from the title with illegal characters replaced by `-` (replacement rules: `/\s+/g → '-'`, `/[^a-zA-Z0-9\u4e00-\u9fff\-_\.]/g → ''`)

### MD preview area on the right

- With no task selected: show the empty-state hint "← Pick a task on the left to see details"
- With a selected task that has no `md_path`: show the task's basic information (title, status, priority, due date)
- With an `md_path`:
  1. Request `GET /api/tasks/:id/md` to get the markdown source
  2. marked.js renders HTML, and mermaid code blocks are replaced with `<div class="mermaid">...</div>`
  3. `mermaid.init()` triggers rendering
  4. The preview area is scrollable
  5. When rendering finishes, the outline on the right is generated

### Right outline (TOC)

- Shown only when the current task has an `md_path`, otherwise hidden (the width collapses)
- Parses the `h1~h4` heading elements in the DOM rendered by marked.js and builds a tree
- Heading indentation by level: `h1` none, `h2` 8px, `h3` 16px, `h4` 24px
- Clicking an outline entry → the matching heading scrolls to the top of the visible range of the middle preview area (`scrollIntoView`)
- When the middle preview area scrolls → the outline entry of the topmost heading in the visible range is highlighted (scroll listener + IntersectionObserver)

```html
<!-- CDN includes (index.html) -->
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script>
```

---

## 9. Configuration (`.env`)

```env
# GitHub OAuth
GITHUB_CLIENT_ID=xxx
GITHUB_CLIENT_SECRET=xxx
GITHUB_CALLBACK_URL=http://localhost:3000/auth/github/callback

# GitHub usernames allowed in (comma separated)
ALLOWED_GITHUB_USERS=matonglin

# Service
PORT=3000
SESSION_SECRET=your-random-secret
```

---

## 10. Dependency list

```json
{
  "dependencies": {
    "express": "^4.18.x",
    "better-sqlite3": "^9.x",
    "connect-better-sqlite3": "^1.x",
    "express-session": "^1.17.x",
    "axios": "^1.x"
  }
}
```

---

## 11. Security considerations

| Risk | Mitigation |
|------|------|
| Session hijacking | `httpOnly` + `secure` (production) cookies, randomly generated session secret |
| CSRF | API requests carry an `X-Requested-With` header that the server checks |
| Unauthorized access | Every API goes through the auth middleware, which checks the session |
| Leaking sensitive configuration | `.env` is in `.gitignore`, and `.env.example` is provided |
| Bypassing the username allowlist | The `login` field returned by the GitHub API is matched exactly; parameters from the frontend are not trusted |
| Arbitrary file read | `/api/tasks/:id/md` only reads the `md_path` already stored in the database and never accepts a path from the frontend; the extension must be `.md` |

---

## 12. How to start

```bash
npm install
cp .env.example .env   # fill in the GitHub OAuth settings
node server.js         # development: nodemon server.js
```

| Layer | Technology |
|------|------|
| Frontend | Plain HTML + CSS + Vanilla JS (no framework) |
| Backend | Node.js + Express |
| Database | SQLite (better-sqlite3) |
| Authentication | GitHub OAuth 2.0 + Express Session |
| Data persistence | Sessions are stored in SQLite (connect-better-sqlite3) |

---

## 3. Project structure

```
torin-x-web/
├── server.js              # Entry point, Express service
├── config.js              # Configuration (GitHub OAuth, allowed usernames, port and so on)
├── .env                   # Environment variables (not committed to git)
├── .env.example           # Example environment variables
├── db/
│   ├── index.js           # SQLite connection & initialization
│   └── schema.sql         # Table definitions
├── routes/
│   ├── auth.js            # GitHub OAuth routes
│   ├── bookmarks.js       # Quick-navigation API
│   └── tasks.js           # Task list API
├── middleware/
│   └── auth.js            # Login-state check middleware
├── public/
│   ├── index.html         # Home page (visible after login)
│   ├── login.html         # Login page
│   ├── css/
│   │   └── style.css
│   └── js/
│       ├── app.js         # Home page logic
│       ├── bookmarks.js   # Quick-navigation module
│       └── tasks.js       # Task list module
└── data/
    └── db.sqlite          # SQLite database file (not committed to git)
```

---

## 4. Data model

### bookmarks (quick navigation)

```sql
CREATE TABLE bookmarks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT    NOT NULL,
  url        TEXT    NOT NULL,
  icon       TEXT,              -- favicon URL or emoji
  group_name TEXT    DEFAULT 'Default',
  sort_order INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### tasks (task list)

```sql
CREATE TABLE tasks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT    NOT NULL,
  status     TEXT    DEFAULT 'todo',   -- todo | doing | done
  priority   TEXT    DEFAULT 'normal', -- low | normal | high
  due_date   TEXT,                     -- YYYY-MM-DD
  md_path    TEXT,                     -- absolute path of the linked local .md file (may be NULL)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

**Notes:**
- `md_path` is an optional field
- When creating a task: only `md_path` may be filled in (the title is taken from the file name without the `.md` suffix), or both a title and a path
- The path must be absolute and the file extension must be `.md`, validated on the server

### sessions (session persistence, managed automatically by connect-better-sqlite3)

---

## 5. Authentication flow

```
User visits any page
      │
      ▼
Middleware checks session.user
      │
  Not logged in ──► redirect to /login
      │
  Logged in
      │
      ▼
  Is the GitHub username in the ALLOWED_USERS list?
      │
    No ──► return a 403 page
      │
    Yes ──► let through
```

**OAuth callback flow:**
1. The user clicks "Log in with GitHub" → redirected to `GET /auth/github`
2. Redirect to the GitHub authorization page
3. GitHub calls back `GET /auth/github/callback?code=xxx`
4. The backend exchanges the code for an access_token and then gets the user information
5. Check whether the username is on the allowlist and write it to the session
6. Redirect to the home page

---

## 6. API design

All APIs need a login state, otherwise they return `401`.

### Authentication

| Method | Path | Description |
|--------|------|------|
| GET | `/auth/github` | Redirect to GitHub OAuth |
| GET | `/auth/github/callback` | OAuth callback |
| POST | `/auth/logout` | Log out |
| GET | `/auth/me` | Get the current user information |

### Quick navigation

| Method | Path | Description |
|--------|------|------|
| GET | `/api/bookmarks` | Get all bookmarks (by group) |
| POST | `/api/bookmarks` | Create a bookmark |
| PUT | `/api/bookmarks/:id` | Update a bookmark |
| DELETE | `/api/bookmarks/:id` | Delete a bookmark |
| PUT | `/api/bookmarks/reorder` | Change the order |

### Task list

| Method | Path | Description |
|--------|------|------|
| GET | `/api/tasks` | Get all tasks (supports the `?status=todo` filter) |
| POST | `/api/tasks` | Create a task |
| PUT | `/api/tasks/:id` | Update a task (including status transitions) |
| DELETE | `/api/tasks/:id` | Delete a task |
| GET | `/api/tasks/:id/md` | Read the content of the task's linked .md file (returned as plain text) |

---

## 7. Frontend page design

### Login page (`/login.html`)

- A centered card
- A GitHub icon + a "Log in with GitHub" button
- Simple, with no extra elements

### Home page (`/`)

```
┌─────────────────────────────────────────────────────┐
│  🏠 Torin's Dashboard        [avatar] matonglin  Log out │
├─────────────────────────────────────────────────────┤
│                                                     │
│  Quick navigation                       [+ Add]     │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐            │
│  │  Work    │ │  Tools   │ │  Docs    │  ...       │
│  │  [icon]  │ │  [icon]  │ │  [icon]  │            │
│  │  Jira    │ │  ChatGPT │ │  Notion  │            │
│  └──────────┘ └──────────┘ └──────────┘            │
│                                                     │
│  ─────────────────────────────────────────────────  │
│                                                     │
│  Task list                              [+ Add]     │
│  ┌─────────────────────────────────────────────┐   │
│  │ ○ [high] Finish the home page         Today  │   │
│  │ ○ [norm] Review code                  Tomorrow │ │
│  │                                              │   │
│  │ ▶ [norm] 📄 design.md                 Today  │   │  ← a task linked to an md file; click to expand
│  │   ┌──────────────────────────────────────┐   │   │
│  │   │  # Design document                   │   │   │
│  │   │  ## Flow chart                       │   │   │
│  │   │  [mermaid diagram]                   │   │   │
│  │   └──────────────────────────────────────┘   │   │
│  │                                              │   │
│  │ ✓ [low]  Update docs                  Done   │   │
│  └─────────────────────────────────────────────┘   │
│                                                     │
└─────────────────────────────────────────────────────┘
```

**Interaction details:**
- Bookmark cards: a click opens the link, and right-click or hover shows edit / delete
- Bookmark groups: switched by tabs
- Tasks: click the circle to switch the status (todo → doing → done)
- Adding a bookmark / task: an inline dialog form, no page jump
- Done tasks are collapsed by default and can be expanded to view

### Task MD preview interaction

**Create a task (linked to an md file):**
1. Click "+ Add" → a dialog with input fields appears
2. Enter the absolute path of a local `.md` file (such as `/Users/torin/docs/design.md`)
3. On blur the server validates the path (extension `.md`, file exists)
4. The title is filled in automatically with the file name (without `.md`) and can be edited by hand
5. After submitting, the task card shows a 📄 icon marker

**Task expand preview:**
- A task with an `md_path` has a `▶` expand arrow to the left of its title
- Click the title row → an inline preview area expands (click again to collapse)
- On expanding, the frontend requests `GET /api/tasks/:id/md` to get the markdown source
- Use **marked.js** to render markdown and **mermaid.js** to render diagrams
- Mermaid code block rendering flow: when marked parses, it recognizes ` ```mermaid ` code blocks → replaces them with `<div class="mermaid">` → mermaid.js initializes and renders
- The preview area has a maximum height of `500px` and scrolls beyond it

### New frontend dependencies (included from a CDN, no build)

```html
<!-- Markdown rendering -->
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<!-- Mermaid diagrams -->
<script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script>
```

---

## 8. Configuration (`.env`)

```env
# GitHub OAuth
GITHUB_CLIENT_ID=xxx
GITHUB_CLIENT_SECRET=xxx
GITHUB_CALLBACK_URL=http://localhost:3000/auth/github/callback

# GitHub usernames allowed in (comma separated)
ALLOWED_GITHUB_USERS=matonglin

# Service
PORT=3000
SESSION_SECRET=your-random-secret
```

---

## 9. Dependency list

```json
{
  "dependencies": {
    "express": "^4.18.x",
    "better-sqlite3": "^9.x",
    "connect-better-sqlite3": "^1.x",
    "express-session": "^1.17.x",
    "axios": "^1.x"
  }
}
```

No passport is needed; GitHub OAuth is implemented by hand to stay lightweight.

---

## 10. Security considerations

| Risk | Mitigation |
|------|------|
| Session hijacking | `httpOnly` + `secure` (production) cookies, randomly generated session secret |
| CSRF | API requests carry an `X-Requested-With` header that the server checks |
| Unauthorized access | Every API request goes through the auth middleware, which checks the session |
| Leaking sensitive configuration | `.env` is in `.gitignore`, and `.env.example` is provided |
| Bypassing the username allowlist | The `login` field returned by the GitHub API is matched exactly; parameters from the frontend are not trusted |
| Arbitrary file read | `/api/tasks/:id/md` only reads the `md_path` already stored in the database and never accepts a path from the frontend; the server strictly validates the extension as `.md` |

---

## 11. How to start

```bash
npm install
cp .env.example .env   # fill in the GitHub OAuth settings
node server.js         # development: nodemon server.js
```

---

## 13. Start on boot

> **Current default (since v2.32.0)**: `install.sh` manages the Client with **PM2**, with the process name `t-agent` (`pm2 start server.js --name t-agent --cwd <project directory>` + `pm2 save`); the in-app update exits with code 75 and PM2 starts it again automatically; for start on boot the user runs `pm2 startup` and `pm2 save`. Old installs that already registered a system service keep using it (`--pm2` migrates, `--system-service` forces keeping it). What follows is the earlier LaunchAgent-based design record.

Managed by a macOS **LaunchAgent**, started automatically at boot, with a crashed process brought back automatically (`KeepAlive: true`).

**plist path**: `~/Library/LaunchAgents/com.torin.x-web.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.torin.x-web</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/torin/main-kuaishou/02_agent/torin-x-web/server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/torin/main-kuaishou/02_agent/torin-x-web</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/torin/main-kuaishou/02_agent/torin-x-web/logs/stdout.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/torin/main-kuaishou/02_agent/torin-x-web/logs/stderr.log</string>
</dict>
</plist>
```

**Common management commands**:

```bash
launchctl start  com.torin.x-web   # start
launchctl stop   com.torin.x-web   # stop (KeepAlive brings it back, so unload first to stop it completely)
launchctl unload ~/Library/LaunchAgents/com.torin.x-web.plist   # stop completely and cancel start on boot
launchctl load   ~/Library/LaunchAgents/com.torin.x-web.plist   # register again and start

# view the run state
launchctl list com.torin.x-web

# view the logs
tail -f /Users/torin/main-kuaishou/02_agent/torin-x-web/logs/stdout.log
tail -f /Users/torin/main-kuaishou/02_agent/torin-x-web/logs/stderr.log
```

**Node.js version**: `/usr/local/bin/node` (v20.16.0), **not** Homebrew's node (to avoid native-module build incompatibilities caused by version conflicts).

> ⚠️ After upgrading dependencies or running `npm install`, if native modules are included (`better-sqlite3`, `node-pty`), make sure they are built by the npm that belongs to `/usr/local/bin/node`, then restart the service:
> ```bash
> cd /Users/torin/main-kuaishou/02_agent/torin-x-web
> npm rebuild
> launchctl stop com.torin.x-web && launchctl start com.torin.x-web
> ```

---
## 12. Quick links technical design

> Date: 2026-07-16

### Goals

Add a "Quick links" area to the existing three-column layout, supporting adding, editing and deleting frequently used URLs, group management, and a single click to jump.

---

### UI design

**Layout: a horizontal link bar below the header**, which does not take space from the task navigation on the left.

```
┌───────────────────────────────────────────────────────────────────┐
│  📋 Tasks                              [avatar] matonglin  [Log out] │
├───────────────────────────────────────────────────────────────────┤
│  🔗  [Jira] [Confluence] [ChatGPT] [KDev] …  [+]  [▾]           │  ← new
├──────────────────┬─────────────────────────────────┬─────────────┤
│                  │                                 │             │
│  [+ New task]    │   MD Preview                    │  TOC        │
│  ─────────────   │                                 │             │
│  ▶ design        │                                 │             │
└──────────────────┴─────────────────────────────────┴─────────────┘
```

**Link chip**: favicon icon + title; a click opens a new tab, and right-click shows "Edit" and "Delete".

**Collapse / expand**: with several groups, click `▾` to expand; the state is persisted in `localStorage`.

**Add / edit dialog**:

```
┌──────────────────────────────┐
│  Add link               ✕   │
├──────────────────────────────┤
│  Name   [__________________] │
│  URL    [__________________] │  ← on blur, fetch the favicon & fill in the name automatically
│  Icon   [__________________] │  ← an emoji or image URL, leave empty to use the favicon
│  Group  [__________________] │
│            [Cancel]  [Add]   │
└──────────────────────────────┘
```

When the URL loses focus, a preview is loaded automatically from `{origin}/favicon.ico`; when the name is empty it is taken from the hostname.

---

### Data model

Already exists (`db/schema.sql`):

```sql
CREATE TABLE IF NOT EXISTS bookmarks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT    NOT NULL,
  url        TEXT    NOT NULL,
  icon       TEXT,
  group_name TEXT    NOT NULL DEFAULT 'Default',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

---

### API (already implemented, nothing to add)

| Method | Path | Description |
|--------|------|------|
| GET | `/api/bookmarks` | Get all bookmarks |
| POST | `/api/bookmarks` | Create |
| PUT | `/api/bookmarks/:id` | Update |
| DELETE | `/api/bookmarks/:id` | Delete |
| PUT | `/api/bookmarks/reorder` | Bulk ordering |

---

### Frontend implementation

**HTML** (inserted between `<header>` and `.layout`):

```html
<div class="quicklinks-bar" id="quicklinks-bar">
  <span class="quicklinks-label">🔗</span>
  <div class="quicklinks-chips" id="quicklinks-chips"></div>
  <button id="btn-add-link">+</button>
  <button id="btn-toggle-links">▾</button>
</div>
```

**JS module**: `public/js/bookmarks.js` (a skeleton already exists, adapted to the horizontal chip layout)

| Interaction | Behavior |
|------|------|
| Click a chip | `window.open(url, '_blank')` |
| Right-click a chip | ContextMenu: edit / delete |
| Click `+` | Open the add dialog |
| Click `▾` | Collapse / expand several groups, written to `localStorage` |

---

### List of changed files

| File | Change |
|------|------|
| `public/index.html` | Insert `.quicklinks-bar` below the header |
| `public/css/style.css` | Add `.quicklinks-*` styles |
| `public/js/bookmarks.js` | Rewritten into a horizontal chip layout |
| `public/js/app.js` | `init()` calls `Bookmarks.load()` |
| Backend | No change needed |

---

## 13. Log of implemented changes

> Date: 2026-07-16

### Quick links feature (implemented)

Implemented according to the design of chapter 12; the details as actually landed:

- **Layout**: `--quicklinks-height: 36px`, and the height of `.layout` is reduced by the same value
- **Chip**: `inline-flex` + `border-radius: 14px`; the favicon is loaded automatically from `{origin}/favicon.ico` and degrades to 🔗 on failure
- **Collapse**: with a single group the `▾` button is hidden; when expanded with several groups each group takes one row and shows its group label; the state is persisted in `localStorage('quicklinksExpanded')`
- **Context menu**: reuses the global `ContextMenu` and offers edit / delete

---

### LAN share link on the Tools page (implemented)

**Background**: the static tool pages under `public/tools/` (such as `kwai-url-parser.html`) are not authenticated and need to show a full URL that can be reached directly on the LAN.

**Implementation**:

1. **Backend**: `server.js` gained an unauthenticated endpoint:
   ```
   GET /api/local-ip  →  { ip: "192.168.x.x", port: 3000 }
   ```
   It uses `os.networkInterfaces()` to get the first non-internal IPv4 address.

2. **Frontend** (`kwai-url-parser.html`): when the page loads it requests `/api/local-ip`, replaces the hostname/port of `window.location` with the LAN IP, and shows it at the right of the header.

3. **UI**:
   ```
   ┌────────────────────────────────────────────────────────────┐
   │  🔗 Kwai URL parser    http://192.168.1.4:3000/tools/… [Copy link] │
   └────────────────────────────────────────────────────────────┘
   ```
   Clicking the whole row or the "Copy link" button both trigger `navigator.clipboard.writeText()`, and after copying the button briefly becomes "Copied ✓".

**Changed files**:

| File | Change |
|------|------|
| `server.js` | Added `GET /api/local-ip`, and the start-up log prints the LAN address |
| `public/tools/kwai-url-parser.html` | A share-link component is inserted at the right of the header, and JS builds the LAN URL dynamically |

---

## 14. Task working path + embedded terminal

> Date: 2026-07-20

### Goals

1. Each task gets a new `work_dir` (working directory) field, defaulting to the directory of `md_path`
2. The content area gets a tab switch (**Document** / **Terminal**), and the terminal uses xterm.js to open a server shell
3. The shell process stays resident in memory, and the terminal output (the commands + their results) is persisted in SQLite so history can be restored after a service restart

---

### Data model changes

A new column on the **tasks table** (appended with `ALTER TABLE`):

```sql
ALTER TABLE tasks ADD COLUMN work_dir TEXT;
-- working directory, defaults to the directory of md_path and can be changed by hand
```

**New terminal_logs table**:

```sql
CREATE TABLE IF NOT EXISTS terminal_logs (
  task_id    INTEGER PRIMARY KEY,
  buffer     TEXT    NOT NULL DEFAULT '',
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- buffer: the full raw terminal output (ANSI escape codes), capped at 5MB; beyond that it is truncated from the start, keeping the last 5MB
```

---

### API changes

`POST /api/tasks` and `PUT /api/tasks/:id`: new `work_dir` field; when not passed it is taken automatically as `path.dirname(md_path)`.

`POST /api/tasks/validate-path`: the response also carries `work_dir: path.dirname(md_path)`.

**New WebSocket endpoint**:

| Endpoint | Description |
|------|------|
| `GET /terminal/ws?taskId=:id` | Upgraded to a WebSocket and connected to the task's shell |

---

### Terminal architecture

```
Frontend xterm.js  ←—— WebSocket ——→  node-pty (per task, resident in memory)
                                       ↓
                              in-memory buffer (5MB ring)
                                       ↓  flush every 5s or when 50KB has accumulated
                              SQLite terminal_logs (persistent)
```

**Process lifecycle**: the pty is created at a task's first connection, is not destroyed when the ws disconnects, and only disappears when the service restarts. After a service restart the history buffer is restored from `terminal_logs` and then a new pty is spawned.

---

### UI changes

A tab bar is added below the toolbar (shown only when a task is selected):

```
[📄 Document]  [⌨ Terminal]
```

- **Document tab**: the original MD preview + TOC, behavior unchanged
- **Terminal tab**: a full-size black xterm.js terminal with cwd = `work_dir`, which replays the history buffer automatically on connect

The new / edit task dialog gains a "Working path" input, filled in automatically once the md_path passes validation on blur.

---

### New dependencies

```json
"node-pty": "^1.0.0",
"ws": "^8.0.0"
```

Frontend CDN includes (`index.html`):

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm/css/xterm.css">
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm/lib/xterm.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit/lib/addon-fit.js"></script>
```

---

### List of changed files

| File | Change |
|------|------|
| `db/index.js` | Append the work_dir migration; create the terminal_logs table |
| `routes/tasks.js` | POST/PUT support work_dir; validate-path returns work_dir |
| `routes/terminal.js` | New: WebSocket PTY, node-pty resident, buffer + SQLite dual write |
| `server.js` | Mount the ws server and intercept the `/terminal/ws` upgrade |
| `package.json` | Add node-pty and ws |
| `public/index.html` | Include the xterm.js CDN; add the tab bar and terminal-pane structure |
| `public/js/tasks.js` | Tab switching; xterm initialization; the work_dir form field; WebSocket forwarding |
| `public/css/style.css` | Add the tab bar, terminal-pane and .task-info-path styles |

---

## 16. Task drag-and-drop ordering + personal task group

> Date: 2026-07-27

### Goals

1. The task list on the left supports drag-and-drop ordering (reordering within a group)
2. Dragging to another status group → changes the task's status
3. A new status value `personal` (personal tasks) as a fourth group alongside In progress / To do / Done

---

### Sidebar structure

```
● In progress
  ▶ design
○ To do
  task-a
✓ Done
  old-task
★ Personal tasks      ← new status='personal' group
  life-task
```

---

### Drag behavior

| Drag scenario | Result |
|---------|------|
| Drag within the same status group | Update sort_order |
| Drag to a different status group | Update status + sort_order |

- While dragging, the target insertion position is highlighted (a placeholder line)
- When the drag ends, the status change is submitted and then sort_order in bulk

---

### Scope of changes

**Frontend** (only tasks.js + style.css):
- `STATUS_ORDER` gets `'personal'` appended and `STATUS_LABEL` gets `'Personal tasks'`
- In the STATUS_NEXT cycle personal → todo
- The status options of the new / edit dialog gain "Personal tasks"
- HTML5 drag-and-drop logic for the sidebar

**Backend**: no change needed (the status column is already TEXT and `personal` is stored directly)

**DB**: no change needed

---

### API changes

New `PUT /api/tasks/reorder`: bulk update of sort_order, body: `[{ id, sort_order }]`

---

### List of changed files

| File | Change |
|------|------|
| `routes/tasks.js` | Add PUT /api/tasks/reorder |
| `public/js/tasks.js` | Update STATUS_ORDER/LABEL/NEXT; drag logic; status options of the new dialog |
| `public/css/style.css` | Add drag placeholder and highlight styles |

---

## 15. PWA Window Controls Overlay + header display mode switch

> Date: 2026-07-21

### Goals

1. The manifest enables `window-controls-overlay`, blending the header content (logo + user info) into the system title bar and saving 48px of vertical space
2. A new toggle button switches between "title bar mode" and "in-page header mode", and the preference is persisted in `localStorage`

---

### manifest changes

```json
"display": "standalone",
"display_override": ["window-controls-overlay", "standalone"]
```

> `display_override` takes precedence over `display`, and the browser picks the first supported mode in order; an environment that does not support overlay falls back to standalone automatically, with unchanged behavior.

---

### CSS adaptation (`style.css`)

CSS environment variables read the size of the system title bar area and only take effect in overlay mode:

```css
@media (display-mode: window-controls-overlay) {
  .header {
    position: fixed;
    top: env(titlebar-area-y, 0);
    left: env(titlebar-area-x, 0);
    width: env(titlebar-area-width, 100%);
    height: env(titlebar-area-height, 48px);
    -webkit-app-region: drag;          /* the whole header can be dragged */
    z-index: 1000;
  }
  /* buttons and avatar cannot be dragged */
  .header button,
  .header a,
  .header img,
  .header-mode-btn {
    -webkit-app-region: no-drag;
  }
  /* leave the header height at the top of the layout */
  .page-wrapper {
    padding-top: env(titlebar-area-height, 48px);
  }
}
```

---

### Toggle button

**Position**: at the right of the header, next to the log out button

**Icon**:
- Title bar mode (currently overlay): shows `⊡` (tuck into the title bar)
- Page mode (currently in the page): shows `⊞` (expand into the page)

**Logic**:
- Read / write `localStorage('header-mode')`, whose value is `'overlay'` or `'page'`
- `'page'` mode: `<html>` gets `class="header-page-mode"`, the CSS overrides the overlay media query and forces the header into the normal in-page flow layout
- `'overlay'` mode: remove that class and rely on `@media (display-mode: window-controls-overlay)` taking effect automatically

---

### List of changed files

| File | Change |
|------|------|
| `public/manifest.json` | Add `display_override` |
| `public/css/style.css` | Add the `@media (display-mode: window-controls-overlay)` adaptation; add the `.header-page-mode` override styles |
| `public/index.html` | The header gains a toggle button |
| `public/js/app.js` | Read localStorage on initialization and bind the toggle button logic |

---

## 18. Stronger highlight of the selected task on the left

> Date: 2026-08-07

### Goals

Make the currently selected task in the left task navigation easier to recognize visually, without changing task selection, dragging or status switching logic.

### Style plan

- The selected item uses a more noticeable light theme-color background, distinct from the ordinary hover state
- The accent bar on the left grows from 3px to 4px and uses the theme link color
- The text color of the selected item is raised to the main text color and made bold
- A light inset shadow is added, keeping the existing rounded corners and list layout
- Unselected tasks, the task status dots and the interaction behavior are not modified

### List of changed files

| File | Change |
|------|------|
| `public/css/style.css` | Strengthen the background, text, accent bar and shadow styles of `.task-nav-item.active` |

---

## 19. Grey overlay for unselected tasks

> Date: 2026-08-07

### Goals

In the left task list, add a translucent grey overlay to unselected task items, so the currently selected task stands out more visually.

### Style plan

- Unselected tasks `.task-nav-item:not(.active)` get `opacity: 0.55` as a whole, giving a greyed look
- On hover `opacity: 1` restores it, and the existing hover background is unchanged
- The selected item `.active` keeps the highlight styles strengthened in the previous section and is unaffected
- Layout, interaction and DOM structure are unchanged

### List of changed files

| File | Change |
|------|------|
| `public/css/style.css` | Add the `.task-nav-item:not(.active)` opacity rule and the hover restore |

### Risks and trade-offs

| Risk | Handling |
|------|------|
| Status dots / terminal badges are covered by the overlay too | They are dimmed as a whole, but users do not need the status of unselected items much; hover restores it |
| Too faint on the light theme | 0.55 stays readable on both light and dark themes, and can be adjusted per theme later if needed |



---

## 17. Terminal WebSocket automatic reconnect

> Date: 2026-08-05

### Background

Currently, after the terminal WebSocket disconnects, xterm only gets `[Connection lost, switch tasks to reconnect]` written to it, and the user has to switch away from the task's shell tab and back to reconnect. The experience is poor in scenarios such as a service restart or a network blip.

### Goals

- When the ws is disconnected not on purpose, reconnect automatically with exponential backoff, without user intervention
- After a successful reconnect, reuse the original xterm instance and replay the server's history buffer (consistent with the existing "switch task to reconnect" experience)
- When the user switches away from the task / the instance is explicitly destroyed, cancel the pending reconnect immediately, to avoid a dangling ws

### Reconnect strategy

| Element | Value |
|------|------|
| First reconnect delay | 1s |
| Backoff | Exponential backoff `delay = 1000 * 2^attempts` |
| Maximum delay | 30s |
| Maximum attempts | Unlimited (keep retrying until the ws succeeds or the instance is destroyed) |
| Trigger | `ws.onclose` and the instance was not explicitly destroyed |
| Cancel | The instance is removed from `termInstances` (`disposed = true`) |

### State machine

```
ws.open(OPEN)  ── onclose ──►  scheduleReconnect(delay)
       ↑                            │
       │                            ↓ (after delay)
       │                       connect() creates a new ws
       │                            │
       └──── onopen (success) ──────┘
                                    │
                              onclose (failure) ──► scheduleReconnect(delay*2)
```

### Implementation points

1. **Instance field extension**: the `inst` in `termInstances.set(task.id, inst)` gains:
   - `disposed: boolean` — whether the instance has been destroyed
   - `reconnectTimer: number | null` — the pending reconnect timer
   - `reconnectAttempts: number` — the number of reconnect attempts so far (reset to zero after onopen succeeds)

2. **Decouple the ws lifecycle from the terminal**:
   - `t.onData` / `t.onResize` are set once when the terminal is created and read `inst.ws` inside, so they are not registered again on every reconnect
   - `connect()` only handles the ws lifecycle and can be called many times

3. **Clear the screen + replay history before reconnecting**:
   - When `ws.onopen` fires and `reconnectAttempts > 0` (the reconnect case), first call `t.reset()` to clear the current content
   - The server sends `{ type: 'history', data }` on the new ws, and writing it into xterm restores the history
   - After a successful reconnect, append the notice `\x1b[32m[Reconnected]\x1b[0m`

4. **onclose handling**:
   - Check `inst.disposed` and `termInstances.get(task.id) === inst`, so an old ws of a destroyed instance does not trigger a reconnect by mistake
   - Write `\x1b[33m[Connection lost, reconnecting in {N}s...]\x1b[0m` (replacing the old "switch tasks to reconnect" text)
   - Compute the backoff delay, set `reconnectTimer`, and call `connect()` when it fires

5. **Silence onerror**: it used to write `[WebSocket connection failed]`; it is now left to `onclose`, so the error message and the reconnect notice are not duplicated

6. **Instance disposal path**: extract the helper `disposeTerminalInstance(taskId)` to handle in one place:
   - `inst.disposed = true`
   - `clearTimeout(inst.reconnectTimer)`
   - `inst.ws.close()`
   - `inst.term.dispose()`, `inst.el.remove()`
   - `termInstances.delete(taskId)`
   - If the current `termTaskId === taskId`, clear the global `term`/`fitAddon`/`termWs`/`termTaskId`
   - The old-instance cleanup inside `connectTerminal` and any future page-unload logic reuse this function

7. **Background tasks reconnect automatically too**: a task ws that is not currently displayed also triggers a reconnect when it drops, so it is ready when the user switches back, with no waiting

### List of changed files

| File | Change |
|------|------|
| `public/js/tasks.js` | Refactor `connectTerminal`: extract `createTerminalInstance` and `disposeTerminalInstance`; decouple the ws lifecycle from the terminal; `onclose` now schedules `connect()` with exponential backoff; `onopen` calls `t.reset()` first in the reconnect case; remove the fixed "switch tasks to reconnect" text |

### Risks and trade-offs

| Risk | Handling |
|------|------|
| An expired session makes reconnecting fail | The cause of failure is currently not distinguished, so it keeps retrying at 30s intervals. Refreshing the page lets the user log in again. Later, the ws close code can be used to tell a 401 apart, stop reconnecting and show a hint |
| Clearing the screen on reconnect loses the scrollback | Consistent with the existing "switch task to reconnect" experience (the old instance is destroyed, the new instance replays the history buffer), which users are used to |
| Many background tasks reconnecting together may briefly overload the server | The backoff naturally spreads the reconnect times; in the single-user scenario the number of tasks is limited, so there is no significant pressure |

---

## 20. Multiple content tabs and the to-do list for a task

> Date: 2026-08-13

### Goals

- Rename the original "Document" tab to "Design doc"
- Add `README` and `AGENTS.md` Markdown preview tabs
- Add a "To-do" page that is isolated per task and persisted in SQLite
- Keep the existing terminal tab and the per-task tab memory

### Tab to file mapping

| Tab | Data source |
|------|----------|
| Design doc | `task.md_path` |
| README | `task.work_dir/README.md`, or the directory of the design doc when there is no `work_dir` |
| AGENTS.md | `task.work_dir/AGENTS.md`, or the directory of the design doc when there is no `work_dir` |
| To-do | SQLite `task_todos` table |
| Terminal | The existing WebSocket PTY session |

The to-do tab keeps the full document toolbar, retaining the "Open folder / Open in VSCode / Share" buttons and the toolbar height, so the content area does not jump up and down when switching tabs.

When a task is created, four documents are always guaranteed to exist: the design doc `DESIGN.md` (`task.md_path`), `README.md`, `AGENTS.md` and `CLAUDE.md`. When only a title is entered, the task directory and these four standard documents are created; when a design path is specified manually, the file name the user specified is kept and the missing `README.md`, `AGENTS.md` and the `CLAUDE.md` that references the main rules are filled in the current Task directory. Existing files are always kept and never overwritten. For an existing task whose file does not exist, the page still offers an explicit create button.

### Data model

```sql
CREATE TABLE IF NOT EXISTS task_todos (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL,
  content    TEXT NOT NULL,
  completed  INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
```

### API

| Method | Path | Description |
|--------|------|------|
| GET | `/api/tasks/:id/document/:kind` | Read a `technical/readme/agent` document |
| POST | `/api/tasks/:id/document/:kind` | Create a missing `README.md` or `AGENTS.md` |
| PUT | `/api/tasks/:id/document/:kind` | Save the Markdown content of a `technical/readme/agent` document |
| GET | `/api/tasks/:id/todos` | Get the task's to-dos |
| POST | `/api/tasks/:id/todos` | Add a to-do |
| PUT | `/api/tasks/:id/todos/:todoId` | Update the content or completion state |
| DELETE | `/api/tasks/:id/todos/:todoId` | Delete a to-do |

### Online Markdown editing

- The toolbars of the design doc, `README.md` and `AGENTS.md` gain an "Edit" button
- Uses Microsoft's official Monaco Editor (the same editor as VS Code), with the VS Code light theme, Markdown syntax highlighting, line numbers, auto-closing brackets and soft wrapping
- Uses Monaco's native VS Code shortcuts, the find / replace panel, multiple cursors and column selection, and only additionally binds `Cmd/Ctrl+S` to the application's Markdown save endpoint
- Monaco 0.56.0 uses the ESM package as its source, is built with esbuild, and the main-thread and worker resources are hosted locally, avoiding CDN and worker cross-origin problems
- When a document has unsaved changes, confirmation is required before switching tasks or tabs
- New `PUT /api/tasks/:id/document/:kind` writes the corresponding Markdown after the task ownership check, with a limit of 5MB per document

All endpoints first check task ownership against the currently logged-in user.

---

## 21. Update check and remote service tasks

> Date: 2026-08-14
> Status: design only, not implemented yet

### 1. Background and goals

The application currently only manages tasks in the local SQLite and files on this machine. The new design wants to add:

1. **GitHub version check**: periodically read a GitHub `VERSION.json` link fixed on the server, compare the local and remote versions, and pop up a reminder when a higher version is found.
2. **Connect peer instances**: after starting, every torin-x-web instance is both a local client and a remote server that other instances can connect to.
3. **Unified task navigation**: the left sidebar is clearly divided into "Local tasks" and "Remote services", with the tasks of each remote service shown under it.
4. **Keep the data boundary**: local tasks still use the local DB / files; the DB, documents and terminals of remote tasks are always managed by the corresponding remote service.

### 2. Scope and non-goals

#### Scope of this design

- Configure several peer service instances through URL, port and Token, with connection testing, enabling / disabling and removal
- The remote task list, design doc, README, AGENTS.md and to-do list
- Creating, editing, status transitions and deleting of remote tasks
- Periodic query of the GitHub version link, an immediate manual check, a new-version dialog, and updating the local service after confirmation

#### Not in the first phase

- Automatic two-way sync or merging of local and remote tasks
- Modifying remote tasks offline and uploading them later
- Dragging tasks across servers to migrate them
- Updates without human confirmation; every update needs the user to confirm in the dialog
- Third-party task platforms (GitHub Issues, Linear, Jira and so on)

### 3. Core principles

1. **The browser never connects to the remote directly**: all remote requests are proxied by the local Express, which avoids CORS and does not expose the remote Token to the frontend.
2. **Never copy as a local task**: a remote task is a remote resource accessed live and is not written into the local `tasks` table.
3. **Show the source explicitly**: a task identity must be `(source, serverId, taskId)`, not just the numeric `id`.
4. **The Token decides permissions**: the connection form does not set permissions again; the actual capability is decided by the remote Token scope and the server switches.
5. **Query automatically, update manually**: reading the fixed GitHub version link may run periodically on its own; Git fetch, changing local code, installing dependencies, migrating the DB and restarting must be confirmed by the user.
6. **Symmetric peer roles**: the same program mounts both the local Session API and the Token-authenticated remote API, and there is no separate "client edition" or "server edition".

### 4. Left sidebar information architecture

```text
Left task bar
├─ Local tasks                      [ + ]
│  ├─ Personal tasks
│  ├─ In progress
│  ├─ To do
│  └─ Done
└─ Remote services                  [ + Connect ]
   ├─ ● Home Mac                          [ ⋯ ]
   │  ├─ Personal tasks
   │  ├─ In progress
   │  ├─ To do
   │  └─ Done
   └─ ○ Office server (offline)          [ Retry ]
```

#### Display conventions

- The first-level areas "Local tasks" and "Remote services" are collapsible, and the collapsed state is saved per user.
- Each remote service shows its connection state: online, checking, offline, authentication expired, version incompatible.
- A remote task entry shows a cloud marker, and a tooltip shows the server name.
- The "New task" button acts on the currently selected task source; if no remote service is selected, the task is created locally by default.
- Dragging across local / remote or across servers is forbidden in the first phase, and the cursor shows it cannot be dropped.
- When a remote service is temporarily unavailable, the last task list snapshot is kept, but the whole group is greyed out and marked "not live".

### 5. Flow for connecting a remote service

#### Connection form

| Field | Description |
|------|------|
| URL | Host or domain, for example `https://tasks.example.com` or `http://192.168.1.20` |
| Port | The listening port of the remote torin-x-web, for example `14002` |
| Token | The access Token issued by the remote instance, entered only when adding or replacing |

The user only needs to provide the three items above. The server display name is generated automatically from the `instance_name` returned by `/capabilities`, the hostname or the URL, and the user may optionally change it to an alias after connecting successfully. Read / write / terminal capabilities are not chosen separately in the form and follow the Token scope.

#### Connection test

```text
The user enters URL + port + Token
    ↓
The local instance assembles and validates the base URL
    ↓
GET <remote>/api/remote/v1/capabilities
Authorization: Bearer <token>
    ↓
Verify the service identity, API version and Token scope
    ↓
Save the connection → load the task snapshot for the first time
```

When the connection fails the plaintext Token is not saved, and only an actionable error category is returned: DNS/timeout, TLS failure, 401 invalid Token, 403 insufficient scope, API version incompatible.

### 6. System architecture

Every running torin-x-web instance has two roles at once:

- **Client role**: manages local tasks with the current browser session, and connects to other instances with saved Tokens.
- **Remote server role**: listens on the same URL/port and offers the `/api/remote/v1/*` Token API to other instances.

```text
Instance A (currently open in the browser)
  ├─ Web UI + Session API ──► A's SQLite / files / PTY
  ├─ Remote Client ── Token ──────────┐
  └─ Remote Server `/api/remote/v1/*`        │
                                                ▼
Instance B
  ├─ Web UI + Session API ──► B's SQLite / files / PTY
  ├─ Remote Client
  └─ Remote Server `/api/remote/v1/*` ◄──┘
```

A can connect to B, and B can connect back to A; the Tokens and permissions of the two connections are independent. Requests are not forwarded further in a cascade: accessing B from A only shows B's local tasks and does not expose instance C that B has connected, which avoids loops and permission spread.

#### Why the frontend does not connect to the remote directly

- The Token never enters `localStorage`, the DOM or browser request logs.
- CORS does not need to be opened on the remote service.
- The local backend can implement timeouts, server identity verification and error redaction uniformly.
- The frontend only handles a unified local / remote task view model.

### 7. Local data model

#### `remote_servers`

```sql
CREATE TABLE remote_servers (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id             TEXT NOT NULL,
  name                TEXT NOT NULL,
  base_url            TEXT NOT NULL,
  port                INTEGER NOT NULL,
  token_ciphertext    TEXT NOT NULL,
  token_iv            TEXT NOT NULL,
  token_auth_tag      TEXT NOT NULL,
  enabled             INTEGER NOT NULL DEFAULT 1,
  remote_instance_id  TEXT,
  api_version         TEXT,
  remote_app_version  TEXT,
  last_status         TEXT NOT NULL DEFAULT 'unknown',
  last_error_code     TEXT,
  last_checked_at     DATETIME,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, base_url, port)
);
```

The Token is encrypted with AES-256-GCM, and the key comes from the separate `REMOTE_CREDENTIALS_KEY` environment variable and does not reuse `SESSION_SECRET`. When the API returns connection settings it never returns the Token or the ciphertext fields.

#### `remote_task_snapshots`

```sql
CREATE TABLE remote_task_snapshots (
  server_id       INTEGER NOT NULL,
  remote_task_id  TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  remote_revision TEXT,
  fetched_at      DATETIME NOT NULL,
  PRIMARY KEY (server_id, remote_task_id),
  FOREIGN KEY (server_id) REFERENCES remote_servers(id) ON DELETE CASCADE
);
```

A snapshot is only used to show the task list offline and is not an editable offline copy. By default the full Markdown text, terminal history and Token are not cached.

#### GitHub version check state

The update state is per instance rather than per user, because all logged-in users share the same service code. The state can live in a singleton `system_state` table or a separate JSON:

```text
github_version_url     https URL       # the fixed GitHub VERSION.json link
git_remote             origin          # only used after an update is confirmed
git_branch             main            # only used after an update is confirmed
update_check_interval  1800            # 30 minutes by default
update_last_checked_at datetime
update_local_version   semver
update_remote_version  semver
update_manifest_etag   text
update_manifest_mtime  text             # GitHub Last-Modified
update_status          idle | checking | current | available | local_newer | blocked | updating | failed
update_error           safe error code
update_notice_version  semver           # the remote version already shown in a dialog
```

### 8. Remote service API protocol

A separate versioned namespace `/api/remote/v1` is created, and the existing Session API is not exposed directly.

#### Endpoint overview

| Method | Path | Scope | Description |
|--------|------|-------|------|
| GET | `/api/remote/v1/capabilities` | `server:read` | Instance ID, app / API versions, features and scopes |
| GET | `/api/remote/v1/tasks` | `tasks:read` | Remote task list, supports `updated_since` |
| POST | `/api/remote/v1/tasks` | `tasks:write` | Create a remote task |
| GET | `/api/remote/v1/tasks/:id` | `tasks:read` | Task details and revision |
| PUT | `/api/remote/v1/tasks/:id` | `tasks:write` | Update a task, which must carry the revision |
| DELETE | `/api/remote/v1/tasks/:id` | `tasks:write` | Delete a remote task |
| GET/PUT | `/api/remote/v1/tasks/:id/documents/:kind` | `docs:read/write` | `technical/readme/agent` documents |
| GET/POST/PUT/DELETE | `/api/remote/v1/tasks/:id/todos...` | `todos:read/write` | To-do CRUD |
| WS | `/api/remote/v1/tasks/:id/terminal` | `terminal` | Remote PTY, which must be enabled separately |

#### Task view model

The frontend normalizes local and remote tasks into:

```json
{
  "key": "remote:12:task:87",
  "source": "remote",
  "server_id": 12,
  "server_name": "Home Mac",
  "id": "87",
  "title": "Example",
  "status": "doing",
  "priority": "normal",
  "due_date": null,
  "capabilities": {
    "write": true,
    "documents": true,
    "todos": true,
    "terminal": false
  },
  "revision": "2026-08-14T09:20:11.123Z:4",
  "stale": false
}
```

### 9. Local proxy API

The frontend only calls local endpoints:

| Method | Path | Description |
|--------|------|------|
| GET/POST | `/api/remote-servers` | List / add a connection |
| PUT/DELETE | `/api/remote-servers/:id` | Verify the new address with the saved Token and then modify / remove the connection |
| POST | `/api/remote-servers/test` | Test a connection before saving |
| POST | `/api/remote-servers/:id/test` | Test a new address that is about to be changed, with the saved Token |
| POST | `/api/remote-servers/:id/check` | Check the given service again |
| GET | `/api/remote-servers/:id/tasks` | Get remote tasks through the local proxy |
| `*` | `/api/remote-servers/:id/tasks/:taskId/...` | Proxy task, document and to-do operations |
| GET | `/api/system/version` | Current app / API / schema versions and the Git commit |
| GET | `/api/system/update-status` | The latest GitHub version check result and update progress |
| POST | `/api/system/check-update` | Request the fixed GitHub version link now and compare versions |
| POST | `/api/system/apply-update` | Update the local service after confirmation and trigger a controlled restart when done |

`check-update` can be open to ordinary logged-in users, while `apply-update` must require instance administrator rights and a second confirmation, so that no arbitrary registered user can restart the whole service.

The proxy must implement:

- Only requests to the `base_url` configured in the DB are allowed; the frontend must not pass an arbitrary target URL.
- Connect and read timeouts, request cancellation, and bounded retries with exponential backoff.
- Filter hop-by-hop headers, and never pass through cookies, the local session or internal error stacks.
- Limit the response body and Markdown size, so a remote service cannot exhaust memory.
- Prevent SSRF: the resolved address, redirect targets and DNS rebinding are all checked again; accessing private-network addresses needs the user to enable it explicitly.

### 10. Remote authentication and Token management

The remote service does not reuse the browser session and adds a Personal Access Token:

```text
Token format: txw_<public-id>_<secret>
The DB stores only a scrypt/Argon2id hash of the secret
Token scope:
  server:read
  tasks:read | tasks:write
  docs:read  | docs:write
  todos:read | todos:write
  terminal
```

Management requirements:

- A Token is shown only once when it is created, can have an expiry time and a name, and can be revoked at any time.
- Every request records the Token ID, user, scope, target resource and result, without recording the secret or the full document text.
- A connection name is bound to the Token's owner, and tasks of other remote users cannot be accessed.
- The terminal scope is not granted by default, and a remote server can disable Remote PTY globally.

### 11. Concurrency and conflict handling

- Remote task / document returns a `revision` or `ETag`.
- On update the local proxy passes `If-Match` / the revision.
- When the remote content has changed it returns `409 Conflict` or `412 Precondition Failed`.
- The frontend does not overwrite directly; for Markdown it shows "Reload / Copy local changes / View differences".
- To-dos are conflict-checked by individual ID and `updated_at`.

### 12. Remote terminal plan

A remote terminal is riskier than reading and writing tasks, so it is suggested for the third phase:

```text
Browser xterm
  ↔ local WebSocket /terminal/remote/:serverId/:taskId
  ↔ remote WSS /api/remote/v1/tasks/:id/terminal
  ↔ remote PTY
```

- The local service only proxies the byte stream in both directions, and the Token is never sent to the browser.
- Remote terminal output is not persisted in the local SQLite; history is managed by the remote.
- Heartbeats, message size, the number of concurrent sessions and the idle time must be limited.
- On reconnect, sessions must be told apart by `(serverId, taskId)` and never mixed with local task IDs.

### 13. Update check design

#### Version information

`VERSION.json` is added in the repository root as the only release information source for the application version and protocol compatibility. `package.json.version` is kept equal to `VERSION.json.app_version` in the release flow, but at run time `VERSION.json` is authoritative.

```json
{
  "app_version": "1.0.0",
  "api_version": 1,
  "schema_version": 1,
  "min_remote_api_version": 1,
  "max_remote_api_version": 1,
  "published_at": "2026-08-14T12:00:00Z",
  "release_url": "https://github.com/owner/repository/releases/tag/v1.0.0"
}
```

Field description:

| Version | Purpose |
|------|------|
| `app_version` | The application release version, semantic versioning, for example `1.4.0` |
| `api_version` | The remote API protocol version, for example `1` |
| `schema_version` | The SQLite migration version, for example `7` |
| `min_remote_api_version` | The lowest remote API version this client can connect to |
| `max_remote_api_version` | The highest remote API version this client can connect to |
| `published_at` | Optional, the release time of the version, used for display in the UI |
| `release_url` | Optional, the matching GitHub Release page, used to view the release notes |

`GET /api/system/version` returns the current version, the build commit, the build time and the supported range of remote API versions.

#### Comparing the local and GitHub versions

The periodic check does not run `git fetch`. The local side reads the version file at the root of the deployment directory, and the remote side is read through a fixed GitHub HTTPS link configured on the server:

```text
Local version: read VERSION.json in the workspace root
Remote version: GET https://raw.githubusercontent.com/<owner>/<repository>/<branch>/VERSION.json
```

A fixed GitHub Contents API address may also be used, but one instance can only configure one trusted version source. The address comes from the deployment configuration or an environment variable, is shown read-only by the frontend, and no check endpoint may accept a temporary URL. For a public repository the Raw link is preferred; if a private repository needs a GitHub Token, it can only be read from the server environment and the logs must be redacted.

Decision rules:

| Condition | Result |
|------|------|
| `remote.app_version > local.app_version` | An update is available, show a reminder dialog |
| `remote.app_version = local.app_version` | Already up to date, no update reminder is shown |
| `remote.app_version < local.app_version` | The local version is newer, downgrading is not allowed |
| The local or remote `VERSION.json` does not exist / is invalid | The update check fails and updating is not allowed |
| The remote version is higher | Show the available version; after the user clicks update, run the Git safety pre-check |

`app_version` must be strict SemVer and compared with a semver library, never as strings. `api_version` and `schema_version` are not used to decide "is there a new version", but are used for compatibility and migration checks in the update pre-check stage.

The periodic check relies only on the GitHub `VERSION.json.app_version` and does not try to discover commits whose version number was not raised. So the release flow must make sure the version number is raised before releasable code is merged into the target branch.

#### GitHub version source and periodic query

The current instance checks for updates with a fixed GitHub `VERSION.json` link. The version link and the Git remote/branch actually used for updating are both configured on the server, and the frontend cannot pass an arbitrary URL, remote, branch or command.

```text
Timer fires (every 30 minutes by default)
    ↓
Read the local VERSION.json
    ↓
Send If-None-Match / If-Modified-Since
GET <configured-github-version-url>
    ↓
Compare app_version with semver
    ↓
The remote version is higher
  → notify the frontend; update capability is pre-checked after the user confirms
The remote version is the same
  → no formal update
```

- The periodic check only sends a read-only HTTPS request and reads the local version file; it does not call Git and does not modify the workspace.
- The first check runs 30 seconds after start-up, then every 30 minutes by default, configurable from 5 minutes to 24 hours.
- Only one check can run at a time; a manual check reuses the task that is already running.
- The HTTP request has a default timeout of 10 seconds and a response body limit of 16 KiB; only HTTPS and the GitHub domains on the server's allowlist are permitted, and the target is checked again after a redirect.
- ETag/`If-None-Match` and Last-Modified/`If-Modified-Since` are used, and when GitHub returns `304` the remote version that passed validation last time is reused.
- The response is checked for a JSON schema, strict SemVer and field lengths; on errors only a safe error code is saved, never credentials or the full response.
- The local / remote versions, the version link, the release time, the Release link and the last check time are recorded; commit differences are not computed during the periodic check.

#### Application update flow

After the user clicks "Update now", the server runs the following flow:

```text
Acquire the global update lock
    ↓
Request the GitHub VERSION.json again and confirm the remote version is still higher
    ↓
git fetch --prune <configured-remote> <configured-branch>
    ↓
Pre-check: the target branch's VERSION.json matches the GitHub check result, a Git repository, remote/branch, clean working tree, only a fast-forward path exists
    ↓
Record previous_commit
    ↓
git merge --ff-only <remote>/<branch>
    ↓
npm ci
    ↓
npm run build:monaco
    ↓
Run the DB migration and a quick self-check
    ↓
Write the restart marker and ask the supervisor for a controlled restart
```

Mandatory pre-check rules:

- After the fetch, the `VERSION.json.app_version` in `<remote>/<branch>` must equal the version just obtained from the GitHub link; if they differ the update is blocked, avoiding caching, branch or version-link misconfiguration.
- When tracked files have modifications (`git status --porcelain --untracked-files=no` is non-empty) the update is forbidden, the dialog says "Local uncommitted changes" and the details list the file names (`trackedChanges` / `dirtyError` in `lib/git-update-workspace.js`); nothing is stashed, reset or discarded automatically. Untracked files do not block the update: `git merge --ff-only --no-overwrite-ignore` refuses on its own when a same-named file conflicts; a forced update still backs untracked files up to the stash as well.
- When the current branch is ahead or diverged the update is forbidden, with no automatic rebase/merge.
- The update process must not write the DB schema in parallel, so it needs a maintenance state and a global lock.
- When any of npm/build/migration/self-check fails, the new version is not started automatically; `previous_commit` and the logs are kept and recovery guidance is shown to the user.
- Before a database migration, a timestamped SQLite backup is created; rolling back the code does not roll back the DB automatically, so schema migrations must be backward compatible as far as possible.
- The restart does not rely on the old Node process "restarting itself" but is brought back up by a supervisor such as LaunchAgent/systemd/PM2.

#### UI interaction

- The settings dialog gains "Check for updates": the read-only GitHub version link, the local / remote `app_version`, the release time, the Release link, the check interval, the last check time and "Check now".
- When the periodic query finds a higher remote `app_version`, a dialog is shown once for each remote version, and the small blue dot on the settings button is kept.
- The dialog shows local→remote version, the release time and an entry to the release notes, with the buttons "Remind me later" and "Update now"; the Git branch, working tree and fast-forward state are shown in the pre-check stage after "Update now" is clicked.
- An explicit confirmation is asked again before "Update now"; during the update the stage and a log summary are shown, and the frontend polls the update status.
- A non-administrator only gets the hint "There is a new version, please contact the administrator" and no "Update now" button is shown.
- While the service restarts the page shows "Restarting" and requests the health endpoint periodically; once the new process is ready it refreshes automatically.
- Result states: up to date, update available, local changes, branch diverged, check failed, update failed, restarting, update complete.

#### Version release rules

- Every time a releasable version is about to be published to the tracked branch, `VERSION.json.app_version` must be raised first.
- When the remote API protocol changes, raise `api_version` and maintain the minimum / maximum compatible versions as well.
- When a change includes a SQLite schema change, raise `schema_version` and provide the matching ordered migration.
- CI / the release check verifies the `VERSION.json` schema, SemVer validity, the consistency of `package.json.version`, and that the version number has really been raised when code is released.

### 14. Caching, refresh and failure degradation

- Tasks are loaded when a remote service is expanded; expanded services are refreshed lightly every 60 seconds, paused while the page is not visible.
- The user can click the refresh button next to a server to retry immediately.
- On a 429 or 5xx from the remote, back off exponentially; write requests are never retried automatically.
- The suggested snapshot TTL is 7 days; beyond the TTL only "server offline" is shown and the old tasks are no longer displayed.
- When a selected remote task goes offline, the content already loaded stays read-only and the top of the page shows "Connection lost".

### 15. Security requirements

| Risk | Design measure |
|------|----------|
| SSRF | Target URL allowlisting; DNS/redirect rechecks; private networks must be enabled explicitly |
| Token leak | Encrypted storage on the backend; never returned to the frontend; redacted logs |
| Man in the middle | HTTPS is enforced in production; no "ignore TLS errors" option is offered |
| Privilege escalation | A PAT is bound to the user and scope; the remote checks task ownership again |
| Write conflicts | revision/ETag + `If-Match`, never silently overwritten |
| Malicious remote responses | Size / timeout limits; field schema validation; sanitizing before Markdown rendering |
| Remote PTY abuse | Separate scope, a global switch, session limits and audit logs |
| Malicious version link or response | The URL is fixed by the server; only HTTPS and trusted GitHub domains are allowed; redirects are rechecked; timeout / size limits; strict JSON schema validation |
| Malicious Git update | The remote/branch is fixed by the server; only fast-forward is allowed; updates need human confirmation; signed commits / tags can optionally be verified |
| An update overwriting local changes | Modified tracked files block immediately and the files are listed; untracked files rely on git's same-name protection when merging; no automatic stash/reset/rebase |
| Failing to start after an update | Staged state for dependencies / build / migration / self-check; SQLite backup; the previous commit is recorded; the supervisor handles the restart |

### 16. Performance and observability

- A single remote request has a default timeout of 8 seconds and a document request 15 seconds, with a safe upper limit on timeout values.
- Server status checks may run in parallel, but a global concurrency limit is set so that start-up does not stress several remotes at once.
- Record `server_id`, the route, duration, status code and error category, but not the Token, passwords, terminal content or the full Markdown text.
- The connection management page shows the last check time and the last error type, for self-service diagnosis.

### 17. Phased implementation plan

#### Phase 1: peer service protocol and read-only remote tasks

1. Introduce the app/api/schema versions and a SQLite migration mechanism.
2. Implement the PAT and `/api/remote/v1/capabilities`.
3. Enable Remote Client/Server on every instance, and implement URL + port + Token connection, encrypted storage and testing.
4. Add local / remote sections to the left sidebar.
5. Load remote tasks, the three Markdown documents and to-dos read-only.
6. Implement snapshots and offline degradation.

#### Phase 2: GitHub version check and controlled update

1. Add and validate `VERSION.json`, request the fixed GitHub link periodically, compare SemVer, and implement the ETag cache and a singleton lock.
2. The new-version dialog, remind-me-later, manual check and update status polling.
3. Working tree / divergence / fast-forward pre-checks, SQLite backup and a controlled update pipeline.
4. Agree on restarting and health checks of the new process with LaunchAgent/systemd/PM2.

#### Phase 3: remote write operations and the terminal

1. Read / write scopes for tasks, Markdown and to-dos, with revision/ETag conflict handling.
2. A separate terminal scope and a server-side master switch.
3. A two-way WebSocket proxy, rate limiting, auditing, reconnection and end-to-end tests.

### 18. Acceptance criteria

#### Remote connections

- Several remote services can be added, and online, offline, authentication expired and incompatible are clearly told apart.
- The remote Token does not appear in browser network traffic, the DOM, localStorage or frontend errors.
- The behavior of local tasks in the left sidebar is unaffected by remote service failures.
- When a remote is offline, an unexpired snapshot can be viewed but not edited.
- A local task cannot be dragged into a remote, and ordering across remote servers is not possible.

#### Update check

- The periodic check reads `VERSION.json.app_version` through the fixed GitHub link and correctly decides up to date, new version available, local newer and check failed.
- A dialog is shown only once for the same remote version, and a higher version arriving can remind again.
- GitHub timeouts, untrusted redirects, oversized responses, illegal JSON or illegal SemVer all fail safely and never enter the update flow.
- After the user confirms the update, it only continues when the Git target branch version matches the GitHub version and a fast-forward is possible.
- When the working tree has modifications or the branch has diverged, the update is blocked and no file is discarded.
- After user confirmation, fast-forward, dependencies, build, migration, self-check and a controlled restart can complete.
- A failure in any stage has a clear state and recovery information, and a new version that fails the self-check is not served.

### 19. Decisions to confirm

| Decision | Recommended default | Alternative |
|--------|----------|------|
| Remote service type | Only torin-x-web instances are supported | Abstract third-party providers, which raises complexity significantly |
| Connection form | URL + port + Token | Extra display name and permission options (unnecessary) |
| Remote permissions in the first phase | Show whatever the Token allows, with the Phase 1 UI still read-only | Open read and write directly in the first phase |
| Remote terminal | Developed separately in Phase 3 | Opened together with remote tasks in the first phase |
| Version file | `VERSION.json` in the root, the only version source at run time | Use only `package.json.version`, which cannot express API/schema compatibility at the same time |
| Remote version source | The fixed GitHub Raw `VERSION.json` link on the server | The fixed GitHub Contents API link, suitable for private repository authentication |
| Git update target | `origin/main` tracked by the current branch | Configure remote/branch through environment variables |
| Check interval | First check 30 seconds after start-up, then every 30 minutes | Configurable from 5 minutes to 24 hours |
| Update behavior | Run the full pipeline and restart after confirmation in a dialog | Only prompt and let the user run the commands by hand |
| Private-network HTTP | Allowed only in development mode | Enabled in the connection settings after a high-risk confirmation |

### 20. Expected scope of changes (implementation phase)

| Area | Expected change |
|------|----------|
| DB | Schema migration, `remote_servers`, `remote_task_snapshots`, PATs and user settings |
| Server | Every instance enables the remote client/server, the local proxy, credential encryption and the Git scheduler / update pipeline |
| Frontend | A tree of task sources on the left, connection management, a unified task key, remote error / conflict UI |
| Terminal | Remote WebSocket proxy and permission isolation (Phase 3) |
| Release | `VERSION.json`, app/api/schema versions, Git remote/branch conventions, migrations, supervisor restart conventions |
| Tests | Version file schema / SemVer, local / remote version comparison, protocol contract, SSRF / Token leaks, Git behind/ahead/diverged, dirty working tree, pipeline failure and restart |

### Agent rule file compatibility

New tasks create `AGENTS.md` and `CLAUDE.md` by default, and the latter references the main rules through `@AGENTS.md`. An existing `CLAUDE.md` keeps its content and gets the reference added. Existing tasks are migrated at start-up: when only `AGENT.md` exists it becomes `AGENTS.md`; when both exist `AGENTS.md` is kept and `AGENT.md` is deleted. An old explicit `AGENT.md` path is migrated as well, other custom rule paths are left as they are, and the working directory still gets the standard rule entry points. A working directory that cannot be accessed records an error and is retried at the next start-up, and an old directory that no longer exists is not recreated. Remote projects are migrated after the corresponding Engine is updated and started.

### Test environment and current layout checks

The full test run includes real Chromium regressions; Playwright, xterm 5.5 and Fit 0.10 are locked as dev dependencies, and Chromium is installed after `npm ci --include=dev`. The browser scripts all support `CHROME_PATH`. The layout regressions check the safe-area and installed-app window rules of the current shared `style.css` and no longer refer to the removed `mobile.css`.

### Task file panel (v2.11.0)

A "File browser" was added to the content toolbar; after it automatically selects the task terminal, it unfolds downward. By default it takes 85% of the available height below the toolbar, its bottom edge can be adjusted between 20% and 90%, and on a narrow height it gives priority to keeping the terminal usable; no draggable floating window or modal mask is used. The original content tabs are hidden for now, the terminal is truly resized into the remaining area, the function keys at the bottom are hidden in compact mode, and the shell and connection stay unchanged. The directory tree and the Monaco file tabs are separate modules that isolate models by the task / Engine / path combination, and unsaved content is dealt with first when switching context.

The file service is shared by the local `/api/tasks/:id/files`, the Engine `/v1/tasks/:id/files` and the matching Client remote proxy. The root GET lists directories in pages, GET/PUT `/content` reads and saves, POST creates, PATCH renames and DELETE deletes. A save carries the file revision, a conflict is HTTP 409, and the client sends force only after an explicit confirmation. Paths are only accepted relative to the working directory, the root cannot be modified and symbolic links are never followed. UTF-8 text is limited to 5 MiB, keeping the BOM, line endings and permissions.

File access re-checks the inode and realpath of the directory chain and the identity of the opened file, and a save writes a temporary file in the same directory and then replaces. It is not a security sandbox against malicious local processes: Node's path-based create, rename and delete operations still have a race gap before the final system call, and cannot defend against the same system user continuously replacing a parent directory.

The Engine advertises and validates `files:read` and `files:write`; existing standard-role credentials are compatible with the new capabilities, and custom restricted scopes are not widened automatically. The endpoints are a compatible addition and do not change the database schema or the API major version. Directories are expanded on demand with 200 entries per page; every asynchronous result checks the current context, and a failed save or a conflict keeps the draft. Files and directories are confirmed before deleting, and rename / delete update the opened files accordingly.

Regressions include service and local / Engine / proxy endpoint tests, real Monaco file editing, simultaneous terminal input, panel resizing, task-switch protection and the registration of common languages. Building Monaco also generates the JSON worker.

## Client OSS terminal image upload

The Client stores OSS configuration isolated per user, reusing `system_state` and the AES-GCM encryption based on `SESSION_SECRET`, without changing the database structure. `/api/oss/config` provides reading, writing and deleting the configuration, and a read never returns the Secret; `POST /api/oss/upload-policy` (`{ type, size }`) signs an OSS V4 form-upload policy and returns `{ host, fields, url, expiresAt }`: the policy allows exactly one randomly generated object key, one `Content-Type` (png / jpeg / gif / webp), `Content-Disposition: inline`, a `content-length-range` of exactly the announced size (up to 10 MiB) and is valid for 5 minutes; the signature is the V4 HMAC chain over the base64 policy, checked in tests against `ali-oss`'s `signPostObjectPolicyV4`. The browser POSTs the form to the bucket itself (`public/js/oss-direct.js`, shared by the desktop and the phone page), so image bytes never pass through the Client and the AccessKey secret never leaves it; the earlier `POST /api/oss/images` (the Client received the image and put it to OSS) was removed. The real file type is now checked in the browser from the first bytes (the server cannot see the bytes any more); OSS enforces the type and size of the policy. The bucket needs a CORS rule that allows `POST` from the page's origin; a blocked or failed request is reported with a message that names it, and an OSS error response shows its code. The endpoints keep the Client's authentication and same-origin protection, and no configuration or credential is exposed on the Engine. The default signed read URL is valid for 24 hours, and a public HTTPS address is optional.

Local and remote xterm instances reuse the image upload controller; ordinary text pasting keeps its original behavior. Image pasting and the select button at the bottom enter the same upload flow, a full-page mask locks pointer, keyboard and focus operations; the progress reflects the browser's transfer to OSS, the processing state stays while OSS finishes, and the lock is released and the URL filled in only after OSS accepted the upload. Filling in does not trigger Enter, the state of the original instance is still checked when the async work completes so nothing is written into another terminal, and a failure or timeout restores page operation.

### Explicit intranet HTTP sessions

The Client uses a unified cookie policy and keeps requiring HTTPS for remote access in production by default; only `CLIENT_ALLOW_HTTP=true` explicitly allows HTTP to store the login session, and HTTPS requests always use a Secure cookie. This setting does not change the authenticator, the same-origin check, task permissions or WebSocket authentication, and it does not choose to trust automatically by source IP.

### Bounded terminal restore and on-demand history

The terminal service maintains a headless xterm state synchronized with the PTY output / size, and uses a serialized snapshot to restore the current screen, modes and the latest 500 lines of scrollback. On connect the entire persisted buffer is no longer sent to the browser; the snapshot restore and the live output are delivered in order, so no data is lost or duplicated during asynchronous parsing. The raw log format on disk and its retention limit are unchanged. The headless xterm and the serialize addon are pinned to compatible versions; for the full-screen modes and cursor state the addon does not cover, restore sequences are added and verified with a real parser. When the server process restarts, the state is rebuilt from the retained log, and control context that was already discarded because it exceeded the retention limit cannot be restored.

The initial WebSocket `history` frame keeps the `data` field and carries the snapshot size and optional `archive` metadata. The archive is pinned to the log snapshot of this connection, and a plain-text page of at most 500 lines and 128 KiB is returned only when the browser explicitly requests `history-page`. The request is bound to the connection, the archive ID and a cursor, and inherits the terminal authentication; control frames must never fall into the PTY input. An old Client can still restore the initial data, and a new Client does not request paging from an old Engine without archive metadata.

The Client shares one history controller, keeping the input / OSC52 suppression and the scroll-position handling during replay; earlier logs are shown in a separate read-only window, inserted through text nodes, without replaying ANSI control sequences. Paging does not block the live main terminal, and pending requests are cleaned up when switching tasks, on disconnect and when releasing an instance, so history cannot mix into another terminal. This extension is backward compatible and changes neither the database nor the Engine API major version.

### Chinese selection alignment in the terminal

The `.xterm` container shared by local and remote terminals disables Chinese punctuation compression and the automatic spacing between Chinese and Western text, so the hidden character-width measurement and the visible text follow the same fixed column width. This avoids Chrome's contextual punctuation compression affecting the xterm DOM renderer and causing text after Chinese punctuation and the mouse selection to drift cumulatively. The browser regression covers Chinese, punctuation and English mixed, plus the normal / alternate screen and different pixel densities.

### Ownership checks for asynchronous preview results

Local Markdown and remote previews check the current task, tab and render sequence number after asynchronous steps such as the request, reading the body and rendering diagrams. Switching into the terminal cleans up the outline, scroll listeners and the document watcher; an expired preview must not show the outline again, overwrite a new page or restart an old document watcher. Error responses follow the same rule.

### OSS window configuration sync

The frontend OSS configuration is read again when the window gets focus, when the page is restored and when it returns to the foreground; asynchronous reads use a sequence number so an old result cannot overwrite a newly saved configuration. The upload entry does not depend on the cached enabled state: when it is not enabled or not read yet, the read is retried inside the full-page lock and the target terminal is checked again; a read failure and "not enabled" use different hints. Saving a configuration that is not enabled keeps the form and gives explicit feedback.

## Tunnel (frp)

- Service: `services/frp.js` (configuration, random port, TOML generation, frpc process management), routes: `routes/frp.js` (`/api/frp`, login + same-origin check required), page: `public/js/frp.js`.
- The configuration is stored in `system_state.frp_config` (JSON); the Token is encrypted with `SESSION_SECRET` through `lib/token-crypto`. The frpc configuration is written to `data/frpc.toml` (0600).
- A fixed `type = "tcp"` proxy: `localIP/localPort` points at this Client and `remotePort` is a random value within `[portMin, portMax]`, generated only when missing or out of range and otherwise kept stable. If frpc exits because of a busy port within 15 seconds after start-up, a new random port is chosen and it retries, at most 3 times.
- The domain is only used to show `publicAddress` and never enters the frpc configuration. The process ends with the Client's exit, and when `autoStart` is true it is started after the Client starts.
- frpc lookup order: `T_AGENT_FRPC_BIN` → `data/bin/` → PATH and common directories → Homebrew (`bin/`, `opt/frpc|frp/bin`, `Cellar/frpc|frp/<version>/bin`, with prefixes including `HOMEBREW_PREFIX`, `/opt/homebrew`, `/usr/local` and Linuxbrew); only executable regular files are accepted, and an empty keg does not count as installed. After it is found, `frpc --version` is run (5 second timeout, cached by path + mtime), and below 0.52 `start` returns `FRP_VERSION_UNSUPPORTED`. `POST /api/frp/detect` clears the cache and scans again. `POST /api/frp/install` installs asynchronously (`services/frp-install.js`): it downloads the pinned release package and `frp_sha256_checksums.txt`, gives up when the SHA-256 does not match, extracts only frpc with the system `tar`, writes a temporary file and renames it; the page polls `installing` / `installError`.
- Remote port: when `remotePortManual` is true the manual value is used as-is (it may be outside `[portMin, portMax]`, and neither a range change nor a port conflict alters it); passing an empty / 0 `remotePort` or "Regenerate" restores automatic. The page only submits `remotePort` when the input was edited, so saving never stores an automatic port as a manual one by mistake.
- Agent prompts are produced by the pure functions in `public/js/frp-prompts.js` (frpc: checksum + only into `data/bin`; frps: systemd, `allowPorts`, firewall / security group), and after "Install frpc" is clicked a dialog asks: yes → copy the prompt, no → go through `POST /api/frp/install`. The prompts are plain text for an Agent and are always English.
- Limits: local machine only; automatic install only on macOS / Linux (amd64, arm64, arm).

## SSH reverse tunnel

- Service: `services/ssh-tunnel.js`, routes: `routes/ssh-tunnel.js` (`/api/ssh-tunnel`, login + same-origin check required), page: `public/js/ssh-tunnel.js`; it shares the "Page enhancement" page (the left navigation name) with frp, a radio switch at the top (the choice is stored in `localStorage`), and the configuration and process of the two methods are independent of each other.
- The configuration is stored in `system_state.ssh_tunnel_config`. No key content is stored, only the private key **path**; the private key file is never read.
- Process: `ssh -N -T -v -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new -p <port> [-i <private key> -o IdentitiesOnly=yes] -R [0.0.0.0:]<remote port>:<local IP>:<local port> <user>@<host>`. It is started with an argument array only (no shell); `ControlMaster=no`, `ControlPath=none` and `ControlPersist=no` are always added: the `ControlMaster auto` often found in the user's `~/.ssh/config` makes ssh hand the forward request to an existing shared connection and exit with 0 right away (the tunnel is then not owned by this process, the page wrongly reports a failure and stop cannot close it either), so the tunnel always uses its own connection; the host and username are validated when saved and may not start with `-`. An empty private key path adds no `-i` and follows ssh's default lookup entirely; a non-empty one is checked for existence before starting.
- State: running is decided by `remote forward success` in the `-v` output; the log keeps only lines about connection, authentication and forwarding. `remote port forwarding failed` retries with another port for automatic ports (at most 3 times within 15 seconds) and reports an error directly for manual ports. Authentication failure, DNS, connection refused, timeout, unusable private key and a changed host key are all mapped to readable reasons.
- Unexpected exit after having connected: reconnect automatically after 5 seconds, at most 5 times in a row; `stop` cancels a pending reconnect. It ends with the Client's exit; when `autoStart` is true it is started after start-up.
- Limits: local machine only; passwordless login only; the host key is trusted on first connection (TOFU).

## Automatic refresh after an update

- The on-disk `VERSION.json` is already the new version when the code is merged, and before the old process exits `/api/system/version` also returns the new version number, so the version number cannot be used to decide that "the restart is done".
- Every service process generates a `boot_id` at start-up (`update-manager.bootId`), returned with `/api/system/version` and `/api/system/update-status`. Before clicking update the page reads the current `boot_id` once (the return value of `apply-update` is `{ accepted, status }` and it is taken from there as well), and refreshes as soon as a different `boot_id` is read after the restart.
- Fallback: the old process exits about 0.75 seconds after writing `restarting`, so once the page has seen `restarting` for more than 4 seconds (`RESTART_GRACE_MS`) any successful response comes from the new process and it refreshes directly, without depending on one particular poll hitting the outage and without requiring the version number to equal the target version. An old service without `boot_id` treats a successful response after an observed outage as the new process as well.
- If it still has not refreshed after waiting for more than 20 seconds, a "Refresh now" button is shown; closing the dialog does not interrupt the polling.

## Floating notices (Toast)

- `public/js/toast.js`: the global `Toast.show(message, { type: 'info' | 'success' | 'error' })` and `notify(message, type)`. The `.toast-stack` container is positioned fixed at the top centre of the page and takes no part in the layout, so no notice ever changes the height of the two toolbars at the bottom of the terminal (the Chinese-to-English input bar and the function-key bar). Text is written with `textContent`; the same text only restarts the timer; at most 4 are shown at once; they disappear automatically after 2.5 seconds for success, 3.5 seconds for ordinary and 6 seconds for errors, and a click dismisses one immediately.
- Messages that now use floating notices: the send / translate / configuration hints of the Chinese-to-English input (before, they took a separate line in the input bar and made it taller), terminal copy results, and the errors of terminal image upload and reading the OSS settings (before, `alert`). Each script calls `notify` through a local `tell()`, and an environment that did not load `toast.js` (the unit-test page) falls back to `alert`.
- Still unchanged: operation status text placed next to buttons inside forms (such as the frp / SSH pages and the feedback in the settings dialog), the image upload progress card, `confirm` dialogs that need the user's confirmation, and the `alert` used for tasks, sharing, document editing and so on.

## Terminal colours and themes

The terminal, its tab strip, the buttons, the keys bar, the translate bar and xterm's own background use one set of CSS variables (`--term-bg`, `--term-chrome`, `--term-line`, `--term-btn`, `--term-btn-hover`, `--term-btn-line`, `--term-pop`, `--term-text`, `--term-tab-active`, `--term-accent`). `style.css` holds the neutral grey defaults (the light and dark themes keep the terminal they always had) and `themes.css` replaces the whole set for the futuristic theme with the blue of the page, so the pieces never mix two palettes. xterm takes its background from `Theme.terminal()` (the same variable) when it is created and every open terminal is updated when the theme changes. A new terminal rule must use the variables: `test/terminal-theme-css.test.js` fails when a grey is written into a rule again, and `scripts/test-terminal-theme-browser.cjs` checks the real colours in every theme, including xterm's background.

## Interface language

- The UI text is English and the default language. The 🌐 button in the top bar (and at the bottom of the login page) switches between English and Chinese; the choice is stored in `localStorage['ta-lang']`, and switching reloads the page so all dynamic content is rendered again in the new language.
- **All source text is English**: UI strings, comments, documentation, test names, server messages and CLI output. There are no translation keys in the code; the English text itself is the key. The Chinese UI is a translation layer in `public/js/i18n.js` plus the dictionaries `i18n-zh-ui.js` (client text), `i18n-zh-server.js` (messages produced by `services/`, `routes/` and `lib/`) and `i18n-zh-extra.js` (sentences JavaScript assembles from several pieces, and verb forms). Only when Chinese is selected, `i18n.js` translates:
  - a `MutationObserver` translates DOM text nodes and `title` / `placeholder` / `aria-label` / `data-tip` / `alt` (static HTML, content rendered later by JavaScript and Toasts are all covered);
  - `alert` / `confirm` / `prompt` are wrapped;
  - text written straight to the terminal or the clipboard, which does not go through the DOM, uses `I18n.t('English text')` (written as `typeof I18n !== 'undefined' ? I18n.t(x) : x`, because the test environment has no `I18n`).
- Dictionary format: `I18n.add({ 'English text': '<Chinese text>' })`. A whole string is matched first; otherwise `{1}`, `{2}` ... placeholders match the variable parts of a sentence (`'Saved {1}': '<Chinese> {1}'`, and the same placeholders may be reordered in the Chinese value). A captured value is itself translated when it is a known string. A template with almost no fixed text (such as `'{1}s'` for a duration) only matches numbers. A string joined with ` · ` is translated segment by segment. A piece ending with a colon (for example `'Could not save the document:'`) also gets a `'... {1}'` entry, because the message is appended at run time. Text without an entry is shown as English.
- User content is never translated: Markdown documents (`.markdown-body`), the terminal (`.xterm`), the editor (`.monaco-editor`), task / file / bookmark names and so on are in the `SKIP` selector of `i18n.js`; add `translate="no"` to any other element that must stay as written. Content created or entered by users (tasks, documents, terminal input, file names) must keep working with Chinese and any other language; the terminal Chinese-to-English input is built for exactly that.
- When adding UI text, write it in English and add its Chinese translation to the dictionary. `test/i18n.test.js` checks that every static label in `index.html`, `login.html` and the Kwai tool page has a Chinese translation, and it fails if Chinese text appears anywhere in the project outside the dictionaries and the CJK-handling test fixtures. Where a regular expression needs a CJK range, write it with `\u` escapes. A stylesheet cannot be translated through the DOM, so the few texts in CSS (for example the empty update log) are English with a Chinese override under `html[lang="zh-CN"]`, written as CSS escapes.
- The prompts that `frp-prompts.js` copies to an Agent and the CLI output of the install scripts are plain English text and are not translated. The Chinese-to-English input box keeps working as before.
- Compatibility: home-directory paths in file sync are written `home/...`, and the Chinese prefix written by earlier versions is still read (`LEGACY_HOME_PREFIX` in `services/file-sync.js`). The default bookmark group name in new databases is `Default`; rows saved earlier keep their stored value.

## Agent chat mode (v2.72.0)

A conversation view of Claude Code / Codex that replaces the terminal for one session; it is reached from the `+` menu of the terminal tabs (desktop) and the Session menu (phone): **Claude agent** / **Codex agent** list "New … chat", the task's existing chats and the agent CLI sessions of the task directory that have no chat yet. Local and remote Engines share the same conversation router. Engines advertise `agent-chat:manage`; older Engines without it keep the chat entries hidden. The Engine mounts `/v1/tasks/:id/agent` with token authentication and the token principal as task owner; the Client proxies the JSON endpoints and pipes SSE (including `after`, `reset` and `gone`) without buffering. The selected Engine owns the runtime, session files, CLI credentials and task working directory; tokens stay on the Client server. Deleting an Engine task interrupts its chats just like a local task.

- Backends (`lib/agent-chat/claude.js`, `codex.js`): the Claude Agent SDK (`query()` once per turn, `resume` = the session id, `includePartialMessages`, `settingSources: user/project/local` so CLAUDE.md and settings apply, `canUseTool` for approvals (and for the agent's questions and plans, see below), the installed `claude` binary when found on PATH). Codex runs on **`codex app-server`** (`lib/agent-chat/codex-app-server.js`, a JSON-RPC client over the stdio of the user's own `codex`, so it uses the terminal's install, login and configuration (it is looked for in `CODEX_PATH`, on PATH, in the usual install folders of the user and, as a last resort, through the user's login shell asked once with `command -v codex`, because a service started by pm2 / systemd / launchd has a short PATH and nvm, bun or a custom prefix are set up by the shell profile; the answer of the shell is remembered while that file stays executable); there is no SDK dependency). One app-server process serves one turn: `initialize` → `thread/start` or `thread/resume` → `turn/start`, then notifications until `turn/completed`. The access level maps to the thread's sandbox (`read-only`, `workspace-write`, `danger-full-access`) with `approvalPolicy: on-request` (`never` for full access) and `approvalsReviewer: user`, so Codex asks in the chat even when `~/.codex/config.toml` routes approvals to an automatic reviewer. The Claude Agent SDK is ESM and loaded with `import()` on first use. Codex threads start with `config.features.default_mode_request_user_input = true`, because Codex has no question tool in its default collaboration mode and the model would otherwise list options as text.
- Items: both adapters normalise their events into `{ id, kind: user | text | thinking | tool | notice | error, text, name, input, output, status }`. Claude streams a block under `<message id>:<ordinal>` and the final assistant message upserts the same id; a tool call uses the tool_use id and its result fills `output`; subagent chatter is dropped. History of a resumed session comes from `getSessionMessages` (Claude) or the rollout file (Codex); injected context (environment block, AGENTS.md) is not shown.
- Two-way interaction with Codex: requests Codex sends while it works are answered through the same permission cards as Claude's: command and file-change approvals (Allow / Allow for this session / Deny → `accept` / `acceptForSession` / `decline`), extra permission requests (`item/permissions/requestApproval`, granted for the turn or the session), questions to the person (`item/tool/requestUserInput`) and MCP elicitations (form fields are shown as questions), which a `kind: 'question'` request carries to the page as `questions`. Dynamic tools are declined and unknown requests get a JSON-RPC error. A message sent while a Codex turn runs is added to it with `turn/steer` (the adapter registers `ctx.setControl({ steer })`; the snapshot's `capabilities.steer` tells the page to keep Send available; an adapter without it keeps answering `409 CONVERSATION_BUSY`), Stop sends `turn/interrupt` and kills the process if the turn does not report `interrupted` within 4 seconds. Item ids are prefixed with the turn id because Codex numbers items per turn, and notifications of other threads (sub-agents) are ignored. History of a resumed session is still read from the rollout file. Limitations: one process per turn (no state shared between turns), no dynamic tools, and a Codex CLI older than the app-server protocol used here (`0.164`) is not covered.
- Service (`services/agent-chat.js`): one in-memory runtime per conversation (items, numbered events, pending permission requests, the running turn) plus the `agent_conversations` table (agent, `session_id`, title, mode; additive table). One turn at a time (`409 CONVERSATION_BUSY`); a Claude session id is learned from the `system init` message, a Codex one from `thread.started`; the first prompt names a new chat. Interrupt aborts the turn and denies pending requests; deleting a task stops its chats.
- API (`routes/agent-chat.js`, `/api/tasks/:id/agent`): `GET/POST conversations`, `GET sessions?agent=`, `GET/PATCH/DELETE conversations/:cid`, `POST conversations/:cid/messages | interrupt | permissions/:rid`, and `GET conversations/:cid/events?after=<seq>` (server-sent events: `upsert`, `append`, `status`, `permission`, `permission_done`, `session`, `meta`; `reset` when the client is too far behind, `gone` for an unknown chat). A client loads the snapshot, then follows the events after its `seq`.
- Attachments: up to 6 images (png/jpeg/gif/webp, 8 MB each; base64 in the request, passed as image blocks to Claude and as temporary files to Codex) and up to 10 text files (200 KB each, quoted into the prompt). Other files are refused.
- UI (`public/js/agent-chat.js`, `public/js/agent-chat-ui.js`, `css/agent-chat.css`): one component mounted by both pages. `agent-chat.js` is a small script loaded with every page (agent labels and access levels, the open-a-chat choices, the agent logos) and loads the view bundle `agent-chat-ui.js` on the first chat that is mounted (`mount` returns at once; `focus` and `destroy` work before the bundle arrives). The bundle is React 19 with assistant-ui (`@assistant-ui/react` external-store runtime: thread, viewport scrolling, message parts) and react-markdown with remark-gfm and highlight.js for agent text; it is built with esbuild from `scripts/agent-chat/` (`npm run build:agent-chat`) and the output is committed like the Markdown and Monaco bundles, so installs need no build step. `store.mjs` holds the conversation state (snapshot, SSE events after `seq`, answering, sending, access level) and has no React in it; `convert.mjs` turns the items into assistant-ui messages (one user message per prompt, one assistant message per turn with text, reasoning, tool-call and notice parts in order). Permission, question and plan cards, the access-level selector and the composer (attachments, steering while Codex works) are ours. Agent text is rendered by React and react-markdown, which does not pass raw HTML, and the view carries `translate="no"`: labels go through `I18n.t` because the i18n observer would otherwise rewrite text nodes React owns. The phone page mounts it full-screen and follows the visual viewport so the keyboard never covers the composer; the desktop page covers the terminal pane (closed when another task is selected).

  **Look** (the same on both pages, one column of at most 760 px): a header with only the title and a menu (rename, close; on narrow views also a back arrow and the agent's mark, because the phone page has no tab strip); the person's messages as grey rounded bubbles on the right, the agent's text without a bubble; a folded "Initialized session" entry (an `init` item with `details`, sent by the adapter when a new session starts); while a turn runs, animated dots and how long it has run (`runningMs` of the snapshot, counted on the page's own clock); one rounded composer holding the attach button, the text, the stop button, a send button when there is something to send and, on pointer devices whose browser has speech recognition, a dictation button (phones dictate through their keyboard); below it the access level (a select laid over its label) and the model and effort the agent reported (`setMeta`; claude ids such as `claude-sonnet-5-5` are shown as `Sonnet 5.5`). Only what exists is drawn: no model line until the agent reports one, no dictation button without a recognizer. Enter sends, Shift+Enter is a new line; while a turn runs Enter steers it when the agent takes input (Codex) and Cmd/Ctrl+Enter queues the message, and for an agent that does not take input both queue. Queued messages live on the page (`store.queue`): the next one is sent when a turn ends normally, after a stop or a failure they stay until the person sends or removes them, and a refresh drops them.
  **Dictation.** The microphone in the composer uses the page's speech model, `VoiceInput` from `public/js/voice-input.js` (Fun-ASR, the same as the Chinese input box and its settings), not the browser's `SpeechRecognition` (v2.84.24; v2.84.23 had a browser recognizer). The button exists only where the page loaded `voice-input.js` (desktop and `/h5`). A tap starts recording and the next tap stops it. `VoiceInput.attach` writes into a textarea, and a value set from outside does not reach React's state, so it gets a detached textarea; its `input` events are copied into the chat text after what was typed before the recording (a cancelled recording restores that text). Text typed while recording is replaced by the next result. When speech is not configured, the desktop opens the voice input settings and the phone tells the person to set it up on the desktop page, as the Chinese input box does. Test (with a fake `VoiceInput`, not the real service): `scripts/test-agent-chat-browser.cjs`.

  **Tool calls.** The calls of a turn that follow each other are one `tools` part (`convert.mjs`), drawn as a folded line like "Initialized session" ("Ran 2 commands · 1 failed"; while one runs, "Running Bash make test" with a turning ring); opened, it is a rounded card with a row per call, each with its state (a ring while it runs, a check, a cross) and what it is about, and a row opens again to show what was sent and what came back. The label comes from `groupLabel` (`format.mjs`): commands, edited files or tools. Both pages use the same component, so the desktop and the phone look the same.

  **Choosing and reviewing.** What the agent needs from the person arrives as a request and is answered in the page: (1) *approvals* (command, file change, extra permission): Allow / Allow for this session / Deny; (2) *questions* (`kind: 'question'`): Claude's `AskUserQuestion` (enabled; up to four questions, each with two to four options with descriptions and optional previews, one or several picks when `multiSelect`, and always an answer of one's own; the answers go back as `updatedInput.answers`, question text → the picked labels joined with ", ", and skipping denies the tool) and Codex's `item/tool/requestUserInput` and MCP forms, all drawn as option cards; Submit waits until every question has an answer; (3) *plans* (`kind: 'plan'`): Claude's `ExitPlanMode` in plan mode arrives with the plan as markdown (`input.plan`), shown formatted with "Approve plan" and "Keep planning" (the comments typed there go back as the reason of the refusal so the agent revises the plan); approving also takes the chat out of plan mode (`answerPermission` sets the access level to the adapter's default) so the next messages are not "plan only"; (4) *changes to review*: an approval of an edit (Codex `fileChange`, Claude `Edit`, `MultiEdit`, `Write`) shows the change as a diff with the lines that go, the lines that come and the lines around them (`diffLines` in `format.mjs`, at most 400 lines), the same diff is in the opened row of the call.

  **Footer: model, effort, context and plan limits.** What the agent reports about itself goes through `ctx.setMeta({ model, effort, context: { used, window }, limits })` and reaches the page as `meta` events and in the snapshot's conversation row. Because a chat can be opened long after its last turn (after a restart, or from a session of the terminal), `loadMeta` of each adapter reads the same values from the session itself when the history is loaded and only fills what no live turn has reported: Codex from the end of its rollout file (`turn_context` for model and effort, `token_count` for the context use and the window), Claude from the last assistant message's `usage` (the window is 200k, or 1M when a request held more; a finished turn reports the real size in `modelUsage.contextWindow`). The context is drawn as a ring that turns amber from 80% and red from 92%.

  The plan limits are the account's, not the chat's: Codex reads `account/rateLimits/read` through a short-lived app server (and gets `account/rateLimits/updated` during turns), Claude reports them only in its `rate_limit_event` messages during a turn (five-hour and seven-day windows; the utilization is read as a fraction of the window, which the SDK does not spell out). The service keeps the last reading per agent, shows it at once when a chat opens and reads it again in the background when it is older than a minute (a failure waits for the next interval), pushing the result to every open chat of that agent as a `meta` event; partial updates merge by window. The page shows what is left and when it resets as `5h 62.5% · 4.2h`: the remaining share, then the time to the reset in one unit (`m`, `h` or `d`) with at most one decimal and no trailing `.0`; a window whose reset time has passed is hidden until the next reading, and the text turns red at 10% left.

  **Choosing the model and the effort.** The model in the footer is a button (when the adapter has `CAPABILITIES.models`) that opens the models on offer, each with the efforts it supports, and the effort levels of the selected one. The list is read from the agent when first needed and kept for ten minutes: Codex `model/list` through a short-lived app server, Claude `supportedModels()` of a query that never runs a turn; the service puts a "Default" entry (no choice) first. `GET /conversations/:cid/models` returns it, `PATCH /conversations/:cid { model, effort }` saves the choice (`agent_conversations.model` / `effort`, additive columns, an empty value goes back to the agent's default). The choice applies from the next message: Codex passes it as `model` / `effort` of `thread/start|resume` and `turn/start`, Claude as the SDK's `model` and `effort` options. The footer shows the choice at once and the agent's report once a turn has run; choosing another model drops the effort the last turn reported (it belonged to the old model) and keeps one the person chose, and the page resets an effort the new model does not offer. Limitations: the list and the efforts are what the agent says today (nothing is hard-coded), the Claude plan limits are only as fresh as the last turn, and a restart shows the model and context of a chat from its session file until the next turn reports them. On the desktop, the chats open on a task are tabs after its terminals (`AgentView` in `app.js`). Which chats are open is saved in the database, not in the browser: `agent_conversations.opened_web` / `opened_h5` hold the time a chat was opened on the desktop page / the phone page (NULL: not open there; additive columns, like the terminals the two pages are separate sets), set and cleared with `PATCH /conversations/:cid { opened, surface: 'web' | 'h5' }` (the phone page first sends the same body with `POST /conversations/:cid/opened`, for a network path in front of the Client that lets POST through but not PATCH, and falls back to the PATCH for an Engine without that route) and listed as `opened: { web, h5 }` on every conversation row. Opening does not change the order of the list; opening a chat again keeps its place among the tabs; the phone shows one chat at a time, so opening one there closes the other chats of the task on that page. The first time a task of an Engine supporting `agent-chat:manage` is mounted after a page load the desktop reopens the chats with `opened.web`, in the order they were opened, so a refresh, another browser or another computer shows the same tabs; the phone page opens the chat with `opened.h5` when its task is selected (on a refresh, the task that was open). Restoring never writes to the server, a list that cannot be read opens nothing and forgets nothing, and a chat that was deleted is simply not in the list. Closing a tab (or the phone's back button) clears the flag, which closes it everywhere on that page type. Only the tab that is shown is a matter of the browser (`localStorage` `agent-tabs:<task scope>` → `{ active }`; on another browser no tab is shown and the terminal is). Earlier versions kept the open chats in `localStorage` (`{ ids, active }` on the desktop, `h5-agent:<source>:<task id>` on the phone); such a record is moved to the database the first time it is found and then dropped. What is not saved: the messages (the agent's own session file is the source and is read again when a chat is opened), queued messages and requests that wait for an answer. A chat open over another task on the phone is put away when a different task is selected and comes back with its own task. The chats of the selected task are also listed in the task sheet, after its terminals (`GET /conversations`, read when a task is selected and whenever the sheet is opened); tapping one opens it. Because the chat covers the whole screen and the back arrow is the only way out of it (and means the person is done with it, which clears the open flag), this list is how a chat that was left is reached again and why it never seems to have disappeared.

## Environment check

`GET /api/environment/check` (`routes/environment.js`, behind the same sign-in and same-origin check as the other Client APIs) runs `services/environment-check.js` and answers `{ checked_at, machine, summary, features: [{ id, name, description, status, checks: [{ id, name, status, detail, fix, impact }] }] }`. The page (`public/js/environment-check.js`, the tab right below "File sync") draws it with the features that will not work first and open.

- **Statuses**: a check is `ok`, `warn` (works, something is off), `fail` (the feature will not work) or `info` (nothing wrong: not set up or not applicable); a feature is as bad as its worst check. `impact` says what stops working, `fix` what to do (text between backticks is drawn as code). The checks are grouped by what the person uses (terminals, Claude / Codex in terminals and in the chat view, network, updates, image upload, login, tunnel, PM2, storage), not by technology, so the page answers "which features will have problems".
- **Every check is a small function** with its own time limit (15 s); a check that throws or hangs is one failed or warned check, never a failed report; all run in parallel (the clock check waits for the network checks, whose `Date` headers it compares). A second request while a check runs shares its answer, so a double click starts no more processes.
- **It only reads.** The writable checks never create a folder (a folder that does not exist yet is judged by the nearest existing one above it); the report holds no account names, e-mail addresses, keys or proxy credentials (the proxy is shown as host:port).
- **Network checks are made like the agents make theirs**: `curl` (so `https_proxy` of the Client is followed; the CLIs read the same variables), with `fetch` when there is no curl; any HTTP answer means reachable. The image upload check also sends a CORS preflight (`OPTIONS` with the page's origin) to the bucket and looks for `Access-Control-Allow-Origin`, which finds a missing CORS rule before the first upload fails.
- **Programs are found like the person's terminal finds them** (`lib/find-program.js`): an explicit variable (`CODEX_PATH`, `CLAUDE_PATH`), PATH, the usual install folders (npm, bun, volta, cargo, pnpm, the newest nvm node, the standalone installers), and last the login shell asked once with `command -v` (a service started by pm2, systemd or launchd has a short PATH). The Codex chat uses the same finder.
- **The agents are probed, not just looked for**: Claude Code is started without a turn (`probe()` in `lib/agent-chat/claude.js`: models and `accountInfo()`), the Codex app server is started and asked `account/read`, which tells "installed" from "installed and logged in".
- It checks the machine running the Client; on a remote engine the page says so. All texts are English, translated through the dictionaries; `test/environment-i18n.test.js` scans the service for every text it can show and fails when one has no Chinese translation.

## Static asset caching

The pages rewrite their `/js` and `/css` URLs with `?v=<app version>` (`sendClientPage`). A request with a plain `v` is cached for a year (`immutable`), so a phone loads the app scripts and styles from its cache after the first visit and only the page itself (`no-store`, because of the login redirect) hits the server. Unversioned requests keep revalidating. `/js` and `/css` are gzipped (`h5.js` 47 KB → 13 KB; compression is limited to these prefixes and `/vendor` so streaming endpoints are not buffered); icons, the favicon and the manifests are cached for a day. Because of the long cache, JavaScript or CSS changes only reach users with a version bump, which every release does.

## Phone page (/h5)

Phones and computers use two separate pages that share no frontend state or layout. The phone page only offers tasks, terminals, image upload and translate-and-send; everything else stays on the desktop page.

- Routing (`server.js`): `/web` is always the desktop page (fixed 1280px layout), `/h5` is always the phone page (`public/h5.html`, `public/css/h5.css`, `public/js/h5.js`, `width=device-width`). `/` sends phone user agents (iPhone, Android phones and similar; iPad and tablets stay on the desktop page) to `/h5` and serves the desktop page otherwise; the installed app starts at `/` and follows the same rule. `/h5` is an allowed login return target, and the login page returns to `/` by default so the device rule applies.
- The phone page reuses only page-independent helpers: `i18n.js` and the dictionaries, `toast.js`, `TerminalKeys.encode`, `TerminalTranslate.sanitize` and `TerminalViewport.fit`. It does not load `style.css`, `app.js`, `tasks.js` or any other desktop module.
- Single-owner terminals (`routes/terminal.js` `handleWs`, `public/js/terminal-owner.js`): the phone and the desktop list and create the same terminals (`GET/POST …/tasks/:id/terminals`; the old `surface` parameter is ignored, and `h5-…` shells from v2.65–v2.81 are no longer listed). A terminal has one attached WebSocket. A second client from another browser tab or device is refused with close code `4009` (`terminal in use`) and gets no output and cannot type; the page shows "This terminal is in use on another device" over the terminal with a "Use this terminal here" button, which reconnects with `takeover=1`. A takeover closes the previous owner with `4010`; that page shows "This terminal is now used by another device" and the same button, and does not auto-reconnect. Neither code is retried automatically. Each browser tab sends a `clientId` (kept in `sessionStorage`, so a reload keeps it); the same `clientId` always replaces its own old socket, so a refresh or a reconnect after a dropped network never shows the prompt. The PTY is shared, so a takeover keeps the shell and its running program; the new owner's resize applies. Remote engines: the Client proxy forwards `clientId` and `takeover` to the Engine stream, so the rule is enforced where the PTY lives; an older Engine still replaces the old connection without a prompt.
- Width: the page is capped at 480px (`--h5-max-width` in `h5.css`) and centred, so opened on a computer it stays a phone-portrait column; the task sheet, key grid and notices share the same cap and the terminal fits the column.
- Layout: header (task name opens the task sheet, settings button), full-height terminal (the terminal list is in the task sheet, not above the terminal), the always-visible translate row, and an 8-column, two-row key grid: `Esc Tab Ctrl Alt Shift ⌨ Paste Image` / `← ↓ ↑ → Enter(2 columns) ⌫ ^C`. While the on-screen keyboard is open (see below) the key grid is hidden and the translate row stays; it comes back when the keyboard closes. The page height follows `visualViewport` so the on-screen keyboard pushes the translate row up. Keys do not move focus (so they neither open nor close the on-screen keyboard); `⌨` focuses or blurs the terminal input. Ctrl / Alt / Shift latch for one key, including the next character typed on the on-screen keyboard.
- Session menu: the `+` on the right of the selected task row opens a Session menu: New Terminal (a plain phone terminal), Claude session and Codex session. A session kind expands to "New Claude/Codex session" plus the sessions that were run in the task's working directory (newest first, titled by their first prompt); choosing one creates a terminal whose shell first types `claude` / `codex` or `claude --resume <id>` / `codex resume <id>` (`POST …/terminals` with `{agent, session_id}`; the command is held in memory and typed once when the PTY is spawned). Sessions come from `GET …/tasks/:id/agent-sessions?agent=claude|codex` (`lib/agent-sessions.js`: `~/.claude/projects/<dir>/*.jsonl`, and `~/.codex/sessions/**/rollout-*.jsonl` filtered by `cwd`); the Engine API and the remote proxy expose the same endpoint. An old engine ignores `agent` and opens a plain terminal.
- Translate box: grows with its text from one line up to 120px (`autosize`), then scrolls inside. A single-line variant (v2.70.1) was tried and dropped because it made longer text hard to review.
- Terminal icons and names: each phone terminal row starts with a type icon (`>_` shell, `✳` Claude, `◎` Codex). `task_terminals` has `agent`, `agent_session_id` and `agent_started_at` (additive columns). A new Claude terminal runs `claude --session-id <uuid>`, so its session is known from the start; a new Codex terminal is bound on listing to the oldest unclaimed session of the task directory that started after it. `GET …/terminals` returns `agent` and, for agent terminals, the current session name (Claude: last `custom-title` / `ai-title` in the session file, else the first prompt; Codex: `thread_name` in `~/.codex/session_index.jsonl`), falling back to the stored `Claude N` / `Codex N`. The phone page refreshes the names every 8 s while the task sheet is open; Rename is hidden for agent terminals because the name follows the session. Whenever a new shell is spawned for an agent terminal (Reopen after close, Restart in the working directory, service restart) it types `claude --resume <id>` / `codex resume <id>` for the bound session; a Claude session that has no file yet is started again with `--session-id`, and an unbound Codex terminal starts a plain `codex`.
- Terminal actions: each terminal row has a `⋯` button that opens a bottom action sheet: Rename (`PATCH {tasksBase}/{task}/terminals/{id}`), Reopen (reconnect, starts a new shell if it was closed), Restart in the working directory and Delete (both `POST {tasksBase}/{task}/terminal/control` with `restart-workdir` / `delete`, after a confirmation; the server refuses to delete the `default` terminal, which is why that row has no Delete). Works for local and remote engines alike.
- Terminal list: the phone terminals of the selected task are a second-level list nested under it in the task sheet (current one highlighted, `+` adds a new phone terminal); tapping one switches to it (tapping the current one reconnects a dropped terminal) and closes the sheet. The sheet keeps the old flow of closing when a task is tapped.
- Task sheet: a drawer that slides in from the left (0.25s, none with reduced motion) and is clipped to the phone column; engine switcher (when remote engines exist), create a task by title, tasks grouped by status. The selected engine, task and terminal are remembered in `localStorage` (`h5-*`) as a convenience only.
- Touch scrolling: in the normal buffer the browser scrolls the history natively; in the alternate buffer (Claude Code, Codex, vim, tmux) a one-finger drag is turned into wheel events on the xterm screen, so xterm forwards them as mouse wheel reports or, without mouse mode, up/down arrows. Press-and-hold never starts text selection or the callout menu on the phone terminal (`user-select: none`), so a drag always scrolls; copying terminal text is a desktop-page feature.
- Home-screen app: a browser tab cannot hide its address bar and toolbar, so `/h5` is installable as a standalone web app (`manifest-h5.json` with `start_url` `/h5`, dark colours, plus the `apple-mobile-web-app-capable` meta tags). Opened from the home-screen icon (browser share menu → Add to Home Screen) it runs without the browser bars; the layout already follows `visualViewport` and the safe-area insets. The desktop page keeps `manifest.json`.
- Wrong page address: for a logged-in browser page visit (GET/HEAD asking for `text/html`) to an address nothing serves, the last handler (`createUnknownPageRedirect` in `lib/login-gate.js`, mounted after the static files) redirects to `/` (phones continue to `/h5`). Logged-out requests are never redirected, so the hidden login entrance stays hidden and they keep getting the plain 404; `/api`, `/auth`, `/v1`, `/share`, `/hooks`, `/terminal`, `/js`, `/css`, `/vendor`, `/icons`, the login path and non-HTML requests also keep the 404. Tests: `test/login-gate.test.js` and `test/client-auth-http.test.js`.
- Keyboard and terminal size: when the visual viewport shrinks by more than 8px from its tallest height (the on-screen keyboard), the terminal keeps the height it had before and is shifted up (`translateY`) so its bottom rows stay visible above the keys; the top rows are clipped. The shift is capped by the cursor row (`TerminalViewport.keyboardShift`, updated on every cursor move), so a shell prompt near the top of the terminal stays visible instead of being pushed out of sight. Its size does not change, so no `resize` reaches the PTY and a full-screen program does not redraw. When the keyboard closes the terminal goes back to its place. Rotating the phone measures the full height again. iOS Safari can report the final keyboard height without a last `resize` event (for example when focus moves from the terminal to the translate box), which left a blank band under the translate row; the page therefore measures again on `visualViewport` `scroll`, on every focus change (at 0, 100, 250, 500 and 1000 ms) and every 500 ms while the keyboard is open.
- Apple Chinese keyboard: xterm 5.5 ignores an `insertText` input event that is `composed` and follows a keydown, which is how iOS types a space, punctuation or a number with the native Pinyin keyboard, so those characters never reached the shell. `public/js/terminal-ime.js` (`TerminalIme.attach`) watches the terminal root in the capture phase and, 40 ms after such an event (a single space, punctuation mark, symbol or number, not composing), sends the character unless xterm emitted it in the meantime, so nothing is typed twice. Letters and composed text stay with xterm. Test: `test/terminal-ime.test.js`; not verified on a real iPhone.
- Settings: the header's top-right button (⚙) opens a sheet that slides in from the right with the language toggle and an icon-only (↻) PC one-click update button; its status text appears only while an update runs. The update uses the desktop endpoints (`POST /api/system/check-update`, `apply-update` with `confirm: true`, `GET /api/system/update-status`): check, show `old → new` with a confirm button (the service restarts and interrupts terminals), then poll the progress log; once the service is back (changed `boot_id`, `stage: completed`, or the 4 s restart grace) the page reloads. Force update stays a desktop-only option.
- Copy text: the phone terminal blocks text selection (a drag scrolls), so a 📋 button at the top of the floating button stack (above ▲ ▼) opens a full-screen overlay with the terminal buffer as plain text (`buffer.active` lines, wrapped lines joined, trailing blank lines dropped; the whole scrollback in the normal buffer, only the screen in a full-screen program). The overlay uses the terminal's font and size (11px) with 4px side padding and `white-space: pre`, so one terminal row is one line and the layout matches the terminal. The text is `user-select: text`, so the browser's long-press handles work; `Copy all` uses `navigator.clipboard.writeText` and falls back to selecting the text and `execCommand('copy')` on plain HTTP. It is a snapshot, not live.
- Scroll buttons: two floating buttons (▲ ▼) on the right edge of the terminal move it by click, so scrolling does not depend on a drag. In the normal buffer a click scrolls the history by a page (`rows - 2` lines); in the alternate buffer it sends 5 wheel events, like a drag. They do not take focus, so the on-screen keyboard stays as it is.
- Terminal connection: same WebSocket protocol as the desktop (`history` replay first, input held back until it is drawn, `resize` after fitting, exponential reconnect, reconnect when the page becomes visible again).
- Paste reads `navigator.clipboard.readText()` (needs HTTPS or localhost) and goes through `term.paste` so bracketed paste is kept. Image upload uses `POST /api/oss/images` with a full-screen lock; the link is typed into the original terminal with a trailing space and no Enter, or shown for copying when that terminal went away. Translate-and-send uses `POST /api/translate`, strips control characters with the shared `sanitize`, then sends Enter after 120 ms; translation settings stay on the desktop page.
- Tests: `test/terminal-multiple.test.js`, `test/terminal-api.test.js` and `test/terminal-owner.test.js` (shared terminals and single-owner takeover), `test/client-auth*.test.js` (routes and return targets), `test/i18n.test.js` (`h5.html` labels), `scripts/test-h5-browser.cjs` (real Chromium at phone size).
> v2.84.16 Agent chat footer and paste: the plan usage row (`.agent-chat > .ac-limits`) is a flex row with `justify-content: flex-end`, so it sits right-aligned above the model, on the same edge as the footer content. Pasting an image works anywhere in the chat, not only inside the input box: a `document` paste listener in `Composer` takes it when the target is inside the chat (or `body` when only one chat is on the page) and is not another input; images are also read from `clipboardData.items` when `files` is empty. Regression: `scripts/test-agent-chat-browser.cjs`.
> v2.84.17 Claude plan usage: `loadLimits` in `lib/agent-chat/claude.js` reads the 5h and 7d windows from the SDK's `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` on an idle query (no turn runs), so the usage row shows as soon as a chat opens (`refreshLimits` in `services/agent-chat.js`, at most once a minute). Before this, Claude's `rate_limit_event` was the only source and it carries a percent only when a window is close to its limit. Utilization from this call is already a percent (the event's is a fraction). API-key and third-party accounts (`rate_limits_available` false), or an SDK without the call, give no limits and no error; the call is experimental, so an SDK upgrade can break it, and the row then falls back to the event. Regression: `test/agent-chat-service.test.js`.
> v2.84.18 Chat versus terminal icons: a terminal that runs an agent shows the agent's plain mark (`AgentChat.icon`), and an agent chat shows the same mark with a small speech bubble at its lower right (`AgentChat.chatIcon`, `.agent-chat-mark` / `.agent-chat-bubble`), in the phone task sheet and in the desktop agent tabs. Before, both showed the same mark and could not be told apart. Regression: `scripts/test-h5-browser.cjs`.

Agent chat translation: the composer has a Translate switch beside dictation, off by default for each mounted chat. Turning it on translates the message text through the Client's existing `POST /api/translate` before sending, steering or queueing, including remote Engine chats. Translation uses the existing translation settings (configured from the terminal toolbar); English passes through. Images and attached files are unchanged. Queued messages keep the text prepared when queued. During translation the draft is locked; failures keep the draft and attachments and show an error. The existing service limit of 4,000 characters applies when translation is on. Closing or reloading the chat resets the switch.
> v2.84.20 Chat order: `GET .../agent/conversations` lists chats in the order they were created (`ORDER BY rowid ASC`), so a chat that gets a message no longer jumps to the top of the phone task sheet. It was `updated_at DESC`. The "open a chat" choices (`AgentChat.choices`) sort by `updated_at` themselves to keep the latest first. A remote Engine on an older version still returns the old order until it is updated. Regression: `test/agent-chat-service.test.js`.
> v2.84.21 Chat footer layout: the translation switch moved out of the input box into a row of its own (`.agent-chat > .ac-meta`) between the input box and the access level, with the switch on the left (its left edge matches the access level) and the plan usage on the right, above the model. The row is always there because the switch is; the usage still shows only when known. `Limits` is rendered by `Composer` for this. Regression: `scripts/test-agent-chat-browser.cjs` (positions).
> v2.84.22 Development speed: `npm run test:quick` (unit tests without the installer tests, about 20 s; or pass files), `scripts/release.js` (one-step version bump, tested in `test/release-script.test.js`) and `scripts/new-worktree.sh` (a worktree from the latest `origin/main` with `node_modules` linked). `AGENTS.md` says to run the full `npm test` once before a release, not after every edit.
> v2.84.23 Dictation: the microphone in the agent chat composer is a tap-to-start, tap-to-stop toggle (see Dictation above); it was hold-to-talk.
> v2.84.24 Dictation in the agent chat uses the page's speech model (`VoiceInput`, Fun-ASR) instead of the browser recognizer; see Dictation above.
> v2.84.25 Speech recognition in noise: the voice input settings have a noise filter (`speech_noise_threshold`, -1 to 1, empty = the service default; closer to 1 filters more noise and can cut quiet speech), hot words (sent as `input.context`, one `user` message of type `input_text`, at most 400 characters, kept as one clean comma list) and a hot word list ID (`parameters.vocabulary_id`, a list made in advance on Alibaba Cloud); they are saved per user with the other settings, kept when another field is saved, and reach the browser in the token response only when set (`services/speech.js`, `createRecognizer`). The microphone is asked for `autoGainControl` besides echo cancellation and noise suppression, and a 100 Hz high-pass filter sits between the microphone and the capture worklet (it is skipped when the context has no `createBiquadFilter`). Limits: the service has no speaker separation, so other people talking close to the microphone are still transcribed, and no browser-side denoiser (such as RNNoise) is included. Not verified against the real service (no key here); the tests use fake sockets and audio contexts. Regression: `test/speech.test.js`.
