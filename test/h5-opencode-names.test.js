// OpenCode as the third agent of the page: every place that names or keeps an agent kind knows it (the maps of scripts/h5-shell and public/js), so an
// OpenCode terminal is never shown as "Terminal", never loses its kind in the shared Recent list and never draws Claude's sparkle. The JSX maps are read
// from the source (the shell components are not loadable in node); the modules are imported.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
function chinese() {
  const sandbox = { TALocalKeys: { get: () => 'zh', set() {} } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const file of ['i18n.js', 'i18n-zh-ui.js', 'i18n-zh-extra.js']) vm.runInContext(read(`public/js/${file}`), sandbox);
  return sandbox.I18n;
}

test('the shared maps of the shell name OpenCode', async () => {
  const columns = await import('../scripts/h5-shell/columns.mjs');
  assert.equal(columns.AGENT_NAMES.opencode, 'OpenCode', 'column and session headers: "OpenCode · Running"');
  const base = { type: columns.MESSAGE_TYPE, paneId: 'p1', event: 'title', title: 'T', session: 'S' };
  assert.equal(columns.readPaneMessage({ ...base, agent: 'opencode' }).agent, 'opencode', 'a pane reports an OpenCode terminal');
  assert.equal(columns.readPaneMessage({ ...base, agent: 'other' }).agent, undefined, 'an unknown agent is still dropped');
  const { cleanEntry } = await import('../scripts/h5-shell/recent-sessions.mjs');
  assert.equal(cleanEntry({ sourceKey: 'local', taskId: 1, terminalId: 'oc1', agent: 'opencode' }).agent, 'opencode', 'the shared Recent list keeps the kind');
  assert.equal(cleanEntry({ sourceKey: 'local', taskId: 1, terminalId: 'x', agent: 'other' }).agent, null);
  const { recentRows } = await import('../scripts/h5-shell/recent-rows.mjs');
  const [row] = recentRows([{ sourceKey: 'local', taskId: '1', terminalId: 'oc1', title: '', agent: 'opencode' }]);
  assert.equal(row.name, 'OpenCode session', 'an unnamed OpenCode session is named by its kind');
  const { MENU_ACTIONS } = await import('../scripts/h5-shell/usage-track.mjs');
  assert.ok(MENU_ACTIONS.has('OpenCode'));
});

test('the JSX maps name OpenCode, and the names have Chinese translations', () => {
  const maps = [
    ['scripts/h5-shell/TaskDrawer.jsx', /const AGENT_NAMES = \{[^}]*opencode: 'OpenCode'/],
    ['scripts/h5-shell/Switcher.jsx', /const AGENT_NAMES = \{[^}]*opencode: 'OpenCode'/],
    ['scripts/h5-shell/RecentList.jsx', /const KIND_NAMES = \{[^}]*opencode: 'OpenCode session'/],
    ['scripts/h5-shell/Attention.jsx', /const AGENT_NAME = \{[^}]*opencode: 'OpenCode'/],
    ['scripts/h5-shell/Attention.jsx', /const AGENT_LABEL = \{[^}]*opencode: 'OpenCode'/],
    ['scripts/h5-shell/Terminal.jsx', /const LINK_TITLES = \{[^}]*OpenCode: 'OpenCode wants to open a link'/],
    ['public/js/h5.js', /const SESSION_KINDS = \[\['claude', 'Claude session'\], \['codex', 'Codex session'\], \['opencode', 'OpenCode session'\]\]/],
    ['public/js/h5.js', /const AGENT_CAPABILITY = \{ opencode: 'terminal:opencode' \}/],
  ];
  for (const [file, pattern] of maps) assert.match(read(file), pattern, file);
  const I18n = chinese();
  for (const text of ['OpenCode session', 'New OpenCode session', 'OpenCode commands', 'OpenCode wants to open a link']) assert.notEqual(I18n.t(text), text, `"${text}" is translated`);
  assert.notEqual(I18n.t('K01 needs an update first'), 'K01 needs an update first', 'the greyed row\'s reason is translated');
  assert.match(I18n.t('K01 needs an update first'), /^K01 /, 'with the engine name kept');
});

test('the OpenCode mark is its own (agent-chat.js icon), and an unknown agent never draws Claude\'s sparkle', () => {
  const made = [];
  const node = (kind, name) => {
    const item = { kind, name, attributes: {}, children: [], setAttribute(key, value) { this.attributes[key] = value; }, append(...children) { this.children.push(...children); } };
    made.push(item);
    return item;
  };
  const sandbox = { document: { createTextNode: text => ({ kind: 'text', text }), createElementNS: (ns, name) => node('svg', name), createElement: name => node('html', name) } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${read('public/js/agent-chat.js')}\nthis.AgentChat = AgentChat;`, sandbox);
  const { icon } = sandbox.AgentChat;
  assert.equal(icon('claude').text, '✳');
  assert.equal(icon('codex').children[0].name, 'path');
  const mark = icon('opencode');
  assert.equal(mark.name, 'svg');
  assert.equal(mark.attributes.viewBox, '0 0 24 24');
  assert.deepEqual(mark.children.map(child => child.name), ['rect', 'rect'], 'an outlined block and its filled lower part');
  const [outline, block] = mark.children;
  assert.deepEqual([outline.attributes.x, outline.attributes.y, outline.attributes.width, outline.attributes.height, outline.attributes.rx], ['5', '4', '14', '16', '2']);
  assert.equal(outline.attributes.fill, 'none');
  assert.equal(outline.attributes['stroke-width'], '1.5');
  assert.equal(outline.attributes['stroke-linejoin'], 'round');
  assert.deepEqual([block.attributes.x, block.attributes.y, block.attributes.width, block.attributes.height, block.attributes.fill], ['8', '12', '8', '5', 'currentColor']);
  assert.equal(icon('something-new').text, '>_', 'an unknown agent: the plain terminal mark');
  assert.equal(icon(undefined).text, '>_');
});
