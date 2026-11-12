// services/browser-recordings.js in a temporary folder: append with redaction, the summary fields, ids that are refused, the per-recording limit,
// the total limit (oldest first), the 14-day cleanup, reloading from disk, the items stream and removal.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBrowserRecordings } = require('../services/browser-recordings');

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'browser-rec-'));
const DAY = 24 * 3600 * 1000;

test('append: items are redacted, counted by kind and origin; the summary has the contract fields; files are private', () => {
  const dir = tempDir();
  try {
    const recordings = createBrowserRecordings({ dir, now: () => Date.parse('2026-11-01T10:00:00Z') });
    recordings.start('rec_abc_1234', { tab_id: 4, browser_id: 'br_1', task_id: 3, terminal_id: 't-1', url: 'https://a.test/x' });
    const result = recordings.append('rec_abc_1234', [
      { seq: 1, kind: 'input', tab_id: 4, url: 'https://a.test/login', target: { tag: 'input', type: 'password', name: 'pw' }, value: 'hunter2' },
      { seq: 2, kind: 'submit', tab_id: 4, url: 'https://a.test/login', fields: { user: 'ann', password: 'hunter2' } },
      { seq: 3, kind: 'request', tab_id: 4, url: 'https://cdn.test/app.js?sig=abc' },
      'not an item', null, [1],
    ]);
    assert.deepEqual(result, { appended: 3, items: 3, bytes: result.bytes, truncated: false });
    const text = fs.readFileSync(path.join(dir, 'rec_abc_1234.jsonl'), 'utf8');
    assert.ok(!text.includes('hunter2'));
    assert.equal(text.trim().split('\n').length, 3);
    const summary = recordings.get('rec_abc_1234');
    for (const field of ['recording_id', 'tab_id', 'started_at', 'stopped_at', 'origins', 'items', 'bytes', 'task_id', 'terminal_id']) assert.ok(field in summary, field);
    assert.deepEqual(summary.kinds, { input: 1, submit: 1, request: 1 });
    assert.deepEqual(summary.origins, ['https://a.test', 'https://cdn.test']);
    assert.equal(summary.bytes, Buffer.byteLength(text));
    assert.equal(fs.statSync(path.join(dir, 'rec_abc_1234.jsonl')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.throws(() => recordings.append('../etc/passwd', []), { code: 'BAD_RECORDING_ID' });
    assert.throws(() => recordings.append('rec_a_b/../x', []), { code: 'BAD_RECORDING_ID' });
    assert.throws(() => recordings.get('rec_none_0000'), error => error.code === 'RECORDING_NOT_FOUND' && error.status === 404);
    assert.equal(recordings.stop('rec_abc_1234', { reason: 'stopped' }).stop_reason, 'stopped');
    assert.equal(recordings.stop('rec_abc_1234', { reason: 'again' }).stop_reason, 'stopped', 'the first stop counts');

    const again = createBrowserRecordings({ dir });
    assert.equal(again.list()[0].items, 3, 'read back from disk');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('limits: items past the per-recording limit are dropped and counted; past the total, the oldest recordings go first', () => {
  const dir = tempDir();
  try {
    let clock = Date.parse('2026-11-01T00:00:00Z');
    const recordings = createBrowserRecordings({ dir, now: () => clock, maxRecordingBytes: 1000, maxTotalBytes: 2500 });
    const item = n => ({ seq: n, kind: 'console', text: 'x'.repeat(200) });
    recordings.start('rec_a_0001', {});
    const result = recordings.append('rec_a_0001', [item(1), item(2), item(3), item(4), item(5), item(6)]);
    assert.equal(result.truncated, true);
    const first = recordings.get('rec_a_0001');
    assert.ok(first.bytes <= 1000);
    assert.equal(first.items + first.dropped_items, 6);
    for (const id of ['rec_b_0001', 'rec_c_0001']) {
      clock += 1000;
      recordings.start(id, {});
      recordings.append(id, [item(1), item(2), item(3), item(4)]);
    }
    const ids = recordings.list().map(summary => summary.recording_id);
    assert.ok(!ids.includes('rec_a_0001'), 'the oldest was removed');
    assert.ok(ids.includes('rec_c_0001'), 'the one being written stays');
    assert.equal(fs.existsSync(path.join(dir, 'rec_a_0001.jsonl')), false);
    assert.ok(recordings.list().reduce((sum, summary) => sum + summary.bytes, 0) <= 2500);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cleanup: recordings without activity for 14 days are removed; the items stream and remove', async () => {
  const dir = tempDir();
  try {
    let clock = Date.parse('2026-11-01T00:00:00Z');
    const recordings = createBrowserRecordings({ dir, now: () => clock });
    recordings.start('rec_old_0001', {});
    recordings.append('rec_old_0001', [{ seq: 1, kind: 'nav', url: 'https://a.test/' }]);
    recordings.stop('rec_old_0001');
    clock += 10 * DAY;
    recordings.start('rec_new_0001', {});
    recordings.append('rec_new_0001', [{ seq: 1, kind: 'nav', url: 'https://b.test/' }, { seq: 2, kind: 'click', url: 'https://b.test/' }]);
    clock += 5 * DAY;
    assert.equal(recordings.cleanup(), 1);
    assert.deepEqual(recordings.list().map(summary => summary.recording_id), ['rec_new_0001']);
    const chunks = [];
    for await (const chunk of recordings.itemsStream('rec_new_0001')) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString().trim().split('\n').map(line => JSON.parse(line).seq).join(','), '1,2');
    recordings.start('rec_empty_0001', {});
    const empty = [];
    for await (const chunk of recordings.itemsStream('rec_empty_0001')) empty.push(chunk);
    assert.equal(empty.length, 0);
    assert.deepEqual(recordings.remove('rec_new_0001'), { removed: true, recording_id: 'rec_new_0001' });
    assert.equal(fs.existsSync(path.join(dir, 'rec_new_0001.json')), false);
    assert.throws(() => recordings.remove('rec_new_0001'), { code: 'RECORDING_NOT_FOUND' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
