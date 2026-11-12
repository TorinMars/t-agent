// The redaction rule of the browser extension (contract section 5), applied before anything leaves the browser.
// GENERATED from lib/browser-redact.js by scripts/sync-extension-redact.js: the body is copied verbatim and only the
// exports differ (ESM here, CommonJS there), so the extension and the server redact identically. Do not edit the rule
// only here; change lib/browser-redact.js and run `node scripts/sync-extension-redact.js`. The same vectors test both
// sides (test/fixtures/browser-redact-vectors.json).

const HEADER_ALWAYS = new Set(['cookie', 'set-cookie', 'authorization', 'proxy-authorization']);
const HEADER_SECRET = /(token|secret|session|passw|api[-_]?key|auth|signature|csrf|xsrf)/i;
const KEY_SECRET = /(token|secret|session|passw|pwd|api[-_]?key|auth|signature|csrf|xsrf|cookie|ticket|code_verifier)/i;
const SAFE_WORDS = new Set(['author', 'authors', 'authored', 'authoring', 'authorship', 'coauthor', 'coauthors', 'authority', 'authorities']);
const COUNT_WORDS = new Set(['tokens', 'sessions']);
const URL_HEADERS = new Set(['referer', 'location', 'content-location', ':path']);
const JWT = /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/;
const BEARER = /\bbearer\s+[\w\-.~+/]+=*/i;
const REDACTED = /^<redacted:\d+>$/;
const MAX_DEPTH = 64;

const mark = value => `<redacted:${value.length}>`;
const isRedacted = value => typeof value === 'string' && REDACTED.test(value);

// The words of a name: `X-CSRF-Token` -> x csrf token, `accessToken` -> access token, `max_tokens` -> max tokens.
function words(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// Whether a name is secret: its words without SAFE_WORDS, joined with "_" (so `apiKey` and `x-api-key` still match api[-_]?key), match the
// pattern. A number is kept when every word that matches on its own is a count word (`max_tokens: 1024`).
function nameIsSecret(name, pattern, value) {
  const kept = words(name).filter(word => !SAFE_WORDS.has(word));
  if (!pattern.test(kept.join('_'))) return false;
  if (typeof value === 'number' || (typeof value === 'string' && /^\d{1,9}$/.test(value))) {
    const matching = kept.filter(word => pattern.test(word));
    if (matching.length && matching.every(word => COUNT_WORDS.has(word))) return false;
  }
  return true;
}

// Whether the value under this query, JSON or form name is redacted (booleans and null never are).
const keyIsSecret = (name, value) => value !== null && typeof value !== 'boolean' && nameIsSecret(name, KEY_SECRET, value);
function headerIsSecret(name) {
  const lower = String(name).toLowerCase();
  return HEADER_ALWAYS.has(lower) || nameIsSecret(lower, HEADER_SECRET);
}

// One value under a secret name: strings, numbers and nested values become "<redacted:N>"; booleans and null stay.
function redactWhole(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return value;
  if (isRedacted(value)) return value;
  if (typeof value === 'string') return mark(value);
  if (typeof value === 'number' || typeof value === 'bigint') return mark(String(value));
  let text;
  try { text = JSON.stringify(value); } catch { text = String(value); }
  return mark(text || '');
}

const looksLikeJwt = value => typeof value === 'string' && JWT.test(value);

// ── Query strings ──
function decodePart(text) {
  try { return decodeURIComponent(text.replace(/\+/g, ' ')); } catch { return text; }
}

// `a=1&token=xyz` -> `a=1&token=<redacted:3>`. The names and the order are kept; only secret values change.
function redactQuery(query) {
  if (!query) return query;
  return query.split('&').map(pair => {
    if (!pair) return pair;
    const eq = pair.indexOf('=');
    if (eq < 0) return pair;
    const name = pair.slice(0, eq);
    const raw = pair.slice(eq + 1);
    if (isRedacted(raw)) return pair;
    const value = decodePart(raw);
    if (keyIsSecret(decodePart(name), value) || looksLikeJwt(value)) return `${name}=${mark(value)}`;
    return pair;
  }).join('&');
}

// A URL with its query (and a `#a=b&c=d` fragment, as OAuth uses for access_token) redacted. Anything that is not a string is returned unchanged.
function redactUrl(url) {
  if (typeof url !== 'string' || !url) return url;
  const hashAt = url.indexOf('#');
  const beforeHash = hashAt >= 0 ? url.slice(0, hashAt) : url;
  let hash = hashAt >= 0 ? url.slice(hashAt + 1) : null;
  const queryAt = beforeHash.indexOf('?');
  const base = queryAt >= 0 ? beforeHash.slice(0, queryAt) : beforeHash;
  const query = queryAt >= 0 ? beforeHash.slice(queryAt + 1) : null;
  if (hash !== null && /^[^=&]+=/.test(hash)) hash = redactQuery(hash);
  return `${base}${query !== null ? `?${redactQuery(query)}` : ''}${hash !== null ? `#${hash}` : ''}`;
}

// ── Headers ──
function redactHeaderValue(name, value) {
  if (value === null || value === undefined) return value;
  const lower = String(name).toLowerCase();
  const text = Array.isArray(value) ? value.join('\n') : String(value);
  if (isRedacted(text)) return text;
  if (headerIsSecret(lower) || BEARER.test(text) || looksLikeJwt(text.trim())) return mark(text);
  if (URL_HEADERS.has(lower)) return redactUrl(text);
  return value;
}

// Headers as an object ({ name: value }) or a list ([{ name, value }], as CDP sends some of them). The same shape comes back.
function redactHeaders(headers) {
  if (!headers || typeof headers !== 'object') return headers;
  if (Array.isArray(headers)) {
    return headers.map(entry => (entry && typeof entry === 'object' && 'name' in entry ? { ...entry, value: redactHeaderValue(entry.name, entry.value) } : entry));
  }
  const out = {};
  for (const [name, value] of Object.entries(headers)) out[name] = redactHeaderValue(name, value);
  return out;
}

// ── JSON values and bodies ──
// Keys at any depth: a secret key's value is replaced whole; other strings are checked for a JWT.
function redactJson(value, depth = 0) {
  if (depth > MAX_DEPTH) return value;
  if (typeof value === 'string') return looksLikeJwt(value) ? mark(value) : value;
  if (Array.isArray(value)) return value.map(item => redactJson(item, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = keyIsSecret(key, item) ? redactWhole(item) : redactJson(item, depth + 1);
    return out;
  }
  return value;
}

const FORM = /^[^\s=&{}[\]"]+=[^\s]*(?:&[^\s=&]+=[^\s]*)*$/;

// A request or response body as text: JSON is parsed, redacted and written back compactly; an urlencoded form keeps its form; any other
// text is left as it is, unless it is a JWT. `mime` helps (application/json, application/x-www-form-urlencoded) but is not required.
function redactBody(body, mime = '') {
  if (typeof body !== 'string' || !body) return body;
  const type = String(mime || '').toLowerCase();
  const trimmed = body.trim();
  if (/json/.test(type) || /^[[{]/.test(trimmed)) {
    try { return JSON.stringify(redactJson(JSON.parse(trimmed))); } catch { /* not JSON after all */ }
  }
  if (/x-www-form-urlencoded/.test(type) || FORM.test(trimmed)) return redactQuery(trimmed);
  return looksLikeJwt(trimmed) ? mark(body) : body;
}

// ── Server only: whole answers and recording items ──
// Not part of the shared vectors: a second, wider pass the server runs over everything it stores (recording items) and over the non-raw answers
// of net.list / net.get / page.fetch, in case the extension missed something. At any depth: `headers` objects get the header rule; url, from, to,
// href and referrer strings the URL rule; body, post_data and data strings the body rule; any secret key its value replaced; the value of an
// `input` / `change` item whose target field looks secret (type password, or a name, id or autocomplete that matches the key rule) is replaced;
// and in every other string a JWT or a "Bearer <token>" found inside the text is replaced too.
const URL_KEYS = new Set(['url', 'from', 'to', 'href', 'referrer', 'document_url']);
const BODY_KEYS = new Set(['body', 'post_data', 'data']);
const JWT_INSIDE = /eyJ[\w-]{2,}\.[\w-]{2,}\.[\w-]{2,}/g;
const BEARER_INSIDE = /\b(bearer)\s+([\w\-.~+/]{8,}=*)/gi;

function scanText(text) {
  if (isRedacted(text)) return text;
  if (looksLikeJwt(text)) return mark(text);
  return text.replace(JWT_INSIDE, match => mark(match)).replace(BEARER_INSIDE, (match, word, token) => (isRedacted(token) ? match : `${word} ${mark(token)}`));
}

function mimeOf(object) {
  if (typeof object.mime === 'string') return object.mime;
  const headers = object.headers;
  if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
    for (const [name, value] of Object.entries(headers)) if (name.toLowerCase() === 'content-type' && typeof value === 'string') return value;
  }
  return '';
}

function secretField(target) {
  if (!target || typeof target !== 'object') return false;
  if (String(target.type || '').toLowerCase() === 'password') return true;
  return ['name', 'id', 'autocomplete'].some(field => typeof target[field] === 'string' && target[field] && keyIsSecret(target[field], 'x'));
}

function redactDeep(value, depth = 0) {
  if (depth > MAX_DEPTH) return value;
  if (typeof value === 'string') return scanText(value);
  if (Array.isArray(value)) return value.map(item => redactDeep(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  const hideValue = 'value' in value && secretField(value.target);
  for (const [key, item] of Object.entries(value)) {
    if (key === 'headers' && item && typeof item === 'object') out[key] = redactDeep(redactHeaders(item), depth + 1);
    else if (key === 'value' && hideValue) out[key] = redactWhole(item);
    else if (URL_KEYS.has(key) && typeof item === 'string') out[key] = scanText(redactUrl(item));
    else if (BODY_KEYS.has(key) && typeof item === 'string') out[key] = scanText(redactBody(item, mimeOf(value)));
    else if (keyIsSecret(key, item)) out[key] = redactWhole(item);
    else out[key] = redactDeep(item, depth + 1);
  }
  return out;
}


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
