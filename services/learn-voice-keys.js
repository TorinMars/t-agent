// The Bailian (Alibaba Cloud Model Studio) key of the Learn voice ("Bailian voice" in docs/design/learn-english-voice.md): the DashScope API key and
// the workspace id its API host needs, saved per person in system_state (`learn-voice:<owner>`), encrypted with the session secret like the keys of
// the translation service (services/translator.js). The key never leaves this process: view() says only whether one is saved and the workspace id
// (not a secret: it is part of the API host). The settings sync carries the whole row between linked engines (group learn-voice, sent encrypted),
// as it does the translator's keys; a page never gets it.
const syncStore = require('./settings-sync-store');

const SYNC_GROUP = 'learn-voice';
const MAX_KEY = 512;
// A workspace id is one lower-case host label ("llm-xxx" in the docs). The person may paste the whole API host or its URL
// (https://llm-xxx.cn-beijing.maas.aliyuncs.com/api/v1): the first label is taken.
const WORKSPACE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const CONTROLS = /[\x00-\x20\x7f]/;

// A refusal as the learn routes answer it (its English message, 400).
function keyError(message) {
  const { LearnError } = require('./learn');
  return new LearnError(message, 400);
}

// The workspace id of what the person typed (an id, an API host or its URL), or '' when it is not one.
function workspaceId(value) {
  let raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!raw) return '';
  raw = raw.replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '');
  const label = raw.split('.')[0];
  return WORKSPACE.test(label) ? label : '';
}

const stateKey = owner => `learn-voice:${owner}`;
const clean = value => {
  const bailian = value && typeof value === 'object' && value.bailian && typeof value.bailian === 'object' ? value.bailian : null;
  if (!bailian || typeof bailian.apiKey !== 'string' || !bailian.apiKey || typeof bailian.workspace !== 'string' || !WORKSPACE.test(bailian.workspace)) return null;
  return { apiKey: bailian.apiKey, workspace: bailian.workspace };
};

function createVoiceKeys({ db, sessionSecret }) {
  if (!db) throw new Error('createVoiceKeys needs db');
  const read = owner => clean(syncStore.readState(db, stateKey(owner), sessionSecret));
  return {
    // Server side only (services/learn-speech.js): { apiKey, workspace } or null.
    bailian: owner => read(owner),
    // What a page may see.
    view(owner) {
      const saved = read(owner);
      return { has_key: Boolean(saved), workspace: saved ? saved.workspace : '' };
    },
    // { api_key, workspace }: an empty key keeps the one saved (a new workspace id for the same key).
    saveBailian(owner, body) {
      const value = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
      const entered = typeof value.api_key === 'string' ? value.api_key.trim() : '';
      const saved = read(owner);
      const apiKey = entered || (saved ? saved.apiKey : '');
      if (!apiKey) throw keyError('Enter the Bailian API key');
      if (CONTROLS.test(entered)) throw keyError('The Bailian API key contains invalid characters such as spaces or line breaks');
      if (entered.length > MAX_KEY) throw keyError(`The Bailian API key is too long (at most ${MAX_KEY} characters)`);
      const typed = typeof value.workspace === 'string' ? value.workspace.trim() : '';
      const workspace = typed ? workspaceId(typed) : (saved ? saved.workspace : '');
      if (!workspace) throw keyError('Enter the workspace ID of Bailian (llm-…), or paste its API host');
      syncStore.writeState(db, stateKey(owner), { bailian: { apiKey, workspace } }, sessionSecret);
      syncStore.settingChanged(SYNC_GROUP);
      return this.view(owner);
    },
    removeBailian(owner) {
      syncStore.writeState(db, stateKey(owner), null);
      syncStore.settingChanged(SYNC_GROUP);
      return this.view(owner);
    },
  };
}

// Settings sync across linked devices (services/settings-sync.js): the stored value, the key included, or null. Only the sync calls these, and it
// sends the value encrypted.
const exportForSync = ({ db, sessionSecret }, owner) => syncStore.readState(db, stateKey(owner), sessionSecret);
const importFromSync = ({ db, sessionSecret }, owner, value) => syncStore.writeState(db, stateKey(owner), syncStore.objectOrNull(value), sessionSecret);

module.exports = { SYNC_GROUP, createVoiceKeys, workspaceId, exportForSync, importFromSync };
