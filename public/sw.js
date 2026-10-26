// Service Worker — minimal, required for PWA installability
// The fetch event is not intercepted: every request goes straight to the network so OAuth and the API keep working
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());

// A notification of an agent chat (shown by agent-chat.js through this worker): a click shows the page that is open and tells it which chat to show, or
// opens the page with ?openChat=<task id>:<conversation id> when no page is open.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const data = event.notification.data || {};
  event.waitUntil((async () => {
    const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const page = data.page || '/';
    const target = pages.find(client => new URL(client.url).pathname === page) || pages[0];
    if (target) {
      try { await target.focus(); } catch { /* the browser refused to focus it */ }
      target.postMessage({ type: 'agent-chat-open', data });
      return;
    }
    const link = data.taskId && !data.remote && data.conversationId ? `?openChat=${data.taskId}:${encodeURIComponent(data.conversationId)}` : '';
    await self.clients.openWindow(`${page}${link}`);
  })());
});
