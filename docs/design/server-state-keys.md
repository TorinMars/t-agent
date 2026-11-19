# Server state keys

> Part of the T-Agent design document. The index of all parts is [DESIGN.md](../../DESIGN.md).

The server keeps small pieces of state in two key / value tables: `system_state` (settings, sync bookkeeping, caches) and `engine_identity` (who this machine is). Every key of both is declared in one registry, `lib/server-state-keys.js`, with its **scope**, so it is plain which state follows the person to every engine and which stays on one machine, and why. It is the server twin of the browser's registry (`public/js/local-keys.js`, "Key audit" in [shared-page-state.md](shared-page-state.md)). The rule behind it: "One experience on every device and engine" in `AGENTS.md`.

## Scopes

- `shared`: synced to every linked engine, company computers included. The registry names the sync that carries it: a settings sync group ([settings-sync.md](settings-sync.md)), the shared page state ([shared-page-state.md](shared-page-state.md)), the shared task order, the Telegram sender choice.
- `personal`: the person's own data. Kept on the normal machines and synced between them; a company computer keeps only a cache and a hand-over queue ("Company computer" in [linked-device-settings.md](linked-device-settings.md)). Today: the learning settings (the Learn sync, [learn-english.md](learn-english.md)).
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
| `attention-summary:<owner>` | system_state | shared | settings sync, group attention-summary (encrypted) | `services/attention-summary.js` |
| `attention-notify:<owner>` | system_state | shared | settings sync, group notify-rules (encrypted) | `services/attention-notify.js` |
| `attention-plugin:<plugin>:<owner>` | system_state | shared | settings sync, group notifier-plugins (encrypted) | `services/attention-notify.js` |
| `task_list_hidden_instances_v1` | system_state | shared | settings sync, group task-list-devices (as engine instance ids) | `routes/task-list-prefs.js` |
| `browser_site_v1:<host>` | system_state | shared | settings sync, group browser-sites (merged per site) | `services/browser-sites.js` |
| `browser_sites_tombstones_v1` | system_state | shared | settings sync, group browser-sites (the deleted sites) | `services/browser-sites.js` |
| `page_state_v1:<owner>` | system_state | shared | the shared page state sync | `services/page-state.js` |
| `task_order_v1` | system_state | shared | the shared task order sync, last writer wins | `services/task-order.js` |
| `telegram_sender` | system_state | shared | the Telegram sender choice, sent to every linked device (`PUT /v1/attention/notify-relay/sender`), newest wins | `services/attention-relay.js` |
| `learn_v1:<owner>` | system_state | personal | the Learn sync: the learning settings | `services/learn.js` |
| `learn_v1_sync:<owner>` | system_state | personal | the Learn sync: the version clock of the learning settings | `services/learn.js` |
| `attention_widget_settings_v1` | system_state | device | the desktop window of this Mac: its switch and window preferences; its `language` field alone is shared (settings sync, group widget-language) | `services/attention-widget.js` |
| `task_list_hidden_devices_v1` | system_state | device | hidden devices named by page-relative keys (`local`, `remote:<row id>`) whose engine instance id is not known: they mean something only here | `routes/task-list-prefs.js` |
| `attention-notify:<plugin>:<owner>` | system_state | device | a notifier plugin's own state, such as the Telegram session: one login per device (settings sync group telegram) | `services/attention-notify.js` |
| `service_links_v1` | system_state | device | the service links of this machine and their tokens | `services/service-links.js` |
| `settings_sync_keypair_v1` | system_state | device | this machine's key pair for the sync envelopes (the private key encrypted) | `services/settings-sync.js` |
| `device_tier_v1` | system_state | device | the "Company computer" flag of this machine | `services/device-tier.js` |
| `peer_fs_v1` | system_state | device | whether linked sessions may read this machine's files (settings sync group peer-fs: device) | `services/peer-fs-settings.js` |
| `rule_sync_v1` | system_state | device | this machine's role in the rules and skills sync, and its state | `services/rule-sync.js` |
| `browser_ext_v1` | system_state | device | the browsers paired with this machine (token hashes) | `services/browser-bridge.js` |
| `frp_config` | system_state | device | the frp tunnel of this machine | `services/frp.js` |
| `ssh_tunnel_config` | system_state | device | the SSH tunnel of this machine | `services/ssh-tunnel.js` |
| `file_sync_v1` | system_state | device | this machine's file sync role and file list (the files travel by the file sync itself) | `services/file-sync.js` |
| `single_user_id` | system_state | device | the login that owns this machine's data | `services/single-user.js` |
| `update_auto` | system_state | device | automatic update of this machine: each engine updates itself under its own idle rule, with its history | `services/update-manager.js` |
| `task_link_visibility_v1` | system_state | device | which links may see which task of this machine (its own tasks and links) | `services/task-visibility.js` |
| `terminal_order_v1:<task>` | system_state | device | the order of the terminals of a task of this machine; other engines read it through the link with the task | `routes/terminal.js` |
| `remote_engine_names_v1` | system_state | device | which `remote_servers` rows of this machine take their name from their engine (row ids are machine-relative) | `services/engine-name.js` |
| `agent-config:<owner>` | system_state | device | the agent config defaults and per-server overrides, keyed by this machine's `remote_servers` rows | `services/agent-config.js` |
| `attention-guide:<owner>` | system_state | device | the T-Attention setup guide flags (dismissed, page only, paired, tested) | `services/attention-guide.js` |
| `ui_usage_v1` | system_state | device | the "Record button use" switch of this server | `services/ui-events.js` |
| `update_state` | system_state | runtime | the progress and result of the last update of this machine | `services/update-manager.js` |
| `settings_sync_v1` | system_state | runtime | the settings sync's clocks and value hashes per group | `services/settings-sync.js` |
| `settings_sync_peers_v1` | system_state | runtime | the settings sync's state per peer | `services/settings-sync.js` |
| `page_state_peers_v1` | system_state | runtime | the shared page state sync's state per peer | `services/page-state.js` |
| `learn_sync_peers_v1` | system_state | runtime | the Learn sync's change numbers per peer | `services/learn-sync.js` |
| `learn_home_v1` | system_state | runtime | on a company computer: the last summary of the normal machine that keeps its learning data | `services/learn-sync.js` |
| `remote_engine_instances_v1` | system_state | runtime | the instance id each `remote_servers` row's engine reported in `/v1/info` (a cache) | `services/engine-name.js` |
| `attention_widget_page_language_v1` | system_state | runtime | the language the person's page last used, learned from its cookie (a cache for the desktop window) | `services/attention-widget.js` |
| `instance_id` | engine_identity | device | the identity of this engine, made once; every shared state names engines by it | `services/engine-identity.js` |
| `name` | engine_identity | device | the name of this engine, kept by itself and shown everywhere (settings sync group engine-name: device) | `services/engine-name.js` |

## Keys whose scope looks wrong

Found by the audit that made the registry (2026-11-20). They keep their scope until the feature that owns them moves them; each has `concern` in the registry.

| Key | Scope today | Why it looks wrong for the rule |
| --- | --- | --- |
| `agent-config:<owner>` | device | the person's Claude / Codex defaults: the page of another engine shows a different set; should be shared, with the overrides keyed by engine instance id |
| `attention-guide:<owner>` | device | dismissed and pageOnly describe the person: the guide comes back on every other engine; should be shared (paired / tested may stay per machine) |
| `ui_usage_v1` | device | a preference of the person kept per server; becomes shared with the merged usage data ("usage-data-merged") |
| `update_auto` | device | the switch "Update automatically when idle" is a choice the person makes once; only its history and the idle rule are this machine's |

## Other stores

Not key / value rows, so not in the registry; listed so the picture is whole. Tables of the person's work are owned by the engine that runs it and reached from the others through the service link (location transparency), unless named otherwise.

- Personal, synced (the Learn sync): `learn_cards`, `learn_reviews`, `learn_card_moves`.
- Owned by their engine, reached through the link: `tasks`, `task_terminals` and the default-terminal tables, `task_todos`, `agent_conversations`, `apps`, `repo_cleanups`.
- This machine's connections and access: `remote_servers`, `remote_access_tokens`, `engine_access_tokens`, `engine_pairing_codes`, `attention_tokens`, `client_auth`, `users` (`work_dir` is the device setting "Working directory").
- Per engine today, with an item of the single-system-image program to change it: `attention_items` and `attention_events` (a read copy on every engine, "attention-replicated"), `ui_events` and `ui_controls` (one data set for the person, "usage-data-merged"), mind maps in `<data folder>/mindmaps/` (replicated, "mindmaps-replicated"). Also per engine: `task_groups` and `bookmarks`.

Test: `test/server-state-keys.test.js` (the scan of the sources, the scanner's own check on sample sources, unused declarations, the registry's shape and its most-specific match, the guard on a fresh database and on the server's database, this table, and the line in `AGENTS.md`).
