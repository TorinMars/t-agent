// The other formats of the mind map view (scripts/mindmap/formats.mjs): Markdown, indented text, HTML lists, OPML, FreeMind, the choice of a reader for a file,
// and the XMind 8 part of an .xmind export.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseHTML } = require('linkedom');
const { zipSync, unzipSync, strToU8, strFromU8 } = require('fflate');

const modules = (async () => ({
  formats: await import('../scripts/mindmap/formats.mjs'),
  xmind: await import('../scripts/mindmap/xmind.mjs'),
  doc: await import('../scripts/mindmap/doc.mjs'),
}))();

const parser = () => new (parseHTML('<!doctype html><html></html>').DOMParser)();
// linkedom stands in for the browser's DOMParser. Two differences are made up for here: in an XML document its getAttribute returns the value escaped again (the
// attribute node has it right), and it does not put an HTML fragment into a body.
const parseXml = text => {
  const dom = parser().parseFromString(text, 'text/xml');
  for (const el of [dom.documentElement, ...dom.documentElement.querySelectorAll('*')]) {
    el.getAttribute = name => { const attr = [...el.attributes].find(a => a.name === name); return attr ? attr.value : null; };
  }
  return dom;
};
const parseHtml = text => parser().parseFromString(/<html[\s>]/i.test(text) ? text : `<!doctype html><html><head></head><body>${text}</body></html>`, 'text/html');
const bytesOf = text => strToU8(text);

const CJK = '\u4e2d\u6587\u4e3b\u9898'; // Chinese topic text
const CJK_NOTE = '\u5907\u6ce8\u7b2c\u4e00\u884c';

// Only what a format can carry, for comparing trees.
const shape = (node, keep = []) => {
  const out = { topic: node.topic };
  for (const key of keep) if (node[key] !== undefined) out[key] = node[key];
  out.children = (node.children || []).map(child => shape(child, keep));
  return out;
};
const shapes = (nodes, keep) => nodes.map(node => shape(node, keep));

const sampleRoot = () => ({
  id: 'r', topic: 'Root', note: 'Root note\nsecond line', children: [
    { id: 'a', topic: CJK, note: `${CJK_NOTE}\n\n- not a bullet\n# not a heading\n\\ starts with a backslash\n> not a quote`, hyperLink: 'https://example.com/a?q=(1)', children: [
      { id: 'a1', topic: 'Grandchild one', children: [{ id: 'a1x', topic: 'Deep', children: [] }] },
      { id: 'a2', topic: 'Done task', markers: ['task-done'], children: [] },
    ] },
    { id: 'b', topic: 'Second [with] brackets', hyperLink: 'https://example.com/b', expanded: false, children: [{ id: 'b1', topic: 'Hidden', children: [] }] },
    { id: 'c', topic: 'Third', children: [] },
  ],
});
const sampleDoc = () => ({ nodeData: sampleRoot(), arrows: [{ id: 'ar', label: 'depends on', from: 'a1', to: 'c', delta1: { x: 1, y: 2 }, delta2: { x: 3, y: 4 } }, { id: 'ar2', label: '', from: 'b', to: 'r', bidirectional: true, delta1: { x: 0, y: 0 }, delta2: { x: 0, y: 0 } }], summaries: [], direction: 1 });

test('outline text: one topic per line with tabs, and it reads back as the same tree', async () => {
  const { formats } = await modules;
  const nodes = [sampleRoot()];
  const text = formats.toOutlineText(nodes);
  assert.equal(text.split('\n')[0], 'Root');
  assert.equal(text.split('\n')[1], `\t${CJK}`);
  assert.equal(text.split('\n')[3], '\t\t\tDeep');
  assert.ok(!text.endsWith('\n'));
  const back = formats.parseOutline(text);
  assert.deepEqual(shapes(back.nodes), shapes(nodes));
  assert.equal(back.levels, 4);
  const two = [{ topic: 'One', children: [{ topic: 'Line\nbreak', children: [] }] }, { topic: 'Two', children: [] }];
  assert.equal(formats.toOutlineText(two), 'One\n\tLine break\nTwo');
  assert.deepEqual(shapes(formats.parseOutline(formats.toOutlineText(two)).nodes).map(n => n.topic), ['One', 'Two']);
});

test('Markdown: the whole map as a heading with lists, notes, links and done tasks, and it reads back the same', async () => {
  const { formats } = await modules;
  const nodes = [sampleRoot()];
  const md = formats.toMarkdown(nodes);
  const lines = md.split('\n');
  assert.equal(lines[0], '# Root');
  assert.ok(lines.includes('> Root note'));
  assert.ok(lines.includes(`- [${CJK}](https://example.com/a?q=%281%29)`), md);
  assert.ok(lines.includes('  - [x] Done task'), md);
  assert.ok(lines.includes('- [Second \\[with\\] brackets](https://example.com/b)'), md);
  assert.ok(lines.includes('  \\- not a bullet'), 'a note line that looks like Markdown is escaped');
  assert.ok(!md.endsWith('\n'));
  assert.ok(!/#\w/.test(md.replace(/^# /, '')), 'no tags are written');
  const back = formats.parseOutline(md);
  const expected = shapes(nodes, ['note', 'hyperLink', 'markers']);
  expected[0].children[0].hyperLink = 'https://example.com/a?q=%281%29'; // the same address, written safely for Markdown
  assert.deepEqual(shapes(back.nodes, ['note', 'hyperLink', 'markers']), expected);
  assert.deepEqual(formats.parseOutline(formats.toMarkdown([sampleRoot().children[0]])).nodes[0].children.map(n => n.topic), ['Grandchild one', 'Done task']);
  // A selection of several topics: each one as a top-level item.
  const selection = sampleRoot().children;
  const listMd = formats.toMarkdown(selection);
  assert.ok(listMd.startsWith(`- [${CJK}]`));
  assert.ok(listMd.includes('\n- [Second'));
  assert.deepEqual(shapes(formats.parseOutline(listMd).nodes, ['note']), shapes(selection, ['note']));
});

test('HTML list: escaped text and links, and it reads back as the same tree', async () => {
  const { formats } = await modules;
  const nodes = [{ topic: 'A <b>&"\'', hyperLink: 'https://example.com/?a=1&b="2"', children: [{ topic: CJK, children: [] }] }, { topic: 'B', children: [] }];
  const html = formats.toHtmlList(nodes);
  assert.equal(html, `<ul><li><a href="https://example.com/?a=1&amp;b=&quot;2&quot;">A &lt;b&gt;&amp;&quot;&#39;</a><ul><li>${CJK}</li></ul></li><li>B</li></ul>`);
  const back = formats.parseHtmlList(html, { parseHtml });
  assert.deepEqual(shapes(back.nodes, ['hyperLink']), shapes(nodes, ['hyperLink']));
  assert.equal(back.levels, 2);
  assert.equal(formats.toHtmlList([]), '');
});

test('outline parsing: 2, 3 and 4 spaces, tabs and mixed indents all give the same tree', async () => {
  const { formats } = await modules;
  const want = [{ topic: 'A', children: [{ topic: 'B', children: [{ topic: 'C', children: [] }] }, { topic: 'D', children: [] }] }, { topic: 'E', children: [] }];
  for (const [name, pad] of [['2 spaces', '  '], ['3 spaces', '   '], ['4 spaces', '    '], ['tabs', '\t']]) {
    for (const bullet of ['- ', '* ', '+ ', '\u2022 ', '']) {
      const text = `${bullet}A\n${pad}${bullet}B\n${pad}${pad}${bullet}C\n${pad}${bullet}D\n${bullet}E\n`;
      assert.deepEqual(shapes(formats.parseOutline(text).nodes), want, `${name} ${JSON.stringify(bullet)}`);
    }
  }
  assert.deepEqual(shapes(formats.parseOutline('- A\n\t- B\n\t    - C\n    - D\n- E').nodes), want, 'a tab counts as 4 columns');
  assert.deepEqual(shapes(formats.parseOutline('- A\n    - B\n  - C').nodes), [{ topic: 'A', children: [{ topic: 'B', children: [] }, { topic: 'C', children: [] }] }], 'a smaller indent goes back to the nearest smaller one');
  const flat = formats.parseOutline('One\nTwo\n\nThree');
  assert.deepEqual(flat.nodes.map(n => n.topic), ['One', 'Two', 'Three']);
  assert.equal(flat.levels, 1);
  assert.deepEqual(formats.parseOutline('').nodes, []);
});

test('outline parsing: headings with lists, numbers, task boxes, notes, front matter, code and rules', async () => {
  const { formats } = await modules;
  const md = [
    '---', 'title: Front matter', 'tags: [a]', '---',
    '## Plan', 'Intro prose of the plan', '',
    '- **Bold** step', '  continued here', '', '  and a second paragraph',
    '  1. First', '  2) Second', '     note of second',
    '- [ ] Open task', '- [x] Closed task', '- [X] Also closed',
    '```js', '- not an item', '```',
    '***', '---',
    '#### Skipped a level', '- `code item`', '- __under__ and snake_case_name', '-', '- [ ]',
    '## Links', '- [Site](https://example.com/s "Title")', '- https://example.com/bare', '- <https://example.com/auto>', '- [Bad](javascript:alert(1))', '- [Notion page](Page%20abc.md)',
    `## ${CJK}`, `- ${CJK}\u5b50\u9879`, `\t- ${CJK_NOTE}`,
    '# Top',
  ].join('\n');
  const { nodes, levels } = formats.parseOutline(md);
  assert.deepEqual(nodes.map(n => n.topic), ['Plan', 'Links', CJK, 'Top'], 'the smallest heading level is the top');
  const [plan, links, cjk] = nodes;
  assert.equal(plan.note, 'Intro prose of the plan');
  const [bold, open, closed, alsoClosed, skipped] = plan.children;
  assert.equal(bold.topic, 'Bold step');
  assert.equal(bold.note, 'continued here\n\nand a second paragraph');
  assert.deepEqual(bold.children.map(n => n.topic), ['First', 'Second']);
  assert.equal(bold.children[1].note, 'note of second');
  assert.equal(open.topic, 'Open task');
  assert.equal(open.markers, undefined);
  assert.deepEqual(closed.markers, ['task-done']);
  assert.deepEqual(alsoClosed.markers, ['task-done']);
  assert.equal(skipped.topic, 'Skipped a level', 'a heading two levels down is a child of the heading above');
  assert.deepEqual(skipped.children.map(n => n.topic), ['code item', 'under and snake_case_name'], 'code marks and emphasis go, empty items are skipped');
  assert.ok(!JSON.stringify(nodes).includes('not an item'), 'fenced code is skipped');
  assert.ok(!JSON.stringify(nodes).includes('Front matter'), 'front matter is skipped');
  assert.deepEqual(links.children.map(n => [n.topic, n.hyperLink]), [
    ['Site', 'https://example.com/s'], ['https://example.com/bare', 'https://example.com/bare'], ['https://example.com/auto', 'https://example.com/auto'], ['Bad', undefined], ['Notion page', undefined],
  ]);
  assert.equal(cjk.children[0].topic, `${CJK}\u5b50\u9879`);
  assert.equal(cjk.children[0].children[0].topic, CJK_NOTE, 'a tab-indented item is a child');
  assert.equal(levels, 3);
  // In a text with no bullets, every line is a topic.
  const plain = formats.parseOutline('# Project\nIntro line\n## Tasks\nBuy milk');
  assert.deepEqual(shapes(plain.nodes), [{ topic: 'Project', children: [{ topic: 'Intro line', children: [] }, { topic: 'Tasks', children: [{ topic: 'Buy milk', children: [] }] }] }]);
  const noBullets = formats.parseOutline('Root\n    Child line\n        Grandchild');
  assert.deepEqual(shapes(noBullets.nodes), [{ topic: 'Root', children: [{ topic: 'Child line', children: [{ topic: 'Grandchild', children: [] }] }] }]);
  assert.equal(formats.parseOutline('\ufeff- A\r\n  - B\r\n').nodes[0].children[0].topic, 'B', 'a BOM and Windows line ends');
  assert.deepEqual(formats.parseOutline('<!-- one line -->\n- A\n<!--\n- hidden\n-->\n~~~\n- code\n~~~~\n- B').nodes.map(n => n.topic), ['A', 'B'], 'comments and a longer closing fence');
});

test('HTML lists from Notion, Google Docs and web pages give text only', async () => {
  const { formats } = await modules;
  const notion = `<meta charset="utf-8"><h1>Ignored heading</h1><ul><li><p>Parent <strong>bold</strong></p><ul><li>Child <a href="https://example.com/c">link</a> text</li><li><a href="javascript:alert(1)">Bad link</a></li></ul></li>
    <li>Second<ol><li>Numbered<br>with break</li></ol></li></ul><p>between</p><ol><li>Another list<script>alert(1)</script><style>li{}</style></li><li><img src=x onerror=alert(1)>Image item</li><li>  </li></ol>`;
  const { nodes, levels } = formats.parseHtmlList(notion, { parseHtml });
  assert.deepEqual(shapes(nodes, ['hyperLink']), [
    { topic: 'Parent bold', children: [{ topic: 'Child link text', hyperLink: 'https://example.com/c', children: [] }, { topic: 'Bad link', children: [] }] },
    { topic: 'Second', children: [{ topic: 'Numbered with break', children: [] }] },
    { topic: 'Another list', children: [] },
    { topic: 'Image item', children: [] },
  ]);
  assert.equal(levels, 2);
  assert.ok(!JSON.stringify(nodes).includes('<'), 'no markup reaches the document');
  // Google Docs writes nested lists right inside the outer list.
  const gdocs = '<b id="docs-internal-guid"><ul><li>One</li><ul><li>One a</li><ul><li>One a i</li></ul></ul><li>Two</li></ul></b>';
  assert.deepEqual(shapes(formats.parseHtmlList(gdocs, { parseHtml }).nodes), [{ topic: 'One', children: [{ topic: 'One a', children: [{ topic: 'One a i', children: [] }] }] }, { topic: 'Two', children: [] }]);
  assert.equal(formats.parseHtmlList('<p>No list here</p><script>var ul = 1</script>', { parseHtml }), null);
  assert.equal(formats.parseHtmlList('<div><script><ul><li>x</li></ul></script></div>', { parseHtml }), null, 'a list inside a script is not a list');
});

test('OPML: export and import keep texts, order, nesting, notes with line breaks and links', async () => {
  const { formats } = await modules;
  const data = sampleDoc();
  data.nodeData.children[2].topic = 'Quote " amp & lt < gt > apos \' tab\tend\u0001';
  const opml = formats.toOpml({ title: 'My <map>', data });
  assert.ok(opml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">'));
  assert.ok(opml.includes('<title>My &lt;map&gt;</title>'));
  assert.ok(opml.includes('_note="Root note&#10;second line"'));
  assert.ok(!opml.includes('\u0001'), 'characters XML does not allow are dropped');
  const { doc, lost, format, title } = formats.importFile({ name: 'export.opml', bytes: bytesOf(opml), parseXml });
  assert.equal(format, 'opml');
  assert.equal(title, 'My <map>');
  const expected = shape(sampleRoot(), ['note', 'hyperLink']);
  expected.children[2].topic = 'Quote " amp & lt < gt > apos \' tab\tend';
  assert.deepEqual(shape(doc.nodeData, ['note', 'hyperLink']), expected);
  assert.deepEqual(lost, { sheets: 0, images: 0, boundaries: 0, callouts: 0, floating: 0, links: 0 });
});

test('OPML from other apps: several top-level outlines, title attributes, feed links and unsafe links', async () => {
  const { formats, xmind } = await modules;
  const opml = `<?xml version="1.0"?>\n<!-- exported -->\n<opml version="1.0"><head><title>  Feeds\n list </title></head><body>
    <outline text="News" _note="n"><outline title="Feed" type="rss" xmlUrl="https://example.com/feed.xml"/><outline text="Page" htmlUrl="http://example.com/"/></outline>
    <outline text="Local" url="file:///etc/passwd"/></body></opml>`;
  const { doc, lost, title } = formats.importFile({ name: 'feeds.txt', bytes: bytesOf(opml), parseXml });
  assert.equal(title, 'Feeds list');
  assert.equal(doc.nodeData.topic, 'Feeds list', 'several top-level outlines get a root with the title');
  assert.deepEqual(shapes(doc.nodeData.children, ['hyperLink', 'note']), [
    { topic: 'News', note: 'n', children: [{ topic: 'Feed', hyperLink: 'https://example.com/feed.xml', children: [] }, { topic: 'Page', hyperLink: 'http://example.com/', children: [] }] },
    { topic: 'Local', children: [] },
  ]);
  assert.equal(lost.links, 1);
  assert.equal(xmind.describeLost(lost).length, 1);
  const untitled = formats.importFile({ name: 'C:\\x\\two roots.opml', bytes: bytesOf('<opml><body><outline text="A"/><outline text="B"/></body></opml>'), parseXml });
  assert.equal(untitled.doc.nodeData.topic, 'two roots', 'or the file name');
  assert.throws(() => formats.importFile({ name: 'e.opml', bytes: bytesOf('<opml><head/><body/></opml>'), parseXml }), { name: 'Error', message: 'This file has no topics in it' });
});

test('FreeMind: export and import keep texts, notes, links, folding and arrows', async () => {
  const { formats } = await modules;
  const data = sampleDoc();
  data.nodeData.children[2].topic = 'Two\nlines & <tags>';
  const mm = formats.toFreeMind({ title: 'Ignored', data });
  assert.ok(mm.startsWith('<map version="1.0.1">'));
  assert.match(mm, /<node ID="ID_\d+" TEXT="Root">/);
  assert.ok(mm.includes('TEXT="Two&#10;lines &amp; &lt;tags&gt;"'));
  assert.ok(mm.includes('<richcontent TYPE="NOTE"><html><head/><body><p>Root note</p><p>second line</p></body></html></richcontent>'));
  assert.ok(mm.includes('FOLDED="true"'));
  assert.match(mm, /<arrowlink DESTINATION="ID_\d+" STARTARROW="None" ENDARROW="Default" MIDDLE_LABEL="depends on"\/>/);
  const ids = [...mm.matchAll(/ ID="(ID_\d+)"/g)].map(m => m[1]);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  const { doc, lost, format, title } = formats.importFile({ name: 'map.mm', bytes: bytesOf(mm), parseXml });
  assert.equal(format, 'freemind');
  assert.equal(title, 'Root');
  const expected = shape(sampleRoot(), ['note', 'hyperLink', 'expanded']);
  expected.children[2].topic = 'Two\nlines & <tags>';
  assert.deepEqual(shape(doc.nodeData, ['note', 'hyperLink', 'expanded']), expected);
  const byId = new Map();
  (function index(node, path) { byId.set(node.id, path); node.children.forEach((child, i) => index(child, `${path}/${i}`)); })(doc.nodeData, '');
  assert.deepEqual(doc.arrows.map(a => [byId.get(a.from), byId.get(a.to), a.label, !!a.bidirectional]), [['/0/0', '/2', 'depends on', false], ['/1', '', '', true]]);
  assert.deepEqual(doc.arrows[0].delta1, { x: 80, y: -40 });
  assert.deepEqual(lost.links, 0);
});

test('FreeMind and Freeplane files from those apps: rich text, local links, unknown arrows and icons', async () => {
  const { formats } = await modules;
  const mm = `<map version="freeplane 1.9.13"><!--Freeplane--><node TEXT="Root" ID="ID_1"><icon BUILTIN="idea"/><hook NAME="MapStyle"/>
    <node ID="ID_2" POSITION="right"><richcontent TYPE="NODE"><html><head><style>p{}</style></head><body><p>Rich <b>title</b></p></body></html></richcontent>
      <richcontent TYPE="NOTE" CONTENT-TYPE="xml/"><html><head/><body><p>Line one</p><p>Line <i>two</i></p></body></html></richcontent>
      <arrowlink DESTINATION="ID_3" STARTARROW="Default" ENDARROW="Default"/><arrowlink DESTINATION="ID_missing"/></node>
    <node ID="ID_3" TEXT="${CJK}" LINK="#ID_2"/><node TEXT="Web" LINK="https://example.com/w" FOLDED="false"/></node></map>`;
  const { doc, lost } = formats.importFile({ name: 'free.mm', bytes: bytesOf(mm), parseXml });
  assert.deepEqual(shape(doc.nodeData, ['note', 'hyperLink', 'expanded']), { topic: 'Root', children: [
    { topic: 'Rich title', note: 'Line one\nLine two', children: [] }, { topic: CJK, children: [] }, { topic: 'Web', hyperLink: 'https://example.com/w', children: [] },
  ] });
  assert.equal(doc.arrows.length, 1, 'an arrow to an unknown topic is dropped');
  assert.equal(doc.arrows[0].bidirectional, true);
  assert.equal(lost.links, 1, 'a link to a topic in the file is not kept');
  assert.throws(() => formats.importFile({ name: 'e.mm', bytes: bytesOf('<map version="1.0.1"></map>'), parseXml }), /no topics/);
});

test('a reader is chosen by content, and by name only for .xmind', async () => {
  const { formats, xmind } = await modules;
  const zip = xmind.buildXmind({ title: 'Z', data: sampleDoc() });
  const asMd = formats.importFile({ name: 'odd.md', bytes: zip, parseXml });
  assert.equal(asMd.format, 'xmind', 'a zip is read as .xmind whatever its name');
  assert.equal(asMd.title, 'Root');
  assert.throws(() => formats.importFile({ name: 'notes.XMIND', bytes: bytesOf('- A\n- B'), parseXml }), err => err instanceof xmind.XmindError && err.message === 'This is not a .xmind file');
  const opmlTxt = formats.importFile({ name: 'outline.txt', bytes: bytesOf('\ufeff<?xml version="1.0"?>\n<opml version="2.0"><body><outline text="X"/></body></opml>'), parseXml });
  assert.equal(opmlTxt.format, 'opml');
  assert.equal(formats.importFile({ name: 'a.txt', bytes: bytesOf('  # Title\n- a'), parseXml }).format, 'markdown');
  const text = formats.importFile({ name: 'list.txt', bytes: bytesOf('One\n\tTwo\nThree'), parseXml });
  assert.equal(text.format, 'text');
  assert.equal(text.doc.nodeData.topic, 'list', 'several top-level lines get a root named after the file');
  assert.equal(text.title, 'list');
  assert.deepEqual(text.doc.nodeData.children.map(n => n.topic), ['One', 'Three']);
  assert.throws(() => formats.importFile({ name: 'page.html', bytes: bytesOf('<!doctype html><html><body><ul><li>x</li></ul></body></html>'), parseXml }), { message: 'This file cannot be read as a mind map' });
  assert.throws(() => formats.importFile({ name: 'x.svg', bytes: bytesOf('<svg/>'), parseXml }), err => err instanceof formats.FormatError);
  // Encodings: UTF-8 with a BOM, UTF-16 with either byte order, and GB18030 Chinese text.
  const utf16 = (text, le) => { const out = [le ? 0xff : 0xfe, le ? 0xfe : 0xff]; for (const ch of text) { const c = ch.charCodeAt(0); out.push(...(le ? [c & 255, c >> 8] : [c >> 8, c & 255])); } return new Uint8Array(out); };
  for (const le of [true, false]) assert.equal(formats.importFile({ name: 'u.txt', bytes: utf16(`${CJK}\n\tB`, le), parseXml }).doc.nodeData.topic, CJK, `utf-16 ${le ? 'le' : 'be'}`);
  assert.equal(formats.importFile({ name: 'b.md', bytes: new Uint8Array([0xef, 0xbb, 0xbf, ...bytesOf('# T')]) }).title, 'T');
  const gbk = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]); // the first two characters of CJK in GB18030
  assert.equal(formats.importFile({ name: 'gbk.txt', bytes: gbk }).doc.nodeData.topic, CJK.slice(0, 2));
});

test('limits and errors: too large, too many topics, too deep, empty', async () => {
  const { formats, doc } = await modules;
  assert.throws(() => formats.importFile({ name: 'big.txt', bytes: new Uint8Array(formats.TEXT_LIMIT + 1).fill(65) }), { message: 'This file is too large' });
  const many = Array.from({ length: doc.LIMITS.topics + 1 }, (_, i) => `t${i}`).join('\n');
  assert.throws(() => formats.parseOutline(many), { message: 'This map has too many topics' });
  assert.throws(() => formats.importFile({ name: 'many.txt', bytes: bytesOf(many) }), err => err instanceof formats.FormatError && /too many topics/.test(err.message));
  const deep = Array.from({ length: doc.LIMITS.depth + 5 }, (_, i) => `${'\t'.repeat(i)}d${i}`).join('\n');
  assert.throws(() => formats.parseOutline(deep), { message: 'This map is too deeply nested' });
  let opml = '<outline text="leaf"/>';
  for (let i = 0; i < doc.LIMITS.depth + 5; i += 1) opml = `<outline text="n">${opml}</outline>`;
  assert.throws(() => formats.importFile({ name: 'deep.opml', bytes: bytesOf(`<opml><body>${opml}</body></opml>`), parseXml }), /too deeply nested/);
  let ul = '<li>leaf</li>';
  for (let i = 0; i < doc.LIMITS.depth + 5; i += 1) ul = `<li>n<ul>${ul}</ul></li>`;
  assert.throws(() => formats.parseHtmlList(`<ul>${ul}</ul>`, { parseHtml }), /too deeply nested/);
  // The new root of several top-level topics counts one level: the result still goes through the document rules.
  const edge = Array.from({ length: doc.LIMITS.depth + 1 }, (_, i) => `${'\t'.repeat(i)}d${i}`).join('\n');
  assert.equal(formats.parseOutline(edge).levels, doc.LIMITS.depth + 1);
  assert.throws(() => formats.docFromNodes([...formats.parseOutline(edge).nodes, { topic: 'x', children: [] }], 'Root'), err => err instanceof formats.FormatError && /too deeply nested/.test(err.message));
  for (const empty of ['', '\n\n  \n', '---\nfront: matter\n---\n', '-\n- [ ]\n***']) {
    assert.throws(() => formats.importFile({ name: 'e.md', bytes: bytesOf(empty) }), { message: 'This file has no topics in it' }, JSON.stringify(empty));
  }
  assert.throws(() => formats.docFromNodes([], 'x'), err => err instanceof formats.FormatError);
  const one = formats.docFromNodes([{ id: 'bad id!', topic: 'Only', children: [] }], 'unused');
  assert.equal(one.nodeData.topic, 'Only');
  assert.notEqual(one.nodeData.id, 'bad id!', 'through sanitizeDoc');
  assert.equal(formats.docFromNodes([{ topic: 'a' }, { topic: 'b' }], '').nodeData.topic, 'Central Topic');
});

test('XML escaping drops what XML 1.0 does not allow and escapes the rest', async () => {
  const { xmind } = await modules;
  assert.equal(xmind.escapeXml('a<b>&"\'\n\r\t\u0000\u0008\u000b\uffff\ud800z\ud83d\ude00'), 'a&lt;b&gt;&amp;&quot;&apos;&#10;&#13;&#9;z\ud83d\ude00');
  assert.equal(xmind.escapeXml('line\nbreak\ttab', { attribute: false }), 'line\nbreak\ttab');
  assert.equal(xmind.escapeXml(null), '');
});

test('.xmind export carries an XMind 8 content.xml with the same ids, and it reads back the same without content.json', async () => {
  const { xmind } = await modules;
  const data = sampleDoc();
  data.nodeData.children[0].tags = ['label <one>', 'two'];
  data.nodeData.children[0].markers = ['priority-1', 'star-red'];
  data.nodeData.children[2].note = 'Note & <stuff>\nline two\u0002';
  data.summaries = [{ id: 'su', parent: 'a', start: 0, end: 1, label: 'Sum "up"' }, { id: 'su2', parent: 'r', start: 1, end: 2, label: '' }];
  const bytes = xmind.buildXmind({ title: 'Sheet & <title>', data });
  const entries = unzipSync(bytes);
  for (const name of ['content.json', 'metadata.json', 'manifest.json', 'content.xml', 'meta.xml', 'META-INF/manifest.xml']) assert.ok(entries[name], name);
  const xml = strFromU8(entries['content.xml']);
  assert.ok(xml.includes('<xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0" xmlns:xlink="http://www.w3.org/1999/xlink" version="2.0">'));
  assert.ok(xml.includes('structure-class="org.xmind.ui.logic.right"'));
  assert.ok(xml.includes('branch="folded"'));
  assert.ok(xml.includes('<title>Sheet &amp; &lt;title&gt;</title></sheet>'));
  assert.ok(!xml.includes('\u0002'));
  const manifest = strFromU8(entries['META-INF/manifest.xml']);
  assert.ok(manifest.includes('<file-entry full-path="content.xml" media-type="text/xml"/>'));
  assert.ok(strFromU8(entries['meta.xml']).includes('urn:xmind:xmap:xmlns:meta:2.0'));
  const json = JSON.parse(strFromU8(entries['content.json']))[0];
  const jsonIds = [];
  (function walk(topic) { jsonIds.push(topic.id); for (const child of (topic.children && topic.children.attached) || []) walk(child); for (const child of (topic.children && topic.children.summary) || []) walk(child); })(json.rootTopic);
  const xmlIds = [...parseXml(xml).getElementsByTagName('topic')].map(el => el.getAttribute('id'));
  assert.deepEqual(new Set(xmlIds), new Set(jsonIds), 'the same topic ids in both');
  assert.ok(xml.includes(`id="${json.id}"`), 'and the same sheet id');

  const fromJson = xmind.parseXmind(bytes).doc;
  const { 'content.json': _drop, ...rest } = entries;
  const old = xmind.parseXmind(zipSync(rest), { parseXml });
  const comparable = map => {
    const paths = new Map();
    (function index(node, path) { paths.set(node.id, path); node.children.forEach((child, i) => index(child, `${path}/${i}`)); })(map.nodeData, '');
    const strip = node => { const { id, ...keep } = node; return { ...keep, children: node.children.map(strip) }; };
    return {
      nodeData: strip(map.nodeData),
      arrows: map.arrows.map(a => ({ from: paths.get(a.from), to: paths.get(a.to), label: a.label })),
      summaries: map.summaries.map(s => ({ parent: paths.get(s.parent), start: s.start, end: s.end, label: s.label })),
    };
  };
  fromJson.nodeData.children[2].note = fromJson.nodeData.children[2].note.replace('\u0002', ''); // JSON keeps the control character, XML cannot carry it
  assert.deepEqual(comparable(old.doc), comparable(fromJson));
  assert.equal(old.doc.nodeData.children[0].tags[0], 'label <one>');
  assert.equal(old.doc.nodeData.children[2].note, 'Note & <stuff>\nline two');
  assert.equal(old.doc.summaries.length, 2);
  assert.deepEqual(old.lost, { sheets: 0, images: 0, boundaries: 0, callouts: 0, floating: 0, links: 0 });
});
