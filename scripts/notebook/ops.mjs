// The cell changes of a notebook and the events of its stream ("Edits and the stream" in docs/design/shell-notebook-page.md). Pure: no DOM, no
// network (the queue is given its `send`), so test/notebook-ops.test.js runs it in Node.
//
// - `applyOps(cells, ops)`: the op shapes of the contract (insert, set, type, delete, move), applied in order on the current cells; an op on a
//   missing cell is skipped, as the server does.
// - `applyEvent(doc, event)`: one event of `GET …/events` (snapshot, ops, cell, output, kernel) applied to the notebook shown. Output lines are
//   changed in place (a fast program sends many events; copying ten thousand lines for each would cost more than drawing them).
// - `createOpQueue`: what this page changed and has not sent yet. A cell's text is sent 400 ms after typing stops (`edit`), the other ops at once
//   (`push`); `flush` sends everything now (before a run, whose source is the one the server holds). One request at a time, at most 200 ops each.

export const OP_LIMIT = 200; // ops per request (the contract's limit)
export const REQUEST_BYTES = 4 * 1024 * 1024; // the JSON of one request stays under the contract's 5 MB
export const SOURCE_BYTES = 1024 * 1024; // a cell's source, at most (the contract's limit)
export const EDIT_DELAY_MS = 400;

const hex = bytes => Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
// A new cell's id: 8 random hex characters, as the server makes them.
export function newCellId(random = globalThis.crypto) {
  const bytes = new Uint8Array(4);
  if (random && typeof random.getRandomValues === 'function') random.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return hex(bytes);
}

// A cell as the page keeps it: the contract's shape, with the fields of a code cell filled in.
export function normalCell(cell) {
  const id = String(cell && cell.id ? cell.id : newCellId());
  const source = typeof (cell && cell.source) === 'string' ? cell.source : '';
  if (!cell || cell.type !== 'code') return { id, type: 'markdown', source };
  return {
    id, type: 'code', source,
    count: Number.isInteger(cell.count) ? cell.count : null,
    state: typeof cell.state === 'string' ? cell.state : 'idle',
    exit: Number.isInteger(cell.exit) ? cell.exit : null,
    duration_ms: Number.isFinite(cell.duration_ms) ? cell.duration_ms : null,
    started_at: Number.isFinite(cell.started_at) ? cell.started_at : null,
    ended_at: Number.isFinite(cell.ended_at) ? cell.ended_at : null,
    lines: Array.isArray(cell.lines) ? cell.lines.map(line => String(line)) : [],
    dropped: Number(cell.dropped) > 0 ? Number(cell.dropped) : 0,
    program: typeof cell.program === 'string' ? cell.program : null, // a full-screen cell: the program the engine stopped
  };
}
export function normalDoc(notebook) {
  const doc = notebook && typeof notebook === 'object' ? notebook : {};
  const kernel = doc.kernel && typeof doc.kernel === 'object' ? doc.kernel : {};
  return {
    ...doc,
    revision: Number.isInteger(doc.revision) ? doc.revision : 0,
    kernel: {
      state: kernel.state || 'stopped', shell: kernel.shell || '', running: kernel.running || null,
      queue: Array.isArray(kernel.queue) ? kernel.queue.map(String) : [], waiting_input: Boolean(kernel.waiting_input),
      counter: Number.isInteger(kernel.counter) ? kernel.counter : 0,
    },
    cells: Array.isArray(doc.cells) ? doc.cells.map(normalCell) : [],
  };
}

const clampIndex = (index, length) => {
  const n = Number(index);
  return Number.isInteger(n) ? Math.max(0, Math.min(length, n)) : length;
};

// The cells after `ops`. `keep(id)`: a cell whose text this page changed and has not had saved yet keeps its text (its own `set` follows and
// wins at the server: last write wins). The array and every changed cell are new; an unchanged cell is the same object.
export function applyOps(cells, ops, { keep = () => false } = {}) {
  let list = cells.slice();
  for (const op of Array.isArray(ops) ? ops : []) {
    if (!op || typeof op !== 'object') continue;
    const at = list.findIndex(cell => cell.id === op.id);
    if (op.op === 'insert') {
      const cell = op.cell && typeof op.cell === 'object' ? op.cell : {};
      if (cell.id && list.some(item => item.id === String(cell.id))) continue; // already there (an insert sent again)
      list.splice(clampIndex(op.index, list.length), 0, normalCell({ ...cell, type: cell.type === 'code' ? 'code' : 'markdown' }));
    } else if (op.op === 'set') {
      if (at < 0 || typeof op.source !== 'string' || keep(op.id)) continue;
      list[at] = { ...list[at], source: op.source };
    } else if (op.op === 'type') {
      if (at < 0 || (op.type !== 'code' && op.type !== 'markdown') || list[at].type === op.type) continue;
      list[at] = normalCell({ id: list[at].id, source: list[at].source, type: op.type }); // outputs go when it becomes text
    } else if (op.op === 'delete') {
      if (at >= 0) list.splice(at, 1);
    } else if (op.op === 'move') {
      if (at < 0) continue;
      const [cell] = list.splice(at, 1);
      list.splice(clampIndex(op.index, list.length), 0, cell);
    }
  }
  if (list.length === cells.length && list.every((cell, index) => cell === cells[index])) list = cells;
  return list;
}

const CELL_KEYS = ['count', 'state', 'exit', 'duration_ms', 'started_at', 'ended_at', 'program'];

// One event of the stream, applied to `doc` (the notebook shown, a `normalDoc`). Answers what changed, for the view to draw:
// { doc, cells: 'all' | [ids], from?: { [id]: first changed line }, kernel: bool, resync: bool, title?: string }.
// `client`: this page's id (its own ops come back and are already applied); `keep(id)` as for applyOps; `pending()`: the ops of this page that the
// server may not have yet (a snapshot is older than them: they are applied again on it, so nothing typed here disappears).
export function applyEvent(doc, event, { client = '', keep = () => false, pending = () => [] } = {}) {
  const none = { doc, cells: [], kernel: false, resync: false };
  if (!event || typeof event !== 'object') return none;
  if (event.type === 'snapshot' && event.notebook) {
    const next = normalDoc(event.notebook);
    const local = new Map(doc ? doc.cells.map(cell => [cell.id, cell]) : []);
    next.cells = applyOps(next.cells.map(cell => (keep(cell.id) && local.has(cell.id) ? { ...cell, source: local.get(cell.id).source } : cell)), pending());
    return { doc: next, cells: 'all', kernel: true, resync: false, title: typeof next.title === 'string' ? next.title : undefined };
  }
  if (!doc) return { ...none, resync: true };
  if (event.type === 'ops') {
    if (Number.isInteger(event.revision)) doc.revision = Math.max(doc.revision, event.revision);
    if (client && event.by === client) return none;
    const before = doc.cells;
    doc.cells = applyOps(before, event.ops, { keep });
    if (doc.cells === before) return none;
    const same = doc.cells.length === before.length && doc.cells.every((cell, index) => cell.id === before[index].id && cell.type === before[index].type);
    return { doc, cells: same ? doc.cells.filter((cell, index) => cell !== before[index]).map(cell => cell.id) : 'all', kernel: false, resync: false };
  }
  if (event.type === 'kernel' && event.kernel) {
    doc.kernel = normalDoc({ kernel: event.kernel }).kernel;
    return { doc, cells: [], kernel: true, resync: false };
  }
  const at = doc.cells.findIndex(cell => cell.id === event.id);
  const cell = at >= 0 ? doc.cells[at] : null;
  if (event.type === 'cell' && event.patch && typeof event.patch === 'object') {
    if (!cell || cell.type !== 'code') return none;
    const next = { ...cell };
    for (const key of CELL_KEYS) if (key in event.patch) next[key] = event.patch[key];
    doc.cells = doc.cells.slice();
    doc.cells[at] = next;
    return { doc, cells: [cell.id], kernel: false, resync: false };
  }
  if (event.type === 'output') {
    if (!cell || cell.type !== 'code') return none;
    const from = Number(event.from);
    const lines = Array.isArray(event.lines) ? event.lines.map(line => String(line)) : [];
    if (!Number.isInteger(from) || from < 0 || from > cell.lines.length) return { ...none, resync: true }; // an event was missed: read it again
    cell.lines.length = from;
    for (const line of lines) cell.lines.push(line);
    if (Number.isFinite(Number(event.dropped)) && event.dropped !== undefined) cell.dropped = Math.max(0, Number(event.dropped));
    return { doc, cells: [cell.id], from: { [cell.id]: from }, kernel: false, resync: false };
  }
  return none;
}

const transient = error => !error || !error.status || error.status >= 500 || error.status === 408 || error.status === 429;

// The ops of this page on their way to the server. `send(ops)` posts them (resolves, or rejects with an Error that has `.status`). `onState(state)`:
// 'saved' (nothing waits), 'saving', 'retrying' (a request failed and is tried again). `onRefused(error, ops)`: the server refused a request (a 4xx
// such as INVALID_NOTEBOOK_OPS or TASK_ARCHIVED); its ops are dropped, and the view reads the notebook again.
export function createOpQueue({ send, delay = EDIT_DELAY_MS, onState = () => {}, onRefused = () => {}, retryMs = [1000, 2000, 5000, 10000, 15000], timers = globalThis } = {}) {
  let queued = []; // ops to send, in order
  let inflight = null; // the ops of the request on its way
  const edits = new Map(); // cell id -> its text, typed and not yet queued
  let editTimer = null;
  let retryTimer = null;
  let sendTimer = null;
  let failures = 0;
  let state = 'saved';
  let disposed = false;
  let waiters = []; // { resolve, reject } of flush calls

  const setState = next => { if (next !== state) { state = next; onState(next); } };
  const busy = () => edits.size > 0 || queued.length > 0 || inflight !== null;
  // Nothing queued or on its way: every flush so far is done (text typed after it waits for its own timer), and with no typed text left either the
  // notebook is saved.
  const settle = () => {
    if (queued.length || inflight) return;
    const done = waiters;
    waiters = [];
    for (const waiter of done) waiter.resolve();
    if (!edits.size && retryTimer === null) setState('saved');
  };
  function takeEdits() {
    if (editTimer !== null) { timers.clearTimeout(editTimer); editTimer = null; }
    for (const [id, source] of edits) queued.push({ op: 'set', id, source });
    edits.clear();
  }
  function nextChunk() {
    const chunk = [];
    let bytes = 2;
    while (queued.length && chunk.length < OP_LIMIT) {
      const size = JSON.stringify(queued[0]).length + 1;
      if (chunk.length && bytes + size > REQUEST_BYTES) break;
      chunk.push(queued.shift());
      bytes += size;
    }
    return chunk;
  }
  async function pump() {
    if (disposed || inflight || retryTimer !== null) return;
    if (!queued.length) { settle(); return; }
    setState('saving');
    inflight = nextChunk();
    let failure = null;
    try { await send(inflight); } catch (error) { failure = error || new Error('NETWORK'); }
    if (disposed) return;
    const chunk = inflight;
    inflight = null;
    if (!failure) { failures = 0; void pump(); return; }
    if (!transient(failure)) {
      onRefused(failure, chunk);
      failures = 0;
      void pump();
      return;
    }
    queued = chunk.concat(queued);
    const done = waiters;
    waiters = [];
    for (const waiter of done) waiter.reject(failure);
    setState('retrying');
    const wait = retryMs[Math.min(failures, retryMs.length - 1)];
    failures += 1;
    retryTimer = timers.setTimeout(() => { retryTimer = null; void pump(); }, wait);
  }
  const soon = () => {
    if (sendTimer !== null || disposed) return;
    sendTimer = timers.setTimeout(() => { sendTimer = null; void pump(); }, 0);
  };
  return {
    // A cell's text changed: its `set` goes out `delay` ms after the last change (one op per cell, the latest text).
    edit(id, source) {
      if (disposed) return;
      edits.delete(id);
      edits.set(id, source);
      if (state === 'saved') setState('saving');
      if (editTimer !== null) timers.clearTimeout(editTimer);
      editTimer = timers.setTimeout(() => { editTimer = null; takeEdits(); void pump(); }, delay);
    },
    // Any other op: sent at once, after the ops before it. A deleted cell's typed text is not sent.
    push(op) {
      if (disposed || !op) return;
      if (op.op === 'delete') edits.delete(op.id);
      queued.push(op);
      setState(state === 'retrying' ? 'retrying' : 'saving');
      soon();
    },
    // Sends everything now. Resolves when the server has all of it; rejects with the error when a request fails (the queue goes on trying).
    flush() {
      if (disposed) return Promise.resolve();
      takeEdits();
      if (!busy()) return Promise.resolve();
      const promise = new Promise((resolve, reject) => waiters.push({ resolve, reject }));
      if (retryTimer !== null) { timers.clearTimeout(retryTimer); retryTimer = null; }
      void pump();
      return promise;
    },
    // Is a text of this cell on its way (typed, queued or sent and not answered)? Its text here is then newer than what the server says.
    pending(id) {
      if (edits.has(id)) return true;
      const sets = op => op.op === 'set' && op.id === id;
      return queued.some(sets) || Boolean(inflight && inflight.some(sets));
    },
    // Every op of this page the server may not have applied yet, in order (applied again on a snapshot).
    pendingOps() {
      return [...(inflight || []), ...queued, ...[...edits].map(([id, source]) => ({ op: 'set', id, source }))];
    },
    state: () => state,
    dispose() {
      disposed = true;
      for (const timer of [editTimer, retryTimer, sendTimer]) if (timer !== null) timers.clearTimeout(timer);
      editTimer = retryTimer = sendTimer = null;
      const done = waiters;
      waiters = [];
      for (const waiter of done) waiter.resolve();
    },
  };
}
