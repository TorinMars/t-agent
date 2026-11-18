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
const FOCUS_RING = { '&.Mui-focusVisible': { outline: '2px solid #fff', outlineOffset: 2 } };
const CLIPBOARD_BAR = {
  bgcolor: 'notice.main', color: 'notice.contrastText', backgroundImage: 'none',
  border: 1, borderColor: 'rgba(255, 255, 255, .28)', '--h5-clipboard-ring': theme => theme.palette.notice.ring,
};
const CLIPBOARD_COPY = {
  bgcolor: 'notice.button', color: 'notice.main', fontWeight: 600, px: 2,
  '&:hover': { bgcolor: 'notice.buttonHover' }, '&:active': { bgcolor: 'notice.buttonHover' }, ...FOCUS_RING,
};
const CLIPBOARD_CANCEL = { color: 'notice.contrastText', px: 1.5, '&:hover': { bgcolor: 'rgba(255, 255, 255, .14)' }, ...FOCUS_RING };


// The bottom area (reference design): the draft box (hidden by default), then two rows of buttons. Row 1 are the function keys (one row that scrolls sideways); row 2 is the action row:
// terminal keyboard, draft keyboard, upload image, saved commands, voice, and (only while the draft box is shown) send and translate-and-send. One box holds all of it so that, when the draft box
// grows over the terminal, the rows move up with it and stay visible (h5.js sets `--h5-bar-extra` on this box and moves the terminal; the terminal is never resized for it).
// Under row 2, while `state.osk` is on (touch mode only), the terminal's own on-screen keyboard (Osk.jsx). It takes room in the layout, so the terminal refits above it.
// What the bottom area draws (its rows read it from here): T-Attention and the file sheet only as the counts and flags the buttons show.
const BOTTOM = state => ({
  input: state.input, terminalAgent: state.terminalAgent, translating: state.translating, osk: state.osk, mods: state.mods, keyboard: state.keyboard,
  activeCount: state.activeCount, pane: state.pane, wide: state.wide, paneFocused: Boolean(state.paneFocused),
  attentionNeeds: Number(state.attention && state.attention.needs) || 0, attentionOpen: Boolean(state.attention && state.attention.open),
  designOpen: Boolean(state.design && state.design.open),
});
export function BottomArea({ ui }) {
  const state = useStore(ui, BOTTOM, shallowEqual);
  countRender('BottomArea');
  const [menu, setMenu] = useState(false); // the saved commands list (and Paste text) is open
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
  // A computer (input mode 'pointer'): no function key row (a real keyboard has the keys), the draft box always shown, and the whole action row always there.
  const pointer = state.input === 'pointer';
  const presets = commandsFor(state.terminalAgent);
  const rows = [
    { icon: <Icon name="paste" />, label: 'Paste text', run: () => run(() => ui.actions.key({ action: 'paste' })) },
    // Under 360px (touch) row 2 has no room for the Docs button: the list leads to the documents instead (shown only there, `narrowOnly`).
    ...(pointer || compact ? [] : [{ icon: <Icon name="designDoc" />, label: 'Docs', id: 'h5-commands-docs', narrowOnly: true, run: () => run(() => ui.actions.openDesign()) }]),
    // The presets of the open terminal's kind (Claude Code, Codex or a plain shell; `state.terminalAgent`, set by h5.js), under a header naming the list (scripts/h5-shell/commands.mjs).
    // A tap types the command WITHOUT Enter, so the user checks it and presses Enter.
    { head: true, label: presets.title },
    ...presets.commands.map(({ command, note }) => ({ label: command, note, mono: true, run: () => run(() => ui.actions.insertCommand(command)) })),
    // Claude Code and Codex also list common key combinations under "Keys". A tap SENDS the key at once (h5.js `ui.actions.key({ send })`, which drops a latched Ctrl / Alt / Shift)
    // and closes the list, like a command.
    ...(presets.keys ? [{ head: true, label: 'Keys' }, ...presets.keys.map(({ label, send, note }) => ({ label, note, mono: true, keyRow: true, run: () => run(() => ui.actions.key({ send })) }))] : []),
  ];
  const list = menu ? <CommandsList rows={rows} /> : null;
  if (compact) return <CompactBottom state={state} ui={ui} list={list} onMenu={setMenu} pointer={pointer} />;
  return (
    <Box className="h5-bottom" id="h5-bottom" sx={{ flex: '0 0 auto', position: 'relative', zIndex: 3, bgcolor: 'var(--h5-bg)', marginTop: 'calc(var(--h5-bar-extra, 0px) * -1)', pb: 'max(8px, env(safe-area-inset-bottom))', ...(pointer ? POINTER_ON : DRAFT_ON) }}>
      {list}
      <TranslateBar state={state} pointer={pointer} />
      {pointer ? null : <KeyBar state={state} ui={ui} />}
      <ActionBar state={state} ui={ui} menu={menu} onMenu={setMenu} pointer={pointer} />
      {state.osk && !pointer ? <TerminalKeyboard ui={ui} /> : null}
    </Box>
  );
}

// The saved commands list (and Paste text), above the bottom area: opened by the saved commands button, or from "More tools" in a column.
function CommandsList({ rows }) {
  return (
    <Paper
      className="h5-add-menu" role="menu" aria-label={t('Saved commands')} elevation={8} onMouseDown={event => event.preventDefault()}
      sx={{ position: 'absolute', left: 8, bottom: 'calc(100% + 8px)', width: 300, maxWidth: 'calc(100vw - 16px)', boxSizing: 'border-box', maxHeight: '60vh', overflowY: 'auto', borderRadius: 2, border: 1, borderColor: 'divider', zIndex: 4 }}
    >
      {rows.map((row, index) => (row.head ? (
        <Box key={`head-${row.label}`} className="h5-add-menu-head" role="presentation" sx={{ px: 2, pt: 1.25, pb: 0.5, fontSize: 12, fontWeight: 600, color: 'text.secondary', borderTop: index ? 1 : 0, borderColor: 'divider' }}>{t(row.label)}</Box>
      ) : (
        <Button
          key={`${row.keyRow ? 'key' : 'item'}-${row.label}`} id={row.id} role="menuitem" fullWidth color="inherit" onClick={row.run} startIcon={row.icon} title={row.note ? t(row.note) : undefined}
          sx={{ justifyContent: 'flex-start', minHeight: 44, borderRadius: 0, px: 2, py: row.note ? 0.75 : 0, textTransform: 'none', fontSize: 15, borderTop: index && !rows[index - 1].head ? 1 : 0, borderColor: 'divider', ...(row.narrowOnly ? { [WIDE_ENOUGH]: { display: 'none' } } : {}) }}
        >
          {row.note ? (
            <Box component="span" sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', flex: '1 1 auto', minWidth: 0, textAlign: 'left' }}>
              <Box component="span" className={row.keyRow ? 'h5-add-menu-key' : 'h5-add-menu-command'} translate="no" sx={{ fontFamily: 'ui-monospace, Menlo, monospace', lineHeight: 1.3, overflowWrap: 'anywhere' }}>{row.label}</Box>
              <Box component="span" className="h5-add-menu-note" sx={{ fontSize: 12, lineHeight: 1.35, color: 'text.secondary', overflowWrap: 'anywhere', textWrap: 'pretty' }}>{t(row.note)}</Box>
            </Box>
          ) : t(row.label)}
        </Button>
      )))}
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

// The buttons of the focused column's row. "More tools" holds what has no button here, each doing exactly what its button does on the page:
// Saved commands (the same list), Docs, Next running or pending session (with its count, which the "More tools" button also shows as a badge),
// Send as typed without translating (the form's submit, as the send arrow and Option+Enter), and in touch input mode Terminal keyboard.
// A chosen item runs after the menu closed, so the focus the menu gives back to its button does not take it from where the action put it
// (a sent message focuses the terminal on a computer).
const COMPACT_ICON = { flex: '0 0 auto', width: 36, height: 36, p: 0, color: 'text.secondary', '&:hover': { color: 'text.primary' }, [TOUCH]: { width: 44, height: 44 } };
const BADGE = { '& .MuiBadge-badge': { fontSize: 10, height: 16, minWidth: 16, px: 0.5, pointerEvents: 'none' } };
function CompactTools({ state, ui, onMenu, pointer }) {
  const [anchor, setAnchor] = useState(null);
  useEffect(() => { if (!state.paneFocused) setAnchor(null); }, [state.paneFocused]);
  const close = () => setAnchor(null);
  const choose = action => () => { close(); setTimeout(action, 0); };
  const active = Number(state.activeCount) || 0;
  const more = t('More tools') + (active ? ` (${active})` : '');
  const cycle = t('Next running or pending session') + (active ? ` (${active})` : '');
  const image = t('Upload image or file');
  const item = { sx: { minHeight: 40, [TOUCH]: { minHeight: 48 } } };
  return (
    <Box
      className="h5-row-tools" id="h5-actions" role="toolbar" aria-label={t('Input')}
      onMouseDown={event => { if (event.target.closest('button, label')) event.preventDefault(); }}
      sx={{ display: 'none', alignItems: 'center', gap: 0.5, flex: '0 0 auto' }}
    >
      {/* The same label around the real file input as on the page (see ActionBar), so the picker opens natively and h5.js reads the files. */}
      <IconButton component="label" id="h5-image" data-action="image" sx={{ ...COMPACT_ICON, position: 'relative', overflow: 'hidden' }} {...named(image)}>
        <Icon name="image" size={20} />
        <input
          type="file" id="h5-image-picker" multiple tabIndex={-1} aria-hidden="true"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', margin: 0, padding: 0, opacity: 0, cursor: 'pointer', fontSize: 0 }}
        />
      </IconButton>
      <IconButton id="h5-voice" className="h5-voice" sx={COMPACT_ICON} title={t(pointer ? 'Voice input: click to start speaking' : 'Voice input: hold to speak, release to stop')} aria-label={t('Voice input')} aria-pressed="false"><Icon name="voice" size={20} /></IconButton>
      <IconButton
        id="h5-more" data-action="more" sx={COMPACT_ICON} {...named(more)} aria-haspopup="menu" aria-expanded={anchor ? 'true' : 'false'} aria-controls={anchor ? 'h5-more-menu' : undefined}
        onClick={event => setAnchor(anchor ? null : event.currentTarget)}
      >
        <Badge className="h5-more-badge" badgeContent={active} max={99} color="primary" invisible={!active} overlap="rectangular" sx={BADGE}><Icon name="taskMore" size={20} /></Badge>
      </IconButton>
      <Button
        id="h5-translate-button" type="button" variant="contained" disabled={state.translating} title={t('Translate to English and send') + TRANSLATE_KEYS} aria-label={t('Translate and send')}
        startIcon={<Icon name="send" size={16} />} sx={{ flex: '0 0 auto', height: 36, minWidth: 0, px: 1.5, borderRadius: '18px', fontSize: 13, [TOUCH]: { height: 44, borderRadius: '22px' } }}
      >{t('Send')}</Button>
      <Menu
        id="h5-more-menu" anchorEl={anchor} open={Boolean(anchor)} onClose={close}
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }} transformOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        slotProps={{ paper: { sx: { minWidth: 260, maxWidth: 'calc(100vw - 16px)' } }, list: { 'aria-label': t('More tools'), dense: pointer } }}
      >
        <MenuItem {...item} id="h5-more-commands" aria-haspopup="menu" onClick={choose(() => onMenu(true))}>
          <ListItemIcon><Icon name="commands" size={20} /></ListItemIcon><ListItemText>{t('Saved commands')}</ListItemText>
        </MenuItem>
        <MenuItem {...item} id="h5-more-docs" aria-haspopup="dialog" onClick={choose(() => ui.actions.openDesign())}>
          <ListItemIcon><Icon name="designDoc" size={20} /></ListItemIcon><ListItemText>{t('Docs')}</ListItemText>
        </MenuItem>
        <MenuItem {...item} id="h5-more-cycle" aria-label={cycle} onClick={choose(() => ui.actions.nextActiveSession())}>
          <ListItemIcon><Icon name="cycleSessions" size={20} /></ListItemIcon><ListItemText>{t('Next running or pending session')}</ListItemText>
          {active ? <Pill className="h5-more-count" label={active > 99 ? '99+' : String(active)} tone="primary" filled aria-hidden="true" sx={{ ml: 2, height: 20, px: 0.75, fontSize: 12 }} /> : null}
        </MenuItem>
        <Divider />
        <MenuItem {...item} id="h5-more-send" disabled={state.translating} onClick={choose(() => { const form = document.getElementById('h5-translate'); if (form && form.requestSubmit) form.requestSubmit(); })}>
          <ListItemIcon><Icon name="send" size={20} /></ListItemIcon><ListItemText>{t('Send as typed, without translating')}</ListItemText>
          <Box component="span" aria-hidden="true" sx={{ ml: 3, color: 'text.secondary', typography: 'body2' }}>{SEND_KEYS.trim().replace(/^\(|\)$/g, '')}</Box>
        </MenuItem>
        {pointer ? null : (
          <MenuItem {...item} id="h5-more-keyboard" role="menuitemcheckbox" aria-checked={Boolean(state.osk)} selected={Boolean(state.osk)} onClick={choose(() => ui.actions.key({ action: 'keyboard' }))}>
            <ListItemIcon><Icon name="terminalKeyboard" size={20} /></ListItemIcon><ListItemText>{t('Terminal keyboard')}</ListItemText>
          </MenuItem>
        )}
      </Menu>
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
      <Box component="span" className="h5-draft-peek-text" translate="no" sx={{ flex: '1 1 auto', minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: 'text.secondary', fontSize: 14 }}>{text}</Box>
    </Box>
  );
}

// The draft box. The textarea is the plain DOM one that voice-input.js and h5.js read and write directly (value, height; `autosize()` in h5.js grows it to show all its text); Material UI draws around it.
// The box is hidden by default: it has no height at all (`COLLAPSED`) and sits ABOVE the two button rows. The "Draft keyboard" key focuses the textarea; while the textarea has focus (`:focus-within`), a button is
// being pressed (`data-hold`, set by h5.js), voice is recording (`:has(.listening)`) or a translation is running (class `translating`), the box is shown, and so are the send and translate-and-send buttons
// at the right end of the action row (`DRAFT_ON`, a `:has()` rule on `#h5-bottom`). Losing the focus hides it again at once (CSS only, no timer); the text stays in the textarea. Only the CSS changes,
// so the textarea is never remounted and keeps its focus. The send button is outside the form and points at it with the `form` attribute.
// The bar reserves nothing in the page layout: all of its height is `--h5-bar-extra`, set by h5.js on `#h5-bottom`, pulled back by a negative top margin
// there, so the bar grows upward OVER the terminal and the terminal box never changes size (no fit, no PTY resize); h5.js moves the terminal instead.
// One radius system: the box sets `--h5-bar-radius` (its outer corner radius) and the textarea inside uses it minus the box padding (concentric corners, never below 8px).
const BAR_RADIUS = '22px';
const BAR_PAD = '6px'; // the box padding (px/py 0.75 = 6px) between the outer shape and the textarea
const COLLAPSED = { maxHeight: 0, overflow: 'hidden', m: 0, p: 0, border: 0 };
const SHOWN = { maxHeight: 'none', overflow: 'visible', mt: 0.75, mx: 1, px: 0.75, py: 0.75, border: 1, borderColor: 'divider' };
// On a computer the draft box is always shown (one line at rest, growing with its text like on the phone) and so are send and translate-and-send.
// Its resting line takes room in the page layout there (h5.js `syncBar` counts only the growth beyond one line as `--h5-bar-extra`), so the terminal sits above it.
const POINTER_ON = { '& .h5-draft-only': { display: 'inline-flex' } };
const DRAFT_ON = {
  '&:has(#h5-translate:focus-within), &:has(#h5-translate[data-hold]), &:has(#h5-translate.translating), &:has(.h5-voice.listening)': {
    '& #h5-translate': SHOWN, '& .h5-draft-only': { display: 'inline-flex' }, '& .h5-draft-hide': { display: 'none' },
    '@media (min-width: 380px)': { '& #h5-actions': { gap: '8px' } }, // the draft-shown row has fewer buttons: the full 8px gaps (see REST_GAP)
  },
};
// The draft box takes anything: no length cap, no character filter, and it stays editable while a translation runs (only the send buttons wait).
// The keyboard settings are the platform defaults (Enter is a new line), so the user's own keyboard, IME, autocorrect and dictation work as usual.
export function TranslateBar({ state, pointer = false, compact = false, ui = null }) {
  return (
    <Box
      component="form" className={`h5-translate${state.translating ? ' translating' : ''}`} id="h5-translate" autoComplete="off"
      onMouseDown={event => { if (event.target.closest('button')) event.preventDefault(); }}
      // A column: the focus coming into the draft box (a click, Tab) makes it the focused column at once (pane.mjs `paneUse`).
      onFocus={compact && ui && ui.actions.paneUse ? () => ui.actions.paneUse() : undefined}
      sx={compact ? COMPACT_BOX : { position: 'relative', '--h5-bar-radius': BAR_RADIUS, borderRadius: 'var(--h5-bar-radius)', bgcolor: 'action.hover', ...(pointer ? SHOWN : COLLAPSED) }}
    >
      <OutlinedInput
        id="h5-translate-input" className={`h5-translate-input${state.translating ? ' translating' : ''}`} fullWidth size="small" inputComponent="textarea"
        placeholder={t('Chinese → English, then send')}
        inputProps={{ rows: 1, enterKeyHint: 'enter', 'aria-label': t('Chinese input, translated to English and sent to the terminal'), style: { resize: 'none' } }}
        sx={compact ? COMPACT_INPUT : { alignItems: 'flex-end', py: 0.25, fontSize: 15, bgcolor: 'transparent', borderRadius: `max(8px, calc(var(--h5-bar-radius) - ${BAR_PAD}))`, '& fieldset': { borderColor: 'transparent' } }}
      />
      {compact && ui ? <DraftPeek ui={ui} /> : null}
    </Box>
  );
}
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

// Row 1, one row that scrolls sideways. Order: Esc, the four arrows, Enter, then all the other keys. Keys with `icon` draw that icon from `Icons.jsx` (Ant Design Official Icon Library, see "Phone UI icons" in AGENTS.md)
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

const KEY_BLUE = { bgcolor: 'rgba(41, 182, 246, .18)', borderColor: 'primary.main', color: 'primary.light' };
const keyLook = { border: 1, borderColor: 'divider', borderRadius: 2, color: 'text.primary', bgcolor: 'action.hover', textTransform: 'none', '&:hover': { bgcolor: 'action.selected' }, '&.Mui-selected, &.Mui-selected:hover, &[aria-pressed="true"], &[aria-pressed="true"]:hover': KEY_BLUE };

// Row 1: the function keys. A tap keeps the focus where it is (mouse down is stopped), so it neither opens nor closes the on-screen keyboard. They stay visible while the on-screen keyboard is open.
// The keys are 44px high (a finger-sized target) with 8px between them.
export function KeyBar({ state, ui }) {
  const fade = useEdgeFade();
  return (
    <Box
      ref={fade} className="h5-keys" id="h5-keys" role="toolbar" aria-label={t('Terminal keys')}
      onMouseDown={event => event.preventDefault()}
      sx={{ display: 'flex', gap: 1, px: 1, pt: 0.75, overflowX: 'auto', overscrollBehaviorX: 'contain', scrollbarWidth: 'none', '&::-webkit-scrollbar': { display: 'none' }, ...EDGE_FADE }}
    >
      {KEYS.map(item => {
        const name = item.aria ? t(item.aria) : undefined;
        const common = { key: item.aria || item.label, size: 'small', 'aria-label': name, title: name, sx: { flex: '0 0 auto', minWidth: 44, px: 1.25, height: 44, fontSize: 14, fontWeight: 500, lineHeight: 1, ...keyLook } };
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

// Row 2 (reference design): terminal keyboard, draft keyboard, upload image, saved commands, voice, Docs (the design document sheet, whose header leads to the
// file tree), Attention (T-Attention, with the "Needs you" count) and next running or pending session (the last three hidden while the draft box is shown); then, only while the draft box is shown, a divider, the send arrow (white circle: sends the text as typed)
// and translate-and-send (the same white circle with a small "Aa"). The keyboard key whose input has the focus is blue and aria-pressed. The voice button is the one voice-input.js drives (`#h5-voice`).
// The send and translate-and-send buttons look the same (white round button, send icon); translate-and-send only has a small "Aa" mark in its lower right corner.
// Touch targets: every button of the row is at least 44 x 44px. At rest the row has eight buttons (seven under 360px, where Docs is left out and the saved
// commands list has a Docs entry instead), which
// need 8 x 44 + 7 x 8 + 16 = 424px with 8px gaps: from 380px the gaps shrink to what is left (`REST_GAP`, about 3px at 390px, 8px from 424px), and
// with the draft box shown (five buttons, a divider and the two send buttons) they are 8px again. Under 380px (a 320 or 360px phone) the buttons touch: each takes an equal share of the row (at least 44px at
// 320px) and is DRAWN `--h5-slot-pad` smaller on each side (`::before`), so the whole share is the target and the gap stays visible.
const NARROW = '@media (max-width: 379.98px)';
// Eight 44px buttons in the row's width, at most 8px apart; with voice input off there are seven (`--h5-rest-*` in h5.css).
const REST_GAP = 'min(8px, calc((100% - var(--h5-rest-width, 352px)) / var(--h5-rest-gaps, 7)))';
const WIDE_ENOUGH = '@media (min-width: 360px)'; // eight 44px buttons fit in row 2 (touch)
const SEND = { display: 'none', flex: '0 0 auto', width: 44, height: 44, bgcolor: '#fff', color: '#111', '&:hover': { bgcolor: '#e6e6e6' }, '&.Mui-disabled': { bgcolor: 'action.disabledBackground', color: 'action.disabled' } };
const TOUCH_SEND = {
  ...SEND,
  [NARROW]: {
    flex: '1 1 0', width: 'auto', minWidth: 44, position: 'relative', isolation: 'isolate', '&, &:hover, &.Mui-disabled': { bgcolor: 'transparent' },
    '&::before': { content: '""', position: 'absolute', zIndex: -1, top: '50%', left: '50%', width: 40, height: 40, transform: 'translate(-50%, -50%)', borderRadius: '50%', bgcolor: '#fff' },
    '&:hover::before': { bgcolor: '#e6e6e6' }, '&.Mui-disabled::before': { bgcolor: 'action.disabledBackground' },
    '& .MuiTouchRipple-root': { inset: 'auto', top: '50%', left: '50%', width: 40, height: 40, transform: 'translate(-50%, -50%)' },
  },
};
const ACTION = {
  flex: '1 1 0', minWidth: 44, height: 44, p: 0, ...keyLook,
  [NARROW]: {
    position: 'relative', isolation: 'isolate',
    '&, &:hover, &.Mui-selected, &.Mui-selected:hover, &[aria-pressed="true"], &[aria-pressed="true"]:hover': { bgcolor: 'transparent', borderColor: 'transparent' },
    '&::before': { content: '""', position: 'absolute', zIndex: -1, inset: '0 var(--h5-slot-pad)', border: 1, borderColor: 'divider', borderRadius: 2, bgcolor: 'action.hover' },
    '&:hover::before': { bgcolor: 'action.selected' },
    '&[aria-pressed="true"]::before': { bgcolor: KEY_BLUE.bgcolor, borderColor: KEY_BLUE.borderColor },
    '& .MuiTouchRipple-root': { inset: '0 var(--h5-slot-pad)' },
  },
};
// A computer: compact square buttons on the left, send and translate-and-send at the right end (the row does not stretch the buttons over 960px).
const POINTER_ACTION = { flex: '0 0 auto', width: 40, height: 40, p: 0, ...keyLook };
// The hardware keyboard shortcuts of the draft box (keydown on #h5-translate-input in h5.js), shown after the tooltips: Apple systems (iPadOS reports MacIntel) use Cmd / Option.
const APPLE = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
const SEND_KEYS = APPLE ? ' (\u2325\u21a9)' : ' (Alt+Enter)';
const TRANSLATE_KEYS = APPLE ? ' (\u21a9)' : ' (Enter)';
export function ActionBar({ state, ui, menu, onMenu, pointer = false }) {
  const look = pointer ? POINTER_ACTION : ACTION;
  // The keyboard keys exist only on touch screens. Terminal keyboard shows and hides the terminal's own on-screen keyboard (Osk.jsx, never the system one);
  // draft keyboard focuses the draft box, so the system keyboard (with its IME and dictation) types into it.
  const keyboard = (action, kind, label) => (
    <IconButton data-action={action} sx={look} title={t(label)} aria-label={t(label)} aria-pressed={kind === 'terminal' ? Boolean(state.osk) : state.keyboard === kind} onClick={() => ui.actions.key({ action })}><Icon name={kind === 'terminal' ? 'terminalKeyboard' : 'draftKeyboard'} /></IconButton>
  );
  const image = t('Upload image or file');
  const commands = t('Saved commands');
  const docs = t('Docs');
  // The name carries the "Needs you" count of T-Attention while there are some; the badge shows the same number.
  const needs = state.attentionNeeds;
  const attention = t('Attention') + (needs ? ` (${needs})` : '');
  const attentionOpen = state.attentionOpen;
  // The name carries the count of running or pending sessions while there are some; the badge shows the same number.
  const active = Number(state.activeCount) || 0;
  const cycle = t('Next running or pending session') + (active ? ` (${active})` : '');
  const sendTitle = t('Send as typed, without translating') + SEND_KEYS;
  const translateTitle = t('Translate to English and send') + TRANSLATE_KEYS;
  return (
    <Box
      className="h5-actions" id="h5-actions" role="toolbar" aria-label={t('Input')}
      onMouseDown={event => { if (event.target.closest('button, label')) event.preventDefault(); }}
      sx={pointer ? { display: 'flex', alignItems: 'center', gap: 0.75, px: 1, pt: 0.75 }
        : { display: 'flex', alignItems: 'center', gap: REST_GAP, px: 1, pt: 1, [NARROW]: { gap: 0, px: 0.5, '--h5-slot-pad': '3px' }, '@media (max-width: 339.98px)': { '--h5-slot-pad': '2px' } }}
    >
      {pointer ? null : keyboard('keyboard', 'terminal', 'Terminal keyboard')}
      {pointer ? null : keyboard('draft', 'draft', 'Draft keyboard')}
      {/* Upload image or file is a label around the real file input, and the (invisible, not display:none) input covers the whole button, so the finger taps the input
          itself and the picker opens natively. iOS WebKit, a Home Screen web app above all, ignores a script `input.click()` on a hidden input here. h5.js checks
          on the input's click (it can cancel it) and reads the chosen files (`multiple`: up to nine go up in one batch). Not a <button>, so the bar's press capture
          leaves it alone. */}
      <IconButton component="label" id="h5-image" data-action="image" sx={{ ...look, position: 'relative', overflow: 'hidden' }} {...named(image)}>
        <Icon name="image" />
        <input
          type="file" id="h5-image-picker" multiple tabIndex={-1} aria-hidden="true"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', margin: 0, padding: 0, opacity: 0, cursor: 'pointer', fontSize: 0 }}
        />
      </IconButton>
      <IconButton id="h5-commands" data-action="commands" sx={look} {...named(commands)} aria-haspopup="menu" aria-expanded={menu} onClick={() => onMenu(!menu)}><Icon name="commands" /></IconButton>
      {/* voice-input.js owns this button's title (hold-to-talk on touch, click to start and stop on a computer), so it keeps the native title only. */}
      <IconButton id="h5-voice" className="h5-voice" sx={look} title={t(pointer ? 'Voice input: click to start speaking' : 'Voice input: hold to speak, release to stop')} aria-label={t('Voice input')} aria-pressed="false"><Icon name="voice" /></IconButton>
      {/* Docs: the design document sheet (Design.jsx); its header has Files (the read-only file tree, FileTree.jsx), and the tree's header leads back to the
          design document. It steps aside while the draft box is shown (`.h5-draft-hide`), so send and translate-and-send keep finger-sized buttons at 320px.
          On a touch screen under 360px eight 44px buttons do not fit, so it is left out there: the saved commands list has a Docs entry instead. */}
      <IconButton id="h5-design" className="h5-draft-hide" data-action="design" sx={pointer ? look : { ...look, '@media (max-width: 359.98px)': { display: 'none' } }} {...named(docs)} aria-haspopup="dialog" aria-expanded={state.designOpen} onClick={() => ui.actions.openDesign()}><Icon name="designDoc" /></IconButton>
      {/* T-Attention (Attention.jsx): the badge counts the tasks that need the user (waiting_user). Steps aside with the draft box too. Not in a pane of the
          multi-column view: the top page keeps T-Attention for all its columns (pane.mjs). */}
      {state.pane ? null : (
        <IconButton id="h5-attention" className="h5-draft-hide" data-action="attention" sx={look} {...named(attention)} aria-haspopup={state.wide ? undefined : 'dialog'} aria-expanded={attentionOpen} onClick={() => ui.actions.toggleAttention()}><Badge className="h5-attention-badge" badgeContent={needs} max={99} color="warning" invisible={!needs} overlap="circular" sx={{ '& .MuiBadge-badge': { fontSize: 10, height: 16, minWidth: 16, px: 0.5, pointerEvents: 'none' } }}><Icon name="attention" /></Badge></IconButton>
      )}
      {/* Next running or pending terminal session, in task sheet order (`ui.actions.nextActiveSession` in h5.js). Also steps aside while the draft box is shown. */}
      <IconButton id="h5-cycle" className="h5-draft-hide" data-action="cycle" sx={look} {...named(cycle)} onClick={() => ui.actions.nextActiveSession()}><Badge className="h5-cycle-badge" badgeContent={active} max={99} color="primary" invisible={!active} overlap="circular" sx={{ '& .MuiBadge-badge': { fontSize: 10, height: 16, minWidth: 16, px: 0.5, pointerEvents: 'none' } }}><Icon name="cycleSessions" /></Badge></IconButton>
      {/* The divider takes 1px and no extra gap (its right margin cancels one gap), so the draft-shown row fits from 380px with 8px gaps. */}
      <Box className="h5-draft-only" aria-hidden="true" sx={{ display: 'none', alignSelf: 'stretch', width: '1px', my: 0.5, ml: pointer ? 'auto' : 0, mr: pointer ? 0 : -1, bgcolor: 'divider', [NARROW]: { mr: 0 } }} />
      <IconButton
        type="submit" form="h5-translate" id="h5-translate-send" className="h5-translate-send h5-draft-only" disabled={state.translating} title={sendTitle} aria-label={t('Send')}
        sx={pointer ? SEND : TOUCH_SEND}
      ><Icon name="send" /></IconButton>
      <IconButton
        id="h5-translate-button" type="button" className="h5-draft-only" disabled={state.translating} title={translateTitle} aria-label={t('Translate and send')}
        sx={{ ...(pointer ? SEND : TOUCH_SEND), position: 'relative' }}
      ><Icon name="send" /><Box component="span" className="h5-aa" aria-hidden="true" sx={{ position: 'absolute', right: 10, bottom: 8, fontSize: 10, fontWeight: 700, lineHeight: 1, letterSpacing: '-0.02em', pointerEvents: 'none' }}>Aa</Box></IconButton>
    </Box>
  );
}
