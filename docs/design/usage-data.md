# Usage data

> Part of the T-Agent design document. The index of all parts is [DESIGN.md](../../DESIGN.md).

## Usage data

Local, private tracking of which buttons of the page (`/` and `/h5`, its lazy chunks and the columns of the multi-column view) are pressed, so the layout can later be improved from real use: what is used most, what is never used, what is pressed after what. Everything stays on the server that serves the page; nothing is sent to any outside service.

- **Page**: `scripts/h5-shell/usage-track.mjs` (first screen, about 1.8 KB minified) and `scripts/h5-shell/usage-recorder.mjs` (a chunk of its own, `usage-recorder-<hash>.js`, loaded only while recording is on). Settings group: `scripts/h5-shell/UsageData.jsx` (in the Settings chunk).
- **Server**: `services/ui-events.js` (storage, summary, export, retention), `routes/ui-events.js` (`/api/ui-events`), tables `ui_events` and `ui_controls` in `db/schema.sql` (schema 12).
- **Tests**: `test/h5-usage-track.test.js` (keys, surfaces, privacy, batches, the switch), `test/ui-events.test.js` (route, caps, login, retention, summary, export, clear), the 11 → 12 migration in `test/data-home.test.js`, and `scripts/test-h5-usage-data-browser.cjs` (real presses on a computer and a phone, raw request bodies, the beacon, the switch, the Settings group, Clear and Export).

### What is recorded, and what never is

One event per activation of a button-like control: `button`, `[role=button|menuitem|menuitemcheckbox|menuitemradio|tab|option|switch]`, checkbox and radio inputs (a Switch or Checkbox counts by its input; its round ButtonBase is mapped to the input), links and labels styled as MUI buttons (`a.MuiButtonBase-root`, `label.MuiButtonBase-root`) and any `.MuiButtonBase-root` (list rows, chips, tabs, nav items, toggle buttons). One capture-phase `click` listener on the document covers every control, also new ones, without touching the ~310 handlers; Enter / Space count through a capture-phase `keydown` only on controls that are not native buttons (MUI calls their `onClick` without a DOM click: list rows, menu items, tabs). A disabled control is not recorded.

Never recorded: visible text, `aria-label`, `title`, input values, task / session / device / file names, paths, terminal text, URLs, `data-session`, `data-path` or any other data attribute outside the list below. The character keys of the on-screen keyboard (`data-char`, `Osk.jsx`) are typing and are not recorded at all, not even as a count.

Each event: `at` (ms), `key`, optional `detail`, `surface`, `view` (`sessions` | `columns` | `maps`), `layout` (`wide` | `narrow`), `input` (`pointer` | `touch`), `pane` (pressed inside a column of the multi-column view), `device` (`local` | `remote`: where the shown session runs, never its name), optional `state` (`on` | `off`: the new state of a switch, checkbox or `aria-pressed` toggle). The server adds `page` (a random id of one page load), `version` (its app version) and corrects `at` to its own clock.

### Keys

The key is the control's stable identity (`identityOf` in `usage-recorder.mjs`), in this order:

1. `data-track` (added where a control has no id: `h5-paste-text`, `h5-add-menu-command`, `h5-add-menu-key`, `h5-menu-action`).
2. The element id, cleaned (`cleanId`): React / MUI generated ids (`:r1:`, `_r_1_`, `mui-4`) are refused, a run of hex with digits (a uuid) becomes `*`, a number between dashes `#` (`h5-settings-tab-3` → `h5-settings-tab-#`), and ids that end in a name (`h5-agent-skill-install-…`, `h5-plugin-login-…`, `h5-plugins-tab-…`, `h5-notify-mode-…`) keep only the prefix plus `*`.
3. `data-action` as `action:<value>` (`action:more`, `action:approve`).
4. A fixed data attribute as `<prefix>:<value>`, only when the value is a short plain word: `data-key` → `key:Escape`, `data-modifier` → `mod:ctrl`, `data-shortcut`, `data-view`, `data-filter`, `data-group`, `data-cols`. A value with other characters (the switcher card's `data-key="remote:7|12|c1"`) is ignored.
5. Fallbacks: the element's own project class (`h5-task-item`, `h5-terminal-main`, `h5-task-more`, `h5-switcher-card`: the kind of a row, never its content), else the closest project class or `h5-` id above it with the role (`h5-header-more-menu/menuitem`), else the role alone.

`detail` (`data-track-detail`, printable ASCII, at most 48 characters) is a fixed product string of a list row: the preset command of `commands.mjs` (there is no user editing of the presets; if it comes, the detail must go), the label of a key combination, or the label of a task / session menu row when it is one of `MENU_ACTIONS` in `usage-track.mjs` and not a `raw` (name) label.

Measured in `scripts/test-h5-usage-data-browser.cjs` (visible controls): computer main screen 29 controls, 6 by their own class (the task rows' `h5-task-item`, `h5-task-more`, `h5-task-add`); with the saved commands open 47, 16 by class (the session rows and the command rows' edit pencil); phone terminal page 32, none by a fallback; the Settings group's own controls all by id.

### Surfaces

A small fixed set from the closest known container (`surfaceOf`): `settings:<group>` (or `settings` for the group list), `switcher`, `rail`, `bottom-nav`, `menu:commands` (the saved commands list), `key-row`, `keyboard` (the on-screen keyboard), `attention`, `design`, `files`, `maps`, `chat`, `task-menu`, `menu:<id>` / `dialog:<id>` (an MUI menu or dialog, by its cleaned id without `h5-`), `task-list`, `tool-row` (row 2 of a phone) or `bottom-row` (the one row of a computer or a column, the draft box), `header`, `columns`, `notice`, `page`.

### Sending

`usage-track.mjs` keeps only the target and the store's state of each press; 1.5 s after the start it reads the switch (`GET /api/ui-events/settings`, again when the page comes back after 10 minutes or more) into `state.usageRecording`. Only when it is on is the recorder chunk loaded; up to 50 presses before that are kept and then turned into events (or dropped when it is off). The recorder buffers events and sends them with `fetch(..., { keepalive: true })` 10 s after the first buffered one or at 50 events, and on `pagehide` / `visibilitychange` to hidden with `navigator.sendBeacon`. No request per press. It also reports the controls on screen (`seen`: key, surface, layout; only combinations not sent yet by this page), scanned in an idle callback 3 s after it starts and 1.5 s after each press (a press often opens a menu or dialog). The handler does no layout reads beyond `closest()`. While the switch is off nothing is buffered, scanned or sent, and turning it off drops what was buffered; a POST answered with `enabled: false` (turned off on another page) turns it off here.

### Storage and retention

Only in the SQLite database of the server that serves the page: `ui_events` (one row per press, index on `at`) and `ui_controls` (`key`, `surface`, `layout`, `first_seen`, `last_seen`). Schema 12 (new tables count as a schema change, see "Version release rules" in `architecture-data.md`). Rows older than 90 days (and controls not seen for 90 days) are deleted at start and once a day (`startRetention`, an unref'd timer). Clear deletes both tables.

### The switch

"Record button use", on by default, per server (`system_state` key `ui_usage_v1` `{ enabled }`), shared by all pages of that server and not part of the settings sync. It is in Settings → Usage data; a linked device's tab shows the note to open that device's own page (`LocalOnly`), since usage data lives on each server.

### API

Behind the page login and same-origin check like every `/api` route.

- `GET /api/ui-events/settings` → `{ enabled }`; `PUT` with exactly `{ enabled: boolean }` → `{ enabled }` (else 400 `INVALID_UI_EVENTS_SETTING`).
- `POST /api/ui-events` with `{ page, sent, events, seen }` → `{ accepted, enabled }`. Checked whole, any problem refuses the batch with 400 `INVALID_UI_EVENTS`: unknown fields (batch, event or seen entry), `page` not 6–32 lower-case letters / digits, more than 100 events or 200 seen entries, a key outside `^[A-Za-z][A-Za-z0-9_:#*./-]{0,79}$`, a surface outside `^[a-z][a-z0-9-]{0,23}(:[A-Za-z0-9#*_-]{1,48})?$`, a detail that is not printable ASCII of at most 48, an unknown view / layout / input / device / state, `pane` not a boolean. Times are moved by `server now − sent`; an event still older than a day or more than a minute ahead is dropped. While the switch is off: `{ accepted: 0, enabled: false }` and nothing is stored.
- `GET /api/ui-events/summary?days=30&layout=wide|narrow` (days 1–90; layout optional) →
  `{ enabled, days, layout, since, total, top, unused, next, data }`:
  - `top`: up to 10 keys by count, each `{ key, count, surfaces: [{ surface, count }], layouts: { wide, narrow }, details: [{ detail, count }] }`;
  - `unused`: controls seen in the window and never pressed there, compared per key, surface and layout, joined per key and surface: `{ key, surface, layouts, first_seen, last_seen }`;
  - `next`: for each key the most common following key within 30 s in the same page load, `{ key, next, count, followed }` (followed: how many presses of the key had any next press), the 30 most frequent;
  - `data`: the whole store, `{ count, first_at, retention_days: 90, bytes }` (size of the tables and indexes from SQLite's `dbstat`, an estimate where it is missing).
- `GET /api/ui-events/export` → a JSON download (`t-agent-usage-<date>.json`): `{ exported_at, retention_days, events: [...every stored row with an ISO time...], controls: [...] }`, written in pieces as the rows are read.
- `DELETE /api/ui-events` → `{ cleared }`.

### Settings group "Usage data"

The last group of Settings (`usage-data` in `settings-target.mjs`; parts `usage-record`, `usage-top`, `usage-unused`, `usage-store`, all in this device's tab), both layouts, `openSettings('usage-data')`. Cards, as in the mockup: the switch row; "Most used · last 30 days" with an All / Computer / Phone toggle (`#h5-usage-layout`, reads the summary of that layout) and the top keys as bars (name, surface with "· computer" / "· phone" when all presses were on one layout, a bar relative to the first, the count; on a phone the name, surface and count on one line and the bar under them); "Not used in 30 days" with chips ("Candidates to move into a menu.", a layout or surface added when it tells them apart); "Data" with the count, first date, "kept for 90 days", size, Clear (error colour, a confirmation dialog of the one dialog pattern: Cancel, Clear) and Export JSON (a link to the export). Readable names come from `NAMES` in `UsageData.jsx` (key → English, translated through `i18n-zh-ui.js`), `key:` / `mod:` keys read "<key> key", anything else is shown as the key itself.
