// Service Worker — minimal, required for PWA installability
// fetch 事件不拦截，所有请求透传网络，保持 OAuth 和 API 正常工作
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());
