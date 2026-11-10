// Autosave of the open map: one request at a time, always with the latest revision, debounced after a change, retried after a failure.
// A failed save never drops edits: while the service restarts (auto update: 20 to 60 seconds of failing requests) the map keeps retrying with a growing delay.
//
//   send(body, { keepalive })  -> resolves { status, json } (status 0 / rejection = the network failed)
//   getSnapshot()              -> { title, data } at the moment of sending
//   verify(sent)               -> resolves true when the server already holds exactly `sent` (a save whose answer was lost)
//   onConflict(info) / onRejected(code)
export const DEBOUNCE_MS = 1000;
export const MAX_BACKOFF_MS = 15000;

export function createSaver({ revision, send, getSnapshot, verify, onState, onConflict, onRejected, writeDraft = () => {}, clearDraft = () => {}, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = id => clearTimeout(id), debounceMs = DEBOUNCE_MS }) {
  let rev = revision;
  let seq = 0;
  let savedSeq = 0;
  let timer = null;
  let attempt = 0;
  let inflight = null;
  let blocked = false;
  let disposed = false;
  let state = 'saved';

  const set = next => { if (state !== next) { state = next; onState(next); } };
  const dirty = () => seq !== savedSeq;
  const stopTimer = () => { if (timer !== null) { clearTimer(timer); timer = null; } };
  const backoff = () => Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(attempt, 5));

  async function run(keepalive) {
    timer = null;
    if (disposed || blocked || inflight || !dirty()) return inflight || undefined;
    const running = attempt1(keepalive);
    inflight = running.finally(() => { inflight = null; });
    return inflight;
  }

  async function attempt1(keepalive) {
    const sentSeq = seq;
    const snapshot = getSnapshot();
    set('saving');
    let result;
    try {
      result = await send({ revision: rev, ...snapshot }, { keepalive: Boolean(keepalive) });
    } catch {
      result = { status: 0 };
    }
    const { status, json = {} } = result;
    if (status >= 200 && status < 300 && json.revision !== undefined) {
      rev = json.revision;
      saved(sentSeq);
    } else if (status === 409 && json.error === 'MINDMAP_CONFLICT') {
      // The server moved on. The commonest honest reason is our own save whose answer was lost (a restart while it was answered): then it holds exactly what we sent.
      let same = false;
      try { same = await verify(snapshot, json.current_revision); } catch { same = false; }
      if (same) {
        rev = json.current_revision;
        saved(sentSeq);
      } else {
        blocked = true;
        set('conflict');
        onConflict({ currentRevision: json.current_revision });
      }
    } else if (status === 404) {
      blocked = true;
      set('conflict');
      onConflict({ gone: true });
    } else if (status === 400 || status === 413) {
      blocked = true;
      set('rejected');
      onRejected(json.error || 'INVALID_MINDMAP');
    } else {
      attempt += 1;
      set('retrying');
    }
    if (blocked || disposed) return;
    if (dirty()) {
      timer = setTimer(() => void run(false), state === 'retrying' ? backoff() : debounceMs);
    }
  }

  function saved(sentSeq) {
    savedSeq = sentSeq;
    attempt = 0;
    if (dirty()) return; // more changes arrived meanwhile: the next round saves them
    clearDraft();
    set('saved');
  }

  return {
    // Something changed. The draft is written first, so a page that dies before the next save loses nothing.
    touch() {
      if (blocked || disposed) return;
      seq += 1;
      writeDraft();
      if (state === 'retrying') { // the retry already waiting also takes this change; typing must not keep pushing it back
        if (timer === null && !inflight) timer = setTimer(() => void run(false), backoff());
        return;
      }
      set('dirty');
      stopTimer();
      timer = setTimer(() => void run(false), debounceMs);
    },
    // Send now (closing the map, page hidden, Cmd+S). Returns when this round ended, however it ended.
    async flush({ keepalive = false } = {}) {
      if (blocked || disposed) return;
      if (dirty()) writeDraft();
      stopTimer();
      if (inflight) await inflight;
      if (!blocked && dirty()) await run(keepalive);
    },
    // The network came back: do not wait for the end of the delay.
    wake() { if (!blocked && !disposed && dirty() && !inflight) { stopTimer(); void run(false); } },
    get dirty() { return dirty(); },
    get state() { return state; },
    get revision() { return rev; },
    dispose() { disposed = true; stopTimer(); },
  };
}
