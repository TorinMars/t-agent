// The audio of the Learn page (scripts/h5-shell/learn-audio.mjs; "Audio" in docs/design/learn-english-page.md): the settings, when each exercise
// plays by itself, and the player with fake speech and fake timers: repeats with the pause between, Stop, a new play over an old one, skipping the
// rest when the person types, a browser that drops the end of a reading, and a refused first play.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.T_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-learn-audio-'));

const load = () => import('../scripts/h5-shell/learn-audio.mjs');

test('pronunciation acquires mixable audio and restores the previous session after the last player releases it', async () => {
  const { beginMixedPlayback } = await load();
  const audioSession = { type: 'auto' };
  const first = beginMixedPlayback({ audioSession });
  const second = beginMixedPlayback({ audioSession });
  assert.equal(audioSession.type, 'ambient');
  first();
  first();
  assert.equal(audioSession.type, 'ambient');
  second();
  assert.equal(audioSession.type, 'auto');
  const recording = { type: 'play-and-record' };
  beginMixedPlayback({ audioSession: recording })();
  assert.equal(recording.type, 'play-and-record');
  assert.doesNotThrow(() => beginMixedPlayback({})());
});

// Fake timers on a fake clock, and fake speech that the test ends by hand.
function rig({ refuse = false, silent = false } = {}) {
  let now = 0;
  let timers = [];
  const spoken = [];
  const states = [];
  let cancels = 0;
  const setTimer = (fn, ms) => { const timer = { fn, at: now + ms }; timers.push(timer); return timer; };
  const clearTimer = timer => { timers = timers.filter(item => item !== timer); };
  const advance = ms => {
    const until = now + ms;
    for (;;) {
      const due = timers.filter(timer => timer.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter(timer => timer !== due);
      now = due.at;
      due.fn();
    }
    now = until;
  };
  const speakOnce = (text, handlers) => {
    const entry = { text, slow: handlers.slow, at: now, ...handlers };
    spoken.push(entry);
    if (refuse) { handlers.onError('not-allowed'); return true; }
    if (!silent) handlers.onStart();
    return true;
  };
  let busy = false; // what the fake browser says while asked whether it is still reading
  return {
    spoken, states, setTimer, clearTimer, advance, speakOnce,
    speaking: () => busy,
    setSpeaking: value => { busy = value; },
    cancel: () => { cancels += 1; },
    cancels: () => cancels,
    end: () => spoken.at(-1).onEnd(),
    pending: () => timers.length,
  };
}

test('the settings and when each exercise plays by itself', async () => {
  const { audioOptions, autoPlays } = await load();
  assert.deepEqual(audioOptions({}), { words: true, sentences: true, sentencesAt: 'after', repeat: 2, pauseMs: 2000, slow: false, stopOnTyping: true });
  assert.deepEqual(audioOptions({ audio_repeat: 5, audio_pause: 3, audio_speed: 'slow', audio_words: false, audio_repeat_bad: 1 }).repeat, 5);
  assert.equal(audioOptions({ audio_repeat: 4 }).repeat, 2, 'a value it does not know is the default');
  const on = audioOptions({});
  assert.deepEqual(autoPlays('spell', on), ['start', 'after'], 'a word: when it appears and once more after the answer');
  assert.deepEqual(autoPlays('dictation', on), ['start']);
  assert.deepEqual(autoPlays('say', on), ['start']);
  assert.deepEqual(autoPlays('build', on), ['after'], 'hearing the sentence first would give the answer away');
  assert.deepEqual(autoPlays('fill', on), ['after']);
  assert.deepEqual(autoPlays('build', audioOptions({ audio_sentences_at: 'start' })), ['start']);
  const off = audioOptions({ audio_words: false, audio_sentences: false });
  assert.deepEqual(autoPlays('spell', off), []);
  assert.deepEqual(autoPlays('build', off), []);
  assert.deepEqual(autoPlays('say', off), []);
  assert.deepEqual(autoPlays('dictation', off), ['start'], 'Dictation always plays: listening is the task');
});

test('a play repeats with the pause between, shows "1 of 2", and ends idle', async () => {
  const { createPlayer } = await load();
  const r = rig();
  const player = createPlayer({ ...r, onChange: state => r.states.push(state) });
  player.play('expire', { repeat: 2, pauseMs: 2000, slow: true });
  assert.equal(r.spoken.length, 1);
  assert.equal(r.spoken[0].slow, true);
  assert.deepEqual(player.state(), { playing: true, text: 'expire', index: 1, total: 2, blocked: false });
  r.end();
  r.advance(1999);
  assert.equal(r.spoken.length, 1, 'the pause');
  r.advance(1);
  assert.equal(r.spoken.length, 2);
  assert.equal(player.state().index, 2);
  r.end();
  assert.equal(player.state().playing, false);
  assert.equal(r.pending(), 0, 'no timer left');
  r.advance(60000);
  assert.equal(r.spoken.length, 2, 'nothing more');
});

test('Stop and a new play cancel the pending repeats; nothing of the old one plays later', async () => {
  const { createPlayer } = await load();
  const r = rig();
  const player = createPlayer(r);
  player.play('expire', { repeat: 3, pauseMs: 1000 });
  r.end();
  player.stop();
  assert.equal(player.state().playing, false);
  assert.equal(r.cancels(), 1);
  r.advance(10000);
  assert.equal(r.spoken.length, 1);
  // A new play over a running one: the old one's late end does nothing.
  player.play('one', { repeat: 2, pauseMs: 1000 });
  const old = r.spoken.at(-1);
  player.play('two', { repeat: 1 });
  old.onEnd();
  r.advance(5000);
  assert.deepEqual(r.spoken.map(entry => entry.text), ['expire', 'one', 'two']);
});

test('typing skips the rest: the reading goes on, the repeats after it do not; in a pause it stops at once', async () => {
  const { createPlayer } = await load();
  const r = rig();
  const player = createPlayer(r);
  player.play('expire', { repeat: 3, pauseMs: 1000 });
  player.skipRest();
  assert.deepEqual([player.state().index, player.state().total, player.state().playing], [1, 1, true], 'still reading');
  r.end();
  r.advance(10000);
  assert.equal(r.spoken.length, 1);
  assert.equal(player.state().playing, false);
  player.play('merge', { repeat: 3, pauseMs: 1000 });
  r.end(); // now in the pause
  player.skipRest();
  assert.equal(player.state().playing, false);
  r.advance(10000);
  assert.equal(r.spoken.length, 2);
});

test('a reading whose end never comes is let go after a while; a play that cannot start ends at once', async () => {
  const { createPlayer, longestMs } = await load();
  const r = rig();
  const player = createPlayer(r);
  player.play('expire', { repeat: 2, pauseMs: 1000 });
  r.advance(longestMs('expire', false) + 1000);
  assert.equal(r.spoken.length, 2, 'the next repeat came anyway');
  const none = createPlayer({ speakOnce: () => false, setTimer: r.setTimer, clearTimer: r.clearTimer });
  none.play('expire', { repeat: 2 });
  assert.equal(none.state().playing, false);
});

test('a browser that refuses sound before the first tap: an automatic play says so (blocked), a press does not', async () => {
  const { createPlayer, START_MS } = await load();
  const refused = rig({ refuse: true });
  const player = createPlayer(refused);
  player.play('expire', { repeat: 2, auto: true });
  assert.deepEqual([player.state().blocked, player.state().text, player.state().playing], [true, 'expire', false]);
  refused.advance(10000);
  assert.equal(refused.spoken.length, 1, 'no repeat after a refusal');
  player.stop();
  assert.equal(player.state().blocked, false);
  // Speech that never starts (iOS ignores it silently) counts as refused after START_MS, only for an automatic play.
  const silent = rig({ silent: true });
  const quiet = createPlayer(silent);
  quiet.play('expire', { repeat: 1, auto: true });
  silent.advance(START_MS - 1);
  assert.equal(quiet.state().blocked, false);
  silent.advance(1);
  assert.equal(quiet.state().blocked, true);
  quiet.play('expire', { repeat: 1 });
  silent.advance(START_MS + 10);
  assert.equal(quiet.state().blocked, false, 'a press is never marked refused');
});

test('an end reported while the browser is still reading: the next repeat waits until it has stopped, then the pause', async () => {
  const { createPlayer, SPEAKING_CHECK_MS } = await load();
  const r = rig();
  const sentence = 'The session cookie expires after thirty minutes, so please log in again.';
  const player = createPlayer({ ...r, onChange: state => r.states.push(state) });
  player.play(sentence, { repeat: 2, pauseMs: 2000 });
  r.setSpeaking(true);
  r.end(); // reported too early: the sentence is still being read
  r.advance(5000);
  assert.equal(r.spoken.length, 1, 'no second pass (and no cancel) while the first is still heard');
  assert.equal(r.cancels(), 0);
  assert.equal(player.state().index, 1);
  player.skipRest(); // typing while it is still heard: the reading goes on, no repeat after it
  r.setSpeaking(false);
  r.advance(SPEAKING_CHECK_MS);
  r.advance(5000);
  assert.equal(r.spoken.length, 1);
  assert.equal(player.state().playing, false);

  player.play(sentence, { repeat: 2, pauseMs: 2000 });
  r.setSpeaking(true);
  r.end();
  r.advance(1000);
  r.setSpeaking(false);
  r.advance(SPEAKING_CHECK_MS);
  r.advance(1999);
  assert.equal(r.spoken.length, 2, 'the pause counts from the real end');
  r.advance(1);
  assert.equal(r.spoken.length, 3);
  assert.equal(player.state().index, 2);
});

test('a browser that keeps saying it is reading: the repeat comes after the longest time a reading can take', async () => {
  const { createPlayer, longestMs } = await load();
  const r = rig();
  const player = createPlayer({ ...r });
  player.play('expire', { repeat: 2, pauseMs: 1000 });
  r.setSpeaking(true);
  r.end();
  r.advance(longestMs('expire', false) - 1);
  assert.equal(r.spoken.length, 1);
  r.advance(1000 + 400);
  assert.equal(r.spoken.length, 2);
});

test('the study step reads the word, then its sentence, as the settings say', async () => {
  const { audioOptions, studyReadings } = await load();
  const on = audioOptions({});
  assert.deepEqual(studyReadings('receive', 'Did you receive it?', on), ['receive', 'Did you receive it?']);
  assert.deepEqual(studyReadings('receive', '', on), ['receive'], 'a word with no sentence');
  assert.deepEqual(studyReadings('receive', 'Did you receive it?', audioOptions({ audio_words: false })), ['Did you receive it?']);
  assert.deepEqual(studyReadings('receive', 'Did you receive it?', audioOptions({ audio_sentences: false })), ['receive']);
  assert.deepEqual(studyReadings('receive', 'Did you receive it?', audioOptions({ audio_words: false, audio_sentences: false })), []);
});
