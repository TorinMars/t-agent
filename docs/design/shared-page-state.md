# Shared page state

> Part of the T-Agent design document. The index of all parts is [DESIGN.md](../../DESIGN.md).

What the page remembers about the person (the recent sessions, the chosen tabs, the columns, collapsed groups, small preferences) is kept on the server, per owner, and is the same on every device and on every engine joined by service links, company computers included (it is not personal progress data like Learn: it goes everywhere, like the settings). The rule behind it: "One experience on every device and engine" in `AGENTS.md`. Before this, each browser kept its own copy in localStorage, and the page of T01 and the page of K01 are different origins, so phone, computer, T01 and K01 each showed a different Recent list.

Code: `services/page-state-merge.js` (the merge rules, pure), `services/page-state.js` (store, page reads and changes, the sync), `routes/page-state.js` (`/api/page-state`, `/v1/page-state`), `public/js/page-state.js` (the page's side, `window.TAPageState`), `scripts/h5-shell/shared-store.mjs` (the shell's door to it, and `useShared` in `common.jsx`), h5.js "Recent sessions".

**Why a sync of its own, not a settings-sync group.** A settings group has one version for its whole value, so two devices that note different sessions at the same time would keep one of them. The page state merges per entry (each recent session) and per key (each remembered choice), like the Learn sync, but it is one small document (a few KB), so a round exchanges it whole instead of paging after a change number.

## Store and merge

- `system_state` `page_state_v1:<owner>` = `{ state: { recent: { <id>: entry }, keys: { <name>: { value, at, by } } }, clock }`. `clock` is a hybrid clock in ms: a change takes `max(now, newest seen + 1)`, every version read from a peer moves it forward.
- **A recent entry** names a terminal session by an engine-neutral identity: `instance` (the engine's instance id, `engine_identity`), `task` and `terminal` (id `<instance>|<task>|<terminal>`), with the session's `title` and `agent` as last shown, `used` (when it was last used, the page's clock, the sort key) and the version `at` / `by` (the engine that took the change). A removed session is a tombstone (`gone: true`).
- **A key** is one remembered choice under its old localStorage name (table below), any JSON of at most 16 KB; `null` is a cleared key (a tombstone too).
- **Merge** (`merge`): for every entry and key the later version wins (greater `at`, then greater `by`, then the greater stable JSON, so every engine picks the same). The recency of saved commands (`ta-saved-commands-used`, `{ kind: { command: ms } }`) is merged per command by the later time, so two devices that use different commands at once keep both. Then `trim`: the 24 live entries used last (`RECENT_KEEP`, twice the page's 12, so one side's cap never drops the other's latest), tombstones and cleared keys of the last 30 days (at most 200 tombstones), at most 128 keys. Merging is commutative and merging the result again changes nothing, so echoes stop.
- **A page change** (`changeState`) is stamped once with the engine's clock. `import` (what a browser kept before this feature) gets version time 0, so any value set since on any device wins over it.

## Page API

Behind the login and same-origin gates of `/api`, per owner (the page login):

- `GET /api/page-state` -> `{ instance_id, recent: [{ instance, task, terminal, title, agent, used }] (used last first), keys: { <name>: value | null }, peers: [{ name, online, supported, last_sync_at }] }`.
- `PUT /api/page-state { recent?: [{ instance, task, terminal, title, agent, used } | { instance, task, terminal, gone: true }], keys?: { <name>: value | null }, import?: { recent, keys } }` -> the same. 400 `INVALID_PAGE_STATE` for a malformed body.

## The page (`public/js/page-state.js`)

A classic script in the head run of `h5.html` (combined with i18n.js, toast.js and client-auth.js), so the shell and h5.js find `TAPageState` when they start; it is not part of the first-screen bundle.

- **Keys.** Each moved key keeps its browser key as a cache: every value the server gives is written into it (`mirror`), so the scripts that read it at start (i18n.js, word-translate.js, entry.jsx, Columns.jsx) find the last value at once. A change goes through `TAPageState.store` (`setItem` / `getItem` / `removeItem`, the shell's `writeShared` / `readShared`): written to the browser key at once and sent. Components that draw a key follow it (`useShared`), so a change on another device shows without a reload.
- **Identity.** `toShared`, `toPage`, `recentForPage`: each page names an engine by its own source key (`local`, `remote:<n>`), from the instance ids it already knows (`instance_id` of `/api/system/version`, of each `/api/remote-servers` row; h5.js passes them with `setSources`). On T01 the session `K|5|k1` is `remote:7|5|k1`, on K01 `local|5|k1`. A device without an instance id (an older Engine, or the first minute after a server start) is `~<source key>`: its entries stay in this browser only and are never sent. Two keys name devices and tasks and are translated (`CODECS`): the collapsed T-Attention parents (`<instance>:<task id>`; ids of an engine this page does not list are kept) and the engine of a new T-Attention task (an instance id).
- **Sending.** A change is drawn at once and sent 800 ms later (a burst is one `PUT`), with `keepalive` when the page is hidden or closed. Until the server took it, it stays on top of the server's state and in the cache (`ta-page-state`), so a reload sends it again. An answer replaces the state; a change made meanwhile stays on top. A 400 drops the change; other failures retry after 5, 15, then 60 s.
- **Following other devices** (a light read, no stream): the top page reads the state at start, when the tab becomes visible or the window gets the focus (at most every 3 s) and every 60 s while visible. A pane of the multi-column view and other tabs of the browser make no requests of their own: they follow the cache through `storage` events.
- **Import, once per browser.** The moved keys this browser kept and the server does not have are sent as an import (`ta-page-state-imported` marks the parts sent; the keys that name devices once this page knows its devices), and h5.js imports the old `h5-recent-sessions` list (its order kept; an entry without a time gets a small one) and removes that key.
- **Language.** A language chosen on another device: the page reloads in it once (`I18n.set`; at most once per tab, `ta-lang-applied` in sessionStorage, and only when the browser kept it, so blocked storage never loops). The `ta-lang` cookie stays: the server needs it before any script runs.
- **An older server** (`/api/page-state` 404): everything stays in this browser's cache, as before the feature.

## Recent sessions (h5.js)

`state.recent` is `recentForPage(TAPageState.recent())` without the sessions that are gone ("Recent sessions" in [session-switcher.md](session-switcher.md)). Showing a session (`noteShown`, only a terminal of the task's list, so the id left behind while another list loads is never noted) sends the entries that changed: the new first one and the one left, stamped 1 ms earlier so the order by time is the list's order (`noteRecent` in `recent-sessions.mjs`); `leave` applies only when this page showed that first entry itself. A rename or a delete from a session menu sends the new name or a tombstone. A session that is gone for sure becomes a tombstone when the task list is drawn again: its task is listed with its sessions known and it is not among them, or it is a task of this machine that left the list (once that list answered, while this machine is listed). A task of another engine that is not listed is only left out here, since this page may not see all its tasks (per-task visibility); that engine's own page forgets it.

## Columns

The layout (`h5-columns`: on, the column ids, the rail tab) is shared, and so is the session each column shows: the pane keeps `h5-column:<pane id>` = `{ instance, task, terminal }` (JSON) when its shown terminal changes, and opens what another device chose there, at start (before its own remembered session) and when it changes. What a pane brings back by itself at start is sent as an import, so it never overrides a column chosen on another device. Closing a column clears its key. The layout is written only when it differs from what is stored, so a device that starts with nothing stored never overwrites another one's. A layout changed elsewhere is taken at once; a column that stays keeps its frame.

## Sync between engines

- `GET /v1/info` must list `page-state:sync` (an older peer is skipped and shown as `supported: false` in `peers`). Link tokens only (`linkForToken`, not revoked; any other Engine token 403 `LINKED_ONLY`); 404 with `SETTINGS_SYNC_ENABLED=false` (then the state stays on this engine).
- `GET /v1/page-state?public_key=` -> `{ instance_id, public_key, digest }` (an HMAC of the state under the link's page-state key). `POST /v1/page-state/pull { instance_id, public_key }` -> `{ instance_id, sealed }` (the whole state). `PUT /v1/page-state { instance_id, public_key, sealed }` -> `{ changed }`. The state travels only inside the settings sync's AES-256-GCM envelopes, with a key derived by HKDF from that link's settings-sync key (`linkKey`, info `t-agent page-state v1`) and the additional data `t-agent page-state v1|<push|pull>|<sender>|<link id>`. A sender whose instance id is not the link's is 400 `INVALID_PAGE_STATE`.
- **A round** with one peer: `/v1/info`, then the digest; equal digests end it. Else the peer's state is pulled and merged here, and the merged state is sent when it still differs. A side that changed by a merge (here, or a receiver of a `PUT`) starts a round with its other peers (fan-out), so a chain A–B–C reaches C and comes back; the echo stops at the digest check.
- **When**: 1 s after a page change (debounced), when a link comes online, at start and every 5 minutes. Failures are logged once per link and reason by code (`[page-state] sync with <name> failed: <code>`).
- **Per-task visibility**: the entries of this engine's tasks that a link may not see are left out of what that link gets and of the digest made for it.

## Key audit

Every localStorage and sessionStorage key of the page and its chunks (`public/js/h5.js`, `public/js/*.js`, `scripts/h5-shell/*`, `scripts/agent-chat/*`, `scripts/mindmap/*`). Shared: in the shared page state (the browser key is its cache). Local: stays in this browser, with the reason (also a comment where the key is defined).

| Key | Decision | Reason |
| --- | --- | --- |
| `h5-recent-sessions` | shared (the Recent list) | imported once, then removed |
| `h5-task-list-tab` | shared | a list choice |
| `h5-columns`, `h5-column:<pane id>` (new) | shared | the columns and the session of each |
| `h5-sidebar-collapsed` (top page) | shared | a layout choice; a pane's `pane:<id>:h5-sidebar-collapsed` stays with its pane |
| `h5-attention-collapsed` | shared, by instance id | collapsed groups |
| `h5-attention-add-on` | shared, by instance id | the engine a new T-Attention task goes to |
| `h5-design-outline` | shared | a display preference of the file sheet |
| `ta-saved-commands-used` | shared, merged per command | the recency of saved commands |
| `h5-mindmap-list-folded` | shared | a display preference of the Mind maps tab |
| `word-translate` | shared | tap to translate, a preference |
| `ta-lang` (and its cookie) | shared | the language; the cookie stays for the server |
| `h5-source`, `h5-task:<source>`, `h5-terminal:<source>:<task>` | local | which session this window opens at start: they decide the first requests (the early socket) before any answer, and opening the session last looked at on another device would open one the person did not choose here. The session last looked at anywhere is the first of the shared Recent list, one press of ⇋ away |
| `h5-terminal-width`, `h5-terminal-wide-cols` | local | the screen's size (fit or a fixed width) |
| `h5-terminal-width-noted` | local | a one-time hint about this device's gesture |
| `voice-enabled`, `voice-keep-mic` | local | this device's microphone and its permission |
| `h5-attention-sound` | local | Settings offers it as "Reminders on this device" (scope device): a phone in a meeting and a computer at home want different sounds |
| `t-agent.settings-tab` (`t-agent.settings-device` before) | local | the device whose settings the open form edits, chosen where it is edited, so a save never goes to a machine another device picked |
| `h5-mindmap-draft:<map>` | local | this browser's unsaved edits (a crash copy); the saved map is on its service |
| `h5-mindmap` under a pane (v2.133 / v2.134) | local | read only to drop old mind map columns |
| `pane:<id>:*` | local | a column's own memory in this browser (its session is shared as `h5-column:<id>`) |
| `terminal-client-id` (sessionStorage) | local | names this tab as a terminal client |
| `h5-auto-reloaded-versions` (sessionStorage) | local | the auto-reload guard |
| `ta-page-state`, `ta-page-state-imported`, `ta-lang-applied` (sessionStorage) | local | the cache of the shared state, the import marker, the once-per-tab language guard |
| `h5-agent:*`, `h5-attention-notify` | not read | left by older versions |

The last opened mind map is not remembered at all (the Mind maps tab opens on its list), so there is nothing to share.

## Known limits

- A change waiting in a browser that was offline is stamped when it reaches the server, so it can win over a change made a little earlier elsewhere (the later arrival wins).
- A tombstone lives 30 days: an engine that was away longer can bring a removed session back, until a page of its engine forgets it again.
- A page reads changes of other devices when it is shown again, gets the focus, or once a minute, not at once. Two columns views open at the same time follow each other's column sessions.
- The page does not yet say when an engine is offline or too old to share the state (`peers` in the answer has it, for a later note on the page).

Tests: `test/page-state.test.js` (merge rules, the page's identity mapping and codecs, two, three and four engines over real HTTP: the same Recent list and keys, a rename and a delete, changes on both sides, the push after a change, no loop, a chain, an older peer, a hidden task, the engine routes), `scripts/test-h5-shared-state-browser.cjs` (two engines' pages, a computer and a phone, over one mocked state: the import, the same list under each page's own keys, the tab and tap to translate followed on focus, a delete), and the tests of each moved key (unchanged behaviour without the server: the cache).
