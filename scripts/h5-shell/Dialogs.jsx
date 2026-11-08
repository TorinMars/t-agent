import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import LinearProgress from '@mui/material/LinearProgress';
import Snackbar from '@mui/material/Snackbar';
import TextField from './TextField.jsx';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';
import { Pill, t } from './common.jsx';
import { TOUCH } from './theme.mjs';

// The terminal text as plain text, so the browser's own selection handles work on it.
export function CopyDialog({ state, ui }) {
  const text = state.copyText;
  const stick = useRef(true); // the view was at the bottom: follow new output
  const box = useRef(null);
  const [query, setQuery] = useState('');
  const attach = useCallback(node => { // the latest output first, when the view opens
    box.current = node;
    if (node) { node.scrollTop = node.scrollHeight; stick.current = true; }
  }, []);
  useLayoutEffect(() => { // a refresh keeps the scroll position, unless the view sat at the bottom
    const node = box.current;
    if (node && stick.current) node.scrollTop = node.scrollHeight;
  }, [text]);
  useEffect(() => { if (text === null) setQuery(''); }, [text === null]);
  const onScroll = event => { const node = event.currentTarget; stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24; };
  const search = event => { event.preventDefault(); ui.actions.copySearch(query); };
  return (
    <Dialog id="h5-copy" fullScreen open={text !== null} onClose={() => ui.actions.copyClose()} aria-labelledby="h5-copy-title">
      <AppBar position="static" color="default" enableColorOnDark elevation={0} sx={{ borderBottom: 1, borderColor: 'divider' }}>
        <Toolbar variant="dense" sx={{ gap: 1 }}>
          <Typography id="h5-copy-title" variant="h6" component="h2" sx={{ flex: '1 1 auto' }}>{t('Copy text')}</Typography>
          <Button id="h5-copy-all" color="inherit" onClick={() => ui.actions.copyAll()}>{t('Copy all')}</Button>
          <IconButton id="h5-copy-close" aria-label={t('Close')} edge="end" onClick={() => ui.actions.copyClose()}><CloseIcon /></IconButton>
        </Toolbar>
        <Box component="form" role="search" onSubmit={search} sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 2, pb: 1 }}>
          <TextField
            id="h5-copy-search" type="search" size="small" fullWidth value={query} onChange={event => { setQuery(event.target.value); if (!event.target.value) ui.actions.copySearch(''); }}
            placeholder={t('Search')} inputProps={{ 'aria-label': t('Search in the text'), enterKeyHint: 'search', autoCapitalize: 'off', autoCorrect: 'off', spellCheck: false }}
          />
          <Button id="h5-copy-next" type="submit" variant="outlined" color="inherit" disabled={!query} sx={{ flex: '0 0 auto' }}>{t('Next match')}</Button>
        </Box>
        {/* Fit mode on a narrow screen: programs such as Claude Code wrap their own lines at the PTY width, which the copy view cannot join. */}
        {state.terminalWidth && state.terminalWidth.mode !== 'wide' && state.terminalWidth.current > 0 && state.terminalWidth.current < 100 ? (
          <Box id="h5-copy-wrap-hint" sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 2, pb: 1, fontSize: 13, color: 'text.secondary' }}>
            <Box component="span" sx={{ flex: '1 1 auto', minWidth: 0 }}>{t(`Lines are wrapped at ${state.terminalWidth.current} columns`)}</Box>
            <Button id="h5-copy-widen" size="small" variant="outlined" color="inherit" sx={{ flex: '0 0 auto', minHeight: 36 }} onClick={() => ui.actions.setTerminalWidth({ mode: 'wide' })}>{t('Widen terminal')}</Button>
          </Box>
        ) : null}
        {state.copyStale ? (
          <Box sx={{ px: 2, pb: 1 }}>
            <Pill id="h5-copy-stale" tone="primary" filled label={t('New output')} onClick={() => ui.actions.copyRefresh()} sx={{ [TOUCH]: { height: 32, px: 1.5, position: 'relative', '&::after': { content: '""', position: 'absolute', inset: '-6px 0' } } }} />
          </Box>
        ) : null}
      </AppBar>
      <div className="h5-copy-text" id="h5-copy-text" ref={attach} onScroll={onScroll} tabIndex={0}>{text}</div>
    </Dialog>
  );
}

// While an image or file goes up the page is locked and says how far it is.
export function UploadDialog({ state }) {
  const upload = state.upload;
  return (
    <Dialog className="h5-upload-overlay" open={Boolean(upload)} aria-label={t('Uploading file')} disableEscapeKeyDown transitionDuration={0}>
      {upload ? (
        <DialogContent sx={{ minWidth: 260 }}>
          <DialogContentText role="status" sx={{ mb: 2 }}>{t(upload.status)}</DialogContentText>
          <LinearProgress aria-label={t('Upload progress')} variant={upload.progress === null ? 'indeterminate' : 'determinate'} value={upload.progress === null ? undefined : upload.progress} />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

// The Paste sheet: the browser refused to read the clipboard (iOS asks for each read, and a dismissed "Paste" callout is a refusal), so the user pastes
// with the system's own paste into this box. A paste of text into the empty box is sent at once; text typed or pasted next to other text waits for Send.
// A pasted image or file goes to the upload. It sits at the top of the screen, so the on-screen keyboard does not cover it; h5.js returns the focus on close.
export function PasteDialog({ state, ui }) {
  const open = Boolean(state.pasteSheet && state.pasteSheet.open);
  const [text, setText] = useState('');
  useEffect(() => { if (!open) setText(''); }, [open]);
  const onPaste = event => {
    const data = event.clipboardData;
    const files = [...((data && data.items) || [])].filter(entry => entry.kind === 'file');
    if (files.length) {
      event.preventDefault();
      ui.actions.pasteSheetFile(files[0].getAsFile());
      return;
    }
    const pasted = data ? data.getData('text/plain') : '';
    if (pasted && !event.currentTarget.value) { event.preventDefault(); ui.actions.pasteSheetSend(pasted); }
  };
  return (
    <Dialog
      id="h5-paste" open={open} onClose={() => ui.actions.pasteSheetClose()} aria-labelledby="h5-paste-title" fullWidth maxWidth="xs" transitionDuration={0}
      sx={{ '& .MuiDialog-container': { alignItems: 'flex-start' } }}
      slotProps={{ paper: { sx: { m: 2, mt: 'max(16px, env(safe-area-inset-top))', width: 'calc(100% - 32px)', maxWidth: 420 } } }}
    >
      <DialogTitle id="h5-paste-title" sx={{ fontSize: 17, pb: 1 }}>{t('Paste')}</DialogTitle>
      <DialogContent sx={{ pb: 1 }}>
        <TextField
          id="h5-paste-text" fullWidth multiline minRows={3} maxRows={8} autoFocus value={text} onChange={event => setText(event.target.value)}
          placeholder={t('Long-press here and choose Paste')}
          slotProps={{ htmlInput: { 'aria-label': t('Long-press here and choose Paste'), onPaste, autoCapitalize: 'off', autoCorrect: 'off', spellCheck: false, translate: 'no' } }}
          sx={{ '& textarea': { fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 16 } }}
        />
        <DialogContentText id="h5-paste-hint" sx={{ mt: 1, fontSize: 13 }}>{t('The browser did not let the page read the clipboard. Long-press the box and choose Paste.')}</DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button id="h5-paste-cancel" color="inherit" onClick={() => ui.actions.pasteSheetClose()}>{t('Cancel')}</Button>
        <Button id="h5-paste-send" variant="contained" disabled={!text} onClick={() => ui.actions.pasteSheetSend(text)}>{t('Send')}</Button>
      </DialogActions>
    </Dialog>
  );
}

// The link of an image or file that was uploaded when its terminal was already gone.
export function RetainDialog({ state, ui }) {
  const url = state.retainUrl;
  return (
    <Dialog className="h5-upload-overlay" open={url !== null} onClose={() => ui.actions.retainClose()} fullWidth maxWidth="xs" transitionDuration={0}>
      <DialogTitle sx={{ fontSize: 16 }}>{t('Uploaded; the original terminal was switched or disconnected. Copy the link manually:')}</DialogTitle>
      <DialogContent>
        <TextField fullWidth size="small" value={url || ''} slotProps={{ htmlInput: { readOnly: true, 'aria-label': t('Uploaded link'), onClick: event => event.target.select() } }} />
      </DialogContent>
      <DialogActions><Button onClick={() => ui.actions.retainClose()}>{t('Close')}</Button></DialogActions>
    </Dialog>
  );
}

const DURATIONS = { info: 3500, success: 2500, error: 6000 };

// A blue notice: a one-line chip that covers little of the terminal; the button opens it in place to the whole text.
// The button is outside the role="status" box, so a screen reader reads the message without the button's name, and the text is cut by CSS only.
// Open, the button shrinks to the icon: it keeps its element (and the keyboard focus) and closes the message again. It never takes the focus from the terminal.
const CHIP = {
  minHeight: 28, py: 0, px: 1.25, alignItems: 'center', fontSize: 13, lineHeight: 1.4, borderRadius: 14,
  '& .MuiAlert-icon': { p: 0, mr: 0.75, fontSize: 16 },
  '& .MuiAlert-message': { p: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
};
function InfoNotice({ message, expanded, onToggle, onClose, ref, ...transition }) {
  const label = t(expanded ? 'Collapse this notice' : 'Show the full notice');
  const area = expanded
    ? { top: 0, bottom: 0, left: 0, width: 44 }
    : { inset: 0, [TOUCH]: { top: 'calc(50% - 22px)', bottom: 'auto', height: 44 } }; // the look stays 28px high, the finger gets 44px
  return (
    <Box ref={ref} {...transition} sx={{ position: 'relative', pointerEvents: 'auto', ...(expanded ? { width: '100%' } : { width: 'fit-content', maxWidth: 'min(280px, calc(100vw - 32px))' }) }}>
      <Box
        component="button" type="button" aria-expanded={expanded} aria-label={label} title={label}
        onMouseDown={event => event.preventDefault()} onClick={onToggle}
        sx={{ position: 'absolute', zIndex: 1, p: 0, border: 0, borderRadius: '14px', background: 'transparent', '&:hover, &:active, &:focus': { background: 'transparent' }, WebkitTapHighlightColor: 'transparent', cursor: 'pointer', '&:focus-visible': { outline: '2px solid #fff', outlineOffset: -2 }, ...area }}
      />
      <Alert
        severity="info" variant="filled" role="status" onClose={expanded ? onClose : undefined}
        sx={expanded ? { width: '100%', overflowWrap: 'anywhere', '& .MuiAlert-message': { maxHeight: '70dvh' } } : CHIP}
      >{message}</Alert>
    </Box>
  );
}

// The floating notice (what Toast did): the last message, which goes by itself. Only a blue notice that is opened stays until it is closed or replaced.
export function Notice({ state }) {
  const notice = state.notice;
  const [shown, setShown] = useState(null);
  const [expandedId, setExpandedId] = useState(null); // by id, so a newer notice starts collapsed
  useEffect(() => { if (notice) setShown(notice); }, [notice]);
  const close = (event, reason) => { if (reason !== 'clickaway') setShown(null); };
  const type = shown && DURATIONS[shown.type] ? shown.type : 'info';
  const expanded = Boolean(shown) && expandedId === shown.id;
  return (
    <Snackbar
      key={shown ? shown.id : 'none'} open={Boolean(shown)} onClose={close} autoHideDuration={expanded ? null : DURATIONS[type]}
      anchorOrigin={{ vertical: 'top', horizontal: 'center' }} sx={{ top: 'max(12px, env(safe-area-inset-top))', ...(type === 'info' ? { pointerEvents: 'none' } : null) }}
    >
      {type === 'info'
        ? <InfoNotice message={shown ? shown.message : ''} expanded={expanded} onToggle={() => setExpandedId(expanded ? null : shown.id)} onClose={() => setShown(null)} />
        : <Alert severity={type} variant="filled" onClose={() => setShown(null)} role="status" sx={{ width: '100%', overflowWrap: 'anywhere' }}>{shown ? shown.message : ''}</Alert>}
    </Snackbar>
  );
}
