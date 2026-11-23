// The cell changes and the stream events of the shell notebook view (scripts/notebook/ops.mjs, "Edits and the stream" in
// docs/design/shell-notebook-page.md): the contract's op shapes applied in order, a remote edit never overwriting text typed here and not yet saved,
// a snapshot older than this page's ops, output events (append, overwrite, clear, a missed event), and the queue that sends a cell's text 400 ms
// after typing stops, everything else at once, one request at a time, retried after a failure and dropped when refused. Also the texts of
// scripts/notebook/model.mjs (the shell's state, the task list's line, a cell's meta line, the shell highlighting, the .ipynb of Download).
const test = require('node:test');
const assert = require('node:assert/strict');

const ops = () => import('../scripts/notebook/ops.mjs');
const model = () => import('../scripts/notebook/model.mjs');

// Timers the test moves by hand.
function clock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    setTimeout(fn, ms) { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    async tick(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await new Promise(resolve => setImmediate(resolve));
      }
      now = end;
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}
const cells = () => [{ id: 'a', type: 'code', source: 'echo a' }, { id: 'b', type: 'markdown', source: '# B' }, { id: 'c', type: 'code', source: 'ls' }];

test('applyOps: insert, set, type, delete and move, in order; an op on a missing cell is skipped', async () => {
  const { applyOps, normalCell } = await ops();
  const start = cells().map(normalCell);
  const after = applyOps(start, [
    { op: 'insert', index: 1, cell: { id: 'n', type: 'code', source: 'pwd' } },
    { op: 'set', id: 'a', source: 'echo A' },
    { op: 'type', id: 'b', type: 'code' },
    { op: 'delete', id: 'c' },
    { op: 'move', id: 'a', index: 2 },
    { op: 'set', id: 'gone', source: 'x' },
    { op: 'delete', id: 'gone' },
  ]);
  assert.deepEqual(after.map(cell => [cell.id, cell.type, cell.source]), [['n', 'code', 'pwd'], ['b', 'code', '# B'], ['a', 'code', 'echo A']]);
  assert.equal(after[1].state, 'idle', 'a text cell made code gets the fields of a code cell');
  assert.deepEqual(after[1].lines, []);
  const text = applyOps(after, [{ op: 'type', id: 'a', type: 'markdown' }]);
  assert.deepEqual(Object.keys(text[2]).sort(), ['id', 'source', 'type'], 'outputs go when it becomes text');
  assert.equal(applyOps(start, []), start, 'nothing changed: the same array');
  assert.equal(applyOps(start, [{ op: 'insert', index: 0, cell: { id: 'a', type: 'code', source: 'again' } }]), start, 'an insert of a cell that is there is skipped');
  assert.equal(applyOps(start, [{ op: 'insert', index: 99, cell: { id: 'z', type: 'code', source: '' } }]).at(-1).id, 'z', 'an index past the end appends');
  assert.equal(applyOps(start, [{ op: 'set', id: 'a', source: 'remote' }], { keep: id => id === 'a' })[0].source, 'echo a', 'a cell kept by this page keeps its text');
});

test('applyEvent: remote ops, this page\'s own ops and the revision', async () => {
  const { applyEvent, normalDoc } = await ops();
  const doc = normalDoc({ id: 't1', revision: 3, kernel: { state: 'idle', shell: 'zsh' }, cells: cells() });
  const mine = applyEvent(doc, { type: 'ops', revision: 4, by: 'me', ops: [{ op: 'delete', id: 'a' }] }, { client: 'me' });
  assert.deepEqual(mine.cells, [], 'its own ops are already applied here');
  assert.equal(doc.revision, 4);
  assert.equal(doc.cells.length, 3);
  const edit = applyEvent(doc, { type: 'ops', revision: 5, by: 'phone', ops: [{ op: 'set', id: 'c', source: 'ls -la' }] }, { client: 'me' });
  assert.deepEqual(edit.cells, ['c'], 'a text change draws only that cell');
  assert.equal(doc.cells[2].source, 'ls -la');
  const insert = applyEvent(doc, { type: 'ops', revision: 6, by: 'phone', ops: [{ op: 'insert', index: 0, cell: { id: 'p', type: 'markdown', source: 'hi' } }] }, { client: 'me' });
  assert.equal(insert.cells, 'all', 'an insert redraws the list');
  assert.equal(doc.cells[0].id, 'p');
  const kept = applyEvent(doc, { type: 'ops', revision: 7, by: 'phone', ops: [{ op: 'set', id: 'a', source: 'theirs' }] }, { client: 'me', keep: id => id === 'a' });
  assert.deepEqual(kept.cells, []);
  assert.equal(doc.cells.find(cell => cell.id === 'a').source, 'echo a', 'text typed here and not yet saved wins');
});

test('applyEvent: a snapshot keeps the text typed here and re-applies this page\'s pending ops', async () => {
  const { applyEvent, normalDoc } = await ops();
  const doc = normalDoc({ revision: 1, cells: cells() });
  doc.cells[0].source = 'echo typed';
  const pending = [{ op: 'insert', index: 3, cell: { id: 'new', type: 'code', source: '' } }, { op: 'set', id: 'new', source: 'date' }];
  const result = applyEvent(doc, { type: 'snapshot', notebook: { title: 'Release check', revision: 9, kernel: { state: 'busy', running: 'c', queue: ['a'] }, cells: cells() } },
    { keep: id => id === 'a' || id === 'new', pending: () => pending });
  assert.equal(result.cells, 'all');
  assert.equal(result.title, 'Release check');
  assert.equal(result.doc.revision, 9);
  assert.equal(result.doc.cells[0].source, 'echo typed');
  assert.deepEqual(result.doc.cells.map(cell => cell.id), ['a', 'b', 'c', 'new'], 'a cell inserted here and not yet saved does not disappear');
  assert.equal(result.doc.cells[3].source, 'date');
  assert.deepEqual(result.doc.kernel, { state: 'busy', shell: '', running: 'c', queue: ['a'], waiting_input: false, counter: 0 });
});

test('applyEvent: cell patches, kernel, output append / overwrite / clear, and a missed output event', async () => {
  const { applyEvent, normalDoc } = await ops();
  const doc = normalDoc({ cells: cells() });
  const patch = applyEvent(doc, { type: 'cell', id: 'a', patch: { state: 'running', started_at: 1000, count: 4, unknown: 'x' } });
  assert.deepEqual(patch.cells, ['a']);
  assert.equal(doc.cells[0].state, 'running');
  assert.equal(doc.cells[0].count, 4);
  assert.equal(doc.cells[0].unknown, undefined, 'only the cell fields are taken');
  assert.deepEqual(applyEvent(doc, { type: 'cell', id: 'b', patch: { state: 'running' } }).cells, [], 'a text cell has no state');
  const out1 = applyEvent(doc, { type: 'output', id: 'a', from: 0, lines: ['one', 'two'], dropped: 0 });
  assert.deepEqual(out1.from, { a: 0 });
  const lines = doc.cells[0].lines;
  applyEvent(doc, { type: 'output', id: 'a', from: 2, lines: ['three 10%'] });
  applyEvent(doc, { type: 'output', id: 'a', from: 2, lines: ['three 100%', 'four'], dropped: 5 });
  assert.deepEqual(doc.cells[0].lines, ['one', 'two', 'three 100%', 'four'], 'a progress line ends as its last state');
  assert.equal(doc.cells[0].lines, lines, 'the lines change in place');
  assert.equal(doc.cells[0].dropped, 5);
  assert.equal(applyEvent(doc, { type: 'output', id: 'a', from: 9, lines: ['x'] }).resync, true, 'an event was missed: the notebook is read again');
  applyEvent(doc, { type: 'output', id: 'a', from: 0, lines: [] });
  assert.deepEqual(doc.cells[0].lines, [], 'from 0 with no lines clears');
  const kernel = applyEvent(doc, { type: 'kernel', kernel: { state: 'idle', shell: 'zsh', queue: [], counter: 4 } });
  assert.equal(kernel.kernel, true);
  assert.equal(doc.kernel.counter, 4);
  assert.equal(applyEvent(null, { type: 'cell', id: 'a', patch: {} }).resync, true, 'no notebook yet: read it');
  assert.deepEqual(applyEvent(doc, { type: 'something-new' }).cells, []);
});

test('the queue: a cell\'s text 400 ms after typing stops, one op per cell, other ops at once and in order', async () => {
  const { createOpQueue } = await ops();
  const timers = clock();
  const sent = [];
  const states = [];
  const queue = createOpQueue({ send: async list => { sent.push(list); }, timers, onState: state => states.push(state) });
  queue.edit('a', 'e');
  await timers.tick(300);
  queue.edit('a', 'ec');
  queue.edit('a', 'echo');
  assert.equal(queue.pending('a'), true);
  await timers.tick(399);
  assert.deepEqual(sent, [], 'nothing while typing goes on');
  await timers.tick(1);
  assert.deepEqual(sent, [[{ op: 'set', id: 'a', source: 'echo' }]], 'one set with the latest text');
  assert.equal(queue.pending('a'), false);
  queue.push({ op: 'insert', index: 0, cell: { id: 'n', type: 'code', source: '' } });
  queue.edit('n', 'pwd');
  await timers.tick(0);
  assert.deepEqual(sent[1], [{ op: 'insert', index: 0, cell: { id: 'n', type: 'code', source: '' } }], 'an insert goes at once');
  await timers.tick(400);
  assert.deepEqual(sent[2], [{ op: 'set', id: 'n', source: 'pwd' }], 'and the text of the new cell after it');
  assert.equal(queue.state(), 'saved');
  assert.deepEqual(states.filter((state, index) => state !== states[index - 1]), states, 'a state is told once per change');
  assert.ok(states.includes('saving') && states.at(-1) === 'saved');
});

test('the queue: flush sends at once (before a run), a deleted cell\'s text is not sent, pendingOps lists what is on its way', async () => {
  const { createOpQueue } = await ops();
  const timers = clock();
  const sent = [];
  let release = null;
  const queue = createOpQueue({ send: list => { sent.push(list); return new Promise(resolve => { release = resolve; }); }, timers });
  queue.edit('a', 'echo 1');
  queue.edit('b', 'gone');
  queue.push({ op: 'delete', id: 'b' });
  const flushed = queue.flush();
  let done = false;
  flushed.then(() => { done = true; });
  await timers.tick(0);
  assert.deepEqual(sent, [[{ op: 'delete', id: 'b' }, { op: 'set', id: 'a', source: 'echo 1' }]], 'one request, the deleted cell\'s text left out');
  assert.deepEqual(queue.pendingOps(), sent[0], 'the request on its way is still pending');
  assert.equal(queue.pending('a'), true);
  assert.equal(done, false, 'flush waits for the answer');
  queue.edit('a', 'echo 2');
  assert.deepEqual(queue.pendingOps().at(-1), { op: 'set', id: 'a', source: 'echo 2' });
  release();
  await timers.tick(0);
  assert.equal(done, true);
  await timers.tick(400);
  assert.deepEqual(sent[1], [{ op: 'set', id: 'a', source: 'echo 2' }]);
  release();
  await timers.tick(0);
  assert.equal(await queue.flush(), undefined, 'nothing to send: resolves at once');
});

test('the queue: at most 200 ops per request, one request at a time', async () => {
  const { createOpQueue, OP_LIMIT } = await ops();
  const timers = clock();
  const sent = [];
  let inFlight = 0;
  let most = 0;
  const queue = createOpQueue({ send: async list => { inFlight += 1; most = Math.max(most, inFlight); sent.push(list.length); await new Promise(resolve => setImmediate(resolve)); inFlight -= 1; }, timers });
  for (let i = 0; i < 450; i++) queue.push({ op: 'insert', index: i, cell: { id: `c${i}`, type: 'code', source: '' } });
  await queue.flush();
  assert.equal(OP_LIMIT, 200);
  assert.deepEqual(sent, [200, 200, 50]);
  assert.equal(most, 1);
});

test('the queue: a network failure is retried with the same ops; a refusal drops them and says so', async () => {
  const { createOpQueue } = await ops();
  const timers = clock();
  const sent = [];
  const refused = [];
  const states = [];
  let fail = [Object.assign(new Error('NETWORK'), { status: 0 }), Object.assign(new Error('BAD_GATEWAY'), { status: 502 })];
  const queue = createOpQueue({
    send: async list => { sent.push(list); const error = fail.shift(); if (error) throw error; },
    timers, onState: state => states.push(state), onRefused: (error, list) => refused.push([error.message, list]),
  });
  queue.push({ op: 'delete', id: 'a' });
  await assert.rejects(queue.flush(), /NETWORK/, 'flush says the request failed');
  assert.equal(queue.state(), 'retrying');
  await timers.tick(1000);
  assert.equal(sent.length, 2, 'tried again after 1 s');
  await timers.tick(2000);
  assert.equal(sent.length, 3, 'then after 2 s');
  assert.deepEqual(sent.map(list => list[0].id), ['a', 'a', 'a'], 'the same op each time');
  assert.equal(queue.state(), 'saved');
  fail = [Object.assign(new Error('INVALID_NOTEBOOK_OPS'), { status: 400 })];
  queue.push({ op: 'move', id: 'x', index: -1 });
  queue.push({ op: 'delete', id: 'y' });
  await queue.flush();
  assert.deepEqual(refused, [['INVALID_NOTEBOOK_OPS', [{ op: 'move', id: 'x', index: -1 }, { op: 'delete', id: 'y' }]]]);
  assert.equal(queue.state(), 'saved');
  queue.dispose();
  queue.edit('z', 'after');
  await timers.tick(1000);
  assert.equal(sent.length, 4, 'nothing is sent after dispose');
});

test('newCellId: 8 hex characters', async () => {
  const { newCellId } = await ops();
  const ids = new Set(Array.from({ length: 50 }, () => newCellId()));
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}$/);
  assert.ok(ids.size > 45);
});

test('model: the shell\'s state, the task list\'s line and the gutter', async () => {
  const { kernelStatus, rowLine, countLabel, queuedAfter, codeNumber } = await model();
  const list = [{ id: 't', type: 'markdown' }, { id: 'a', type: 'code' }, { id: 'b', type: 'code' }, { id: 'c', type: 'code' }, { id: 'd', type: 'code' }];
  assert.equal(codeNumber(list, 'c'), 3, 'text cells are not counted');
  assert.equal(codeNumber(list, 't'), 0);
  assert.deepEqual(kernelStatus({ state: 'busy', shell: 'zsh', running: 'c' }, list), { text: 'zsh · Running cell 3', tone: 'running' });
  assert.deepEqual(kernelStatus({ state: 'busy', shell: 'zsh', running: 'c', waiting_input: true }, list), { text: 'zsh · Waiting for input', tone: 'running' });
  assert.deepEqual(kernelStatus({ state: 'idle', shell: 'zsh' }, list), { text: 'zsh · Idle', tone: 'idle' });
  assert.deepEqual(kernelStatus({ state: 'starting', shell: 'bash' }, list), { text: 'bash · Starting', tone: 'starting' });
  assert.deepEqual(kernelStatus({ state: 'stopped', shell: 'zsh' }, list), { text: 'Shell stopped', tone: 'stopped' });
  assert.equal(rowLine({ state: 'busy', running: 'c' }, list), 'Notebook · Running cell 3');
  assert.equal(rowLine({ state: 'idle' }, list), 'Notebook · Idle');
  assert.equal(rowLine({ state: 'stopped' }, list), 'Notebook · Shell stopped');
  assert.equal(countLabel({ type: 'code', state: 'running', count: 2 }), '[*]');
  assert.equal(countLabel({ type: 'code', state: 'queued', count: 2 }), '[ ]');
  assert.equal(countLabel({ type: 'code', state: 'done', count: 2 }), '[2]');
  assert.equal(countLabel({ type: 'code', state: 'idle', count: null }), '[ ]');
  const kernel = { state: 'busy', running: 'c', queue: ['d', 'a'] };
  assert.equal(queuedAfter(kernel, list, 'd'), 3, 'the first in the queue runs after the running cell');
  assert.equal(queuedAfter(kernel, list, 'a'), 4);
  assert.equal(queuedAfter(kernel, list, 'b'), 0);
});

test('model: the meta line of a cell, durations and the program of a full-screen cell', async () => {
  const { metaOf, durationText, elapsedText, programOf } = await model();
  const at = new Date(2026, 10, 23, 14, 20).getTime();
  assert.equal(durationText(300), '0.3 s');
  assert.equal(durationText(1940), '1.9 s');
  assert.equal(durationText(12000), '12 s');
  assert.equal(durationText(125000), '2 min 5 s');
  assert.equal(durationText(3720000), '1 h 2 min');
  assert.equal(elapsedText(38000), '0:38');
  assert.equal(elapsedText(3723000), '1:02:03');
  assert.deepEqual(metaOf({ type: 'code', state: 'done', exit: 0, duration_ms: 300, ended_at: at }), { tone: 'done', check: true, parts: ['Exit 0', '0.3 s', '14:20'] });
  assert.deepEqual(metaOf({ type: 'code', state: 'failed', exit: 1, duration_ms: 800, ended_at: at }, { stoppedRun: true }).parts, ['Exit 1', '0.8 s', '14:20', 'Run all stopped here']);
  assert.deepEqual(metaOf({ type: 'code', state: 'stopped', exit: 130, duration_ms: 12000 }).parts, ['Stopped (Ctrl+C)', '12 s', 'the shell keeps its state']);
  assert.deepEqual(metaOf({ type: 'code', state: 'running', started_at: 1000 }, { now: 39000 }).parts, ['Running', '0:38', 'Ctrl+C stops it']);
  assert.deepEqual(metaOf({ type: 'code', state: 'queued' }, { after: 3 }).parts, ['Queued · runs after cell 3']);
  assert.deepEqual(metaOf({ type: 'code', state: 'interrupted' }).parts, ['Not finished: the shell was restarted']);
  assert.deepEqual(metaOf({ type: 'code', state: 'interrupted' }, { kernelStopped: true }).parts, ['Not finished: the shell was stopped']);
  assert.equal(metaOf({ type: 'code', state: 'idle' }), null);
  assert.equal(metaOf({ type: 'markdown' }), null);
  assert.equal(programOf('htop'), 'htop');
  assert.equal(programOf('# watch it\nFOO=1 sudo /usr/bin/vim notes.txt'), 'vim');
  assert.equal(programOf('  less -R log.txt | cat'), 'less');
  assert.equal(programOf(''), '');
});

test('model: the shell highlighting joins back to the source exactly', async () => {
  const { shellTokens } = await model();
  const source = 'export BASE=http://localhost:4900\ncurl -s $BASE/api | jq \'{app_version}\' # the version\nif [ "$ok" = y ]; then echo ${HOME}; fi';
  const runs = shellTokens(source);
  assert.equal(runs.map(run => run.text).join(''), source);
  const kinds = kind => runs.filter(run => run.kind === kind).map(run => run.text);
  assert.deepEqual(kinds('keyword'), ['export', 'if', 'then', 'echo', 'fi']);
  assert.deepEqual(kinds('var'), ['$BASE', '${HOME}']);
  assert.deepEqual(kinds('string'), ["'{app_version}'", '"$ok"']);
  assert.deepEqual(kinds('comment'), ['# the version']);
  assert.deepEqual(shellTokens('echo-like cd2; echo cd'), [{ text: 'echo-like cd2; ', kind: '' }, { text: 'echo', kind: 'keyword' }, { text: ' cd', kind: '' }], 'only whole words in a command\'s place');
  assert.equal(shellTokens('unterminated "string').map(run => run.text).join(''), 'unterminated "string');
});

test('model: Download .ipynb is nbformat 4.5 with the outputs, the counts and our metadata', async () => {
  const { ipynbOf, fileName, outputText } = await model();
  const text = ipynbOf({
    path: 'notebooks/release-check.ipynb',
    cells: [
      { id: 'm1', type: 'markdown', source: '# Release check\nRun it.' },
      { id: 'c1', type: 'code', source: 'git status', count: 1, state: 'done', exit: 0, duration_ms: 120, ended_at: 5, lines: ['\u001b[32mclean\u001b[0m', 'ok'] },
      { id: 'c2', type: 'code', source: '', count: null, state: 'idle', exit: null, duration_ms: null, ended_at: null, lines: [] },
    ],
  });
  assert.ok(text.endsWith('}\n'), 'a trailing newline');
  const nb = JSON.parse(text);
  assert.equal(nb.nbformat, 4);
  assert.equal(nb.nbformat_minor, 5);
  assert.deepEqual(nb.metadata.kernelspec, { name: 'bash', display_name: 'Bash', language: 'bash' });
  assert.deepEqual(nb.cells[0], { cell_type: 'markdown', id: 'm1', metadata: {}, source: ['# Release check\n', 'Run it.'] });
  assert.deepEqual(nb.cells[1].outputs, [{ output_type: 'stream', name: 'stdout', text: ['\u001b[32mclean\u001b[0m\n', 'ok\n'] }], 'SGR codes kept');
  assert.equal(nb.cells[1].execution_count, 1);
  assert.deepEqual(nb.cells[1].metadata, { 't-agent': { exit: 0, duration_ms: 120, ended_at: 5, state: 'done' } });
  assert.deepEqual(nb.cells[2], { cell_type: 'code', id: 'c2', metadata: {}, source: [], execution_count: null, outputs: [] });
  assert.equal(fileName('notebooks/release-check.ipynb'), 'release-check.ipynb');
  assert.equal(outputText(['\u001b[1ma\u001b[0m', 'b']), 'a\nb\n');
});

test('model: long cells fold past 12 screen lines, show 8, and stay open once opened or edited', async () => {
  const { FOLD_OVER, FOLD_SHOW, foldLabel, foldOf, lineCount, screenLines } = await model();
  assert.equal(FOLD_OVER, 12);
  assert.equal(FOLD_SHOW, 8);
  // The lines of the text: a last newline does not start a new line.
  assert.equal(lineCount(''), 0);
  assert.equal(lineCount('a'), 1);
  assert.equal(lineCount('a\nb\n'), 2);
  assert.equal(lineCount('a\n\nb'), 3);
  // Screen lines from the drawn height: 42 lines of 20.8 px plus 16 px of padding; null when not laid out.
  assert.equal(screenLines(42 * 20.8 + 16, 20.8, 16), 42);
  assert.equal(screenLines(13 * 25.6 + 16, 25.6, 16), 13);
  assert.equal(screenLines(0, 20.8, 16), null);
  assert.equal(screenLines(100, 0, 0), null);
  // The rule: more than 12 lines is long; a short cell never folds; opened or focused is not folded; focus on a long cell holds it open.
  assert.deepEqual(foldOf(12), { long: false, folded: false, hold: false });
  assert.deepEqual(foldOf(13), { long: true, folded: true, hold: false });
  assert.deepEqual(foldOf(42, { opened: true }), { long: true, folded: false, hold: false });
  assert.deepEqual(foldOf(42, { focused: true }), { long: true, folded: false, hold: true });
  assert.deepEqual(foldOf(42, { focused: true, opened: true }), { long: true, folded: false, hold: false });
  assert.deepEqual(foldOf(5, { focused: true }), { long: false, folded: false, hold: false });
  assert.deepEqual(foldOf(null), { long: false, folded: false, hold: false });
  // The button: the lines of the text; a few wrapped lines count as their screen lines.
  const long = Array.from({ length: 42 }, (_, i) => `echo ${i}`).join('\n');
  assert.equal(foldLabel(true, long, 42), 'Show all 42 lines');
  assert.equal(foldLabel(true, `${long}\n`, 50), 'Show all 42 lines');
  assert.equal(foldLabel(true, 'a very long line\nanother', 20), 'Show all 20 lines');
  assert.equal(foldLabel(false, long, 42), 'Show less');
});
