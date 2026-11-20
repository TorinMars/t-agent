// Continue where you left off (public/js/continue-drafts.js, docs/design/continue-and-drafts.md): when the "Continue <session>" hint shows, the rules
// of drafts that follow their session (a draft from another device, this box's own text, focus, clears, caps, age), the page's controller over a fake
// shared state with a fake clock, and where a recent entry was seen through the merge rules and the page's mapping.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.T_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-continue-drafts-'));
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../public/js/continue-drafts.js');
const merge = require('../services/page-state-merge');
const pageSide = require('../public/js/page-state.js');

const NOW = Date.UTC(2026, 10, 20, 9, 0, 0);
const MIN = 60 * 1000;
const T = '11111111-1111-4111-8111-111111111111';
const ident = { instance: T, task: '1', terminal: 'c1' };
const ID = C.sessionId(ident);
const draft = (extra = {}) => ({ ...ident, text: 'hello', at: NOW - MIN, client: 'computer', device: 'computer0001', ...extra });

test('a draft key names one session: a valid shared key name, the same for the same session, different for another', () => {
  const key = C.draftKey(ID);
  assert.match(key, /^ta-draft:[0-9a-f]{16}$/);
  assert.match(key, /^[a-z][a-z0-9._:-]{0,95}$/, 'fits KEY_NAME of the shared page state');
  assert.equal(C.draftKey(ID), key);
  assert.notEqual(C.draftKey(C.sessionId({ ...ident, terminal: 'c2' })), key);
  assert.equal(C.sessionId({ instance: '', task: '1', terminal: 'x' }), '');
});

test('the client kind: the Mac app, a Home Screen app, a phone, a computer', () => {
  assert.equal(C.clientKind({ app: true, standalone: false, platform: 'other' }), 'mac');
  assert.equal(C.clientKind({ app: false, standalone: true, platform: 'ios' }), 'home');
  assert.equal(C.clientKind({ app: false, standalone: false, platform: 'ios' }), 'phone');
  assert.equal(C.clientKind({ app: false, standalone: false, platform: 'android' }), 'phone');
  assert.equal(C.clientKind({ app: false, standalone: false, platform: 'other' }), 'computer');
  assert.equal(C.clientKind(null), 'computer');
  assert.equal(C.clientLabel('home'), 'Home Screen app');
});

test('a stored draft is read only for its session, when it has text, is at most 4,000 characters and at most 7 days old', () => {
  assert.deepEqual(C.cleanDraft(draft(), ID, NOW), { text: 'hello', at: NOW - MIN, client: 'computer', device: 'computer0001' });
  assert.equal(C.cleanDraft(draft({ terminal: 'c2' }), ID, NOW), null, 'another session');
  assert.equal(C.cleanDraft(draft({ text: '   ' }), ID, NOW), null, 'only spaces');
  assert.equal(C.cleanDraft(draft({ text: 'x'.repeat(4001) }), ID, NOW), null, 'too long');
  assert.ok(C.cleanDraft(draft({ text: String.fromCharCode(0x4e2d).repeat(4000) }), ID, NOW), '4,000 characters of Chinese fit');
  assert.equal(C.cleanDraft(draft({ at: NOW - 7 * 24 * 60 * MIN - 1 }), ID, NOW), null, 'older than 7 days');
  assert.ok(C.cleanDraft(draft({ at: NOW - 7 * 24 * 60 * MIN }), ID, NOW), 'exactly 7 days');
  assert.equal(C.cleanDraft(null, ID, NOW), null);
  assert.equal(C.cleanDraft(draft({ client: 'toaster' }), ID, NOW).client, null, 'an unknown client is not named');
});

test('a draft from another device: into an empty box or one in step, offered over own text, never while the box has the focus', () => {
  const remote = C.cleanDraft(draft(), ID, NOW);
  const base = { remote, known: '', base: '', focused: false, device: 'phone0000001' };
  assert.equal(C.arrival({ ...base, box: '' }).act, 'fill', 'empty box: put in');
  assert.equal(C.arrival({ ...base, box: 'old', base: 'old', taken: 'old' }).act, 'fill', 'the box holds a draft taken from another device: follows');
  assert.equal(C.arrival({ ...base, box: 'old', base: 'old' }).act, 'offer', 'this device\'s own text, even when it was shared: offered');
  assert.equal(C.arrival({ ...base, box: 'my own words', base: '' }).act, 'offer', 'own unsent text: offered instead');
  assert.equal(C.arrival({ ...base, box: '', focused: true }).act, 'wait', 'focused: nothing changes now');
  assert.equal(C.arrival({ ...base, box: 'hello' }).act, 'same');
  assert.equal(C.arrival({ ...base, box: '', device: 'computer0001' }).act, 'none', 'this browser\'s own write coming back');
  assert.equal(C.arrival({ ...base, box: '', known: C.signature(remote) }).act, 'none', 'already handled');
});

test('a draft sent or emptied elsewhere clears a box that is in step and not focused, and never this box\'s own text', () => {
  const base = { remote: null, known: 'computer0001|1|5', focused: false, device: 'phone0000001' };
  assert.equal(C.arrival({ ...base, box: 'hello', base: 'hello' }).act, 'clear');
  assert.equal(C.arrival({ ...base, box: 'hello', base: 'hello', focused: true }).act, 'wait');
  assert.equal(C.arrival({ ...base, box: 'hello and more', base: 'hello' }).act, 'none', 'edited here: kept');
  assert.equal(C.arrival({ ...base, box: '', base: '' }).act, 'none');
});

test('the hint: another device, the last 12 hours, not gone, not what this device shows, not this device', () => {
  const top = { sourceKey: 'local', taskId: '1', terminalId: 'c1', title: 'SELF AGENT DEV', lastUsed: NOW - 2 * MIN, client: 'computer', device: 'computer0001' };
  const shown = { sourceKey: 'local', taskId: '2', terminalId: 'd1' };
  const base = { top, listed: true, shown, device: 'phone0000001', now: NOW };
  assert.deepEqual(C.hintFor(base), { client: 'computer', at: NOW - 2 * MIN });
  assert.equal(C.hintFor({ ...base, shown: { sourceKey: 'local', taskId: 1, terminalId: 'c1' } }), null, 'the session this device opens anyway');
  assert.equal(C.hintFor({ ...base, listed: false }), null, 'gone');
  assert.equal(C.hintFor({ ...base, device: 'computer0001' }), null, 'last viewed on this same device');
  assert.equal(C.hintFor({ ...base, top: { ...top, lastUsed: NOW - 12 * 60 * MIN - 1 } }), null, 'older than 12 hours');
  assert.ok(C.hintFor({ ...base, top: { ...top, lastUsed: NOW - 12 * 60 * MIN } }), 'exactly 12 hours');
  assert.equal(C.hintFor({ ...base, top: { ...top, client: undefined } }), null, 'noted by an older page: no device to name');
  assert.equal(C.hintFor({ ...base, top: null }), null);
  assert.ok(C.hintFor({ ...base, shown: null }), 'nothing shown here (a first visit)');
  assert.equal(C.lastViewedText('computer', NOW - 2 * MIN, NOW), 'Last viewed on your computer · 2 min ago');
  assert.equal(C.lastViewedText('home', NOW - 3 * 60 * MIN, NOW), 'Last viewed on your Home Screen app · 3 h ago');
  assert.equal(C.draftFromText('mac', NOW - 10 * 1000, NOW), 'Draft from your Mac app · just now');
  assert.equal(C.draftFromText('phone', NOW - 2 * 24 * 60 * MIN, NOW), 'Draft from your phone · 2 days ago');
  assert.equal(C.useDraftText('phone'), 'Use the draft from your phone');
});

test('stale drafts: older than 7 days and the oldest beyond 20 are cleared, never the bound one', () => {
  const entries = [['h5-columns', '{}'], ['ta-draft:old', draft({ at: NOW - 8 * 24 * 60 * MIN })], ['ta-draft:gone', null]];
  for (let i = 0; i < 22; i += 1) entries.push([`ta-draft:n${i}`, draft({ terminal: `t${i}`, at: NOW - i * MIN })]);
  const stale = C.staleDrafts(entries, NOW, 'ta-draft:n21');
  assert.deepEqual(stale.sort(), ['ta-draft:n20', 'ta-draft:old'].sort());
});

// A fake shared state (the TAPageState door the controller uses) and a fake box, with a fake clock.
function harness({ device = 'phone0000001', kind = 'phone' } = {}) {
  const keys = {};
  const sets = [];
  let sends = 0;
  const store = {
    get: name => keys[name],
    set: (name, value) => { keys[name] = value === undefined ? null : value; sets.push([name, value]); },
    send: () => { sends += 1; },
    keys: () => Object.keys(keys),
  };
  const input = { value: '' };
  const notes = [];
  const clock = { now: NOW };
  const drafts = C.createDrafts({ input, store, setText: text => { input.value = text; }, onNote: note => notes.push(note), device, kind, now: () => clock.now });
  return { keys, sets, store, input, notes, clock, drafts, sends: () => sends };
}
const key = C.draftKey(ID);

test('the controller writes what is typed at once, then at most every 2 s, and at once on blur', async () => {
  const h = harness();
  h.drafts.bind({ ident, pageKey: 'local|1|c1' });
  h.input.value = 'h';
  h.drafts.input();
  assert.equal(h.keys[key].text, 'h', 'the first change at once');
  assert.equal(h.keys[key].client, 'phone');
  assert.equal(h.keys[key].device, 'phone0000001');
  h.clock.now += 500;
  h.input.value = 'he';
  h.drafts.input();
  assert.equal(h.keys[key].text, 'h', 'within 2 s: waits');
  h.input.value = 'hel';
  h.drafts.input();
  h.drafts.blur();
  assert.equal(h.keys[key].text, 'hel', 'blur writes at once');
  assert.ok(h.sends() >= 1, 'and sends at once');
  h.clock.now += 2500;
  h.input.value = '';
  h.drafts.input();
  assert.equal(h.keys[key], null, 'emptied: cleared everywhere');
});

test('the controller keeps a draft over 4,000 characters in this box only', () => {
  const h = harness();
  h.drafts.bind({ ident, pageKey: 'local|1|c1' });
  h.input.value = 'short';
  h.drafts.input();
  h.clock.now += 3000;
  h.input.value = 'x'.repeat(4001);
  h.drafts.input();
  assert.equal(h.keys[key].text, 'short', 'the long text is not shared');
  h.drafts.bind({ ident: { ...ident, terminal: 'c2' }, pageKey: 'local|1|c2' });
  assert.equal(h.input.value, '');
  h.drafts.bind({ ident, pageKey: 'local|1|c1' });
  assert.equal(h.input.value.length, 4001, 'back to the session: this box\'s long text is still here');
});

test('the controller swaps the box with the session and shows where a taken draft came from', () => {
  const h = harness();
  h.keys[C.draftKey(C.sessionId({ ...ident, terminal: 'c2' }))] = draft({ terminal: 'c2', text: 'from the computer' });
  h.drafts.bind({ ident, pageKey: 'local|1|c1' });
  h.input.value = 'mine';
  h.drafts.input();
  h.drafts.bind({ ident: { ...ident, terminal: 'c2' }, pageKey: 'local|1|c2' });
  assert.equal(h.input.value, 'from the computer');
  assert.deepEqual(h.notes.at(-1), { kind: 'took', client: 'computer', at: NOW - MIN });
  assert.equal(h.keys[key].text, 'mine', 'the session left keeps its text');
  h.input.value = 'from the computer!';
  h.drafts.input();
  assert.equal(h.notes.at(-1), null, 'the caption goes when the person edits');
  h.drafts.bind({ ident, pageKey: 'local|1|c1' });
  assert.equal(h.input.value, 'mine');
});

test('the controller follows a newer draft into an idle box, offers it over own text, and waits while focused', () => {
  global.document = { activeElement: null };
  try {
    const h = harness();
    h.drafts.bind({ ident, pageKey: 'local|1|c1' });
    h.keys[key] = draft({ text: 'first' });
    h.drafts.changed();
    assert.equal(h.input.value, 'first', 'empty and not focused: put in');
    assert.equal(h.notes.at(-1).kind, 'took');
    h.keys[key] = draft({ text: 'first and second', at: NOW });
    h.drafts.changed();
    assert.equal(h.input.value, 'first and second', 'in step: follows');
    // Own text: offered, never overwritten.
    h.clock.now += 3000;
    h.input.value = 'my own';
    h.drafts.input();
    h.keys[key] = draft({ text: 'newer elsewhere', at: NOW + 4000 });
    h.drafts.changed();
    assert.equal(h.input.value, 'my own');
    assert.deepEqual(h.notes.at(-1), { kind: 'offer', client: 'computer', at: NOW + 4000, text: 'newer elsewhere' });
    h.drafts.useOffer();
    assert.equal(h.input.value, 'newer elsewhere', 'Use the draft');
    assert.equal(h.notes.at(-1).kind, 'took');
    // Focused: nothing changes until the box loses the focus.
    document.activeElement = h.input;
    h.keys[key] = draft({ text: 'while typing', at: NOW + 9000 });
    h.drafts.changed();
    assert.equal(h.input.value, 'newer elsewhere', 'focused: unchanged');
    document.activeElement = null;
    h.drafts.blur();
    assert.equal(h.input.value, 'while typing', 'after blur it follows');
    // Sent elsewhere: the box in step is emptied.
    h.keys[key] = null;
    h.drafts.changed();
    assert.equal(h.input.value, '');
    assert.equal(h.notes.at(-1), null);
  } finally { delete global.document; }
});

test('a send clears the draft everywhere; a send that ends after a switch clears the session it started in', () => {
  const h = harness();
  h.drafts.bind({ ident, pageKey: 'local|1|c1' });
  h.input.value = 'to send';
  h.drafts.input();
  h.input.value = '';
  h.drafts.sent(ID);
  assert.equal(h.keys[key], null);
  h.clock.now += 3000;
  h.input.value = 'again';
  h.drafts.input();
  const started = h.drafts.id;
  h.drafts.bind({ ident: { ...ident, terminal: 'c2' }, pageKey: 'local|1|c2' });
  h.drafts.sent(started);
  assert.equal(h.keys[key], null, 'the session the send started in');
});

test('a session of an engine without an instance id keeps its draft in this page only', () => {
  const h = harness();
  h.drafts.bind({ ident: { instance: '~remote:4', task: '2', terminal: 'x' }, pageKey: 'remote:4|2|x' });
  h.input.value = 'local only';
  h.drafts.input();
  assert.equal(h.sets.length, 0, 'nothing shared');
  h.drafts.bind({ ident, pageKey: 'local|1|c1' });
  assert.equal(h.input.value, '');
  h.drafts.bind({ ident: { instance: '~remote:4', task: '2', terminal: 'x' }, pageKey: 'remote:4|2|x' });
  assert.equal(h.input.value, 'local only');
});

test('where a recent entry was seen travels through the merge rules and the page mapping, and is left out when unknown', () => {
  const by = T;
  const state = merge.changeState({ recent: [{ instance: T, task: '1', terminal: 'c1', title: 'A', used: NOW, client: 'phone', device: 'phone0000001' }, { instance: T, task: '2', terminal: 'd1', title: 'B', used: NOW - 1, client: 'fridge', device: 'BAD' }] }, { at: NOW, by });
  const view = merge.pageView(merge.merge({}, state, NOW).state);
  assert.equal(view.recent[0].client, 'phone');
  assert.equal(view.recent[0].device, 'phone0000001');
  assert.equal('client' in view.recent[1], false, 'an unknown client is left out');
  assert.equal('device' in view.recent[1], false);
  const onT = [{ key: 'local', instanceId: T }];
  const page = pageSide.toPage(view.recent[0], onT);
  assert.equal(page.client, 'phone');
  assert.equal(pageSide.toShared(page, onT).device, 'phone0000001');
  assert.equal('client' in pageSide.toPage(view.recent[1], onT), false);
});

test('a session shown here while another device noted it last is noted again for this device, and only then', async () => {
  const { noteRecent } = await import('../scripts/h5-shell/recent-sessions.mjs');
  const list = [{ sourceKey: 'local', taskId: '1', terminalId: 'c1', title: 'A', agent: null, lastUsed: NOW - MIN, client: 'computer', device: 'computer0001' }];
  const same = noteRecent(list, { ...list[0], client: 'computer', device: 'computer0001' }, undefined, { now: NOW });
  assert.equal(same, list, 'the same device: nothing changes');
  const moved = noteRecent(list, { ...list[0], client: 'phone', device: 'phone0000001' }, undefined, { now: NOW });
  assert.equal(moved[0].device, 'phone0000001');
  assert.equal(moved[0].lastUsed, NOW, 'stamped now');
});
