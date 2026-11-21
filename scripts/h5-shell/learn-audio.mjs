// The audio of the Learn page ("Audio" in docs/design/learn-english-page.md): playing a word or a sentence a number of times with a pause between,
// stopping, skipping the rest when the person starts typing, and noticing a browser that refuses sound before the first tap. Pure: the speech
// (`speakOnce`), the cancel and the timers are handed in, so the unit test (test/h5-learn-audio.test.js) runs it with fake ones.

export const START_MS = 2500; // an automatic play that has not started by then counts as refused (iOS ignores speech before the first tap)

// What the settings ask for (the server's learn_v1 fields, defaults where one is missing).
export function audioOptions(settings) {
  const value = settings || {};
  const pick = (key, values, fallback) => (values.includes(value[key]) ? value[key] : fallback);
  return {
    words: pick('audio_words', [true, false], true),
    sentences: pick('audio_sentences', [true, false], true),
    sentencesAt: pick('audio_sentences_at', ['after', 'start'], 'after'),
    repeat: pick('audio_repeat', [1, 2, 3, 5], 2),
    pauseMs: pick('audio_pause', [1, 2, 3], 2) * 1000,
    slow: pick('audio_speed', ['normal', 'slow'], 'normal') === 'slow',
    stopOnTyping: pick('audio_stop_on_typing', [true, false], true),
  };
}

// When an exercise plays by itself: a list of 'start' (when the card appears) and 'after' (after the answer). A word: at the start and once more
// after the answer. Dictation always at the start (listening is the task); Say it plays the model at the start; Build, Fill the gap and a sentence in
// Review follow `sentencesAt`, because hearing the sentence first would give the answer away.
export function autoPlays(exercise, options) {
  if (exercise === 'spell') return options.words ? ['start', 'after'] : [];
  if (exercise === 'dictation') return ['start'];
  if (!options.sentences) return [];
  if (exercise === 'say') return ['start'];
  return [options.sentencesAt];
}

// A rough upper bound of one reading, for a browser that never says the speech ended (Chromium can drop `end` for long text).
export const longestMs = (text, slow) => Math.round((4000 + String(text || '').length * 120) * (slow ? 1.6 : 1));

// How often the player looks again whether the browser is still reading before it starts the next repeat.
export const SPEAKING_CHECK_MS = 200;

// `speakOnce(text, { slow, onStart, onEnd, onError })` reads once and calls back (onError with the error name); returns false when it cannot.
// `cancel()` stops what is being read. `speaking()`: whether the browser is still reading (speechSynthesis.speaking / pending). Some browsers
// report the end of a long reading (a whole sentence in Spell) before it is heard to the end; the next repeat starts with a cancel, so it would cut
// the sentence off. The next repeat therefore waits until the browser has really stopped, then the pause, and gives up waiting after the longest
// time a reading can take (a browser that keeps `speaking` set). `onChange(state)`: { playing, text, index, total, blocked } after every change.
// See "Audio" in docs/design/learn-english-page.md.
export function createPlayer({ speakOnce, cancel = () => {}, speaking = () => false, setTimer = setTimeout, clearTimer = clearTimeout, onChange = () => {} }) {
  let run = null; // the play in progress: { total, reading, pause }
  let timers = [];
  let state = { playing: false, text: '', index: 0, total: 0, blocked: false };
  const set = next => { state = { ...state, ...next }; onChange(state); };
  const clearAll = () => { for (const timer of timers) clearTimer(timer); timers = []; };
  const later = (fn, ms) => { timers.push(setTimer(fn, ms)); };
  const idle = { playing: false, text: '', index: 0, total: 0 };

  function stop() {
    const wasPlaying = Boolean(run);
    run = null;
    clearAll();
    if (wasPlaying) cancel();
    if (state.playing || state.blocked) set({ ...idle, blocked: false });
  }

  // Plays `text` `repeat` times with `pauseMs` between. `auto`: started by the page, not by a press (only then can it be refused).
  function play(text, { repeat = 1, pauseMs = 0, slow = false, auto = false } = {}) {
    stop();
    if (!text) return;
    const mine = { total: Math.max(1, repeat), index: 0, reading: false };
    run = mine;
    const live = () => run === mine;
    const finish = () => { if (!live()) return; run = null; clearAll(); set(idle); };
    const refused = () => {
      if (!live()) return;
      run = null;
      clearAll();
      cancel();
      set({ ...idle, text, blocked: true });
    };
    const next = () => {
      if (!live()) return;
      clearAll();
      mine.index += 1;
      mine.reading = true;
      set({ playing: true, text, index: mine.index, total: mine.total, blocked: false });
      let started = false;
      let ended = false;
      const end = () => {
        if (ended || !live()) return;
        ended = true;
        clearAll();
        // Still reading although the end was reported: look again shortly, at most until the longest time a reading can take.
        let waited = 0;
        const limit = longestMs(text, slow);
        const done = () => {
          if (!live()) return;
          if (waited < limit && safe(speaking)) { waited += SPEAKING_CHECK_MS; later(done, SPEAKING_CHECK_MS); return; }
          mine.reading = false;
          if (mine.index < mine.total) later(next, pauseMs); else finish();
        };
        done();
      };
      const first = auto && mine.index === 1;
      const ok = speakOnce(text, {
        slow,
        onStart: () => { started = true; },
        onEnd: end,
        onError: error => {
          if (!live()) return;
          if (first && (error === 'not-allowed' || !started)) refused(); else end();
        },
      });
      if (!ok) { finish(); return; }
      if (first) later(() => { if (!started && !ended) refused(); }, START_MS);
      later(end, longestMs(text, slow));
    };
    next();
  }

  const safe = fn => { try { return Boolean(fn()); } catch { return false; } };

  // The person started typing: the reading now goes on to its end, the repeats after it are skipped (in a pause between two: it stops now).
  function skipRest() {
    if (!run) return;
    if (!run.reading) { finish(); return; }
    run.total = run.index;
    set({ total: run.index });
  }
  function finish() { run = null; clearAll(); if (state.playing) set(idle); }

  return { play, stop, skipRest, state: () => state };
}
