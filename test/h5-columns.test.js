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

test('a column is at least a quarter of the strip and never narrower than 340px', async () => {
  const { minColumnWidth, MIN_COLUMN_WIDTH, VISIBLE_COLUMNS, NAV_WIDTH, stripWidthOf } = await load();
  assert.equal(MIN_COLUMN_WIDTH, 340);
  assert.equal(VISIBLE_COLUMNS, 4);
  assert.equal(NAV_WIDTH, 72);
  assert.equal(stripWidthOf(1440), 1368, 'the window less the navigation rail');
  assert.equal(stripWidthOf(undefined), 0);
  assert.equal(minColumnWidth(1368), 342, 'a 1440px window: four columns of 342px fit beside the rail');
  assert.equal(minColumnWidth(1848), 462, 'a 1920px window');
  assert.equal(minColumnWidth(2488), 622);
  assert.equal(minColumnWidth(1369), 342, 'rounded down, so four still fit');
  assert.equal(minColumnWidth(928), 340, 'a narrow window (1000px): never below 340 (fewer fit and the strip scrolls)');
  assert.equal(minColumnWidth(828), 340);
  for (const bad of [0, -3, NaN, Infinity, undefined, null, 'x']) assert.equal(minColumnWidth(bad), 340, String(bad));
});

test('up to four columns share the visible width; more are a quarter each and scroll', async () => {
  const { columnWidth } = await load();
  assert.equal(columnWidth(1368, 1), 1368);
  assert.equal(columnWidth(1368, 2), 684);
  assert.equal(columnWidth(1368, 4), 342, 'four fit at 1440 beside the rail');
  assert.equal(columnWidth(1368, 5), 342, 'a fifth makes the strip scroll; each stays a quarter');
  assert.equal(columnWidth(1848, 3), 616);
  assert.equal(columnWidth(1848, 4), 462);
  assert.equal(columnWidth(1848, 12), 462);
  assert.equal(columnWidth(928, 2), 464);
  assert.equal(columnWidth(928, 3), 340, 'three do not fit at 1000: 340 each');
  assert.equal(columnWidth(928, 0), 928, 'no count counts as one');
  assert.equal(columnWidth(0, 3), 340, 'no usable width: the floor');
});

test('the first use opens floor(strip width / 340) columns, 2 to 4', async () => {
  const { defaultCount, columnsFor, stripWidthOf } = await load();
  assert.equal(defaultCount(stripWidthOf(1440)), 4, 'four on a 1440px screen');
  assert.equal(defaultCount(stripWidthOf(1920)), 4);
  assert.equal(defaultCount(stripWidthOf(3840)), 4, 'never more than 4');
  assert.equal(defaultCount(stripWidthOf(1431)), 3);
  assert.equal(defaultCount(stripWidthOf(1092)), 3);
  assert.equal(defaultCount(stripWidthOf(1091)), 2);
  assert.equal(defaultCount(stripWidthOf(1000)), 2);
  assert.equal(defaultCount(stripWidthOf(900)), 2);
  assert.equal(defaultCount(500), 2, 'at least 2 (the second one scrolls)');
  assert.equal(defaultCount(undefined), 2);
  assert.equal(columnsFor([], 1368).length, 4);
  assert.equal(columnsFor([], 928).length, 2);
  assert.deepEqual(columnsFor(['a', 'b'], 1848), ['a', 'b'], 'stored columns are kept as they are');
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
  assert.deepEqual(readLayout(null), { on: false, ids: [], tab: 'columns' });
  assert.deepEqual(readLayout('not json'), { on: false, ids: [], tab: 'columns' });
  assert.deepEqual(readLayout('{"on":"yes","ids":"a"}'), { on: false, ids: [], tab: 'columns' });
  assert.deepEqual(readLayout(JSON.stringify({ on: true, ids: ['a', 'a', 'B', 'c', 7, 'd'] })), { on: true, ids: ['a', 'c', 'd'], tab: 'columns' }, 'a layout from before the rail opens on the columns');
  assert.equal(MAX_COLUMNS, 12);
  const many = Array.from({ length: 15 }, (_, i) => `c${i}`);
  assert.deepEqual(readLayout(JSON.stringify({ on: true, ids: many })).ids, many.slice(0, 12), 'the first twelve are kept');
  assert.deepEqual(readLayout(writeLayout({ on: true, ids: many })).ids, many.slice(0, 12), 'and only twelve are written');
  const layout = { on: true, ids: ['x1', 'y2'], tab: 'columns' };
  assert.deepEqual(readLayout(writeLayout(layout)), layout);
});

test('the tab of the navigation rail is remembered with the layout: columns or mind maps, nothing else', async () => {
  const { readLayout, writeLayout, readTab, TABS, STORAGE_KEY } = await load();
  assert.equal(STORAGE_KEY, 'h5-columns');
  assert.deepEqual(TABS, ['columns', 'maps']);
  const maps = { on: true, ids: ['x1'], tab: 'maps' };
  assert.equal(writeLayout(maps), '{"on":true,"ids":["x1"],"tab":"maps"}');
  assert.deepEqual(readLayout(writeLayout(maps)), maps, 'the Mind maps tab comes back after a reload');
  assert.equal(readLayout(writeLayout({ on: false, ids: [], tab: 'maps' })).tab, 'maps', 'kept while the view is off, for the next time');
  for (const bad of [undefined, null, '', 'map', 'Maps', 'settings', 3, {}]) {
    assert.equal(readTab(bad), 'columns', String(bad));
    assert.equal(readLayout(JSON.stringify({ on: true, ids: ['a'], tab: bad })).tab, 'columns', `stored ${String(bad)}`);
  }
  assert.equal(JSON.parse(writeLayout({ on: true, ids: ['a'], tab: 'evil' })).tab, 'columns', 'only a known tab is written');
});

test('mind map columns of v2.133 / v2.134 are dropped on load; the other columns keep their order', async () => {
  const { dropMapColumns, legacyMapKeyOf, LEGACY_MAP_KEY, readLayout } = await load();
  assert.equal(LEGACY_MAP_KEY, 'h5-mindmap');
  assert.equal(legacyMapKeyOf('k3x9'), 'pane:k3x9:h5-mindmap', 'the key such a pane wrote (pane:<id>: + h5-mindmap)');
  // A stored state as v2.134.0 left it: two terminal columns and two map columns (one on the list, one with a map open).
  const storage = new Map([
    ['h5-columns', JSON.stringify({ on: true, ids: ['aaa111', 'mapl01', 'bbb222', 'mape02'] })],
    ['pane:mapl01:h5-mindmap', '{"screen":"list"}'],
    ['pane:mape02:h5-mindmap', '{"screen":"editor","sourceKey":"local","id":"m1"}'],
    ['pane:aaa111:h5-task:local', '1'],
  ]);
  const layout = readLayout(storage.get('h5-columns'));
  const result = dropMapColumns(layout.ids, id => storage.has(legacyMapKeyOf(id)));
  assert.deepEqual(result, { ids: ['aaa111', 'bbb222'], dropped: ['mapl01', 'mape02'] });
  assert.equal(layout.tab, 'columns');
  const none = ['a', 'b'];
  assert.equal(dropMapColumns(none, () => false).ids, none, 'nothing dropped: the same order, unchanged');
  assert.deepEqual(dropMapColumns(['m1'], () => true), { ids: [], dropped: ['m1'] }, 'only map columns: none left (the view opens its default columns)');
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

test('reorder: a column moved to a place or one step, and the stored order', async () => {
  const { moveColumn, shiftColumn, readLayout, writeLayout } = await load();
  const ids = ['a', 'b', 'c', 'd'];
  assert.deepEqual(moveColumn(ids, 'a', 2), ['b', 'c', 'a', 'd']);
  assert.deepEqual(moveColumn(ids, 'd', 0), ['d', 'a', 'b', 'c']);
  assert.deepEqual(moveColumn(ids, 'b', 99), ['a', 'c', 'd', 'b'], 'clamped to the end');
  assert.deepEqual(moveColumn(ids, 'c', -5), ['c', 'a', 'b', 'd'], 'clamped to the start');
  assert.equal(moveColumn(ids, 'b', 1), ids, 'the same place: the same array');
  assert.equal(moveColumn(ids, 'x', 0), ids, 'an unknown id');
  assert.deepEqual(ids, ['a', 'b', 'c', 'd'], 'the input is not changed');
  assert.deepEqual(shiftColumn(ids, 'b', 1), ['a', 'c', 'b', 'd']);
  assert.deepEqual(shiftColumn(ids, 'b', -1), ['b', 'a', 'c', 'd']);
  assert.equal(shiftColumn(ids, 'a', -1), ids, 'the first stays');
  assert.equal(shiftColumn(ids, 'd', 1), ids, 'the last stays');
  assert.equal(shiftColumn(ids, 'b', 2), ids, 'one step only');
  assert.equal(shiftColumn(ids, 'x', 1), ids);
  // The order is what is stored, and it comes back as it was.
  const moved = moveColumn(ids, 'a', 3);
  assert.deepEqual(readLayout(writeLayout({ on: true, ids: moved })), { on: true, ids: ['b', 'c', 'd', 'a'], tab: 'columns' });
});

test('the DOM order of the columns never follows a reorder: kept ids in their old order, new ones at the end', async () => {
  const { mountOrder } = await load();
  assert.deepEqual(mountOrder([], ['a', 'b', 'c']), ['a', 'b', 'c'], 'a fresh page creates them in the stored order');
  assert.deepEqual(mountOrder(['a', 'b', 'c'], ['c', 'a', 'b']), ['a', 'b', 'c'], 'a reorder moves nothing');
  assert.deepEqual(mountOrder(['a', 'b', 'c'], ['c', 'a']), ['a', 'c'], 'a closed column goes, the others keep their order');
  assert.deepEqual(mountOrder(['a', 'b'], ['b', 'a', 'n']), ['a', 'b', 'n'], 'a new one at the end');
  assert.deepEqual(mountOrder(null, ['x']), ['x']);
});

test('pane messages: the device of a tab, and column moves', async () => {
  const { readPaneMessage, readDevice, deviceOfRow, tagOf } = await load();
  assert.deepEqual(readPaneMessage({ type: 't-agent-pane', paneId: 'ab1', event: 'title', title: 'Fix', session: 'T1', device: { name: ' K01 ', instanceId: 'i-1', local: false, extra: 1 } }),
    { paneId: 'ab1', event: 'title', title: 'Fix', session: 'T1', device: { name: 'K01', instanceId: 'i-1', local: false, offline: false } });
  assert.deepEqual(readPaneMessage({ type: 't-agent-pane', paneId: 'ab1', event: 'title', title: 'Fix', device: { local: true } }).device,
    { name: '', instanceId: '', local: true, offline: false }, 'this machine of an older server has no name');
  for (const bad of [null, 'K01', {}, { name: '' }, { name: 42 }, { local: 'yes' }]) assert.equal(readDevice(bad), null, JSON.stringify(bad));
  assert.equal('device' in readPaneMessage({ type: 't-agent-pane', paneId: 'ab1', event: 'title', title: 'Fix', device: { name: '' } }), false, 'no usable device: none');
  assert.equal(readDevice({ name: 'x'.repeat(200) }).name.length, 80);
  assert.equal(readDevice({ name: 'Off', offline: true }).offline, true);
  // From a tagged task row of the pane's list (h5.js deviceTag): this machine is named by `name`, a remote device by `label`.
  assert.deepEqual(deviceOfRow({ device: { key: 'local', local: true, label: 'This machine', name: 'MacBook', instanceId: 'm1', offline: false } }), { name: 'MacBook', instanceId: 'm1', local: true, offline: false });
  assert.deepEqual(deviceOfRow({ device: { key: 'remote:7', local: false, label: 'VPS', name: '', instanceId: 'v1', offline: true } }), { name: 'VPS', instanceId: 'v1', local: false, offline: true });
  assert.equal(deviceOfRow({ device: null }), null);
  assert.equal(deviceOfRow(null), null);
  // Back into the shape DeviceTag draws.
  assert.deepEqual(tagOf({ name: 'MacBook', instanceId: 'm1', local: true, offline: false }), { key: 'local', local: true, name: 'MacBook', label: 'MacBook', instanceId: 'm1', offline: false });
  assert.deepEqual(tagOf({ name: 'VPS', instanceId: 'v1', local: false, offline: true }), { key: 'remote', local: false, name: '', label: 'VPS', instanceId: 'v1', offline: true });
  assert.equal(tagOf(null), null);
  assert.deepEqual(readPaneMessage({ type: 't-agent-pane', paneId: 'ab1', event: 'move', step: 1 }), { paneId: 'ab1', event: 'move', step: 1 });
  assert.deepEqual(readPaneMessage({ type: 't-agent-pane', paneId: 'ab1', event: 'move', step: -1 }), { paneId: 'ab1', event: 'move', step: -1 });
  for (const step of [undefined, 0, 2, '1']) assert.equal(readPaneMessage({ type: 't-agent-pane', paneId: 'ab1', event: 'move', step }), null, String(step));
});

test('column move keys: Ctrl+Alt+Shift+Left / Right, never the step keys', async () => {
  const { columnMove, columnStep } = await load();
  assert.equal(columnMove({ key: 'ArrowRight', ctrlKey: true, altKey: true, shiftKey: true }), 1);
  assert.equal(columnMove({ key: 'ArrowLeft', ctrlKey: true, altKey: true, shiftKey: true }), -1);
  for (const other of [{ key: 'ArrowRight', ctrlKey: true, altKey: true }, { key: 'ArrowRight', ctrlKey: true, shiftKey: true }, { key: 'ArrowRight', altKey: true, shiftKey: true },
    { key: 'ArrowRight', ctrlKey: true, altKey: true, shiftKey: true, metaKey: true }, { key: 'ArrowUp', ctrlKey: true, altKey: true, shiftKey: true }, {}]) {
    assert.equal(columnMove(other), 0, JSON.stringify(other));
  }
  assert.equal(columnStep({ key: 'ArrowRight', ctrlKey: true, altKey: true, shiftKey: true }), 0, 'a move is never a step');
});

// ── Mind map columns and the maximized column with its rail ──

test('pane messages carry the terminal shown, its agent, and peek lines; a map is no longer read', async () => {
  const { readPaneMessage, PEEK_LINES } = await load();
  const base = { type: 't-agent-pane', paneId: 'abc' };
  const title = readPaneMessage({ ...base, event: 'title', title: 'Fix', session: 'S', map: { title: ' Plan ', screen: 'editor' }, target: { sourceKey: 'local', taskId: 3, terminalId: 'default' }, agent: 'codex' });
  assert.equal(title.map, undefined, 'an old pane that still says what map it shows: ignored');
  assert.deepEqual(title.target, { sourceKey: 'local', taskId: 3, terminalId: 'default' });
  assert.equal(title.agent, 'codex');
  const odd = readPaneMessage({ ...base, event: 'title', map: { screen: 'nope' }, target: { sourceKey: 'x', taskId: 1, terminalId: 'a' }, agent: 'bash' });
  assert.equal(odd.map, undefined);
  assert.equal(odd.target, undefined);
  assert.equal(odd.agent, undefined);
  assert.equal(readPaneMessage({ ...base, event: 'title', target: { sourceKey: 'local', taskId: -1, terminalId: 'a' } }).target, undefined);
  assert.deepEqual(readPaneMessage({ ...base, event: 'maximize' }), { paneId: 'abc', event: 'maximize' });
  assert.deepEqual(readPaneMessage({ ...base, event: 'mindmaps' }), { paneId: 'abc', event: 'mindmaps' }, 'the pane asks for the Mind maps tab');
  assert.equal(readPaneMessage({ ...base, event: 'maximized' }), null, 'the top page no longer hears a map column\'s state');
  const peek = readPaneMessage({ ...base, event: 'peek', lines: ['a', 5, 'b  ', ...Array.from({ length: 10 }, (_, n) => `l${n}`), 'x'.repeat(500)] });
  assert.equal(peek.lines.length, PEEK_LINES);
  assert.equal(peek.lines.at(-1).length, 200, 'each line cut to 200 characters');
  assert.deepEqual(readPaneMessage({ ...base, event: 'peek', lines: 'no' }).lines, []);
});

test('any open column of the shown strip can be maximized; one at a time', async () => {
  const { canMaximize, keptMaximized, toggleMaximize, railColumns, RAIL_WIDTH } = await load();
  assert.equal(RAIL_WIDTH, 72);
  const columns = { shown: true, ids: ['a', 'b', 'c'], closing: [], titles: { a: { title: 'T' }, b: { title: 'U', session: 'chat' } }, maximized: null };
  assert.equal(canMaximize(columns, 'b'), true);
  assert.equal(canMaximize(columns, 'a'), true, 'a terminal column too');
  assert.equal(canMaximize(columns, 'c'), true, 'a column whose pane said nothing yet');
  assert.equal(canMaximize(columns, 'z'), false);
  assert.equal(canMaximize({ ...columns, shown: false }, 'b'), false, 'not on a narrow screen');
  assert.equal(canMaximize({ ...columns, closing: ['b'] }, 'b'), false);
  assert.deepEqual(toggleMaximize(columns, 'b'), { maximized: 'b' });
  assert.deepEqual(toggleMaximize(columns, 'a'), { maximized: 'a' });
  assert.equal(toggleMaximize(columns, null), null, 'no focused column: nothing to maximize');
  assert.equal(toggleMaximize({ ...columns, shown: false }, 'a'), null);
  const max = { ...columns, maximized: 'b' };
  assert.deepEqual(toggleMaximize(max, 'b'), { maximized: null }, 'the same keys restore');
  assert.deepEqual(toggleMaximize(max, 'a'), { maximized: null });
  assert.equal(keptMaximized(max), 'b');
  assert.equal(keptMaximized({ ...max, titles: { ...max.titles, b: { title: 'T' } } }), 'b', 'it shows another task: it stays maximized');
  assert.equal(keptMaximized({ ...max, ids: ['a', 'c'] }), null, 'it was closed');
  assert.equal(keptMaximized({ ...max, closing: ['b'] }), null, 'it is being closed');
  assert.equal(keptMaximized({ ...max, shown: false }), null, 'the strip went away');
  assert.deepEqual(railColumns(max, 'b'), ['a', 'c'], 'the others, in the order shown');
  assert.deepEqual(railColumns({ ...max, closing: ['c'] }, 'b'), ['a']);
});

test('Cmd/Ctrl+Shift+Enter maximizes or restores; Alt or an IME composition does not', async () => {
  const { maximizeKey } = await load();
  assert.equal(maximizeKey({ key: 'Enter', metaKey: true, shiftKey: true }), true);
  assert.equal(maximizeKey({ key: 'Enter', ctrlKey: true, shiftKey: true }), true);
  assert.equal(maximizeKey({ key: 'Enter', metaKey: true }), false, 'Cmd+Enter is the map\'s Add parent topic');
  assert.equal(maximizeKey({ key: 'Enter', shiftKey: true }), false, 'Shift+Enter is Add topic before');
  assert.equal(maximizeKey({ key: 'Enter', metaKey: true, shiftKey: true, altKey: true }), false);
  assert.equal(maximizeKey({ key: 'Enter', metaKey: true, shiftKey: true, isComposing: true }), false);
  assert.equal(maximizeKey({ key: 'Enter', ctrlKey: true, shiftKey: true, keyCode: 229 }), false);
});

test('the state of a rail tile: running, needs you (with the count and the question), or idle', async () => {
  const { columnStatus, columnName } = await load();
  const info = { title: 'Re-render', target: { sourceKey: 'local', taskId: 4, terminalId: 'default' }, agent: 'codex' };
  assert.deepEqual(columnStatus(info, {}), { state: 'idle', count: 0, question: '' });
  assert.equal(columnStatus(info, { activity: { local: { 4: { default: 'running' } } } }).state, 'running');
  assert.equal(columnStatus(info, { activity: { local: { 4: { default: 'done' } } } }).state, 'waiting', 'finished and not seen yet');
  assert.equal(columnStatus(info, { activity: { local: { 4: { other: 'running' } } } }).state, 'idle', 'another terminal of the task');
  const item = (id, extra) => ({ id, status: 'waiting_user', engine: 'local', context: { tagent: { task_id: 4, terminal_id: 'default' }, pending: { text: `Q${id}` } }, ...extra });
  const items = [item(1, { updated_at: '2026-01-01' }), item(2, { updated_at: '2026-02-01' }), item(3, { status: 'working' }), item(4, { engine: 'remote:2' }),
    { id: 5, status: 'waiting_user', engine: 'local', context: JSON.stringify({ tagent: { task_id: 4, terminal_id: 'default' } }), attention_reason: 'Allow edit?', updated_at: '2025-01-01' }];
  const status = columnStatus(info, { activity: { local: { 4: { default: 'running' } } }, items });
  assert.deepEqual(status, { state: 'waiting', count: 3, question: 'Q2' }, 'needs you wins over running; the newest question');
  assert.deepEqual(columnStatus({ title: 'No terminal' }, { items }), { state: 'idle', count: 0, question: '' }, 'a column with no terminal');
  assert.equal(columnName(info), 'Re-render');
  assert.equal(columnName({ title: '', map: { title: 'Plan', screen: 'editor' } }), '', 'a map is never a column name any more');
  assert.equal(columnName(null), '');
});

test('pane title messages carry whether the task sheet is shown and the terminal width, for the column header', async () => {
  const { readPaneMessage, readWidth } = await load();
  const base = { type: 't-agent-pane', paneId: 'a1', event: 'title', title: 'Fix', session: 'T1' };
  assert.deepEqual(readPaneMessage({ ...base, sheet: true, width: { mode: 'wide', cols: 160 } }), { paneId: 'a1', event: 'title', title: 'Fix', session: 'T1', sheet: true, width: { mode: 'wide', cols: 160 } });
  assert.deepEqual(readPaneMessage({ ...base, sheet: 'yes', width: { mode: 'huge' } }), { paneId: 'a1', event: 'title', title: 'Fix', session: 'T1' }, 'only true and a known mode are kept');
  assert.deepEqual(readWidth({ mode: 'fit', cols: 'x' }), { mode: 'fit', cols: 0 });
  assert.deepEqual(readWidth({ mode: 'wide', cols: 5000 }), { mode: 'wide', cols: 0 });
  assert.equal(readWidth(null), null);
});

test('header actions for a pane: only the agreed events, read back the same way', async () => {
  const { actionMessage, readAction } = await load();
  assert.deepEqual(actionMessage('tasks', { toggle: true }), { type: 't-agent-pane', event: 'tasks', toggle: true });
  assert.deepEqual(actionMessage('tasks'), { type: 't-agent-pane', event: 'tasks' });
  assert.deepEqual(actionMessage('width'), { type: 't-agent-pane', event: 'width' }, 'no mode: switch Fit <-> Wide');
  assert.deepEqual(actionMessage('width', { mode: 'wide', cols: 160 }), { type: 't-agent-pane', event: 'width', mode: 'wide', cols: 160 });
  for (const event of ['rename', 'restart', 'reload']) assert.deepEqual(actionMessage(event), { type: 't-agent-pane', event });
  assert.equal(actionMessage('forget'), null, 'forget and open have their own builders');
  assert.equal(actionMessage('delete'), null);
  assert.deepEqual(readAction(actionMessage('tasks', { toggle: true })), { event: 'tasks', toggle: true });
  assert.deepEqual(readAction(actionMessage('tasks')), { event: 'tasks', toggle: false });
  assert.deepEqual(readAction(actionMessage('width', { mode: 'fit' })), { event: 'width', mode: 'fit' });
  assert.deepEqual(readAction({ type: 't-agent-pane', event: 'width', mode: 'odd', cols: 3 }), { event: 'width' });
  assert.equal(readAction({ type: 'other', event: 'rename' }), null);
  assert.equal(readAction({ type: 't-agent-pane', event: 'open' }), null);
  assert.equal(readAction(null), null);
});

test('the column header names its column and the bar sums up the states', async () => {
  const { headerName, headerLabel, summarize, listState, LIST_WORDS } = await load();
  assert.deepEqual(headerName(null), { title: '', session: '' });
  assert.deepEqual(headerName({ title: 'SELF-TAGENT', session: 'main dev' }), { title: 'SELF-TAGENT', session: 'main dev' });
  assert.deepEqual(headerName({ title: '', session: 'stray' }), { title: '', session: '' }, 'no session without a task');
  assert.deepEqual(headerName({ title: 'x', session: 'y', map: { title: '', screen: 'list' } }), { title: 'x', session: 'y' }, 'no map variant');
  assert.equal(headerLabel({ title: 'SELF-TAGENT', session: 'main dev' }, 'needs you', 'Column 1'), 'SELF-TAGENT, main dev, needs you');
  assert.equal(headerLabel(null, 'idle', 'Column 2'), 'Column 2, idle');
  const states = { a: 'running', b: 'waiting', c: 'idle', d: 'waiting', e: 'running' };
  assert.deepEqual(summarize(['a', 'b', 'c', 'd', 'e'], id => ({ state: states[id] })), { running: 2, waiting: 2, first: 'b' });
  assert.deepEqual(summarize(['d', 'b'], id => ({ state: states[id] })).first, 'd', 'the first in the order shown');
  assert.deepEqual(summarize([], () => ({ state: 'idle' })), { running: 0, waiting: 0, first: null });
  assert.equal(listState({ state: 'waiting' }, true), 'focused');
  assert.equal(LIST_WORDS[listState({ state: 'waiting' }, false)], 'needs you');
});

test('the navigation rail: the arrow keys move between its destinations, the badge counts the columns that need the person', async () => {
  const { railKey, needsCount, summarize } = await load();
  assert.equal(railKey('ArrowDown', 0, 2), 1);
  assert.equal(railKey('ArrowDown', 1, 2), 0, 'wraps');
  assert.equal(railKey('ArrowUp', 0, 2), 1, 'wraps the other way');
  assert.equal(railKey('ArrowRight', 0, 2), 1);
  assert.equal(railKey('ArrowLeft', 1, 2), 0);
  assert.equal(railKey('Home', 1, 2), 0);
  assert.equal(railKey('End', 0, 2), 1);
  for (const key of ['Enter', ' ', 'Tab', 'Escape', 'a']) assert.equal(railKey(key, 0, 2), -1, `${key} is not a move (Enter and Space open, Tab leaves)`);
  assert.equal(railKey('ArrowDown', 0, 0), -1);
  const states = { a: 'running', b: 'waiting', c: 'idle', d: 'waiting' };
  const statusOf = id => ({ state: states[id] });
  assert.equal(needsCount(['a', 'b', 'c', 'd'], statusOf), 2);
  assert.equal(needsCount(['a', 'b', 'c', 'd'], statusOf), summarize(['a', 'b', 'c', 'd'], statusOf).waiting, 'the same count as the "N need you" chip');
  assert.equal(needsCount(['a', 'c'], statusOf), 0);
});
