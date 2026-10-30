import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Fab from '@mui/material/Fab';
import IconButton from '@mui/material/IconButton';
import OutlinedInput from '@mui/material/OutlinedInput';
import Paper from '@mui/material/Paper';
import ToggleButton from '@mui/material/ToggleButton';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import MicIcon from '@mui/icons-material/Mic';
import SendIcon from '@mui/icons-material/Send';
import { t } from './common.jsx';

// The terminal area. h5.js puts the xterm element in after these two; React draws only the note and the scroll buttons.
export function TerminalArea({ state, ui }) {
  return (
    <Box component="main" className="h5-terminal" id="h5-terminal">
      {state.empty ? <div className="h5-empty" id="h5-empty">{t(state.empty)}</div> : null}
      <Box className="h5-scroll" id="h5-scroll" onMouseDown={event => event.preventDefault()} sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <Fab size="small" data-copy aria-label={t('Copy text')} onClick={() => ui.actions.openCopy()}><ContentCopyIcon fontSize="small" /></Fab>
        <Fab size="small" data-scroll="-1" aria-label={t('Scroll up')} onClick={() => ui.actions.scrollPage(-1)}><KeyboardArrowUpIcon /></Fab>
        <Fab size="small" data-scroll="1" aria-label={t('Scroll down')} onClick={() => ui.actions.scrollPage(1)}><KeyboardArrowDownIcon /></Fab>
      </Box>
    </Box>
  );
}

// The Chinese-to-English box. The textarea is the plain DOM one that voice-input.js and h5.js read and write directly (value, height); Material UI draws around it.
export function TranslateBar({ state }) {
  return (
    <Box component="form" className="h5-translate" id="h5-translate" autoComplete="off" sx={{ flex: '0 0 auto', display: 'flex', alignItems: 'flex-end', gap: 1, px: 1, pt: 1, borderTop: 1, borderColor: 'divider' }}>
      <OutlinedInput
        id="h5-translate-input" className={`h5-translate-input${state.translating ? ' translating' : ''}`} fullWidth size="small" inputComponent="textarea" readOnly={state.translating}
        placeholder={t('Chinese → English, then send')}
        inputProps={{ rows: 1, maxLength: 4000, enterKeyHint: 'send', 'aria-label': t('Chinese input, translated to English and sent to the terminal'), style: { resize: 'none', maxHeight: 120 } }}
        sx={{ alignItems: 'flex-end', py: 0.25 }}
      />
      <IconButton id="h5-voice" className="h5-voice" title={t('Voice input: hold to speak, release to stop')} aria-label={t('Voice input')} aria-pressed="false"><MicIcon /></IconButton>
      <Button type="submit" id="h5-translate-send" className="h5-translate-send" variant="contained" disabled={state.translating} endIcon={<SendIcon />} sx={{ flex: '0 0 auto', height: 40 }}>{t('Send')}</Button>
    </Box>
  );
}

const KEYS = [
  { key: 'Escape', label: 'Esc' }, { key: 'Tab', label: 'Tab' },
  { modifier: 'ctrl', label: 'Ctrl' }, { modifier: 'alt', label: 'Alt' }, { modifier: 'shift', label: 'Shift' },
  { action: 'keyboard', label: '⌨', aria: 'Show or hide the on-screen keyboard' }, { action: 'paste', label: 'Paste' }, { action: 'image', label: 'Image', aria: 'Upload image' },
  { key: 'ArrowLeft', label: '←', aria: 'ArrowLeft' }, { key: 'ArrowDown', label: '↓', aria: 'ArrowDown' }, { key: 'ArrowUp', label: '↑', aria: 'ArrowUp' }, { key: 'ArrowRight', label: '→', aria: 'ArrowRight' },
  { key: 'Enter', label: 'Enter', wide: true }, { key: 'Backspace', label: '⌫', aria: 'Backspace' }, { shortcut: 'ctrl-c', label: '^C', aria: 'Send Ctrl+C' },
];

// The function keys. A tap keeps the focus where it is (mouse down is stopped), so it neither opens nor closes the on-screen keyboard.
export function KeyBar({ state, ui }) {
  return (
    <Box
      className="h5-keys" id="h5-keys" role="toolbar" aria-label={t('Terminal keys')} hidden={state.keysHidden}
      onMouseDown={event => event.preventDefault()}
      sx={{ flex: '0 0 auto', display: state.keysHidden ? 'none' : 'grid', gridTemplateColumns: 'repeat(8, minmax(0, 1fr))', gap: 0.5, p: 1, pb: 'max(8px, env(safe-area-inset-bottom))' }}
    >
      {KEYS.map(item => {
        const common = { key: item.label, size: 'small', 'aria-label': item.aria ? t(item.aria) : undefined, sx: { minWidth: 0, px: 0.5, height: 36, textTransform: 'none', gridColumn: item.wide ? 'span 2' : undefined } };
        const data = item.key ? { 'data-key': item.key } : item.modifier ? { 'data-modifier': item.modifier } : item.action ? { 'data-action': item.action } : { 'data-shortcut': item.shortcut };
        if (item.modifier) {
          const on = Boolean(state.mods[item.modifier]);
          return <ToggleButton {...common} {...data} value={item.modifier} selected={on} aria-pressed={on} onClick={() => ui.actions.key(item)}>{item.label}</ToggleButton>;
        }
        return <Button {...common} {...data} variant="outlined" color="inherit" onClick={() => ui.actions.key(item)}>{item.label}</Button>;
      })}
    </Box>
  );
}
