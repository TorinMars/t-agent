# Browser extension

> Part of the T-Agent design document. The index of all parts is [DESIGN.md](../../DESIGN.md).

A Chrome extension (Manifest V3, `extensions/chrome/`) that agent sessions drive with `tcli browser ...`, so a model can open and operate web pages in the person's own, logged-in Chrome, read the page and its network traffic, and record how a site works (the material of the site capability library, `tcli site`). Three parts: the extension (`extensions/chrome/`, its own tests), the core described here (the server bridge, pairing, the tcli relay, `tcli browser`, recordings, the Settings part), and the site library (its own section). This section holds the shared contract (v1) in compact form; anything not fixed by it is a decision of the part that owns it, listed under "Core decisions".

- **`tabs.reveal { origin }`** (extension 1.0.3, the one method beyond the 25 of v1; in `METHODS` of `services/browser-bridge.js`): brings the tab of a T-Agent page to the front for the desktop window's Open session (`POST /api/attention/widget/open-terminal`). The tab is a top-level page of that exact origin (no `pane` parameter); the active tab of the last focused window when it is one, else the one used last (`lastAccessed`). It reads no page, so it needs no handed tab. `{ focused: true, tab_id }`, or `{ focused: false }` when there is no such tab; an origin that is not `http(s)://host[:port]` is `BAD_PARAMS`. An older extension does not list it in its `hello`, so the bridge answers `UNKNOWN_METHOD` and the caller falls back.

```
tcli browser (terminal) --HTTP, hook token--> /api/tcli/browser/* --+
                                                                    |  services/browser-bridge.js
Settings page --login--> /api/browser-ext* ------------------------+--> pairing, tokens (system_state browser_ext_v1)
                                                                    |    commands c_<n> with timeouts, events
extension options page --one-time code--> POST /api/browser-ext/pair|
extension service worker <==WebSocket /api/browser-ext/ws
```
