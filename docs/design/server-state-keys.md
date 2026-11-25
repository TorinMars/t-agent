# Server state keys

> Part of the T-Agent design document. The index of all parts is [DESIGN.md](../../DESIGN.md).

The server keeps small pieces of state in two key / value tables: `system_state` (settings, sync bookkeeping, caches) and `engine_identity` (who this machine is). Every key of both is declared in one registry, `lib/server-state-keys.js`, with its **scope**, so it is plain which state follows the person to every engine and which stays on one machine, and why. It is the server twin of the browser's registry (`public/js/local-keys.js`, "Key audit" in [shared-page-state.md](shared-page-state.md)). The rule behind it: "One experience on every device and engine" in `AGENTS.md`.

## Scopes

- `shared`: synced to every linked engine, company computers included. The registry names the sync that carries it: a settings sync group ([settings-sync.md](settings-sync.md)), the shared page state ([shared-page-state.md](shared-page-state.md)), the shared task order, the Telegram sender choice.
- `personal`: the person's own data. Kept on the normal machines and synced between them; a company computer keeps only a cache and a hand-over queue ("Company computer" in [linked-device-settings.md](linked-device-settings.md)). Today: the learning settings and the estimated level (the Learn sync, [learn-english.md](learn-english.md)) and the clear mark of the usage data (the usage data sync, [usage-data.md](usage-data.md)).
- `device`: this machine only, with the reason: its connections and tokens, its identity, its tunnels, a choice made for this machine, the data of its own tasks (which other engines reach through the link with the task), ids that mean something only here.
- `runtime`: the state of a process, a sync's bookkeeping (clocks, hashes, what each peer has seen) or a cache that is rebuilt.

## Enforcement

- **The database refuses an undeclared key.** `db/index.js` calls `guard(db)` right after the schema: a temporary trigger on insert (upserts and `INSERT OR REPLACE` included) and on a changed key of both tables calls `ta_state_key_check`, a function of the connection that throws `UNDECLARED_STATE_KEY: system_state key "<key>" is not declared in lib/server-state-keys.js …` (logged once per key). The triggers are `TEMP`: they live with the connection and are never written to the file, so an older version that opens the same database is not affected. Reads, value updates and deletes are not checked, so a row an older version left (a retired key) can still be read, changed and removed.
- **The guard test.** `test/server-state-keys.test.js` scans the server's sources (`server.js`, `config.js`, `db/`, `lib/`, `services/`, `routes/`, `middleware/`, `plugins/`, `scripts/` without the page code) for every key they read or write: SQL on either table (a key written in the SQL, or the argument given to `.get` / `.run` / `.all` where the statement is prepared), the helpers of `services/settings-sync-store.js` (`readState`, `writeState`) and the local wrappers of the same shape, and the module constants named `*_KEY` / `*Key`. A key argument may be a string, a template (`${…}` reads as any text, or as the constant of the file it names), a constant of the file, or a key builder (`const key = owner => \`translator:${owner}\``, also one of a required module, `learnModule.settingsKey(name)`). It fails, quoting the rule, when a key is not declared; when a key cannot be read (a statement prepared in one place and given its key in another: give the key where it is prepared); when a declared key is no longer used, or not used in the file the registry names as its owner; and when the table below differs from the registry (keys, stores, scopes, and the list of concerns). Wrappers that pass on their caller's key are listed in the test (`PASS_THROUGH`); their callers are checked.
- **A new key**: add it to `KEYS` in `lib/server-state-keys.js` with its scope and `how` (which sync; or why it stays here), and a row here. Person-level state is `shared` or `personal` and rides on a sync (a settings sync group, the shared page state, or its own sync with the same pattern), named by engine instance ids, never by `local` / `remote:<n>`.

## Key registry

`<owner>` is the login of the page, `<plugin>` a notifier plugin's name, `<host>` a site's host, `<task>` a task id of this machine. The most specific declaration wins (`attention-notify:<plugin>:<owner>` over `attention-notify:<owner>`).

| Key | Store | Scope | Synced by / why it stays here | Owner |
| --- | --- | --- | --- | --- |
| `translator:<owner>` | system_state | shared | settings sync, group translate (encrypted) | `services/translator.js` |
| `speech:<owner>` | system_state | shared | settings sync, group voice (encrypted) | `services/speech.js` |
| `oss-images:<owner>` | system_state | shared | settings sync, group oss (encrypted) | `services/oss-images.js` |
| `oss_agent_access_v1` | system_state | shared | settings sync, group oss-agent-access | `services/oss-agent-settings.js` |
| `agent-config:<owner>` | system_state | shared | settings sync, group agent-config: the Claude / Codex defaults; the per-server overrides and push results in the same row stay here (keyed by `local` and this machine's `remote_servers` row ids) | `services/agent-config.js` |
| `attention-summary:<owner>` | system_state | shared | settings sync, group attention-summary (encrypted) | `services/attention-summary.js` |
| `attention-guide:<owner>` | system_state | shared | settings sync, group attention-guide: `dismissed` and `pageOnly`; `paired` and `tested` in the same row stay here (what was done on this machine) | `services/attention-guide.js` |
| `attention-notify:<owner>` | system_state | shared | settings sync, group notify-rules (encrypted) | `services/attention-notify.js` |
| `attention-plugin:<plugin>:<owner>` | system_state | shared | settings sync, group notifier-plugins (encrypted) | `services/attention-notify.js` |
| `task_list_hidden_instances_v1` | system_state | shared | settings sync, group task-list-devices (as engine instance ids) | `routes/task-list-prefs.js` |
| `update_auto` | system_state | shared | settings sync, group update-auto: the `enabled` switch, once set with this version or later; the attempts, restarts and history in the same row stay here (each engine updates itself under its own idle rule) | `services/update-manager.js` |
| `browser_site_v1:<host>` | system_state | shared | settings sync, group browser-sites (merged per site) | `services/browser-sites.js` |
| `browser_sites_tombstones_v1` | system_state | shared | settings sync, group browser-sites (the deleted sites) | `services/browser-sites.js` |
| `ui_usage_v1` | system_state | shared | settings sync, group usage-record: the "Record button use" switch of the usage data | `services/ui-events.js` |
| `usage_time_record_v1` | system_state | shared | settings sync, group usage-time-record: the "Record time" switch of the usage time | `services/usage-time.js` |
| `usage_memories_digest_v1` | system_state | shared | settings sync, group usage-memories-digest: the "Write a weekly digest" switch of the memories | `services/usage-time.js` |
| `access_alerts_v1` | system_state | shared | settings sync, group access-alerts: the "Alert me about new devices" switch of the access log | `services/access-log.js` |
| `page_state_v1:<owner>` | system_state | shared | the shared page state sync | `services/page-state.js` |
| `task_order_v1` | system_state | shared | the shared task order sync, last writer wins | `services/task-order.js` |
| `telegram_sender` | system_state | shared | the Telegram sender choice, sent to every linked device (`PUT /v1/attention/notify-relay/sender`), newest wins | `services/attention-relay.js` |
| `learn_v1:<owner>` | system_state | personal | the Learn sync: the learning settings | `services/learn.js` |
| `learn_v1_sync:<owner>` | system_state | personal | the Learn sync: the version clock of the learning settings | `services/learn.js` |
| `learn_level_v1:<owner>` | system_state | personal | the Learn sync: the estimated English level with its version clock (the newest estimate wins; a company computer keeps a read-only copy) | `services/learn.js` |
| `ui_usage_clear_v1` | system_state | personal | the usage data sync (`services/ui-events-sync.js`): the last Clear of the merged usage data, which every engine applies | `services/ui-events.js` |
| `usage_time_clear_v1` | system_state | personal | the usage time sync (`services/usage-time-sync.js`): the last Clear of the Time tab, which every engine applies | `services/usage-time.js` |
| `usage_memories_clear_v1` | system_state | personal | the usage time sync (`services/usage-time-sync.js`): the last Clear of the Memories tab, which every engine applies | `services/usage-time.js` |
| `attention_widget_settings_v1` | system_state | device | the desktop window of this Mac: its switch and window preferences; its `language` field alone is shared (settings sync, group widget-language) | `services/attention-widget.js` |
| `task_list_hidden_devices_v1` | system_state | device | hidden devices named by page-relative keys (`local`, `remote:<row id>`) whose engine instance id is not known: they mean something only here | `routes/task-list-prefs.js` |
| `attention-notify:<plugin>:<owner>` | system_state | device | a notifier plugin's own state, such as the Telegram session: one login per device (settings sync group telegram) | `services/attention-notify.js` |
| `service_links_v1` | system_state | device | the service links of this machine and their tokens | `services/service-links.js` |
| `settings_sync_keypair_v1` | system_state | device | this machine's key pair for the sync envelopes (the private key encrypted) | `services/settings-sync.js` |
| `device_tier_v1` | system_state | device | the "Company computer" flag of this machine | `services/device-tier.js` |
| `sign_in_handover_v1` | system_state | device | whether this machine accepts sign-in hand-overs from its linked engines (Settings → Devices): a choice about logins to this machine | `services/sign-in-handover.js` |
| `peer_fs_v1` | system_state | device | whether linked sessions may read this machine's files (settings sync group peer-fs: device) | `services/peer-fs-settings.js` |
| `rule_sync_v1` | system_state | device | this machine's role in the rules and skills sync, and its state | `services/rule-sync.js` |
| `browser_ext_v1` | system_state | device | the browsers paired with this machine (token hashes) | `services/browser-bridge.js` |
| `frp_config` | system_state | device | the frp tunnel of this machine | `services/frp.js` |
| `ssh_tunnel_config` | system_state | device | the SSH tunnel of this machine | `services/ssh-tunnel.js` |
| `access_log_v1` | system_state | device | when this machine's access log started (sessions signed in before it are learned without an alert); the log is this machine's own | `services/access-log.js` |
| `file_sync_v1` | system_state | device | this machine's file sync role and file list (the files travel by the file sync itself) | `services/file-sync.js` |
| `single_user_id` | system_state | device | the login that owns this machine's data | `services/single-user.js` |
| `updated_notice_v1:<owner>` | system_state | device | the update of this machine the person has not acknowledged yet; the dialog of any linked page acknowledges it here through /v1/updated-notice | `services/updated-notice.js` |
| `task_link_visibility_v1` | system_state | device | which links may see which task of this machine (its own tasks and links) | `services/task-visibility.js` |
| `terminal_order_v1:<task>` | system_state | device | the order of the terminals of a task of this machine; other engines read it through the link with the task | `routes/terminal.js` |
| `remote_engine_names_v1` | system_state | device | which `remote_servers` rows of this machine take their name from their engine (row ids are machine-relative) | `services/engine-name.js` |
| `updated_running_v1` | system_state | runtime | the version this service ran at its last start, to notice an update | `services/updated-notice.js` |
| `update_state` | system_state | runtime | the progress and result of the last update of this machine | `services/update-manager.js` |
| `settings_sync_v1` | system_state | runtime | the settings sync's clocks and value hashes per group | `services/settings-sync.js` |
| `settings_sync_peers_v1` | system_state | runtime | the settings sync's state per peer | `services/settings-sync.js` |
| `sign_in_handover_used_v1` | system_state | runtime | the ids of sign-in hand-overs already used, each until it expires (at most a minute and a half), so a hand-over works once | `services/sign-in-handover.js` |
| `linked_web_addresses_v1` | system_state | runtime | a cache of the web addresses and the hand-over switch each linked engine told while online, for the page's "Continue on" and app.json | `services/sign-in-handover.js` |
| `linked_last_tasks_v1` | system_state | runtime | a cache of the task names last read from each linked engine, shown dimmed while it is offline | `services/linked-last-tasks.js` |
| `page_state_peers_v1` | system_state | runtime | the shared page state sync's state per peer | `services/page-state.js` |
| `learn_sync_peers_v1` | system_state | runtime | the Learn sync's change numbers per peer | `services/learn-sync.js` |
| `learn_sentences_day_v1:<owner>` | system_state | runtime | the day and the count of the example sentences this engine asked the model for today (a budget per engine, at most 10 a day) | `services/learn-sentences.js` |
| `learn_home_v1` | system_state | runtime | on a company computer: the last summary of the normal machine that keeps its learning data | `services/learn-sync.js` |
| `ui_usage_sync_peers_v1` | system_state | runtime | the usage data sync's change numbers and tiers per peer | `services/ui-events-sync.js` |
| `ui_usage_home_v1` | system_state | runtime | on a company computer: the normal machine its usage data was last handed to | `services/ui-events-sync.js` |
| `mindmap_sync_peers_v1` | system_state | runtime | the mind map sync's change numbers, tiers and hand-over per peer | `services/mindmap-sync.js` |
| `mindmap_home_v1` | system_state | runtime | on a company computer: the normal machine its mind maps were last handed to | `services/mindmap-sync.js` |
| `ui_usage_seq_v1` | system_state | runtime | the newest change number of the usage data, kept when rows are deleted so the numbers never go back | `services/ui-events.js` |
| `ui_usage_engines_v1` | system_state | runtime | the names of the engines whose button presses are in the usage data (a cache from the sync pages) | `services/ui-events.js` |
| `usage_time_sync_peers_v1` | system_state | runtime | the usage time sync's change numbers and tiers per peer | `services/usage-time-sync.js` |
| `usage_time_home_v1` | system_state | runtime | on a company computer: the normal machine its usage time and memories were last handed to | `services/usage-time-sync.js` |
| `usage_time_seq_v1` | system_state | runtime | the newest change number of the usage time and memories, kept when rows are deleted so the numbers never go back | `services/usage-time.js` |
| `usage_time_engines_v1` | system_state | runtime | the names of the engines whose rows are in the usage time and memories (a cache from the sync pages) | `services/usage-time.js` |
| `usage_memories_digest_try_v1` | system_state | runtime | the week and time of the last automatic try of the weekly digest, so a failing provider is asked at most every 6 hours | `services/usage-digest.js` |
| `attention_copy_peers_v1` | system_state | runtime | the T-Attention copies' change numbers and capability per peer | `services/attention-copy.js` |
| `attention_copy_owners_v1` | system_state | runtime | the names, hosts and last-heard times of the engines whose T-Attention items are copied here (a cache from the sync pages) | `services/attention-copy.js` |
| `attention_copy_clock_v1` | system_state | runtime | the T-Attention copies' version clock and newest change number, kept so neither goes back when rows are removed | `services/attention-copy.js` |
| `remote_engine_instances_v1` | system_state | runtime | the instance id each `remote_servers` row's engine reported in `/v1/info` (a cache) | `services/engine-name.js` |
| `attention_widget_page_language_v1` | system_state | runtime | the language the person's page last used, learned from its cookie (a cache for the desktop window) | `services/attention-widget.js` |
| `instance_id` | engine_identity | device | the identity of this engine, made once; every shared state names engines by it | `services/engine-identity.js` |
| `name` | engine_identity | device | the name of this engine, kept by itself and shown everywhere (settings sync group engine-name: device) | `services/engine-name.js` |

## Keys whose scope looks wrong

Found by the audit that made the registry (2026-11-20). They keep their scope until the feature that owns them moves them; each has `concern` in the registry.

| Key | Scope today | Why it looks wrong for the rule |
| --- | --- | --- |

Moved since: `ui_usage_v1` (the "Record button use" switch) is shared through the settings sync group `usage-record` ("usage-data-merged", 2026-11-20). Moved with "scope-fixes" (2026-11-20): `agent-config:<owner>` (its defaults), `attention-guide:<owner>` (`dismissed`, `pageOnly`) and `update_auto` (`enabled`, once set with this version) are shared through the settings sync, groups `agent-config`, `attention-guide` and `update-auto` ([settings-sync.md](settings-sync.md)). Each keeps its per-machine fields in the same row: the agent-config overrides and push results (keyed by this machine's `remote_servers` rows: re-keying them by engine instance id would only matter for a page that edits them, and none does now), the guide's `paired` / `tested`, and the update attempts and history.

## Other stores

Not key / value rows, so not in the registry; listed so the picture is whole. Tables of the person's work are owned by the engine that runs it and reached from the others through the service link (location transparency), unless named otherwise.

- Personal, synced (the Learn sync): `learn_cards`, `learn_reviews`, `learn_card_moves`. Personal, synced (the usage data sync): `ui_events`, `ui_controls`. Personal, a copy on every normal engine (the mind map sync, [mind-maps.md](mind-maps.md)): the files of `<data folder>/mindmaps/` with `sync/state.json` and `sync/tombstones/`.
- Owned by their engine, reached through the link: `tasks`, `task_terminals` and the default-terminal tables, `task_todos`, `agent_conversations`, `apps`, `repo_cleanups`.
- This machine's connections and access: `remote_servers`, `remote_access_tokens`, `engine_access_tokens`, `engine_pairing_codes`, `attention_tokens`, `client_auth`, `users` (`work_dir` is the device setting "Working directory").
- Per engine today, with an item of the single-system-image program to change it: `attention_items` and `attention_events` (a read copy on every engine, "attention-replicated"). Also per engine: `task_groups` and `bookmarks`.
- Audited per-owner tables ("scope-fixes", 2026-11-20), left per engine with a recommendation:
  - `task_groups`: the groups the tasks of that engine sit in (a task's `status` is the group key). Every engine makes the same four (Personal tasks, In progress, To do, Done) and the page groups by key, falling back to those four; the page no longer creates, renames or reorders groups (the writes of `/api/task-groups` are kept for compatibility only), the order of the tasks is shared (`task_order_v1`) and the collapsed groups are in the shared page state. Nothing the person sees differs between engines today. Recommendation: keep it with its engine; if editing groups comes back, keep the list as one settings sync group keyed by group key (name and order), not by row id.
  - `bookmarks`: no owner column, read and written only by the compatibility endpoint `/api/bookmarks`; no page shows it. Recommendation: retire the table and the route in a later cleanup rather than sync it; if bookmarks come back, keep them in the shared page state or a settings sync group merged per entry (as the site library).
  - Device by design: `users.work_dir` (folders differ per machine), `apps` and `repo_cleanups` (they run on their machine), `attention_tokens` and `remote_servers` (this machine's connections).

Test: `test/server-state-keys.test.js` (the scan of the sources, the scanner's own check on sample sources, unused declarations, the registry's shape and its most-specific match, the guard on a fresh database and on the server's database, this table, and the line in `AGENTS.md`).
