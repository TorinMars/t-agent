// The bubbles of the T-Attention desktop window: the in-memory queue (services/widget-notices.js: seq, the cap of 20, the 10 minute expiry, the
// 60 s window of a reader without `after`, the notice contract) and the widget notifier (plugins/notifiers/widget: readiness from the window state,
// the target of a click, the text it picks, direct messages, the Settings test, loading through services/attention-notify.js).
// No window, no network: the window state is a function of the test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const notify = require('../services/attention-notify');
const notices = require('../services/widget-notices');
const widget = require('../plugins/notifiers/widget');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', 'notifiers', 'widget', 'manifest.json'), 'utf8'));
const SECRET = 'widget-notices-test-secret-0123456789';
const ON = { supported: true, blocked: false, enabled: true, running: true, url: 'http://127.0.0.1:3000' };
const makeDb = () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
  return db;
};
const clock = (start = Date.parse('2026-11-17T10:00:00Z')) => { const value = { now: start }; value.fn = () => value.now; return value; };
const KEYS = ['seq', 'at', 'kind', 'title', 'text', 'from', 'status', 'key', 'target', 'seconds'];

test('the queue: seq goes up by one, every notice has exactly the contract fields, oldest first after `after`', () => {
  const time = clock();
  const queue = notices.createWidgetNotices({ now: time.fn });
  assert.deepEqual(queue.list(), { seq: 0, notices: [] });
  const first = queue.push({ kind: 'direct', title: 'Build', text: 'Done', from: 'Fix CI', target: 'https://t.example.com/x', seconds: 5 });
  assert.deepEqual(first, { seq: 1, at: '2026-11-17T10:00:00.000Z', kind: 'direct', title: 'Build', text: 'Done', from: 'Fix CI', status: null, key: null, target: 'https://t.example.com/x', seconds: 5 });
  time.now += 1000;
  const second = queue.push({ kind: 'item', title: 'Fix login', text: 'Approve', status: 'waiting_user', key: 'local:12', target: null, seconds: 0 });
  assert.equal(second.seq, 2);
  assert.equal(second.seconds, 0, '0 = until it is closed');
  assert.deepEqual(Object.keys(second), KEYS);
  assert.deepEqual(queue.list({ after: 0 }).notices.map(notice => notice.seq), [1, 2]);
  assert.deepEqual(queue.list({ after: 1 }), { seq: 2, notices: [second] });
  assert.deepEqual(queue.list({ after: 2 }), { seq: 2, notices: [] });
  // A reader that saw a seq above the latest (this server restarted since): the recent ones, like a reader without `after`.
  assert.deepEqual(queue.list({ after: 99 }).notices.map(notice => notice.seq), [1, 2]);
  // What the reader gets is a copy.
  queue.list({ after: 0 }).notices[0].title = 'changed';
  assert.equal(queue.list({ after: 0 }).notices[0].title, 'Build');
  // status and key only for items; an unknown kind or an empty notice is refused.
  assert.deepEqual([queue.push({ kind: 'test', title: 'T', status: 'done', key: 'local:1' }).status, queue.list({ after: 2 }).notices[0].key], [null, null]);
  assert.throws(() => queue.push({ kind: 'other', title: 'x' }), /kind/);
  assert.throws(() => queue.push({ kind: 'direct', title: ' ', text: '\n' }), /title or a text/);
  assert.equal(queue.latestSeq(), 3);
});

test('the queue keeps 20 notices and none older than 10 minutes; without `after` only the last 60 s', () => {
  const time = clock();
  const queue = notices.createWidgetNotices({ now: time.fn });
  for (let index = 1; index <= 25; index += 1) queue.push({ kind: 'direct', text: `n${index}` });
  const all = queue.list({ after: 0 });
  assert.equal(all.seq, 25);
  assert.deepEqual(all.notices.map(notice => notice.seq), Array.from({ length: 20 }, (_, index) => index + 6), 'the 20 newest');
  assert.equal(notices.NOTICES_MAX, 20);
  time.now += 30 * 1000;
  queue.push({ kind: 'direct', text: 'later' });
  time.now += 45 * 1000; // the first 25 are 75 s old, the last one 45 s
  assert.deepEqual(queue.list().notices.map(notice => notice.text), ['later'], 'a window that has just started: the last 60 s');
  assert.equal(queue.list({ after: 0 }).notices.length, 20, 'with after: everything kept');
  time.now += 9 * 60 * 1000; // the first 25 are now 10 min 15 s old, the last one 9 min 45 s
  assert.deepEqual(queue.list({ after: 0 }).notices.map(notice => notice.text), ['later']);
  time.now += 60 * 1000;
  assert.deepEqual(queue.list({ after: 0 }), { seq: 26, notices: [] }, 'expired; the seq stays');
  assert.equal(queue.size(), 0);
});

test('a notice is cleaned: one-line title of 200, text of 500 with line breaks, from of 80, only http(s) targets without credentials', () => {
  const queue = notices.createWidgetNotices();
  const long = queue.push({ kind: 'direct', title: `a\nb\u202e${'x'.repeat(300)}`, text: `  line 1\r\n\n\n\nline 2\u0007 ${'y'.repeat(600)}  `, from: 'z'.repeat(100) });
  assert.equal(long.title.length, 200);
  assert.ok(long.title.startsWith('a b x'));
  assert.ok(long.title.endsWith('\u2026'));
  assert.equal(long.text.length, 500);
  assert.ok(long.text.startsWith('line 1\n\nline 2 y'));
  assert.equal(long.from.length, 80);
  const noTitle = queue.push({ kind: 'direct', text: 'First line\nsecond' });
  assert.equal(noTitle.title, 'First line', 'a missing title is the first line of the text');
  for (const bad of ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'https://user:pw@example.com/', '/relative', '//host/x', 'ftp://x.example/', 'not a url', 42, null]) {
    assert.equal(queue.push({ kind: 'direct', text: 'x', target: bad }).target, null, String(bad));
  }
  assert.equal(queue.push({ kind: 'direct', text: 'x', target: ' https://example.com/a?b=1#c ' }).target, 'https://example.com/a?b=1#c');
  assert.equal(queue.push({ kind: 'direct', text: 'x', seconds: 'soon' }).seconds, 8, 'an invalid time is the default');
  assert.equal(notices.resolvePath('/h5?task=3', 'http://127.0.0.1:3000'), 'http://127.0.0.1:3000/h5?task=3');
  assert.equal(notices.resolvePath('//evil.example/x', 'http://127.0.0.1:3000'), null);
  assert.equal(notices.resolvePath('/x\\y', 'http://127.0.0.1:3000'), null);
  assert.equal(notices.resolvePath('/x', 'javascript:alert(1)'), null);
});

test('the notifier is ready only on macOS, in a server that starts the window, with the window on and running', () => {
  const cases = [
    [{ ...ON, supported: false }, widget.NOT_READY.platform],
    [{ ...ON, blocked: true }, widget.NOT_READY.blocked],
    [{ ...ON, enabled: false }, widget.NOT_READY.off],
    [{ ...ON, running: false }, widget.NOT_READY.stopped],
    [ON, ''],
  ];
  for (const [state, why] of cases) {
    const plugin = widget.createWidgetNotifier({ notices: notices.createWidgetNotices(), widgetState: () => state });
    assert.equal(plugin.whyNotReady(), why, JSON.stringify(state));
    assert.equal(plugin.ready({}), !why);
    assert.deepEqual(plugin.status({}), { configured: !why, summary: why || 'Shows bubbles beside the desktop window' });
  }
  // A state function that throws, and no state at all (the default before server.js sets one): not ready.
  assert.equal(widget.createWidgetNotifier({ widgetState: () => { throw new Error('x'); } }).ready(), false);
  assert.equal(widget.createWidgetNotifier({ notices: notices.createWidgetNotices() }).whyNotReady(), widget.NOT_READY.platform);
  assert.equal(widget.name, 'widget');
  assert.equal(widget.direct, true);
});

test('an item notice: the title, the most useful line, the status and key, and the target of a click', async () => {
  const queue = notices.createWidgetNotices();
  let state = { ...ON };
  const plugin = widget.createWidgetNotifier({ notices: queue, widgetState: () => state });
  const send = async (item, extra = {}) => { await plugin.notify({ reason: 'status', mode: 'message', item, link: '', values: { seconds: '15' }, ...extra }); return queue.list({ after: queue.latestSeq() - 1 }).notices[0]; };
  const base = { id: 12, title: 'Fix the login', status: 'waiting_user' };
  const pending = await send({ ...base, attention_reason: 'Approve it', result: 'r', context: { pending: { text: 'Claude wants to run a command' } } });
  assert.deepEqual(pending, { ...pending, kind: 'item', title: 'Fix the login', text: 'Claude wants to run a command', from: null, status: 'waiting_user', key: 'local:12', target: 'http://127.0.0.1:3000/', seconds: 15 });
  assert.equal((await send({ ...base, attention_reason: 'Approve it', result: 'r', context: '{"pending":{"text":"From JSON"}}' })).text, 'From JSON');
  assert.equal((await send({ ...base, attention_reason: 'Approve it', result: 'r' })).text, 'Approve it');
  assert.equal((await send({ ...base, status: 'done', result: 'All tests pass' })).text, 'All tests pass');
  assert.equal((await send({ ...base, status: 'review' })).text, 'Review', 'else the status label');
  assert.equal((await send({ ...base, status: 'custom' })).text, 'custom');
  // Targets: an absolute link_url as it is; a page path against the window's server; else the notification link; else the T-Agent page.
  assert.equal((await send({ ...base, link_url: 'https://ci.example.com/run/7' })).target, 'https://ci.example.com/run/7');
  assert.equal((await send({ ...base, link_url: '/h5?task=3' }, { link: 'https://public.example.com/h5?task=3' })).target, 'http://127.0.0.1:3000/h5?task=3');
  assert.equal((await send(base, { link: 'https://public.example.com/' })).target, 'https://public.example.com/');
  assert.equal((await send({ ...base, link_url: 'javascript:alert(1)' }, { link: 'javascript:alert(2)' })).target, 'http://127.0.0.1:3000/', 'javascript: is never a target');
  assert.equal((await send({ ...base, link_url: 'https://u:p@example.com/' })).target, 'http://127.0.0.1:3000/');
  // Without the window's address (before the server listens): the page path against the origin of the notification link, or nothing.
  state = { ...ON, url: null };
  assert.equal((await send({ ...base, link_url: '/h5?task=3' }, { link: 'https://public.example.com/h5?task=3' })).target, 'https://public.example.com/h5?task=3');
  assert.equal((await send({ ...base, link_url: '/h5?task=3' })).target, null);
  assert.equal((await send(base)).target, null);
  // A relayed origin names the device; a call falls back to a message (the manifest never allows one).
  state = { ...ON };
  assert.equal((await send(base, { origin: { name: 'K01' } })).from, 'K01');
  assert.deepEqual(await plugin.notify({ reason: 'status', mode: 'call', item: base, link: '' }), { fallback: 'message', error: 'The desktop window cannot make calls' });
  assert.equal(queue.list({ after: queue.latestSeq() - 1 }).notices[0].seconds, 8, 'the default time');
  // Not ready: refused, nothing queued.
  state = { ...ON, enabled: false };
  const before = queue.latestSeq();
  await assert.rejects(plugin.notify({ reason: 'status', mode: 'message', item: base }), error => error.message === widget.NOT_READY.off && error.statusCode === 409);
  assert.equal(queue.latestSeq(), before);
});

test('a direct message and the Settings test', async () => {
  const queue = notices.createWidgetNotices();
  let state = { ...ON };
  const plugin = widget.createWidgetNotifier({ notices: queue, widgetState: () => state });
  await plugin.notify({ reason: 'direct', mode: 'message', item: null, message: { title: '', text: 'Build finished\nAll green', from: 'Fix CI \u00b7 Claude 1' }, link: 'https://ci.example.com/7', values: { seconds: '0' } });
  const direct = queue.list({ after: 0 }).notices[0];
  assert.deepEqual(direct, { ...direct, kind: 'direct', title: widget.DIRECT_TITLE, text: 'Build finished\nAll green', from: 'Fix CI \u00b7 Claude 1', status: null, key: null, target: 'https://ci.example.com/7', seconds: 0 });
  await plugin.notify({ reason: 'direct', mode: 'message', item: null, message: { title: 'Build', text: 'x', from: '' }, link: '' });
  assert.deepEqual([queue.list({ after: 1 }).notices[0].title, queue.list({ after: 1 }).notices[0].from, queue.list({ after: 1 }).notices[0].target], ['Build', null, 'http://127.0.0.1:3000/']);
  await assert.rejects(plugin.notify({ reason: 'direct', mode: 'message', message: { text: '  ' } }), /no text/);
  const tested = await plugin.test({}, { link: '', values: { seconds: '30' } });
  assert.deepEqual(tested, { ok: true, outcome: 'sent', message: 'Test bubble sent to the desktop window' });
  const sample = queue.list({ after: 2 }).notices[0];
  assert.deepEqual([sample.kind, sample.title, sample.target, sample.seconds], ['test', 'Test message', 'http://127.0.0.1:3000/', 30]);
  state = { ...ON, supported: false };
  assert.deepEqual(await plugin.test({}, {}), { ok: false, message: widget.NOT_READY.platform });
  assert.equal(queue.latestSeq(), 3);
});

test('through the notify service: loaded from the folder, message-only, quietly skipped when not ready, the Settings test says why', async t => {
  const scanned = notify.scanNotifiers(undefined, () => {});
  const entry = scanned.loaded.find(loaded => loaded.plugin.name === 'widget');
  assert.ok(entry, `widget is loaded: ${JSON.stringify(scanned.skipped)}`);
  assert.deepEqual(entry.manifest.modes, ['message', 'off']);
  assert.equal(entry.manifest.test, true);
  assert.deepEqual(entry.manifest.config.map(field => [field.key, field.type, field.default, field.options.map(option => option.value)]), [['seconds', 'select', '8', ['5', '8', '15', '30', '0']]]);

  const queue = notices.createWidgetNotices();
  let state = { ...ON, running: false };
  const plugin = widget.createWidgetNotifier({ notices: queue, widgetState: () => state });
  const service = notify.createAttentionNotify({ db: makeDb(), sessionSecret: SECRET, onChange: null, getOwner: () => 'owner', notifiers: [plugin], manifests: { widget: MANIFEST }, log: () => {} });
  t.after(() => service.stop());
  service.saveRules('owner', { messageDelayMinutes: 0 });
  const item = { id: 4, title: 'Deploy', status: 'review', result: 'Ready to check' };
  // Not ready: no line on a status change, refused for tcli notify, and the test explains it.
  await Promise.all(service.handle({ kind: 'updated', item, previous: { ...item, status: 'working' } }));
  assert.equal(service.recent().length, 0);
  await assert.rejects(service.sendDirect({ owner: 'owner', text: 'hello', via: 'widget' }), error => error.code === 'NOTIFY_NOT_CONFIGURED');
  assert.deepEqual(await service.testPlugin('widget', 'owner'), { ok: false, message: widget.NOT_READY.stopped });
  const overview = service.overview('owner').find(row => row.name === 'widget');
  assert.deepEqual([overview.configured, overview.summary, overview.settings, overview.test], [false, widget.NOT_READY.stopped, true, true]);
  assert.throws(() => service.saveRules('owner', { modes: { widget: { review: 'call' } } }), /widget cannot make calls/);
  // Ready: the seconds setting, a status change, tcli notify and the test all reach the queue.
  state = { ...ON };
  assert.equal(service.savePluginConfig('widget', 'owner', { values: { seconds: '30' } }).values.seconds, '30');
  assert.throws(() => service.savePluginConfig('widget', 'owner', { values: { seconds: '7' } }), /Show for/);
  await Promise.all(service.handle({ kind: 'updated', item: { ...item, id: 5 }, previous: { ...item, id: 5, status: 'working' } }));
  assert.equal(service.recent()[0].outcome, 'sent');
  const answer = await service.sendDirect({ owner: 'owner', title: 'Build', text: 'Done', from: 'CI', link: 'https://ci.example.com/', via: ['widget'] });
  assert.deepEqual(answer.results, [{ notifier: 'widget', outcome: 'sent' }]);
  assert.deepEqual(await service.testPlugin('widget', 'owner'), { ok: true, message: 'Test bubble sent to the desktop window' });
  assert.deepEqual(queue.list({ after: 0 }).notices.map(notice => [notice.kind, notice.title, notice.text, notice.key, notice.target, notice.seconds]), [
    ['item', 'Deploy', 'Ready to check', 'local:5', 'http://127.0.0.1:3000/', 30],
    ['direct', 'Build', 'Done', null, 'https://ci.example.com/', 30],
    ['test', 'Test message', 'This is a test from Settings. Messages about tasks that need you show up here; click a bubble to open it.', null, 'http://127.0.0.1:3000/', 30],
  ]);
  // Turned off in Settings: skipped like any notifier that is switched off.
  service.savePluginConfig('widget', 'owner', { enabled: false });
  assert.deepEqual((await service.directStatus('owner')).notifiers, [{ name: 'widget', label: 'Desktop window (macOS)', enabled: false, ready: false }]);
});

test('the launcher state the notifier reads: synchronous, the switch, the platform and the server address', () => {
  const { createWidgetLauncher } = require('../services/attention-widget');
  let enabled = true;
  const settings = { read: () => ({ enabled, language: 'auto' }) };
  const mac = createWidgetLauncher({ settings, dataDir: '/nonexistent', platform: 'darwin', env: {}, fs: { existsSync: () => false } });
  assert.deepEqual(mac.state(), { supported: true, blocked: false, enabled: true, running: false, url: null });
  enabled = false;
  assert.equal(mac.state().enabled, false);
  const linux = createWidgetLauncher({ settings, dataDir: '/nonexistent', platform: 'linux', env: { NODE_ENV: 'test' } });
  assert.deepEqual(linux.state(), { supported: false, blocked: true, enabled: false, running: false, url: null });
  // The shared state reader cleans what it gets.
  assert.deepEqual(notices.readWidgetState(() => ({ supported: 1, enabled: true, running: true, url: 'javascript:x' })), { supported: false, blocked: false, enabled: true, running: true, url: null });
});

test('the words of a bubble have Chinese translations, ready for widgets/macos/strings.json when the window uses them', () => {
  const { createDictionary } = require('../routes/attention-widget');
  const words = createDictionary()();
  const bubble = ['Close', 'Open', widget.DIRECT_TITLE, 'Test message', 'This is a test from Settings. Messages about tasks that need you show up here; click a bubble to open it.',
    'Needs you', 'Review', 'Failed', 'Working', 'To do', 'Done', 'Cancelled', 'Update'];
  assert.deepEqual(bubble.filter(text => typeof words[text] !== 'string'), []);
  for (const why of Object.values(widget.NOT_READY)) assert.equal(typeof words[why], 'string', why);
});
