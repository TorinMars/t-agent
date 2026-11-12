#!/usr/bin/env node
// Regenerate extensions/chrome/redact.js from lib/browser-redact.js so the browser extension redacts exactly like the
// server. The extension is an ES module with no build step and no require(), so the rule cannot be shared by import; it
// is copied here instead, with only the exports changed. Also refreshes the standalone vector file
// extensions/chrome/redact-vectors.json from the canonical fixture.
//
//   node scripts/sync-extension-redact.js          rewrite the generated files
//   node scripts/sync-extension-redact.js --check   exit non-zero if they are out of date (used by the test)
//
// The authoritative rule and its vectors live in lib/browser-redact.js and test/fixtures/browser-redact-vectors.json.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'lib', 'browser-redact.js');
const OUT_JS = path.join(ROOT, 'extensions', 'chrome', 'redact.js');
const CANONICAL = path.join(ROOT, 'test', 'fixtures', 'browser-redact-vectors.json');
const OUT_VECTORS = path.join(ROOT, 'extensions', 'chrome', 'redact-vectors.json');

const HEADER = `// The redaction rule of the browser extension (contract section 5), applied before anything leaves the browser.
// GENERATED from lib/browser-redact.js by scripts/sync-extension-redact.js: the body is copied verbatim and only the
// exports differ (ESM here, CommonJS there), so the extension and the server redact identically. Do not edit the rule
// only here; change lib/browser-redact.js and run \`node scripts/sync-extension-redact.js\`. The same vectors test both
// sides (test/fixtures/browser-redact-vectors.json).
`;

const FOOTER = `
// ---- Extension ESM API: the same rule as the server (lib/browser-redact.js) ----
export const redact = redactDeep;        // redact an arbitrary captured value (object graph, headers map/array, strings)
export const headers = redactHeaders;    // redact a header map {name: value} or array [{name, value}]
export const url = redactUrl;            // keep a URL, redact its query and #fragment
export const mask = mark;                // "<redacted:N>" for a string of length N
export { redactUrl, redactHeaders, redactJson, redactBody, redactDeep, redactQuery, isRedacted, looksLikeJwt, words, keyIsSecret, headerIsSecret, redactWhole, scanText };

// Cut a value to a byte budget, reporting whether it was shortened (used by the capture buffer and body limits).
export function cut(value, bytes) {
  const data = new TextEncoder().encode(String(value));
  return { text: new TextDecoder().decode(data.slice(0, bytes), { stream: true }), truncated: data.length > bytes };
}
`;

function body() {
  const src = fs.readFileSync(SOURCE, 'utf8').split('\n');
  const firstCode = src.findIndex(line => /^const HEADER_ALWAYS\b/.test(line));
  const exportLine = src.findIndex(line => /^module\.exports\b/.test(line));
  if (firstCode < 0 || exportLine < 0) throw new Error('cannot find the rule body in lib/browser-redact.js');
  return src.slice(firstCode, exportLine).join('\n').replace(/\n+$/, '\n');
}

function generatedJs() {
  return `${HEADER}\n${body()}\n${FOOTER}`;
}

// A compact standalone vector file for running the extension on its own: the JSON cases plus the secret keys, each as an
// { input, expected } pair taken straight from the canonical fixture's redacted output (never re-derived from redact()).
function generatedVectors() {
  const v = JSON.parse(fs.readFileSync(CANONICAL, 'utf8'));
  const cases = [];
  for (const e of v.keys || []) cases.push({ input: { [e.name]: e.value }, expected: { [e.name]: e.secret ? markFor(e.value) : e.value } });
  for (const e of v.json || []) cases.push({ input: e.in, expected: e.out });
  return JSON.stringify({ note: 'Generated from test/fixtures/browser-redact-vectors.json by scripts/sync-extension-redact.js', cases }, null, 2) + '\n';
}

function markFor(value) {
  if (value === null || typeof value === 'boolean') return value; // never redacted
  const len = typeof value === 'number' ? String(value).length : (typeof value === 'string' ? value.length : JSON.stringify(value).length);
  return `<redacted:${len}>`;
}

const wanted = { [OUT_JS]: generatedJs(), [OUT_VECTORS]: generatedVectors() };
const check = process.argv.includes('--check');
let stale = 0;
for (const [file, content] of Object.entries(wanted)) {
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (current === content) continue;
  stale += 1;
  if (check) {
    console.error(`out of date: ${path.relative(ROOT, file)} — run \`node scripts/sync-extension-redact.js\``);
  } else {
    fs.writeFileSync(file, content);
    console.log(`wrote ${path.relative(ROOT, file)}`);
  }
}
if (check && stale) process.exit(1);
if (!check && !stale) console.log('extension redaction already in sync');
