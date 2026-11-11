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

test('the default number of columns is floor(width / 420), 2 to 4', async () => {
  const { defaultCount } = await load();
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
  const many = Array.from({ length: 9 }, (_, i) => `c${i}`);
  assert.equal(readLayout(JSON.stringify({ on: true, ids: many })).ids.length, MAX_COLUMNS);
  const layout = { on: true, ids: ['x1', 'y2'] };
  assert.deepEqual(readLayout(writeLayout(layout)), layout);
});

test('columns: first use makes the default count, at most 6, the last one stays', async () => {
  const { columnsFor, addColumn, closeColumn, canAdd, canClose, MAX_COLUMNS } = await load();
  assert.equal(columnsFor([], 1440).length, 3);
  assert.equal(columnsFor([], 2000).length, 4);
  assert.deepEqual(columnsFor(['a', 'b'], 2000), ['a', 'b'], 'stored ids come back as they were');
  let ids = ['a'];
  while (canAdd(ids)) ids = addColumn(ids);
  assert.equal(ids.length, MAX_COLUMNS);
  assert.equal(addColumn(ids), ids, 'no seventh column');
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
    { type: 't-agent-pane', paneId: 'ab1', event: 'forget' }, { type: 't-agent-pane', paneId: 'ab1', event: 'eval' }]) {
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
