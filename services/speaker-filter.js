// iFlytek text-independent speaker verification. Credentials and profile IDs stay on the Client.
// Audio is used for one request and is never saved here. Each user has an isolated provider group.
const crypto = require('node:crypto');
const { encryptToken, decryptToken } = require('../lib/token-crypto');
const { SpeechError } = require('./speech');
const ENDPOINT = 'https://api.xf-yun.com/v1/private/s1aa729d0';
const SERVICE = 's1aa729d0';
const MAX_AUDIO = 2_560_100; // a 60-second 16 kHz mono PCM WAV, as base64
const defaults = () => ({ enabled: false, appId: '', apiKey: '', apiSecret: '', threshold: 0.75, groupId: '', featureId: '' });
const text = value => typeof value === 'string' ? value.trim() : '';
const format = { encoding: 'utf8', compress: 'raw', format: 'json' };

function signedUrl(config, now = new Date()) {
  const url = new URL(ENDPOINT);
  const date = now.toUTCString();
  const source = `host: ${url.host}\ndate: ${date}\nPOST ${url.pathname} HTTP/1.1`;
  const signature = crypto.createHmac('sha256', config.apiSecret).update(source).digest('base64');
  const auth = `api_key="${config.apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
  url.searchParams.set('authorization', Buffer.from(auth).toString('base64'));
  url.searchParams.set('host', url.host);
  url.searchParams.set('date', date);
  return url.href;
}

// Parse chunks instead of assuming the data starts at byte 44 (valid WAVs can contain extra chunks).
function validateAudio(value, enrollment = false) {
  if (typeof value !== 'string' || value.length > MAX_AUDIO || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new SpeechError('Invalid voice sample');
  const wav = Buffer.from(value, 'base64');
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE' || wav.readUInt32LE(4) + 8 !== wav.length) throw new SpeechError('Use a 16 kHz mono 16-bit PCM WAV file');
  let pcm = false, size = 0;
  for (let at = 12; at + 8 <= wav.length;) {
    const id = wav.toString('ascii', at, at + 4), length = wav.readUInt32LE(at + 4), start = at + 8;
    if (start + length > wav.length) throw new SpeechError('Invalid voice sample');
    if (id === 'fmt ') {
      if (length < 16 || wav.readUInt16LE(start) !== 1 || wav.readUInt16LE(start + 2) !== 1 || wav.readUInt32LE(start + 4) !== 16000 || wav.readUInt32LE(start + 8) !== 32000 || wav.readUInt16LE(start + 12) !== 2 || wav.readUInt16LE(start + 14) !== 16) throw new SpeechError('Use a 16 kHz mono 16-bit PCM WAV file');
      pcm = true;
    }
    if (id === 'data') size += length;
    at = start + length + (length % 2);
  }
  const seconds = size / 32000;
  if (!pcm || size % 2 || seconds < (enrollment ? 10 : 0.5) || seconds > 60) throw new SpeechError(enrollment ? 'Record 10 to 60 seconds of your voice' : 'The voice segment must be 0.5 to 60 seconds');
  return value;
}

function createSpeakerFilter({ db, sessionSecret, fetchImpl = (...args) => fetch(...args), now = () => new Date() }) {
  const key = owner => `speaker-filter:${owner}`;
  const read = owner => {
    const row = db.prepare('SELECT value FROM system_state WHERE key = ?').get(key(owner));
    return { ...defaults(), ...(row ? JSON.parse(decryptToken(row.value, sessionSecret)) : {}) };
  };
  const write = (owner, value) => db.prepare(`INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(key(owner), encryptToken(JSON.stringify(value), sessionSecret));
  const safe = value => ({ enabled: value.enabled, appId: value.appId, hasApiKey: Boolean(value.apiKey), hasApiSecret: Boolean(value.apiSecret), enrolled: Boolean(value.featureId), threshold: value.threshold });
  const credentials = value => { if (!value.appId || !value.apiKey || !value.apiSecret) throw new SpeechError('Set up iFlytek speaker recognition credentials first', 409); };
  const busy = new Set();
  async function call(config, func, args = {}, audio = null) {
    credentials(config);
    const resultName = `${func}Res`;
    const body = { header: { app_id: config.appId, status: 3 }, parameter: { [SERVICE]: { func, ...args, [resultName]: format } } };
    if (audio) body.payload = { resource: { encoding: 'raw', sample_rate: 16000, channels: 1, bit_depth: 16, status: 3, audio } };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetchImpl(signedUrl(config, now()), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
      if (!response.ok) throw new SpeechError(`iFlytek speaker verification failed (HTTP ${response.status})`, 502);
      const data = await response.json();
      if (data?.header?.code !== 0) throw new SpeechError('iFlytek rejected the speaker recognition request; check credentials and service access', 502);
      const encoded = data?.payload?.[resultName]?.text;
      if (typeof encoded !== 'string') throw new SpeechError('Invalid iFlytek speaker recognition response', 502);
      let result;
      try { result = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')); } catch { throw new SpeechError('Invalid iFlytek speaker recognition response', 502); }
      if (!result || typeof result !== 'object' || Array.isArray(result) || (result.code !== undefined && ![0, '0', '000000'].includes(result.code))) throw new SpeechError('Invalid iFlytek speaker recognition response', 502);
      return result;
    } catch (error) {
      if (error instanceof SpeechError) throw error;
      throw new SpeechError('Cannot verify the speaker; the voice segment was not accepted', 502);
    } finally { clearTimeout(timer); }
  }
  async function remove(config) {
    if (!config.groupId) return;
    const result = await call(config, 'deleteGroup', { groupId: config.groupId });
    if (result.msg !== 'success') throw new SpeechError('Could not delete the iFlytek voiceprint', 502);
  }
  return {
    getConfig: owner => safe(read(owner)),
    sessionConfig(owner) {
      const config = read(owner);
      if (config.enabled) { credentials(config); if (!config.featureId) throw new SpeechError('Register your voice before enabling the speaker filter', 409); }
      return config.enabled;
    },
    saveConfig(owner, body) {
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SpeechError('Invalid speaker filter configuration');
      if (busy.has(owner)) throw new SpeechError('Voiceprint registration is in progress', 409);
      const previous = read(owner), config = { ...previous };
      for (const name of ['appId', 'apiKey', 'apiSecret']) {
        if (body[name] !== undefined && typeof body[name] !== 'string') throw new SpeechError('Invalid iFlytek credentials');
        const next = text(body[name]);
        if (next) {
          if (!/^[A-Za-z0-9_-]{1,128}$/.test(next)) throw new SpeechError('Invalid iFlytek credentials');
          config[name] = next;
        }
      }
      if (previous.featureId && ['appId', 'apiKey', 'apiSecret'].some(name => config[name] !== previous[name])) throw new SpeechError('Delete your voiceprint before changing iFlytek credentials');
      if (body.threshold !== undefined) {
        if (body.threshold === '' || body.threshold === null || typeof body.threshold === 'boolean') throw new SpeechError('The voice match threshold must be between 0 and 1');
        const threshold = Number(body.threshold);
        if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new SpeechError('The voice match threshold must be between 0 and 1');
        config.threshold = threshold;
      }
      if (body.enabled !== undefined) { if (typeof body.enabled !== 'boolean') throw new SpeechError('Invalid speaker filter configuration'); config.enabled = body.enabled; }
      credentials(config);
      if (config.enabled && !config.featureId) throw new SpeechError('Register your voice before enabling the speaker filter', 409);
      write(owner, config);
      return safe(config);
    },
    async enroll(owner, audio) {
      validateAudio(audio, true);
      if (busy.has(owner)) throw new SpeechError('Voiceprint registration is in progress', 409);
      busy.add(owner);
      const previous = read(owner), config = { ...previous, groupId: `ta_${crypto.randomBytes(12).toString('hex')}`, featureId: 'owner' };
      let created = false;
      try {
        const group = await call(config, 'createGroup', { groupId: config.groupId, groupName: 'T-Agent voice filter' });
        if (group.groupId !== config.groupId) throw new SpeechError('Could not create the iFlytek voiceprint group', 502);
        created = true;
        const feature = await call(config, 'createFeature', { groupId: config.groupId, featureId: config.featureId, featureInfo: 'Owner' }, audio);
        if (feature.featureId !== config.featureId) throw new SpeechError('Could not register the iFlytek voiceprint', 502);
        await remove(previous);
        write(owner, config);
        return safe(config);
      } catch (error) {
        if (created) await remove(config).catch(() => {}); // discard a failed replacement; keep the previous profile
        throw error;
      } finally { busy.delete(owner); }
    },
    async verify(owner, audio) {
      validateAudio(audio);
      const config = read(owner);
      if (!config.enabled || !config.featureId) throw new SpeechError('The speaker filter is not enabled or has no registered voice', 409);
      const result = await call(config, 'searchScoreFea', { groupId: config.groupId, dstFeatureId: config.featureId }, audio);
      if (result.featureId !== config.featureId || typeof result.score !== 'number' || !Number.isFinite(result.score) || result.score < -1 || result.score > 1) throw new SpeechError('Invalid iFlytek speaker match result', 502);
      const current = read(owner);
      if (!current.enabled || current.groupId !== config.groupId || current.featureId !== config.featureId) throw new SpeechError('The speaker profile changed; start a new recording', 409);
      return { matched: result.score >= current.threshold, score: result.score };
    },
    async clearConfig(owner) {
      if (busy.has(owner)) throw new SpeechError('Voiceprint registration is in progress', 409);
      busy.add(owner);
      try { await remove(read(owner)); db.prepare('DELETE FROM system_state WHERE key = ?').run(key(owner)); return safe(defaults()); }
      finally { busy.delete(owner); }
    },
  };
}
module.exports = { createSpeakerFilter, validateAudio, signedUrl };
