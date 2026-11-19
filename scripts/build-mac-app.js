#!/usr/bin/env node
// Builds dist/T-Agent.app, the native macOS front end of T-Agent, from apps/macos/*.swift with the command line tools only (no Xcode project), and
// optionally installs it into ~/Applications. Run by the person (`npm run build:mac-app`), and by the server after an update when an installed
// app's shell code changed (services/mac-app-autobuild.js, with --install and the host architecture); install.sh and the update never run it.
// See "Building and installing" and "Automatic rebuild after an update" in docs/design/mac-app.md.
//
//   npm run build:mac-app                       universal (x86_64 + arm64) dist/T-Agent.app
//   npm run build:mac-app -- --arch arm64       one architecture (faster while developing)
//   npm run build:mac-app -- --install          build, then copy to ~/Applications/T-Agent.app
//   npm run build:mac-app -- --icon-preview <file.png>   also write the 1024 px icon there
//
// Steps: find swiftc safely (lib/swift-toolchain.js: never the /usr/bin/swiftc stub, which opens the install dialog on a Mac without the tools);
// compile the sorted sources once per architecture (`-O -swift-version 5 -target <arch>-apple-macos12.0 -framework AppKit -framework WebKit`) and
// draw the icon (scripts/mac-app/make-icon.swift -> .iconset -> `iconutil -c icns`), all at the same time; `lipo -create` the universal executable;
// lay out the bundle with Info.plist (written here, checked with `plutil -lint`) and PkgInfo; ad-hoc sign it (`codesign --force --deep --sign -
// --timestamp=none`); verify it (`codesign --verify --strict`, `lipo -archs`); run `T-Agent --self-test` when the host architecture was built and
// the sources support that flag (the GUI is never launched); then replace dist/T-Agent.app in one step (the bundle is staged next to it).
// Info.plist carries TAgentSourceHash, the hash of the build inputs (lib/mac-app-source.js), read before compiling.
// Intermediate files go to a temporary folder that is removed at the end.
//
// TA_MAC_APP_HOME (tests only) replaces the home folder that --install copies into.
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findSwiftToolchain, firstLine } = require('../lib/swift-toolchain');
const { INFO_KEY, appSources, hashInputs } = require('../lib/mac-app-source');

const ROOT = path.resolve(__dirname, '..');
const ICON_SOURCE = path.join(__dirname, 'mac-app', 'make-icon.swift');
const APP_NAME = 'T-Agent';
const BUNDLE_ID = 'local.t-agent.app';
const URL_SCHEME = 't-agent';
const MIN_MACOS = '12.0';
const ARCHS = ['x86_64', 'arm64'];
const COMPILE_TIMEOUT_MS = 15 * 60 * 1000;
const TOOL_TIMEOUT_MS = 2 * 60 * 1000;
const SELF_TEST_TIMEOUT_MS = 2 * 60 * 1000;
const NO_TOOLS = 'Install the Xcode command line tools: xcode-select --install';
const ICON_FILES = [
  ['icon_16x16', 16], ['icon_16x16@2x', 32], ['icon_32x32', 32], ['icon_32x32@2x', 64], ['icon_128x128', 128],
  ['icon_128x128@2x', 256], ['icon_256x256', 256], ['icon_256x256@2x', 512], ['icon_512x512', 512], ['icon_512x512@2x', 1024],
];

class BuildError extends Error {}

// process.arch -> the architecture name of swiftc and lipo.
const archName = arch => (arch === 'x64' ? 'x86_64' : arch);

function parseArgs(argv) {
  const options = { archs: ARCHS.slice(), install: false, iconPreview: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++index];
      if (!next) throw new BuildError(`${arg.split('=')[0]} needs a value`);
      return next;
    };
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--install') options.install = true;
    else if (arg === '--arch' || arg.startsWith('--arch=')) {
      const arch = value();
      if (!ARCHS.includes(arch)) throw new BuildError(`Unknown architecture "${arch}"; use --arch x86_64 or --arch arm64`);
      options.archs = [arch];
    } else if (arg === '--icon-preview' || arg.startsWith('--icon-preview=')) options.iconPreview = path.resolve(value());
    else throw new BuildError(`Unknown option "${arg}" (see --help)`);
  }
  return options;
}

const USAGE = `Usage: npm run build:mac-app [-- options]
  --arch x86_64|arm64     build one architecture instead of both
  --install               then copy the app to ~/Applications/T-Agent.app
  --icon-preview <file>   also write the 1024 px icon to <file>
`;

const xml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// A property list value as XML, indented by `depth` tabs.
function plistValue(value, depth) {
  const pad = '\t'.repeat(depth);
  if (value === true || value === false) return `${pad}<${value}/>`;
  if (Array.isArray(value)) return [`${pad}<array>`, ...value.map(item => plistValue(item, depth + 1)), `${pad}</array>`].join('\n');
  if (value && typeof value === 'object') {
    const lines = [`${pad}<dict>`];
    for (const [key, item] of Object.entries(value)) lines.push(`${pad}\t<key>${xml(key)}</key>`, plistValue(item, depth + 1));
    lines.push(`${pad}</dict>`);
    return lines.join('\n');
  }
  return `${pad}<string>${xml(value)}</string>`;
}

// The keys of Contents/Info.plist (the contract of the app: identity, URL scheme, microphone text, category, minimum system), and the hash
// of the build inputs when given (TAgentSourceHash: services/mac-app-autobuild.js rebuilds an installed app whose value differs).
function infoDictionary(version, sourceHash = null) {
  return {
    CFBundleDevelopmentRegion: 'en',
    CFBundleDisplayName: APP_NAME,
    CFBundleExecutable: APP_NAME,
    CFBundleIconFile: 'AppIcon',
    CFBundleIdentifier: BUNDLE_ID,
    CFBundleInfoDictionaryVersion: '6.0',
    CFBundleName: APP_NAME,
    CFBundlePackageType: 'APPL',
    CFBundleShortVersionString: version,
    CFBundleVersion: version,
    CFBundleURLTypes: [{ CFBundleURLName: BUNDLE_ID, CFBundleURLSchemes: [URL_SCHEME] }],
    LSApplicationCategoryType: 'public.app-category.developer-tools',
    LSMinimumSystemVersion: MIN_MACOS,
    NSHighResolutionCapable: true,
    NSMicrophoneUsageDescription: 'T-Agent uses the microphone for voice input.',
    NSPrincipalClass: 'NSApplication',
    // The page is served over plain http on this Mac (127.0.0.1) or the local network.
    NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
    ...(sourceHash ? { [INFO_KEY]: sourceHash } : {}),
  };
}

function infoPlist(version, sourceHash = null) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    plistValue(infoDictionary(version, sourceHash), 0),
    '</plist>',
    '',
  ].join('\n');
}

function readVersion(root) {
  let version;
  try { version = JSON.parse(fs.readFileSync(path.join(root, 'VERSION.json'), 'utf8')).app_version; } catch (error) {
    throw new BuildError(`Cannot read the version from VERSION.json: ${error.message}`);
  }
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw new BuildError(`VERSION.json has no valid app_version (${version})`);
  return version;
}

// `run(file, args, options)` -> { error, code, stdout, stderr }; never rejects. A command name is looked up in options.env.PATH.
function createRunner(env) {
  return (file, args, options = {}) => new Promise(resolve => {
    try {
      childProcess.execFile(file, args, { maxBuffer: 16 * 1024 * 1024, env, timeout: TOOL_TIMEOUT_MS, ...options }, (error, stdout, stderr) => resolve({
        error, code: error ? (typeof error.code === 'number' ? error.code : null) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''),
      }));
    } catch (error) { resolve({ error, code: null, stdout: '', stderr: '' }); }
  });
}

// The lines of a compiler's output worth showing: its errors (at most 20), else its last lines.
function errorLines(text) {
  const lines = String(text || '').split('\n').map(line => line.trimEnd()).filter(Boolean);
  const errors = lines.filter(line => /\berror\b/i.test(line));
  return (errors.length ? errors : lines.slice(-10)).slice(0, 20).join('\n');
}

// Runs a tool that must succeed; throws a BuildError naming it otherwise.
async function must(run, label, file, args, options) {
  const result = await run(file, args, options);
  if (result.error) {
    if (result.error.code === 'ENOENT') throw new BuildError(`${path.basename(file)} was not found. ${NO_TOOLS}`);
    const detail = result.error.killed ? 'timed out' : (errorLines(result.stderr || result.stdout) || result.error.message);
    throw new BuildError(`${label} failed: ${detail}`);
  }
  return result;
}

// Builds the bundle and puts it at <distDir>/T-Agent.app. Every path and tool location can be replaced (tests). Resolves
// { app, version, archs, seconds, selfTest: 'passed' | 'skipped: ...', sourceHash }.
async function buildApp({
  root = ROOT,
  sourceDir = path.join(root, 'apps', 'macos'),
  distDir = path.join(root, 'dist'),
  iconSource = ICON_SOURCE,
  buildScript = __filename,
  archs = ARCHS.slice(),
  iconPreview = null,
  env = process.env,
  platform = process.platform,
  hostArch = archName(process.arch),
  xcodeSelect,
  xcrun,
  tmpDir = os.tmpdir(),
  pid = process.pid,
  log = message => console.log(message),
  now = Date.now,
} = {}) {
  const started = now();
  if (platform !== 'darwin') throw new BuildError('The Mac app can only be built on macOS');
  const version = readVersion(root);
  const sources = appSources(sourceDir);
  if (!sources.some(file => path.basename(file) === 'main.swift')) {
    throw new BuildError(`No app sources: ${path.relative(root, sourceDir) || sourceDir} needs main.swift (and the other *.swift files of the app)`);
  }
  // The hash of exactly the files this build compiles, read before compiling (lib/mac-app-source.js).
  let sourceHash;
  try { sourceHash = hashInputs({ sources, buildScript, iconSource }); } catch (error) { throw new BuildError(`Cannot read the build inputs: ${error.message}`); }
  const run = createRunner(env);
  const toolchain = await findSwiftToolchain(run, { xcodeSelect, xcrun });
  if (!toolchain) throw new BuildError(`swiftc was not found. ${NO_TOOLS}`);
  const compileEnv = { ...env, ...(toolchain.sdkRoot ? { SDKROOT: toolchain.sdkRoot } : {}) };
  log(`Building ${APP_NAME}.app ${version} for ${archs.join(' + ')} from ${sources.length} Swift file(s) with ${toolchain.swiftc}`);

  const work = fs.mkdtempSync(path.join(tmpDir, 'ta-mac-app-'));
  fs.mkdirSync(distDir, { recursive: true });
  const stagingRoot = path.join(distDir, `.build-${pid}`);
  fs.rmSync(stagingRoot, { recursive: true, force: true });
  try {
    // 1. The executables (one per architecture) and the icon, at the same time.
    const compileArch = async arch => {
      const out = path.join(work, `${APP_NAME}-${arch}`);
      const result = await run(toolchain.swiftc, [
        '-O', '-swift-version', '5', '-target', `${arch}-apple-macos${MIN_MACOS}`, '-framework', 'AppKit', '-framework', 'WebKit', ...sources, '-o', out,
      ], { env: compileEnv, timeout: COMPILE_TIMEOUT_MS });
      if (result.error) return { arch, error: result.error.killed ? 'timed out' : (errorLines(result.stderr || result.stdout) || result.error.message) };
      return { arch, out };
    };
    const icon = (async () => {
      const tool = path.join(work, 'make-icon');
      await must(run, 'Building the icon tool', toolchain.swiftc, ['-Onone', '-swift-version', '5', '-framework', 'AppKit', iconSource, '-o', tool],
        { env: compileEnv, timeout: COMPILE_TIMEOUT_MS });
      const iconset = path.join(work, 'AppIcon.iconset');
      await must(run, 'Drawing the icon', tool, [iconset]);
      const missing = ICON_FILES.map(([name]) => `${name}.png`).filter(name => !fs.existsSync(path.join(iconset, name)));
      if (missing.length) throw new BuildError(`Drawing the icon failed: missing ${missing.join(', ')}`);
      const icns = path.join(work, 'AppIcon.icns');
      await must(run, 'iconutil', 'iconutil', ['-c', 'icns', iconset, '-o', icns]);
      if (!fs.existsSync(icns)) throw new BuildError('iconutil failed: no AppIcon.icns was written');
      return { icns, preview: path.join(iconset, 'icon_512x512@2x.png') };
    })();
    // Both finish before anything is reported, so no compiler still writes into the temporary folder when it is removed.
    const [compiled, drawn] = await Promise.all([Promise.all(archs.map(compileArch)), icon.then(value => ({ value }), failure => ({ failure }))]);
    const failed = compiled.filter(item => item.error);
    if (failed.length) {
      const built = compiled.filter(item => !item.error).map(item => item.arch);
      // The same error for every architecture (a mistake in the source) is shown once.
      const groups = new Map();
      for (const item of failed) groups.set(item.error, [...(groups.get(item.error) || []), item.arch]);
      const lines = [...groups].map(([text, names]) => `Could not build for ${names.join(' and ')}:\n${text}`);
      if (built.length) lines.push(`Build only ${built.join(' and ')} with: npm run build:mac-app -- --arch ${built[0]}`);
      throw new BuildError(lines.join('\n'));
    }
    if (drawn.failure) throw drawn.failure;
    const { icns, preview } = drawn.value;

    // 2. The bundle, staged next to its final place.
    const app = path.join(stagingRoot, `${APP_NAME}.app`);
    const contents = path.join(app, 'Contents');
    fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
    fs.mkdirSync(path.join(contents, 'Resources'), { recursive: true });
    const executable = path.join(contents, 'MacOS', APP_NAME);
    if (compiled.length > 1) await must(run, 'lipo', 'lipo', ['-create', '-output', executable, ...compiled.map(item => item.out)]);
    else fs.copyFileSync(compiled[0].out, executable);
    fs.chmodSync(executable, 0o755);
    fs.copyFileSync(icns, path.join(contents, 'Resources', 'AppIcon.icns'));
    const plist = path.join(contents, 'Info.plist');
    fs.writeFileSync(plist, infoPlist(version, sourceHash));
    fs.writeFileSync(path.join(contents, 'PkgInfo'), 'APPL????');
    await must(run, 'plutil -lint', 'plutil', ['-lint', plist]);

    // 3. Ad-hoc signature and checks.
    await must(run, 'codesign', 'codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', app]);
    await must(run, 'codesign --verify', 'codesign', ['--verify', '--strict', app]);
    const lipo = await must(run, 'lipo -archs', 'lipo', ['-archs', executable]);
    const found = lipo.stdout.trim().split(/\s+/).filter(Boolean).sort();
    if (found.join(' ') !== archs.slice().sort().join(' ')) {
      throw new BuildError(`The executable has the architectures "${found.join(' ')}" instead of "${archs.join(' ')}"`);
    }

    // 4. The self-test: pure logic checks of the app, no window, no network. Only for the host architecture, and only when the sources have it
    // (an app without the flag would open its window).
    let selfTest;
    const supportsSelfTest = sources.some(file => fs.readFileSync(file, 'utf8').includes('--self-test'));
    if (!archs.includes(hostArch)) selfTest = `skipped: this Mac runs ${hostArch}`;
    else if (!supportsSelfTest) selfTest = 'skipped: the app sources do not support --self-test yet';
    else {
      const home = path.join(work, 'self-test-home');
      fs.mkdirSync(home);
      const result = await run(executable, ['--self-test'], { env: { ...env, TAGENT_HOME: home, T_AGENT_DATA_DIR: home }, timeout: SELF_TEST_TIMEOUT_MS });
      const summary = result.stdout.split('\n').map(line => line.trim()).filter(line => /^\d+ passed, \d+ failed$/.test(line)).pop();
      if (result.error) {
        const failures = result.stdout.split('\n').filter(line => /^FAIL/.test(line)).slice(0, 20).join('\n');
        throw new BuildError(`The self-test of the built app failed${result.error.killed ? ' (timed out)' : ''}: ${summary || firstLine(result.stderr) || result.error.message}${failures ? `\n${failures}` : ''}`);
      }
      selfTest = `passed${summary ? ` (${summary})` : ''}`;
    }
    if (iconPreview) {
      fs.mkdirSync(path.dirname(iconPreview), { recursive: true });
      fs.copyFileSync(preview, iconPreview);
    }

    // 5. Replace the old bundle: two renames on the same disk, the old copy is removed afterwards.
    const final = path.join(distDir, `${APP_NAME}.app`);
    const old = path.join(stagingRoot, `${APP_NAME}.old.app`);
    if (fs.existsSync(final)) fs.renameSync(final, old);
    fs.renameSync(app, final);
    const seconds = (now() - started) / 1000;
    log(`Built ${final} (${version}, ${found.join(' + ')}) in ${seconds.toFixed(1)} s; self-test ${selfTest}`);
    return { app: final, version, archs: found, seconds, selfTest, sourceHash };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

// The CFBundleIdentifier of an Info.plist (XML, or binary through plutil), or null when it cannot be read.
async function bundleIdOf(plist, run) {
  let text;
  try { text = fs.readFileSync(plist, 'utf8'); } catch { return null; }
  if (text.startsWith('bplist')) {
    const converted = await run('plutil', ['-convert', 'xml1', '-o', '-', plist]);
    if (converted.error) return null;
    text = converted.stdout;
  }
  const match = text.match(/<key>CFBundleIdentifier<\/key>\s*<string>([^<]*)<\/string>/);
  return match ? match[1].trim() : null;
}

// Copies <distDir>/T-Agent.app to <home>/Applications/T-Agent.app. An existing copy is replaced only when it is this app (bundle id
// local.t-agent.app); anything else there is left alone and the install stops. Never writes to /Applications. Resolves the installed path.
async function installApp({
  app = path.join(ROOT, 'dist', `${APP_NAME}.app`),
  home = os.homedir(),
  env = process.env,
  pid = process.pid,
  log = message => console.log(message),
} = {}) {
  const run = createRunner(env);
  if (!fs.existsSync(path.join(app, 'Contents', 'Info.plist'))) throw new BuildError(`Nothing to install: ${app} was not built`);
  const folder = path.join(home, 'Applications');
  const dest = path.join(folder, `${APP_NAME}.app`);
  const shown = home === os.homedir() ? `~/Applications/${APP_NAME}.app` : dest;
  let existing = null;
  try { existing = fs.lstatSync(dest); } catch { /* not there */ }
  if (existing) {
    const id = existing.isDirectory() ? await bundleIdOf(path.join(dest, 'Contents', 'Info.plist'), run) : null;
    if (id !== BUNDLE_ID) {
      throw new BuildError(`${shown} exists but is not this app (bundle id ${id ? `"${id}"` : 'unknown'}, expected "${BUNDLE_ID}"). Move it away, then install again.`);
    }
  }
  fs.mkdirSync(folder, { recursive: true });
  const temporary = path.join(folder, `.${APP_NAME}.app.install-${pid}`);
  const old = path.join(folder, `.${APP_NAME}.app.old-${pid}`);
  fs.rmSync(temporary, { recursive: true, force: true });
  try {
    fs.cpSync(app, temporary, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    if (existing) fs.renameSync(dest, old);
    fs.renameSync(temporary, dest);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
    fs.rmSync(old, { recursive: true, force: true });
  }
  // A copy made from a downloaded checkout could carry the quarantine flag, which would make Gatekeeper refuse the ad-hoc signed app. "No such
  // xattr" when there is none is not an error.
  const cleared = await run('xattr', ['-dr', 'com.apple.quarantine', dest]);
  if (cleared.error && !/no such xattr/i.test(cleared.stderr)) log(`Note: could not clear the quarantine flag: ${firstLine(cleared.stderr) || cleared.error.message}`);
  log(`Installed ${shown}. Open it with: open ${shown.includes(' ') ? `"${shown}"` : shown}`);
  log('The T-Agent web service keeps running when the app quits, and browsers can still use it.');
  return dest;
}

// `buildOptions` replaces paths and tool locations of buildApp (tests only).
async function main(argv = process.argv.slice(2), { env = process.env, log = message => console.log(message), error = message => console.error(message), buildOptions = {} } = {}) {
  try {
    const options = parseArgs(argv);
    if (options.help) { log(USAGE.trimEnd()); return 0; }
    const built = await buildApp({ ...buildOptions, archs: options.archs, iconPreview: options.iconPreview, env, log });
    if (options.install) await installApp({ app: built.app, home: env.TA_MAC_APP_HOME || os.homedir(), env, log });
    return 0;
  } catch (failure) {
    error(failure instanceof BuildError ? failure.message : (failure && failure.stack) || String(failure));
    return 1;
  }
}

if (require.main === module) main().then(code => { process.exitCode = code; });

module.exports = { buildApp, installApp, main, parseArgs, infoPlist, infoDictionary, appSources, BuildError, ARCHS, BUNDLE_ID, APP_NAME, ICON_FILES, NO_TOOLS };
