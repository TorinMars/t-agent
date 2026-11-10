// STUB of the reverse tunnel contract, used by the link lifecycle until the real module (branch feat/link-tunnel) replaces this file.
// It keeps one real WebSocket per link, so online state and 401 handling can be tested, but it carries no requests:
// a request to tunnelBase(linkId) fails, as one to a peer that is offline does.
const WebSocket = require('ws');

const BASE = /^http:\/\/link-([0-9a-f-]{36})\.tunnel\.invalid$/;
const RETRY_MS = 1000;

const tunnelBase = linkId => `http://link-${linkId}.tunnel.invalid`;
const isTunnelBase = baseUrl => BASE.test(String(baseUrl || ''));
const linkIdOf = baseUrl => (String(baseUrl || '').match(BASE) || [])[1] || null;

class Hub {
  constructor() { this.sockets = new Map(); this.listeners = new Set(); }
  accept(linkId, ws) {
    const previous = this.sockets.get(linkId);
    this.sockets.set(linkId, ws);
    if (previous) previous.close(1000, 'replaced');
    else this.emit(linkId, true);
    ws.on('close', () => {
      if (this.sockets.get(linkId) !== ws) return;
      this.sockets.delete(linkId);
      this.emit(linkId, false);
    });
    ws.on('error', () => {});
  }
  isOnline(linkId) { return this.sockets.has(linkId); }
  drop(linkId, reason = 'dropped') {
    const ws = this.sockets.get(linkId);
    if (ws) ws.close(1000, String(reason).slice(0, 100));
  }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(linkId, online) { for (const fn of this.listeners) fn({ linkId, online }); }
}

let hub = null;
function getHub() { return (hub ||= new Hub()); }

function startTunnelClient({ url, token, onState }) {
  let stopped = false;
  let socket = null;
  let timer = null;
  const target = `${String(url).replace(/^http/, 'ws')}/v1/service-links/tunnel`;
  const connect = () => {
    if (stopped) return;
    socket = new WebSocket(target, { headers: { Authorization: `Bearer ${token}` } });
    socket.on('open', () => onState({ online: true, error: null }));
    socket.on('unexpected-response', (request, response) => {
      if (response.statusCode === 401 || response.statusCode === 403) {
        stopped = true;
        onState({ online: false, error: 'LINK_REVOKED' });
      }
      request.destroy();
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      if (stopped) return;
      onState({ online: false, error: null });
      timer = setTimeout(connect, RETRY_MS);
      timer.unref();
    });
  };
  connect();
  return { stop() { stopped = true; clearTimeout(timer); if (socket) socket.terminate(); } };
}

module.exports = { tunnelBase, isTunnelBase, linkIdOf, getHub, startTunnelClient };
