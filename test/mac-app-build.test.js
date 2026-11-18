// scripts/build-mac-app.js: building, signing and installing T-Agent.app ("Building and installing" in docs/design/mac-app.md).
// - Everywhere: fake swiftc / lipo / codesign / plutil / iconutil / xattr / xcode-select / xcrun (small Node scripts in a temporary folder that
//   record their argv and write the files the real tools would) check the exact commands, the bundle layout, Info.plist, the version, --arch, the
//   self-test rules, the install into an injected home folder with its bundle id guard, and the error messages. Nothing is installed for real.
// - On macOS with the command line tools: one real universal build of a stand-in main.swift (written to a temporary folder, never to apps/macos),
//   checked with lipo -archs and codesign --verify. Set TA_SKIP_SWIFT_APP=1 to skip it. The first build on a Mac fills swiftc's module cache for
//   arm64 (about 50 s); later ones take a few seconds.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { buildApp, installApp, main, parseArgs, infoPlist, ICON_FILES, NO_TOOLS } = require('../scripts/build-mac-app');
const { findSwiftToolchain } = require('../lib/swift-toolchain');

const ROOT = path.join(__dirname, '..');

// A tiny XML property list reader (dict, array, string, true, false), enough to read Info.plist back.
function parsePlist(text) {
  const tokens = [...text.replace(/<\?xml[^>]*\?>|<!DOCTYPE[^>]*>/g, '').matchAll(/<(\/?)(\w+)(?:\s[^>]*?)?(\/?)>|([^<]+)/g)].map(match => (match[4] !== undefined
    ? { text: match[4] } : { close: Boolean(match[1]), name: match[2], empty: Boolean(match[3]) })).filter(token => token.text === undefined || token.text.trim());
  let index = 0;
  const unescape = value => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  function value() {
    const token = tokens[index++];
    if (token.name === 'true' || token.name === 'false') return token.name === 'true';
    if (token.name === 'string') { const content = tokens[index].text !== undefined ? unescape(tokens[index++].text) : ''; index += 1; return content; }
    if (token.name === 'array') { const list = []; while (!tokens[index].close) list.push(value()); index += 1; return list; }
    if (token.name === 'dict') {
      const dict = {};
      while (!tokens[index].close) { index += 1; const key = unescape(tokens[index++].text); index += 1; dict[key] = value(); }
      index += 1;
      return dict;
    }
    throw new Error(`unexpected ${JSON.stringify(token)}`);
  }
  assert.equal(tokens[index++].name, 'plist');
  return value();
}

// The fake tools. Each one appends { tool, argv, sdkroot } to $FAKE_LOG.
const RECORD = `const fs = require('fs'); const path = require('path'); const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ tool: path.basename(process.argv[1]), argv, sdkroot: process.env.SDKROOT || null }) + '\\n');
const after = flag => argv[argv.indexOf(flag) + 1];`;
const FAKE_APP = `
const argv = process.argv.slice(2);
if (argv[0] === '--self-test') {
  require('fs').appendFileSync(process.env.FAKE_LOG, JSON.stringify({ tool: 'app', argv, home: process.env.TAGENT_HOME, data: process.env.T_AGENT_DATA_DIR }) + '\\n');
  if (process.env.FAKE_SELF_TEST_FAIL) { console.log('FAIL   the url check'); console.log('2 passed, 1 failed'); process.exit(1); }
  console.log('ok   one'); console.log('3 passed, 0 failed'); process.exit(0);
}
require('fs').writeFileSync(process.env.FAKE_GUI_MARKER, 'the app was started without --self-test');
process.exit(9);
`;
const FAKES = {
  'xcode-select': `${RECORD} if (process.env.FAKE_NO_TOOLS) { console.error('xcode-select: error: unable to get active developer directory'); process.exit(2); }
console.log('/Library/Developer/CommandLineTools');`,
  xcrun: `${RECORD} if (argv.includes('--show-sdk-path')) console.log('/fake/MacOSX.sdk'); else console.log(path.join(process.env.FAKE_DIR, 'swiftc'));`,
  swiftc: `${RECORD} const out = after('-o');
if (argv.some(arg => arg.endsWith('make-icon.swift'))) {
  fs.writeFileSync(out, '#!${process.execPath}\\nconst fs = require("fs"), path = require("path"); const dir = process.argv[2]; fs.mkdirSync(dir, { recursive: true });\\n'
    + ${JSON.stringify(ICON_FILES.map(([name]) => name))}.map(name => 'fs.writeFileSync(path.join(dir, ' + JSON.stringify(name + '.png') + '), "png");').join('\\n'));
  fs.chmodSync(out, 0o755); process.exit(0);
}
const arch = after('-target').split('-')[0];
if (process.env.FAKE_FAIL_ARCH === arch) { console.error('<unknown>:0: error: unable to load standard library for target ' + after('-target')); process.exit(1); }
fs.writeFileSync(out, '#!${process.execPath}\\n// arch: ' + arch + '\\n' + ${JSON.stringify(FAKE_APP)}); fs.chmodSync(out, 0o755);`,
  lipo: `${RECORD} if (argv[0] === '-archs') { console.log([...fs.readFileSync(argv[1], 'utf8').matchAll(/^\\/\\/ arch: (\\S+)$/gm)].map(m => m[1]).join(' ')); process.exit(0); }
const inputs = argv.slice(3); let text = fs.readFileSync(inputs[0], 'utf8'); for (const file of inputs.slice(1)) text += fs.readFileSync(file, 'utf8').split('\\n')[1] + '\\n';
fs.writeFileSync(after('-output'), text);`,
  codesign: `${RECORD} if (argv[0] === '--verify' && process.env.FAKE_VERIFY_FAIL) { console.error(argv[argv.length - 1] + ': invalid signature'); process.exit(1); }
if (argv[0] === '--force') { const dir = path.join(argv[argv.length - 1], 'Contents', '_CodeSignature'); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'CodeResources'), 'sealed'); }`,
  plutil: `${RECORD} if (argv[0] === '-lint') console.log(argv[1] + ': OK'); else if (argv[0] === '-convert') process.stdout.write(fs.readFileSync(argv[argv.length - 1], 'utf8').replace(/^bplist00/, ''));`,
  iconutil: `${RECORD} const set = argv[2]; for (const name of fs.readdirSync(set)) if (!name.endsWith('.png')) process.exit(1);
if (fs.readdirSync(set).length !== 10) { console.error('Failed to generate ICNS.'); process.exit(1); } fs.writeFileSync(after('-o'), 'icns');`,
  xattr: `${RECORD} console.error('xattr: ' + argv[argv.length - 1] + ': No such xattr: com.apple.quarantine'); process.exit(1);`,
};

// A temporary project: VERSION.json, apps/macos with the given files, and the fake tools.
function fixture({ version = '9.8.7', sources = { 'main.swift': 'if CommandLine.arguments.contains("--self-test") { }\n', 'Window.swift': '', 'AppDelegate.swift': '' } } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ta-mac-app-test-')));
  const root = path.join(dir, 'project');
  const fakes = path.join(dir, 'bin');
  const tmp = path.join(dir, 'tmp');
  for (const folder of [path.join(root, 'apps', 'macos'), fakes, tmp]) fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(root, 'VERSION.json'), JSON.stringify({ app_version: version, api_version: 1 }));
  for (const [name, text] of Object.entries(sources)) fs.writeFileSync(path.join(root, 'apps', 'macos', name), text);
  for (const [name, body] of Object.entries(FAKES)) {
    fs.writeFileSync(path.join(fakes, name), `#!${process.execPath}\n${body}\n`);
    fs.chmodSync(path.join(fakes, name), 0o755);
  }
  const logFile = path.join(dir, 'calls.jsonl');
  fs.writeFileSync(logFile, '');
  const marker = path.join(dir, 'gui-started');
  const env = { PATH: `${fakes}:/usr/bin:/bin`, FAKE_LOG: logFile, FAKE_DIR: fakes, FAKE_GUI_MARKER: marker };
  const logs = [];
  const options = (extra = {}) => ({
    root, env, tmpDir: tmp, platform: 'darwin', hostArch: 'x86_64', pid: 4242, log: line => logs.push(line),
    xcodeSelect: path.join(fakes, 'xcode-select'), xcrun: path.join(fakes, 'xcrun'), ...extra, env: { ...env, ...(extra.env || {}) },
  });
  const calls = () => fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  return { dir, root, fakes, tmp, env, marker, logs, options, calls, cleanup, app: path.join(root, 'dist', 'T-Agent.app') };
}

test('a universal build runs the exact commands and lays out a signed bundle with the contract Info.plist', async () => {
  const fx = fixture();
  try {
    const result = await buildApp(fx.options());
    const calls = fx.calls();
    const sources = ['AppDelegate.swift', 'Window.swift', 'main.swift'].map(name => path.join(fx.root, 'apps', 'macos', name));
    const compiles = calls.filter(call => call.tool === 'swiftc' && call.argv.includes('-target'));
    assert.equal(compiles.length, 2);
    for (const arch of ['x86_64', 'arm64']) {
      const call = compiles.find(item => item.argv.includes(`${arch}-apple-macos12.0`));
      assert.ok(call, `a compile for ${arch}`);
      const out = call.argv[call.argv.length - 1];
      assert.deepEqual(call.argv, ['-O', '-swift-version', '5', '-target', `${arch}-apple-macos12.0`, '-framework', 'AppKit', '-framework', 'WebKit', ...sources, '-o', out]);
      assert.equal(path.basename(out), `T-Agent-${arch}`);
      assert.ok(out.startsWith(path.join(fx.tmp, 'ta-mac-app-')), 'executables are built in the temporary folder');
      assert.equal(call.sdkroot, '/fake/MacOSX.sdk', 'swiftc gets the SDK from xcrun');
    }
    const iconTool = calls.find(call => call.tool === 'swiftc' && !call.argv.includes('-target'));
    assert.deepEqual(iconTool.argv.slice(0, 5), ['-Onone', '-swift-version', '5', '-framework', 'AppKit']);
    assert.equal(iconTool.argv[5], path.join(ROOT, 'scripts', 'mac-app', 'make-icon.swift'));
    const iconutil = calls.find(call => call.tool === 'iconutil');
    assert.deepEqual(iconutil.argv.slice(0, 2), ['-c', 'icns']);
    assert.match(iconutil.argv[2], /AppIcon\.iconset$/);
    assert.match(iconutil.argv[4], /AppIcon\.icns$/);

    const staged = path.join(fx.root, 'dist', '.build-4242', 'T-Agent.app');
    const exe = path.join(staged, 'Contents', 'MacOS', 'T-Agent');
    assert.deepEqual(calls.find(call => call.tool === 'lipo' && call.argv[0] === '-create').argv,
      ['-create', '-output', exe, ...['x86_64', 'arm64'].map(arch => compiles.find(item => item.argv.includes(`${arch}-apple-macos12.0`)).argv.at(-1))]);
    assert.deepEqual(calls.filter(call => call.tool === 'codesign').map(call => call.argv), [
      ['--force', '--deep', '--sign', '-', '--timestamp=none', staged],
      ['--verify', '--strict', staged],
    ]);
    assert.deepEqual(calls.find(call => call.tool === 'plutil').argv, ['-lint', path.join(staged, 'Contents', 'Info.plist')]);
    assert.deepEqual(calls.find(call => call.tool === 'lipo' && call.argv[0] === '-archs').argv, ['-archs', exe]);
    // xcode-select first, then xcrun; the /usr/bin/swiftc stub is never run.
    assert.deepEqual(calls.filter(call => ['xcode-select', 'xcrun'].includes(call.tool)).map(call => [call.tool, ...call.argv]),
      [['xcode-select', '-p'], ['xcrun', '--find', 'swiftc'], ['xcrun', '--sdk', 'macosx', '--show-sdk-path']]);

    // The bundle.
    assert.equal(result.app, fx.app);
    assert.deepEqual(result.archs, ['arm64', 'x86_64']);
    assert.equal(result.version, '9.8.7');
    assert.deepEqual(fs.readdirSync(path.join(fx.app, 'Contents')).sort(), ['Info.plist', 'MacOS', 'PkgInfo', 'Resources', '_CodeSignature']);
    assert.deepEqual(fs.readdirSync(path.join(fx.app, 'Contents', 'MacOS')), ['T-Agent']);
    assert.ok(fs.statSync(path.join(fx.app, 'Contents', 'MacOS', 'T-Agent')).mode & 0o111, 'the executable can run');
    assert.deepEqual(fs.readdirSync(path.join(fx.app, 'Contents', 'Resources')), ['AppIcon.icns']);
    assert.equal(fs.readFileSync(path.join(fx.app, 'Contents', 'PkgInfo'), 'utf8'), 'APPL????');
    assert.deepEqual(parsePlist(fs.readFileSync(path.join(fx.app, 'Contents', 'Info.plist'), 'utf8')), {
      CFBundleDevelopmentRegion: 'en',
      CFBundleDisplayName: 'T-Agent',
      CFBundleExecutable: 'T-Agent',
      CFBundleIconFile: 'AppIcon',
      CFBundleIdentifier: 'local.t-agent.app',
      CFBundleInfoDictionaryVersion: '6.0',
      CFBundleName: 'T-Agent',
      CFBundlePackageType: 'APPL',
      CFBundleShortVersionString: '9.8.7',
      CFBundleVersion: '9.8.7',
      CFBundleURLTypes: [{ CFBundleURLName: 'local.t-agent.app', CFBundleURLSchemes: ['t-agent'] }],
      LSApplicationCategoryType: 'public.app-category.developer-tools',
      LSMinimumSystemVersion: '12.0',
      NSHighResolutionCapable: true,
      NSMicrophoneUsageDescription: 'T-Agent uses the microphone for voice input.',
      NSPrincipalClass: 'NSApplication',
      NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
    });
    assert.ok(!/NSCameraUsageDescription|com\.apple\.security/.test(fs.readFileSync(path.join(fx.app, 'Contents', 'Info.plist'), 'utf8')), 'no camera text, no sandbox');

    // The self-test ran once, with a temporary data home; the GUI never started.
    const selfTests = calls.filter(call => call.tool === 'app');
    assert.equal(selfTests.length, 1);
    assert.deepEqual(selfTests[0].argv, ['--self-test']);
    assert.ok(selfTests[0].home.startsWith(fx.tmp) && selfTests[0].data === selfTests[0].home, 'the self-test never sees the real ~/.tagent');
    assert.equal(result.selfTest, 'passed (3 passed, 0 failed)');
    assert.ok(!fs.existsSync(fx.marker), 'the app window was never launched');
    // Nothing is left behind: no temporary folder, no staging folder.
    assert.deepEqual(fs.readdirSync(fx.tmp), []);
    assert.deepEqual(fs.readdirSync(path.join(fx.root, 'dist')), ['T-Agent.app']);
    assert.ok(fx.logs.at(-1).startsWith(`Built ${fx.app} (9.8.7, arm64 + x86_64) in `));
  } finally { fx.cleanup(); }
});

test('Info.plist escapes XML and is well-formed for any version string', () => {
  const text = infoPlist('1.2.3');
  assert.ok(text.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"'));
  assert.equal(parsePlist(text).CFBundleVersion, '1.2.3');
  assert.equal(parsePlist(infoPlist('1&<2>')).CFBundleShortVersionString, '1&<2>');
});

test('--arch builds one architecture without lipo -create; the self-test runs only for the host architecture', async () => {
  const fx = fixture();
  try {
    const arm = await buildApp(fx.options({ archs: ['arm64'], hostArch: 'x86_64' }));
    let calls = fx.calls();
    const compiles = calls.filter(call => call.tool === 'swiftc' && call.argv.includes('-target'));
    assert.deepEqual(compiles.map(call => call.argv[4]), ['arm64-apple-macos12.0']);
    assert.ok(!calls.some(call => call.tool === 'lipo' && call.argv[0] === '-create'));
    assert.deepEqual(arm.archs, ['arm64']);
    assert.equal(arm.selfTest, 'skipped: this Mac runs x86_64');
    assert.ok(!calls.some(call => call.tool === 'app'));

    fs.writeFileSync(path.join(fx.dir, 'calls.jsonl'), '');
    const own = await buildApp(fx.options({ archs: ['arm64'], hostArch: 'arm64' }));
    calls = fx.calls();
    assert.equal(own.selfTest, 'passed (3 passed, 0 failed)');
    assert.equal(calls.filter(call => call.tool === 'app').length, 1);
    assert.ok(!fs.existsSync(fx.marker));
  } finally { fx.cleanup(); }
});

test('sources without --self-test are never run (the app would open its window)', async () => {
  const fx = fixture({ sources: { 'main.swift': 'print("hello")\n' } });
  try {
    const result = await buildApp(fx.options());
    assert.equal(result.selfTest, 'skipped: the app sources do not support --self-test yet');
    assert.ok(!fx.calls().some(call => call.tool === 'app'));
    assert.ok(!fs.existsSync(fx.marker));
    assert.match(fx.logs.at(-1), /self-test skipped: the app sources do not support --self-test yet$/);
  } finally { fx.cleanup(); }
});

test('a new build replaces dist/T-Agent.app; a failed one leaves the old bundle untouched', async () => {
  const fx = fixture();
  try {
    fs.mkdirSync(path.join(fx.app, 'Contents'), { recursive: true });
    fs.writeFileSync(path.join(fx.app, 'Contents', 'old-marker'), 'old');

    await assert.rejects(buildApp(fx.options({ env: { FAKE_SELF_TEST_FAIL: '1' } })),
      error => error.message === 'The self-test of the built app failed: 2 passed, 1 failed\nFAIL   the url check');
    assert.ok(fs.existsSync(path.join(fx.app, 'Contents', 'old-marker')), 'a failed self-test keeps the old bundle');
    await assert.rejects(buildApp(fx.options({ env: { FAKE_VERIFY_FAIL: '1' } })), /^Error: codesign --verify failed: .*invalid signature$/);
    assert.ok(fs.existsSync(path.join(fx.app, 'Contents', 'old-marker')));
    assert.deepEqual(fs.readdirSync(path.join(fx.root, 'dist')), ['T-Agent.app'], 'no staging folder is left');
    assert.deepEqual(fs.readdirSync(fx.tmp), []);

    await buildApp(fx.options());
    assert.ok(!fs.existsSync(path.join(fx.app, 'Contents', 'old-marker')), 'the old bundle is replaced');
    assert.ok(fs.existsSync(path.join(fx.app, 'Contents', 'Info.plist')));
    assert.deepEqual(fs.readdirSync(path.join(fx.root, 'dist')), ['T-Agent.app']);
  } finally { fx.cleanup(); }
});

test('clear errors: no command line tools, not macOS, no sources, an architecture that cannot be built', async () => {
  const fx = fixture();
  try {
    await assert.rejects(buildApp(fx.options({ env: { FAKE_NO_TOOLS: '1' } })), error => error.message === `swiftc was not found. ${NO_TOOLS}`);
    assert.equal(NO_TOOLS, 'Install the Xcode command line tools: xcode-select --install');
    assert.ok(!fx.calls().some(call => call.tool === 'xcrun' || call.tool === 'swiftc'), 'without a developer folder nothing else is run');

    await assert.rejects(buildApp(fx.options({ platform: 'linux' })), { message: 'The Mac app can only be built on macOS' });

    await assert.rejects(buildApp(fx.options({ archs: ['arm64'], env: { FAKE_FAIL_ARCH: 'arm64' } })),
      error => error.message === 'Could not build for arm64:\n<unknown>:0: error: unable to load standard library for target arm64-apple-macos12.0');
    await assert.rejects(buildApp(fx.options({ env: { FAKE_FAIL_ARCH: 'arm64' } })), error => {
      assert.equal(error.message, 'Could not build for arm64:\n<unknown>:0: error: unable to load standard library for target arm64-apple-macos12.0\n'
        + 'Build only x86_64 with: npm run build:mac-app -- --arch x86_64');
      return true;
    });
    assert.ok(!fs.existsSync(fx.app), 'nothing is put in dist after a failure');
    assert.deepEqual(fs.readdirSync(fx.tmp), []);

    fs.rmSync(path.join(fx.root, 'apps', 'macos', 'main.swift'));
    await assert.rejects(buildApp(fx.options()), { message: 'No app sources: apps/macos needs main.swift (and the other *.swift files of the app)' });
    fs.writeFileSync(path.join(fx.root, 'VERSION.json'), '{"app_version": "next"}');
    await assert.rejects(buildApp(fx.options()), { message: 'VERSION.json has no valid app_version (next)' });
  } finally { fx.cleanup(); }
});

test('the options: --arch, --install, --icon-preview, and refusals', () => {
  assert.deepEqual(parseArgs([]), { archs: ['x86_64', 'arm64'], install: false, iconPreview: null, help: false });
  assert.deepEqual(parseArgs(['--arch', 'arm64']).archs, ['arm64']);
  assert.deepEqual(parseArgs(['--arch=x86_64', '--install']), { archs: ['x86_64'], install: true, iconPreview: null, help: false });
  assert.equal(parseArgs(['--icon-preview', 'a/b.png']).iconPreview, path.resolve('a/b.png'));
  assert.throws(() => parseArgs(['--arch', 'ppc']), { message: 'Unknown architecture "ppc"; use --arch x86_64 or --arch arm64' });
  assert.throws(() => parseArgs(['--arch']), { message: '--arch needs a value' });
  assert.throws(() => parseArgs(['--sudo']), { message: 'Unknown option "--sudo" (see --help)' });
});

test('--install copies into <home>/Applications, replaces only this app, and clears the quarantine flag', async () => {
  const fx = fixture();
  try {
    const home = path.join(fx.dir, 'home');
    fs.mkdirSync(home);
    const printed = [];
    // Through the command line entry: build one architecture, then install into the injected home.
    const code = await main(['--arch', 'x86_64', '--install', '--icon-preview', path.join(fx.dir, 'preview.png')], {
      env: { ...fx.env, TA_MAC_APP_HOME: home }, log: line => printed.push(line), error: line => printed.push(`ERROR ${line}`),
      buildOptions: fx.options(),
    });
    assert.equal(code, 0, printed.join('\n'));
    const dest = path.join(home, 'Applications', 'T-Agent.app');
    assert.deepEqual(fs.readdirSync(path.join(home, 'Applications')), ['T-Agent.app'], 'the folder is created; no temporary copy is left');
    for (const file of ['Contents/Info.plist', 'Contents/PkgInfo', 'Contents/MacOS/T-Agent', 'Contents/Resources/AppIcon.icns', 'Contents/_CodeSignature/CodeResources']) {
      assert.deepEqual(fs.readFileSync(path.join(dest, file)), fs.readFileSync(path.join(fx.app, file)), file);
    }
    assert.ok(fs.statSync(path.join(dest, 'Contents', 'MacOS', 'T-Agent')).mode & 0o111);
    assert.deepEqual(fx.calls().filter(call => call.tool === 'xattr').map(call => call.argv), [['-dr', 'com.apple.quarantine', dest]]);
    assert.ok(printed.includes(`Installed ${dest}. Open it with: open ${dest}`), printed.join('\n'));
    assert.ok(printed.includes('The T-Agent web service keeps running when the app quits, and browsers can still use it.'));
    assert.ok(!printed.some(line => line.startsWith('Note:') || line.startsWith('ERROR')), '"No such xattr" is not an error');
    assert.equal(fs.readFileSync(path.join(fx.dir, 'preview.png'), 'utf8'), 'png', 'the 1024 px icon is copied to --icon-preview');

    // An older copy of this app is replaced.
    fs.writeFileSync(path.join(dest, 'Contents', 'stale'), 'x');
    await installApp({ app: fx.app, home, env: fx.env, log: () => {} });
    assert.ok(!fs.existsSync(path.join(dest, 'Contents', 'stale')));
    assert.deepEqual(fs.readdirSync(path.join(home, 'Applications')), ['T-Agent.app']);
    // ... also when its Info.plist is binary (read through plutil -convert).
    const plist = path.join(dest, 'Contents', 'Info.plist');
    fs.writeFileSync(plist, `bplist00${fs.readFileSync(plist, 'utf8')}`);
    fs.writeFileSync(path.join(dest, 'Contents', 'stale'), 'x');
    await installApp({ app: fx.app, home, env: fx.env, log: () => {} });
    assert.ok(!fs.existsSync(path.join(dest, 'Contents', 'stale')));

    // Another app with the same name is never replaced.
    fs.writeFileSync(plist, infoPlist('1.0.0').replace('local.t-agent.app</string>', 'com.example.other</string>'));
    await assert.rejects(installApp({ app: fx.app, home, env: fx.env, log: () => {} }),
      { message: `${dest} exists but is not this app (bundle id "com.example.other", expected "local.t-agent.app"). Move it away, then install again.` });
    assert.match(fs.readFileSync(plist, 'utf8'), /com\.example\.other/, 'the other app is untouched');
    fs.rmSync(dest, { recursive: true });
    fs.writeFileSync(dest, 'a file');
    await assert.rejects(installApp({ app: fx.app, home, env: fx.env, log: () => {} }), /bundle id unknown/);
    assert.equal(fs.readFileSync(dest, 'utf8'), 'a file');

    await assert.rejects(installApp({ app: path.join(fx.dir, 'nothing', 'T-Agent.app'), home, env: fx.env, log: () => {} }), /^Error: Nothing to install: /);
  } finally { fx.cleanup(); }
});

test('the command line prints errors and returns 1; --help prints the usage', async () => {
  const printed = [];
  assert.equal(await main(['--arch', 'mips'], { log: line => printed.push(line), error: line => printed.push(`ERROR ${line}`) }), 1);
  assert.deepEqual(printed, ['ERROR Unknown architecture "mips"; use --arch x86_64 or --arch arm64']);
  printed.length = 0;
  assert.equal(await main(['--help'], { log: line => printed.push(line) }), 0);
  assert.match(printed[0], /^Usage: npm run build:mac-app/);
});

test('the build is a development tool: npm script, dist/ ignored, never run by the service install or update', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['build:mac-app'], 'node scripts/build-mac-app.js');
  assert.match(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8'), /^dist\/$/m);
  for (const file of ['install.sh', 'bootstrap.sh', 'services/update-manager.js', 'server.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, file), 'utf8'), /build-mac-app|build:mac-app/, `${file} never builds the app`);
  }
  assert.match(fs.readFileSync(path.join(ROOT, 'test', 'production-dependencies.test.js'), 'utf8'), /\^build-mac-app\\\.js\$/);
});

test('findSwiftToolchain never runs xcrun without a developer folder, and returns swiftc with the SDK', async () => {
  const seen = [];
  const run = answers => async (file, args) => { seen.push([file, ...args]); return answers(file, args); };
  assert.equal(await findSwiftToolchain(run(() => ({ error: new Error('no'), stdout: '' }))), null);
  assert.deepEqual(seen, [['/usr/bin/xcode-select', '-p']]);
  const found = await findSwiftToolchain(run((file, args) => ({
    error: null, stdout: file.endsWith('xcode-select') ? '/dev\n' : args.includes('--show-sdk-path') ? '/sdk\n' : '/tools/swiftc\n',
  })));
  assert.deepEqual(found, { swiftc: '/tools/swiftc', sdkRoot: '/sdk' });
  assert.equal(await findSwiftToolchain(run(file => ({ error: null, stdout: file.endsWith('xcode-select') ? '/dev\n' : 'swiftc\n' }))), null, 'a relative path is refused');
});

// The real toolchain: only on macOS with the command line tools.
function realToolchain() {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  if (process.env.TA_SKIP_SWIFT_APP) return Promise.resolve(null);
  const run = (file, args) => new Promise(resolve => childProcess.execFile(file, args, (error, stdout) => resolve({ error, stdout: String(stdout || '') })));
  return findSwiftToolchain(run);
}

test('a real universal build of a stand-in app passes lipo -archs and codesign --verify', { timeout: 15 * 60 * 1000 }, async t => {
  if (!(await realToolchain())) { t.skip(process.platform !== 'darwin' ? 'macOS only' : process.env.TA_SKIP_SWIFT_APP ? 'TA_SKIP_SWIFT_APP is set' : `swiftc not found (${NO_TOOLS})`); return; }
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ta-mac-app-real-')));
  try {
    const root = path.join(dir, 'project');
    fs.mkdirSync(path.join(root, 'apps', 'macos'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'VERSION.json'), path.join(root, 'VERSION.json'));
    fs.writeFileSync(path.join(root, 'apps', 'macos', 'main.swift'), [
      'import AppKit', 'import WebKit',
      'if CommandLine.arguments.contains("--self-test") {',
      '    let ok = WKWebViewConfiguration().websiteDataStore.isPersistent',
      '    print(ok ? "ok   data store" : "FAIL data store"); print(ok ? "1 passed, 0 failed" : "0 passed, 1 failed"); exit(ok ? 0 : 1)',
      '}',
      'exit(3)', '',
    ].join('\n'));
    const preview = path.join(dir, 'preview.png');
    const result = await buildApp({ root, tmpDir: dir, iconPreview: preview, log: () => {} });
    const app = path.join(root, 'dist', 'T-Agent.app');
    const exe = path.join(app, 'Contents', 'MacOS', 'T-Agent');
    assert.deepEqual(childProcess.execFileSync('lipo', ['-archs', exe], { encoding: 'utf8' }).trim().split(/\s+/).sort(), ['arm64', 'x86_64']);
    childProcess.execFileSync('codesign', ['--verify', '--strict', app]);
    const plist = JSON.parse(childProcess.execFileSync('plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' }));
    assert.equal(plist.CFBundleIdentifier, 'local.t-agent.app');
    assert.equal(plist.CFBundleVersion, require('../VERSION.json').app_version);
    assert.equal(result.selfTest, 'passed (1 passed, 0 failed)');
    assert.ok(fs.statSync(path.join(app, 'Contents', 'Resources', 'AppIcon.icns')).size > 10000);
    assert.equal(childProcess.execFileSync('sips', ['-g', 'pixelWidth', preview], { encoding: 'utf8' }).trim().split(/\s+/).pop(), '1024');
    // The installed copy keeps a valid signature (an injected home folder, never the real ~/Applications).
    const home = path.join(dir, 'home');
    fs.mkdirSync(home);
    const dest = await installApp({ app, home, log: () => {} });
    childProcess.execFileSync('codesign', ['--verify', '--strict', dest]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
