# Access log: devices, addresses and sign-ins

> Part of the T-Agent design document. The index of all parts is [DESIGN.md](../../DESIGN.md).

## Access log

Which devices use this server, from which address, and the sign-ins, so the person can spot use that is not theirs, get an alert in T-Attention and sign a device out (the user's request, 2026-11-25). Server: `services/access-log.js`, `lib/client-ip.js`, `routes/access.js` (`/api/access`), the hooks in `server.js` and `routes/auth.js`. Page: Settings → Account and access → "Devices and sign-ins" ([page-files-and-settings.md](page-files-and-settings.md)).

**Where it lives.** On this machine only, never synced: a company computer or another engine keeps its own log of the visits it gets. Only the switch "Alert me about new devices" is shared (settings sync group `access-alerts`, `access_alerts_v1`, [settings-sync.md](settings-sync.md)). `/v1/info` lists `access:log` (nothing is served on `/v1`).

**Device id.** Every browser has a random id (`ta-device-id`, a `browser` key of `public/js/local-keys.js`, `TALocalKeys.deviceId()`): the page sends it as `X-TA-Device` on every same-origin request, the login page with the login, and the terminal websocket as `device=` in its query. The Mac app loads the same page. It is a label, never a credential: anyone can send any id, and nothing is decided by it alone. What signs a device out is its login sessions: a login binds the new session to the id it came with (`session.access = { deviceId, boundAt }`), and every later request of that session is that device whatever header it sends. A session that has no binding yet (signed in before this version, or by an old cached login page) is bound by its first request that names a device.

**Tables** (schema 27, created by `db/schema.sql`, nothing to move):

| Table | Rows |
| --- | --- |
| `access_devices` | one per device id: `name` (derived once from the User-Agent: "iPhone · Safari", "Mac · Chrome", "T-Agent Mac App" for the app's `T-AgentApp/<version>`; the raw User-Agent is never kept), `custom_name` (Rename), `first_seen`, `last_seen`, `last_ip`, `confirmed`, `revoked_at`, `alerted_at`, `attention_id` (its open alert). The session count is read from the `sessions` table. |
| `access_device_ips` | the addresses a device was seen from (the newest 50 per device), for the "new address" rule and the count in the list. |
| `access_events` | `at`, `device_id`, `ip`, `kind` (`login_ok`, `login_failed`, `new_device`, `new_ip`, `revoked`, `blocked`), `detail` (a short English line). |

**What is written.** Not every request: a device's row is touched at most once per 10 minutes for the same address (in memory), and an event only for the kinds above. Never a request body, token, code, recovery code or terminal text. Events, and addresses not seen since, are deleted after 90 days (at start and once a day, `startRetention`, the same pattern as the usage data); the devices stay until forgotten.

**Detection.**
- A device id never seen before is `new_device`; in authenticator mode (`remote`) it raises a T-Attention item: source `access-log`, status `waiting_user`, title "New device signed in: <name>, IP <ip>. Was it you?", notes that say what to do. Marking the item done is "It was me" (the device is confirmed); "It was me" in Settings closes the item.
- Learned silently (an event, no alert, confirmed): the very first device of a fresh log, a device whose session was signed in before the access log started (`access_log_v1.started_at`, or a hand-over: `authenticatedAt` 0), and every device in local access mode (all visits come from this machine there).
- A known device from an address it was never seen from is `new_ip`; it alerts ("Known device signed in from a new address: …") only when the address is outside the /24 (IPv4) or /64 (IPv6) of every earlier address of it that is not a loopback one, and is not loopback itself.
- Five wrong codes (`login_failed`) from one address within 10 minutes raise "<n> wrong codes from IP <ip> in 10 minutes". A login refused because of the existing attempt limit (`AUTH_RATE_LIMITED`, 10 per address per 15 minutes) is `blocked`.
- Rate limit: at most one alert per device per hour (`alerted_at`) and one wrong-code alert per address per hour. The switch "Alert me about new devices" (`access_alerts_v1`, on by default) turns all alerts off; the events are still written.

**Sign out a device.** `POST /api/access/devices/:id/revoke` deletes every session bound to that device (`json_extract(sess, '$.access.deviceId')`), closes their open terminal websockets (`disconnectClientSession`), sets `revoked_at` and writes `revoked`. Its next request meets the login gate like an expired session (404 / the login page); a copy of a session that is still around, or an unbound session that names a signed-out id, loses its login (`blocked`, once an hour). Logging in with a code again clears `revoked_at`. The device in use cannot sign itself out (`ACCESS_CURRENT_DEVICE`: Log out is for that). In local access mode there is no login: `ACCESS_NO_LOGIN`, and the page says devices are only logged.

**API** (session and origin checks of `/api`, `Cache-Control: no-store`; errors `{ error, message }`):

| Route | Answer |
| --- | --- |
| `GET /api/access/devices` | `{ mode, can_sign_out, current_device, alerts: { enabled }, ip_note, devices: [{ id, name, derived_name, custom_name, first_seen, last_seen, last_ip, ips_seen_count, confirmed, revoked_at, current, sessions, loopback }] }`, newest `last_seen` first |
| `GET /api/access/events?before=<id>&limit=<1..100, 30>` | `{ events: [{ id, at, device_id, device_name, ip, kind, detail }], more }`, newest first |
| `POST /api/access/devices/:id/rename { name }` | `{ device }`; '' or null goes back to the derived name; one line of at most 60 characters (`ACCESS_NAME_INVALID`) |
| `POST /api/access/devices/:id/confirm` | `{ device }` ("It was me") |
| `POST /api/access/devices/:id/revoke` | `{ ok, device, sessions_ended }` |
| `DELETE /api/access/devices/:id` | `{ ok }`: forgets the device and its events; it is not signed out, and a later visit is a new device |
| `GET` / `PUT /api/access/settings { access_alerts }` | `{ access_alerts }` (`ACCESS_SETTINGS_INVALID` for a non-boolean) |

## Client address

`lib/client-ip.js` `clientAddress(req, { trusted })` is the one place that says where a request came from (only for the log and its alerts):

- A socket peer that is not loopback is the address (`via: 'direct'`). Its forwarding headers are never read: anyone can send them.
- A loopback peer is this machine: a local browser, or the SSH reverse tunnel / frp client that carries the VPS's reverse proxy here. Only while a proxy is set up (`trusted`), the address the proxy appended is used (`via: 'proxy'`): the RIGHT-MOST valid entry of `X-Forwarded-For` (a client can put anything at the left of the chain), then `X-Real-IP`, then the right-most `for=` of `Forwarded`. Ports and brackets are stripped, `::ffff:a.b.c.d` is shown as IPv4, and an entry that is not an IPv4 or IPv6 address is never taken (garbage where the proxy's entry should be stops the search).
- `trusted`: `TRUSTED_PROXY` in `.env`: `auto` (default) is on while an SSH tunnel (`ssh_tunnel_config.host`), frp (`frp_config.serverAddr`) or a public page address (the T-Attention notifier rules) is set up, read again every 30 seconds; `on`; `off`.

The checks that decide whether a request is local (`isLocalInitialization` in `services/client-auth.js`, `fromThisMachine` in `lib/terminal-relay-auth.js`) are unchanged: any forwarding header still makes a request not local (`test/access-log.test.js` holds that). Express's `trust proxy` (one hop, for secure cookies and the login attempt limit's `req.ip`) is unchanged too.

**The tunnel note.** `ip_note` in `GET /api/access/devices` says something about the request that read it: `tunnel_no_forward` for a loopback peer without any forwarding header whose Host is not a loopback name (it came through the tunnel, and the proxy does not pass the address: every visit then shows 127.0.0.1), `untrusted_forward` for forwarding headers that are not used (no tunnel or public address is set up here). The page shows a caption for each.

**The VPS proxy.** The deployment of T01: the page at torinmoon.icu is served by a reverse proxy on a VPS, which forwards to the SSH reverse tunnel's port on the VPS (127.0.0.1:<remote port>), which reaches this server from 127.0.0.1. The proxy must set `X-Forwarded-For` to the address it saw, replacing whatever the client sent:

- nginx: `proxy_set_header X-Forwarded-For $remote_addr;` (not `$proxy_add_x_forwarded_for`, which keeps the client's own header in front; the right-most rule copes with that too, but a clean chain is clearer) and `proxy_set_header X-Real-IP $remote_addr;`.
- Caddy: `reverse_proxy` sets `X-Forwarded-For` by default (with `trusted_proxies` unset it does not pass the client's header on).
- A CDN or a second proxy in front of the VPS proxy: the right-most entry is then the CDN's address; set the VPS proxy to take the real address from the CDN (`real_ip_header` with `set_real_ip_from`) first.

**Limits and caveats.**
- Not verified against a real VPS and tunnel in tests: the tests send the headers a proxy would send to a loopback peer (`test/access-log-server.test.js`, `TRUSTED_PROXY=on`).
- While `trusted` is on, a process on this machine can make up `X-Forwarded-For` through the loopback; the address is a label for the log, never a security decision.
- The device id is a label: a person who has a valid session cookie can send any id, and a new browser profile is a new device. Signing out works on sessions, so a stolen cookie is ended by signing its device out only when the cookie was bound to that device.
- An EventSource (`/api/attention/stream`) cannot send the header; its device is the session's.
