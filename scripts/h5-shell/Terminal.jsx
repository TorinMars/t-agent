import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Badge from '@mui/material/Badge';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import OutlinedInput from '@mui/material/OutlinedInput';
import Paper from '@mui/material/Paper';
import ToggleButton from '@mui/material/ToggleButton';
import { named, t } from './common.jsx';
import { Icon } from './Icons.jsx';
import { commandsFor } from './commands.mjs';
import { TerminalKeyboard } from './Osk.jsx';

// The terminal area. h5.js puts the xterm element in after these two; React draws only the note, the wheel strip (h5.js handles its touches) and the selection bar.
export function TerminalArea({ state, ui }) {
  return (
    <Box component="main" className="h5-terminal" id="h5-terminal">
      {state.empty ? <div className="h5-empty" id="h5-empty">{t(state.empty)}</div> : null}
      {/* The wheel strip is for fingers; a computer has a real wheel or trackpad, so it is not drawn there (input mode 'pointer'). */}
      {state.input === 'pointer' ? null : <div className="h5-wheel" id="h5-wheel" role="presentation" aria-label={t('Scroll wheel')} />}
      {state.selectionBar ? (
        <Paper className="h5-selection-bar" id="h5-selection-bar" role="toolbar" aria-label={t('Selected text')} elevation={4} onMouseDown={event => event.preventDefault()}>
          <Button id="h5-selection-copy" size="small" onClick={() => ui.actions.selectionCopy()}>{t('Copy')}</Button>
          <Button id="h5-selection-cancel" size="small" color="inherit" onClick={() => ui.actions.selectionCancel()}>{t('Cancel')}</Button>
        </Paper>
      ) : null}
    </Box>
  );
}


// The bottom area (reference design): the draft box (hidden by default), then two rows of buttons. Row 1 are the function keys (one row that scrolls sideways); row 2 is the action row:
// terminal keyboard, draft keyboard, upload image, saved commands, voice, and (only while the draft box is shown) send and translate-and-send. One box holds all of it so that, when the draft box
// grows over the terminal, the rows move up with it and stay visible (h5.js sets `--h5-bar-extra` on this box and moves the terminal; the terminal is never resized for it).
// Under row 2, while `state.osk` is on (touch mode only), the terminal's own on-screen keyboard (Osk.jsx). It takes room in the layout, so the terminal refits above it.
export function BottomArea({ state, ui }) {
  const [menu, setMenu] = useState(false); // the saved commands list (and Paste text) is open
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
  const run = action => { setMenu(false); action(); };
  // A computer (input mode 'pointer'): no function key row (a real keyboard has the keys), the draft box always shown, and the whole action row always there.
  const pointer = state.input === 'pointer';
  const presets = commandsFor(state.terminalAgent);
  const rows = [
    { icon: <Icon name="paste" />, label: 'Paste text', run: () => run(() => ui.actions.key({ action: 'paste' })) },
    // The presets of the open terminal's kind (Claude Code, Codex or a plain shell; `state.terminalAgent`, set by h5.js), under a header naming the list (scripts/h5-shell/commands.mjs).
    // A tap types the command WITHOUT Enter, so the user checks it and presses Enter.
    { head: true, label: presets.title },
    ...presets.commands.map(({ command, note }) => ({ label: command, note, mono: true, run: () => run(() => ui.actions.insertCommand(command)) })),
    // Claude Code and Codex also list common key combinations under "Keys". A tap SENDS the key at once (h5.js `ui.actions.key({ send })`, which drops a latched Ctrl / Alt / Shift)
    // and closes the list, like a command.
    ...(presets.keys ? [{ head: true, label: 'Keys' }, ...presets.keys.map(({ label, send, note }) => ({ label, note, mono: true, keyRow: true, run: () => run(() => ui.actions.key({ send })) }))] : []),
  ];
  return (
    <Box className="h5-bottom" id="h5-bottom" sx={{ flex: '0 0 auto', position: 'relative', zIndex: 3, bgcolor: 'var(--h5-bg)', marginTop: 'calc(var(--h5-bar-extra, 0px) * -1)', pb: 'max(8px, env(safe-area-inset-bottom))', ...(pointer ? POINTER_ON : DRAFT_ON) }}>
      {menu ? (
        <Paper
          className="h5-add-menu" role="menu" aria-label={t('Saved commands')} elevation={8} onMouseDown={event => event.preventDefault()}
          sx={{ position: 'absolute', left: 8, bottom: 'calc(100% + 8px)', width: 300, maxWidth: 'calc(100vw - 16px)', boxSizing: 'border-box', maxHeight: '60vh', overflowY: 'auto', borderRadius: 2, border: 1, borderColor: 'divider', zIndex: 4 }}
        >
          {rows.map((row, index) => (row.head ? (
            <Box key={`head-${row.label}`} className="h5-add-menu-head" role="presentation" sx={{ px: 2, pt: 1.25, pb: 0.5, fontSize: 12, fontWeight: 600, color: 'text.secondary', borderTop: index ? 1 : 0, borderColor: 'divider' }}>{t(row.label)}</Box>
          ) : (
            <Button
              key={`${row.keyRow ? 'key' : 'item'}-${row.label}`} role="menuitem" fullWidth color="inherit" onClick={row.run} startIcon={row.icon} title={row.note ? t(row.note) : undefined}
              sx={{ justifyContent: 'flex-start', minHeight: 44, borderRadius: 0, px: 2, py: row.note ? 0.75 : 0, textTransform: 'none', fontSize: 15, borderTop: index && !rows[index - 1].head ? 1 : 0, borderColor: 'divider' }}
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
      ) : null}
      <TranslateBar state={state} pointer={pointer} />
      {pointer ? null : <KeyBar state={state} ui={ui} />}
      <ActionBar state={state} ui={ui} menu={menu} onMenu={setMenu} pointer={pointer} />
      {state.osk && !pointer ? <TerminalKeyboard ui={ui} /> : null}
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
export function TranslateBar({ state, pointer = false }) {
  return (
    <Box
      component="form" className={`h5-translate${state.translating ? ' translating' : ''}`} id="h5-translate" autoComplete="off"
      onMouseDown={event => { if (event.target.closest('button')) event.preventDefault(); }}
      sx={{ position: 'relative', '--h5-bar-radius': BAR_RADIUS, borderRadius: 'var(--h5-bar-radius)', bgcolor: 'action.hover', ...(pointer ? SHOWN : COLLAPSED) }}
    >
      <OutlinedInput
        id="h5-translate-input" className={`h5-translate-input${state.translating ? ' translating' : ''}`} fullWidth size="small" inputComponent="textarea"
        placeholder={t('Chinese → English, then send')}
        inputProps={{ rows: 1, enterKeyHint: 'enter', 'aria-label': t('Chinese input, translated to English and sent to the terminal'), style: { resize: 'none' } }}
        sx={{ alignItems: 'flex-end', py: 0.25, fontSize: 15, bgcolor: 'transparent', borderRadius: `max(8px, calc(var(--h5-bar-radius) - ${BAR_PAD}))`, '& fieldset': { borderColor: 'transparent' } }}
      />
    </Box>
  );
}

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

// Row 2 (reference design): terminal keyboard, draft keyboard, upload image, saved commands, voice, design document, files and next running or pending session (the last three hidden while the draft box is shown); then, only while the draft box is shown, a divider, the send arrow (white circle: sends the text as typed)
// and translate-and-send (the same white circle with a small "Aa"). The keyboard key whose input has the focus is blue and aria-pressed. The voice button is the one voice-input.js drives (`#h5-voice`).
// The send and translate-and-send buttons look the same (white round button, send icon); translate-and-send only has a small "Aa" mark in its lower right corner.
// Touch targets: every button of the row is at least 44 x 44px. At rest the row has eight buttons (seven under 360px, where Files is left out), which
// need 8 x 44 + 7 x 8 + 16 = 424px with 8px gaps: from 380px the gaps shrink to what is left (`REST_GAP`, about 3px at 390px, 8px from 424px), and
// with the draft box shown (five buttons, a divider and the two send buttons) they are 8px again. Under 380px (a 320 or 360px phone) the buttons touch: each takes an equal share of the row (at least 44px at
// 320px) and is DRAWN `--h5-slot-pad` smaller on each side (`::before`), so the whole share is the target and the gap stays visible.
const NARROW = '@media (max-width: 379.98px)';
const REST_GAP = 'min(8px, calc((100% - 352px) / 7))'; // eight 44px buttons in the row's width, at most 8px apart
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
const TRANSLATE_KEYS = APPLE ? ' (\u2318\u21a9)' : ' (Ctrl+Enter)';
export function ActionBar({ state, ui, menu, onMenu, pointer = false }) {
  const look = pointer ? POINTER_ACTION : ACTION;
  // The keyboard keys exist only on touch screens. Terminal keyboard shows and hides the terminal's own on-screen keyboard (Osk.jsx, never the system one);
  // draft keyboard focuses the draft box, so the system keyboard (with its IME and dictation) types into it.
  const keyboard = (action, kind, label) => (
    <IconButton data-action={action} sx={look} title={t(label)} aria-label={t(label)} aria-pressed={kind === 'terminal' ? Boolean(state.osk) : state.keyboard === kind} onClick={() => ui.actions.key({ action })}><Icon name={kind === 'terminal' ? 'terminalKeyboard' : 'draftKeyboard'} /></IconButton>
  );
  const image = t('Upload image');
  const commands = t('Saved commands');
  const design = t('Design document');
  const files = t('Files');
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
      {/* Upload image is a label around the real file input, and the (invisible, not display:none) input covers the whole button, so the finger taps the input
          itself and the picker opens natively. iOS WebKit, a Home Screen web app above all, ignores a script `input.click()` on a hidden input here. h5.js checks
          on the input's click (it can cancel it) and reads the chosen file. Not a <button>, so the bar's press capture leaves it alone. */}
      <IconButton component="label" id="h5-image" data-action="image" sx={{ ...look, position: 'relative', overflow: 'hidden' }} {...named(image)}>
        <Icon name="image" />
        <input
          type="file" id="h5-image-picker" accept="image/png,image/jpeg,image/gif,image/webp" tabIndex={-1} aria-hidden="true"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', margin: 0, padding: 0, opacity: 0, cursor: 'pointer', fontSize: 0 }}
        />
      </IconButton>
      <IconButton id="h5-commands" data-action="commands" sx={look} {...named(commands)} aria-haspopup="menu" aria-expanded={menu} onClick={() => onMenu(!menu)}><Icon name="commands" /></IconButton>
      {/* voice-input.js owns this button's title (hold-to-talk on touch, click to start and stop on a computer), so it keeps the native title only. */}
      <IconButton id="h5-voice" className="h5-voice" sx={look} title={t(pointer ? 'Voice input: click to start speaking' : 'Voice input: hold to speak, release to stop')} aria-label={t('Voice input')} aria-pressed="false"><Icon name="voice" /></IconButton>
      {/* The design document viewer. It steps aside while the draft box is shown (`.h5-draft-hide`), so send and translate-and-send keep finger-sized buttons at 320px. */}
      <IconButton id="h5-design" className="h5-draft-hide" data-action="design" sx={look} {...named(design)} aria-haspopup="dialog" aria-expanded={Boolean(state.design && state.design.open)} onClick={() => ui.actions.openDesign()}><Icon name="designDoc" /></IconButton>
      {/* The read-only file tree of the working directory (FileTree.jsx). Steps aside with the draft box too. On a touch screen under 360px eight 44px
          buttons do not fit, so it is left out there: the file viewer's own "Files" button (Design.jsx) leads to the tree. */}
      <IconButton id="h5-files" className="h5-draft-hide" data-action="files" sx={pointer ? look : { ...look, '@media (max-width: 359.98px)': { display: 'none' } }} {...named(files)} aria-haspopup={state.wide ? undefined : 'dialog'} aria-expanded={Boolean(state.files && state.files.open)} onClick={() => ui.actions.openFiles()}><Icon name="folder" /></IconButton>
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
