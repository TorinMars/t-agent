// Service Worker — minimal, required for PWA installability
// The fetch event is not intercepted: every request goes straight to the network so OAuth and the API keep working
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());
