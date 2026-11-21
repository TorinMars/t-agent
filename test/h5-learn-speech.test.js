// The voice the Learn page reads with (scripts/h5-shell/learn-speech.mjs; "Speech" in docs/design/learn-english-page.md): always American English,
// a natural voice first, never a novelty or a British voice.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.T_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-learn-speech-'));

const load = () => import('../scripts/h5-shell/learn-speech.mjs');
const voice = (name, lang, extra = {}) => ({ name, lang, localService: true, default: false, ...extra });

test('a natural American voice wins over the novelty voices macOS lists first', async () => {
  const { pickVoice } = await load();
  const list = [voice('Albert', 'en-US'), voice('Bells', 'en-US'), voice('Daniel', 'en-GB', { default: true }), voice('Samantha', 'en-US'), voice('Zarvox', 'en-US')];
  assert.equal(pickVoice(list).name, 'Samantha');
  assert.equal(pickVoice([voice('Google UK English Female', 'en-GB'), voice('Google US English', 'en-US', { localService: false })]).name, 'Google US English');
  assert.equal(pickVoice([voice('Microsoft Jenny Online (Natural) - English (United States)', 'en-US', { localService: false }), voice('Microsoft David', 'en-US')]).name.startsWith('Microsoft Jenny'), true);
});

test('without a known name: the default en-US voice, then a local one, then any en-US voice; en_US counts too', async () => {
  const { pickVoice } = await load();
  assert.equal(pickVoice([voice('Other', 'en-US'), voice('Main', 'en-US', { default: true })]).name, 'Main');
  assert.equal(pickVoice([voice('Far', 'en-US', { localService: false }), voice('Near', 'en_US')]).name, 'Near');
  assert.equal(pickVoice([voice('Far', 'en-US', { localService: false })]).name, 'Far');
});

test('never a British, Australian or Indian voice, nor a novelty voice: null, and the utterance keeps lang en-US', async () => {
  const { pickVoice } = await load();
  assert.equal(pickVoice([voice('Daniel', 'en-GB'), voice('Karen', 'en-AU'), voice('Rishi', 'en-IN')]), null);
  assert.equal(pickVoice([voice('Zarvox', 'en-US'), voice('Bad News', 'en-US')]), null);
  assert.equal(pickVoice([]), null);
  assert.equal(pickVoice(undefined), null);
});
