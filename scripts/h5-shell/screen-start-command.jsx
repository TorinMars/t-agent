// "Run a command when it starts" of the New session dialog ("The New session dialog" in docs/design/terminal-initial-command.md): a text button
// that unfolds a multiline field (at most COMMAND_MAX characters) and a Recent menu of the last commands that started a terminal (start-commands.mjs, the same on
// every device and engine; a pick fills the field). Enter in the field is a new line; Cmd/Ctrl+Enter makes the terminal (`run`). A chunk of its own
// (lazy-screens.jsx `StartCommand`, so the first screen does not grow), drawn by TaskDrawer.jsx `NewSessionDialog`. An Engine without
// `terminal:start-command` (support.on false) has the field disabled, with its note under the button. It also gives h5.js
// `ui.actions.startCommandUsed`, which remembers a command that made a terminal for Recent.
//
// shell-core.mjs is imported only to keep the first screen's modules in one shared chunk (see there).
import './shell-core.mjs';
import React, { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Typography from '@mui/material/Typography';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import TextField from './TextField.jsx';
import { api, DialogError, errorText, t, useShared } from './common.jsx';
import { Icon } from './Icons.jsx';
import { TOUCH } from './theme.mjs';
import { COMMAND_MAX, START_COMMANDS_KEY, commandPreview, recentCommands, recordCommand } from './start-commands.mjs';

const composing = event => Boolean(event.nativeEvent && event.nativeEvent.isComposing) || event.keyCode === 229;

export function StartCommand({ ui, state, change, support, busy, run }) {
  useEffect(() => { ui.actions.startCommandUsed = text => recordCommand(text); }, [ui]); // h5.js `startSession`, once New Terminal was made with one
  return (
    <Box id="h5-start-command" sx={{ mt: 1, mx: -1 }}>
      <Button
        id="h5-start-command-toggle" size="small" disabled={busy} onClick={() => change({ expanded: !state.expanded })}
        aria-expanded={state.expanded ? 'true' : 'false'} aria-controls="h5-start-command-body"
        endIcon={<Icon name={state.expanded ? 'chevronUp' : 'chevronDown'} size={16} />} sx={{ [TOUCH]: { minHeight: 44 } }}
      >
        {t('Run a command when it starts')}
      </Button>
      {support.note ? <Typography id="h5-start-command-note" variant="caption" component="p" color="text.secondary" sx={{ px: 1 }}>{support.note}</Typography> : null}
      <Body open={state.expanded} value={state.value} change={change} off={busy || !support.on} run={run} />
    </Box>
  );
}

function Body({ open, value, change, off, run }) {
  const text = useShared(START_COMMANDS_KEY);
  const recent = recentCommands({ getItem: () => text });
  const [anchor, setAnchor] = useState(null);
  const field = useRef(null);
  const focus = () => setTimeout(() => { if (field.current) field.current.focus(); }, 0);
  useEffect(() => { if (open && !off) focus(); }, [open]); // unfolded: the cursor goes into the field
  if (!open) return null;
  const pick = entry => {
    setAnchor(null);
    change({ value: entry.command.slice(0, COMMAND_MAX) });
    focus();
  };
  const key = event => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !composing(event)) { event.preventDefault(); event.stopPropagation(); run(); return; }
    if (event.key === 'Enter' || event.key === 'ArrowUp' || event.key === 'ArrowDown') event.stopPropagation(); // a new line, or the cursor moves in the field
  };
  return (
    <Box id="h5-start-command-body" sx={{ px: 1, mt: 1 }}>
      <CommandField
        id="h5-start-command-input" disabled={off} value={value}
        inputRef={field} onChange={event => change({ value: event.target.value })} onKeyDown={key}
        helper="Typed into the shell every time this session starts, then Enter. The terminal stays open."
      />
      <Box sx={{ display: 'flex', alignItems: 'center', mt: 0.5, mx: -1 }}>
        <Button
          id="h5-start-command-recent" size="small" disabled={off || !recent.length} onClick={event => setAnchor(event.currentTarget)}
          aria-haspopup="menu" aria-expanded={anchor ? 'true' : 'false'} aria-controls={anchor ? 'h5-start-command-menu' : undefined}
          endIcon={<Icon name="chevronDown" size={16} />} sx={{ [TOUCH]: { minHeight: 44 } }}
        >
          {t('Recent')}
        </Button>
      </Box>
      <Menu id="h5-start-command-menu" anchorEl={anchor} open={Boolean(anchor)} onClose={() => setAnchor(null)} slotProps={{ paper: { sx: { maxWidth: 'min(360px, calc(100vw - 32px))' } } }}>
        {recent.map(entry => (
          <MenuItem key={entry.command} onClick={() => pick(entry)} title={entry.command} sx={{ fontFamily: 'monospace', typography: 'body2', [TOUCH]: { minHeight: 44 } }}>
            <span translate="no" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{commandPreview(entry.command)}</span>
          </MenuItem>
        ))}
      </Menu>
    </Box>
  );
}

function CommandField({ helper, ...props }) {
  return (
    <TextField
      name="command" size="small" fullWidth multiline minRows={2} maxRows={6}
      placeholder={t('Command')} helperText={t(helper)}
      slotProps={{ htmlInput: { maxLength: COMMAND_MAX, autoCapitalize: 'off', autoCorrect: 'off', spellCheck: false, 'aria-label': t('Command to run when it starts') } }}
      sx={{ '& textarea': { fontFamily: 'monospace' }, mt: 1 }}
      {...props}
    />
  );
}

export function StartCommandDialog({ state, ui }) {
  const url = state.startCommandDialog;
  const close = () => ui.set({ startCommandDialog: null });
  return url ? <EditStartCommand key={url} url={url} close={close} /> : null;
}

function EditStartCommand({ url, close }) {
  const [stored, setStored] = useState(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const field = useRef(null);
  useEffect(() => {
    let active = true;
    api('GET', `${url}/start-command`).then(({ command }) => {
      if (!active) return;
      setStored(command);
      setValue(command);
    }).catch(failure => { if (active) setError(errorText(failure)); });
    return () => { active = false; };
  }, [url]);
  useEffect(() => { if (stored !== null) field.current?.focus(); }, [stored]);

  const save = async command => {
    if (stored === null || busy) return;
    setBusy(true);
    setError('');
    try {
      await api('PATCH', url, { start_command: command });
      close();
    } catch (failure) {
      setError(errorText(failure));
      setBusy(false);
    }
  };
  const dismiss = () => { if (!busy) close(); };
  return (
    <Dialog id="h5-edit-start-command" open onClose={dismiss} fullWidth maxWidth="xs" aria-labelledby="h5-edit-start-command-title"
      sx={{ bottom: 'auto', height: 'var(--h5-height, 100%)' }}
      slotProps={{ paper: { component: 'form', onSubmit: event => { event.preventDefault(); void save(value); } } }}>
      <DialogTitle id="h5-edit-start-command-title">{t('Start command')}</DialogTitle>
      <DialogContent>
        <CommandField id="h5-edit-start-command-input" inputRef={field} disabled={stored === null || busy} value={value}
          onChange={event => setValue(event.target.value)}
          helper="Typed into the shell every time this session starts, then Enter." />
        {error ? <DialogError>{error}</DialogError> : null}
      </DialogContent>
      <DialogActions>
        {stored ? <Button type="button" color="error" disabled={busy} onClick={() => save('')} sx={{ minHeight: 44, mr: 'auto' }}>{t('Remove')}</Button> : null}
        <Button type="button" disabled={busy} onClick={dismiss} sx={{ minHeight: 44 }}>{t('Cancel')}</Button>
        <Button type="submit" variant="contained" disabled={stored === null || busy} sx={{ minHeight: 44 }}>{t('Save')}</Button>
      </DialogActions>
    </Dialog>
  );
}
