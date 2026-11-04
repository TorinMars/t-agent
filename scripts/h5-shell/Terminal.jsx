import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import OutlinedInput from '@mui/material/OutlinedInput';
import Paper from '@mui/material/Paper';
import ToggleButton from '@mui/material/ToggleButton';
import { t } from './common.jsx';
import { Icon } from './Icons.jsx';

// The terminal area. h5.js puts the xterm element in after these two; React draws only the note, the wheel strip (h5.js handles its touches) and the selection bar.
export function TerminalArea({ state, ui }) {
  return (
    <Box component="main" className="h5-terminal" id="h5-terminal">
      {state.empty ? <div className="h5-empty" id="h5-empty">{t(state.empty)}</div> : null}
      <div className="h5-wheel" id="h5-wheel" role="presentation" aria-label={t('Scroll wheel')} />
      {state.selectionBar ? (
        <Paper className="h5-selection-bar" id="h5-selection-bar" role="toolbar" aria-label={t('Selected text')} elevation={4} onMouseDown={event => event.preventDefault()}>
          <Button id="h5-selection-copy" size="small" onClick={() => ui.actions.selectionCopy()}>{t('Copy')}</Button>
          <Button id="h5-selection-cancel" size="small" color="inherit" onClick={() => ui.actions.selectionCancel()}>{t('Cancel')}</Button>
        </Paper>
      ) : null}
    </Box>
  );
}

// The commands of the "Insert command" list. Edit this list to change the presets (there is no user editing yet).
// A tap puts the text into the terminal input like a paste and does NOT press Enter, so the user checks it and presses Enter.
export const INSERT_COMMANDS = ['ls -la', 'pwd', 'git status', 'git diff', 'git log --oneline -10', 'clear', 'claude', 'exit'];

// The bottom area (reference design): the draft box (hidden by default), then two rows of buttons. Row 1 are the function keys (one row that scrolls sideways); row 2 is the action row:
// terminal keyboard, draft keyboard, upload image, saved commands, voice, and (only while the draft box is shown) send and translate-and-send. One box holds all of it so that, when the draft box
// grows over the terminal, the rows move up with it and stay visible (h5.js sets `--h5-bar-extra` on this box and moves the terminal; the terminal is never resized).
export function BottomArea({ state, ui }) {
  const [menu, setMenu] = useState(false); // the saved commands list (and Paste text) is open
  useEffect(() => {
    if (!menu) return undefined;
    // A tap outside the menu (and outside the saved commands button) or Escape closes it.
    const away = event => { if (!event.target.closest('.h5-add-menu, #h5-commands')) setMenu(false); };
    const escape = event => { if (event.key === 'Escape') setMenu(false); };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', escape); };
  }, [menu]);
  const run = action => { setMenu(false); action(); };
  const rows = [
    { icon: <Icon name="paste" />, label: 'Paste text', run: () => run(() => ui.actions.key({ action: 'paste' })) },
    ...INSERT_COMMANDS.map(command => ({ label: command, mono: true, run: () => run(() => ui.actions.insertCommand(command)) })),
  ];
  return (
    <Box className="h5-bottom" id="h5-bottom" sx={{ flex: '0 0 auto', position: 'relative', zIndex: 3, bgcolor: 'var(--h5-bg)', marginTop: 'calc(var(--h5-bar-extra, 0px) * -1)', pb: 'max(8px, env(safe-area-inset-bottom))', ...DRAFT_ON }}>
      {menu ? (
        <Paper
          className="h5-add-menu" role="menu" aria-label={t('Saved commands')} elevation={8} onMouseDown={event => event.preventDefault()}
          sx={{ position: 'absolute', left: 8, bottom: 'calc(100% + 8px)', width: 240, maxHeight: '60vh', overflowY: 'auto', borderRadius: 2, border: 1, borderColor: 'divider', zIndex: 4 }}
        >
          {rows.map((row, index) => (
            <Button
              key={row.label} role="menuitem" fullWidth color="inherit" onClick={row.run} startIcon={row.icon}
              sx={{ justifyContent: 'flex-start', height: 44, borderRadius: 0, px: 2, textTransform: 'none', fontSize: 15, fontFamily: row.mono ? 'ui-monospace, Menlo, monospace' : undefined, borderTop: index ? 1 : 0, borderColor: 'divider', ...(row.head ? { color: 'text.secondary' } : null) }}
            >{row.mono ? row.label : t(row.label)}</Button>
          ))}
        </Paper>
      ) : null}
      <TranslateBar state={state} />
      <KeyBar state={state} ui={ui} />
      <ActionBar state={state} ui={ui} menu={menu} onMenu={setMenu} />
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
const DRAFT_ON = {
  '&:has(#h5-translate:focus-within), &:has(#h5-translate[data-hold]), &:has(#h5-translate.translating), &:has(.h5-voice.listening)': {
    '& #h5-translate': SHOWN, '& .h5-draft-only': { display: 'inline-flex' }, '& .h5-draft-hide': { display: 'none' },
  },
};
// The draft box takes anything: no length cap, no character filter, and it stays editable while a translation runs (only the send buttons wait).
// The keyboard settings are the platform defaults (Enter is a new line), so the user's own keyboard, IME, autocorrect and dictation work as usual.
export function TranslateBar({ state }) {
  return (
    <Box
      component="form" className={`h5-translate${state.translating ? ' translating' : ''}`} id="h5-translate" autoComplete="off"
      onMouseDown={event => { if (event.target.closest('button')) event.preventDefault(); }}
      sx={{ position: 'relative', '--h5-bar-radius': BAR_RADIUS, borderRadius: 'var(--h5-bar-radius)', bgcolor: 'action.hover', ...COLLAPSED }}
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
// and need `aria` (the English accessible name, also used as the title). Keys without an icon (the set has none that fits Ctrl, Alt, Ins or ^C) keep a short text label in the same size and weight.
const KEYS = [
  { key: 'Escape', label: 'Esc', aria: 'Escape' },
  { key: 'ArrowLeft', icon: 'keyArrowLeft', aria: 'Left arrow' }, { key: 'ArrowDown', icon: 'keyArrowDown', aria: 'Down arrow' }, { key: 'ArrowUp', icon: 'keyArrowUp', aria: 'Up arrow' }, { key: 'ArrowRight', icon: 'keyArrowRight', aria: 'Right arrow' },
  { key: 'Enter', icon: 'keyEnter', aria: 'Enter' }, { key: 'Backspace', icon: 'keyBackspace', aria: 'Backspace' },
  { key: 'Tab', icon: 'keyTab', aria: 'Tab' }, { modifier: 'ctrl', label: 'Ctrl' }, { modifier: 'alt', label: 'Alt' },
  { key: 'Home', label: 'Home', aria: 'Home' }, { key: 'End', label: 'End', aria: 'End' }, { key: 'PageUp', label: 'PgUp', aria: 'Page up' }, { key: 'PageDown', label: 'PgDn', aria: 'Page down' }, { key: 'Insert', label: 'Ins', aria: 'Insert' },
  { key: 'Delete', label: 'Del', aria: 'Delete' }, { modifier: 'shift', icon: 'keyShift', aria: 'Shift' },
  { shortcut: 'ctrl-c', label: '^C', aria: 'Send Ctrl+C' },
];

const KEY_BLUE = { bgcolor: 'rgba(41, 182, 246, .18)', borderColor: 'primary.main', color: 'primary.light' };
const keyLook = { border: 1, borderColor: 'divider', borderRadius: 2, color: 'text.primary', bgcolor: 'action.hover', textTransform: 'none', '&:hover': { bgcolor: 'action.selected' }, '&.Mui-selected, &.Mui-selected:hover, &[aria-pressed="true"], &[aria-pressed="true"]:hover': KEY_BLUE };

// Row 1: the function keys. A tap keeps the focus where it is (mouse down is stopped), so it neither opens nor closes the on-screen keyboard. They stay visible while the on-screen keyboard is open.
export function KeyBar({ state, ui }) {
  return (
    <Box
      className="h5-keys" id="h5-keys" role="toolbar" aria-label={t('Terminal keys')}
      onMouseDown={event => event.preventDefault()}
      sx={{ display: 'flex', gap: 0.75, px: 1, pt: 0.75, overflowX: 'auto', overscrollBehaviorX: 'contain', scrollbarWidth: 'none', '&::-webkit-scrollbar': { display: 'none' }, WebkitMaskImage: 'linear-gradient(to right, #000 calc(100% - 28px), transparent)', maskImage: 'linear-gradient(to right, #000 calc(100% - 28px), transparent)' }}
    >
      {KEYS.map(item => {
        const name = item.aria ? t(item.aria) : undefined;
        const common = { key: item.aria || item.label, size: 'small', 'aria-label': name, title: name, sx: { flex: '0 0 auto', minWidth: 44, px: 1.25, height: 38, fontSize: 14, fontWeight: 500, lineHeight: 1, ...keyLook } };
        const face = item.icon ? <Icon name={item.icon} size={22} /> : item.label;
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

// Row 2 (reference design): terminal keyboard, draft keyboard, upload image, saved commands, voice, design document and next running or pending session (both hidden while the draft box is shown); then, only while the draft box is shown, a divider, the send arrow (white circle: sends the text as typed)
// and translate-and-send (the same white circle with a small "Aa"). The keyboard key whose input has the focus is blue and aria-pressed. The voice button is the one voice-input.js drives (`#h5-voice`).
// The send and translate-and-send buttons look the same (white round button, send icon); translate-and-send only has a small "Aa" mark in its lower right corner.
const SEND = { display: 'none', flex: '0 0 auto', width: 44, height: 44, bgcolor: '#fff', color: '#111', '&:hover': { bgcolor: '#e6e6e6' }, '&.Mui-disabled': { bgcolor: 'action.disabledBackground', color: 'action.disabled' } };
const ACTION = { flex: '1 1 0', minWidth: 0, height: 44, p: 0, ...keyLook };
export function ActionBar({ state, ui, menu, onMenu }) {
  const keyboard = (action, kind, label) => (
    <IconButton data-action={action} sx={ACTION} title={t(label)} aria-label={t(label)} aria-pressed={state.keyboard === kind} onClick={() => ui.actions.key({ action })}><Icon name={kind === 'terminal' ? 'terminalKeyboard' : 'draftKeyboard'} /></IconButton>
  );
  return (
    <Box
      className="h5-actions" id="h5-actions" role="toolbar" aria-label={t('Input')}
      onMouseDown={event => { if (event.target.closest('button, label')) event.preventDefault(); }}
      sx={{ display: 'flex', alignItems: 'center', gap: 0.75, px: 1, pt: 0.75, '@media (max-width: 340px)': { gap: 0.5, px: 0.75 } }}
    >
      {keyboard('keyboard', 'terminal', 'Terminal keyboard')}
      {keyboard('draft', 'draft', 'Draft keyboard')}
      {/* Upload image is a label around the real file input, and the (invisible, not display:none) input covers the whole button, so the finger taps the input
          itself and the picker opens natively. iOS WebKit, a Home Screen web app above all, ignores a script `input.click()` on a hidden input here. h5.js checks
          on the input's click (it can cancel it) and reads the chosen file. Not a <button>, so the bar's press capture leaves it alone. */}
      <IconButton component="label" id="h5-image" data-action="image" sx={{ ...ACTION, position: 'relative', overflow: 'hidden' }} title={t('Upload image')} aria-label={t('Upload image')}>
        <Icon name="image" />
        <input
          type="file" id="h5-image-picker" accept="image/png,image/jpeg,image/gif,image/webp" tabIndex={-1} aria-hidden="true"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', margin: 0, padding: 0, opacity: 0, cursor: 'pointer', fontSize: 0 }}
        />
      </IconButton>
      <IconButton id="h5-commands" data-action="commands" sx={ACTION} title={t('Saved commands')} aria-label={t('Saved commands')} aria-haspopup="menu" aria-expanded={menu} onClick={() => onMenu(!menu)}><Icon name="commands" /></IconButton>
      <IconButton id="h5-voice" className="h5-voice" sx={ACTION} title={t('Voice input: hold to speak, release to stop')} aria-label={t('Voice input')} aria-pressed="false"><Icon name="voice" /></IconButton>
      {/* The design document viewer. It steps aside while the draft box is shown (`.h5-draft-hide`), so send and translate-and-send keep finger-sized buttons at 320px. */}
      <IconButton id="h5-design" className="h5-draft-hide" data-action="design" sx={ACTION} title={t('Design document')} aria-label={t('Design document')} aria-haspopup="dialog" aria-expanded={Boolean(state.design && state.design.open)} onClick={() => ui.actions.openDesign()}><Icon name="designDoc" /></IconButton>
      {/* Next running or pending terminal session, in task sheet order (`ui.actions.nextActiveSession` in h5.js). Also steps aside while the draft box is shown. */}
      <IconButton id="h5-cycle" className="h5-draft-hide" data-action="cycle" sx={ACTION} title={t('Next running or pending session')} aria-label={t('Next running or pending session')} onClick={() => ui.actions.nextActiveSession()}><Icon name="cycleSessions" /></IconButton>
      <Box className="h5-draft-only" aria-hidden="true" sx={{ display: 'none', alignSelf: 'stretch', width: '1px', my: 0.5, bgcolor: 'divider' }} />
      <IconButton
        type="submit" form="h5-translate" id="h5-translate-send" className="h5-translate-send h5-draft-only" disabled={state.translating} title={t('Send as typed, without translating')} aria-label={t('Send')}
        sx={SEND}
      ><Icon name="send" /></IconButton>
      <IconButton
        id="h5-translate-button" type="button" className="h5-draft-only" disabled={state.translating} title={t('Translate to English and send')} aria-label={t('Translate and send')}
        sx={{ ...SEND, position: 'relative' }}
      ><Icon name="send" /><Box component="span" className="h5-aa" aria-hidden="true" sx={{ position: 'absolute', right: 10, bottom: 8, fontSize: 10, fontWeight: 700, lineHeight: 1, letterSpacing: '-0.02em', pointerEvents: 'none' }}>Aa</Box></IconButton>
    </Box>
  );
}
