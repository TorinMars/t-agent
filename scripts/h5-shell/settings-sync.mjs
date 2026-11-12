// The model behind the scope labels of the settings sheet (ScopeLabel.jsx): what a change to one setting affects ("Shared across devices", "This device
// only", Telegram's one sender) and how far a shared change got. Data: GET /api/settings-sync
//   { supported, scopes: { <id>: 'shared'|'device'|'telegram' }, keys: [{ key, scope, updated_at, updated_by_name, synced_peers, pending_peers }],
//     peers: [{ name, online, supported, last_sync_at, last_error }] }
// An older server answers 404: no labels at all (the page as before). With no linked device the labels are not shown either: on one machine the
// difference means nothing. Pure functions, no React; `t` translates (the page passes I18n.t).
import { relativeTime, timeOf } from './plugins-model.mjs';

const plain = text => text;
export const SCOPES = ['shared', 'device', 'telegram'];
const names = list => (Array.isArray(list) ? list.filter(name => typeof name === 'string' && name).map(String) : []);

// The answer of the route, or null / { supported: false } when there is none. Unknown scopes are dropped.
export function normalizeSync(data) {
  if (!data || typeof data !== 'object' || data.supported === false) return { supported: false, scopes: {}, keys: [], peers: [], sender: '' };
  const scopes = {};
  for (const [id, scope] of Object.entries(data.scopes && typeof data.scopes === 'object' ? data.scopes : {})) if (SCOPES.includes(scope)) scopes[id] = scope;
  const keys = (Array.isArray(data.keys) ? data.keys : []).filter(entry => entry && typeof entry.key === 'string').map(entry => ({
    key: entry.key, scope: SCOPES.includes(entry.scope) ? entry.scope : null, updated_at: entry.updated_at || null,
    updated_by_name: typeof entry.updated_by_name === 'string' ? entry.updated_by_name : '', synced_peers: names(entry.synced_peers), pending_peers: names(entry.pending_peers),
  }));
  const peers = (Array.isArray(data.peers) ? data.peers : []).filter(peer => peer && typeof peer.name === 'string' && peer.name).map(peer => ({
    name: peer.name, online: peer.online !== false, supported: peer.supported !== false, last_sync_at: peer.last_sync_at || null, last_error: peer.last_error ? String(peer.last_error) : '',
  }));
  // The device that sends Telegram, when the server says (an optional field; without it the label says one device sends).
  const telegram = data.telegram && typeof data.telegram === 'object' ? data.telegram : {};
  const sender = [data.telegram_sender, telegram.sender_name, telegram.sender].find(value => typeof value === 'string' && value.trim()) || '';
  return { supported: true, scopes, keys, peers, sender: sender.trim() };
}

// Labels are shown when the server knows about settings sync and at least one device is linked.
export const labelsShown = sync => Boolean(sync && sync.supported && sync.peers.length > 0);

// The scope of a setting: what the server says, else the scope the page knows for it (`fallback`).
export const scopeOf = (sync, id, fallback = null) => (id && sync && sync.scopes[id]) || fallback;

// The words of the label, untranslated.
export function scopeText(scope, sender = '') {
  if (scope === 'shared') return 'Shared across devices';
  if (scope === 'telegram') return sender ? `Sent through ${sender}` : 'Telegram: one device sends';
  return 'This device only';
}
export function scopeTitle(scope) {
  if (scope === 'shared') return 'Changes here are copied to every linked device';
  if (scope === 'telegram') return 'One linked device sends the Telegram messages and calls for all of them';
  return 'Only this device uses this';
}

// The entries of the route that belong to one setting: the key itself, or keys under it (`translate.provider`, `oss:agent-access`). Merged into one:
// the latest change, and every device still waiting for it.
const belongs = (key, id) => key === id || key.startsWith(`${id}.`) || key.startsWith(`${id}:`) || key.startsWith(`${id}/`);
export function keyEntry(sync, id) {
  if (!sync || !id) return null;
  const entries = sync.keys.filter(entry => belongs(entry.key, id));
  if (!entries.length) return null;
  const latest = entries.reduce((best, entry) => ((timeOf(entry.updated_at) || 0) > (timeOf(best.updated_at) || 0) ? entry : best), entries[0]);
  const pending = [...new Set(entries.flatMap(entry => entry.pending_peers))];
  return { key: id, updated_at: latest.updated_at, updated_by_name: latest.updated_by_name, pending_peers: pending };
}

const list = items => items.join(', ');

// The details line of a shared setting's label: who still waits for it, or which other device changed it last. Empty when there is nothing to say.
export function detailLine(sync, id, { now = Date.now(), t = plain } = {}) {
  const entry = keyEntry(sync, id);
  if (!entry) return '';
  if (entry.pending_peers.length) return t(`Waiting to reach ${list(entry.pending_peers)}`);
  const by = entry.updated_by_name;
  if (by && sync.peers.some(peer => peer.name === by)) {
    const when = relativeTime(entry.updated_at, { now });
    if (when === 'Just now') return t(`Changed on ${by} just now`);
    return t(when ? `Changed on ${by}, ${relativeTime(entry.updated_at, { now, t })}` : `Changed on ${by}`);
  }
  return '';
}

// After a save of a shared setting: 'copied' once no linked device waits for it, 'waiting' with the names of the devices that still wait, or null while
// it is too early to say. `before` is the entry's updated_at before the save: an answer that still shows that time may not know the save yet, so it
// counts only from the second look on (`attempt` starts at 0).
export function saveOutcome(sync, id, { before = null, attempt = 0, last = false } = {}) {
  const entry = keyEntry(sync, id);
  const fresh = entry && entry.updated_at !== before;
  if (!fresh && attempt < 1 && !last) return null;
  const pending = entry ? entry.pending_peers : [];
  if (!pending.length) return { state: 'copied', peers: [] };
  const offline = pending.filter(name => sync.peers.some(peer => peer.name === name && !peer.online));
  // Devices that are offline will not take it before they are back: say so at once. Online ones get until the last look.
  if (offline.length === pending.length || last) return { state: 'waiting', peers: pending, offline: offline.length === pending.length };
  return null;
}

export function outcomeText(outcome) {
  if (!outcome) return '';
  if (outcome.state === 'copying') return 'Copying to linked devices…';
  if (outcome.state === 'copied') return 'Copied to linked devices';
  return outcome.offline ? `Will be copied when ${list(outcome.peers)} is online` : `Waiting to reach ${list(outcome.peers)}`;
}

// The state of one peer on the "Settings sync" status line, after its name: "Online · Synced 5 min ago", "Offline · Not synced yet", "Online · Error: …".
export function peerStatus(peer, { now = Date.now(), t = plain } = {}) {
  const parts = [t(peer.online ? 'Online' : 'Offline')];
  if (!peer.supported) parts.push(t('Needs an update to share settings'));
  else if (peer.last_sync_at) {
    const when = relativeTime(peer.last_sync_at, { now });
    if (when === 'Just now') parts.push(t('Synced just now'));
    else if (when) parts.push(t(`Synced ${relativeTime(peer.last_sync_at, { now, t })}`));
  }
  else parts.push(t('Not synced yet'));
  if (peer.last_error) parts.push(`${t('Error')}: ${peer.last_error}`);
  return parts.join(' · ');
}
