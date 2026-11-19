# The page: session switcher

> Part of the T-Agent design document. The index of all parts is [DESIGN.md](../../DESIGN.md).

The switch button (`#h5-cycle`, the `cycleSessions` icon "⇋") of the single view opens the recently shown sessions: on a phone-sized area a stack like
the iPhone app switcher (2026-11-19, mockup `SwitcherPhone.dc.html`), on a wider one a row of cards (2026-11-19, mockup `SwitcherWideB.dc.html`; it
replaced the stack of `SwitcherDesktop.dc.html` there, whose fixed 300 x 380 cards left the area empty and named only the session above a card). It replaced the "Next running or pending session" button of the
single view. A column of the multi-column view keeps that action in its "More tools" (`#h5-more-cycle`, `ui.actions.nextActiveSession`; see "Next
running or pending session" in [page-terminal-and-bottom-bar.md](page-terminal-and-bottom-bar.md)).

## Session switcher

- **Recent sessions** (`scripts/h5-shell/recent-sessions.mjs`, pure; h5.js "Recent sessions", through `ui.recent` from `entry.jsx`): the terminal sessions
  this page showed, most recently shown first, at most 12 (`RECENT_MAX`). An entry is `{ sourceKey, taskId, terminalId, title, agent, lastUsed? }`: the device,
  the task and the terminal, plus the session's name and agent kind as they were when last shown (a task that is not selected has no terminal list in
  the page), and when it was last used (ms, 2026-11-19): `noteRecent(..., { now, leave })` stamps an entry when it is shown, and the entry it replaces at
  the top when this page had shown that one itself (h5.js `recentShownHere`), so a list from an earlier visit keeps its times; older stored lists have no
  time and stay readable. A rename or a delete from a session menu updates the entry (`editRecent`, h5.js `changeRecent`). The task list's Recent tab
  draws the same list as rows ("Recent tab" in [page-task-list.md](page-task-list.md)). `noteShown` notes it whenever the shown terminal changes by any path (it runs in `renderSessionName`, where `state.shownTarget` is set: the
  task list, the header, T-Attention, the switcher, a deep link, the page load). Other engines' sessions (K01) are entries of their own, keyed by
  device, task and terminal. Remembered on this device (`h5-recent-sessions` through h5.js `store`, guarded like every key). `state.recent` is the list
  without the sessions that are gone: the task is not in `state.taskList`, or the terminals of its task are known (the selected task, an expanded
  one) and it is not among them. The stored list forgets them only once every listed device answered and none is offline (an offline device keeps its
  sessions). A pane keeps none and never opens the switcher.
- **Opening** (`ui.actions.pressSwitcher`): the first press opens it (`openSwitcher`: the focused input is blurred and the terminal's own keyboard
  closed first); a press while it is open counts in `state.switcher.press` and switches to the centred (selected) card, so two quick presses go to the previous
  session and two more come back. No keyboard shortcut opens it. The button has no count and no badge; it is `aria-haspopup="dialog"` with
  `aria-expanded` (the selected look of the row's tools) while open.
- **Place**: computer (input mode `pointer`): the button is in the bottom row between Docs and "More tools" (40px), also in the narrow row (Saved
  commands and Docs go into More first); the switcher covers the terminal area, between the header and the bottom row. Touch: the last button of the
  tool row; the switcher covers the header, the terminal and the key row, so the tool row and the bottom navigation stay. Measured from the page
  (`#h5-app`, `#h5-terminal`, `#h5-bottom` / `#h5-actions`) and kept current (ResizeObserver, resize); a fixed element at z-index 1100, a portal under
  `<body>` (under MUI's modals; above the chat at 108).
- **Stack** (`Switcher.jsx`, a lazy chunk `screen-switcher.jsx` preloaded from `#h5-cycle` by `lazy-screens.jsx`; App.jsx draws it from the `switcher`
  key only, and the open switcher reads the rest itself, so a closed one draws nothing on an activity push), for an area under 600px wide: the
  current session is the top card, peeking in from the right; the previous one is centred; older ones lie behind it to the left, each `step` px
  further, 4% smaller and 18% darker (`cardPlace`); phone-sized cards (250 x 500 at most, 56px apart, the current card 18px less than a card width to
  the right). A session that is neither centred nor current has no card when no terminal is shown (a chat): then the newest is centred. The background is a radial gradient of the theme's
  `background.default`, lighter in the middle.
- **The wide row** (an area of 600px and more, whatever the input mode; `switcherRow`, `rowScrollFor`, `rowPick` in recent-sessions.mjs): the cards
  side by side, 20px apart, never overlapping, most recent first from the left: the current session (marked "Current"), then the previous one, which
  is selected when it opens, then older ones. The card height is two thirds of the area (within the space between the title, 86px, and the hint,
  56px; at least 160px), the width 0.65 of the height, 280 to 380px, so a wider window shows more cards; the row starts 24px in. The row is a sideways
  scroller (`.h5-switcher-row`, no visible scrollbar, `touch-action: pan-x`): a trackpad or a tilting wheel scrolls it natively, an upright wheel is
  turned into a sideways scroll, a mouse drag scrolls it (not a click), a finger is the browser's own scroll. ← → move the selection along the row
  (→ older), Home / End the ends; the selected card is scrolled into view (whole, with the 24px margin; at once on opening, smoothly after a key, none
  with reduced motion). When a scroll by hand rests (140ms) and less than 60% of the selected card is in view, the card most in view becomes the
  selected one, so the next press of ⇋ goes to a card that can be seen. A partly cut card at the right edge shows that it scrolls. No position dots.
- **A wide card** (the same `.h5-switcher-card` and data attributes): a 52px header inside its top (`.h5-switcher-head`, the surface at the 8dp
  elevation overlay, a divider below): the session's tile (28px), the task as the title (subtitle1, medium, one line with an ellipsis, the full name as
  its `title`; the session's name when the task is not in the list), below it the device tag, the session's name (caption, text.secondary), the 6px
  state dot and the state word. "Current" is a pill in the card under the header at the right. Below: the preview lines or the quiet placeholder. No
  label above the card and no bottom line. Edges as on the stack: the selected card 2px primary, one that needs the person 2px warning, else the 1px
  divider; 8px corners, elevation 8. A switch grows the card from its place in the row into the whole area.
- **A card in the stack** (`.h5-switcher-card`, a ButtonBase, `data-key`, `data-status`, `data-centred`, `data-current`): above it the session's tile (Claude /
  Codex mark or `>_`, `SessionKindIcon` of TaskDrawer.jsx, as the task list), the device tag (`DeviceTag`, when the list tags its rows), the name
  (subtitle2) and the state dot; a card behind the centred one shows only its tile. Inside: the preview lines (caption, monospace); at the bottom over
  a dark gradient: the task (caption), the state word (Running / Needs you / Idle in success.light / warning.light / text.secondary) and a "Current"
  pill on the current card. The state is the header's rule (`columnStatus` on `state.terminalActivity` and the T-Attention items), so it follows the
  activity feed; no new polling. Edge: the centred card 2px primary (it holds the focus), a card that needs the person 2px warning (orange), else the
  1px divider; 8px corners (the project's card radius; the mockup drew 16px) and elevation 8. Title "Recent sessions" (h6; subtitle1 on a phone),
  position dots in the stack (oldest on the left, the centred one primary) and a hint: "Press ⇋ again to switch to it", after a swipe "Swipe to move · tap a card
  or press ⇋ to switch", on a computer "Press ⇋ again or click a card to switch" and the keys ← → Enter Esc. With fewer than two cards: "No other
  recent sessions" (with the current card, or alone).
- **Preview lines** (no request): `openSwitcher` hands over `state.switcher.previews`: a warm terminal (h5.js keeps `WARM_MAX` connected) gives its
  buffer's last 40 lines (`linesOf`, plain text, trailing empty rows dropped); a terminal closed earlier in this page gives what it showed then
  (`keepPreview` in `disposeSession`, kept in memory only, at most 12); any other card shows a quiet placeholder (its tile and "No preview yet").
  No endpoint gives a terminal's text without attaching to it (the widget's `/activity` and the activity snapshot carry states only), so none is read.
- **Moving** (the stack; the wide row scrolls, see above): a horizontal swipe or a mouse drag moves the stack under the pointer (past either end at a third of the speed) and settles with one card
  centred (`settleIndex`; a quick flick goes on by one); right shows older, left newer. A sideways wheel or trackpad scroll does the same (settles
  140ms after its last step). ← shows older, → newer, Home / End the ends. The focus follows the centred card (the only Tab stop).
- **Switching**: a tap or click on any card, Enter on the centred one, or another press of the button: the card grows into the switcher's area (200ms,
  MD2 standard easing; none with `prefers-reduced-motion`), then `ui.actions.openRow` (the task list's path; other engines too) and the switcher closes.
  The focus goes to the button first, so on a computer the terminal takes it as after any switch.
- **Closing without switching**: a tap or click on the empty space, Escape, the back button (`entry.jsx` names it as a back layer of back.mjs), or a
  downward swipe on the stack (touch, more than 80px). The focus returns to the button. A change of the shown session by another path, or the columns
  view, closes it too. While it is open h5.js sends no typed key to the terminal (`modalOpen`).
- **Screen readers**: a modal dialog (`role="dialog"`, `aria-modal`, "Recent sessions"); each card a button named "device, session, task, state" plus
  ", Current".
- Tests: `test/recent-sessions.test.js` (order, duplicates, the limit, gone sessions, other engines, the stored form, the cards, the places in the stack,
  the wide row's sizes, its scroll to the selected card and the pick after a hand scroll), `scripts/test-h5-switcher-browser.cjs` (phone 390x844:
  the place, order, labels, the orange edge, previews, swipe, tap, two presses back and forth, Back, empty space, downward swipe, focus return; computer
  1440x900: the wide row side by side without overlap and most recent first, the previous card selected, the headers with task, device tag, session
  and state, no label or bottom line, "Current" under the header, arrow keys along the row with the selected card scrolled into view, Home, Enter, a
  second press switching to the selected card, an upright wheel and a mouse drag scrolling, Escape, empty space, a click on a card, and at 1920x1080
  with the sidebar folded more whole cards; no badge, the computer row and the narrow row, the remembered list, no switcher in a pane).
