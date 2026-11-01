import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import OutlinedInput from '@mui/material/OutlinedInput';
import Paper from '@mui/material/Paper';
import SvgIcon from '@mui/material/SvgIcon';
import ToggleButton from '@mui/material/ToggleButton';
import MicIcon from '@mui/icons-material/Mic';
import AddIcon from '@mui/icons-material/Add';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import CloseIcon from '@mui/icons-material/Close';
import ContentPasteIcon from '@mui/icons-material/ContentPasteOutlined';
import ImageIcon from '@mui/icons-material/ImageOutlined';
import TerminalIcon from '@mui/icons-material/Terminal';
import TranslateIcon from '@mui/icons-material/Translate';
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

// The bottom area: the function keys (one row that scrolls sideways) above the message bar. One box holds both so that, when the bar grows over the
// terminal, the keys move up with it and stay visible (h5.js sets `--h5-bar-extra` on this box and moves the terminal; the terminal is never resized).
export function BottomArea({ state, ui }) {
  const [menu, setMenu] = useState(null); // null, 'add' (the add menu) or 'commands' (the preset commands)
  useEffect(() => {
    if (!menu) return undefined;
    // A tap outside the menu (and outside the plus button) or Escape closes it.
    const away = event => { if (!event.target.closest('.h5-add-menu, #h5-add')) setMenu(null); };
    const escape = event => { if (event.key === 'Escape') setMenu(null); };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', escape); };
  }, [menu]);
  const run = action => { setMenu(null); action(); };
  const rows = menu === 'commands'
    ? [{ icon: <ArrowBackIcon />, label: 'Insert command', run: () => setMenu('add'), head: true }, ...INSERT_COMMANDS.map(command => ({ label: command, mono: true, run: () => run(() => ui.actions.insertCommand(command)) }))]
    : [
      { icon: <ImageIcon />, label: 'Upload image', run: () => run(() => ui.actions.key({ action: 'image' })) },
      { icon: <ContentPasteIcon />, label: 'Paste text', run: () => run(() => ui.actions.key({ action: 'paste' })) },
      { icon: <TerminalIcon />, label: 'Insert command', run: () => setMenu('commands') },
    ];
  return (
    <Box className="h5-bottom" id="h5-bottom" sx={{ flex: '0 0 auto', position: 'relative', zIndex: 3, bgcolor: 'var(--h5-bg)', marginTop: 'calc(var(--h5-bar-extra, 0px) * -1)', pb: 'max(8px, env(safe-area-inset-bottom))' }}>
      {menu ? (
        <Paper
          className="h5-add-menu" role="menu" aria-label={t('Add')} elevation={8} onMouseDown={event => event.preventDefault()}
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
      <TranslateBar state={state} menu={menu} onMenu={setMenu} />
      <KeyBar state={state} ui={ui} />
    </Box>
  );
}

// The draft box. The textarea is the plain DOM one that voice-input.js and h5.js read and write directly (value, height; `autosize()` in h5.js grows it to show all its text); Material UI draws around it.
// The box is hidden by default: it has no height at all (`COLLAPSED`) and sits ABOVE the function keys. The "Draft keyboard" key focuses the textarea; while the textarea has focus (`:focus-within`), a button is
// being pressed (`data-hold`, set by h5.js), the add menu is open (`data-menu`), the voice input is recording (`:has(.listening)`) or a translation is running (class `translating`), the box is shown.
// Losing the focus hides it again at once (CSS only, no timer); the text stays in the textarea. One grid: the box takes row 1 across the full width and the buttons sit on row 2:
// plus (it becomes a cross while its menu is open) at the left, voice, then send (as typed) and translate (and send) at the right. Only the CSS changes between hidden and shown, so the textarea is never remounted and keeps its focus.
// The bar reserves nothing in the page layout: all of its height is `--h5-bar-extra`, set by h5.js on `#h5-bottom`, pulled back by a negative top margin
// there, so the bar grows upward OVER the terminal and the terminal box never changes size (no fit, no PTY resize); h5.js moves the terminal instead.
const BUTTON_ROW = { gridRow: 2 };
// One radius system: the bar sets `--h5-bar-radius` (its own outer corner radius); the send and translate buttons use it as is, and the box
// inside uses it minus the bar padding (concentric corners, never below 8px). Nothing else holds a radius number, so they cannot drift apart.
const BAR_RADIUS = '22px';
const BAR_PAD = '6px'; // the bar padding (px/py 0.75 = 6px) between the outer shape and the box
const COLLAPSED = { maxHeight: 0, overflow: 'hidden', m: 0, p: 0, border: 0 };
const SHOWN = { maxHeight: 'none', overflow: 'visible', mt: 0.75, mx: 1, px: 0.75, py: 0.75, border: 1, borderColor: 'divider' };
const ROUND = { width: 40, height: 40 };
const WIDE = { width: 60, height: 40, borderRadius: 'var(--h5-bar-radius)' }; // the send arrow and translate-and-send: 1.5 times as wide as the round buttons, same height
export function TranslateBar({ state, menu, onMenu }) {
  return (
    <Box
      component="form" className={`h5-translate${state.translating ? ' translating' : ''}`} id="h5-translate" autoComplete="off" data-menu={menu ? '' : undefined}
      onMouseDown={event => { if (event.target.closest('button')) event.preventDefault(); }}
      sx={{
        position: 'relative', display: 'grid', gridTemplateColumns: 'auto 1fr auto auto auto', alignItems: 'end', columnGap: 0.5, rowGap: 0.5, '--h5-bar-radius': BAR_RADIUS, borderRadius: 'var(--h5-bar-radius)', bgcolor: 'action.hover', ...COLLAPSED,
        '& .h5-translate-input': { gridColumn: '1 / -1', gridRow: 1 },
        '& #h5-add': { gridColumn: 1, ...BUTTON_ROW }, '& #h5-voice': { gridColumn: 3, ...BUTTON_ROW }, '& #h5-translate-send': { gridColumn: 4, ...BUTTON_ROW }, '& #h5-translate-button': { gridColumn: 5, ...BUTTON_ROW },
        '&:focus-within, &[data-hold], &[data-menu], &.translating': SHOWN,
        '&:has(.h5-voice.listening)': SHOWN,
      }}
    >
      <IconButton id="h5-add" className="h5-add" type="button" sx={ROUND} aria-haspopup="menu" aria-expanded={Boolean(menu)} title={t(menu ? 'Close menu' : 'Add')} aria-label={t(menu ? 'Close menu' : 'Add')} onClick={() => onMenu(menu ? null : 'add')}>{menu ? <CloseIcon /> : <AddIcon />}</IconButton>
      <OutlinedInput
        id="h5-translate-input" className={`h5-translate-input${state.translating ? ' translating' : ''}`} fullWidth size="small" inputComponent="textarea" readOnly={state.translating}
        placeholder={t('Chinese → English, then send')}
        inputProps={{ rows: 1, maxLength: 4000, enterKeyHint: 'enter', 'aria-label': t('Chinese input, translated to English and sent to the terminal'), style: { resize: 'none' } }}
        sx={{ alignItems: 'flex-end', py: 0.25, fontSize: 15, bgcolor: 'transparent', borderRadius: `max(8px, calc(var(--h5-bar-radius) - ${BAR_PAD}))`, '& fieldset': { borderColor: 'transparent' } }}
      />
      <IconButton id="h5-voice" className="h5-voice" sx={ROUND} title={t('Voice input: hold to speak, release to stop')} aria-label={t('Voice input')} aria-pressed="false"><MicIcon /></IconButton>
      <IconButton type="submit" id="h5-translate-send" className="h5-translate-send" disabled={state.translating} sx={{ ...WIDE, border: 1, borderColor: 'divider' }} title={t('Send as typed, without translating')} aria-label={t('Send')}><ArrowUpwardIcon /></IconButton>
      <IconButton id="h5-translate-button" type="button" disabled={state.translating} sx={{ ...WIDE, bgcolor: '#fff', color: '#111', '&:hover': { bgcolor: '#e6e6e6' }, '&.Mui-disabled': { bgcolor: 'action.disabledBackground', color: 'action.disabled' } }} title={t('Translate to English and send')} aria-label={t('Translate and send')}><TranslateIcon /></IconButton>
    </Box>
  );
}

// One row that scrolls sideways. Order: terminal keyboard, draft keyboard, Esc, the four arrows, Enter, then all the other keys.
const KEYS = [
  { action: 'keyboard', id: 'keyboard', icon: 'terminal', aria: 'Terminal keyboard' }, // first, so it is on screen when the row starts at the left; it types into the terminal
  { action: 'draft', id: 'draft', icon: 'draft', aria: 'Draft keyboard' }, // types into the draft box above the keys
  { key: 'Escape', label: 'Esc' },
  { key: 'ArrowLeft', label: '←', aria: 'ArrowLeft' }, { key: 'ArrowDown', label: '↓', aria: 'ArrowDown' }, { key: 'ArrowUp', label: '↑', aria: 'ArrowUp' }, { key: 'ArrowRight', label: '→', aria: 'ArrowRight' },
  { key: 'Enter', label: 'Enter' }, { key: 'Backspace', label: '⌫', aria: 'Backspace' },
  { key: 'Tab', label: 'Tab' }, { modifier: 'ctrl', label: 'Ctrl' }, { modifier: 'alt', label: 'Alt' },
  { key: 'Home', label: 'Home' }, { key: 'End', label: 'End' }, { key: 'PageUp', label: 'PgUp', aria: 'PageUp' }, { key: 'PageDown', label: 'PgDn', aria: 'PageDown' }, { key: 'Insert', label: 'Ins', aria: 'Insert' },
  { key: 'Delete', label: 'Del', aria: 'Delete' }, { modifier: 'shift', label: 'Shift' },
  { shortcut: 'ctrl-c', label: '^C', aria: 'Send Ctrl+C' },
];

// The two keyboard keys (icons as in the reference design: a keyboard with a prompt, and a keyboard with a pencil). The one whose input has the focus is blue and aria-pressed.
function KeyboardIcon({ kind }) {
  return (
    <SvgIcon viewBox="0 0 36 24" sx={{ width: 36, height: 24 }} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1.5" y="5.5" width="19" height="13" rx="2.2" />
      <path d="M5 9.2h1.6M9 9.2h1.6M13 9.2h1.6M17 9.2h.4M5 12.4h1.6M9 12.4h1.6M13 12.4h1.6M17 12.4h.4M7 15.6h8" strokeWidth="1.4" />
      {kind === 'terminal' ? <path d="M24 9.5l4 3-4 3M30 16h4.5" /> : <path d="M31.5 6.5l3 3-8.5 8.5-3.8.8.8-3.8z" />}
    </SvgIcon>
  );
}

// The function keys. A tap keeps the focus where it is (mouse down is stopped), so it neither opens nor closes the on-screen keyboard. They stay visible while the on-screen keyboard is open.
export function KeyBar({ state, ui }) {
  return (
    <Box
      className="h5-keys" id="h5-keys" role="toolbar" aria-label={t('Terminal keys')}
      onMouseDown={event => event.preventDefault()}
      sx={{ display: 'flex', gap: 0.75, px: 1, pt: 0.75, overflowX: 'auto', overscrollBehaviorX: 'contain', scrollbarWidth: 'none', '&::-webkit-scrollbar': { display: 'none' }, WebkitMaskImage: 'linear-gradient(to right, #000 calc(100% - 28px), transparent)', maskImage: 'linear-gradient(to right, #000 calc(100% - 28px), transparent)' }}
    >
      {KEYS.map(item => {
        const common = { key: item.id || item.label, size: 'small', 'aria-label': item.aria ? t(item.aria) : undefined, title: item.icon ? t(item.aria) : undefined, sx: { flex: '0 0 auto', minWidth: item.icon ? 56 : 44, px: item.icon ? 0.75 : 1.25, height: 34, border: 1, borderColor: 'divider', borderRadius: 2, color: 'text.primary', bgcolor: 'action.hover', textTransform: 'none', '&:hover': { bgcolor: 'action.selected' }, '&.Mui-selected, &.Mui-selected:hover, &[aria-pressed="true"], &[aria-pressed="true"]:hover': { bgcolor: 'rgba(41, 182, 246, .18)', borderColor: 'primary.main', color: 'primary.light' } } };
        const data = item.key ? { 'data-key': item.key } : item.modifier ? { 'data-modifier': item.modifier } : item.action ? { 'data-action': item.action } : { 'data-shortcut': item.shortcut };
        if (item.modifier) {
          const on = Boolean(state.mods[item.modifier]);
          return <ToggleButton {...common} {...data} value={item.modifier} selected={on} aria-pressed={on} onClick={() => ui.actions.key(item)}>{item.label}</ToggleButton>;
        }
        if (item.icon) {
          const on = state.keyboard === item.icon;
          return <Button {...common} {...data} variant="text" color="inherit" aria-pressed={on} onClick={() => ui.actions.key(item)}><KeyboardIcon kind={item.icon} /></Button>;
        }
        return <Button {...common} {...data} variant="text" color="inherit" onClick={() => ui.actions.key(item)}>{item.label}</Button>;
      })}
    </Box>
  );
}
