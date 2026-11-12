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

test('a column is at least a quarter of the strip and never narrower than 360px', async () => {
  const { minColumnWidth, MIN_COLUMN_WIDTH, VISIBLE_COLUMNS } = await load();
  assert.equal(MIN_COLUMN_WIDTH, 360);
  assert.equal(VISIBLE_COLUMNS, 4);
  assert.equal(minColumnWidth(1440), 360, '1440 / 4');
  assert.equal(minColumnWidth(1920), 480);
  assert.equal(minColumnWidth(2560), 640);
  assert.equal(minColumnWidth(1441), 360, 'rounded down, so four still fit');
  assert.equal(minColumnWidth(1999), 499);
  assert.equal(minColumnWidth(1000), 360, 'a narrow window: never below 360 (fewer fit and the strip scrolls)');
  assert.equal(minColumnWidth(900), 360);
  for (const bad of [0, -3, NaN, Infinity, undefined, null, 'x']) assert.equal(minColumnWidth(bad), 360, String(bad));
});

test('up to four columns share the visible width; more are a quarter each and scroll', async () => {
  const { columnWidth } = await load();
  assert.equal(columnWidth(1440, 1), 1440);
  assert.equal(columnWidth(1440, 2), 720);
  assert.equal(columnWidth(1440, 4), 360, 'four fit at 1440');
  assert.equal(columnWidth(1440, 5), 360, 'a fifth makes the strip scroll; each stays a quarter');
  assert.equal(columnWidth(1920, 3), 640);
  assert.equal(columnWidth(1920, 4), 480);
  assert.equal(columnWidth(1920, 12), 480);
  assert.equal(columnWidth(1000, 2), 500);
  assert.equal(columnWidth(1000, 3), 360, 'three do not fit at 1000: 360 each');
  assert.equal(columnWidth(1000, 0), 1000, 'no count counts as one');
  assert.equal(columnWidth(0, 3), 360, 'no usable width: the floor');
});

test('the first use opens floor(width / 360) columns, 2 to 4', async () => {
  const { defaultCount, columnsFor } = await load();
  assert.equal(defaultCount(1440), 4, 'four on a 1440px screen');
  assert.equal(defaultCount(1920), 4);
  assert.equal(defaultCount(3840), 4, 'never more than 4');
  assert.equal(defaultCount(1439), 3);
  assert.equal(defaultCount(1080), 3);
  assert.equal(defaultCount(1079), 2);
  assert.equal(defaultCount(1000), 2);
  assert.equal(defaultCount(900), 2);
  assert.equal(defaultCount(500), 2, 'at least 2 (the second one scrolls)');
  assert.equal(defaultCount(undefined), 2);
  assert.equal(columnsFor([], 1440).length, 4);
  assert.equal(columnsFor([], 1000).length, 2);
  assert.deepEqual(columnsFor(['a', 'b'], 1920), ['a', 'b'], 'stored columns are kept as they are');
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
  assert.equal(columnsFor([], 1440).length, 4);
  assert.equal(columnsFor([], 1200).length, 3);
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
