// The macOS desktop widget (widgets/macos/*.swift, the entry point in main.swift).
// - Everywhere: widgets/macos/strings.json lists exactly the interface strings of the Swift files (every L("...") and S("..."))
//   and each one has a Chinese translation, so GET /api/attention/widget/strings can serve the whole table.
// - On macOS with swiftc: the files the launcher builds (services/attention-widget.js widgetSources) compile together (to a temporary
//   folder, never into the repository) and the --self-test passes.
//   --self-test puts no window on screen and uses no network. The build here is unoptimized (-Onone, about 10 s; T-Agent itself
//   builds with -O, about 30 s). Elsewhere (Linux CI, no Xcode tools) the test is skipped with a message.
//   Set TA_SKIP_SWIFT_WIDGET=1 to skip the build on a Mac too.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { widgetSources } = require('../services/attention-widget');

const ROOT = path.join(__dirname, '..');
const FOLDER = path.join(ROOT, 'widgets', 'macos');
const SOURCES = widgetSources(FOLDER);
const STRINGS = path.join(FOLDER, 'strings.json');

function sourceStrings() {
  const found = new Set();
  for (const file of SOURCES) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/\b[LS]\("((?:[^"\\]|\\.)*)"/g)) found.add(JSON.parse(`"${match[1]}"`));
  }
  return found;
}

test('the widget sources: several files, every *.swift of the folder, top-level code only in main.swift', () => {
  const names = fs.readdirSync(FOLDER).filter(name => name.endsWith('.swift')).sort();
  assert.deepEqual(SOURCES.map(file => path.basename(file)), names, 'the launcher builds every .swift file of the folder');
  assert.ok(names.includes('main.swift') && names.length > 1);
  assert.ok(!names.includes('TAttentionWidget.swift'), 'the retired single-file source is not in the repository');
  // Swift allows top-level statements only in main.swift; elsewhere a line at the left margin is a declaration, an import, a comment,
  // an attribute or the end of a block.
  const declaration = /^(?:$|\/\/|\/\*|\*|}|\)|]|@|import |(?:(?:private|fileprivate|final|public|internal) )*(?:func|let|var|class|struct|enum|extension|protocol|typealias) )/;
  for (const file of SOURCES.filter(name => path.basename(name) !== 'main.swift')) {
    const stray = fs.readFileSync(file, 'utf8').split('\n').map((line, index) => [index + 1, line]).filter(([, line]) => !declaration.test(line) && !/^\s/.test(line));
    assert.deepEqual(stray, [], `top-level code outside main.swift in ${path.basename(file)}`);
  }
});

test('strings.json lists exactly the interface strings of the widget', () => {
  const list = JSON.parse(fs.readFileSync(STRINGS, 'utf8'));
  assert.ok(Array.isArray(list) && list.every(item => typeof item === 'string' && item.trim() === item && item));
  assert.equal(new Set(list).size, list.length, 'no string is listed twice');
  const used = sourceStrings();
  assert.deepEqual([...used].filter(item => !list.includes(item)), [], 'strings used in the Swift files but missing from strings.json');
  assert.deepEqual(list.filter(item => !used.has(item)), [], 'strings in strings.json that the Swift files do not use');
  for (const item of list) assert.doesNotMatch(item.replace(/\{\d\}/g, ''), /[{}]/, `only {1}-style placeholders: ${item}`);
});

test('every widget string has a Chinese translation', () => {
  const sandbox = { localStorage: { getItem: () => 'zh', setItem() {} } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const file of ['i18n.js', 'i18n-zh-ui.js', 'i18n-zh-server.js', 'i18n-zh-extra.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'js', file), 'utf8'), sandbox);
  }
  const list = JSON.parse(fs.readFileSync(STRINGS, 'utf8'));
  // Placeholders are filled with a number first, as the window shows them: a template with almost no fixed text
  // ("{1}m") matches only numbers in the page's engine (the server itself serves the exact key).
  const shown = item => item.replace(/\{\d\}/g, '7');
  assert.deepEqual(list.filter(item => sandbox.I18n.t(shown(item)) === shown(item)), []);
});

function swiftSkipReason() {
  if (process.platform !== 'darwin') return 'the widget is macOS only';
  if (process.env.TA_SKIP_SWIFT_WIDGET === '1') return 'TA_SKIP_SWIFT_WIDGET=1';
  const probe = spawnSync('swiftc', ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) return 'swiftc is not installed (xcode-select --install)';
  return null;
}

const skip = swiftSkipReason();
test('the widget compiles and its self-test passes', { skip: skip || false, timeout: 240000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-widget-'));
  try {
    const binary = path.join(dir, 'taw');
    const build = spawnSync('swiftc', ['-Onone', '-swift-version', '5', '-framework', 'AppKit', ...SOURCES, '-o', binary],
      { encoding: 'utf8', timeout: 180000 });
    assert.equal(build.status, 0, `swiftc failed:\n${build.stderr}`);
    // No TA_WIDGET_URL / TA_WIDGET_TOKEN: the self-test never connects anywhere.
    const env = { ...process.env };
    delete env.TA_WIDGET_URL;
    delete env.TA_WIDGET_TOKEN;
    const run = spawnSync(binary, ['--self-test'], { encoding: 'utf8', timeout: 60000, env });
    const lines = run.stdout.split('\n');
    const failed = lines.filter(line => line.startsWith('FAIL'));
    assert.deepEqual(failed, [], `self-test failures:\n${failed.join('\n')}\n${run.stderr}`);
    assert.equal(run.status, 0, `self-test exit ${run.status}\n${run.stderr}`);
    const passed = lines.filter(line => line.startsWith('ok   ')).length;
    assert.ok(passed >= 200, `only ${passed} checks ran`);
    assert.match(run.stdout, new RegExp(`^${passed} passed, 0 failed$`, 'm'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
