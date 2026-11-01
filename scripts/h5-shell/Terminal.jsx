import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Fab from '@mui/material/Fab';
import IconButton from '@mui/material/IconButton';
import OutlinedInput from '@mui/material/OutlinedInput';
import Paper from '@mui/material/Paper';
import ToggleButton from '@mui/material/ToggleButton';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import MicIcon from '@mui/icons-material/Mic';
import SendIcon from '@mui/icons-material/Send';
import { t } from './common.jsx';

// The terminal area. h5.js puts the xterm element in after these two; React draws only the note, the wheel strip (h5.js handles its touches) and the copy button.
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
      <Box className="h5-scroll" id="h5-scroll" onMouseDown={event => event.preventDefault()} sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <Fab size="small" data-copy aria-label={t('Copy text')} onClick={() => ui.actions.openCopy()}><ContentCopyIcon fontSize="small" /></Fab>
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
        sx={{ alignItems: 'flex-end', py: 0.25, fontSize: 15, bgcolor: 'action.hover', '& fieldset': { borderColor: 'transparent' } }}
      />
      <IconButton id="h5-voice" className="h5-voice" sx={{ width: 40, height: 40 }} title={t('Voice input: hold to speak, release to stop')} aria-label={t('Voice input')} aria-pressed="false"><MicIcon /></IconButton>
      <Button type="submit" id="h5-translate-send" className="h5-translate-send" variant="contained" disabled={state.translating} endIcon={<SendIcon />} sx={{ flex: '0 0 auto', height: 40 }}>{t('Send')}</Button>
    </Box>
  );
}

// Six columns, three rows. `at` is [row, column]; `wide` spans two columns. The arrows sit like a keyboard's cluster (an inverted T) in the
// right half of the last two rows: ↑ above ↓, ← and → beside ↓. The cells beside ↑ stay empty.
const KEYS = [
  { key: 'Escape', label: 'Esc', at: [1, 1] }, { key: 'Tab', label: 'Tab', at: [1, 2] },
  { modifier: 'ctrl', label: 'Ctrl', at: [1, 3] }, { modifier: 'alt', label: 'Alt', at: [1, 4] }, { modifier: 'shift', label: 'Shift', at: [1, 5] },
  { action: 'keyboard', label: '⌨', aria: 'Show or hide the on-screen keyboard', at: [1, 6] },
  { action: 'paste', label: 'Paste', at: [2, 1] }, { action: 'image', label: 'Image', aria: 'Upload image', at: [2, 2] }, { key: 'Backspace', label: '⌫', aria: 'Backspace', at: [2, 3] },
  { key: 'Enter', label: 'Enter', wide: true, at: [3, 1] }, { shortcut: 'ctrl-c', label: '^C', aria: 'Send Ctrl+C', at: [3, 3] },
  { key: 'ArrowUp', label: '↑', aria: 'ArrowUp', at: [2, 5] },
  { key: 'ArrowLeft', label: '←', aria: 'ArrowLeft', at: [3, 4] }, { key: 'ArrowDown', label: '↓', aria: 'ArrowDown', at: [3, 5] }, { key: 'ArrowRight', label: '→', aria: 'ArrowRight', at: [3, 6] },
];

// The function keys. A tap keeps the focus where it is (mouse down is stopped), so it neither opens nor closes the on-screen keyboard.
export function KeyBar({ state, ui }) {
  return (
    <Box
      className="h5-keys" id="h5-keys" role="toolbar" aria-label={t('Terminal keys')} hidden={state.keysHidden}
      onMouseDown={event => event.preventDefault()}
      sx={{ flex: '0 0 auto', display: state.keysHidden ? 'none' : 'grid', gridTemplateColumns: 'repeat(6, minmax(0, 1fr))', gap: 0.75, p: 1, pb: 'max(8px, env(safe-area-inset-bottom))' }}
    >
      {KEYS.map(item => {
        // Flat keys: a quiet fill, no outline; a latched modifier takes the accent colour.
        const common = { key: item.label, size: 'small', 'aria-label': item.aria ? t(item.aria) : undefined, sx: { minWidth: 0, px: 0.5, height: 38, border: 0, borderRadius: 2, color: 'text.primary', bgcolor: 'action.hover', gridRow: item.at[0], gridColumn: item.wide ? `${item.at[1]} / span 2` : item.at[1], '&:hover': { bgcolor: 'action.selected' }, '&.Mui-selected, &.Mui-selected:hover': { bgcolor: 'primary.main', color: 'primary.contrastText' } } };
        const data = item.key ? { 'data-key': item.key } : item.modifier ? { 'data-modifier': item.modifier } : item.action ? { 'data-action': item.action } : { 'data-shortcut': item.shortcut };
        if (item.modifier) {
          const on = Boolean(state.mods[item.modifier]);
          return <ToggleButton {...common} {...data} value={item.modifier} selected={on} aria-pressed={on} onClick={() => ui.actions.key(item)}>{item.label}</ToggleButton>;
        }
        return <Button {...common} {...data} variant="text" color="inherit" onClick={() => ui.actions.key(item)}>{item.label}</Button>;
      })}
    </Box>
  );
}
