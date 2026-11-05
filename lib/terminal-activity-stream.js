// Server push of terminal activity (server-sent events), so pages do not poll GET /terminal-activity and /terminal-subagents.
//
// Every stream gets `event: activity` with the whole picture of its owner's tasks, `{ activity, subagents }` (the same two objects the
// polling endpoints answer), once on connect and again whenever it changes. A whole snapshot instead of diffs: it is small (only
// terminals that are not idle are listed), a missed message can never leave a page wrong, and the page needs no merge logic.
//
// What triggers a new snapshot:
//  - activity: `notify()`, called by routes/terminal.js when a tracker changes state (running / done / idle, ack included) and when a
//    terminal session ends. Calls within `debounceMs` are sent as one.
//  - sub-agents: they live in log files, so there is no event. One shared timer (`subagentMs`, only while at least one stream is open)
//    recomputes the sub-agent counts of all live Claude terminals once for every stream; streams are only written to when it changed.
// Each stream only gets a message when its own snapshot differs from the last one it was sent. A comment line every `heartbeatMs`
// keeps proxies from closing an idle stream.
function createActivityStream({ activity, subagents, subagentMs = 5000, debounceMs = 100, heartbeatMs = 20000 } = {}) {
  const clients = new Set();
  let subagentAll = {};
  let subagentKey = '{}';
  let subagentTimer = null;
  let debounceTimer = null;

  const pick = (all, ids) => {
    const out = {};
    for (const id of ids) if (all[id]) out[id] = all[id];
    return out;
  };

  function send(client, force = false) {
    let payload;
    try {
      const ids = client.taskIds();
      payload = JSON.stringify({ activity: activity(ids), subagents: pick(subagentAll, ids) });
    } catch { return; }
    if (!force && payload === client.last) return;
    client.last = payload;
    client.res.write(`event: activity\ndata: ${payload}\n\n`);
  }

  function broadcast() {
    debounceTimer = null;
    for (const client of clients) send(client);
  }

  function refreshSubagents() {
    let next;
    try { next = subagents() || {}; } catch { return false; }
    const key = JSON.stringify(next);
    if (key === subagentKey) return false;
    subagentAll = next;
    subagentKey = key;
    return true;
  }

  function startTimer() {
    if (subagentTimer) return;
    subagentTimer = setInterval(() => { if (refreshSubagents()) notify(); }, subagentMs);
    subagentTimer.unref?.();
  }

  function stopTimer() {
    if (!subagentTimer) return;
    clearInterval(subagentTimer);
    subagentTimer = null;
  }

  // Something changed: send the new snapshots soon (several changes in a burst become one message).
  function notify() {
    if (!clients.size || debounceTimer) return;
    debounceTimer = setTimeout(broadcast, debounceMs);
    debounceTimer.unref?.();
  }

  // taskIds: () => the ids of the tasks this stream may see (read again for every message, so new tasks are included).
  function serve(req, res, taskIds) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    // Keep reverse proxies (nginx) from buffering the stream.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    // The browser waits this long before it reconnects by itself (EventSource); the page's own client has its own backoff.
    res.write('retry: 5000\n\n');

    const client = { res, taskIds, last: null };
    // The first stream has no recent sub-agent counts yet: read them now, so the first snapshot is complete.
    if (!subagentTimer) refreshSubagents();
    clients.add(client);
    startTimer();
    send(client, true);

    const heartbeat = setInterval(() => res.write(': ping\n\n'), heartbeatMs);
    heartbeat.unref?.();
    const close = () => {
      clearInterval(heartbeat);
      clients.delete(client);
      if (!clients.size) stopTimer();
    };
    req.on('close', close);
    res.on('error', close);
  }

  return { serve, notify, size: () => clients.size };
}

module.exports = { createActivityStream };
