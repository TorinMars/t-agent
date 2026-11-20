# Continue and drafts

> Part of the T-Agent design document. The index of all parts is [DESIGN.md](../../DESIGN.md).

Picking up on one device where the person left off on another (the rule "One experience on every device and engine" in `AGENTS.md`): a "Continue <session>" hint on entry, and the text of the draft box that follows its session. Both ride on the shared page state ([shared-page-state.md](shared-page-state.md)), which the server pushes to every open page in about a second, so nothing in the server's stream, the sync or the routes changes for them. Mockup: `ContinueHint` (the program of 2026-11-20).

Code: `public/js/continue-drafts.js` (`window.TAContinue`: the pure rules and the page's draft controller; a classic script of `h5.html`, combined with the others, not in the first-screen bundle), h5.js "The Continue hint" and "Drafts that follow their session", `Notice.jsx` (`ActionNotice` with `lead`, `detail`, `close`, `ms`), `Terminal.jsx` (`DraftNote`), `services/page-state-merge.js` and `public/js/page-state.js` (the `client` and `device` of a recent entry), `recent-sessions.mjs` (`cleanEntry`, `noteRecent`).

## Where a session was looked at

- A recent entry ("Recent sessions" in [session-switcher.md](session-switcher.md)) carries `client`, the kind of client that noted it, and `device`, a random id of that browser. Both are optional and left out when unknown, so an entry from an older page keeps the same JSON (and digest) as before; the merge rules check them (`client` one of `phone`, `computer`, `mac`, `home`; `device` 8 to 32 lower-case letters and digits).
- The client kind (`clientKind`): the Mac app (its `tagentOpen` message handler) is `mac`, a Home Screen app (standalone display mode) `home`, an iPhone, iPad or Android browser `phone`, anything else `computer` (from `OpenLink.environment`, open-links.md). Shown as "phone", "computer", "Mac app", "Home Screen app".
- The device id is `ta-device-id` in localStorage (a `browser` key of `public/js/local-keys.js`): without storage it is new on every page load.
- `noteShown` stamps this device on the entry when the page has just come to the session (`recentShownKey` changed), also when the session was already first because another device noted it (`noteRecent` notes it again when the `device` differs). Drawing the same session again never restamps it, so two devices that show one session never take turns noting it.

## The continue hint

- When: once after the page opened, and again when it comes back after 5 minutes or more hidden; only after the task list is known and the shared state was read or pushed since then (`TAPageState.answered()`, then the next answer), and after the page opened its own session (or 4 s without one). Not in a column pane, not while the columns view is shown.
- Which session: the session last looked at anywhere before this page came, that is the first of the shared Recent list, where an entry this page noted since it opened counts as it was before that (`notedHere`, the entry from before the note).
- Not offered when that session is the one this device shows (it opened it anyway), is gone (not in the page's pruned Recent list), was last looked at more than 12 hours ago, on this same device (its `device`), or by a page that did not say where (no `client`).
- Look: the MD2 snackbar of `ui.notify` with an action, at the top centre like every notice ("Floating notices" in [toast.md](toast.md)): "Continue **<session name>**" (the name in bold, `translate="no"`; the task's title when the session has no name), a second line "Last viewed on your <client> · <relative time>" (caption, `text.secondary`), the text button "Open" and a close button. It goes after 10 s; clicking away does not close it. Open switches to the session the way the switcher does (`ui.actions.openRow`); nothing switches by itself. A newer notice replaces it.

## Drafts

- **Store**: one key per session in the shared page state, `ta-draft:<16 hex>` (two FNV-1a hashes of `<instance>|<task>|<terminal>`: a key name allows no `|` or capitals), the value `{ instance, task, terminal, text, at, client, device }`; `null` when it was sent or emptied (a cleared key travels like any other and goes after 30 days). The shared state's merge keeps the later version of a key, so the newer edit wins. A draft is read only for its own session, when it has text, at most 4,000 characters and at most 7 days old.
- **The box follows the shown session**: when the shown terminal changes (`renderSessionName`, only once the task's terminal list has it), the text typed for the session left is written and the box shows the new session's draft (or nothing). A session of an engine without an instance id keeps its draft in this page only.
- **Writing**: the first change is written at once, then at most every 2 s while typing (each write is one `PUT` 800 ms later and one push to every page), and at once with a send on blur and when the page hides or closes (keepalive). A text longer than 4,000 characters stays in this box only (no note; the shared draft keeps its last shorter version). After a send (`submitBox`) the rest of the box, usually nothing, is written, so a sent draft is cleared everywhere; a send that ends after a switch clears the session it started in. The top page clears drafts older than 7 days and the oldest beyond 20 when it writes one (the shared state holds at most 128 keys).
- **A draft from another device** (pushed, `arrival`):
  - into an empty box that does not have the focus, or a box that still holds a draft taken from another device unchanged: it is put in the box, with the caption "Draft from your <client> · <relative time>" above it. The caption goes when the person edits or sends.
  - this box has its own different text: the box is left alone and the caption is the text button "Use the draft from your <client>", which puts that draft in the box.
  - the box has the focus: nothing changes; it is decided again when the box loses the focus.
  - this browser's own write coming back changes nothing.
- **Sent or emptied elsewhere**: a box that holds exactly the draft that was cleared, and does not have the focus, is emptied; text the box kept while another draft won stays.
- **Caption** (`DraftNote`, `#h5-draft-note`, `state.draftNote` `{ kind: 'took' | 'offer', text }`): caption type in `text.secondary`, the offer as a small primary text button `#h5-draft-use` (44px in touch input mode). On a touch screen it is the first line of the draft box and is shown and hidden with it (the box is hidden until it has the focus, as before); on a computer and in a column it sits just above the box, over the terminal's last line, on the paper colour, like the box growing upward. The translate-and-send rules, the focus rules and the phone layout are unchanged.

## Known limits

- The hint and the captions say "phone" for an iPad in a browser (its user agent is that of a Mac with touch points, as open-link.js reads it).
- Two columns of one browser showing one session do not fill each other's boxes (one device id).
- During a version skew an older engine drops `client` and `device` when it stamps an entry, and its pages neither write drafts nor show the hint; the digest of its state differs for entries that carry them, so the periodic round exchanges the state more often until it is updated.
- A draft longer than 4,000 characters does not follow its session.

Tests: `test/continue-drafts.test.js` (the key, the client kind, reading a draft, `arrival` for every case, the hint rules, stale drafts, the controller over a fake shared state with a fake clock: writing at once then every 2 s, blur, the cap, the swap with the session, follow, offer, focus, clear, send, an engine without an instance id; `client` / `device` through the merge rules, the page mapping and `noteRecent`), `scripts/test-h5-continue-drafts-browser.cjs` (a computer of T01 and an iPhone of K01 over one pushed state: the hint, Open, close, the 10 s timeout, no hint for the session the phone opens itself; a draft from the computer in the phone's box within 3 s with its caption, a send clears both, the reverse direction, own text offered the other draft, a focused box unchanged, an emptied draft cleared everywhere; screenshots with `SHOTS_DIR`).
