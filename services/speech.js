// Backend of the voice input. The browser streams the microphone straight to Alibaba Cloud Model Studio real-time speech recognition (Fun-ASR), so no audio passes through this server.
// This service only keeps the configuration and hands the browser a short-lived token, so the real API key never leaves the server.
// Configuration is saved per user in system_state, the API key is stored encrypted and never sent back to the frontend. DASHSCOPE_API_KEY in the server environment is used when no key is saved.
const { encryptToken, decryptToken } = require('../lib/token-crypto');

const REGIONS = {
  beijing: { label: 'China (Beijing)', endpoint: 'wss://dashscope.aliyuncs.com/api-ws/v1/inference' },
  singapore: { label: 'Singapore', endpoint: 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference' },
};
const LANGUAGES = { '': 'Auto detect', zh: 'Chinese', en: 'English', ja: 'Japanese', ko: 'Korean' };
const DEFAULT_REGION = 'beijing';
const DEFAULT_MODEL = 'fun-asr-realtime';
const DEFAULT_LANGUAGE = 'zh';
const TOKEN_TTL_SECONDS = 60; // the token only has to survive the WebSocket handshake; a connected session keeps running
const TIMEOUT_MS = 10_000;

class SpeechError extends Error {
  constructor(message, statusCode = 400) { super(message); this.name = 'SpeechError'; this.statusCode = statusCode; }
}
const controls = /[\x00-\x20\x7f]/;
const text = value => (typeof value === 'string' ? value.trim() : '');
const defaults = () => ({ enabled: false, apiKey: '', region: DEFAULT_REGION, endpoint: '', model: DEFAULT_MODEL, language: DEFAULT_LANGUAGE });

function endpointUrl(value) {
  const raw = text(value);
  if (!raw) return '';
  try {
    if (controls.test(raw) || raw.includes('\\')) throw Error();
    const url = new URL(raw);
    if (url.protocol !== 'wss:' || url.username || url.password || url.search || url.hash) throw Error();
    return url.href.replace(/\/+$/, '');
  } catch { throw new SpeechError('The endpoint must be a wss:// URL without credentials or query parameters'); }
}
// The token endpoint lives on the same host as the WebSocket endpoint, over HTTPS.
const tokenUrl = endpoint => `https://${new URL(endpoint).host}/api/v1/tokens?expire_in_seconds=${TOKEN_TTL_SECONDS}`;

function createSpeech({ db, sessionSecret, env = process.env, fetchImpl = (...args) => fetch(...args) }) {
  const key = owner => `speech:${owner}`;
  function read(owner) {
    const base = defaults();
    const row = db.prepare('SELECT value FROM system_state WHERE key = ?').get(key(owner));
    if (!row) return base;
    const stored = JSON.parse(decryptToken(row.value, sessionSecret));
    return {
      ...base, ...stored,
      region: Object.hasOwn(REGIONS, stored.region) ? stored.region : DEFAULT_REGION,
      language: Object.hasOwn(LANGUAGES, stored.language) ? stored.language : DEFAULT_LANGUAGE,
    };
  }
  const envKey = () => text(env.DASHSCOPE_API_KEY);
  const safe = config => ({
    enabled: config.enabled, region: config.region, model: config.model, language: config.language,
    // Echo the custom endpoint (blank = the region default) and also say which address is really in effect.
    endpoint: config.endpoint, effectiveEndpoint: config.endpoint || REGIONS[config.region].endpoint,
    hasApiKey: Boolean(config.apiKey), keySource: config.apiKey ? 'saved' : (envKey() ? 'environment' : 'none'),
    regions: Object.fromEntries(Object.entries(REGIONS).map(([id, item]) => [id, { label: item.label, endpoint: item.endpoint }])),
    languages: LANGUAGES,
  });
  // The settings that voice input really uses; null when it is not available.
  function resolve(owner) {
    const config = read(owner);
    const apiKey = config.apiKey || envKey();
    if (!apiKey || (!config.enabled && config.apiKey)) return null;
    return { apiKey, url: config.endpoint || REGIONS[config.region].endpoint, model: config.model, language: config.language };
  }

  return {
    getConfig: owner => safe(read(owner)),
    saveConfig(owner, body) {
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SpeechError('Invalid voice input configuration');
      const current = read(owner);
      const region = text(body.region) || current.region;
      if (!Object.hasOwn(REGIONS, region)) throw new SpeechError('Unsupported region');
      const language = body.language === undefined ? current.language : text(body.language);
      if (!Object.hasOwn(LANGUAGES, language)) throw new SpeechError('Unsupported language');
      const next = {
        // An empty key keeps the key already saved.
        apiKey: text(body.apiKey) || current.apiKey,
        region, language,
        endpoint: body.endpoint === undefined ? current.endpoint : endpointUrl(body.endpoint),
        model: text(body.model) || DEFAULT_MODEL,
        enabled: body.enabled !== false,
      };
      if (next.apiKey && (controls.test(next.apiKey) || next.apiKey.length > 512)) throw new SpeechError('Invalid API key');
      if (!next.apiKey && !envKey()) throw new SpeechError('Enter the Alibaba Cloud API key');
      if (!/^[\w.\-:/]{1,80}$/.test(next.model)) throw new SpeechError('Invalid model name');
      db.prepare(`INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(key(owner), encryptToken(JSON.stringify(next), sessionSecret));
      return safe(next);
    },
    clearConfig(owner) {
      db.prepare('DELETE FROM system_state WHERE key = ?').run(key(owner));
      return safe(defaults());
    },
    // Asks Alibaba for a short-lived token and returns what the browser needs to open the WebSocket by itself.
    async createToken(owner) {
      const settings = resolve(owner);
      if (!settings) throw new SpeechError('Voice input not configured yet', 409);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const response = await fetchImpl(tokenUrl(settings.url), { method: 'POST', headers: { Authorization: `Bearer ${settings.apiKey}` }, signal: controller.signal });
        if (response.status === 401 || response.status === 403) throw new SpeechError('The speech recognition API key is invalid or lacks permission (keys only work in the region they were created in)', 502);
        if (response.status === 429) throw new SpeechError('Speech recognition rate limit reached; please retry later', 502);
        if (!response.ok) throw new SpeechError(`The speech recognition service returned an error (HTTP ${response.status})`, 502);
        const data = await response.json();
        const token = text(data && data.token);
        if (!token) throw new SpeechError('The speech recognition service returned no token', 502);
        return { url: settings.url, token, model: settings.model, language: settings.language };
      } catch (error) {
        if (error instanceof SpeechError) throw error;
        if (error && error.name === 'AbortError') throw new SpeechError('The speech recognition service timed out; please retry', 504);
        throw new SpeechError('Cannot reach the speech recognition service; check the network and endpoint address', 502);
      } finally { clearTimeout(timer); }
    },
  };
}

module.exports = { REGIONS, LANGUAGES, TOKEN_TTL_SECONDS, createSpeech, SpeechError };
