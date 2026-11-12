// The save-time safety net for the site-capability library (SITE_HAS_SECRET). A site entry is authored by a model, so
// before it is stored it is redacted with the canonical rule (lib/browser-redact.js, redactJson), and then this guard
// refuses it if a value still looks like a live credential the key-name rule cannot shape: a JWT or bearer token that
// somehow survived, or an opaque provider key / long high-entropy run a model pasted into an example. The guard never
// redacts (redaction keeps lengths and shapes); it only points at the first offending path so the caller can fix it.
//
// It reuses the canonical module's word-based key test (keyIsSecret), so the same names count as secret on both sides
// and safe words like `author` / `authority` are not flagged. Only the opaque-token net below is specific to saving.
const { keyIsSecret, looksLikeJwt, redactJson, isRedacted } = require('./browser-redact');

const MARKER = /^<redacted:\d+>$/;
const BEARER = /\bBearer\s+[\w.~+/=-]{8,}/i;
// A known provider key prefix, or a 32+ character run mixing letters and digits (a live token pasted into an example).
const KNOWN_KEY_PREFIX = /\b(?:sk|pk|rk)[_-](?:live|test|prod)?[_-]?[A-Za-z0-9]{16,}|\b(?:ghp|gho|ghu|ghs|ghr|github_pat|glpat|xox[baprs]|shpat|shpss|npm|AKIA|ASIA|AIza|ya29)[_-][A-Za-z0-9_-]{12,}/;
const LONG_TOKEN = /(?:^|[^A-Za-z0-9_-])([A-Za-z0-9_-]{32,})(?:$|[^A-Za-z0-9_-])/;

const looksLikeBearer = value => typeof value === 'string' && BEARER.test(value);
// A string value that is itself a credential whatever key holds it.
const valueLooksSecret = value => looksLikeJwt(value) || looksLikeBearer(value);

// A string that holds a live-looking opaque token the redaction rule does not catch. Used only to refuse a saved entry.
function looksLikeOpaqueToken(value) {
  if (typeof value !== 'string' || value.length < 20) return false;
  if (KNOWN_KEY_PREFIX.test(value)) return true;
  const run = value.match(LONG_TOKEN);
  return Boolean(run && /[A-Za-z]/.test(run[1]) && /[0-9]/.test(run[1]));
}

// After redaction, the first path (dotted) that still looks like a secret, or null: a surviving JWT / bearer / opaque
// token, or a secret-named key holding a plain non-marker string (an opaque id the shape rule could not mark).
function residualSecretPath(value, path = '') {
  if (typeof value === 'string') return (valueLooksSecret(value) || looksLikeOpaqueToken(value)) ? (path || '<value>') : null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const found = residualSecretPath(value[i], `${path}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const here = path ? `${path}.${key}` : key;
      if (typeof item === 'string' && item && !MARKER.test(item) && keyIsSecret(key, item)) return here;
      const found = residualSecretPath(item, here);
      if (found) return found;
    }
    return null;
  }
  return null;
}

const hasResidualSecret = value => residualSecretPath(value) !== null;

// Redact a site-library entry before it is saved. First the canonical rule (secret-named keys, whole-value JWTs); then,
// because an entry is free-form authored text, any string that still carries a JWT or a bearer token is masked whole
// (the canonical rule only masks bearers inside header values, which an entry does not have). Opaque provider keys and
// high-entropy runs are left for the SITE_HAS_SECRET guard to refuse, since masking them would not tell the author.
function maskLooseSecrets(value) {
  if (typeof value === 'string') return (!isRedacted(value) && valueLooksSecret(value)) ? `<redacted:${value.length}>` : value;
  if (Array.isArray(value)) return value.map(maskLooseSecrets);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskLooseSecrets(item)]));
  return value;
}
const redactEntry = entry => maskLooseSecrets(redactJson(entry));

module.exports = { redactEntry, hasResidualSecret, residualSecretPath, valueLooksSecret, looksLikeOpaqueToken, looksLikeBearer };
