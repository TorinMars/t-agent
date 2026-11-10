// Pure logic of the mind map view: the .xmind converter, the document rules, autosave, keys and arrow navigation.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseHTML } = require('linkedom');
const { zipSync, unzipSync, strToU8, strFromU8 } = require('fflate');

const modules = (async () => ({
  xmind: await import('../scripts/mindmap/xmind.mjs'),
  doc: await import('../scripts/mindmap/doc.mjs'),
  saver: await import('../scripts/mindmap/saver.mjs'),
  keys: await import('../scripts/mindmap/keys.mjs'),
  nav: await import('../scripts/mindmap/nav.mjs'),
}))();

const CHILD = 'Child \u4e2d\u6587';
const sheet = () => [{
  id: 's1', class: 'sheet', title: 'Sheet', rootTopic: {
    id: 'r', class: 'topic', title: 'Root', structureClass: 'org.xmind.ui.logic.right',
    children: {
      attached: [
        { id: 'a', title: CHILD, notes: { plain: { content: 'A note' } }, labels: ['label one'], href: 'https://example.com/x', markers: [{ markerId: 'priority-1' }, { markerId: 'unknown-marker' }], branch: 'folded', children: { attached: [{ id: 'a1', title: 'Grandchild' }] } },
        { id: 'b', title: 'Bad link', href: 'javascript:alert(1)', image: { src: 'xap:resources/x.png' } },
      ],
      detached: [{ id: 'f', title: 'Floating' }],
    },
    boundaries: [{ id: 'bd', range: '(0,1)' }],
    summaries: [{ id: 'sm', range: '(0,1)', topicId: 'smt' }],
  },
  relationships: [{ id: 'rel', end1Id: 'a', end2Id: 'b', title: '<img src=x onerror=alert(1)>' }, { id: 'rel2', end1Id: 'a', end2Id: 'missing' }],
}, { id: 's2', class: 'sheet', rootTopic: { id: 'r2', title: 'Second sheet' } }];
sheet.withSummaryTopic = () => { const s = sheet(); s[0].rootTopic.children.summary = [{ id: 'smt', title: 'A summary' }]; return s; };
const zipOf = (content, extra = {}) => zipSync({ 'content.json': strToU8(typeof content === 'string' ? content : JSON.stringify(content)), 'metadata.json': strToU8('{}'), 'manifest.json': strToU8('{}'), ...extra });

test('a real .xmind zip becomes a document, and says what was lost', async () => {
  const { xmind, doc } = await modules;
  const { doc: map, lost } = xmind.parseXmind(zipOf(sheet.withSummaryTopic()));
  assert.equal(map.nodeData.topic, 'Root');
  assert.equal(map.direction, doc.DIRECTION.RIGHT);
  const [a, b] = map.nodeData.children;
  assert.equal(a.topic, CHILD);
  assert.equal(a.note, 'A note');
  assert.deepEqual(a.tags, ['label one']);
  assert.equal(a.hyperLink, 'https://example.com/x');
  assert.deepEqual(a.markers, ['priority-1', 'unknown-marker']);
  assert.equal(a.icons.length, 1, 'a marker with no symbol is kept only as an id');
  assert.equal(a.expanded, false);
  assert.equal(a.children[0].topic, 'Grandchild');
  assert.equal(b.hyperLink, undefined, 'javascript: is dropped');
  assert.equal(map.arrows.length, 1, 'a relationship to a missing topic is dropped');
  assert.equal(map.arrows[0].label, '<img src=x onerror=alert(1)>', 'kept as text; the editor draws it escaped');
  assert.deepEqual(map.summaries.map(({ start, end, label }) => [start, end, label]), [[0, 1, 'A summary']]);
  assert.deepEqual(lost, { sheets: 1, images: 1, boundaries: 1, callouts: 0, floating: 1, links: 1 });
  assert.equal(xmind.describeLost(lost).length, 5);
});

test('round trip: export then import keeps topics, notes, labels, links, markers, folding and layout', async () => {
  const { xmind, doc } = await modules;
  const { doc: first } = xmind.parseXmind(zipOf(sheet.withSummaryTopic()));
  const bytes = xmind.buildXmind({ title: 'Trip', data: first });
  const entries = unzipSync(bytes);
  assert.ok(entries['content.json'] && entries['metadata.json'] && entries['manifest.json'], 'the three entries of the format');
  const content = JSON.parse(strFromU8(entries['content.json']));
  assert.equal(content[0].class, 'sheet');
  assert.equal(content[0].rootTopic.class, 'topic');
  assert.equal(content[0].rootTopic.structureClass, 'org.xmind.ui.logic.right');
  const manifest = JSON.parse(strFromU8(entries['manifest.json']));
  assert.ok(manifest['file-entries']['content.json'] && manifest['file-entries']['metadata.json']);
  const { doc: second, lost } = xmind.parseXmind(bytes);
  const strip = node => ({ ...node, id: undefined, children: node.children.map(strip) });
  assert.deepEqual(strip(second.nodeData), strip(first.nodeData));
  assert.equal(second.direction, doc.DIRECTION.RIGHT);
  assert.equal(second.summaries.length, 1);
  assert.equal(second.arrows.length, 1);
  assert.deepEqual(lost, { sheets: 0, images: 0, boundaries: 0, callouts: 0, floating: 0, links: 0 });
  // A map with both sides exports the mind map structure class, and folded topics survive.
  const side = xmind.buildXmind({ title: 'S', data: { nodeData: { id: 'r', topic: 'R', children: [] }, direction: doc.DIRECTION.SIDE } });
  assert.equal(JSON.parse(strFromU8(unzipSync(side)['content.json']))[0].rootTopic.structureClass, 'org.xmind.ui.map.unbalanced');
});

test('older files with content.xml are read', async () => {
  const { xmind } = await modules;
  const xml = `<?xml version="1.0"?><xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0" xmlns:xlink="http://www.w3.org/1999/xlink" version="2.0"><sheet id="s"><topic id="r" structure-class="org.xmind.ui.map.unbalanced"><title>Old root</title><children><topics type="attached"><topic id="a" xlink:href="https://example.com/"><title>Old child</title><notes><plain>Old note</plain></notes><labels><label>L</label></labels><marker-refs><marker-ref marker-id="star-red"/></marker-refs></topic></topics><topics type="detached"><topic id="f"><title>F</title></topic></topics></children></topic><relationships><relationship end1="a" end2="r"><title>R</title></relationship></relationships></sheet></xmap-content>`;
  const bytes = zipSync({ 'content.xml': strToU8(xml) });
  const { doc: map, lost } = xmind.parseXmind(bytes, { parseXml: text => new (parseHTML('<!doctype html><html></html>').DOMParser)().parseFromString(text, 'text/xml') });
  assert.equal(map.nodeData.topic, 'Old root');
  const [child] = map.nodeData.children;
  assert.equal(child.topic, 'Old child');
  assert.equal(child.note, 'Old note');
  assert.deepEqual(child.tags, ['L']);
  assert.equal(child.hyperLink, 'https://example.com/');
  assert.deepEqual(child.markers, ['star-red']);
  assert.equal(map.arrows.length, 1);
  assert.equal(lost.floating, 1);
});

test('a file that is not a zip, a damaged one and an empty one are refused with a clear message', async () => {
  const { xmind } = await modules;
  assert.throws(() => xmind.parseXmind(strToU8('not a zip at all')), { message: 'This is not a .xmind file' });
  const zip = zipOf(sheet.withSummaryTopic());
  assert.throws(() => xmind.parseXmind(zip.slice(0, 40)), /damaged/);
  assert.throws(() => xmind.parseXmind(zipSync({ 'other.txt': strToU8('x') })), /no map/);
  assert.throws(() => xmind.parseXmind(zipOf('not json')), /damaged/);
  assert.throws(() => xmind.parseXmind(zipOf([{ rootTopic: null }])), /no map/);
});

test('size limits: an oversized entry is refused, and a lying declared size stays inside its buffer', async () => {
  const { xmind } = await modules;
  const big = new Uint8Array(xmind.XMIND_LIMITS.entry + 1024);
  assert.throws(() => xmind.parseXmind(zipSync({ 'content.json': big })), /too large/);
  // A deflated bomb that declares a small size in the central directory.
  const bytes = zipSync({ 'content.json': new Uint8Array(1024 * 1024).fill(32) });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  for (let i = 0; i + 4 < bytes.length; i += 1) {
    if (view.getUint32(i, true) === 0x02014b50) { view.setUint32(i + 24, 16, true); break; }
  }
  assert.throws(() => xmind.parseXmind(bytes), /damaged|no map/);
});

test('only the named entries are read, and limits on topics and depth hold', async () => {
  const { xmind, doc } = await modules;
  const extra = zipOf(sheet.withSummaryTopic(), { 'attachments/huge.bin': new Uint8Array(xmind.XMIND_LIMITS.entry + 1024) });
  assert.equal(xmind.parseXmind(extra).doc.nodeData.topic, 'Root', 'other entries are not unpacked');
  let deep = { id: 'x', title: 'leaf' };
  for (let i = 0; i < doc.LIMITS.depth + 5; i += 1) deep = { id: `n${i}`, title: 'n', children: { attached: [deep] } };
  assert.throws(() => xmind.parseXmind(zipOf([{ rootTopic: deep }])), /too deeply nested/);
  const wide = { id: 'w', title: 'w', children: { attached: Array.from({ length: doc.LIMITS.topics + 5 }, (_, i) => ({ id: `w${i}`, title: 't' })) } };
  assert.throws(() => xmind.parseXmind(zipOf([{ rootTopic: wide }])), /too many topics/);
});

test('sanitizeDoc drops whatever the editor would draw as HTML or fetch', async () => {
  const { doc } = await modules;
  const clean = doc.sanitizeDoc({
    nodeData: { id: 'a"b', topic: 'x', dangerouslySetInnerHTML: '<img onerror=1>', image: { url: 'http://evil/x.png', width: 1, height: 1 }, style: { color: 'red' }, hyperLink: 'data:text/html,1', tags: [{ text: 'ok', className: 'x', style: { color: 'red' } }, 7], icons: ['<b>'], children: [{ id: 'a"b', topic: 'dup', children: 'nope' }] },
    arrows: [{ id: 'x', from: 'nope', to: 'nope', label: 'a' }], summaries: [{ id: 's', parent: 'a"b', start: 0, end: 1, label: 'l' }], direction: 9,
  });
  const root = clean.nodeData;
  for (const field of ['dangerouslySetInnerHTML', 'image', 'style', 'hyperLink']) assert.equal(root[field], undefined, field);
  assert.deepEqual(root.tags, ['ok']);
  assert.match(root.id, /^[\w-]+$/);
  assert.notEqual(root.children[0].id, root.id, 'a duplicate id is replaced');
  assert.deepEqual(root.children[0].children, []);
  assert.equal(clean.arrows.length, 0);
  assert.equal(clean.summaries[0].parent, root.id, 'a summary follows its parent to the new id');
  assert.equal(clean.direction, doc.DIRECTION.SIDE);
  assert.throws(() => doc.sanitizeDoc({ nodeData: null }), /cannot be read/);
  assert.equal(doc.escapeHtml('<a href="x">&\''), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  assert.equal(doc.safeLink('mailto:a@b.c'), 'mailto:a@b.c');
  assert.equal(doc.safeLink('  JAVASCRIPT:alert(1)'), '');
});

// A controllable clock and a server for the saver.
function harness(saverModule, handlers = {}) {
  const timers = new Map();
  let nextTimer = 1;
  const states = [];
  const sends = [];
  let pending = [];
  const conflicts = [];
  const rejected = [];
  const saver = saverModule.createSaver({
    revision: 1,
    getSnapshot: () => ({ title: 'T', data: { v: handlers.value ? handlers.value() : 1 } }),
    send: (body, options) => { sends.push({ body, options }); return new Promise((resolve, reject) => pending.push({ resolve, reject, body })); },
    verify: handlers.verify || (async () => false),
    onState: state => states.push(state),
    onConflict: info => conflicts.push(info),
    onRejected: code => rejected.push(code),
    writeDraft: handlers.writeDraft || (() => {}),
    clearDraft: handlers.clearDraft || (() => {}),
    setTimer: (fn, ms) => { const id = nextTimer; nextTimer += 1; timers.set(id, { fn, ms }); return id; },
    clearTimer: id => timers.delete(id),
    debounceMs: 1000,
  });
  const flushMicro = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };
  const fire = async () => { const [[id, t]] = [...timers.entries()]; timers.delete(id); t.fn(); await flushMicro(); };
  const answer = async (status, json = {}) => { const p = pending.shift(); p.resolve({ status, json }); await flushMicro(); };
  const fail = async () => { const p = pending.shift(); p.reject(new Error('offline')); await flushMicro(); };
  return { saver, timers, states, sends, conflicts, rejected, fire, answer, fail, flushMicro, get pendingCount() { return pending.length; } };
}

test('autosave debounces, sends one request at a time, and uses the latest revision', async () => {
  const { saver: mod } = await modules;
  const drafts = [];
  const h = harness(mod, { writeDraft: () => drafts.push(1) });
  h.saver.touch();
  h.saver.touch();
  assert.equal(h.sends.length, 0);
  assert.equal(h.timers.size, 1, 'one debounce timer');
  assert.equal([...h.timers.values()][0].ms, 1000);
  await h.fire();
  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0].body.revision, 1);
  assert.equal(h.pendingCount, 1);
  h.saver.touch(); // an edit while the save is running waits for it
  assert.equal([...h.timers.values()].length, 1);
  await h.fire();
  assert.equal(h.sends.length, 1, 'never two at once');
  await h.answer(200, { revision: 2 });
  assert.equal(h.sends.length, 1);
  assert.equal(h.timers.size, 1, 'the second change is scheduled once the first is answered');
  await h.fire();
  assert.equal(h.sends[1].body.revision, 2, 'with the new revision');
  await h.answer(200, { revision: 3 });
  assert.equal(h.states.at(-1), 'saved');
  assert.equal(h.saver.dirty, false);
  assert.ok(drafts.length >= 2, 'a draft is written for each change');
});

test('a failed save retries with a growing delay and keeps the edits through a long outage', async () => {
  const { saver: mod } = await modules;
  const h = harness(mod);
  h.saver.touch();
  await h.fire();
  const delays = [];
  for (let i = 0; i < 6; i += 1) {
    await h.fail();
    assert.equal(h.states.at(-1), 'retrying');
    assert.equal(h.saver.dirty, true);
    const [delay] = [...h.timers.values()];
    delays.push(delay.ms);
    await h.fire();
  }
  assert.deepEqual(delays, [2000, 4000, 8000, 15000, 15000, 15000], 'capped at 15 seconds (never a give-up)');
  // An answer from a server that is coming back (502) counts the same.
  await h.answer(502, {});
  assert.equal(h.states.at(-1), 'retrying');
  h.saver.touch(); // an edit during the outage does not push the retry back
  assert.equal(h.timers.size, 1);
  await h.fire();
  await h.answer(200, { revision: 9 });
  assert.equal(h.states.at(-1), 'saved');
  assert.equal(h.saver.revision, 9);
});

test('409: not overwritten and reported, except a save whose answer was lost', async () => {
  const { saver: mod } = await modules;
  let h = harness(mod);
  h.saver.touch();
  await h.fire();
  await h.answer(409, { error: 'MINDMAP_CONFLICT', current_revision: 7 });
  assert.equal(h.states.at(-1), 'conflict');
  assert.equal(h.conflicts.length, 1);
  assert.equal(h.conflicts[0].currentRevision, 7);
  h.saver.touch();
  assert.equal(h.timers.size, 0, 'nothing is sent after a conflict');
  h = harness(mod, { verify: async () => true });
  h.saver.touch();
  await h.fire();
  await h.answer(409, { error: 'MINDMAP_CONFLICT', current_revision: 8 });
  assert.equal(h.conflicts.length, 0);
  assert.equal(h.states.at(-1), 'saved');
  assert.equal(h.saver.revision, 8, 'continues from the revision the lost save made');
});

test('413, 400 and 404 stop the retries and report it', async () => {
  const { saver: mod } = await modules;
  let h = harness(mod);
  h.saver.touch();
  await h.fire();
  await h.answer(413, { error: 'MINDMAP_TOO_LARGE' });
  assert.deepEqual(h.rejected, ['MINDMAP_TOO_LARGE']);
  assert.equal(h.states.at(-1), 'rejected');
  assert.equal(h.timers.size, 0);
  h = harness(mod);
  h.saver.touch();
  await h.fire();
  await h.answer(404, { error: 'MINDMAP_NOT_FOUND' });
  assert.deepEqual(h.conflicts, [{ gone: true }]);
  assert.equal(h.timers.size, 0);
});

test('flush sends at once with keepalive, waits for a running save, and clears the draft only when clean', async () => {
  const { saver: mod } = await modules;
  let cleared = 0;
  const h = harness(mod, { clearDraft: () => { cleared += 1; } });
  h.saver.touch();
  const round = h.saver.flush({ keepalive: true });
  await h.flushMicro();
  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0].options.keepalive, true);
  h.saver.touch();
  await h.answer(200, { revision: 2 });
  await round;
  assert.equal(h.saver.dirty, true, 'the edit made meanwhile is still to be saved');
  assert.equal(cleared, 0);
  await h.fire();
  await h.answer(200, { revision: 3 });
  assert.equal(cleared, 1);
  assert.equal(h.saver.dirty, false);
});

test('keys follow the XMind table (Cmd on Mac, Ctrl elsewhere)', async () => {
  const { keys: { actionFor } } = await modules;
  const press = (key, mods = {}) => ({ key, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, keyCode: 0, isComposing: false, ...mods });
  const cases = [
    [press('Tab'), 'addChild'], [press('Enter'), 'addSibling'], [press('Enter', { shiftKey: true }), 'addBefore'], [press('F2'), 'edit'], [press(' '), 'edit'],
    [press('Delete'), 'remove'], [press('Backspace'), 'remove'], [press('ArrowLeft'), 'left'], [press('ArrowUp'), 'up'], [press('Escape'), 'back'], [press('F3'), 'label'], [press('F4'), 'note'],
    [press('ArrowUp', { altKey: true }), 'moveUp'], [press('a'), 'type'], [press('\u4e2d'), 'type'],
  ];
  for (const [event, action] of cases) assert.equal(actionFor(event, true), action, `${event.key} on Mac`);
  assert.equal(actionFor(press('Enter', { metaKey: true }), true), 'addParent');
  assert.equal(actionFor(press('Enter', { ctrlKey: true }), false), 'addParent');
  assert.equal(actionFor(press('z', { metaKey: true }), true), 'undo');
  assert.equal(actionFor(press('z', { ctrlKey: true }), false), 'undo');
  assert.equal(actionFor(press('z', { metaKey: true, shiftKey: true }), true), 'redo');
  assert.equal(actionFor(press('y', { ctrlKey: true }), false), 'redo');
  assert.equal(actionFor(press('/', { metaKey: true }), true), 'toggleFold');
  assert.equal(actionFor(press('=', { metaKey: true }), true), 'zoomIn');
  assert.equal(actionFor(press('-', { metaKey: true }), true), 'zoomOut');
  assert.equal(actionFor(press('0', { metaKey: true }), true), 'zoomReset');
  assert.equal(actionFor(press('z', { ctrlKey: true }), true), null, 'Ctrl on a Mac is not ours');
  assert.equal(actionFor(press('z', { metaKey: true }), false), null, 'the Windows key is not ours');
  assert.equal(actionFor(press('c', { metaKey: true }), true), null, 'copy stays a browser action (the copy event carries the topics)');
  assert.equal(actionFor(press('r', { metaKey: true }), true), null, 'reload stays with the browser');
  assert.equal(actionFor(press('a', { isComposing: true }), true), null, 'a key inside an IME composition opens nothing');
  assert.equal(actionFor(press('Process', { keyCode: 229 }), true), null);
});

test('arrow navigation picks the topic that lies that way on the screen', async () => {
  const { nav: { pickDirectional } } = await modules;
  const box = (id, x, y) => ({ id, left: x, right: x + 40, top: y, bottom: y + 20 });
  const rects = [box('root', 200, 200), box('rightUp', 320, 100), box('rightDown', 320, 300), box('rightSame', 400, 205), box('left', 80, 200), box('leftFar', 0, 210)];
  assert.equal(pickDirectional(rects, 'root', 'left'), 'left');
  assert.equal(pickDirectional(rects, 'root', 'right'), 'rightSame', 'the same row wins over a nearer topic off to the side');
  assert.equal(pickDirectional(rects, 'root', 'up'), 'rightUp');
  assert.equal(pickDirectional(rects, 'root', 'down'), 'rightDown');
  assert.equal(pickDirectional(rects, 'rightUp', 'up'), null, 'nothing that way');
  assert.equal(pickDirectional(rects, 'gone', 'up'), null);
});
