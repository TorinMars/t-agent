// Service Worker — minimal, required for PWA installability (the Home Screen app)
// The fetch event is not intercepted: every request goes straight to the network so OAuth and the API keep working
// It shows no notifications: T-Agent has no system (browser / OS) notifications; reminders come from the page and the server's notifiers (Telegram).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());
