# The page: UI icons

> Part of the T-Agent design document. The index of all parts is [DESIGN.md](../../DESIGN.md).

## UI icons

- Library: "Ant Design Official Icon Library", a collection on iconfont.cn: https://www.iconfont.cn/collections/detail?cid=9402 (collection id 9402, 599 icons when checked on 2026-11-02). The icons are the official Ant Design icons (outlined style, 1024 grid, project ant-design/ant-design-icons).
- Licence: MIT, as stated by the Ant Design project. The iconfont.cn collection page shows no licence field, so the owner should confirm the terms before the project is distributed outside private use.
- How the icons were obtained: from the public JSON API of iconfont.cn, without login and without cookies. The list of the collection is `https://www.iconfont.cn/api/collection/detail.json?id=9402`; every icon in it has an `id`, a `name` and a `show_svg` field with the SVG source. The `d` attribute of each `path` was copied into `PATHS` in `scripts/h5-shell/Icons.jsx` (an icon with two paths, such as `delete`, has them joined into one path string).
- How they are used: inline SVG (`viewBox="0 0 1024 1024"`, `fill` is `currentColor`, `aria-hidden`), drawn by `<Icon name size />` from Material UI `SvgIcon`: 24px in row 2, 22px in row 1. Colour follows the theme, the blue pressed state and the disabled colour. Nothing is fetched at runtime.
- Rules for new icons: see "UI icons" in `AGENTS.md`. Library icons come first; where none is clearly recognisable, a self-drawn icon or a text label is used (in 2.87.6 several keys used library substitutes that nobody could recognise as those keys, such as a cross for Esc and Backspace, a trash can for Delete).
- Self-drawn icons: `DRAWN` in the `SELF-DRAWN ICONS` section of `scripts/h5-shell/Icons.jsx`. 24 viewBox, outlined, `stroke-width` 1.5, round caps and joins, `currentColor`, shown at 22px like the library icons.
- Text labels: Esc, Ctrl, Alt, Home, End, PgUp, PgDn, Ins, Del and ^C show a short text (14px, weight 500, centred) with the same size and alignment as the icon keys. Their `aria-label` and `title` stay the full name (Escape, Page up, Page down, Insert, Delete, ...).
- Send and translate-and-send: both use the white round 44px button (`SEND` in `scripts/h5-shell/Terminal.jsx`) and the same `send` icon. Translate-and-send adds a 10px bold "Aa" text (`.h5-aa`, `aria-hidden`) inside the circle at the lower right. The outlined square and the `translate` icon (8094821) are no longer used and were removed from `Icons.jsx`.

| Button | Icon name | iconfont.cn icon id | Note |
| --- | --- | --- | --- |
| Terminal keyboard (row 2) | code library | 4765970 | substitute: the set has no keyboard icon |
| Draft keyboard (row 2) | edit-square | 4765957 | substitute: the set has no keyboard icon |
| Upload image or file (row 2) | image | 4766917 | |
| Saved commands (row 2) | unordered list | 4767060 | |
| Voice (row 2) | audio | 5756281 | |
| Docs (row 2: the design document sheet; also the Docs entry of the saved commands list under 360px and the Design document button of the file tree header) | file-text | 4766480 | `designDoc` |
| Attention (row 2, T-Attention) | carry out | 4766856 | `attention`; a calendar page with a tick |
| Mark as done (T-Attention row, a task that is done) | check-circle | 4765721 | `attentionDone` |
| Mark as done (T-Attention row, a task that is not done) | check-circle, outer path only | 4765721 | `attentionOpen`: the ring of the same icon, so both states have one weight |
| Step state (T-Attention first-run guide) | check-circle / its outer path | 4765721 | `attentionDone` for a done step, `attentionOpen` for one that is not; decorative, the state is also in hidden text |
| Hide setup guide (T-Attention first-run guide) | close | 4767096 | `close` |
| Add task (T-Attention quick add) | plus | 7834345 | `add` |
| Open link (T-Attention edit view and the link button of a row) | link | 4766965 | `link` |
| Mind maps (task sheet footer) | apartment | 5756280 | `mindmap` |
| Add subtopic (mind map bar) | subnode | 8094810 | `subnode` |
| Add topic after (mind map bar) | sisternode | 8094823 | `sisternode` |
| Edit topic (mind map bar) | edit | 4766959 | `edit` |
| Delete topic, delete map (mind map bar and list) | delete | 4766676 | `delete` |
| Collapse / expand (mind map bar) | minus-square / plus-square | 4765972 / 4765973 | `minusSquare`, `plusSquare` |
| Undo / redo (mind map bar) | undo / redo | 4765837 / 4765838 | `undo`, `redo` |
| Fit map (mind map bar) | fullscreen | 4767015 | `fitWindow` |
| Import .xmind (mind map list) | Import | 4765960 | `Import` |
| Export .xmind (mind map editor) | export | 4765958 | `export` |
| Next running or pending session (row 2) | swap | 4767044 | `cycleSessions` in `Icons.jsx`; two opposite arrows for "switch between" |
| Close (design document sheet) | close | 4767096 | |
| Close (full-screen picture viewer) | close | 4767096 | the same icon as the sheet's Close |
| Zoom in (full-screen picture viewer toolbar) | zoom in | 5756284 | `zoomIn` |
| Zoom out (full-screen picture viewer toolbar) | zoom out | 5756279 | `zoomOut` |
| Download original (full-screen picture viewer toolbar, a file only) | download | 4767031 | `download` |
| Actual size (full-screen picture viewer toolbar) | none | none | text "1:1", 14px, weight 500, like the key labels |
| Fit to screen (full-screen picture viewer toolbar) | none | none | the zoom percent as text (for example "150%"); a tap fits |
| Files (the file viewer header; it was also a row 2 button until T-Attention) | folder | 4766846 | `folder` in `Icons.jsx`; also a closed folder in the file tree |
| Open folder (file tree) | folder-open | 4766847 | `folderOpen` |
| File (file tree) | file | 4766478 | `file` |
| Folder chevron (file tree) | right | 4767011 | `treeChevron`, 14px, turned 90 degrees when the folder is open |
| Reload (file tree header) | reload | 4765852 | `reload` |
| Back to files (file viewer opened from the tree) | arrowleft | 4767022 | `back` in `Icons.jsx`, the same path as the Left key |
| Outline (design document sheet) | ordered list | 4767061 | `outline` in `Icons.jsx`; numbered lines read as a table of contents (`unordered list` is already the saved commands) |
| Open a plugin (row of the plugin list) | right | 4767011 | `treeChevron`, 16px, the same icon as the folder chevron; decorative |
| Back (plugin page in Settings) | arrowleft | 4767022 | `back`, the same icon as Back to files |
| Scroll the owner tabs (Settings, when the tabs do not fit) | right | 4767011 | `treeChevron`, 16px, turned 180 degrees for the start button; the buttons are MUI's tab scroll buttons (44px wide, not focusable: the arrow keys move between the tabs) |
| Collapse the sidebar (header, wide) | outdent | 4767051 | substitute: the set has no menu-fold; same lines-and-left-arrow shape |
| Expand the sidebar (header, wide) | indent | 4767050 | substitute: the set has no menu-unfold |
| Send | send | 9230696 | |
| Translate and send | send | 9230696 | the same icon, plus the "Aa" text mark |
| Paste text (menu item) | snippets | 4766482 | |
| Update (header `#h5-update` and the multi-column bar's `#h5-columns-update`) | none | none | exception kept from before the library: Material `SystemUpdateAlt`; the bar's button uses the same icon (20px) so the two Update buttons look alike |
| Copy bar over the terminal (decorative, left of the title) | file-copy | 4766481 | `copy` in `Icons.jsx`, 22px, `aria-hidden`; the set has no clipboard icon, and `snippets` (the clipboard-like shape) is already Paste |
| Task actions ("⋯" of a task row, task sidebar) | ellipsis | 4767094 | `taskMore` in `Icons.jsx`, 20px, left of the "+" |
| Archived section (end of the task list) | container | 4766438 | `archived` in `Icons.jsx`, 18px; its chevron is `treeChevron` (right, 4767011), turned down when open |
| Esc | none | none | text "Esc" |
| Left | arrowleft | 4767022 | library icon |
| Down | arrowdown | 4767023 | library icon |
| Up | arrowup | 4767021 | library icon |
| Right | arrowright | 4767020 | library icon |
| Enter | enter | 4767097 | library icon (the return arrow) |
| Backspace | self-drawn `keyBackspace` | none | self-drawn: a keycap tag pointing left with a cross inside |
| Tab | self-drawn `keyTab` | none | self-drawn: an arrow to a bar (drawn at 26px, `iconSize` in `KEYS`, so it looks as big as the filled arrows) |
| Ctrl | none | none | text "Ctrl" |
| Alt | none | none | text "Alt" |
| Home | none | none | text "Home" |
| End | none | none | text "End" |
| Page up | none | none | text "PgUp" |
| Page down | none | none | text "PgDn" |
| Insert | none | none | text "Ins" |
| Delete | none | none | text "Del" |
| Shift | self-drawn `keyShift` | none | self-drawn: a hollow up arrow (drawn at 26px, like Tab) |
| Terminal on-screen keyboard: Shift / Backspace / Enter | `keyShift` / `keyBackspace` / `keyEnter` | none / none / 4767097 | the same icons as row 1 (Shift 24px, the others 22px), `aria-label` = `title` |
| Terminal on-screen keyboard: Caps lock | self-drawn `keyCapsLock` | none | self-drawn: the Shift arrow, shorter, over a bar (Shift tapped twice) |
| Wheel strip spring (full-screen program): up / down chevrons | self-drawn `chevronUp`, `chevronDown` | none | self-drawn: open chevrons above and below the spring thumb, 14px (direction marks inside the thin strip, not buttons) |
| Terminal width switch (header, Fit / Wide) | column-width | not looked up (Ant Design `ColumnWidthOutlined`, the same outline as in collection 9402) | `columnWidth` in `Icons.jsx`, 22px |
| Multi-column view switch (header of a wide screen, and the first button of the strip's bar) | project | 4765975 | `columns` in `Icons.jsx`, 22px in the header, 20px in the bar; a board with three columns |
| Add column ("+ Column", multi-column view bar) | plus | 7834345 | `add`, 14px, the start icon of the text button |
| Close column (header of each column) | close | 4767096 | `close`, 14px |
| Drag grip (header of each column, pointer input only, decorative) | holder | not looked up (Ant Design `HolderOutlined`, the same outline as in collection 9402) | `holder` in `Icons.jsx`, 14px |
| Opens a menu or sheet below ("Project · session ▾" of a column header, "N columns ▾" of the bar; decorative) | down | not looked up (Ant Design `DownOutlined`, the same icon as in collection 9402) | `down` in `Icons.jsx`, 12px |
| Column actions ("⋯" of a column header) | ellipsis | 4767094 | `taskMore`, 18px |
| More tools ("⋯" of the compact bottom area of a column, `#h5-more`) | ellipsis | 4767094 | `taskMore`, 20px; its menu items reuse the row 2 icons at 20px: `commands`, `designDoc`, `cycleSessions`, `send`, `terminalKeyboard` |
| Upload image or file, Voice input, Translate and send (compact bottom area of a column) | image / audio / send | 4766917 / 5756281 / 9230696 | the row 2 icons at 20px (send at 16px as the start icon of the contained "Send" button; no "Aa" mark there, its name says it translates) |
| Terminal width (column header) | column-width | not looked up (Ant Design `ColumnWidthOutlined`) | `columnWidth`, 18px |
| Maximize / Restore a column (column header) | expand / compress | not looked up (Ant Design `ExpandOutlined` / `CompressOutlined`) | `maximize` / `restore`, 16px |
| Add mind map column (multi-column view bar) | apartment | 5756280 | `mindmap`, 18px, the same icon as the mind map entry |
| Mind map column (its header and the column list, decorative) | apartment | 5756280 | `mindmap`, 14px, before the map name |
| Maximize a column (mind map editor bar) | expand | not looked up (Ant Design `ExpandOutlined`, the same outline as in collection 9402) | `maximize` in `Icons.jsx`; `fullscreen` is already Fit map |
| Restore the columns (mind map editor bar while maximized, top of the rail) | compress | not looked up (Ant Design `CompressOutlined`, the same outline as in collection 9402) | `restore` in `Icons.jsx`, 20px in the rail |
| Terminal on-screen keyboard: letters, digits, symbols, `123`, `ABC`, `#+=`, Space | none | none | text labels (the layer keys are named "Numbers and symbols", "Letters", "More symbols") |
| Ctrl+C | none | none | text "^C" |

Every icon-only button has an English `aria-label` and the same `title` (function keys: Escape, Left arrow, Down arrow, Up arrow, Right arrow, Enter, Backspace, Tab, Home, End, Page up, Page down, Insert, Delete, Shift, Send Ctrl+C; the Chinese UI text is in `public/js/i18n-zh-ui.js`). The `data-key`, `data-modifier` and `data-shortcut` attributes did not change. The one-shot Ctrl, Alt and Shift keys still turn blue with `aria-pressed` (the Shift icon takes the blue through `currentColor`).
