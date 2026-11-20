// The merge rules of the mind map copies kept on every normal linked engine ("Mind maps on every engine" in docs/design/mind-maps.md). Pure: no files,
// no clock, no network. services/mindmap.js stores what these functions decide; services/mindmap-sync.js carries the entries between engines.
//
// An entry is a map { kind: 'map', id, title, data, revision, created_at, updated_at, sync } or a tombstone { kind: 'tomb', id, deleted_at, revision,
// sync }. `sync` is { vv, at, by, by_name, conflict_of? }:
// - vv: a version vector, { <engine instance id>: n }. Each save on an engine adds one to that engine's number, so one version descends from
//   another exactly when each number is at least as large. Unlike a list of ancestors it never forgets: a long offline session is still known to
//   descend from where it started.
// - at, by: the time of the last change on the hybrid clock of the engine that made it (milliseconds that never go back, see services/mindmap.js)
//   and that engine's instance id. "The newer version" is the later `at`, a tie going to the greater `by`.
// - by_name: the name of that engine when it made the change (what "edited on" and "(conflict from <engine>)" show).
//
// decide(local, incoming) -> { store: entry | null, copy: entry | null }: what to store under the id (null: nothing changes) and a conflict copy to
// store under its own id (then decided again against what is stored there).
const crypto = require('node:crypto');

const INSTANCE_ID = /^[A-Za-z0-9-]{1,64}$/;
const MAX_ENGINES = 256;
const TITLE_CHARS = 200;

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// A version vector from untrusted input, or null.
function cleanVector(value) {
  if (!isObject(value)) return null;
  const entries = Object.entries(value);
  if (!entries.length || entries.length > MAX_ENGINES) return null;
  const out = {};
  for (const [id, n] of entries) {
    if (!INSTANCE_ID.test(id) || !Number.isSafeInteger(n) || n < 1) return null;
    out[id] = n;
  }
  return out;
}

// 'equal', 'after' (a descends from b), 'before' (b descends from a) or 'concurrent' (each has a change the other has not seen).
function compare(a, b) {
  let ahead = false;
  let behind = false;
  for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[id] || 0;
    const y = b[id] || 0;
    if (x > y) ahead = true;
    else if (x < y) behind = true;
  }
  if (ahead && behind) return 'concurrent';
  if (ahead) return 'after';
  if (behind) return 'before';
  return 'equal';
}

// Each engine's larger number: the version that has seen both.
function joined(a, b) {
  const out = { ...a };
  for (const [id, n] of Object.entries(b)) out[id] = Math.max(out[id] || 0, n);
  return out;
}

// Change x is newer than change y: the later time, a tie to the greater instance id.
const newer = (x, y) => x.sync.at > y.sync.at || (x.sync.at === y.sync.at && String(x.sync.by) > String(y.sync.by));
const sameVector = (a, b) => compare(a, b) === 'equal';
const sameContent = (a, b) => a.title === b.title && JSON.stringify(a.data) === JSON.stringify(b.data);
const withVector = (entry, vv) => ({ ...entry, sync: { ...entry.sync, vv } });

// The id of the conflict copy of a version: the same on every engine that sees the conflict, so two engines that resolve it each make the same copy
// (stored once) instead of two. A version 4 UUID in form, from a hash of the map's id and the version vector of the version that lost.
function conflictId(id, vv) {
  const key = Object.keys(vv).sort().map(engine => `${engine}=${vv[engine]}`).join(',');
  const hex = crypto.createHash('sha256').update(`t-agent mindmap conflict v1|${id}|${key}`).digest('hex');
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const clip = text => [...text].slice(0, TITLE_CHARS).join('');
// "<name> (conflict from <engine>)", cut so the suffix always shows (the title limit is 200 characters).
function conflictTitle(title, engineName) {
  const suffix = ` (conflict from ${String(engineName || '').trim() || 'another engine'})`;
  const room = Math.max(1, TITLE_CHARS - [...suffix].length);
  return clip(`${clip(String(title || 'Untitled map')).slice(0, room)}${suffix}`);
}

// The version that lost a conflict, as a map of its own next to the winner.
function conflictCopy(loser) {
  return {
    kind: 'map',
    id: conflictId(loser.id, loser.sync.vv),
    title: conflictTitle(loser.title, loser.sync.by_name),
    data: loser.data,
    revision: 1,
    created_at: loser.updated_at,
    updated_at: loser.updated_at,
    sync: { vv: { ...loser.sync.vv }, at: loser.sync.at, by: loser.sync.by, by_name: loser.sync.by_name, conflict_of: loser.id },
  };
}

const NOTHING = Object.freeze({ store: null, copy: null });

function decide(local, incoming) {
  if (!incoming) return NOTHING;
  if (!local) return { store: incoming, copy: null };
  const order = compare(incoming.sync.vv, local.sync.vv);
  if (local.kind === 'map' && incoming.kind === 'map') {
    if (order === 'equal' || order === 'before') return NOTHING;
    if (order === 'after') return { store: incoming, copy: null };
    // Concurrent: two engines changed the map from the same base while apart. The newer one is the map; the other is kept next to it, unless both
    // ended at the same content. Either way the result has seen both, so it descends from each and the conflict is not found again.
    const vv = joined(local.sync.vv, incoming.sync.vv);
    const winner = newer(incoming, local) ? incoming : local;
    const loser = winner === incoming ? local : incoming;
    return { store: withVector(winner, vv), copy: sameContent(local, incoming) ? null : conflictCopy(loser) };
  }
  if (local.kind === 'map' && incoming.kind === 'tomb') {
    // A delete removes the map only when it had seen this version; an edit the deleting engine never saw keeps the map (it goes back to that engine
    // and brings the map back there too).
    return order === 'equal' || order === 'after' ? { store: incoming, copy: null } : NOTHING;
  }
  if (local.kind === 'tomb' && incoming.kind === 'map') {
    if (order === 'equal' || order === 'before') return NOTHING; // the deleted version or an older one: it stays deleted
    return { store: order === 'after' ? incoming : withVector(incoming, joined(local.sync.vv, incoming.sync.vv)), copy: null };
  }
  // Two deletes.
  if (order === 'after') return { store: incoming, copy: null };
  if (order === 'concurrent') return { store: withVector(newer(incoming, local) ? incoming : local, joined(local.sync.vv, incoming.sync.vv)), copy: null };
  return NOTHING;
}

// The revision of a stored result on this engine (the page saves with it). It goes up whenever the title or the content change here and never goes
// back; a version that descends from what is here takes the sender's revision when that is larger, so engines that saw the same saves mostly agree
// (a company computer's offline saves keep their numbers on its home).
function revisionOf(local, result) {
  const before = local ? local.revision || 0 : 0;
  if (local && local.kind === 'map' && result.kind === 'map' && sameContent(local, result)) return before || result.revision || 1;
  return Math.max(before + 1, result.revision || 1);
}

module.exports = { decide, compare, joined, cleanVector, conflictId, conflictTitle, conflictCopy, revisionOf, sameContent, sameVector, newer, INSTANCE_ID };
