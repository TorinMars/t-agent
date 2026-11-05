// A pushed terminal activity stream for the phone page browser tests (Playwright routes cannot keep a response open).
// `await page.addInitScript(activityStreamMock)` before the page loads: fetches of `.../terminal-activity/stream` get a live
// text/event-stream body. In the page, `window.activityStream.opens` lists the stream URLs opened, `window.activityStream.push(url, snapshot)`
// sends `event: activity` to the newest open stream of that URL, and `window.activityStream.drop(url)` ends it (as a lost connection).
function activityStreamMock() {
  const streams = [];
  const encoder = new TextEncoder();
  const realFetch = window.fetch.bind(window);
  const find = url => [...streams].reverse().find(entry => entry.path === url && !entry.closed);
  window.activityStream = {
    opens: [],
    push(url, snapshot) {
      const entry = find(url);
      if (!entry) return false;
      entry.controller.enqueue(encoder.encode(`event: activity\ndata: ${JSON.stringify(snapshot)}\n\n`));
      return true;
    },
    drop(url) {
      const entry = find(url);
      if (!entry) return false;
      entry.closed = true;
      entry.controller.close();
      return true;
    },
    open: url => Boolean(find(url)),
  };
  window.fetch = (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (!url.pathname.endsWith('/terminal-activity/stream')) return realFetch(input, init);
    const entry = { path: url.pathname, closed: false, controller: null };
    window.activityStream.opens.push(url.pathname);
    const body = new ReadableStream({ start(controller) { entry.controller = controller; } });
    streams.push(entry);
    if (init.signal) {
      init.signal.addEventListener('abort', () => {
        if (entry.closed) return;
        entry.closed = true;
        try { entry.controller.error(new DOMException('Aborted', 'AbortError')); } catch { /* already closed */ }
      });
    }
    return Promise.resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
  };
}

module.exports = { activityStreamMock };
