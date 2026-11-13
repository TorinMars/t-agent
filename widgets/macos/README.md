# T-Attention desktop widget (macOS)

A small native window that stays on top of everything and shows how many T-Attention tasks are unfinished, with a red badge for the ones that need you. Point at it and a panel opens with the tasks, where you can confirm, reject, mark as handled, reorder, change status, create, edit and delete them. It is a port of the floating window of the earlier SELF-ATTENTION tracker (`task_widget.swift`), now reading T-Agent's widget API, so it shows the tasks of this machine and of every connected Engine.

- `TAttentionWidget.swift`: the whole widget. One file, AppKit only, no dependencies.
- `strings.json`: every English string the widget shows (a JSON array). T-Agent serves their translations from `GET /api/attention/widget/strings`; the Chinese text is in `public/js/i18n-zh-ui.js`.

## How T-Agent builds and starts it

```bash
swiftc -O -swift-version 5 -framework AppKit widgets/macos/TAttentionWidget.swift -o <binary>
TA_WIDGET_URL=http://127.0.0.1:3000 TA_WIDGET_TOKEN=<token> <binary> --parent-pid <server pid>
```

- Build only when the binary is missing or older than the source, into a temporary name first, so a failed build never replaces a working binary. A build takes about 30 s with `-O` (about 10 s with `-Onone`). It needs the Xcode command line tools (`xcode-select --install`); without `swiftc` the server should log one line and keep running.
- `TA_WIDGET_URL`: the server's base address (default `http://127.0.0.1:3000`; anything that is not an `http(s)` URL falls back to it). `TA_WIDGET_TOKEN`: sent as `Authorization: Bearer <token>` on every request. The widget never prints or logs the token.
- With `--parent-pid` the widget exits within a second after the server process goes away, so restarting T-Agent replaces the window.
- Requests use their own `URLSession` with no proxy (`connectionProxyDictionary = [:]`, so `http_proxy` never catches `127.0.0.1`), a 3 s timeout and no cache.

## Flags

| Flag | Effect |
|------|--------|
| `--parent-pid PID` | Exit when `PID` is no longer this process's parent (checked every second) |
| `--no-persist` | Neither read nor write the saved window position |
| `--self-test` | Run the checks (grouping, order, children, every request with its headers and body, edit diffs, drag targets including cross-machine refusals, the form and its input-method handling, string fallback) in-process, without putting a window on screen and without the network. Prints `ok   …` / `FAIL …` lines and `N passed, M failed`; exits 0 only when every check passed |
| `--render-sample DIR` | Build the widget and the panel with built-in sample data (three engines, children, every row type, a failed engine), render them offscreen into `DIR/*.png` (light and dark, mid-drag, a refused drop, the forms, the delete question, unreachable) and exit. No window is ever put on screen |

## Behaviour

- **Window**: a small pill, 26 pt high and as wide as it needs (38 pt at least, about 70 pt with a two-digit count and badge): a borderless non-activating panel at `.statusBar` level, on all Spaces and over full-screen apps, no Dock icon. Drag it to move it; the position is saved in the defaults suite `local.t-agent.attention-widget` (keys `x`, `y`; the first start uses 16 pt from the top-right of the main screen, `--no-persist` 16 pt from the bottom-left). Its width changes only between drags; in the right half of the screen it grows to the left, so the right edge stays put. The word "Tasks" is its tooltip and accessibility label, not drawn. Right-click offers Quit.
- **Count**: the unfinished tasks (everything but `done`, `failed` and `cancelled`); the red badge to its right counts the Needs you section and is hidden at zero. `–` while T-Agent cannot be reached (or refuses the token); the panel then says why.
- **Refresh**: `GET /api/attention/widget/items` every 5 s, paused while a row is held or dragged, a button is pressed, or a move or an action is in flight. The interface strings are loaded once at start (and tried again with each refresh until they arrive); without them every string is the English text.
- **Panel**: 288 pt wide and at most 440 pt high (it scrolls past that); opens at once on hover and closes 0.3 s after the pointer leaves both windows. It stays while a form, a menu, the delete question or a red message (3 s) is showing.
- **Sections**: 🔴 Needs you (`waiting_user` and `review`), 🟢 Working (`working`), 🟡 To do (`todo`, and any status the widget does not know), ⚪ Done: N (`done`, `failed`, `cancelled`, a count only). An engine that could not be read adds a muted line "Could not load <name>".
- **Order inside a section**: one block per engine, this machine first, then the order of `engines` in the answer (an engine not listed after them). Inside an engine block, by `sort_order` (highest first, then the id). In Needs you each engine shows its `waiting_user` rows before its `review` rows, because the server orders and moves those two statuses as separate groups. A child is drawn under its parent with `└` when both are in the same block; otherwise it is an ordinary row of its own section.
- **Rows**: the title, then `custom_status` as a muted suffix, and a second line with the first of `pending`, `attention_reason` or `result`. With more than one engine each row has a small tag with the engine's name in the colour of `color_index` (the page's tag palette, `TAG_COLORS` in `scripts/h5-shell/task-order.mjs`).
- **Buttons**: review rows get Confirm (`POST …/confirm`) and Reject (`POST …/reject`); `waiting_user` rows get Handled (`POST …/handled`). They sit at the right of the row's second line when the title takes one line and the second line leaves room; otherwise on a line of their own under the text. They work on the first click while another app is in front. While a request is out the row's buttons are off; on success the list refreshes at once; on failure the buttons come back and "Action failed: …" shows.
- **Drag to reorder**: press a row and move it; a blue line shows where it lands. A row moves only inside its own engine block and server group, among its siblings (a parent takes its children). The new order shows at once and goes to `POST …/move` with `before_key` / `after_key` (or `position: 'top'` for a drop on the section title); if the server refuses, the rows go back and "Move failed: …" shows. A drop on another machine's row is refused with "Only within the same machine".
- **Drag to change status**: drop a row on another section's title (Needs you → `waiting_user`, Working → `working`, To do → `todo`, the Done line → `done`): `POST …/move` with `position: 'top'` and `status`. The section is outlined with the status it will get. A drop between the rows of another section places it there, within the same engine.
- **Create, edit, delete**: `+` opens a form (Name, Status, Notes) that creates on this machine (`POST …/items` with `engine: 'local'`). Right-click a row for Edit (the same form with Custom status, filled in; Save sends only the changed fields with `PATCH`, and nothing when nothing changed; when the answer has no `notes` for that item the Notes field is left out so it cannot overwrite them) and Delete (asks first; `DELETE`; a refusal such as a task with subtasks shows "Delete failed: <server message>"). Return saves when the name is not empty, Esc cancels; during an input-method composition both belong to the input method. The keyboard goes back to the previous app when the form closes.
- Keys contain `:` and are percent-encoded in request paths. Error answers are `{ error, message }`; the widget shows `message`.

## Testing rules

The widget runs on the user's desktop. When working on it:

- Never put a window on the user's screen: do not run a built widget without `--self-test` or `--render-sample`, and do not take screenshots of the screen (no full-screen `screencapture`). Look at the panel through `--render-sample DIR`, which renders it offscreen.
- No CGEvent or other system-level input injection. The self-test sends its mouse events in-process to the views; the real pointer never moves.
- Compile test binaries outside the repository (a temporary or scratch folder), never next to the source.
- Never touch the live defaults suite `local.t-agent.attention-widget` (the self-test and the renders never read or write it).
- `test/attention-widget-swift.test.js` checks `strings.json` against the source and the Chinese dictionary everywhere, and on macOS with `swiftc` compiles the widget to a temporary folder (`-Onone`) and runs `--self-test` (skipped elsewhere; `TA_SKIP_SWIFT_WIDGET=1` skips it on a Mac).
- What only a person can check (no automated test reaches it): real hover and the 0.3 s close, a real mouse drag of rows and of the window, right-click menus, keyboard focus going back to the previous app, typing with an input method, staying on top over full-screen apps and on every Space.
