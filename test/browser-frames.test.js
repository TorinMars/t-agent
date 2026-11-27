// Pictures of a recording ("Pictures of a recording" in docs/design/browser-extension.md): services/browser-recordings.js stores a frame item's
// JPEG in its own file and keeps the line small, with the limits (max_frames, the size of one picture, all pictures of a recording, the 2 GiB
// of all recordings), removal and the 14 days; the relay serves a picture; the bridge refuses --frames to an older extension; and
// `tcli browser record start --frames` / `record export --html` against a fake extension: the replay page holds every picture, the steps and
// their times, works offline (no external address, a CSP), and --gif is refused.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const express = require('express');
const { createBrowserRecordings } = require('../services/browser-recordings');
const { createBrowserRelayRouter } = require('../routes/browser-ext');
const { bridgeServer, fakeExtension, memoryDb, FEATURES } = require('./helpers/fake-browser-ext');
const { buildReplayHtml, describeItem } = require('../lib/browser-recording-replay');

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'browser-frames-'));
const DAY = 24 * 3600 * 1000;
const jpeg = (size = 64, fill = 7) => { const bytes = Buffer.alloc(size, fill); bytes[0] = 0xff; bytes[1] = 0xd8; bytes[2] = 0xff; return bytes; };
const frameItem = (seq, forSeq, image = jpeg()) => ({ seq, at: 1000 + seq, kind: 'frame', tab: 4, tab_id: 4, for_seq: forSeq, mime: 'image/jpeg', width: 640, height: 400, masked: 1, data_base64: image.toString('base64') });

test('a frame is stored in its own file; the line keeps no picture; the rest of the item is redacted as always', () => {
  const dir = tempDir();
  try {
    const recordings = createBrowserRecordings({ dir });
    recordings.start('rec_fr_0001', { tab_id: 4, options: { frames: true, max_frames: 3, bogus: 1 } });
    assert.deepEqual(recordings.get('rec_fr_0001').options, { frames: true, max_frames: 3 });
    const image = jpeg(100);
    recordings.append('rec_fr_0001', [
      { seq: 1, at: 1001, kind: 'click', source: 'agent', tab: 4, target: { tag: 'button', name: 'Save' } },
      { ...frameItem(2, 1, image), url: 'https://a.test/?token=abc' },
    ]);
    const lines = fs.readFileSync(path.join(dir, 'rec_fr_0001.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(lines.length, 2);
    const frame = lines[1];
    assert.equal(frame.data_base64, undefined, 'the picture is not in the items file');
    assert.deepEqual([frame.frame, frame.file, frame.bytes, frame.for_seq, frame.mime], [1, '000001.jpg', 100, 1, 'image/jpeg']);
    assert.equal(frame.url, 'https://a.test/?token=<redacted:3>', 'the rest is redacted');
    const file = path.join(dir, 'rec_fr_0001.frames', '000001.jpg');
    assert.deepEqual(fs.readFileSync(file), image);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    const summary = recordings.get('rec_fr_0001');
    assert.deepEqual([summary.frames, summary.frame_bytes, summary.kinds.frame], [1, 100, 1]);
    assert.deepEqual(recordings.frame('rec_fr_0001', '1'), { file, bytes: 100 });
    assert.throws(() => recordings.frame('rec_fr_0001', '2'), { code: 'FRAME_NOT_FOUND' });
    assert.throws(() => recordings.frame('rec_fr_0001', '../x'), { code: 'FRAME_NOT_FOUND' });
    assert.throws(() => recordings.frame('rec_none_0001', '1'), { code: 'RECORDING_NOT_FOUND' });
    assert.equal(createBrowserRecordings({ dir }).get('rec_fr_0001').frames, 1, 'read back from disk');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('limits: max_frames, one picture, all pictures of a recording; one limit line; not a JPEG; skipped frames kept as notes', () => {
  const dir = tempDir();
  try {
    const recordings = createBrowserRecordings({ dir, maxFrameBytes: 200, maxFrameTotalBytes: 1000 });
    recordings.start('rec_lim_0001', { options: { frames: true, max_frames: 2 } });
    recordings.append('rec_lim_0001', [frameItem(1, 0), frameItem(2, 0), frameItem(3, 0), frameItem(4, 0)]);
    let lines = fs.readFileSync(path.join(dir, 'rec_lim_0001.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(lines.map(line => line.frame || line.skipped), [1, 2, 'limit'], 'past max_frames: one line, then counted');
    assert.equal(recordings.get('rec_lim_0001').frames_dropped, 2);
    assert.equal(fs.readdirSync(path.join(dir, 'rec_lim_0001.frames')).length, 2);

    recordings.start('rec_big_0001', { options: { frames: true } });
    recordings.append('rec_big_0001', [
      frameItem(1, 0, jpeg(300)), // over one picture's limit
      { ...frameItem(2, 0), data_base64: Buffer.from('GIF89a').toString('base64') },
      { ...frameItem(3, 0), data_base64: 'not base64!' },
      { seq: 4, kind: 'frame', for_seq: 0, skipped: 'mask' },
      ...[5, 6, 7, 8, 9, 10].map(seq => frameItem(seq, 0, jpeg(190))), // 5 fit in 1000 bytes
    ]);
    lines = fs.readFileSync(path.join(dir, 'rec_big_0001.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(lines.map(line => line.frame || line.skipped), ['too large', 'not a JPEG', 'not a JPEG', 'mask', 1, 2, 3, 4, 5, 'limit']);
    assert.ok(lines.every(line => line.data_base64 === undefined));
    assert.equal(recordings.get('rec_big_0001').frame_bytes, 950);

    recordings.append('rec_old_0001', [frameItem(1, 0)]); // a recording the server did not see start: the default limit
    assert.equal(recordings.get('rec_old_0001').frames, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the pictures go with their recording: removal, the 14 days, and they count towards the total', () => {
  const dir = tempDir();
  try {
    let clock = Date.parse('2026-11-01T10:00:00Z');
    const recordings = createBrowserRecordings({ dir, now: () => clock, maxTotalBytes: 3000 });
    recordings.start('rec_a_0001', { started_at: '2026-11-01T10:00:00Z', options: { frames: true } });
    recordings.append('rec_a_0001', [frameItem(1, 0, jpeg(2000))]);
    recordings.start('rec_b_0001', { started_at: '2026-11-01T11:00:00Z', options: { frames: true } });
    recordings.append('rec_b_0001', [frameItem(1, 0, jpeg(1500))]);
    assert.equal(fs.existsSync(path.join(dir, 'rec_a_0001.frames')), false, 'the oldest went: its pictures made the total too large');
    assert.throws(() => recordings.get('rec_a_0001'), { code: 'RECORDING_NOT_FOUND' });
    recordings.remove('rec_b_0001');
    assert.equal(fs.existsSync(path.join(dir, 'rec_b_0001.frames')), false);

    recordings.start('rec_c_0001', { options: { frames: true } });
    recordings.append('rec_c_0001', [frameItem(1, 0)]);
    recordings.stop('rec_c_0001');
    clock += 15 * DAY;
    assert.equal(recordings.cleanup(), 1);
    assert.equal(fs.existsSync(path.join(dir, 'rec_c_0001.frames')), false, 'after 14 days the pictures go too');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the replay page: every picture embedded, the steps and times, previous / next, no external address, escaped text', () => {
  const steps = [
    { item: { kind: 'frame', seq: 2, for_seq: 1, at: 2000, tab: 4, width: 640, height: 400 }, action: { seq: 1, at: 1500, kind: 'click', source: 'agent', target: { tag: 'button', role: 'button', name: '<b>Save</b>' }, url: 'https://shop.test/cart' }, image: jpeg(30) },
    { item: { kind: 'frame', seq: 4, for_seq: 3, at: 4000, skipped: 'mask' }, action: { seq: 3, at: 3900, kind: 'nav', to: 'https://shop.test/pay' }, image: null },
    { item: { kind: 'frame', seq: 6, for_seq: 5, at: 6000 }, action: { seq: 5, at: 5500, kind: 'input', source: 'agent', value: '<redacted:7>', target: { tag: 'input', name: 'password' } }, image: jpeg(40) },
  ];
  const html = buildReplayHtml({ recordingId: 'rec_x_0001', startedAt: new Date(1000).toISOString(), steps });
  assert.equal((html.match(/<img src="data:image\/jpeg;base64,/g) || []).length, 2);
  assert.equal((html.match(/<figure /g) || []).length, 3);
  assert.match(html, /Agent clicked button &quot;&lt;b&gt;Save&lt;\/b&gt;&quot;/, 'the text is escaped');
  assert.ok(!html.includes('<b>Save</b>'));
  assert.match(html, /No picture \(not taken: a part that must be hidden could not be checked\)/);
  assert.match(html, /Agent typed &quot;&lt;redacted:7&gt;&quot; into input &quot;password&quot;/);
  assert.match(html, /\+0\.5 s/);
  assert.match(html, /id="prev"/);
  assert.match(html, /id="next"/);
  assert.match(html, /ArrowLeft/);
  assert.match(html, /ArrowRight/);
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; img-src data:/);
  // Nothing in it is fetched: no src / href / url() / @import naming another address (page addresses only appear as text).
  assert.ok(!/\b(?:src|href|action|poster|srcset)\s*=\s*["']?(?!data:)[a-z]+:/i.test(html), 'no external resource');
  assert.ok(!/url\(|@import|<link|<iframe|fetch\(|XMLHttpRequest/i.test(html));
  assert.match(buildReplayHtml({ recordingId: 'rec_y_0001', steps: [] }), /This recording has no pictures/);
  assert.equal(describeItem({ kind: 'key', source: 'user', key: 'Enter', modifiers: ['Control'] }), 'Person pressed Control+Enter');
  assert.equal(describeItem({ kind: 'nav', source: 'agent', action: 'back', to: 'https://a.test/' }), 'Agent back: went to https://a.test/');
});

test('the bridge refuses --frames to an extension without record.frames, in record start and in open --record', async () => {
  const env = await bridgeServer();
  try {
    const pairOne = () => env.bridge.pair({ code: env.bridge.createPairCode().code, name: 'Old' }).token;
    const old = await fakeExtension(env.wsUrl, pairOne(), { features: [...FEATURES, 'open.window'], version: '1.0.7', handler: () => ({ recording_id: 'rec_o_0001' }) });
    await assert.rejects(env.bridge.command('record.start', { frames: true }), error => error.code === 'UNKNOWN_METHOD' && /version 1\.0\.7 does not support record start --frames\): reload it in chrome:\/\/extensions/.test(error.message));
    await assert.rejects(env.bridge.command('tabs.open', { url: 'https://a.test/', record: { frames: true }, window: 'front' }), /does not support open --record --frames/);
    await env.bridge.command('tabs.open', { url: 'https://a.test/', record: { types: ['XHR'] }, window: 'front' });
    assert.equal(old.commands.length, 1, 'only the open without frames reached the browser');
    old.close();
    const fresh = await fakeExtension(env.wsUrl, pairOne(), { features: [...FEATURES, 'open.window', 'record.frames'], handler: () => ({ recording_id: 'rec_n_0001' }) });
    await env.bridge.command('record.start', { frames: true, max_frames: 5 });
    assert.deepEqual(fresh.commands.at(-1).params, { frames: true, max_frames: 5 });
    fresh.close();
  } finally { await env.close(); }
});

// ── tcli against the relay and a fake extension ──
const CLI = path.resolve(__dirname, '../scripts/tcli.js');
const TOKEN = 'f'.repeat(64);
test('tcli: record start --frames, the pictures in record show, record export --html, --gif refused, hints on errors', async t => {
  const work = tempDir();
  const db = memoryDb();
  db.prepare("INSERT INTO tasks (id, user_id) VALUES (31, 'owner')").run();
  const recordings = createBrowserRecordings({ dir: path.join(work, 'recordings') });
  const holder = {};
  const app = express();
  app.use('/api/tcli/browser', createBrowserRelayRouter({ bridge: () => holder.bridge, recordings: () => recordings, db, isLocal: () => true, verifyToken: (task, terminal, token) => task === 31 && terminal === 'term-f' && token === TOKEN }));
  const env = await bridgeServer({ app, db, bridgeOptions: { recordings } });
  holder.bridge = env.bridge;
  let behaviour = {};
  const ext = await fakeExtension(env.wsUrl, env.bridge.pair({ code: env.bridge.createPairCode().code, name: 'Chrome' }).token, {
    features: [...FEATURES, 'open.window', 'record.frames'],
    handler: (method, params) => {
      if (behaviour[method]) return behaviour[method](params);
      if (method === 'record.start') return { recording_id: 'rec_cli_0001', tab_id: 4, url: 'https://shop.test/', options: { network: true, dom: true, bodies: true, types: null, drop_other_types: false, max_body_bytes: null, ...(params.frames ? { frames: true, max_frames: params.max_frames || 200 } : {}) } };
      return {};
    },
  });
  t.after(async () => { ext.close(); await env.close(); fs.rmSync(work, { recursive: true, force: true }); });
  const run = args => new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, 'browser', ...args], { cwd: work, env: { PATH: process.env.PATH, HOME: work, TA_HOOK_URL: `${env.base}/hooks/terminal-activity?task=31&terminal=term-f`, TA_HOOK_TOKEN: TOKEN } });
    const out = [];
    const err = [];
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', chunk => err.push(chunk));
    child.on('close', code => resolve({ code, out: Buffer.concat(out).toString(), err: Buffer.concat(err).toString() }));
  });

  assert.match((await run(['help'])).out, /--frames/);
  assert.match((await run(['help'])).out, /record export <id> --html file\.html/);
  const started = await run(['record', 'start', '--frames', '--max-frames', '50']);
  assert.equal(started.code, 0, started.err);
  assert.deepEqual(ext.commands.at(-1).params, { frames: true, max_frames: 50 });
  const count = ext.commands.length;
  assert.match((await run(['record', 'start', '--max-frames', '5'])).err, /--max-frames needs --frames/);
  assert.match((await run(['record', 'start', '--frames', '--max-frames', '501'])).err, /at most 500/);
  assert.equal(ext.commands.length, count, 'refused options never reach the browser');

  ext.event('record.items', { recording_id: 'rec_cli_0001', items: [
    { seq: 1, at: Date.parse('2026-11-27T10:00:01Z'), kind: 'click', source: 'agent', tab: 4, tab_id: 4, url: 'https://shop.test/', target: { tag: 'button', name: 'Buy' } },
    { seq: 2, at: Date.parse('2026-11-27T10:00:02Z'), kind: 'request', tab: 4, tab_id: 4, url: 'https://shop.test/api/buy', req_id: 'r1' },
    frameItem(3, 1, jpeg(80, 1)),
    { seq: 4, at: Date.parse('2026-11-27T10:00:05Z'), kind: 'nav', tab: 4, tab_id: 4, from: 'https://shop.test/', to: 'https://shop.test/done' },
    frameItem(5, 4, jpeg(90, 2)),
    { seq: 6, at: Date.parse('2026-11-27T10:00:07Z'), kind: 'click', source: 'user', tab: 4, tab_id: 4, target: { tag: 'a', name: 'Home' } },
    { seq: 7, kind: 'frame', tab: 4, for_seq: 6, skipped: 'mask' },
  ] });
  await new Promise(resolve => setTimeout(resolve, 80));
  const shown = await run(['record', 'show', 'rec_cli_0001']);
  assert.match(shown.out, /filters {3}pictures \(at most 50\)/);
  assert.match(shown.out, /pictures {2}2 · 170 B · tcli browser record export rec_cli_0001 --html file\.html/);
  const frames = (await run(['record', 'items', 'rec_cli_0001', '--kind', 'frame'])).out.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(frames.map(item => item.frame || item.skipped), [1, 2, 'mask'], 'record items lists the frames without their pictures');

  const exported = await run(['record', 'export', 'rec_cli_0001', '--html', 'replay.html']);
  assert.equal(exported.code, 0, exported.err);
  assert.match(exported.out, /^Saved .*replay\.html \(2 pictures, .*\): open it in a browser; it needs no network/);
  const html = fs.readFileSync(path.join(work, 'replay.html'), 'utf8');
  assert.equal((html.match(/<figure /g) || []).length, 3, 'one step per frame item');
  assert.ok(html.includes(`data:image/jpeg;base64,${jpeg(80, 1).toString('base64')}`));
  assert.ok(html.includes(`data:image/jpeg;base64,${jpeg(90, 2).toString('base64')}`));
  assert.match(html, /Agent clicked button &quot;Buy&quot;/);
  assert.match(html, /Went to https:\/\/shop\.test\/done/);
  assert.match(html, /Person clicked a &quot;Home&quot;/);
  assert.ok(!/\b(?:src|href)\s*=\s*["']?https?:/i.test(html), 'works offline');
  assert.equal((await run(['record', 'export', 'rec_cli_0001', '--html', 'replay.html'])).code, 1, 'an existing file needs --force');
  assert.equal((await run(['record', 'export', 'rec_cli_0001', '-o', 'replay.html', '--force', '--json'])).code, 0);
  const gif = await run(['record', 'export', 'rec_cli_0001', '--gif', 'replay.gif']);
  assert.equal(gif.code, 1);
  assert.match(gif.err, /GIF export is not built in .*use --html/);
  assert.equal(fs.existsSync(path.join(work, 'replay.gif')), false);
  assert.equal((await run(['record', 'export', 'rec_cli_0001'])).code, 1, 'the file is needed');
  const missing = await run(['record', 'export', 'rec_none_0001', '--html', 'none.html']);
  assert.equal(missing.code, 3);
  assert.match(missing.err, /\(RECORDING_NOT_FOUND\)\nhint: List the recordings with: tcli browser record list/);

  // Hints: a line under the error, `hint` in the JSON; the exit codes stay.
  behaviour['input.click'] = () => { throw Object.assign(new Error('Element is hidden or disabled'), { code: 'ELEMENT_NOT_INTERACTABLE' }); };
  const covered = await run(['click', 'e3']);
  assert.equal(covered.code, 1);
  assert.match(covered.err, /^tcli: Element is hidden or disabled \(ELEMENT_NOT_INTERACTABLE\)\nhint: .*scroll to it .*close the dialog in front of it, then take a new snapshot/);
  const coveredJson = JSON.parse((await run(['click', 'e3', '--json'])).err);
  assert.deepEqual([coveredJson.error, coveredJson.exit, /scroll to it/.test(coveredJson.hint)], ['ELEMENT_NOT_INTERACTABLE', 1, true]);
  behaviour['input.click'] = () => { throw Object.assign(new Error('Unknown or stale ref'), { code: 'REF_NOT_FOUND' }); };
  const stale = await run(['click', 'e3']);
  assert.deepEqual([stale.code, /hint: The page changed since the last snapshot: take a new one/.test(stale.err)], [3, true]);
  behaviour['input.click'] = () => { throw Object.assign(new Error('Nope'), { code: 'SOMETHING_NEW' }); };
  const unknown = await run(['click', 'e3']);
  assert.ok(!/hint:/.test(unknown.err), 'a code without a hint prints none');
  assert.equal((await run(['click', 'nonsense'])).err.includes('hint:'), false, 'usage errors have no hint');
});
