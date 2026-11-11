// The rules of the shared task order and of the device tag (scripts/h5-shell/task-order.mjs).
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../scripts/h5-shell/task-order.mjs');
const rows = keys => keys.map(key => ({ key, name: key || 'old' }));
const keysOf = list => list.map(row => row.key);

test('without an order the list keeps today\'s order', async () => {
  const { arrangeTasks } = await load();
  assert.deepEqual(keysOf(arrangeTasks(rows(['a:1', 'a:2', 'b:1']), null)), ['a:1', 'a:2', 'b:1']);
});

test('the order places the tasks; new ones come first, in today\'s order; tasks without a key go last', async () => {
  const { arrangeTasks } = await load();
  const list = rows(['a:1', 'a:2', 'a:3', null, 'b:1', 'b:2']);
  const arranged = arrangeTasks(list, ['b:2', 'gone:9', 'a:1', 'b:1', 'a:1']);
  assert.deepEqual(keysOf(arranged.slice(0, 2)), ['a:2', 'a:3'], 'new first, this machine first');
  assert.deepEqual(keysOf(arranged.slice(2, 5)), ['b:2', 'a:1', 'b:1'], 'then the order (a duplicate keeps its first place)');
  assert.equal(arranged[5].key, null, 'an older Engine at the end');
  assert.equal(arranged.length, list.length, 'nothing lost, nothing added');
});

test('moveKey puts a key before or after another, and says when nothing changes', async () => {
  const { moveKey } = await load();
  assert.deepEqual(moveKey(['a', 'b', 'c', 'd'], 'd', 'b'), ['a', 'd', 'b', 'c']);
  assert.deepEqual(moveKey(['a', 'b', 'c', 'd'], 'a', 'c', true), ['b', 'c', 'a', 'd']);
  assert.equal(moveKey(['a', 'b', 'c'], 'b', 'c'), null, 'before its next one: the same place');
  assert.equal(moveKey(['a', 'b', 'c'], 'b', 'a', true), null, 'after its previous one: the same place');
  assert.equal(moveKey(['a', 'b'], 'a', 'a'), null);
  assert.equal(moveKey(['a', 'b'], 'x', 'a'), null, 'an unknown key');
});

test('stepTarget: top, up, down, bottom and the ends', async () => {
  const { moveKey, stepTarget } = await load();
  const list = ['a', 'b', 'c', 'd'];
  const step = (key, how) => { const to = stepTarget(list, key, how); return to && moveKey(list, key, to.target, to.after); };
  assert.deepEqual(step('c', 'top'), ['c', 'a', 'b', 'd']);
  assert.deepEqual(step('c', 'up'), ['a', 'c', 'b', 'd']);
  assert.deepEqual(step('b', 'down'), ['a', 'c', 'b', 'd']);
  assert.deepEqual(step('b', 'bottom'), ['a', 'c', 'd', 'b']);
  assert.equal(stepTarget(list, 'a', 'top'), null);
  assert.equal(stepTarget(list, 'a', 'up'), null);
  assert.equal(stepTarget(list, 'd', 'down'), null);
  assert.equal(stepTarget(list, 'd', 'bottom'), null);
  assert.equal(stepTarget(['a'], 'a', 'down'), null, 'one task cannot move');
});

test('mergeOrder keeps the keys that are not shown in their places', async () => {
  const { mergeOrder } = await load();
  // h: hidden device, o: offline device not shown. Shown: a1 a2 b1 (in that order), plus the new one n1 shown first.
  const order = ['a:1', 'h:1', 'a:2', 'o:5', 'b:1', 'h:2'];
  const display = ['n:1', 'a:1', 'a:2', 'b:1'];
  const next = ['a:1', 'a:2', 'b:1', 'n:1']; // the new one moved to the bottom
  assert.deepEqual(mergeOrder(order, display, next), ['a:1', 'a:2', 'h:1', 'b:1', 'o:5', 'n:1', 'h:2']);
  // Moving b1 to the top keeps h1, o5 and h2 at their indexes.
  const merged = mergeOrder(order, ['a:1', 'a:2', 'b:1'], ['b:1', 'a:1', 'a:2']);
  assert.deepEqual(merged, ['b:1', 'h:1', 'a:1', 'o:5', 'a:2', 'h:2']);
  assert.equal(new Set(merged).size, merged.length, 'no duplicates');
  assert.deepEqual(mergeOrder(null, ['a', 'b'], ['b', 'a']), ['b', 'a'], 'no order yet');
});

test('the tag colour comes from the instance id: the same on every client, readable on the dark paper', async () => {
  const { tagColor, tagColorIndex, TAG_COLORS, TAG_TINT, TAG_TINT_OPEN, TAG_NEUTRAL } = await load();
  assert.equal(tagColorIndex('7f3c2a10-0000-4000-8000-000000000001'), tagColorIndex('7f3c2a10-0000-4000-8000-000000000001'));
  assert.equal(tagColorIndex(null), -1, 'no id: neutral');
  assert.equal(tagColor('').index, -1);
  const spread = new Set(Array.from({ length: 64 }, (_, index) => tagColorIndex(`device-${index}`)));
  assert.equal(spread.size, TAG_COLORS.length, 'every colour is used');
  // WCAG contrast of each colour on its own tint over the paper.
  const channel = value => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  const rgb = hex => [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16));
  const paper = [18, 18, 18];
  // The tag of an open task (a stronger tint) stays readable too.
  for (const [tint, color] of [...TAG_COLORS.flatMap(color => [[TAG_TINT, color], [TAG_TINT_OPEN, color]]), [0.08, TAG_NEUTRAL], [0.2, TAG_NEUTRAL]]) {
    for (const ground of [paper]) {
      const fg = rgb(color);
      const bg = fg.map((value, index) => value * tint + ground[index] * (1 - tint));
      const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
      assert.ok((hi + 0.05) / (lo + 0.05) >= 4.5, `${color} at ${tint} on ${ground}: ${((hi + 0.05) / (lo + 0.05)).toFixed(2)}:1`);
    }
  }
  assert.match(tagColor('device-1').open, new RegExp(`, ${TAG_TINT_OPEN}\\)$`), 'the open tint');
  assert.equal(tagColor(null).open, 'rgba(224, 224, 224, 0.2)', 'the neutral open tint');
});

test('shortName cuts at 8 characters with an ellipsis, by code point', async () => {
  const { shortName } = await load();
  assert.equal(shortName('VPS'), 'VPS');
  assert.equal(shortName('MacBook1'), 'MacBook1');
  assert.equal(shortName('TORINMACKUAISHOU.local'), 'TORINMA\u2026');
  assert.equal(shortName('\u4E1C\u4EAC\u7684\u670D\u52A1\u5668\u4E00\u53F7\u673A'), '\u4E1C\u4EAC\u7684\u670D\u52A1\u5668\u4E00\u2026');
  assert.equal(shortName('\u{1F680}'.repeat(9)), `${'\u{1F680}'.repeat(7)}\u2026`);
});
