'use strict';
// Reverse tunnel of a service link. Service B may be behind NAT, so it keeps one outbound WebSocket to service A, and A's requests to B travel back over it.
// A stores B as a remote_servers row with base_url tunnel://<linkId>; services/remote-client.js, remote-stream.js and remote-terminal-proxy.js send such a
// base through the hub below and everything above them works unchanged. See "Service links: tunnel" in DESIGN.md for the protocol.
//
// Security: B (startTunnelClient) is the boundary. It only makes loopback requests under /v1, with an allowlist of headers, and the request still carries the
// Engine token A was given, so B's normal /v1 authorisation applies. The tunnel adds no authority of its own. Nothing here logs tokens, bodies or terminal data.
const http = require('http');
const { EventEmitter } = require('events');
const { Readable } = require('stream');
const WebSocket = require('ws');
const { isSendableCloseCode } = require('./websocket-close');

const PROTOCOL_VERSION = 1;
const TUNNEL_PROTOCOL = 'tunnel:';
const TUNNEL_PATH = '/v1/service-links/tunnel';
const LINK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const MAX_TUNNEL_MESSAGE_BYTES = 128 * 1024;
// What a B that does not announce `maxBody` in its hello takes (T-Agent before streamed request bodies): A keeps to it.
const LEGACY_REQUEST_BODY_BYTES = 64 * 1024 * 1024;
// For the WebSocketServer that accepts tunnels: frames are small and already chunked, and compression would hide the send buffer from the flow control.
const TUNNEL_WS_OPTIONS = Object.freeze({ maxPayload: MAX_TUNNEL_MESSAGE_BYTES, perMessageDeflate: false });

const DEFAULT_LIMITS = Object.freeze({
  maxFrameBytes: 64 * 1024, // data per binary frame; larger bodies and messages are chunked
  maxMessageBytes: MAX_TUNNEL_MESSAGE_BYTES, // one tunnel message of any kind
  maxStreams: 128, // open streams per tunnel
  streamWindowBytes: 512 * 1024, // bytes a peer may send on one stream before it needs credit
  highWaterBytes: 1024 * 1024, // the data pump waits while the tunnel socket holds this much
  hardBufferBytes: 32 * 1024 * 1024, // a peer that stops reading but keeps asking loses the tunnel
  maxWsMessageBytes: 32 * 1024 * 1024, // one tunnelled WebSocket message
  maxSendBacklogBytes: 8 * 1024 * 1024, // terminal input waiting on A, which has no way to pause the browser
  // The largest request body B takes on one stream, announced in its hello as `maxBody`. Bodies stream with the same credit as everything else,
  // so this bounds a transfer, not memory: tcli's upload of up to 1 GiB (routes/tcli.js) is the largest any /v1 route takes.
  maxRequestBodyBytes: 1024 * 1024 * 1024,
  heartbeatMs: 20_000,
  helloTimeoutMs: 10_000,
});

// Binary frame: [kind | MORE] [stream id, uint32 big endian] [payload].
const HEADER_BYTES = 5;
const KIND_HTTP = 1;
const KIND_WS_TEXT = 2;
const KIND_WS_BINARY = 3;
const FLAG_MORE = 0x80;

const CLOSE_REPLACED = 4000;
const CLOSE_DROPPED = 4001;
const CLOSE_VERSION = 4406;
const CREDIT_POLL_MS = 20;
const SOCKET_CLOSE_TIMEOUT_MS = 5_000;
const TERMINATE_GRACE_MS = 1_000;

// Request headers a tunnelled request may carry: what /v1 reads (authorization in middleware/engine-auth.js, content-type for the body parsers, range in the raw
// file routes) and the conditional and accept headers of file and event streams. Everything else is refused, not stripped: without forwarded headers, a cookie or
// an origin, a tunnelled request cannot look like a browser session or a different client address.
const ALLOWED_REQUEST_HEADERS = new Set(['authorization', 'content-type', 'accept', 'range', 'if-none-match', 'last-event-id']);
// Response headers that cross back: what services/remote-stream.js forwards. In particular not set-cookie: the access gate may open a session for a loopback request.
const ALLOWED_RESPONSE_HEADERS = ['content-type', 'content-length', 'last-modified', 'etag', 'content-range', 'accept-ranges', 'content-disposition', 'cache-control'];
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
// Credential exchanges and linking are never available through a tunnel; matched without regard to case, as Express routes are.
const FORBIDDEN_ROUTES = [['pair'], ['service-links'], ['file-sync', 'pair']];
const MAX_TARGET_BYTES = 8 * 1024;
const MAX_HEADER_VALUE_BYTES = 8 * 1024;

const isLinkId = value => typeof value === 'string' && LINK_ID.test(value);
const isStreamId = value => Number.isInteger(value) && value >= 1 && value <= 0xffffffff;
const unrefTimer = timer => { if (timer && timer.unref) timer.unref(); return timer; };
const protocolError = detail => Object.assign(new Error('TUNNEL_PROTOCOL_ERROR'), { detail });
const errorCode = value => (typeof value === 'string' && /^[A-Z0-9_]{1,64}$/.test(value) ? value : 'REMOTE_CONNECTION_FAILED');
const forbidden = code => { throw new Error(code); };

function tunnelBase(linkId) {
  if (!isLinkId(linkId)) throw new Error('INVALID_LINK_ID');
  return `tunnel://${linkId}`;
}

function isTunnelBase(baseUrl) {
  return typeof baseUrl === 'string' && baseUrl.startsWith('tunnel://') && isLinkId(baseUrl.slice('tunnel://'.length));
}

function linkIdOf(baseUrl) {
  return isTunnelBase(baseUrl) ? baseUrl.slice('tunnel://'.length) : null;
}

// The boundary of B's side: the request target must be a plain path under /v1, with a query at most. Returns the target unchanged, or throws.
function checkTunnelTarget(target) {
  const refuse = () => forbidden('TUNNEL_PATH_FORBIDDEN');
  if (typeof target !== 'string' || !target || target.length > MAX_TARGET_BYTES) refuse();
  // Printable ASCII only: this refuses control characters, spaces and CR LF. A fragment never belongs in a request target.
  if (/[^\x21-\x7e]|[\\#]/.test(target)) refuse();
  const question = target.indexOf('?');
  const rawPath = question < 0 ? target : target.slice(0, question);
  // Starting at /v1/ rules out absolute URLs and a host in the path. The characters are what encodeURIComponent leaves, so @ : ; and the like are refused too.
  if (!/^\/v1\/[A-Za-z0-9\-._~%!'()*/]+$/.test(rawPath)) refuse();
  // Encoded dots and separators, and double encoding that could hide them, are refused outright.
  if (/%(?:2e|2f|5c|25)/i.test(rawPath)) refuse();
  let decoded;
  try { decoded = decodeURIComponent(rawPath); } catch { refuse(); }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f\\]/.test(decoded)) refuse();
  const segments = decoded.split('/').slice(2);
  if (!segments.length || segments.some(part => !part || part === '.' || part === '..')) refuse();
  const lower = segments.map(part => part.toLowerCase());
  if (FORBIDDEN_ROUTES.some(route => route.every((part, index) => lower[index] === part))) refuse();
  return target;
}

// Returns a clean header object, or throws. A forbidden header refuses the whole request instead of being dropped, so a misbehaving peer is noticed.
function checkTunnelHeaders(headers) {
  const refuse = () => forbidden('TUNNEL_HEADER_FORBIDDEN');
  if (headers === undefined || headers === null) return {};
  if (typeof headers !== 'object' || Array.isArray(headers)) refuse();
  const clean = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!ALLOWED_REQUEST_HEADERS.has(lower) || Object.prototype.hasOwnProperty.call(clean, lower)) refuse();
    if (typeof value !== 'string' || value.length > MAX_HEADER_VALUE_BYTES || /[^\t\x20-\x7e]/.test(value)) refuse();
    if (lower === 'authorization' && !/^Bearer [\x21-\x7e]+$/.test(value)) refuse();
    clean[lower] = value;
  }
  return clean;
}

function pickResponseHeaders(headers) {
  const picked = {};
  for (const name of ALLOWED_RESPONSE_HEADERS) {
    if (typeof headers[name] === 'string' && !/[^\t\x20-\x7e\x80-\xff]/.test(headers[name])) picked[name] = headers[name];
  }
  return picked;
}

function closeReasonOf(reason) {
  const text = reason === undefined || reason === null ? '' : reason.toString();
  return Buffer.byteLength(text) > 123 ? Buffer.from(text).subarray(0, 123).toString() : text;
}

// One tunnelled stream on one Mux. The sink receives what arrives for it.
class Channel {
  constructor(mux, id, sink) {
    this.mux = mux;
    this.id = id;
    this.sink = sink;
    this.sendCredit = mux.peerWindow; // bytes we may still send
    this.receiveAllowance = mux.limits.streamWindowBytes; // bytes the peer may still send
    this.pendingGrant = 0;
    this.queue = [];
    this.queuedBytes = 0;
    this.onDrain = null; // called when the producer may continue
    this.blocked = null; // while this returns true, credit is held back
    this.creditTimer = null;
    this.parts = [];
    this.partBytes = 0;
    this.partKind = 0;
    this.done = false;
  }

  // Collects the fragments of one WebSocket message. Returns the message, null while it is incomplete, or { tooLarge: true }.
  assemble(kind, more, payload) {
    if (kind !== KIND_WS_TEXT && kind !== KIND_WS_BINARY) throw protocolError('wrong data kind');
    if (this.parts.length && this.partKind !== kind) throw protocolError('message kind changed');
    this.partKind = kind;
    this.parts.push(payload);
    this.partBytes += payload.length;
    if (this.partBytes > this.mux.limits.maxWsMessageBytes) {
      this.parts = [];
      this.partBytes = 0;
      return { tooLarge: true };
    }
    if (more) return null;
    const data = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts);
    this.parts = [];
    this.partBytes = 0;
    return { data, binary: kind === KIND_WS_BINARY };
  }
}

// One tunnel WebSocket, on either side: framing, the hello, per-stream credit, a fair data pump and the heartbeat.
class Mux {
  constructor(ws, { side, linkId = null, limits, onReady, onControl, onClosed }) {
    this.ws = ws;
    this.side = side;
    this.linkId = linkId;
    this.limits = limits;
    this.onReady = onReady;
    this.onControl = onControl;
    this.onClosed = onClosed;
    this.streams = new Map();
    this.sending = new Set(); // channels with something to send, in turn
    this.lastId = 0; // the highest stream id opened so far
    this.peerWindow = 0;
    this.peerMaxBody = LEGACY_REQUEST_BODY_BYTES; // the request body the peer takes on one stream (A sends bodies, B announces this)
    this.ready = false;
    this.closed = false;
    this.pumping = false;
    this.lastSeen = Date.now();
    this.afterWrite = () => this.pump();

    ws.on('message', (data, isBinary) => this.onMessage(data, isBinary));
    const touch = () => { this.lastSeen = Date.now(); };
    ws.on('ping', touch);
    ws.on('pong', touch);
    ws.on('error', () => this.terminate());
    ws.on('close', (code, reason) => this.finish(code, reason));

    this.heartbeat = unrefTimer(setInterval(() => this.beat(), limits.heartbeatMs));
    this.helloTimer = unrefTimer(setTimeout(() => this.terminate(), limits.helloTimeoutMs));
    this.sendControl({
      t: 'hello', v: PROTOCOL_VERSION, side, window: limits.streamWindowBytes, ...(linkId ? { linkId } : {}),
      // Optional field: an older hub ignores it, and a hub without it from B keeps to LEGACY_REQUEST_BODY_BYTES.
      ...(side === 'client' ? { maxBody: limits.maxRequestBodyBytes } : {}),
    });
  }

  beat() {
    if (this.closed) return;
    if (Date.now() - this.lastSeen > this.limits.heartbeatMs * 2) { this.terminate(); return; }
    try { if (this.ws.readyState === WebSocket.OPEN) this.ws.ping(); } catch { /* the close event finishes it */ }
  }

  onMessage(data, isBinary) {
    if (this.closed) return;
    this.lastSeen = Date.now();
    try {
      if (data.length > this.limits.maxMessageBytes) throw protocolError('message too large');
      if (isBinary) this.onBinary(Buffer.isBuffer(data) ? data : Buffer.from(data));
      else this.onText(data.toString('utf8'));
    } catch (error) {
      // Malformed input costs the peer its tunnel, never this process.
      console.warn(`[service-link] tunnel closed: ${error && error.message === 'TUNNEL_PROTOCOL_ERROR' ? error.detail : 'internal error'}`);
      this.terminate();
    }
  }

  onText(text) {
    let frame;
    try { frame = JSON.parse(text); } catch { throw protocolError('invalid JSON'); }
    if (!frame || typeof frame !== 'object' || typeof frame.t !== 'string') throw protocolError('invalid control frame');
    if (frame.t === 'hello') { this.onHello(frame); return; }
    if (!this.ready) throw protocolError('frame before hello');
    if (!isStreamId(frame.id)) throw protocolError('invalid stream id');
    if (frame.t === 'credit') { this.onCredit(frame); return; }
    this.onControl(this, frame);
  }

  onHello(frame) {
    if (this.ready) throw protocolError('second hello');
    if (frame.v !== PROTOCOL_VERSION) { this.close(CLOSE_VERSION, 'TUNNEL_VERSION_MISMATCH'); return; }
    if (frame.side !== (this.side === 'hub' ? 'client' : 'hub')) throw protocolError('wrong side');
    if (!Number.isInteger(frame.window) || frame.window < 2 * this.limits.maxFrameBytes || frame.window > 64 * 1024 * 1024) throw protocolError('invalid window');
    if (this.side === 'hub' && frame.linkId !== this.linkId) throw protocolError('link id mismatch');
    clearTimeout(this.helloTimer);
    this.peerWindow = frame.window;
    if (frame.maxBody !== undefined) {
      if (!Number.isSafeInteger(frame.maxBody) || frame.maxBody < 0) throw protocolError('invalid body limit');
      this.peerMaxBody = frame.maxBody;
    }
    this.ready = true;
    this.onReady(this);
  }

  onCredit(frame) {
    if (!Number.isInteger(frame.n) || frame.n < 1 || frame.n > 0x7fffffff) throw protocolError('invalid credit');
    const channel = this.streams.get(frame.id);
    if (!channel) { if (frame.id > this.lastId) throw protocolError('credit for unknown stream'); return; }
    channel.sendCredit += frame.n;
    if (channel.sendCredit > 0x7fffffff) throw protocolError('credit overflow');
    if (channel.queue.length) { this.sending.add(channel); this.pump(); }
  }

  onBinary(buffer) {
    if (!this.ready) throw protocolError('frame before hello');
    if (buffer.length < HEADER_BYTES) throw protocolError('short frame');
    const kind = buffer[0] & ~FLAG_MORE;
    if (kind !== KIND_HTTP && kind !== KIND_WS_TEXT && kind !== KIND_WS_BINARY) throw protocolError('unknown data kind');
    const id = buffer.readUInt32BE(1);
    if (!isStreamId(id)) throw protocolError('invalid stream id');
    const payload = buffer.subarray(HEADER_BYTES);
    if (payload.length > this.limits.maxFrameBytes) throw protocolError('frame too large');
    const channel = this.streams.get(id);
    // Data for a stream that has just ended is normal; data for one that never existed is not.
    if (!channel) { if (id > this.lastId) throw protocolError('data for unknown stream'); return; }
    if (payload.length > channel.receiveAllowance) throw protocolError('flow control violated');
    channel.receiveAllowance -= payload.length;
    channel.sink.data(kind, Boolean(buffer[0] & FLAG_MORE), payload);
  }

  sendControl(frame) {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.ws.bufferedAmount > this.limits.hardBufferBytes) { this.terminate(); return; }
    this.ws.send(JSON.stringify(frame));
  }

  openChannel(id, sink) {
    const channel = new Channel(this, id, sink);
    this.streams.set(id, channel);
    return channel;
  }

  closeChannel(channel) {
    if (channel.done) return;
    channel.done = true;
    channel.queue = [];
    channel.queuedBytes = 0;
    channel.onDrain = null;
    clearTimeout(channel.creditTimer);
    this.sending.delete(channel);
    this.streams.delete(channel.id);
  }

  // A stream error ends the stream at once; whatever was still queued for it is dropped.
  failChannel(channel, code) {
    if (channel.done) return;
    this.sendControl({ t: 'err', id: channel.id, code });
    this.closeChannel(channel);
  }

  cancelChannel(channel) {
    if (channel.done) return;
    this.sendControl({ t: 'cancel', id: channel.id });
    this.closeChannel(channel);
  }

  // Queues a body chunk or a WebSocket message. False means the producer should wait for onDrain.
  sendData(channel, kind, buffer) {
    if (channel.done || this.closed) return true;
    const isMessage = kind !== KIND_HTTP;
    const max = this.limits.maxFrameBytes;
    if (isMessage && !buffer.length) channel.queue.push({ kind, more: false, payload: buffer });
    for (let offset = 0; offset < buffer.length; offset += max) {
      const payload = buffer.subarray(offset, offset + max);
      channel.queue.push({ kind, more: isMessage && offset + max < buffer.length, payload });
      channel.queuedBytes += payload.length;
    }
    this.sending.add(channel);
    this.pump();
    return channel.queuedBytes < this.limits.streamWindowBytes;
  }

  // Sends a control frame after the data queued before it; `last` ends the stream on this side once it has gone.
  sendInOrder(channel, frame, last = false) {
    if (channel.done || this.closed) return;
    channel.queue.push({ control: frame, last });
    this.sending.add(channel);
    this.pump();
  }

  // Round robin, one frame per stream per turn, and only while the socket is not backed up: a big download cannot starve the streams next to it.
  pump() {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    try {
      let progressed = true;
      while (progressed && this.sending.size && this.canWrite()) {
        progressed = false;
        for (const channel of [...this.sending]) {
          if (!this.canWrite()) break;
          if (this.pumpOne(channel)) progressed = true;
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  canWrite() {
    return !this.closed && this.ws.readyState === WebSocket.OPEN && this.ws.bufferedAmount < this.limits.highWaterBytes;
  }

  pumpOne(channel) {
    const item = channel.queue[0];
    if (!item) { this.sending.delete(channel); return false; }
    if (item.control) {
      channel.queue.shift();
      this.sendControl(item.control);
      if (item.last) this.closeChannel(channel);
      return true;
    }
    // Out of credit: it rejoins the turn when credit arrives.
    if (item.payload.length > channel.sendCredit) { this.sending.delete(channel); return false; }
    channel.queue.shift();
    channel.queuedBytes -= item.payload.length;
    channel.sendCredit -= item.payload.length;
    const header = Buffer.allocUnsafe(HEADER_BYTES);
    header[0] = item.kind | (item.more ? FLAG_MORE : 0);
    header.writeUInt32BE(channel.id, 1);
    this.ws.send(Buffer.concat([header, item.payload]), { binary: true }, this.afterWrite);
    if (channel.onDrain && channel.queuedBytes < this.limits.streamWindowBytes / 2) {
      const drain = channel.onDrain;
      channel.onDrain = null;
      drain();
    }
    return true;
  }

  // Bytes of this stream have been dealt with: lets the peer send that many more. Held back while the next hop is congested.
  consumed(channel, bytes) {
    channel.pendingGrant += bytes;
    this.flushGrant(channel);
  }

  flushGrant(channel) {
    if (channel.done || this.closed || channel.pendingGrant < this.limits.streamWindowBytes / 4) return;
    if (channel.blocked && channel.blocked()) {
      if (!channel.creditTimer) {
        channel.creditTimer = unrefTimer(setTimeout(() => { channel.creditTimer = null; this.flushGrant(channel); }, CREDIT_POLL_MS));
      }
      return;
    }
    const n = channel.pendingGrant;
    channel.pendingGrant = 0;
    channel.receiveAllowance += n;
    this.sendControl({ t: 'credit', id: channel.id, n });
  }

  close(code, reason) {
    const { ws } = this;
    this.finish(code, reason);
    try { if (ws.readyState === WebSocket.OPEN) ws.close(code, reason); } catch { /* it is being torn down */ }
    unrefTimer(setTimeout(() => { try { ws.terminate(); } catch { /* already gone */ } }, TERMINATE_GRACE_MS));
  }

  terminate() {
    const { ws } = this;
    this.finish(1006, '');
    try { ws.terminate(); } catch { /* already gone */ }
  }

  // Everything pending fails here, at once, whatever ended the tunnel.
  finish(code, reason) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    clearTimeout(this.helloTimer);
    const channels = [...this.streams.values()];
    this.streams.clear();
    this.sending.clear();
    for (const channel of channels) {
      channel.done = true;
      channel.queue = [];
      channel.onDrain = null;
      clearTimeout(channel.creditTimer);
      try { channel.sink.closed(); } catch { /* one stream must not stop the others */ }
    }
    try { this.onClosed(this, code, closeReasonOf(reason)); } catch { /* same */ }
  }
}

// ---------------------------------------------------------------------------
// A's side: the hub and the objects its callers use like http and ws.
// ---------------------------------------------------------------------------

// Looks like the response of http.request.
class TunnelResponse extends Readable {
  constructor(status, headers, onRead) {
    super({ highWaterMark: 64 * 1024 });
    this.statusCode = status;
    this.headers = headers;
    this.onRead = onRead;
  }

  _read() { this.onRead(); }

  // As with a real response, an abort must not become an uncaught error when nobody listens for one.
  _destroy(error, callback) { callback(this.listenerCount('error') > 0 ? error : null); }
}

// Looks like the ClientRequest of http.request, for what remote-client.js, remote-stream.js and routes/tcli.js use of it. The body streams: the
// first write opens the stream, every chunk is queued on the channel's credit, and write() returns false (then 'drain') once a window is
// queued, so a piped upload holds at most about one window here whatever its size.
class TunnelRequest extends EventEmitter {
  constructor(hub, target, options, onResponse) {
    super();
    this.hub = hub;
    this.linkId = target.hostname;
    this.method = String(options.method || 'GET').toUpperCase();
    this.path = `${target.pathname}${target.search}`;
    this.headers = {};
    for (const [name, value] of Object.entries(options.headers || {})) {
      // The tunnel frames the body itself.
      if (name.toLowerCase() !== 'content-length' && value !== undefined) this.headers[name.toLowerCase()] = String(value);
    }
    this.onResponse = onResponse;
    this.bodyBytes = 0;
    this.timeoutMs = options.timeout || 0;
    this.timer = null;
    this.channel = null;
    this.mux = null;
    this.response = null;
    this.heldCredit = 0;
    this.started = false;
    this.ended = false;
    this.finished = false;
    this.destroyCalled = false;
  }

  get destroyed() { return this.destroyCalled; }

  setTimeout(ms) {
    this.timeoutMs = ms || 0;
    this.touch();
    return this;
  }

  touch() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.timeoutMs > 0 && !this.finished) this.timer = unrefTimer(setTimeout(() => this.emit('timeout'), this.timeoutMs));
  }

  write(chunk, encoding, callback) {
    if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
    const done = typeof callback === 'function' ? callback : null;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    if (!this.ended) this.start(true);
    // Ended, gone or answered already: nothing waits for these bytes, so the writer must not wait either.
    const channel = this.channel;
    if (this.ended || this.finished || !channel || channel.done) {
      if (done) process.nextTick(done);
      return true;
    }
    this.touch();
    this.bodyBytes += buffer.length;
    if (this.bodyBytes > this.mux.peerMaxBody) {
      this.destroy(new Error('TUNNEL_BODY_TOO_LARGE'));
      if (done) process.nextTick(done);
      return true;
    }
    const more = buffer.length ? this.mux.sendData(channel, KIND_HTTP, buffer) : true;
    if (!more && !channel.done) channel.onDrain = () => this.emit('drain');
    if (done) process.nextTick(done);
    return more;
  }

  end(chunk, encoding, callback) {
    if (typeof chunk === 'function') { callback = chunk; chunk = undefined; }
    if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
    if (chunk !== undefined && chunk !== null && chunk.length) this.write(chunk, encoding);
    if (this.ended) return this;
    this.ended = true;
    if (typeof callback === 'function') process.nextTick(callback);
    if (this.started) {
      if (this.channel && !this.channel.done) this.mux.sendInOrder(this.channel, { t: 'end', id: this.channel.id });
    } else {
      // Later, so that callers have attached their listeners whatever happens next.
      process.nextTick(() => this.start(false));
    }
    return this;
  }

  // Opens the stream; `withBody` says data frames and an `end` follow.
  start(withBody) {
    if (this.started || this.finished) return;
    this.started = true;
    const mux = this.hub.tunnels.get(this.linkId);
    if (!mux) { this.destroy(new Error('REMOTE_OFFLINE')); return; }
    if (mux.streams.size >= mux.limits.maxStreams) { this.destroy(new Error('REMOTE_TUNNEL_BUSY')); return; }
    const id = ++mux.lastId;
    this.mux = mux;
    this.channel = mux.openChannel(id, this);
    this.touch();
    mux.sendControl({ t: 'http', id, method: this.method, path: this.path, headers: this.headers, body: withBody });
  }

  control(frame) {
    this.touch();
    if (frame.t === 'head') {
      if (this.response) throw protocolError('second head');
      if (!Number.isInteger(frame.status) || frame.status < 100 || frame.status > 599 || !frame.headers || typeof frame.headers !== 'object') throw protocolError('invalid head');
      this.response = new TunnelResponse(frame.status, pickResponseHeaders(frame.headers), () => this.releaseCredit());
      if (this.onResponse) this.onResponse(this.response);
      return;
    }
    if (frame.t === 'end') {
      if (!this.response) throw protocolError('end before head');
      this.finished = true;
      clearTimeout(this.timer);
      this.mux.closeChannel(this.channel);
      this.response.push(null);
      return;
    }
    if (frame.t === 'err') { this.destroy(new Error(errorCode(frame.code))); return; }
    if (frame.t === 'cancel') { this.destroy(new Error('REMOTE_CANCELLED')); return; }
    throw protocolError('unexpected frame for an HTTP stream');
  }

  data(kind, more, payload) {
    if (kind !== KIND_HTTP || !this.response) throw protocolError('unexpected data for an HTTP stream');
    this.touch();
    if (this.finished || this.response.destroyed) return;
    // The reader's pace is the credit: a paused pipe stops the sender after one window.
    if (this.response.push(payload)) this.mux.consumed(this.channel, payload.length);
    else this.heldCredit += payload.length;
  }

  releaseCredit() {
    if (!this.heldCredit || !this.channel || this.channel.done) return;
    const bytes = this.heldCredit;
    this.heldCredit = 0;
    this.mux.consumed(this.channel, bytes);
  }

  closed() { this.destroy(new Error('REMOTE_OFFLINE')); }

  destroy(error) {
    const { response } = this;
    // After the tunnel has delivered the last byte, the reader can still be working through what is buffered and give up (too large, or gone).
    const stillReading = response && !response.readableEnded && !response.destroyed;
    if (this.destroyCalled || (this.finished && !stillReading)) return this;
    this.destroyCalled = true;
    this.finished = true;
    clearTimeout(this.timer);
    if (this.channel) this.mux.cancelChannel(this.channel);
    if (response && !response.destroyed) response.destroy(error);
    // Destroying without an error after the answer has started is the normal end of a stream whose reader left.
    const failure = error || (response ? null : new Error('REMOTE_CANCELLED'));
    process.nextTick(() => {
      if (failure && this.listenerCount('error')) this.emit('error', failure);
      this.emit('close');
    });
    return this;
  }
}

// Looks like a ws WebSocket, for what remote-terminal-proxy.js uses of it.
class TunnelSocket extends EventEmitter {
  constructor(hub, linkId, path, headers, options) {
    super();
    this.readyState = WebSocket.CONNECTING;
    this.channel = null;
    this.mux = null;
    this.handshakeTimer = null;
    this.closeTimer = null;
    process.nextTick(() => this.start(hub, linkId, path, headers, options));
  }

  get bufferedAmount() { return this.channel ? this.channel.queuedBytes : 0; }

  start(hub, linkId, path, headers, { handshakeTimeout = 0 }) {
    if (this.readyState !== WebSocket.CONNECTING) return;
    const mux = hub.tunnels.get(linkId);
    if (!mux) { this.failConnect('REMOTE_OFFLINE'); return; }
    if (mux.streams.size >= mux.limits.maxStreams) { this.failConnect('REMOTE_TUNNEL_BUSY'); return; }
    const id = ++mux.lastId;
    this.mux = mux;
    this.channel = mux.openChannel(id, this);
    if (handshakeTimeout > 0) {
      this.handshakeTimer = unrefTimer(setTimeout(() => { mux.cancelChannel(this.channel); this.failConnect('REMOTE_TIMEOUT'); }, handshakeTimeout));
    }
    mux.sendControl({ t: 'ws', id, path, headers });
  }

  failConnect(code) {
    clearTimeout(this.handshakeTimer);
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    const error = new Error(code);
    process.nextTick(() => {
      if (this.listenerCount('error')) this.emit('error', error);
      this.emit('close', 1006, Buffer.alloc(0));
    });
  }

  finishClose(code, reason) {
    clearTimeout(this.closeTimer);
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    if (this.channel && this.mux) this.mux.closeChannel(this.channel);
    this.emit('close', code, Buffer.from(reason || ''));
  }

  control(frame) {
    if (frame.t === 'open') {
      if (this.readyState !== WebSocket.CONNECTING) throw protocolError('unexpected open');
      clearTimeout(this.handshakeTimer);
      this.readyState = WebSocket.OPEN;
      this.emit('open');
      return;
    }
    if (frame.t === 'close') {
      const code = Number.isInteger(frame.code) && frame.code >= 1000 && frame.code <= 4999 ? frame.code : 1006;
      if (this.readyState === WebSocket.CONNECTING) { this.mux.closeChannel(this.channel); this.failConnect('REMOTE_CONNECTION_FAILED'); return; }
      this.finishClose(code, closeReasonOf(frame.reason));
      return;
    }
    if (frame.t === 'err' || frame.t === 'cancel') {
      const code = errorCode(frame.code);
      if (this.readyState === WebSocket.CONNECTING) { this.mux.closeChannel(this.channel); this.failConnect(code); return; }
      this.finishClose(1006, '');
      return;
    }
    throw protocolError('unexpected frame for a WebSocket stream');
  }

  data(kind, more, payload) {
    const { mux, channel } = this;
    const message = channel.assemble(kind, more, payload);
    if (message && message.tooLarge) { mux.cancelChannel(channel); this.finishClose(1009, 'Message too big'); return; }
    if (message && this.readyState === WebSocket.OPEN) this.emit('message', message.data, message.binary);
    if (!channel.done) mux.consumed(channel, payload.length);
  }

  closed() {
    if (this.readyState === WebSocket.CONNECTING) this.failConnect('REMOTE_OFFLINE');
    else this.finishClose(1006, '');
  }

  // The browser's socket behind this one: its send buffer holds back credit, so a noisy terminal waits instead of growing memory here.
  limitBy(peer) {
    if (this.channel) this.channel.blocked = () => peer.bufferedAmount > this.mux.limits.highWaterBytes;
  }

  send(data, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    const done = callback || (() => {});
    if (this.readyState !== WebSocket.OPEN) { done(new Error('WebSocket is not open')); return; }
    const isText = typeof data === 'string';
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const binary = options && options.binary !== undefined ? Boolean(options.binary) : !isText;
    if (buffer.length > this.mux.limits.maxWsMessageBytes || this.channel.queuedBytes + buffer.length > this.mux.limits.maxSendBacklogBytes) {
      this.mux.cancelChannel(this.channel);
      this.finishClose(1013, 'Tunnel backlog too large');
      done(new Error('REMOTE_TUNNEL_BUSY'));
      return;
    }
    this.mux.sendData(this.channel, binary ? KIND_WS_BINARY : KIND_WS_TEXT, buffer);
    done();
  }

  close(code, reason) {
    if (this.readyState === WebSocket.CLOSING || this.readyState === WebSocket.CLOSED) return;
    if (this.readyState === WebSocket.CONNECTING) { this.terminate(); return; }
    this.readyState = WebSocket.CLOSING;
    const frame = { t: 'close', id: this.channel.id };
    if (isSendableCloseCode(code)) { frame.code = Number(code); frame.reason = closeReasonOf(reason); }
    this.mux.sendInOrder(this.channel, frame);
    this.closeTimer = unrefTimer(setTimeout(() => {
      if (this.channel && !this.channel.done) this.mux.cancelChannel(this.channel);
      this.finishClose(1006, '');
    }, SOCKET_CLOSE_TIMEOUT_MS));
  }

  terminate() {
    if (this.readyState === WebSocket.CLOSED) return;
    if (this.channel && !this.channel.done) this.mux.cancelChannel(this.channel);
    if (this.readyState === WebSocket.CONNECTING) this.failConnect('REMOTE_CANCELLED');
    else this.finishClose(1006, '');
  }
}
Object.assign(TunnelSocket, { CONNECTING: WebSocket.CONNECTING, OPEN: WebSocket.OPEN, CLOSING: WebSocket.CLOSING, CLOSED: WebSocket.CLOSED });

class TunnelHub {
  constructor(options = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...options };
    this.tunnels = new Map(); // linkId -> the Mux that has completed its hello
    this.handshaking = new Set();
    this.listeners = new Set();
  }

  // Adopts an authenticated WebSocket. It replaces the current tunnel only after its own hello, so a connection that never gets there cannot displace a working one.
  accept(linkId, ws) {
    if (!isLinkId(linkId)) throw new Error('INVALID_LINK_ID');
    const mux = new Mux(ws, {
      side: 'hub',
      linkId,
      limits: this.limits,
      onReady: ready => this.adopt(ready),
      onControl: (active, frame) => this.onControl(active, frame),
      onClosed: closed => this.forget(closed),
    });
    this.handshaking.add(mux);
  }

  adopt(mux) {
    this.handshaking.delete(mux);
    const previous = this.tunnels.get(mux.linkId);
    this.tunnels.set(mux.linkId, mux);
    if (previous) previous.close(CLOSE_REPLACED, 'TUNNEL_REPLACED');
    else this.notify({ linkId: mux.linkId, online: true });
  }

  forget(mux) {
    this.handshaking.delete(mux);
    if (this.tunnels.get(mux.linkId) !== mux) return;
    this.tunnels.delete(mux.linkId);
    this.notify({ linkId: mux.linkId, online: false });
  }

  onControl(mux, frame) {
    const channel = mux.streams.get(frame.id);
    if (!channel) { if (frame.id > mux.lastId) throw protocolError('frame for unknown stream'); return; }
    channel.sink.control(frame);
  }

  notify(change) {
    for (const listener of this.listeners) {
      try { listener(change); } catch { /* one listener must not affect the others */ }
    }
  }

  isOnline(linkId) { return this.tunnels.has(linkId); }

  // The largest request body the far side of a link takes on one stream (its hello's `maxBody`, or the old 64 MiB), or null while it is offline.
  requestBodyLimit(linkId) {
    const mux = this.tunnels.get(linkId);
    return mux ? mux.peerMaxBody : null;
  }

  // Open streams of a link, for diagnostics and tests.
  streamCount(linkId) {
    const mux = this.tunnels.get(linkId);
    return mux ? mux.streams.size : 0;
  }

  drop(linkId, reason = 'TUNNEL_DROPPED') {
    const code = /^[A-Z0-9_]{1,64}$/.test(String(reason)) ? String(reason) : 'TUNNEL_DROPPED';
    for (const mux of [...this.handshaking]) if (mux.linkId === linkId) mux.close(CLOSE_DROPPED, code);
    const mux = this.tunnels.get(linkId);
    if (mux) mux.close(CLOSE_DROPPED, code);
  }

  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // Same shape as http.request(url, options, callback), for a tunnel:// URL.
  request(target, options, onResponse) {
    return new TunnelRequest(this, target, options || {}, onResponse);
  }

  // A WebSocket-like object for the stream at `path` (with its query) on the far side.
  openWebSocket(linkId, path, options = {}) {
    return new TunnelSocket(this, linkId, path, options.headers || {}, options);
  }
}

let hub = null;
function getHub() {
  if (!hub) hub = new TunnelHub();
  return hub;
}

// ---------------------------------------------------------------------------
// B's side: the client that keeps the tunnel and runs each stream as a loopback request.
// ---------------------------------------------------------------------------

// Common admission of a new stream. False: it has been refused with a stream error and no request is made.
function admitStream(mux, frame, check) {
  if (frame.id <= mux.lastId) throw protocolError('stream id reused');
  mux.lastId = frame.id;
  try {
    check();
    if (mux.streams.size >= mux.limits.maxStreams) forbidden('TUNNEL_TOO_MANY_STREAMS');
  } catch (error) {
    mux.sendControl({ t: 'err', id: frame.id, code: errorCode(error.message) });
    return false;
  }
  return true;
}

function runLocalHttp(mux, frame, localPort) {
  let headers;
  const allowed = admitStream(mux, frame, () => {
    if (!ALLOWED_METHODS.has(frame.method)) forbidden('TUNNEL_METHOD_FORBIDDEN');
    checkTunnelTarget(frame.path);
    headers = checkTunnelHeaders(frame.headers);
  });
  if (!allowed) return;

  const channel = mux.openChannel(frame.id, null);
  const fail = () => mux.failChannel(channel, 'REMOTE_CONNECTION_FAILED');
  const local = http.request({ host: '127.0.0.1', port: localPort, method: frame.method, path: frame.path, headers, agent: false }, res => {
    if (channel.done) { res.destroy(); return; }
    mux.sendControl({ t: 'head', id: channel.id, status: res.statusCode, headers: pickResponseHeaders(res.headers) });
    res.on('data', chunk => {
      if (channel.done) return;
      if (!mux.sendData(channel, KIND_HTTP, chunk)) {
        res.pause();
        channel.onDrain = () => res.resume();
      }
    });
    res.on('end', () => mux.sendInOrder(channel, { t: 'end', id: channel.id }, true));
    res.on('error', fail);
    res.on('close', () => { if (!res.complete) fail(); });
  });
  local.on('error', fail);

  let bodyBytes = 0;
  let waitingBytes = 0;
  let waiting = false;
  const release = () => {
    const bytes = waitingBytes;
    waitingBytes = 0;
    if (bytes) mux.consumed(channel, bytes);
  };
  channel.sink = {
    control(next) {
      if (next.t === 'end') { local.end(); return; }
      if (next.t === 'cancel') { mux.closeChannel(channel); local.destroy(); return; }
      throw protocolError('unexpected frame for an HTTP stream');
    },
    data(kind, more, payload) {
      if (kind !== KIND_HTTP || !frame.body) throw protocolError('unexpected request body');
      bodyBytes += payload.length;
      if (bodyBytes > mux.limits.maxRequestBodyBytes) {
        mux.failChannel(channel, 'TUNNEL_BODY_TOO_LARGE');
        local.destroy();
        return;
      }
      waitingBytes += payload.length;
      if (local.write(payload)) release();
      else if (!waiting) {
        waiting = true;
        local.once('drain', () => { waiting = false; release(); });
      }
    },
    closed() { local.destroy(); },
  };
  if (!frame.body) local.end();
}

function runLocalWebSocket(mux, frame, localPort) {
  let headers;
  if (!admitStream(mux, frame, () => {
    checkTunnelTarget(frame.path);
    headers = checkTunnelHeaders(frame.headers);
  })) return;

  const channel = mux.openChannel(frame.id, null);
  const local = new WebSocket(`ws://127.0.0.1:${localPort}${frame.path}`, {
    headers,
    perMessageDeflate: false,
    followRedirects: false,
    handshakeTimeout: 10_000,
    maxPayload: mux.limits.maxWsMessageBytes,
  });
  let opened = false;
  channel.blocked = () => local.bufferedAmount > mux.limits.highWaterBytes;
  local.on('open', () => {
    opened = true;
    if (channel.done) { local.terminate(); return; }
    mux.sendControl({ t: 'open', id: channel.id });
  });
  local.on('message', (data, binary) => {
    if (channel.done) return;
    if (!mux.sendData(channel, binary ? KIND_WS_BINARY : KIND_WS_TEXT, Buffer.isBuffer(data) ? data : Buffer.from(data))) {
      local.pause();
      channel.onDrain = () => local.resume();
    }
  });
  // A refused terminal closes with 1008 and a reason, which the page relies on: code and reason cross unchanged, after any output still queued.
  local.on('close', (code, reason) => mux.sendInOrder(channel, { t: 'close', id: channel.id, code, reason: closeReasonOf(reason) }, true));
  local.on('error', () => { if (!opened) mux.failChannel(channel, 'REMOTE_CONNECTION_FAILED'); });

  channel.sink = {
    control(next) {
      if (next.t === 'cancel') { mux.closeChannel(channel); local.terminate(); return; }
      if (next.t === 'close') {
        if (local.readyState === WebSocket.CONNECTING) { mux.closeChannel(channel); local.terminate(); return; }
        try {
          if (isSendableCloseCode(next.code)) local.close(next.code, closeReasonOf(next.reason));
          else local.close();
        } catch { local.terminate(); }
        return;
      }
      throw protocolError('unexpected frame for a WebSocket stream');
    },
    data(kind, more, payload) {
      const message = channel.assemble(kind, more, payload);
      if (message && message.tooLarge) { local.close(1009, 'Message too big'); return; }
      if (message && local.readyState === WebSocket.OPEN) local.send(message.data, { binary: message.binary });
      mux.consumed(channel, payload.length);
    },
    closed() { local.terminate(); },
  };
}

function tunnelEndpoint(url) {
  let base;
  try { base = new URL(url); } catch { throw new Error('INVALID_REMOTE_URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('INVALID_REMOTE_URL');
  return `${base.protocol === 'https:' ? 'wss:' : 'ws:'}//${base.host}${TUNNEL_PATH}`;
}

function startTunnelClient({ url, token, linkId, localPort, onState, retryMinMs = 1_000, retryMaxMs = 30_000, retryJitter = 0.25, ...limitOptions }) {
  const endpoint = tunnelEndpoint(url);
  if (!isLinkId(linkId)) throw new Error('INVALID_LINK_ID');
  if (typeof token !== 'string' || !token) throw new Error('INVALID_LINK_TOKEN');
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) throw new Error('INVALID_REMOTE_PORT');
  const limits = { ...DEFAULT_LIMITS, ...limitOptions };

  let stopped = false;
  let socket = null;
  let mux = null;
  let attempt = 0;
  let onlineSince = 0;
  let retryTimer = null;
  const report = state => {
    if (typeof onState !== 'function') return;
    try { onState(state); } catch { /* the caller's problem must not end the tunnel */ }
  };

  const retry = error => {
    report({ online: false, error });
    // A tunnel that stayed up has earned a fresh start; one that drops right after connecting keeps backing off.
    if (onlineSince && Date.now() - onlineSince >= retryMaxMs) attempt = 0;
    onlineSince = 0;
    const delay = Math.min(retryMinMs * 2 ** attempt, retryMaxMs);
    attempt += 1;
    retryTimer = unrefTimer(setTimeout(connect, delay + Math.random() * delay * retryJitter));
  };

  function connect() {
    if (stopped) return;
    let lastError = 'TUNNEL_CONNECT_FAILED';
    const ws = new WebSocket(endpoint, {
      headers: { Authorization: `Bearer ${token}` },
      ...TUNNEL_WS_OPTIONS,
      handshakeTimeout: 15_000,
      followRedirects: false,
    });
    socket = ws;
    let revoked = false;
    let opened = false;
    ws.on('unexpected-response', (req, res) => {
      const status = res.statusCode;
      res.resume();
      if (status === 401 || status === 403) {
        revoked = true;
        stopped = true;
        report({ online: false, error: 'LINK_REVOKED' });
      } else lastError = `TUNNEL_HTTP_${status}`;
      ws.terminate();
    });
    ws.on('error', () => { /* the close event that follows decides what happens next */ });
    ws.on('open', () => {
      opened = true;
      mux = new Mux(ws, {
        side: 'client',
        linkId,
        limits,
        onReady: () => {
          onlineSince = Date.now();
          report({ online: true, error: null });
        },
        onControl: (active, frame) => {
          if (frame.t === 'http') { runLocalHttp(active, frame, localPort); return; }
          if (frame.t === 'ws') { runLocalWebSocket(active, frame, localPort); return; }
          const channel = active.streams.get(frame.id);
          if (!channel) { if (frame.id > active.lastId) throw protocolError('frame for unknown stream'); return; }
          channel.sink.control(frame);
        },
        onClosed: () => {},
      });
    });
    ws.on('close', (code, reason) => {
      if (socket === ws) { socket = null; mux = null; }
      if (opened) {
        const text = closeReasonOf(reason);
        if (code === CLOSE_VERSION) lastError = 'TUNNEL_VERSION_MISMATCH';
        else lastError = /^[A-Z0-9_]{1,64}$/.test(text) ? text : 'TUNNEL_CLOSED';
      }
      if (revoked) return;
      if (stopped) { report({ online: false, error: null }); return; }
      retry(lastError);
    });
  }

  connect();
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(retryTimer);
      if (mux) mux.close(1000, 'TUNNEL_STOPPED');
      else if (socket) socket.terminate();
    },
  };
}

module.exports = {
  TUNNEL_PROTOCOL,
  LEGACY_REQUEST_BODY_BYTES,
  TUNNEL_PATH,
  TUNNEL_WS_OPTIONS,
  ALLOWED_REQUEST_HEADERS,
  tunnelBase,
  isTunnelBase,
  linkIdOf,
  getHub,
  createHub: options => new TunnelHub(options),
  startTunnelClient,
  checkTunnelTarget,
  checkTunnelHeaders,
};
