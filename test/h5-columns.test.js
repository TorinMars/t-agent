// The rules of the multi-column view (scripts/h5-shell/columns.mjs): pane ids, the stored layout, the default count and the pane messages.
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../scripts/h5-shell/columns.mjs');

test('pane ids are 1 to 16 characters of a-z and 0-9, read from ?pane=', async () => {
  const { isPaneId, paneIdOf } = await load();
  for (const id of ['a', 'abc123', 'z'.repeat(16)]) assert.equal(isPaneId(id), true, id);
  for (const id of ['', 'A', 'a-b', 'a b', 'z'.repeat(17), '../x', null, 5]) assert.equal(isPaneId(id), false, String(id));
  assert.equal(paneIdOf('?pane=k3x9'), 'k3x9');
  assert.equal(paneIdOf('?openChat=1:2&pane=abc'), 'abc');
  assert.equal(paneIdOf('?pane=BAD'), '');
  assert.equal(paneIdOf(''), '');
});

test('only a top-level page without any pane parameter offers the view', async () => {
  const { canOfferColumns } = await load();
  assert.equal(canOfferColumns('', false), true);
  assert.equal(canOfferColumns('?openChat=1:x', false), true);
  assert.equal(canOfferColumns('?pane=abc', false), false);
  assert.equal(canOfferColumns('?pane=NOT-VALID', false), false, 'an invalid pane id is still a pane: a column never opens columns');
  assert.equal(canOfferColumns('', true), false, 'a framed page never offers it');
});

test('the minimum column width fits an 80-column terminal, at least 480, 640 when it cannot be measured', async () => {
  const { minColumnWidth, MIN_COLUMN_FLOOR, FALLBACK_COLUMN_WIDTH, TERMINAL_SIDE_PADDING } = await load();
  assert.equal(MIN_COLUMN_FLOOR, 480);
  assert.equal(FALLBACK_COLUMN_WIDTH, 640);
  assert.equal(TERMINAL_SIDE_PADDING, 9, 'the terminal inset (4 + 4) and the column border');
  assert.equal(minColumnWidth(7.82666015625, 9), 636, '13px Menlo: ceil(80 x 7.83 + 9)');
  assert.equal(minColumnWidth(7.82666015625, 9 + 15), 651, 'with a 15px classic scrollbar');
  assert.equal(minColumnWidth(7.82666015625), 636, 'the default padding is the terminal side padding');
  assert.equal(minColumnWidth(8, 0), 640);
  assert.equal(minColumnWidth(6.6, 9), 537, '11px');
  assert.equal(minColumnWidth(4, 9), 480, 'never below 480');
  for (const bad of [0, -3, NaN, Infinity, undefined, null, 'x', 500]) assert.equal(minColumnWidth(bad, 9), 640, String(bad));
  assert.equal(minColumnWidth(8, -5), 640, 'a negative padding counts as none');
});

test('the default number of columns is floor(width / column width), 2 to 4', async () => {
  const { defaultCount } = await load();
  assert.equal(defaultCount(1440, 636), 2);
  assert.equal(defaultCount(2000, 636), 3);
  assert.equal(defaultCount(2560, 636), 4);
  assert.equal(defaultCount(3840, 636), 4);
  assert.equal(defaultCount(1000, 636), 2, 'at least 2 (the second one scrolls)');
  assert.equal(defaultCount(1440, 0), 3, 'no usable width: 420');
  assert.equal(defaultCount(900), 2);
  assert.equal(defaultCount(1260), 3);
  assert.equal(defaultCount(1440), 3);
  assert.equal(defaultCount(1680), 4);
  assert.equal(defaultCount(2000), 4);
  assert.equal(defaultCount(3840), 4);
  assert.equal(defaultCount(500), 2);
});

test('new ids are short, valid and never taken', async () => {
  const { newId, isPaneId } = await load();
  const taken = [];
  for (let i = 0; i < 50; i += 1) { const id = newId(taken); assert.equal(isPaneId(id), true); assert.equal(taken.includes(id), false); taken.push(id); }
  let n = 0;
  const repeating = () => [0, 0, 0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5][n++ % 12]; // the first try collides
  assert.equal(newId(['000000'], repeating), 'iiiiii');
});

test('the stored layout is cleaned and round-trips', async () => {
  const { readLayout, writeLayout, MAX_COLUMNS } = await load();
  assert.deepEqual(readLayout(null), { on: false, ids: [] });
  assert.deepEqual(readLayout('not json'), { on: false, ids: [] });
  assert.deepEqual(readLayout('{"on":"yes","ids":"a"}'), { on: false, ids: [] });
  assert.deepEqual(readLayout(JSON.stringify({ on: true, ids: ['a', 'a', 'B', 'c', 7, 'd'] })), { on: true, ids: ['a', 'c', 'd'] });
  assert.equal(MAX_COLUMNS, 12);
  const many = Array.from({ length: 15 }, (_, i) => `c${i}`);
  assert.deepEqual(readLayout(JSON.stringify({ on: true, ids: many })).ids, many.slice(0, 12), 'the first twelve are kept');
  assert.deepEqual(readLayout(writeLayout({ on: true, ids: many })).ids, many.slice(0, 12), 'and only twelve are written');
  const layout = { on: true, ids: ['x1', 'y2'] };
  assert.deepEqual(readLayout(writeLayout(layout)), layout);
});

test('columns: first use makes the default count, at most 12, the last one stays', async () => {
  const { columnsFor, addColumn, closeColumn, canAdd, canClose, MAX_COLUMNS } = await load();
  assert.equal(columnsFor([], 1440).length, 3);
  assert.equal(columnsFor([], 2000).length, 4);
  assert.equal(columnsFor([], 1440, Math.random, 636).length, 2, 'by the measured column width');
  assert.equal(columnsFor([], 2000, Math.random, 636).length, 3);
  assert.deepEqual(columnsFor(['a', 'b'], 2000), ['a', 'b'], 'stored ids come back as they were');
  let ids = ['a'];
  while (canAdd(ids)) ids = addColumn(ids);
  assert.equal(ids.length, MAX_COLUMNS);
  assert.equal(ids.length, 12);
  assert.equal(addColumn(ids), ids, 'no thirteenth column');
  assert.deepEqual(closeColumn(['a', 'b', 'c'], 'b'), ['a', 'c']);
  assert.equal(canClose(['a']), false);
  assert.deepEqual(closeColumn(['a'], 'a'), ['a'], 'the last column is not closed');
});

test('pane messages: only the agreed shape is read', async () => {
  const { readPaneMessage, forgetMessage, paneUrl } = await load();
  assert.deepEqual(readPaneMessage({ type: 't-agent-pane', paneId: 'ab1', event: 'ready' }), { paneId: 'ab1', event: 'ready' });
  assert.deepEqual(readPaneMessage({ type: 't-agent-pane', paneId: 'ab1', event: 'focus' }), { paneId: 'ab1', event: 'focus' });
  assert.deepEqual(readPaneMessage({ type: 't-agent-pane', paneId: 'ab1', event: 'title', title: '  Fix login ', session: 'Terminal 1', extra: 1 }),
    { paneId: 'ab1', event: 'title', title: 'Fix login', session: 'Terminal 1' });
  assert.equal(readPaneMessage({ type: 't-agent-pane', paneId: 'ab1', event: 'title', title: 'x'.repeat(500) }).title.length, 200);
  assert.deepEqual(readPaneMessage({ type: 't-agent-pane', paneId: 'ab1', event: 'title', title: {} }), { paneId: 'ab1', event: 'title', title: '', session: '' });
  for (const bad of [null, 'text', { type: 'other', paneId: 'ab1', event: 'ready' }, { type: 't-agent-pane', paneId: 'AB', event: 'ready' },
    { type: 't-agent-pane', paneId: 'ab1', event: 'forget' }, { type: 't-agent-pane', paneId: 'ab1', event: 'eval' },
    { type: 't-agent-pane', paneId: 'ab1', event: 'scroll-x' }, { type: 't-agent-pane', paneId: 'ab1', event: 'scroll-x', dx: 0 },
    { type: 't-agent-pane', paneId: 'ab1', event: 'scroll-x', dx: '40' }, { type: 't-agent-pane', paneId: 'ab1', event: 'scroll-x', dx: NaN },
    { type: 't-agent-pane', paneId: 'ab1', event: 'scroll-x', dx: Infinity }, { type: 't-agent-pane', paneId: 'ab1', event: 'step' },
    { type: 't-agent-pane', paneId: 'ab1', event: 'step', step: 2 }, { type: 't-agent-pane', paneId: 'ab1', event: 'step', step: '1' }]) {
    assert.equal(readPaneMessage(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual(forgetMessage(), { type: 't-agent-pane', event: 'forget' });
  assert.equal(paneUrl('ab1'), '/h5?pane=ab1');
});

test('an open request: the agreed message, to the focused column or else the first', async () => {
  const { openMessage, targetColumn } = await load();
  assert.deepEqual(openMessage({ sourceKey: 'local', taskId: 2, terminalId: 'd1' }), { type: 't-agent-pane', event: 'open', sourceKey: 'local', taskId: 2, terminalId: 'd1' });
  assert.deepEqual(openMessage({ sourceKey: 'remote:3', taskId: '9' }), { type: 't-agent-pane', event: 'open', sourceKey: 'remote:3', taskId: 9 }, 'no terminalId when it is not known');
  assert.deepEqual(openMessage({ sourceKey: 'local', taskId: 1, conversationId: 'c-1' }), { type: 't-agent-pane', event: 'open', sourceKey: 'local', taskId: 1, conversationId: 'c-1' });
  for (const bad of [{}, { sourceKey: 'local' }, { sourceKey: '', taskId: 1 }, { sourceKey: 'local', taskId: 0 }, { sourceKey: 'local', taskId: 'x' }]) assert.equal(openMessage(bad), null, JSON.stringify(bad));
  assert.equal(targetColumn(['a', 'b', 'c'], 'b'), 'b');
  assert.equal(targetColumn(['a', 'b', 'c'], null), 'a');
  assert.equal(targetColumn(['a', 'c'], 'b'), 'a', 'a focus on a column that is gone falls back to the first');
  assert.equal(targetColumn([], null), null);
});

test('pane messages: sideways scrolls and column steps', async () => {
  const { readPaneMessage } = await load();
  assert.deepEqual(readPaneMessage({ type: 't-agent-pane', paneId: 'ab1', event: 'scroll-x', dx: 42.5, extra: 1 }), { paneId: 'ab1', event: 'scroll-x', dx: 42.5 });
  assert.deepEqual(readPaneMessage({ type: 't-agent-pane', paneId: 'ab1', event: 'scroll-x', dx: -30 }), { paneId: 'ab1', event: 'scroll-x', dx: -30 });
  assert.equal(readPaneMessage({ type: 't-agent-pane', paneId: 'ab1', event: 'scroll-x', dx: 1e9 }).dx, 10000, 'clamped');
  assert.equal(readPaneMessage({ type: 't-agent-pane', paneId: 'ab1', event: 'scroll-x', dx: -1e9 }).dx, -10000);
  assert.deepEqual(readPaneMessage({ type: 't-agent-pane', paneId: 'ab1', event: 'step', step: 1 }), { paneId: 'ab1', event: 'step', step: 1 });
  assert.deepEqual(readPaneMessage({ type: 't-agent-pane', paneId: 'ab1', event: 'step', step: -1 }), { paneId: 'ab1', event: 'step', step: -1 });
});

test('sideways wheel: a horizontal swipe or Shift+wheel, never a vertical scroll or a pinch', async () => {
  const { sidewaysDelta } = await load();
  assert.equal(sidewaysDelta({ deltaX: 30, deltaY: 4 }), 30);
  assert.equal(sidewaysDelta({ deltaX: -12, deltaY: 0 }), -12);
  assert.equal(sidewaysDelta({ deltaX: 4, deltaY: 30 }), 0, 'mostly vertical');
  assert.equal(sidewaysDelta({ deltaX: 0, deltaY: 100 }), 0);
  assert.equal(sidewaysDelta({ deltaX: 10, deltaY: 10 }), 0, 'a tie is vertical');
  assert.equal(sidewaysDelta({ deltaY: 100, shiftKey: true }), 100, 'Shift+wheel where the system does not turn it into deltaX');
  assert.equal(sidewaysDelta({ deltaX: 100, shiftKey: true }), 100);
  assert.equal(sidewaysDelta({ deltaX: 3, deltaMode: 1 }), 120, 'lines are 40px');
  assert.equal(sidewaysDelta({ deltaX: 1, deltaMode: 2 }, 900), 900, 'pages are the page width');
  assert.equal(sidewaysDelta({ deltaX: 30, ctrlKey: true }), 0, 'a pinch');
  assert.equal(sidewaysDelta({ deltaX: 30, metaKey: true }), 0);
  assert.equal(sidewaysDelta({}), 0);
  assert.equal(sidewaysDelta(), 0);
});

test('column keys: Ctrl+Alt+Left / Right and where they move the focus', async () => {
  const { columnStep, stepTarget } = await load();
  assert.equal(columnStep({ key: 'ArrowRight', ctrlKey: true, altKey: true }), 1);
  assert.equal(columnStep({ key: 'ArrowLeft', ctrlKey: true, altKey: true }), -1);
  for (const other of [{ key: 'ArrowRight', ctrlKey: true }, { key: 'ArrowRight', altKey: true }, { key: 'ArrowRight', ctrlKey: true, altKey: true, metaKey: true },
    { key: 'ArrowRight', ctrlKey: true, altKey: true, shiftKey: true }, { key: 'ArrowUp', ctrlKey: true, altKey: true }, { key: 'l', ctrlKey: true, altKey: true }, {}]) {
    assert.equal(columnStep(other), 0, JSON.stringify(other));
  }
  const ids = ['a', 'b', 'c'];
  assert.equal(stepTarget(ids, 'a', 1), 'b');
  assert.equal(stepTarget(ids, 'b', -1), 'a');
  assert.equal(stepTarget(ids, 'c', 1), 'c', 'stops at the last');
  assert.equal(stepTarget(ids, 'a', -1), 'a', 'stops at the first');
  assert.equal(stepTarget(ids, null, 1), 'a', 'no focus: right is the first');
  assert.equal(stepTarget(ids, 'gone', -1), 'c', 'no focus: left is the last');
  assert.equal(stepTarget([], null, 1), null);
  assert.equal(stepTarget(ids, 'a', 0), null);
});

test('reveal and edges: the scroll that shows a column whole, and which sides hide columns', async () => {
  const { revealLeft, hiddenEdges } = await load();
  assert.equal(revealLeft({ left: 0, width: 600, scrollLeft: 0, clientWidth: 1440 }), null, 'already whole');
  assert.equal(revealLeft({ left: 1272, width: 636, scrollLeft: 0, clientWidth: 1440 }), 468, 'hidden on the right: its right edge at the view edge');
  assert.equal(revealLeft({ left: 636, width: 636, scrollLeft: 900, clientWidth: 1440 }), 636, 'hidden on the left: its start');
  assert.equal(revealLeft({ left: 636, width: 2000, scrollLeft: 0, clientWidth: 1440 }), 636, 'wider than the view: its start');
  assert.equal(revealLeft({ left: 636, width: 636, scrollLeft: 637, clientWidth: 1440 }), null, '1px of rounding is whole');
  assert.deepEqual(hiddenEdges({ scrollLeft: 0, scrollWidth: 1440, clientWidth: 1440 }), { left: false, right: false });
  assert.deepEqual(hiddenEdges({ scrollLeft: 0, scrollWidth: 3180, clientWidth: 1440 }), { left: false, right: true });
  assert.deepEqual(hiddenEdges({ scrollLeft: 700, scrollWidth: 3180, clientWidth: 1440 }), { left: true, right: true });
  assert.deepEqual(hiddenEdges({ scrollLeft: 1740, scrollWidth: 3180, clientWidth: 1440 }), { left: true, right: false });
  assert.deepEqual(hiddenEdges({ scrollLeft: 1739.5, scrollWidth: 3180, clientWidth: 1440 }), { left: true, right: false }, 'rounding');
});
