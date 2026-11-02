import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import OutlinedInput from '@mui/material/OutlinedInput';
import Paper from '@mui/material/Paper';
import SvgIcon from '@mui/material/SvgIcon';
import ToggleButton from '@mui/material/ToggleButton';
import MicIcon from '@mui/icons-material/Mic';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ContentPasteIcon from '@mui/icons-material/ContentPasteOutlined';
import ImageIcon from '@mui/icons-material/ImageOutlined';
import { t } from './common.jsx';

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
    { icon: <ContentPasteIcon />, label: 'Paste text', run: () => run(() => ui.actions.key({ action: 'paste' })) },
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
    '& #h5-translate': SHOWN, '& .h5-draft-only': { display: 'inline-flex' },
  },
};
export function TranslateBar({ state }) {
  return (
    <Box
      component="form" className={`h5-translate${state.translating ? ' translating' : ''}`} id="h5-translate" autoComplete="off"
      onMouseDown={event => { if (event.target.closest('button')) event.preventDefault(); }}
      sx={{ position: 'relative', '--h5-bar-radius': BAR_RADIUS, borderRadius: 'var(--h5-bar-radius)', bgcolor: 'action.hover', ...COLLAPSED }}
    >
      <OutlinedInput
        id="h5-translate-input" className={`h5-translate-input${state.translating ? ' translating' : ''}`} fullWidth size="small" inputComponent="textarea" readOnly={state.translating}
        placeholder={t('Chinese → English, then send')}
        inputProps={{ rows: 1, maxLength: 4000, enterKeyHint: 'enter', 'aria-label': t('Chinese input, translated to English and sent to the terminal'), style: { resize: 'none' } }}
        sx={{ alignItems: 'flex-end', py: 0.25, fontSize: 15, bgcolor: 'transparent', borderRadius: `max(8px, calc(var(--h5-bar-radius) - ${BAR_PAD}))`, '& fieldset': { borderColor: 'transparent' } }}
      />
    </Box>
  );
}

// Row 1, one row that scrolls sideways. Order: Esc, the four arrows, Enter, then all the other keys.
const KEYS = [
  { key: 'Escape', label: 'Esc' },
  { key: 'ArrowLeft', label: '←', aria: 'ArrowLeft' }, { key: 'ArrowDown', label: '↓', aria: 'ArrowDown' }, { key: 'ArrowUp', label: '↑', aria: 'ArrowUp' }, { key: 'ArrowRight', label: '→', aria: 'ArrowRight' },
  { key: 'Enter', label: '↵', aria: 'Enter' }, { key: 'Backspace', label: '⌫', aria: 'Backspace' },
  { key: 'Tab', label: 'Tab' }, { modifier: 'ctrl', label: 'Ctrl' }, { modifier: 'alt', label: 'Alt' },
  { key: 'Home', label: 'Home' }, { key: 'End', label: 'End' }, { key: 'PageUp', label: 'PgUp', aria: 'PageUp' }, { key: 'PageDown', label: 'PgDn', aria: 'PageDown' }, { key: 'Insert', label: 'Ins', aria: 'Insert' },
  { key: 'Delete', label: 'Del', aria: 'Delete' }, { modifier: 'shift', label: 'Shift' },
  { shortcut: 'ctrl-c', label: '^C', aria: 'Send Ctrl+C' },
];

// Icons of the action row (drawn like the reference design: outlined, 1.6px strokes). The two keyboard icons are a keyboard with a prompt (terminal) and a keyboard with a pencil (draft).
const ICON_PROPS = { viewBox: '0 0 36 24', fill: 'none', stroke: 'currentColor', strokeWidth: '1.6', strokeLinecap: 'round', strokeLinejoin: 'round', sx: { width: 30, height: 22 } };
function KeyboardIcon({ kind }) {
  return (
    <SvgIcon {...ICON_PROPS}>
      <rect x="1.5" y="5.5" width="19" height="13" rx="2.2" />
      <path d="M5 9.2h1.6M9 9.2h1.6M13 9.2h1.6M17 9.2h.4M5 12.4h1.6M9 12.4h1.6M13 12.4h1.6M17 12.4h.4M7 15.6h8" strokeWidth="1.4" />
      {kind === 'terminal' ? <path d="M24 9.5l4 3-4 3M30 16h4.5" /> : <path d="M31.5 6.5l3 3-8.5 8.5-3.8.8.8-3.8z" />}
    </SvgIcon>
  );
}
// Saved commands: a rounded square with a prompt and a list.
function CommandsIcon() {
  return (
    <SvgIcon {...ICON_PROPS}>
      <rect x="8" y="2.5" width="20" height="19" rx="3" />
      <path d="M12.5 8.5l3.5 3.5-3.5 3.5M19 9h5M19 12h5M19 15h5" />
    </SvgIcon>
  );
}
// Translate and send: an "A" and an arrow.
function TranslateSendIcon() {
  return (
    <SvgIcon {...ICON_PROPS}>
      <path d="M6 18l4.5-12L15 18M7.6 14h5.8M19 12h10M25 7.5l4.5 4.5-4.5 4.5" />
    </SvgIcon>
  );
}

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
        const common = { key: item.label, size: 'small', 'aria-label': item.aria ? t(item.aria) : undefined, sx: { flex: '0 0 auto', minWidth: 44, px: 1.25, height: 38, ...keyLook } };
        const data = item.key ? { 'data-key': item.key } : item.modifier ? { 'data-modifier': item.modifier } : { 'data-shortcut': item.shortcut };
        if (item.modifier) {
          const on = Boolean(state.mods[item.modifier]);
          return <ToggleButton {...common} {...data} value={item.modifier} selected={on} aria-pressed={on} onClick={() => ui.actions.key(item)}>{item.label}</ToggleButton>;
        }
        return <Button {...common} {...data} variant="text" color="inherit" onClick={() => ui.actions.key(item)}>{item.label}</Button>;
      })}
    </Box>
  );
}

// Row 2 (reference design): terminal keyboard, draft keyboard, upload image, saved commands, voice; then, only while the draft box is shown, a divider, the send arrow (white circle: sends the text as typed)
// and translate-and-send (outlined). The keyboard key whose input has the focus is blue and aria-pressed. The voice button is the one voice-input.js drives (`#h5-voice`).
const ACTION = { flex: '1 1 0', minWidth: 0, height: 44, p: 0, ...keyLook };
export function ActionBar({ state, ui, menu, onMenu }) {
  const keyboard = (action, kind, label) => (
    <IconButton data-action={action} sx={ACTION} title={t(label)} aria-label={t(label)} aria-pressed={state.keyboard === kind} onClick={() => ui.actions.key({ action })}><KeyboardIcon kind={kind} /></IconButton>
  );
  return (
    <Box
      className="h5-actions" id="h5-actions" role="toolbar" aria-label={t('Input')}
      onMouseDown={event => { if (event.target.closest('button')) event.preventDefault(); }}
      sx={{ display: 'flex', alignItems: 'center', gap: 0.75, px: 1, pt: 0.75 }}
    >
      {keyboard('keyboard', 'terminal', 'Terminal keyboard')}
      {keyboard('draft', 'draft', 'Draft keyboard')}
      <IconButton id="h5-image" data-action="image" sx={ACTION} title={t('Upload image')} aria-label={t('Upload image')} onClick={() => ui.actions.key({ action: 'image' })}><ImageIcon /></IconButton>
      <IconButton id="h5-commands" data-action="commands" sx={ACTION} title={t('Saved commands')} aria-label={t('Saved commands')} aria-haspopup="menu" aria-expanded={menu} onClick={() => onMenu(!menu)}><CommandsIcon /></IconButton>
      <IconButton id="h5-voice" className="h5-voice" sx={ACTION} title={t('Voice input: hold to speak, release to stop')} aria-label={t('Voice input')} aria-pressed="false"><MicIcon /></IconButton>
      <Box className="h5-draft-only" aria-hidden="true" sx={{ display: 'none', alignSelf: 'stretch', width: '1px', my: 0.5, bgcolor: 'divider' }} />
      <IconButton
        type="submit" form="h5-translate" id="h5-translate-send" className="h5-translate-send h5-draft-only" disabled={state.translating} title={t('Send as typed, without translating')} aria-label={t('Send')}
        sx={{ display: 'none', flex: '0 0 auto', width: 44, height: 44, bgcolor: '#fff', color: '#111', '&:hover': { bgcolor: '#e6e6e6' }, '&.Mui-disabled': { bgcolor: 'action.disabledBackground', color: 'action.disabled' } }}
      ><ArrowUpwardIcon /></IconButton>
      <IconButton
        id="h5-translate-button" type="button" className="h5-draft-only" disabled={state.translating} title={t('Translate to English and send')} aria-label={t('Translate and send')}
        sx={{ display: 'none', flex: '0 0 auto', width: 52, height: 44, ...keyLook, borderColor: 'text.primary', borderRadius: 2 }}
      ><TranslateSendIcon /></IconButton>
    </Box>
  );
}
