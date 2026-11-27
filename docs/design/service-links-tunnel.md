# Service links: tunnel

> Part of the T-Agent design document. The index of all parts is [DESIGN.md](../../DESIGN.md).

Service B may be behind NAT, so A cannot reach it. B keeps one outbound WebSocket to A (`<A>/v1/service-links/tunnel`, `Authorization: Bearer <link token>`), and A's requests to B travel back over it. A stores B as a normal `remote_servers` row with `base_url` = `tunnel://<linkId>`. `lib/service-link-tunnel.js` is the transport; the code that creates, stores and revokes links is separate. A user can never enter a `tunnel://` address: `normalizeBaseUrl` refuses it, and editing a linked row keeps its base.

Dispatch: `services/remote-client.js` and `services/remote-stream.js` use `getHub()` in place of `http`/`https` for a `tunnel:` URL (the hub's `request` has the shape of `http.request`, so limits and error codes are shared); `services/remote-terminal-proxy.js` uses `hub.openWebSocket`, which behaves like a `ws` socket. Pending work on a lost tunnel fails at once with `REMOTE_OFFLINE`.

Protocol (version 1). Text messages are JSON control frames, binary messages are `[kind | MORE][stream id: uint32 BE][payload]`, with kind 1 HTTP body, 2 WebSocket text, 3 WebSocket binary; MORE (0x80) marks a fragment of a WebSocket message. Only A opens streams.

| Frame | Direction | Meaning |
| --- | --- | --- |
| `hello` `{v, side, window, linkId, maxBody}` | both, first | version and the receive window of that side; a wrong version closes with 4406. `maxBody` (B only, optional): the largest request body B takes on one stream |
| `http` `{id, method, path, headers, body}` | A to B | HTTP stream; `body` says data frames and `end` follow |
| `head` `{id, status, headers}`, `end` `{id}` | B to A (`end` also A to B) | the response head; end of a body |
| `ws` `{id, path, headers}`, `open` `{id}` | A to B, B to A | WebSocket stream and its handshake |
| `close` `{id, code, reason}` | both | WebSocket close with its code and reason |
| `err` `{id, code}`, `cancel` `{id}` | both | the stream failed or the requester left |
| `credit` `{id, n}` | both | the receiver has dealt with `n` more bytes |

Limits (`DEFAULT_LIMITS`): 64 KiB of data per frame, 128 KiB per tunnel message, 128 streams per tunnel (`TUNNEL_TOO_MANY_STREAMS` from B, `REMOTE_TUNNEL_BUSY` from A), a request body of 1 GiB (`maxRequestBodyBytes`, the largest any `/v1` route takes: tcli's upload), a WebSocket message of 32 MiB (larger closes with 1009; a message from B's local server above it ends that socket without a code, and B reports it to A as 1009). The response size limit of a buffered request stays that of the caller.

Request bodies stream. A's `TunnelRequest` opens the stream at the first `write()` (`http` with `body: true`), queues every chunk on the stream's credit and returns false once a window (512 KiB) is queued, then emits `drain`, so a piped upload holds about one window on A whatever its size; B writes each frame to its loopback request and grants credit only when that request has taken it (`drain`), so B holds about one window too. `end()` sends `end` after the data. A body never sits whole in memory on either side; the size limit bounds a transfer, not memory. A requester that leaves (`destroy()`) sends `cancel`, and B destroys its loopback request, so the route on B sees an aborted body (tcli's upload then fails, with no object stored); a tunnel that closes fails the request on A with `REMOTE_OFFLINE` and destroys the loopback request on B. Either way the stream is released and the other streams of the tunnel go on. Every `write()` restarts the request's idle timeout.

Compatibility of the body limit: B announces its limit as `maxBody` in its hello (optional field of protocol version 1; an older hub ignores it). A keeps to it (`hub.requestBodyLimit(linkId)`, null while offline): a B that announces nothing is a T-Agent from before streamed bodies and takes 64 MiB (`LEGACY_REQUEST_BODY_BYTES`). A body above the announced limit fails on A with `TUNNEL_BODY_TOO_LARGE` and a `cancel`; B still checks its own limit (`err` `TUNNEL_BODY_TOO_LARGE`). The frames are the same as before, so an older B gets the stream as it always did (an older A sent the whole body at `end()`, within 64 MiB); only the limit differs. Responses (downloads) always streamed this way.

Flow control is per stream: a side may send one window (512 KiB) before it needs `credit`, and credit is granted when the data has been dealt with (the reader of the HTTP response, the local socket, the browser's socket through `limitBy`). A paused reader or a slow browser therefore stops the producer after one window, and a pump sends one frame per stream in turn while the socket buffer is below 1 MiB, so a big download cannot starve the streams next to it. Sending beyond the window is a protocol error.

Health: both sides ping about every 20 s and close a tunnel silent for two intervals. Malformed frames close the tunnel, never the process. A newer tunnel for the same link replaces the older one after its own hello (close 4000), so a connection that never completes its hello cannot displace a working one. B reconnects with backoff from 1 s to 30 s with jitter; a 401 or 403 answer to the upgrade stops it and reports `LINK_REVOKED`.

B's side is the security boundary. A stream runs only as a loopback request to `127.0.0.1:<localPort>`, and is refused with a stream error, without any request, when:

- the method is not GET, HEAD, POST, PUT, PATCH or DELETE;
- the target is not a plain path under `/v1/` (refused: `..` and `.` segments, empty segments except one trailing slash (the root of VS Code in the browser is `<base>/`), `%2e`, `%2f`, `%5c`, `%25`, backslashes, absolute URLs or a host in the path, control characters, any byte outside printable ASCII, and any path character `encodeURIComponent` would not leave);
- the path is `/v1/pair`, `/v1/service-links` or `/v1/file-sync/pair` or below them, in any case;
- a header is not on the allowlist `authorization` (Bearer only), `content-type`, `accept`, `range`, `if-none-match`, `last-event-id`. A disallowed header refuses the request instead of being dropped.

Every request still carries the Engine token A was given, so `/v1` authorisation applies and the tunnel adds no authority. Only the headers `remote-stream.js` forwards cross back, and `location` for the redirects of VS Code in the browser (`services/vscode-proxy.js` rewrites it to a path on the page's origin, see docs/design/vscode-web-proxy.md); never `set-cookie`.

A tunnelled request reaches B as a plain loopback request (loopback socket, `Host: 127.0.0.1:<port>`, no forwarded headers), so `isLocalInitialization` is true: the access gate and `upgradeAllowed` let it through in the `local` and `unset` modes, and in `local` mode the gate marks a session of that request as trusted. That session is never usable, because the cookie does not cross back and `/api`, the login routes and the pages cannot be reached through the tunnel.
