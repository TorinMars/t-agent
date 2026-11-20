# Shared page state

> Part of the T-Agent design document. The index of all parts is [DESIGN.md](../../DESIGN.md).

What the page remembers about the person (the recent sessions, the chosen tabs, the columns, collapsed groups, small preferences) is kept on the server, per owner, and is the same on every device and on every engine joined by service links, company computers included (it is not personal progress data like Learn: it goes everywhere, like the settings). The rule behind it: "One experience on every device and engine" in `AGENTS.md`. Before this, each browser kept its own copy in localStorage, and the page of T01 and the page of K01 are different origins, so phone, computer, T01 and K01 each showed a different Recent list.

Code: `services/page-state-merge.js` (the merge rules, pure), `services/page-state.js` (store, page reads and changes, the sync), `routes/page-state.js` (`/api/page-state`, `/v1/page-state`), `public/js/page-state.js` (the page's side, `window.TAPageState`), `scripts/h5-shell/shared-store.mjs` (the shell's door to it, and `useShared` in `common.jsx`), h5.js "Recent sessions"; `public/js/local-keys.js` (the registry of every key a browser may keep, "Key audit" below).

**Why a sync of its own, not a settings-sync group.** A settings group has one version for its whole value, so two devices that note different sessions at the same time would keep one of them. The page state merges per entry (each recent session) and per key (each remembered choice), like the Learn sync, but it is one small document (a few KB), so a round exchanges it whole instead of paging after a change number.

## Store and merge

- `system_state` `page_state_v1:<owner>` = `{ state: { recent: { <id>: entry }, keys: { <name>: { value, at, by } } }, clock }`. `clock` is a hybrid clock in ms: a change takes `max(now, newest seen + 1)`, every version read from a peer moves it forward.
- **A recent entry** names a terminal session by an engine-neutral identity: `instance` (the engine's instance id, `engine_identity`), `task` and `terminal` (id `<instance>|<task>|<terminal>`), with the session's `title` and `agent` as last shown, `used` (when it was last used, the page's clock, the sort key) and the version `at` / `by` (the engine that took the change). Optional `client` (`phone`, `computer`, `mac`, `home`) and `device` (a random id of that browser) say where it was looked at, for the "Continue" hint ([continue-and-drafts.md](continue-and-drafts.md)); left out when unknown. A removed session is a tombstone (`gone: true`).
- **A key** is one remembered choice under its old localStorage name (table below), any JSON of at most 16 KB; `null` is a cleared key (a tombstone too).
- **Merge** (`merge`): for every entry and key the later version wins (greater `at`, then greater `by`, then the greater stable JSON, so every engine picks the same). The recency of saved commands (`ta-saved-commands-used`, `{ kind: { command: ms } }`) is merged per command by the later time, so two devices that use different commands at once keep both. Then `trim`: the 24 live entries used last (`RECENT_KEEP`, twice the page's 12, so one side's cap never drops the other's latest), tombstones and cleared keys of the last 30 days (at most 200 tombstones), at most 128 keys. Merging is commutative and merging the result again changes nothing, so echoes stop.
- **A page change** (`changeState`) is stamped once with the engine's clock. `import` (what a browser kept before this feature) gets version time 0, so any value set since on any device wins over it.

## Page API

Behind the login and same-origin gates of `/api`, per owner (the page login):

- `GET /api/page-state` -> `{ instance_id, version, recent: [{ instance, task, terminal, title, agent, used }] (used last first), keys: { <name>: value | null }, peers: [{ name, online, supported, last_sync_at }] }`. `version` is the stored clock, which every save raises (a merge from a peer by at least 1), so a page can tell an older answer from a newer one.
- `PUT /api/page-state { recent?: [{ instance, task, terminal, title, agent, used } | { instance, task, terminal, gone: true }], keys?: { <name>: value | null }, import?: { recent, keys } }` -> the same. 400 `INVALID_PAGE_STATE` for a malformed body.

## The page (`public/js/page-state.js`)

A classic script in the head run of `h5.html` (combined with i18n.js, toast.js and client-auth.js), so the shell and h5.js find `TAPageState` when they start; it is not part of the first-screen bundle.

- **Keys.** Each moved key keeps its browser key as a cache: every value the server gives is written into it (`mirror`), so the scripts that read it at start (i18n.js, word-translate.js, entry.jsx, Columns.jsx) find the last value at once. A change goes through `TAPageState.store` (`setItem` / `getItem` / `removeItem`, the shell's `writeShared` / `readShared`): written to the browser key at once and sent. Components that draw a key follow it (`useShared`), so a change on another device shows without a reload.
- **Identity.** `toShared`, `toPage`, `recentForPage`: each page names an engine by its own source key (`local`, `remote:<n>`), from the instance ids it already knows (`instance_id` of `/api/system/version`, of each `/api/remote-servers` row; h5.js passes them with `setSources`). On T01 the session `K|5|k1` is `remote:7|5|k1`, on K01 `local|5|k1`. A device without an instance id (an older Engine, or the first minute after a server start) is `~<source key>`: its entries stay in this browser only and are never sent. Three keys name devices and tasks and are translated (`CODECS`): the collapsed T-Attention parents (`<instance>:<task id>`; ids of an engine this page does not list are kept), the engine of a new T-Attention task and the machine "Create on" starts with (`h5-create-on`; both an instance id, this machine's too, so no page reads "nothing chosen" as itself; [entry-symmetry.md](entry-symmetry.md)).
- **Sending.** A change is drawn at once and sent 800 ms later (a burst is one `PUT`), with `keepalive` when the page is hidden or closed. Until the server took it, it stays on top of the server's state and in the cache (`ta-page-state`), so a reload sends it again. An answer replaces the state; a change made meanwhile stays on top. A 400 drops the change; other failures retry after 5, 15, then 60 s.
- **Following other devices**: the server pushes the new state to the top page after every change ("The page push" below). The light read stays as the fallback: at start, when the tab becomes visible or the window gets the focus (at most every 3 s) and every 60 s while visible. An answer whose `version` is older than the one the page took (a read that crossed a push) is not applied. A pane of the multi-column view and other tabs of the browser make no requests and open no streams of their own: they follow the cache through `storage` events.
- **Import, once per browser.** The moved keys this browser kept and the server does not have are sent as an import (`ta-page-state-imported` marks the parts sent; the keys that name devices once this page knows its devices), and h5.js imports the old `h5-recent-sessions` list (its order kept; an entry without a time gets a small one) and removes that key.
- **Language.** A language chosen on another device: the page reloads in it once (`I18n.set`; at most once per tab, `ta-lang-applied` in sessionStorage, and only when the browser kept it, so blocked storage never loops). The `ta-lang` cookie stays: the server needs it before any script runs.
- **An older server** (`/api/page-state` 404): everything stays in this browser's cache, as before the feature.

## The page push

A change made on any device or linked engine shows on every open top page in about a second, without the focus or a reload (measured: about 1 s from the tap on one engine's page to the other engine's page in `scripts/test-h5-shared-state-browser.cjs`, 0.3 s from the `PUT` on one engine to the other engine's page in `test/page-state.test.js`).

- **No stream of its own.** The state rides on the stream the top page already keeps open to its own engine: the terminal activity stream (`GET /api/tasks/terminal-activity/stream`, "Terminal activity" in [terminals.md](terminals.md)). h5.js asks for it with `?state=1` on this machine's stream only (never on another engine's through the proxy, and a pane of the columns view opens no stream at all), so a page uses no extra connection (HTTP/1.1 allows about 6 per origin, and the page already keeps up to 3 activity streams and the T-Attention stream).
- **The event.** `event: page-state` with the JSON of the answer a `GET /api/page-state` would give (with `version` and `peers`), 50 ms after any save of the owner's state (a change from a page of this engine, a merge from a peer), a burst of saves being one event (`follow(owner, listener)` in `services/page-state.js`; `attach` in `lib/terminal-activity-stream.js`; `routes/tasks.js`). A state larger than 256 KB (`PUSH_MAX`) is announced as `{"read":true}`, and the page reads it. The page takes it like a read (`TAPageState.pushed`): the changes it has not sent yet stay on top, the cache is written (so its panes and other tabs follow by `storage` events), the moved keys are mirrored and the listeners called.
- **Between engines.** The push to the peers waits 200 ms after a page change instead of 1 s, and that round skips `/v1/info` when it listed the capability within 5 minutes (any failure forgets it; the periodic and on-link-online rounds always ask). The peer that merged it saves, and its pages get the event. Chain: the page waits 800 ms (one `PUT` for a burst), the engine 200 ms, one round (digest, pull, push), the receiver 50 ms.
- **When it is not there**: a hidden page closes its activity stream and reads the state when it is shown again; an older server ignores `?state=1` and the page follows by the light read, as before.
- **A later key rides on it as it is.** Anything kept in the shared page state (a new key under `keys`, such as the drafts of each session and the "continue" hint of a later item) is in every pushed answer: give it a name that fits `KEY_NAME`, read it with `TAPageState.get` or `useShared` (which follow `subscribe`), write it with `TAPageState.set`. Nothing in the stream, the server or h5.js changes for it. Only a value that changes many times a second (typing) should be sent less often by its own code, since each change is one `PUT` per 800 ms and one push to every page. The drafts do so: `ta-draft:<hash>`, one key per session, written at most every 2 s while typing ("Drafts" in [continue-and-drafts.md](continue-and-drafts.md)). `TAPageState.answered()` says whether the server's state was read or pushed since the page started.

## Recent sessions (h5.js)

`state.recent` is `recentForPage(TAPageState.recent())` without the sessions that are gone ("Recent sessions" in [session-switcher.md](session-switcher.md)). Showing a session (`noteShown`, only a terminal of the task's list, so the id left behind while another list loads is never noted) sends the entries that changed: the new first one and the one left, stamped 1 ms earlier so the order by time is the list's order (`noteRecent` in `recent-sessions.mjs`); `leave` applies only when this page showed that first entry itself. A rename or a delete from a session menu sends the new name or a tombstone. A session that is gone for sure becomes a tombstone when the task list is drawn again: its task is listed with its sessions known and it is not among them, or it is a task of this machine that left the list (once that list answered, while this machine is listed). A task of another engine that is not listed is only left out here, since this page may not see all its tasks (per-task visibility); that engine's own page forgets it.

## Columns

The layout (`h5-columns`: on, the column ids, the rail tab) is shared, and so is the session each column shows: the pane keeps `h5-column:<pane id>` = `{ instance, task, terminal }` (JSON) when its shown terminal changes, and opens what another device chose there, at start (before its own remembered session) and when it changes. What a pane brings back by itself at start is sent as an import, so it never overrides a column chosen on another device. Closing a column clears its key. The layout is written only when it differs from what is stored, so a device that starts with nothing stored never overwrites another one's. A layout changed elsewhere is taken at once; a column that stays keeps its frame.

## Sync between engines

- `GET /v1/info` must list `page-state:sync` (an older peer is skipped and shown as `supported: false` in `peers`). Link tokens only (`linkForToken`, not revoked; any other Engine token 403 `LINKED_ONLY`); 404 with `SETTINGS_SYNC_ENABLED=false` (then the state stays on this engine).
- `GET /v1/page-state?public_key=` -> `{ instance_id, public_key, digest }` (an HMAC of the state under the link's page-state key). `POST /v1/page-state/pull { instance_id, public_key }` -> `{ instance_id, sealed }` (the whole state). `PUT /v1/page-state { instance_id, public_key, sealed }` -> `{ changed }`. The state travels only inside the settings sync's AES-256-GCM envelopes, with a key derived by HKDF from that link's settings-sync key (`linkKey`, info `t-agent page-state v1`) and the additional data `t-agent page-state v1|<push|pull>|<sender>|<link id>`. A sender whose instance id is not the link's is 400 `INVALID_PAGE_STATE`.
- **A round** with one peer: `/v1/info`, then the digest; equal digests end it. Else the peer's state is pulled and merged here, and the merged state is sent when it still differs. A side that changed by a merge (here, or a receiver of a `PUT`) starts a round with its other peers (fan-out), so a chain A–B–C reaches C and comes back; the echo stops at the digest check.
- **When**: 200 ms after a page change or a merge that changed this side (debounced; that round skips `/v1/info` when it listed the capability within 5 minutes), when a link comes online, at start and every 5 minutes. Failures are logged once per link and reason by code (`[page-state] sync with <name> failed: <code>`).
- **Per-task visibility**: the entries of this engine's tasks that a link may not see are left out of what that link gets and of the digest made for it.

## Key audit

Every localStorage and sessionStorage key of the page and its chunks (`public/js/*.js`, `scripts/h5-shell/*`, `scripts/agent-chat/*`, `scripts/mindmap/*`). The page reaches browser storage only through one registry, `public/js/local-keys.js` (`window.TALocalKeys`; the shell's door is `scripts/h5-shell/local-keys.mjs`), where each key below is declared with the same category and its reason; a key it does not declare can be neither read nor written (`TALocalKeys.refused()` lists what was tried). `test/local-storage-keys.test.js` fails when a page source touches localStorage, sessionStorage or indexedDB outside the registry, uses a key it does not declare, or when this table and the registry differ. Categories (the AGENTS.md rule): `cache-of-shared-state` (this browser's copy of a value of the shared page state, read at start), `hardware`, `browser` (this browser or tab), `device-setting` (set for this device only in Settings). A key marked "pane" has a copy per column of the multi-column view (`pane:<id>:<key>`).

| Key | Storage | Category | Reason |
| --- | --- | --- | --- |
| `h5-recent-sessions` | local | cache-of-shared-state | the Recent list kept before the shared page state: imported once, then removed |
| `h5-task-list-tab` | local | cache-of-shared-state | the chosen tab of the task list |
| `h5-columns` | local | cache-of-shared-state | the multi-column layout (the session of each column, `h5-column:<pane id>`, is kept on the server only) |
| `h5-sidebar-collapsed` | local, pane | cache-of-shared-state | the folded task sidebar; a column's own copy stays in this browser |
| `h5-attention-collapsed` | local | cache-of-shared-state | the collapsed T-Attention parents (by instance id on the server) |
| `h5-attention-add-on` | local | cache-of-shared-state | the engine a new T-Attention task goes to (an instance id on the server) |
| `h5-create-on` | local | cache-of-shared-state | the machine "Create on" starts with for a new task or mind map: the one chosen last (an instance id on the server) |
| `h5-design-outline` | local | cache-of-shared-state | the outline column of the file sheet |
| `ta-saved-commands-used` | local | cache-of-shared-state | the recency of saved commands (merged per command on the server) |
| `h5-mindmap-list-folded` | local | cache-of-shared-state | the folded list of the Mind maps tab |
| `word-translate` | local | cache-of-shared-state | tap to translate |
| `ta-lang` | local | cache-of-shared-state | the language, read before the first paint; its cookie tells the server |
| `ta-page-state` | local | cache-of-shared-state | the copy of the shared page state and the changes not sent yet |
| `ta-page-state-imported` | local | cache-of-shared-state | which old values of this browser were already sent |
| `h5-source`, `h5-task:<source>`, `h5-terminal:<source>:<task>` | local, pane | browser | which session this window opens at start: they decide the first requests (the early socket) before any answer, and opening the session last looked at on another device would open one the person did not choose here. The session last looked at anywhere is the first of the shared Recent list, one press of ⇋ away |
| `h5-terminal-width`, `h5-terminal-wide-cols` | local, pane | hardware | the screen's size (fit or a fixed width) |
| `h5-terminal-width-noted` | local | hardware | a one-time hint about this device's gesture |
| `voice-enabled`, `voice-keep-mic` | local | hardware | this device's microphone and its permission |
| `h5-attention-sound` | local | device-setting | Settings offers it as "Reminders on this device" (scope device): a phone in a meeting and a computer at home want different sounds |
| `t-agent.settings-tab`, `t-agent.settings-device` | local | browser | the device whose settings the open form edits, chosen where it is edited, so a save never goes to a machine another device picked (the second is the old name, read once) |
| `h5-mindmap-draft:<map>` | local | browser | this browser's unsaved edits of a map (a crash copy); the saved map is on its service |
| `h5-mindmap` | local, pane | browser | kept by mind map columns of v2.133 and v2.134: read only to drop them |
| `ta-linked-engines` | local | cache-of-shared-state | this engine's name and the web addresses of its linked engines, for the offline page's "Continue on" while this engine is down (the server keeps them too) |
| `ta-device-id` | local | browser | a random id of this browser, so the "Continue" hint and the drafts never offer this device its own session or text |
| `terminal-client-id` | session, pane | browser | names this tab as one terminal client |
| `h5-auto-reloaded-versions` | session | browser | the auto-reload guard of this tab |
| `ta-lang-applied` | session | browser | a language from another device is applied once per tab |

Kept on the server only, with no browser copy (read with `TAPageState.get`, written with `TAPageState.set`): `version-skew-closed:<instance id>` = the version for which the banner of an engine on an older version was closed ("When engines run different versions" in [update-check-and-versions.md](update-check-and-versions.md)).

Not stored any more: `h5-agent:*`, `h5-attention-notify` (left by older versions, never read). The last opened mind map is not remembered at all (the Mind maps tab opens on its list), so there is nothing to share.

## Known limits

- A change waiting in a browser that was offline is stamped when it reaches the server, so it can win over a change made a little earlier elsewhere (the later arrival wins).
- A tombstone lives 30 days: an engine that was away longer can bring a removed session back, until a page of its engine forgets it again.
- A page that is hidden gets no push (its stream is closed); it reads the state when it is shown again. Two columns views open at the same time follow each other's column sessions.
- The page does not yet say when an engine is offline or too old to share the state (`peers` in the answer has it, for a later note on the page).

Tests: `test/local-storage-keys.test.js` (the registry is the only door, every key is declared, this table matches it), `test/page-state.test.js` (merge rules, the page's identity mapping and codecs, two, three and four engines over real HTTP: the same Recent list and keys, a rename and a delete, changes on both sides, the push after a change, no loop, a chain, an older peer, a hidden task, the engine routes; the page push: a change on one engine reaches the other engine's page stream within 2 s as the answer a read gives, a burst is one round without `/v1/info`, versions only go up, a large state says to read), `test/task-parity.test.js` (the real `/api/tasks/terminal-activity/stream?state=1` carries `page-state`, a stream without it does not), `scripts/test-h5-shared-state-browser.cjs` (two engines' pages, a computer and a phone, over one mocked state: the import, the same list under each page's own keys, the tab and tap to translate followed on focus, a delete; then with the push: the columns turned off on one engine, the task list tab and a session shown on the phone follow on the other pages within 2 s with no read of their own, only this machine's stream asks for the state, a column opens no stream), and the tests of each moved key (unchanged behaviour without the server: the cache).
