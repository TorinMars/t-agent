// The macOS desktop widget (widgets/macos/TAttentionWidget.swift).
// - Everywhere: widgets/macos/strings.json lists exactly the interface strings of the Swift file (every L("...") and S("..."))
//   and each one has a Chinese translation, so GET /api/attention/widget/strings can serve the whole table.
// - On macOS with swiftc: the file compiles (to a temporary folder, never into the repository) and its --self-test passes.
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

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'widgets', 'macos', 'TAttentionWidget.swift');
const STRINGS = path.join(ROOT, 'widgets', 'macos', 'strings.json');

function sourceStrings() {
  const text = fs.readFileSync(SOURCE, 'utf8');
  const found = new Set();
  for (const match of text.matchAll(/\b[LS]\("((?:[^"\\]|\\.)*)"/g)) found.add(JSON.parse(`"${match[1]}"`));
  return found;
}

test('strings.json lists exactly the interface strings of the widget', () => {
  const list = JSON.parse(fs.readFileSync(STRINGS, 'utf8'));
  assert.ok(Array.isArray(list) && list.every(item => typeof item === 'string' && item.trim() === item && item));
  assert.equal(new Set(list).size, list.length, 'no string is listed twice');
  const used = sourceStrings();
  assert.deepEqual([...used].filter(item => !list.includes(item)), [], 'strings used in the Swift file but missing from strings.json');
  assert.deepEqual(list.filter(item => !used.has(item)), [], 'strings in strings.json that the Swift file does not use');
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
  assert.deepEqual(list.filter(item => sandbox.I18n.t(item) === item), []);
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
    const build = spawnSync('swiftc', ['-Onone', '-swift-version', '5', '-framework', 'AppKit', SOURCE, '-o', binary],
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
