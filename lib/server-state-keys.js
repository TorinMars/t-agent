// The registry of every state key the server keeps in its key / value tables (`system_state` and `engine_identity`), with its scope. The server
// twin of public/js/local-keys.js. Rule: "One experience on every device and engine" in AGENTS.md: state that describes the person and their work is
// kept on the server and shared by all linked engines; what stays on one machine says why. See docs/design/server-state-keys.md.
//
// Scopes:
//   shared    synced to every linked engine, company computers included; `how` names the sync that carries it
//   personal  the person's own data: kept on the normal machines (synced between them), a company computer keeps only a cache and a hand-over
//             queue ("Company computer" in docs/design/linked-device-settings.md); `how` names the sync
//   device    this machine only; `how` says why (its connections, its identity, its hardware, a choice made for this machine, data of its own tasks)
//   runtime   the state of a process, a sync's bookkeeping or a cache that is rebuilt; `how` says of what
//
// A key is a fixed name or a pattern with placeholders (`<owner>`, `<plugin>`, `<host>`, `<task>`), each standing for any non-empty text. The most
// specific declaration wins (`attention-notify:<plugin>:<owner>` over `attention-notify:<owner>`).
//
// Enforcement: guard(db) (db/index.js) makes the database refuse a row with an undeclared key (a temporary trigger on insert and on a changed key
// that calls back into declared(); the error is UNDECLARED_STATE_KEY and names the key), and test/server-state-keys.test.js scans the server's
// sources for every key they read or write and fails when one is not declared here, when a declared key is no longer used, or when the table in
// docs/design/server-state-keys.md lists other keys or scopes. `concern`: the scope this key has today looks wrong for the rule; it is kept as it is
// until the feature that owns it moves it (listed in the doc, "Keys whose scope looks wrong").

const STORES = Object.freeze(['system_state', 'engine_identity']);
const SCOPES = Object.freeze(['shared', 'personal', 'device', 'runtime']);

const S = 'system_state';
const E = 'engine_identity';

// [store, key, scope, how, owner file, concern?]
const KEYS = Object.freeze([
  // Settings sync groups (services/settings-sync.js, "Settings sync across linked devices" in docs/design/settings-sync.md).
  [S, 'translator:<owner>', 'shared', 'settings sync, group translate (encrypted)', 'services/translator.js'],
  [S, 'speech:<owner>', 'shared', 'settings sync, group voice (encrypted)', 'services/speech.js'],
  [S, 'oss-images:<owner>', 'shared', 'settings sync, group oss (encrypted)', 'services/oss-images.js'],
  [S, 'oss_agent_access_v1', 'shared', 'settings sync, group oss-agent-access', 'services/oss-agent-settings.js'],
  [S, 'attention-summary:<owner>', 'shared', 'settings sync, group attention-summary (encrypted)', 'services/attention-summary.js'],
  [S, 'attention-notify:<owner>', 'shared', 'settings sync, group notify-rules (encrypted)', 'services/attention-notify.js'],
  [S, 'attention-plugin:<plugin>:<owner>', 'shared', 'settings sync, group notifier-plugins (encrypted)', 'services/attention-notify.js'],
  [S, 'task_list_hidden_instances_v1', 'shared', 'settings sync, group task-list-devices (as engine instance ids)', 'routes/task-list-prefs.js'],
  [S, 'browser_site_v1:<host>', 'shared', 'settings sync, group browser-sites (merged per site)', 'services/browser-sites.js'],
  [S, 'browser_sites_tombstones_v1', 'shared', 'settings sync, group browser-sites (the deleted sites)', 'services/browser-sites.js'],
  // Syncs of their own.
  [S, 'page_state_v1:<owner>', 'shared', 'the shared page state sync (services/page-state.js)', 'services/page-state.js'],
  [S, 'task_order_v1', 'shared', 'the shared task order sync, last writer wins (services/task-order.js)', 'services/task-order.js'],
  [S, 'telegram_sender', 'shared', 'the Telegram sender choice, sent to every linked device (PUT /v1/attention/notify-relay/sender), newest wins', 'services/attention-relay.js'],
  [S, 'learn_v1:<owner>', 'personal', 'the Learn sync: the learning settings (services/learn-sync.js)', 'services/learn.js'],
  [S, 'learn_v1_sync:<owner>', 'personal', 'the Learn sync: the version clock of the learning settings', 'services/learn.js'],
  // This machine only.
  [S, 'attention_widget_settings_v1', 'device', 'the desktop window of this Mac: its switch and window preferences; its `language` field alone is shared (settings sync, group widget-language)', 'services/attention-widget.js'],
  [S, 'task_list_hidden_devices_v1', 'device', 'hidden devices named by page-relative keys (local, remote:<row id>) whose engine instance id is not known: they mean something only here', 'routes/task-list-prefs.js'],
  [S, 'attention-notify:<plugin>:<owner>', 'device', 'a notifier plugin\'s own state, such as the Telegram session: one login per device (settings sync group telegram)', 'services/attention-notify.js'],
  [S, 'service_links_v1', 'device', 'the service links of this machine and their tokens', 'services/service-links.js'],
  [S, 'settings_sync_keypair_v1', 'device', 'this machine\'s key pair for the sync envelopes (the private key encrypted)', 'services/settings-sync.js'],
  [S, 'device_tier_v1', 'device', 'the "Company computer" flag of this machine', 'services/device-tier.js'],
  [S, 'peer_fs_v1', 'device', 'whether linked sessions may read this machine\'s files (settings sync group peer-fs: device)', 'services/peer-fs-settings.js'],
  [S, 'rule_sync_v1', 'device', 'this machine\'s role in the rules and skills sync, and its state', 'services/rule-sync.js'],
  [S, 'browser_ext_v1', 'device', 'the browsers paired with this machine (token hashes)', 'services/browser-bridge.js'],
  [S, 'frp_config', 'device', 'the frp tunnel of this machine', 'services/frp.js'],
  [S, 'ssh_tunnel_config', 'device', 'the SSH tunnel of this machine', 'services/ssh-tunnel.js'],
  [S, 'file_sync_v1', 'device', 'this machine\'s file sync role and file list (the files travel by the file sync itself)', 'services/file-sync.js'],
  [S, 'single_user_id', 'device', 'the login that owns this machine\'s data', 'services/single-user.js'],
  [S, 'update_auto', 'device', 'automatic update of this machine: each engine updates itself under its own idle rule, with its history', 'services/update-manager.js',
    'the switch "Update automatically when idle" is a choice the person makes once; only its history and the idle rule are this machine\'s'],
  [S, 'task_link_visibility_v1', 'device', 'which links may see which task of this machine (its own tasks and links)', 'services/task-visibility.js'],
  [S, 'terminal_order_v1:<task>', 'device', 'the order of the terminals of a task of this machine; other engines read it through the link with the task', 'routes/terminal.js'],
  [S, 'remote_engine_names_v1', 'device', 'which remote_servers rows of this machine take their name from their engine (row ids are machine-relative)', 'services/engine-name.js'],
  [S, 'agent-config:<owner>', 'device', 'the agent config defaults and per-server overrides, keyed by this machine\'s remote_servers rows', 'services/agent-config.js',
    'the person\'s Claude / Codex defaults: the page of another engine shows a different set; should be shared, with the overrides keyed by engine instance id'],
  [S, 'attention-guide:<owner>', 'device', 'the T-Attention setup guide flags (dismissed, page only, paired, tested)', 'services/attention-guide.js',
    'dismissed and pageOnly describe the person: the guide comes back on every other engine; should be shared (paired / tested may stay per machine)'],
  [S, 'ui_usage_v1', 'device', 'the "Record button use" switch of this server', 'services/ui-events.js',
    'a preference of the person kept per server; becomes shared with the merged usage data ("usage-data-merged")'],
  // State of a process, a sync's bookkeeping, caches.
  [S, 'update_state', 'runtime', 'the progress and result of the last update of this machine', 'services/update-manager.js'],
  [S, 'settings_sync_v1', 'runtime', 'the settings sync\'s clocks and value hashes per group', 'services/settings-sync.js'],
  [S, 'settings_sync_peers_v1', 'runtime', 'the settings sync\'s state per peer', 'services/settings-sync.js'],
  [S, 'page_state_peers_v1', 'runtime', 'the shared page state sync\'s state per peer', 'services/page-state.js'],
  [S, 'learn_sync_peers_v1', 'runtime', 'the Learn sync\'s change numbers per peer', 'services/learn-sync.js'],
  [S, 'learn_home_v1', 'runtime', 'on a company computer: the last summary of the normal machine that keeps its learning data', 'services/learn-sync.js'],
  [S, 'remote_engine_instances_v1', 'runtime', 'the instance id each remote_servers row\'s engine reported in /v1/info (a cache)', 'services/engine-name.js'],
  [S, 'attention_widget_page_language_v1', 'runtime', 'the language the person\'s page last used, learned from its cookie (a cache for the desktop window)', 'services/attention-widget.js'],
  // engine_identity: who this machine is.
  [E, 'instance_id', 'device', 'the identity of this engine, made once; every shared state names engines by it', 'services/engine-identity.js'],
  [E, 'name', 'device', 'the name of this engine, kept by itself and shown everywhere (settings sync group engine-name: device)', 'services/engine-name.js'],
].map(([store, key, scope, how, owner, concern]) => Object.freeze({ store, key, scope, how, owner, ...(concern ? { concern } : {}) })));

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A declared key as a regular expression: each placeholder stands for any non-empty text.
const toRegex = key => new RegExp(`^${key.split(/<[a-z]+>/).map(escape).join('.+')}$`);
// The literal part of a declared key: the longer, the more specific.
const literalLength = key => key.replace(/<[a-z]+>/g, '').length;
const MATCHERS = KEYS.map(entry => ({ entry, regex: toRegex(entry.key), weight: literalLength(entry.key) }))
  .sort((a, b) => b.weight - a.weight);

// The declaration of a stored key, or null.
function declared(store, key) {
  if (!STORES.includes(store) || typeof key !== 'string' || !key) return null;
  const hit = MATCHERS.find(({ entry, regex }) => entry.store === store && regex.test(key));
  return hit ? hit.entry : null;
}

function undeclaredError(store, key) {
  return Object.assign(new Error(`UNDECLARED_STATE_KEY: ${store} key ${JSON.stringify(String(key))} is not declared in lib/server-state-keys.js `
    + '(see "One experience on every device and engine" in AGENTS.md and docs/design/server-state-keys.md)'), { code: 'UNDECLARED_STATE_KEY' });
}

// Throws UNDECLARED_STATE_KEY for a key the registry does not declare; returns its declaration otherwise.
function assertDeclared(store, key) {
  const entry = declared(store, key);
  if (!entry) throw undeclaredError(store, key);
  return entry;
}

// Makes this database connection refuse a row of system_state or engine_identity whose key is not declared: a temporary trigger (it lives with the
// connection, never in the file, so an older version opening the same database is not affected) on every insert (upserts included) and on every
// change of a key calls ta_state_key_check, which throws. A refused write is logged once per key.
const logged = new Set();
function guard(db, { log = console.warn } = {}) {
  db.function('ta_state_key_check', { deterministic: true }, (store, key) => {
    if (declared(store, key)) return 1;
    const error = undeclaredError(store, key);
    if (!logged.has(`${store}\0${key}`)) { logged.add(`${store}\0${key}`); try { log(error.message); } catch { /* the error is thrown anyway */ } }
    throw error;
  });
  for (const store of STORES) {
    db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS ta_state_key_insert_${store} BEFORE INSERT ON main.${store}
      BEGIN SELECT ta_state_key_check('${store}', NEW.key); END`);
    db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS ta_state_key_update_${store} BEFORE UPDATE OF key ON main.${store}
      BEGIN SELECT ta_state_key_check('${store}', NEW.key); END`);
  }
  return db;
}

module.exports = { KEYS, SCOPES, STORES, declared, assertDeclared, guard, toRegex };
