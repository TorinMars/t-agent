// The macOS shell app (apps/macos/*.swift, the entry point in main.swift).
// - Everywhere: the sources are every *.swift file of the folder, top-level code is only in main.swift, apps/macos/README.md
//   names every file, and every string of the app is English (the app has no translation layer in v1).
// - On macOS with swiftc: the files compile together (to a temporary folder, never into the repository, unoptimized -Onone)
//   and --self-test passes. --self-test puts no window on screen, opens no connection, runs no process and never reads
//   the real ~/.tagent or the app's defaults. Elsewhere (Linux CI, no Xcode tools) the build is skipped with a message.
//   Set TA_SKIP_SWIFT_APP=1 to skip the build on a Mac too.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const FOLDER = path.join(ROOT, 'apps', 'macos');
const SOURCES = fs.readdirSync(FOLDER).filter(name => name.endsWith('.swift')).sort().map(name => path.join(FOLDER, name));
// CJK punctuation, kana, Han, Hangul and full-width forms.
const CJK = /[\u2e80-\u303f\u3040-\u30ff\u3100-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/;

test('the app sources: several files, top-level code only in main.swift', () => {
  const names = SOURCES.map(file => path.basename(file));
  assert.ok(names.includes('main.swift') && names.includes('SelfTest.swift') && names.length > 5, names.join(' '));
  // Swift allows top-level statements only in main.swift; elsewhere a line at the left margin is a declaration, an import, a comment,
  // an attribute or the end of a block.
  const declaration = /^(?:$|\/\/|\/\*|\*|}|\)|]|@|import |(?:(?:private|fileprivate|final|public|internal) )*(?:func|let|var|class|struct|enum|extension|protocol|typealias) )/;
  for (const file of SOURCES.filter(name => path.basename(name) !== 'main.swift')) {
    const stray = fs.readFileSync(file, 'utf8').split('\n').map((line, index) => [index + 1, line]).filter(([, line]) => !declaration.test(line) && !/^\s/.test(line));
    assert.deepEqual(stray, [], `top-level code outside main.swift in ${path.basename(file)}`);
  }
});

test('apps/macos/README.md names every source file', () => {
  const readme = fs.readFileSync(path.join(FOLDER, 'README.md'), 'utf8');
  for (const file of SOURCES) assert.ok(readme.includes(`\`${path.basename(file)}\``), `README.md does not name ${path.basename(file)}`);
});

test('every string the app shows is English (no CJK anywhere in apps/macos)', () => {
  for (const name of fs.readdirSync(FOLDER)) {
    const text = fs.readFileSync(path.join(FOLDER, name), 'utf8');
    const lines = text.split('\n').map((line, index) => [index + 1, line]).filter(([, line]) => CJK.test(line));
    assert.deepEqual(lines, [], `CJK text in apps/macos/${name}`);
  }
  // The string literals in particular (what the window, the menus and the alerts show).
  let literals = 0;
  for (const file of SOURCES) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) {
      literals += 1;
      assert.doesNotMatch(match[1], CJK, `${path.basename(file)}: ${match[1]}`);
    }
  }
  assert.ok(literals > 100, `only ${literals} string literals found`);
});

function swiftSkipReason() {
  if (process.platform !== 'darwin') return 'the app is macOS only';
  if (process.env.TA_SKIP_SWIFT_APP === '1') return 'TA_SKIP_SWIFT_APP=1';
  const probe = spawnSync('swiftc', ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) return 'swiftc is not installed (xcode-select --install)';
  return null;
}

const skip = swiftSkipReason();
test('the app compiles and its self-test passes', { skip: skip || false, timeout: 300000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-mac-app-'));
  try {
    const binary = path.join(dir, 'tagent-app');
    const build = spawnSync('swiftc', ['-Onone', '-swift-version', '5', '-framework', 'AppKit', '-framework', 'WebKit', ...SOURCES, '-o', binary],
      { encoding: 'utf8', timeout: 240000 });
    assert.equal(build.status, 0, `swiftc failed:\n${build.stderr}`);
    assert.doesNotMatch(build.stderr, /warning:/, `swiftc warnings:\n${build.stderr}`);
    // A data home of its own: the self-test reads no file, but nothing could reach the real ~/.tagent either.
    const env = { ...process.env, TAGENT_HOME: dir };
    delete env.T_AGENT_DATA_DIR;
    const run = spawnSync(binary, ['--self-test'], { encoding: 'utf8', timeout: 60000, env });
    const lines = run.stdout.split('\n');
    const failed = lines.filter(line => line.startsWith('FAIL'));
    assert.deepEqual(failed, [], `self-test failures:\n${failed.join('\n')}\n${run.stderr}`);
    assert.equal(run.status, 0, `self-test exit ${run.status}\n${run.stderr}`);
    const passed = lines.filter(line => line.startsWith('ok   ')).length;
    assert.ok(passed >= 200, `only ${passed} checks ran`);
    assert.match(run.stdout, new RegExp(`^${passed} passed, 0 failed$`, 'm'));
    const version = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 20000, env });
    assert.equal(version.status, 0);
    assert.equal(version.stdout.trim(), 'dev', 'outside a bundle the version is "dev"');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
