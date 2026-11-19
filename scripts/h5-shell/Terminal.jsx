import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Badge from '@mui/material/Badge';
import { alpha } from '@mui/material/styles';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import OutlinedInput from '@mui/material/OutlinedInput';
import Paper from '@mui/material/Paper';
import ToggleButton from '@mui/material/ToggleButton';
import { Pill, named, t } from './common.jsx';
import { Icon } from './Icons.jsx';
import { commandsFor } from './commands.mjs';
import { orderCommands, recordUse, usedLabel, usesFor } from './command-recency.mjs';
import { TerminalKeyboard } from './Osk.jsx';
import { TOUCH } from './theme.mjs';
import { shallowEqual } from './store.mjs';
import { countRender, useStore, useStoreKeys } from './use-store.mjs';

// The terminal area. h5.js puts the xterm element in after these two; React draws only the note, the wheel strip (h5.js handles its touches,
// sets its mode and thumb and its ARIA values) and the copy bar.
const TERMINAL_KEYS = ['empty', 'emptyCreate', 'input', 'clipboard'];
export function TerminalArea({ ui }) {
  const state = useStoreKeys(ui, TERMINAL_KEYS);
  countRender('TerminalArea');
  return (
    <Box component="main" className="h5-terminal" id="h5-terminal">
      {state.empty ? (
        <div className="h5-empty" id="h5-empty">
          <span>{t(state.empty)}</span>
          {state.emptyCreate ? <Button id="h5-empty-new" variant="outlined" onClick={() => ui.actions.newSessionFromEmpty()}>{t('New session')}</Button> : null}
        </div>
      ) : null}
      {/* The wheel strip is for fingers; a computer has a real wheel or trackpad, so it is not drawn there (input mode 'pointer').
          A scrollbar: a thin track and thumb inside a 40px hit area; in a full-screen program the thumb is a spring in the middle, with chevrons. */}
      {state.input === 'pointer' ? null : (
        <div className="h5-wheel" id="h5-wheel" role="scrollbar" aria-orientation="vertical" aria-label={t('Scroll')} data-mode="none" aria-hidden="true">
          <span className="h5-wheel-track" aria-hidden="true" />
          <span className="h5-wheel-chevron h5-wheel-up" aria-hidden="true"><Icon name="chevronUp" size={14} /></span>
          <span className="h5-wheel-chevron h5-wheel-down" aria-hidden="true"><Icon name="chevronDown" size={14} /></span>
          <span className="h5-wheel-thumb" aria-hidden="true" />
        </div>
      )}
      {/* The copy bar, one for every copy from the terminal (public/js/terminal-clipboard.js): kind 'ask' is a program's copy without a recent
          gesture of the user (nothing is written before Copy); kind 'tap' is a copy the browser refused to write (a page selection or a program's
          copy alike), written inside this tap. The preview is one line, cut to the bar's width; later output cannot change it.
          It is a filled blue bar (`notice` in theme.mjs, white text) so it stands out from the dark terminal: the copy icon, a title line,
          the preview, then Copy (a white filled button) and Cancel (a text button). Keyed by the request, so each new request slides in and
          pulses once (h5.css; off with reduced motion). It hides by itself after `bar.ttl`, shown by a countdown line. */}
      {state.clipboard ? <ClipboardBar key={state.clipboard.id} bar={state.clipboard} ui={ui} /> : null}
    </Box>
  );
}

// The copy bar. A thin line along its bottom edge counts down `bar.ttl` (decorative, aria-hidden; static while held, restarted for each new
// `bar.round`, hidden with reduced motion). A mouse over the bar or the keyboard focus inside it holds the timer (`clipboardHold`); a touch on
// Copy / Cancel just acts.
function ClipboardBar({ bar, ui }) {
  const on = useRef({ hover: false, focus: false, held: false });
  const hold = (key, value) => {
    on.current[key] = value;
    const held = on.current.hover || on.current.focus;
    if (held === on.current.held) return;
    on.current.held = held;
    ui.actions.clipboardHold(held);
  };
  const hover = value => event => { if (event.pointerType === 'mouse') hold('hover', value); };
  return (
    <Paper
      className="h5-clipboard-bar" id="h5-clipboard-bar" role="toolbar" aria-label={t('Copy to the clipboard')} elevation={8}
      data-kind={bar.kind} data-holding={bar.holding ? 'true' : undefined} onMouseDown={event => event.preventDefault()} sx={CLIPBOARD_BAR}
      onPointerEnter={hover(true)} onPointerLeave={hover(false)}
      onFocus={() => hold('focus', true)} onBlur={event => hold('focus', event.currentTarget.contains(event.relatedTarget))}
    >
      <span className="h5-clipboard-icon" aria-hidden="true"><Icon name="copy" size={22} /></span>
      <span className="h5-clipboard-body">
        <span className="h5-clipboard-title" id="h5-clipboard-title">{bar.kind === 'ask' ? t('Copy request from the terminal') : t('Press Copy to finish copying')}</span>
        <span className="h5-clipboard-preview" id="h5-clipboard-text" translate="no" title={bar.text}>{bar.preview}</span>
      </span>
      <span className="h5-clipboard-actions">
        <Button id="h5-clipboard-copy" size="small" variant="contained" onClick={() => ui.actions.clipboardConfirm()} sx={CLIPBOARD_COPY}>{t('Copy')}</Button>
        <Button id="h5-clipboard-cancel" size="small" color="inherit" onClick={() => ui.actions.clipboardCancel()} sx={CLIPBOARD_CANCEL}>{t('Cancel')}</Button>
      </span>
      <span className="h5-clipboard-timer" aria-hidden="true">
        <span key={bar.round} className="h5-clipboard-timer-line" style={{ animationDuration: `${bar.ttl}ms` }} />
      </span>
    </Paper>
  );
}

// The copy bar's colours come from the theme (`notice`); its layout and its one slide-in and pulse are `.h5-clipboard-*` in h5.css.
// `backgroundImage: none` drops the dark theme's elevation overlay, which would grey the blue. A focused button gets a white ring.
const FOCUS_RING = { '&.Mui-focusVisible': { outline: theme => `2px solid ${theme.palette.notice.contrastText}`, outlineOffset: 2 } };
const CLIPBOARD_BAR = {
  bgcolor: 'notice.main', color: 'notice.contrastText', backgroundImage: 'none',
  border: 1, borderColor: theme => alpha(theme.palette.notice.contrastText, 0.28), '--h5-clipboard-ring': theme => theme.palette.notice.ring,
};
const CLIPBOARD_COPY = {
  bgcolor: 'notice.button', color: 'notice.main', fontWeight: 600, px: 2,
  '&:hover': { bgcolor: 'notice.buttonHover' }, '&:active': { bgcolor: 'notice.buttonHover' }, ...FOCUS_RING,
};
const CLIPBOARD_CANCEL = { color: 'notice.contrastText', px: 1.5, '&:hover': { bgcolor: theme => alpha(theme.palette.notice.contrastText, 0.14) }, ...FOCUS_RING };


// The bottom area ("Bottom bar" in docs/design/page-terminal-and-bottom-bar.md). Three layouts, one component tree:
// - a column of the multi-column view (pane mode): CompactBottom, one row (decided once, before the first render);
// - the single view on a computer (input mode 'pointer'): ONE 56px row, the draft box, Upload, Voice, Saved commands, Docs, Recent sessions, "More tools" and Send
//   (`#h5-bottom[data-single]`; CompactTools in its 'single' mode);
// - the single view on a touch screen: the draft box (hidden by default), row 1 the function keys, row 2 the eight tools (CompactTools in its
//   'phone' mode), and under them, while `state.osk` is on, the terminal's own on-screen keyboard (Osk.jsx), which takes room in the layout.
// The input mode can change while the page is open (a mouse plugged in), so the computer row and the touch layout are the SAME elements in the same
// places: the form and its textarea, the voice button and the file input are never remounted (h5.js and voice-input.js hold those DOM nodes from the
// start). Only Send (`#h5-translate-button`) moves between the draft box (touch) and the row (computer); h5.js listens for it on `#h5-bottom`.
// When the draft box grows over the terminal h5.js sets `--h5-bar-extra` on this box and moves the terminal; the terminal is never resized for it.
// What the bottom area draws (its rows read it from here): T-Attention and the file sheet only as the counts and flags the buttons show.
const BOTTOM = state => ({
  input: state.input, terminalAgent: state.terminalAgent, translating: state.translating, osk: state.osk, mods: state.mods, keyboard: state.keyboard,
  activeCount: state.pane ? state.activeCount : 0, pane: state.pane, wide: state.wide, paneFocused: Boolean(state.paneFocused), // the count: a column's only
  attentionNeeds: Number(state.attention && state.attention.needs) || 0, attentionOpen: Boolean(state.attention && state.attention.open),
  designOpen: Boolean(state.design && state.design.open), switcherOpen: Boolean(state.switcher),
});
// The surface of the single view's bottom area: an MD2 bar (Paper at elevation 1, without its shadow) with a divider above it.
const BAR_SURFACE = { flex: '0 0 auto', position: 'relative', zIndex: 3, borderTop: 1, borderColor: 'divider', boxShadow: 'none' };
// The computer row: 56px (plus the divider), the controls on its bottom line, so a draft of several lines grows upward out of it over the terminal.
const SINGLE_ROW = { boxSizing: 'border-box', height: 57, display: 'flex', alignItems: 'flex-end', gap: 0.5, px: 1.5, pb: 1 };
export function BottomArea({ ui }) {
  const state = useStore(ui, BOTTOM, shallowEqual);
  countRender('BottomArea');
  const [menu, setMenu] = useState(false); // the saved commands list (and Paste text) is open
  const [menuAt, setMenuAt] = useState(null); // where the list opens: the left edge of the button that opened it (computer row), else the left side
  // A column of the multi-column view (pane mode) has the compact bottom area: one row (see CompactBottom). It is decided once, before the first render.
  const compact = Boolean(state.pane);
  useEffect(() => {
    if (!menu) return undefined;
    // A tap outside the menu (and outside the saved commands button) or Escape closes it. Escape is caught in the capture phase: on a computer the
    // focus stays in the terminal while the menu is open (the button keeps it there), and xterm stops the keydown of a key it handles, so a listener
    // in the bubble phase never heard it. The Escape that closes the menu is not also sent to the terminal.
    const away = event => { if (!event.target.closest('.h5-add-menu, #h5-commands')) setMenu(false); };
    const escape = event => { if (event.key !== 'Escape') return; event.preventDefault(); event.stopPropagation(); setMenu(false); };
    document.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('pointerdown', away, true); window.removeEventListener('keydown', escape, true); };
  }, [menu]);
  // A column that is no longer the focused one closes its list: a press in another column is in another window, which the listener above never hears.
  useEffect(() => { if (compact && !state.paneFocused) setMenu(false); }, [compact, state.paneFocused]);
  const run = action => { setMenu(false); action(); };
  // Opens or closes the list. On the computer row it opens above the button that opened it (`anchor`), like an MD2 menu.
  const onMenu = (open, anchor) => {
    const bottom = anchor && anchor.closest && anchor.closest('#h5-bottom');
    setMenuAt(bottom && bottom.hasAttribute('data-single') ? Math.round(anchor.getBoundingClientRect().left - bottom.getBoundingClientRect().left) : null);
    setMenu(open);
  };
  // A computer (input mode 'pointer'): no function key row (a real keyboard has the keys), the draft box always shown, one row.
  const pointer = state.input === 'pointer';
  const agent = state.terminalAgent;
  const presets = commandsFor(agent);
  // Recently used first (scripts/h5-shell/command-recency.mjs, one order per kind on this device): read only while the list is open.
  const { used, rest } = menu ? orderCommands(presets.commands, usesFor(agent)) : { used: [], rest: presets.commands };
  const now = Date.now();
  const command = ({ command: text, note, usedAt }) => ({
    label: text, note, used: usedAt ? usedLabel(usedAt, now) : null, mono: true, track: 'h5-add-menu-command', detail: text, // a preset of commands.mjs: a fixed product string (usage data)
    // A tap SENDS the command with Enter and closes the list; the pencil types it without Enter ("Edit before sending"). Both count as a use.
    run: () => run(() => { if (ui.actions.sendCommand(text)) recordUse(agent, text); }),
    edit: () => run(() => { if (ui.actions.insertCommand(text)) recordUse(agent, text); }),
  });
  const rows = [
    { icon: <Icon name="paste" size={20} />, label: 'Paste text', track: 'h5-paste-text', run: () => run(() => ui.actions.key({ action: 'paste' })) },
    // The presets of the open terminal's kind (Claude Code, Codex or a plain shell; `state.terminalAgent`, set by h5.js), under a header naming the list (scripts/h5-shell/commands.mjs):
    // the used ones first, then a divider and the never used ones in their usual order.
    { head: true, label: presets.title, recent: used.length > 0 },
    ...used.map(command),
    ...(used.length && rest.length ? [{ divider: true }] : []),
    ...rest.map(command),
    // Claude Code and Codex also list common key combinations under "Keys". A tap SENDS the key at once (h5.js `ui.actions.key({ send })`, which drops a latched Ctrl / Alt / Shift)
    // and closes the list, like a command.
    ...(presets.keys ? [{ head: true, label: 'Keys' }, ...presets.keys.map(({ label, send, note }) => ({ label, note, mono: true, keyRow: true, track: 'h5-add-menu-key', detail: label, run: () => run(() => ui.actions.key({ send })) }))] : []),
  ];
  const list = menu ? <CommandsList rows={rows} at={menuAt} fill={!compact && !pointer} /> : null;
  if (compact) return <CompactBottom state={state} ui={ui} list={list} onMenu={setMenu} pointer={pointer} />;
  return (
    <Paper
      square elevation={1} className="h5-bottom" id="h5-bottom" data-single={pointer ? '' : undefined} data-focused={pointer ? '' : undefined}
      sx={pointer ? { ...BAR_SURFACE, ...SINGLE_ROW } : { ...BAR_SURFACE, marginTop: 'calc(var(--h5-bar-extra, 0px) * -1)', pb: 'env(safe-area-inset-bottom)', ...DRAFT_ON }}
    >
      {list}
      <TranslateBar state={state} pointer={pointer} single={pointer} />
      {pointer ? null : <KeyBar state={state} ui={ui} />}
      <CompactTools state={state} ui={ui} onMenu={onMenu} menu={menu} pointer={pointer} mode={pointer ? 'single' : 'phone'} />
      {state.osk && !pointer ? <TerminalKeyboard ui={ui} /> : null}
    </Paper>
  );
}

// The saved commands list (and Paste text), above the bottom area: opened by the saved commands button, or from "More tools". An MD2 menu: a Paper at
// elevation 8, rows of body text (commands in monospace with a caption under them) and list subheaders with a divider above them.
// `at`: the left edge of the button that opened it on the computer row (kept inside the area); otherwise 8px from the left. 340px wide (the header
// "Claude Code commands · recently used first" fits on one line); `fill` (the phone layout): the width of the area less 8px on each side, at most 560px.
// A command row (`edit`) ends with the pencil "Edit before sending": always shown in touch input mode (a 44px target), with a pointer only while the row is
// hovered or holds the keyboard focus (opacity, so nothing moves; it stays reachable with Tab). Used commands say when on their second line, and a
// middle divider (16px inset) separates them from the never used ones ("Saved commands" in docs/design/page-terminal-and-bottom-bar.md).
const COMMAND_ROW = {
  display: 'flex', alignItems: 'center', pr: 0.5,
  '@media (hover: hover)': { '&:hover': { bgcolor: 'action.hover' } },
  '& > .MuiButton-root:hover': { bgcolor: 'transparent' },
};
const EDIT_BUTTON = theme => ({
  flex: '0 0 auto', width: 36, height: 36, color: 'text.secondary', opacity: 0, transition: theme.transitions.create('opacity', { duration: theme.transitions.duration.shortest }),
  '.h5-add-menu-row:hover &, .h5-add-menu-row:focus-within &': { opacity: 1 },
  [TOUCH]: { width: 44, height: 44, opacity: 1 },
});
function CommandsList({ rows, at = null, fill = false }) {
  const left = at == null ? 8 : `max(8px, min(${at}px, calc(100% - 348px)))`;
  return (
    <Paper
      className="h5-add-menu" role="menu" aria-label={t('Saved commands')} elevation={8} onMouseDown={event => event.preventDefault()}
      sx={{ position: 'absolute', left, bottom: 'calc(100% + 8px)', width: fill ? 'calc(100% - 16px)' : 340, maxWidth: fill ? 560 : 'calc(100vw - 16px)', boxSizing: 'border-box', maxHeight: '60vh', overflowY: 'auto', py: 1, zIndex: 4 }}
    >
      {rows.map((row, index) => {
        if (row.head) {
          return (
            <Box
              key={`head-${row.label}`} className="h5-add-menu-head" role="presentation"
              sx={{ px: 2, pt: index ? 1.5 : 1, pb: 0.5, mt: index ? 1 : 0, typography: 'body2', fontWeight: 500, color: 'text.secondary', borderTop: index ? 1 : 0, borderColor: 'divider' }}
            >{row.recent ? `${t(row.label)} \u00b7 ${t('recently used first')}` : t(row.label)}</Box>
          );
        }
        if (row.divider) return <Divider key="divider" className="h5-add-menu-divider" role="presentation" variant="middle" sx={{ my: 0.5 }} />;
        const item = (
          <Button
            key={`${row.keyRow ? 'key' : 'item'}-${row.label}`} id={row.id} data-track={row.track} data-track-detail={row.detail} role="menuitem" fullWidth color="inherit" onClick={row.run} startIcon={row.icon} title={row.note ? t(row.note) : undefined}
            sx={{
              justifyContent: 'flex-start', minHeight: 40, borderRadius: 0, px: 2, py: row.note ? 0.75 : 0, typography: 'body1', fontWeight: 400, [TOUCH]: { minHeight: 48 },
              '& .MuiButton-startIcon': { mr: 2, color: 'text.secondary' }, ...(row.edit ? { flex: '1 1 auto', minWidth: 0, pr: 1 } : null),
            }}
          >
            {row.note ? (
              <Box component="span" sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', flex: '1 1 auto', minWidth: 0, textAlign: 'left' }}>
                <Box component="span" className={row.keyRow ? 'h5-add-menu-key' : 'h5-add-menu-command'} translate="no" sx={{ typography: 'body2', fontFamily: 'ui-monospace, Menlo, monospace', fontWeight: 500, overflowWrap: 'anywhere' }}>{row.label}</Box>
                <Box component="span" className="h5-add-menu-note" sx={{ typography: 'caption', color: 'text.secondary', overflowWrap: 'anywhere', textWrap: 'pretty' }}>
                  {t(row.note)}{row.used ? <> {'\u00b7'} <span className="h5-add-menu-used">{t(row.used)}</span></> : null}
                </Box>
              </Box>
            ) : t(row.label)}
          </Button>
        );
        if (!row.edit) return item;
        return (
          <Box key={`row-${row.label}`} className="h5-add-menu-row" role="none" sx={COMMAND_ROW}>
            {item}
            <IconButton className="h5-add-menu-edit" data-track-detail={row.detail} role="menuitem" aria-label={t('Edit before sending')} title={t('Edit before sending')} onClick={row.edit} sx={EDIT_BUTTON}>
              <Icon name="edit" size={20} />
            </IconButton>
          </Box>
        );
      })}
    </Paper>
  );
}

// The bottom area of a column of the multi-column view (pane mode; "Compact bottom area of a column" in docs/design/page-terminal-and-bottom-bar.md):
// ONE row, 52px high (56px in touch input mode), the same in every column whether it is the focused one or not, so the terminal is never resized when
// the focus moves between columns. The focused column (`state.paneFocused`, told by the top page, pane.mjs) shows the draft box, Upload image or file,
// Voice input, "More tools" (a menu with every tool that has no button of its own here) and Translate and send. Any other column shows only the quiet
// draft box (its placeholder, or a "Draft" tag and the first line of an unsent draft); the buttons stay mounted and are hidden with CSS, because
// h5.js and voice-input.js hold the DOM nodes of the voice button, the file input and the send button from the start. They stay shown while voice
// is recording or a translation runs, so those states are never hidden.
// The draft box grows upward over the terminal for a draft of several lines (the row is `align-items: flex-end` with a fixed height, so the box
// overflows above it); the layout never changes: h5.js moves the terminal by the growth (`--h5-bar-extra`), it does not resize it.
// In touch input mode the terminal's own keys (row 1) and on-screen keyboard come from "More tools" > Terminal keyboard, above and below the row;
// they take room in the layout like the keyboard of the normal page (one refit when shown and one when hidden, never on a focus change).
const COMPACT_TOOLS_ON = {
  '&[data-focused] .h5-row-tools, &:has(.h5-voice.listening) .h5-row-tools, &:has(#h5-translate.translating) .h5-row-tools': { display: 'flex' },
};
function CompactBottom({ state, ui, list, onMenu, pointer }) {
  const focused = state.paneFocused;
  const keys = !pointer && state.osk; // touch: the function keys and the on-screen keyboard, shown from the menu
  return (
    <Box
      className="h5-bottom h5-compact" id="h5-bottom" data-compact="" data-focused={focused ? '' : undefined}
      sx={{ flex: '0 0 auto', position: 'relative', zIndex: 3, bgcolor: 'var(--h5-bg)', borderTop: 1, borderColor: 'divider', ...COMPACT_TOOLS_ON }}
    >
      {list}
      {keys ? <KeyBar state={state} ui={ui} /> : null}
      <Box
        className="h5-row" id="h5-row"
        sx={{ boxSizing: 'border-box', height: 52, display: 'flex', alignItems: 'flex-end', gap: 0.5, px: 1, pb: 1, [TOUCH]: { height: 56, pb: '6px' } }}
      >
        <TranslateBar state={state} pointer={pointer} compact ui={ui} />
        <CompactTools state={state} ui={ui} onMenu={onMenu} pointer={pointer} />
      </Box>
      {keys ? <TerminalKeyboard ui={ui} /> : null}
    </Box>
  );
}

// The tools of the bottom area, one component for its three layouts (`mode`):
// - 'column' (a column's row): Upload, Voice, "More tools", Send. More holds Saved commands (the same list), Docs, Next running or pending session (with
//   its count, which the "More tools" button also shows as a badge), Send as typed without translating (the form's submit, as Option+Enter), and in
//   touch input mode Terminal keyboard.
// - 'single' (the single view on a computer, which is wider than a column, so more tools have a button): Upload, Voice, Saved commands, Docs, Recent
//   sessions (`#h5-cycle`, the session switcher), "More tools" and Send. More holds T-Attention (`#h5-attention`, with its "Needs you" count) and Send as
//   typed (`#h5-translate-send`): the ids of the buttons they replace. The menu stays mounted (hidden while closed), so those ids are always in the
//   page. When the area is narrower than SINGLE_NARROW px, Saved commands and Docs go into More too (`#h5-more-commands`, `#h5-more-docs`), as in a
//   column; Recent sessions stays a button. "More tools" carries no badge here: the rail and the bottom navigation show the T-Attention count.
// - 'phone' (touch input): seven tools as flat 44px icon buttons that share the width of a 48px row: terminal keyboard, draft keyboard, upload, saved
//   commands, voice, Docs and Recent sessions (seven fit from 320px). The set never changes with the state (the send buttons are in the draft box). The
//   active tool is drawn in the primary colour. T-Attention is not among them: on a phone it is a destination of the bottom navigation (BottomNav.jsx,
//   which carries `#h5-attention`); a touch screen on the wide layout has it in the navigation rail.
// Recent sessions (`ui.actions.pressSwitcher`, h5.js) opens the session switcher (Switcher.jsx; "Session switcher" in docs/design/session-switcher.md),
// and a press while it is open switches to its centred card. It shows no count, and the selected look (`aria-expanded`) while the switcher is open.
// The elements h5.js and voice-input.js hold (the file input, the voice button) keep their place among the children in every mode (the `null`
// slots), so a change of the input mode never remounts them.
// A chosen menu item runs after the menu closed, so the focus the menu gives back to its button does not take it from where the action put it
// (a sent message focuses the terminal on a computer).
const SINGLE_NARROW = 560;
const COMPACT_ICON = { flex: '0 0 auto', width: 36, height: 36, p: 0, color: 'text.secondary', '&:hover': { color: 'text.primary' }, [TOUCH]: { width: 44, height: 44 } };
const SELECTED_TOOL = theme => ({ color: theme.palette.primary.main, backgroundColor: alpha(theme.palette.primary.main, theme.palette.action.selectedOpacity) });
const ACTIVE = '&[aria-pressed="true"], &[aria-expanded="true"]';
const SINGLE_ICON = { ...COMPACT_ICON, width: 40, height: 40, [ACTIVE]: SELECTED_TOOL };
const PHONE_TOOL = { flex: '1 1 0', minWidth: 0, height: 44, p: 0, borderRadius: 2, color: 'text.primary', [ACTIVE]: SELECTED_TOOL, '& .MuiTouchRipple-root': { borderRadius: 2 } };
const BADGE = { '& .MuiBadge-badge': { typography: 'caption', fontSize: 10, fontWeight: 500, height: 16, minWidth: 16, px: 0.5, pointerEvents: 'none' } };
const COUNT_PILL = { ml: 2, height: 20, px: 0.75, typography: 'caption' };
// The width of the computer row, read while it is shown (the menu needs to know, so CSS alone cannot do it).
function useNarrowRow(on) {
  const ref = useRef(null);
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const row = on && ref.current ? ref.current.closest('#h5-bottom') : null;
    if (!row || typeof ResizeObserver === 'undefined') { setNarrow(false); return undefined; }
    const update = () => setNarrow(row.clientWidth > 0 && row.clientWidth < SINGLE_NARROW);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(row);
    return () => observer.disconnect();
  }, [on]);
  return [ref, narrow];
}
function CompactTools({ state, ui, onMenu, menu = false, pointer, mode = 'column' }) {
  const column = mode === 'column';
  const single = mode === 'single';
  const phone = mode === 'phone';
  const [anchor, setAnchor] = useState(null);
  const [ref, narrow] = useNarrowRow(single);
  useEffect(() => { if (column && !state.paneFocused) setAnchor(null); }, [column, state.paneFocused]);
  useEffect(() => { if (phone) setAnchor(null); }, [phone]);
  const close = () => setAnchor(null);
  const choose = action => () => { close(); setTimeout(action, 0); };
  const active = column ? Number(state.activeCount) || 0 : 0;
  const needs = single ? state.attentionNeeds : 0;
  // A column's "More tools" button counts the running or pending sessions its "Next running or pending session" goes through.
  const more = t('More tools') + (active ? ` (${active})` : '');
  const cycle = t('Next running or pending session') + (active ? ` (${active})` : '');
  const attention = t('Attention') + (needs ? ` (${needs})` : '');
  const recent = t('Recent sessions');
  const switcherOpen = Boolean(state.switcherOpen);
  const image = t('Upload image or file');
  const commands = t('Saved commands');
  const docs = t('Docs');
  const look = phone ? PHONE_TOOL : single ? SINGLE_ICON : COMPACT_ICON;
  const size = phone ? 24 : 20;
  const item = { sx: { minHeight: 40, [TOUCH]: { minHeight: 48 } } };
  // The keyboard keys exist only on touch screens. Terminal keyboard shows and hides the terminal's own on-screen keyboard (Osk.jsx, never the system
  // one); draft keyboard focuses the draft box, so the system keyboard (with its IME and dictation) types into it.
  const keyboard = (action, kind, label) => (
    <IconButton data-action={action} sx={look} {...named(t(label))} aria-pressed={kind === 'terminal' ? Boolean(state.osk) : state.keyboard === kind} onClick={() => ui.actions.key({ action })}>
      <Icon name={kind === 'terminal' ? 'terminalKeyboard' : 'draftKeyboard'} size={size} />
    </IconButton>
  );
  const commandsButton = (
    <IconButton id="h5-commands" data-action="commands" sx={look} {...named(commands)} aria-haspopup="menu" aria-expanded={menu} onClick={event => onMenu(!menu, event.currentTarget)}>
      <Icon name="commands" size={size} />
    </IconButton>
  );
  // Docs: the design document sheet (Design.jsx); its header has Files (the read-only file tree).
  const docsButton = (
    <IconButton
      id="h5-design" data-action="design" sx={look} {...named(docs)}
      aria-haspopup="dialog" aria-expanded={state.designOpen} onClick={() => ui.actions.openDesign()}
    ><Icon name="designDoc" size={size} /></IconButton>
  );
  const menuItems = [];
  if (column || narrow) {
    menuItems.push(
      <MenuItem key="commands" {...item} id="h5-more-commands" aria-haspopup="menu" onClick={choose(() => onMenu(true, single ? anchor : null))}>
        <ListItemIcon><Icon name="commands" size={20} /></ListItemIcon><ListItemText>{commands}</ListItemText>
      </MenuItem>,
      <MenuItem key="docs" {...item} id="h5-more-docs" aria-haspopup="dialog" onClick={choose(() => ui.actions.openDesign())}>
        <ListItemIcon><Icon name="designDoc" size={20} /></ListItemIcon><ListItemText>{docs}</ListItemText>
      </MenuItem>,
    );
  }
  if (single) {
    // T-Attention (Attention.jsx): opens or closes the side panel, as the rail's Attention button does. Its name carries the "Needs you" count.
    menuItems.push(
      <MenuItem key="attention" {...item} id="h5-attention" data-action="attention" aria-label={attention} title={attention} aria-expanded={state.attentionOpen} selected={state.attentionOpen} onClick={choose(() => ui.actions.toggleAttention())}>
        <ListItemIcon><Icon name="attention" size={20} /></ListItemIcon><ListItemText>{t('Attention')}</ListItemText>
        {needs ? <Pill className="h5-attention-count" label={needs > 99 ? '99+' : String(needs)} tone="warning" filled aria-hidden="true" sx={COUNT_PILL} /> : null}
      </MenuItem>,
    );
  }
  if (column) {
    menuItems.push(
      <MenuItem key="cycle" {...item} id="h5-more-cycle" data-action="cycle" aria-label={cycle} onClick={choose(() => ui.actions.nextActiveSession())}>
        <ListItemIcon><Icon name="cycleSessions" size={20} /></ListItemIcon><ListItemText>{t('Next running or pending session')}</ListItemText>
        {active ? <Pill className="h5-more-count" label={active > 99 ? '99+' : String(active)} tone="primary" filled aria-hidden="true" sx={COUNT_PILL} /> : null}
      </MenuItem>,
    );
  }
  menuItems.push(
    <Divider key="divider" />,
    <MenuItem
      key="send" {...item} id={single ? 'h5-translate-send' : 'h5-more-send'} disabled={state.translating} title={single ? t('Send as typed, without translating') + SEND_KEYS : undefined}
      onClick={choose(() => { const form = document.getElementById('h5-translate'); if (form && form.requestSubmit) form.requestSubmit(); })}
    >
      <ListItemIcon><Icon name="send" size={20} /></ListItemIcon><ListItemText>{t('Send as typed, without translating')}</ListItemText>
      <Box component="span" aria-hidden="true" sx={{ ml: 3, color: 'text.secondary', typography: 'body2' }}>{SEND_KEYS.trim().replace(/^\(|\)$/g, '')}</Box>
    </MenuItem>,
  );
  if (column && !pointer) {
    menuItems.push(
      <MenuItem key="keyboard" {...item} id="h5-more-keyboard" role="menuitemcheckbox" aria-checked={Boolean(state.osk)} selected={Boolean(state.osk)} onClick={choose(() => ui.actions.key({ action: 'keyboard' }))}>
        <ListItemIcon><Icon name="terminalKeyboard" size={20} /></ListItemIcon><ListItemText>{t('Terminal keyboard')}</ListItemText>
      </MenuItem>,
    );
  }
  return (
    <Box
      ref={ref} className={column ? 'h5-row-tools' : `h5-actions h5-tools-${mode}`} id="h5-actions" role="toolbar" aria-label={t('Input')}
      onMouseDown={event => { if (event.target.closest('button, label')) event.preventDefault(); }}
      sx={column ? { display: 'none', alignItems: 'center', gap: 0.5, flex: '0 0 auto' }
        : single ? { display: 'flex', alignItems: 'center', gap: 0.5, flex: '0 0 auto' }
          : { display: 'flex', alignItems: 'center', px: 0.5, py: 0.25, borderTop: 1, borderColor: 'divider' }}
    >
      {phone ? keyboard('keyboard', 'terminal', 'Terminal keyboard') : null}
      {phone ? keyboard('draft', 'draft', 'Draft keyboard') : null}
      {/* Upload image or file is a label around the real file input, and the (invisible, not display:none) input covers the whole button, so the finger
          taps the input itself and the picker opens natively. iOS WebKit, a Home Screen web app above all, ignores a script `input.click()` on a hidden
          input here. h5.js checks on the input's click (it can cancel it) and reads the chosen files (`multiple`: up to nine go up in one batch). */}
      <IconButton component="label" id="h5-image" data-action="image" sx={{ ...look, position: 'relative', overflow: 'hidden' }} {...named(image)}>
        <Icon name="image" size={size} />
        <input
          type="file" id="h5-image-picker" multiple tabIndex={-1} aria-hidden="true"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', margin: 0, padding: 0, opacity: 0, cursor: 'pointer', fontSize: 0 }}
        />
      </IconButton>
      {phone ? commandsButton : null}
      {/* voice-input.js owns this button's title (hold-to-talk on touch, click to start and stop on a computer) and its `listening` class. */}
      <IconButton id="h5-voice" className="h5-voice" sx={look} title={t(pointer ? 'Voice input: click to start speaking' : 'Voice input: hold to speak, release to stop')} aria-label={t('Voice input')} aria-pressed="false"><Icon name="voice" size={size} /></IconButton>
      {single && !narrow ? commandsButton : null}
      {phone || (single && !narrow) ? docsButton : null}
      {/* Recent sessions: the session switcher (Switcher.jsx); a press while it is open switches to its centred card. */}
      {column ? null : (
        <IconButton
          id="h5-cycle" data-action="cycle" sx={look} {...named(recent)} aria-haspopup="dialog" aria-expanded={switcherOpen ? 'true' : 'false'}
          aria-controls={switcherOpen ? 'h5-switcher' : undefined} onClick={() => ui.actions.pressSwitcher()}
        ><Icon name="cycleSessions" size={size} /></IconButton>
      )}
      {phone ? null : (
        <IconButton
          id="h5-more" data-action="more" sx={look} {...named(more)} aria-haspopup="menu" aria-expanded={anchor ? 'true' : 'false'} aria-controls={anchor ? 'h5-more-menu' : undefined}
          onClick={event => setAnchor(anchor ? null : event.currentTarget)}
        >
          {column ? <Badge className="h5-more-badge" badgeContent={active} max={99} color="primary" invisible={!active} overlap="rectangular" sx={BADGE}><Icon name="taskMore" size={20} /></Badge> : <Icon name="taskMore" size={20} />}
        </IconButton>
      )}
      {phone ? null : (
        <Button
          id="h5-translate-button" type="button" variant="contained" disabled={state.translating} title={t('Translate to English and send') + TRANSLATE_KEYS} aria-label={t('Translate and send')}
          startIcon={<Icon name="send" size={16} />}
          sx={single ? { flex: '0 0 auto', height: 40, minWidth: 0, px: 2.5, ml: 0.5, [TOUCH]: { height: 44 } }
            : { flex: '0 0 auto', height: 36, minWidth: 0, px: 1.5, borderRadius: '18px', fontSize: 13, [TOUCH]: { height: 44, borderRadius: '22px' } }}
        >{t('Send')}</Button>
      )}
      {phone ? null : (
        <Menu
          id="h5-more-menu" anchorEl={anchor} open={Boolean(anchor)} onClose={close} keepMounted={single}
          anchorOrigin={{ vertical: 'top', horizontal: 'right' }} transformOrigin={{ vertical: 'bottom', horizontal: 'right' }}
          slotProps={{ paper: { sx: { minWidth: 260, maxWidth: 'calc(100vw - 16px)' } }, list: { 'aria-label': t('More tools'), dense: pointer } }}
        >{menuItems}</Menu>
      )}
    </Box>
  );
}

// The "Draft" tag and the first line of an unsent draft, over the draft box of a column that is not the focused one (the draft itself stays in the
// textarea; h5.js publishes its one-line form as `state.draftPeek` in pane mode). A press goes through to the textarea.
function DraftPeek({ ui }) {
  const text = useStore(ui, state => (state.paneFocused ? '' : state.draftPeek || ''));
  if (!text) return null;
  return (
    <Box className="h5-draft-peek" id="h5-draft-peek" aria-hidden="true" sx={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', gap: 1, px: 1.5, pointerEvents: 'none', overflow: 'hidden' }}>
      <Pill className="h5-draft-tag" label={t('Draft')} tone="primary" sx={{ flex: '0 0 auto', height: 18, px: 0.75, borderRadius: 1, fontSize: 11, fontWeight: 500 }} />
      <Box component="span" className="h5-draft-peek-text" translate="no" sx={{ flex: '1 1 auto', minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: 'text.secondary', typography: 'body2' }}>{text}</Box>
    </Box>
  );
}

// The draft box. The textarea is the plain DOM one that voice-input.js and h5.js read and write directly (value, height; `autosize()` in h5.js grows it to
// show all its text); Material UI draws around it.
// Touch: the box is hidden by default: it has no height at all (`COLLAPSED`) and sits ABOVE the two rows. The "Draft keyboard" key focuses the textarea;
// while the textarea has focus (`:focus-within`), a button is being pressed (`data-hold`, set by h5.js), voice is recording (`:has(.listening)`) or a
// translation is running (class `translating`), the box is shown with its two send actions under the text (`DRAFT_ON`, a `:has()` rule on `#h5-bottom`):
// Send as is (`#h5-translate-send`, outlined: the text as typed) and Send (`#h5-translate-button`, contained primary: translate, then send). Losing the
// focus hides it again at once (CSS only, no timer); the text stays in the textarea. Only the CSS changes, so the textarea is never remounted.
// The box reserves nothing in the page layout there: all of its height is `--h5-bar-extra`, set by h5.js on `#h5-bottom`, pulled back by a negative top
// margin, so it grows upward OVER the terminal and the terminal box never changes size (no fit, no PTY resize); h5.js moves the terminal instead.
// Computer (`single`) and a column (`compact`): the box is always shown in the row and grows upward out of it (`COMPACT_BOX`).
const COLLAPSED = { maxHeight: 0, overflow: 'hidden', m: 0, p: 0, border: 0 };
const SHOWN = { maxHeight: 'none', overflow: 'visible', px: 1, pt: 1 };
const DRAFT_ON = {
  '&:has(#h5-translate:focus-within), &:has(#h5-translate[data-hold]), &:has(#h5-translate.translating), &:has(.h5-voice.listening)': {
    '& #h5-translate': SHOWN, '& .h5-draft-actions': { display: 'flex' },
  },
};
// The draft box takes anything: no length cap, no character filter, and it stays editable while a translation runs (only the send buttons wait).
// The keyboard settings are the platform defaults (Enter is a new line), so the user's own keyboard, IME, autocorrect and dictation work as usual.
export function TranslateBar({ state, pointer = false, compact = false, single = false, ui = null }) {
  const row = compact || single;
  return (
    <Box
      component="form" className={`h5-translate${state.translating ? ' translating' : ''}`} id="h5-translate" autoComplete="off"
      onMouseDown={event => { if (event.target.closest('button')) event.preventDefault(); }}
      // A column: the focus coming into the draft box (a click, Tab) makes it the focused column at once (pane.mjs `paneUse`).
      onFocus={compact && ui && ui.actions.paneUse ? () => ui.actions.paneUse() : undefined}
      sx={single ? SINGLE_BOX : compact ? COMPACT_BOX : { position: 'relative', ...COLLAPSED }}
    >
      <OutlinedInput
        id="h5-translate-input" className={`h5-translate-input${state.translating ? ' translating' : ''}`} fullWidth size="small" inputComponent="textarea"
        placeholder={t('Chinese → English, then send')}
        inputProps={{ rows: 1, enterKeyHint: 'enter', 'aria-label': t('Chinese input, translated to English and sent to the terminal'), style: { resize: 'none' } }}
        sx={single ? SINGLE_INPUT : compact ? COMPACT_INPUT : PHONE_INPUT}
      />
      {compact && ui ? <DraftPeek ui={ui} /> : null}
      {row ? null : <DraftActions state={state} />}
    </Box>
  );
}
// The two send actions of the touch draft box: a secondary "Send as is" (outlined; the form's submit, as Option/Alt+Enter) and the primary "Send"
// (translate, then send; Enter from a hardware keyboard). Hidden with the box (`display: none` until `DRAFT_ON`, so they are never tabbed to while hidden).
function DraftActions({ state }) {
  return (
    <Box className="h5-draft-actions" sx={{ display: 'none', justifyContent: 'flex-end', alignItems: 'center', gap: 1, pt: 1 }}>
      <Button
        type="submit" id="h5-translate-send" className="h5-translate-send" variant="outlined" disabled={state.translating} title={t('Send as typed, without translating') + SEND_KEYS}
        sx={{ px: 2 }}
      >{t('Send as is')}</Button>
      <Button
        id="h5-translate-button" type="button" variant="contained" disabled={state.translating} title={t('Translate to English and send') + TRANSLATE_KEYS} aria-label={t('Translate and send')}
        startIcon={<Icon name="send" size={18} />} sx={{ px: 2.5 }}
      >{t('Send')}</Button>
    </Box>
  );
}
// The touch draft box's text field: a filled surface with 8px corners and the primary outline while it has the focus; 16px text (iOS zooms smaller).
const PHONE_INPUT = {
  alignItems: 'flex-end', py: 0.25, typography: 'body1', bgcolor: 'action.hover', borderRadius: 2,
  '&:not(.Mui-focused) fieldset': { borderColor: 'transparent' },
};
// The draft box of a column (CompactBottom): a 36px pill (44px in touch input mode) that takes the free width of the row; a 2px primary ring while
// it has the focus. In a column that is not the focused one it is quieter (a fainter surface and hint), and an unsent draft shows as DraftPeek.
// It grows upward from the row's bottom line with its text (h5.js `autosize`), over the terminal.
const COMPACT_BOX = {
  position: 'relative', flex: '1 1 auto', minWidth: 0, alignSelf: 'flex-end', display: 'flex', flexDirection: 'column', borderRadius: '18px', [TOUCH]: { borderRadius: '22px' },
  bgcolor: 'action.hover', '&:focus-within': { boxShadow: theme => `0 0 0 2px ${theme.palette.primary.main}` },
  '#h5-bottom:not([data-focused]) &': { bgcolor: theme => alpha(theme.palette.text.primary, 0.05) },
  '#h5-bottom:not([data-focused]) & textarea::placeholder': { color: 'text.disabled', opacity: 1 },
  '&:has(.h5-draft-peek) textarea': { opacity: 0 }, // the draft is drawn by DraftPeek instead
};
const COMPACT_INPUT = {
  alignItems: 'flex-end', p: 0, fontSize: 14, bgcolor: 'transparent', borderRadius: 'inherit', minHeight: 36, [TOUCH]: { minHeight: 44 },
  '& textarea': { px: 1.5, py: '8px', height: '20px', lineHeight: '20px', [TOUCH]: { py: '12px' } },
  '& fieldset': { borderColor: 'transparent' }, '&:hover fieldset, &.Mui-focused fieldset': { borderColor: 'transparent' },
};
// The draft box of the computer row: the column's box at the row's 40px with 8px corners (the theme's), body2 text. Its surface is opaque (the hover
// overlay over the paper colour), so a draft of several lines that grows over the terminal and the row's divider hides what is under it.
const SINGLE_BOX = {
  ...COMPACT_BOX, borderRadius: 2, [TOUCH]: { borderRadius: 2 },
  bgcolor: 'background.paper', backgroundImage: theme => { const tint = alpha(theme.palette.text.primary, 0.05 + theme.palette.action.hoverOpacity); return `linear-gradient(${tint}, ${tint})`; },
};
const SINGLE_INPUT = {
  alignItems: 'flex-end', p: 0, typography: 'body2', bgcolor: 'transparent', borderRadius: 'inherit', minHeight: 40, [TOUCH]: { minHeight: 44 },
  '& textarea': { px: 2, py: '10px', height: '20px', lineHeight: '20px', [TOUCH]: { py: '12px' } },
  '& fieldset': { borderColor: 'transparent' }, '&:hover fieldset, &.Mui-focused fieldset': { borderColor: 'transparent' },
};

// Row 1, one row that scrolls sideways. Order: Esc, the four arrows, Enter, then all the other keys. Keys with `icon` draw that icon from `Icons.jsx` (Ant Design Official Icon Library, see "UI icons" in AGENTS.md)
// and need `aria` (the English accessible name, also used as the title). The self-drawn Tab and Shift outlines are drawn a little larger (`iconSize`) so they look as big as the filled arrows. Keys without an icon (the set has none that fits Ctrl, Alt, Ins or ^C) keep a short text label in the same size and weight.
const KEYS = [
  { key: 'Escape', label: 'Esc', aria: 'Escape' },
  { key: 'ArrowLeft', icon: 'keyArrowLeft', aria: 'Left arrow' }, { key: 'ArrowDown', icon: 'keyArrowDown', aria: 'Down arrow' }, { key: 'ArrowUp', icon: 'keyArrowUp', aria: 'Up arrow' }, { key: 'ArrowRight', icon: 'keyArrowRight', aria: 'Right arrow' },
  { key: 'Enter', icon: 'keyEnter', aria: 'Enter' }, { key: 'Backspace', icon: 'keyBackspace', aria: 'Backspace' },
  { key: 'Tab', icon: 'keyTab', aria: 'Tab', iconSize: 26 }, { modifier: 'ctrl', label: 'Ctrl' }, { modifier: 'alt', label: 'Alt' },
  { key: 'Home', label: 'Home', aria: 'Home' }, { key: 'End', label: 'End', aria: 'End' }, { key: 'PageUp', label: 'PgUp', aria: 'Page up' }, { key: 'PageDown', label: 'PgDn', aria: 'Page down' }, { key: 'Insert', label: 'Ins', aria: 'Insert' },
  { key: 'Delete', label: 'Del', aria: 'Delete' }, { modifier: 'shift', icon: 'keyShift', aria: 'Shift', iconSize: 26 },
  { shortcut: 'ctrl-c', label: '^C', aria: 'Send Ctrl+C' },
];

// A row that scrolls sideways fades out at its right edge only while there is more to the right: `data-more` is set on the row while it is
// not scrolled to its end (and not when everything fits), so the last key (^C) is never dimmed once the row is at its end.
const FADE = 'linear-gradient(to right, #000 calc(100% - 28px), transparent)';
export const EDGE_FADE = { '&[data-more]': { WebkitMaskImage: FADE, maskImage: FADE } };
function useEdgeFade() {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const update = () => { node.toggleAttribute('data-more', node.scrollLeft + node.clientWidth < node.scrollWidth - 1); };
    update();
    node.addEventListener('scroll', update, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    if (observer) { observer.observe(node); for (const child of node.children) observer.observe(child); }
    return () => { node.removeEventListener('scroll', update); if (observer) observer.disconnect(); };
  }, []);
  return ref;
}

// A key of row 1: flat, drawn 36px high with 8px corners (`::before`) inside a 44px-high target, so a finger still hits it; the latched Ctrl / Alt /
// Shift in the primary colour with its selected overlay. A press shows the hover overlay and the ripple, clipped to the drawn key.
const KEY_FACE = { content: '""', position: 'absolute', zIndex: -1, inset: '4px 0', borderRadius: 2, bgcolor: 'action.hover' };
const KEY = {
  flex: '0 0 auto', minWidth: 44, height: 44, px: 1.25, py: 0, border: 0, borderRadius: 2, position: 'relative', isolation: 'isolate', color: 'text.primary',
  typography: 'body2', fontWeight: 500, lineHeight: 1, textTransform: 'none', bgcolor: 'transparent',
  '&::before': KEY_FACE, '&:hover, &.Mui-selected:hover': { bgcolor: 'transparent' }, '&:hover::before': { bgcolor: 'action.selected' },
  '& .MuiTouchRipple-root': { inset: '4px 0', borderRadius: 2 },
  '&.Mui-selected, &[aria-pressed="true"]': { bgcolor: 'transparent', color: 'primary.main' },
  '&.Mui-selected::before, &[aria-pressed="true"]::before': { bgcolor: theme => alpha(theme.palette.primary.main, theme.palette.action.selectedOpacity) },
};

// Row 1: the function keys. A tap keeps the focus where it is (mouse down is stopped), so it neither opens nor closes the on-screen keyboard. They stay visible while the on-screen keyboard is open.
// The row is 44px: 44px targets with the 36px keys drawn in them, 8px apart.
export function KeyBar({ state, ui }) {
  const fade = useEdgeFade();
  return (
    <Box
      ref={fade} className="h5-keys" id="h5-keys" role="toolbar" aria-label={t('Terminal keys')}
      onMouseDown={event => event.preventDefault()}
      sx={{ display: 'flex', gap: 1, px: 1, py: 0, overflowX: 'auto', overscrollBehaviorX: 'contain', scrollbarWidth: 'none', '&::-webkit-scrollbar': { display: 'none' }, ...EDGE_FADE }}
    >
      {KEYS.map(item => {
        const name = item.aria ? t(item.aria) : undefined;
        const common = { key: item.aria || item.label, size: 'small', 'aria-label': name, title: name, sx: KEY };
        const face = item.icon ? <Icon name={item.icon} size={item.iconSize || 22} /> : item.label;
        const data = item.key ? { 'data-key': item.key } : item.modifier ? { 'data-modifier': item.modifier } : { 'data-shortcut': item.shortcut };
        if (item.modifier) {
          const on = Boolean(state.mods[item.modifier]);
          return <ToggleButton {...common} {...data} value={item.modifier} selected={on} aria-pressed={on} onClick={() => ui.actions.key(item)}>{face}</ToggleButton>;
        }
        return <Button {...common} {...data} variant="text" color="inherit" onClick={() => ui.actions.key(item)}>{face}</Button>;
      })}
    </Box>
  );
}

// The hardware keyboard shortcuts of the draft box (keydown on #h5-translate-input in h5.js), shown after the tooltips: Apple systems (iPadOS reports MacIntel) use Cmd / Option.
const APPLE = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
const SEND_KEYS = APPLE ? ' (⌥↩)' : ' (Alt+Enter)';
const TRANSLATE_KEYS = APPLE ? ' (↩)' : ' (Enter)';
