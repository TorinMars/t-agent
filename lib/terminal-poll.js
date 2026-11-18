'use strict';
// One clock for everything that polls a terminal's PTY. The activity tracker (lib/terminal-activity.js) and the shell-return watch
// (lib/terminal-input-modes.js) of every terminal subscribe to the shared clock, so a server with N terminals runs one timer instead of
// 2 N, and `pty.process` is read once per terminal per tick for both of them.
//
// Speed: every `fastMs` while someone is watching, every `slowMs` while nobody is. "Watching" is answered by the probes added with
// watchedBy() (routes/terminal.js: a terminal WebSocket is attached, an activity stream is open, or the desktop window read the activity a
// moment ago); a clock without a probe is always fast. The probes are asked again after every tick, and wake() asks them at once, so the
// first watcher brings the fast speed back without waiting for the next slow tick. A clock without subscribers has no timer.
const POLL_MS = 500;
const UNWATCHED_POLL_MS = 2000;

function createPollClock({ fastMs = POLL_MS, slowMs = fastMs * 4 } = {}) {
  const subscribers = new Set();
  const probes = new Set();
  let timer = null;
  let period = 0;
  let readings = null; // pty -> its `process` as read in the tick that is running; null between ticks

  function watched() {
    if (!probes.size) return true;
    for (const probe of probes) {
      try { if (probe()) return true; } catch { return true; } // a probe that fails must not slow the terminals down
    }
    return false;
  }

  // setInterval, not a chain of timeouts: a late tick is not made up for, and the period only changes when the watchers do.
  function retune() {
    const next = subscribers.size ? (watched() ? fastMs : slowMs) : 0;
    if (next === period) return;
    if (timer) clearInterval(timer);
    timer = next ? setInterval(tick, next) : null;
    if (timer && timer.unref) timer.unref();
    period = next;
  }

  function tick() {
    let failure = null;
    readings = new Map();
    try {
      for (const poll of [...subscribers]) {
        if (!subscribers.has(poll)) continue; // ended by an earlier poll of this tick
        try { poll(); } catch (error) { failure = failure || { error }; } // the other terminals are still polled
      }
    } finally {
      readings = null;
      retune();
    }
    if (failure) throw failure.error;
  }

  // `pty.process`: node-pty asks the system for the PTY's foreground process on every read. Inside a tick it is read once per terminal,
  // whichever subscribers ask; between ticks every call reads it. Throws what the getter throws.
  function processOf(pty) {
    if (!readings) return pty.process;
    let reading = readings.get(pty);
    if (!reading) {
      try { reading = { value: pty.process }; } catch (error) { reading = { error }; }
      readings.set(pty, reading);
    }
    if (reading.error) throw reading.error;
    return reading.value;
  }

  return {
    // poll: () => void, called at every tick. Answers the function that ends the subscription (calling it again does nothing).
    subscribe(poll) {
      const run = () => poll();
      subscribers.add(run);
      retune();
      return () => { subscribers.delete(run); retune(); };
    },
    // probe: () => boolean, true while someone is watching. Answers the function that removes it.
    watchedBy(probe) {
      probes.add(probe);
      retune();
      return () => { probes.delete(probe); retune(); };
    },
    // A watcher may have come or gone: pick the speed now.
    wake: retune,
    processOf,
    period: () => period,
    size: () => subscribers.size,
  };
}

// The clock of every terminal of this server.
const sharedClock = createPollClock({ fastMs: POLL_MS, slowMs: UNWATCHED_POLL_MS });

module.exports = { createPollClock, sharedClock, POLL_MS, UNWATCHED_POLL_MS };
