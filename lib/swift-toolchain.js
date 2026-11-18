// Finding swiftc without the system's install dialog, shared by the T-Attention desktop window launcher (services/attention-widget.js) and the
// T-Agent.app build (scripts/build-mac-app.js).
// See "T-Attention desktop window (macOS)" in docs/design/attention-desktop-window.md and "Building and installing" in docs/design/mac-app.md.
//
// `/usr/bin/swiftc` (and every other developer tool in /usr/bin) is a stub: on a Mac without the command line tools, running it opens the dialog
// that offers to install them. So swiftc is never run by that name: `xcode-select -p` must name a developer folder first, then `xcrun --find
// swiftc` gives the real path. swiftc run by its own path (not through the xcrun shim) does not know where the macOS SDK is and fails with
// "unable to load standard library for target ..."; xcrun tells it through SDKROOT, so callers pass `sdkRoot` the same way.
const path = require('node:path');

const XCODE_SELECT = '/usr/bin/xcode-select';
const XCRUN = '/usr/bin/xcrun';
const LOOKUP_TIMEOUT_MS = 10 * 1000;

const firstLine = text => String(text || '').split('\n').map(line => line.trim()).find(Boolean) || '';

// `run(file, args, options)` resolves { error, stdout, stderr } and never rejects. Resolves { swiftc, sdkRoot } (sdkRoot may be null), or null when
// the command line tools are missing. `xcodeSelect` / `xcrun` are other paths for those two tools (tests only).
async function findSwiftToolchain(run, { xcodeSelect = XCODE_SELECT, xcrun = XCRUN, timeout = LOOKUP_TIMEOUT_MS } = {}) {
  const developer = await run(xcodeSelect, ['-p'], { timeout });
  if (developer.error || !firstLine(developer.stdout)) return null;
  const found = await run(xcrun, ['--find', 'swiftc'], { timeout });
  const swiftc = firstLine(found.stdout);
  if (found.error || !path.isAbsolute(swiftc)) return null;
  const sdk = await run(xcrun, ['--sdk', 'macosx', '--show-sdk-path'], { timeout });
  const sdkPath = firstLine(sdk.stdout);
  return { swiftc, sdkRoot: !sdk.error && path.isAbsolute(sdkPath) ? sdkPath : null };
}

module.exports = { findSwiftToolchain, firstLine, XCODE_SELECT, XCRUN, LOOKUP_TIMEOUT_MS };
