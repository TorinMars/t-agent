// lib/browser-error-hints.js ("Errors with a next step" in docs/design/browser-extension.md): every error code that the extension, the bridge,
// the recordings, the relay and tcli can answer has a hint. The codes are collected from the sources, so a new code without a hint fails here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { HINTS, hintFor } = require('../lib/browser-error-hints');
const { EXTENSION_STATUS } = require('../services/browser-bridge');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const all = (text, pattern) => [...text.matchAll(pattern)].map(match => match[1]);

function collectCodes() {
  const codes = new Set(Object.keys(EXTENSION_STATUS));
  // The extension: fail('CODE', ...), Error('CODE: ...'), and the codes its result envelope recognises.
  for (const file of fs.readdirSync(path.join(root, 'extensions/chrome')).filter(name => name.endsWith('.js'))) {
    const text = read(`extensions/chrome/${file}`);
    for (const code of all(text, /\bfail\('([A-Z][A-Z0-9_]+)'/g)) codes.add(code);
    for (const code of all(text, /Error\([`'"]([A-Z][A-Z0-9_]+):/g)) codes.add(code);
    for (const group of all(text, /e\.message\.match\(\/\(([A-Z_|]+)\)/g)) for (const code of group.split('|')) codes.add(code);
  }
  // The server: BridgeError / RecordingError codes, `error: 'CODE'` answers, the relay's TCLI_ codes, the filter errors, tcli's own.
  for (const file of ['services/browser-bridge.js', 'services/browser-recordings.js', 'routes/browser-ext.js', 'lib/browser-recording-query.js', 'scripts/tcli.js', 'scripts/tcli-browser.js', 'scripts/tcli-browser-records.js']) {
    const text = read(file);
    for (const code of all(text, /(?:BridgeError|RecordingError)\('([A-Z][A-Z0-9_]+)'/g)) codes.add(code);
    for (const code of all(text, /\berror: '([A-Z][A-Z0-9_]+)'/g)) codes.add(code);
    for (const code of all(text, /this\.code = '([A-Z][A-Z0-9_]+)'/g)) codes.add(code);
    for (const code of all(text, /\? [^:;\n]+ : '([A-Z][A-Z0-9]*_[A-Z0-9_]+)'/g)) codes.add(code); // a fallback code: `... ? error.code : 'EXTENSION_ERROR'`
  }
  for (const key of all(read('routes/browser-ext.js'), /^\s+([A-Z_]+): \[\d{3}, /gm)) codes.add(`TCLI_${key}`);
  // Not reachable from tcli browser: the pairing route's own refusal of a web page, and the OSS download of scripts/tcli.js.
  for (const code of ['ORIGIN_NOT_ALLOWED', 'INCOMPLETE_DOWNLOAD']) codes.delete(code);
  return codes;
}

test('every error code tcli browser can meet has a hint', () => {
  const codes = collectCodes();
  for (const expected of ['ELEMENT_NOT_INTERACTABLE', 'REF_NOT_FOUND', 'TAB_NOT_ALLOWED', 'BROWSER_TIMEOUT', 'DEBUGGER_BUSY', 'UNKNOWN_METHOD', 'ELEMENT_NOT_FOUND', 'BROWSER_NOT_CONNECTED', 'TIMEOUT', 'INTERNAL', 'BAD_FILTER', 'TCLI_AUTH_INVALID', 'NETWORK', 'FRAME_NOT_FOUND', 'EXTENSION_ERROR', 'INTERNAL_ERROR']) {
    assert.ok(codes.has(expected), `${expected} is found in the sources`);
  }
  const missing = [...codes].filter(code => !hintFor(code));
  assert.deepEqual(missing, [], `add a hint to lib/browser-error-hints.js for: ${missing.join(', ')}`);
});

test('the hints: short single lines; unknown codes have none', () => {
  for (const [code, hint] of Object.entries(HINTS)) {
    assert.match(code, /^[A-Z][A-Z0-9_]+$/);
    assert.ok(hint.length > 10 && hint.length <= 220 && !/\n/.test(hint), code);
  }
  assert.match(hintFor('ELEMENT_NOT_INTERACTABLE'), /scroll to it .*close the dialog in front of it.*snapshot/);
  assert.match(hintFor('REF_NOT_FOUND'), /new one \(tcli browser snapshot\)/);
  assert.match(hintFor('BROWSER_TIMEOUT'), /--timeout/);
  assert.match(hintFor('UNKNOWN_METHOD'), /reload it in chrome:\/\/extensions/);
  assert.equal(hintFor('NOT_A_CODE'), null);
  assert.equal(hintFor('constructor'), null);
  assert.equal(hintFor(undefined), null);
});
