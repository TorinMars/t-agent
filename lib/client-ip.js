// The address of the person behind a request, for the access log ("Client address" in docs/design/access-log.md). One place for the rule:
//
// - The socket peer, when it is not a loopback address: a direct visitor (LAN, frp's raw TCP from the frps host, ...). Forwarding headers from such a
//   peer are never read: anyone can send them.
// - When the peer is loopback, the request came from this machine: a local browser, or the SSH reverse tunnel / frp client that carries the VPS's
//   reverse proxy here. Only then, and only while this server is set up to be reached through a proxy (`trusted`), the address the proxy appended is
//   used: the RIGHT-MOST valid entry of X-Forwarded-For (a client can put anything at the left of the chain; the proxy appends the peer it saw), then
//   X-Real-IP, then the right-most `for=` of Forwarded.
//
// This is a label for the log and its alerts, never a security decision: the "is this request local" checks (services/client-auth.js
// isLocalInitialization, lib/terminal-relay-auth.js fromThisMachine) stay as they are and treat any forwarding header as not local. A process on this
// machine can still send a made-up X-Forwarded-For through the loopback while `trusted` is on.
const net = require('net');

const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

// One address in its plain form: ports and brackets removed, `::ffff:a.b.c.d` as a.b.c.d, a zone id dropped, lower case. null when it is not an IP.
function normalizeIp(value) {
  if (typeof value !== 'string') return null;
  let text = value.trim().replace(/^"|"$/g, '');
  if (!text || text.length > 64) return null;
  const bracket = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(text);
  if (bracket) text = bracket[1];
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/.test(text)) text = text.slice(0, text.lastIndexOf(':'));
  text = text.replace(/%[A-Za-z0-9._-]+$/, '').toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (mapped) text = mapped[1];
  const family = net.isIP(text);
  if (family === 4) return text;
  if (family === 6) return text;
  return null;
}

function isLoopback(ip) {
  const value = normalizeIp(ip);
  return Boolean(value) && (LOOPBACK_V4.test(value) || value === '::1');
}

// The right-most valid address of a comma-separated chain (X-Forwarded-For), or null. Several header lines arrive joined by Node with ", ".
function lastOfChain(value) {
  const text = Array.isArray(value) ? value.join(',') : value;
  if (typeof text !== 'string' || !text || text.length > 2048) return null;
  const parts = text.split(',');
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const ip = normalizeIp(parts[i]);
    if (ip) return ip;
    if (parts[i].trim()) return null; // garbage where the proxy's entry should be: trust nothing further left
  }
  return null;
}

// The right-most `for=` of a Forwarded header (RFC 7239), or null.
function lastOfForwarded(value) {
  const text = Array.isArray(value) ? value.join(',') : value;
  if (typeof text !== 'string' || !text || text.length > 2048) return null;
  const elements = text.split(',');
  for (let i = elements.length - 1; i >= 0; i -= 1) {
    const match = /(?:^|;)\s*for=("[^"]*"|[^;,\s]+)/i.exec(elements[i]);
    if (match) return normalizeIp(match[1].replace(/^"|"$/g, ''));
  }
  return null;
}

const FORWARD_HEADERS = ['x-forwarded-for', 'x-real-ip', 'forwarded'];
const hasForwardHeaders = headers => FORWARD_HEADERS.some(name => headers && headers[name] !== undefined);

// { ip, via } of a request. via: 'direct' (a non-loopback peer), 'proxy' (a loopback peer and the proxy's address), 'loopback' (a loopback peer and no
// usable proxy address: this machine, or a tunnel whose proxy does not pass the address), 'untrusted' (a loopback peer with forwarding headers while
// no proxy is set up: the peer is used). `trusted`: a boolean or a function that says whether a proxy is set up (read on each call).
function clientAddress(req, { trusted = false } = {}) {
  const socket = (req && (req.socket || req.connection)) || {};
  const peer = normalizeIp(socket.remoteAddress) || '';
  const headers = (req && req.headers) || {};
  if (!peer || !isLoopback(peer)) return { ip: peer || 'unknown', via: 'direct' };
  if (!hasForwardHeaders(headers)) return { ip: peer, via: 'loopback' };
  const isTrusted = typeof trusted === 'function' ? Boolean(trusted()) : Boolean(trusted);
  if (!isTrusted) return { ip: peer, via: 'untrusted' };
  const forwarded = lastOfChain(headers['x-forwarded-for']) || normalizeIp(Array.isArray(headers['x-real-ip']) ? headers['x-real-ip'][0] : headers['x-real-ip']) || lastOfForwarded(headers.forwarded);
  return forwarded ? { ip: forwarded, via: 'proxy' } : { ip: peer, via: 'loopback' };
}

const clientIp = (req, options) => clientAddress(req, options).ip;

// The network an address belongs to for the "far address" rule: the /24 of IPv4, the /64 of IPv6.
function networkOf(ip) {
  const value = normalizeIp(ip);
  if (!value) return null;
  if (net.isIP(value) === 4) return value.split('.').slice(0, 3).join('.');
  return expandV6(value).slice(0, 4).join(':');
}
function expandV6(ip) {
  let text = ip;
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (tail) {
    const [a, b, c, d] = tail[1].split('.').map(Number);
    text = text.slice(0, -tail[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = rest !== undefined && rest ? rest.split(':') : [];
  const fill = rest === undefined ? [] : Array(8 - left.length - right.length).fill('0');
  return [...left, ...fill, ...right].map(part => part.padStart(4, '0'));
}

// Whether a Host header names this machine (localhost or a loopback address): a loopback request with another Host came through a tunnel.
function isLoopbackHost(host) {
  const value = String(host || '').trim().toLowerCase();
  if (!value) return true;
  const bare = value.startsWith('[') ? value.slice(1, value.indexOf(']')) : value.replace(/:\d{1,5}$/, '');
  return bare === 'localhost' || isLoopback(bare);
}

module.exports = { clientAddress, clientIp, normalizeIp, isLoopback, lastOfChain, lastOfForwarded, hasForwardHeaders, networkOf, isLoopbackHost };
