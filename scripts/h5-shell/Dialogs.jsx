import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import LinearProgress from '@mui/material/LinearProgress';
import Snackbar from '@mui/material/Snackbar';
import TextField from '@mui/material/TextField';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';
import { t } from './common.jsx';

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
        {state.copyStale ? (
          <Box sx={{ px: 2, pb: 1 }}>
            <Chip id="h5-copy-stale" role="button" color="primary" size="small" label={t('New output')} onClick={() => ui.actions.copyRefresh()} />
          </Box>
        ) : null}
      </AppBar>
      <div className="h5-copy-text" id="h5-copy-text" ref={attach} onScroll={onScroll} tabIndex={0}>{text}</div>
    </Dialog>
  );
}

// While an image goes up the page is locked and says how far it is.
export function UploadDialog({ state }) {
  const upload = state.upload;
  return (
    <Dialog className="h5-upload-overlay" open={Boolean(upload)} aria-label={t('Uploading image')} disableEscapeKeyDown transitionDuration={0}>
      {upload ? (
        <DialogContent sx={{ minWidth: 260 }}>
          <DialogContentText role="status" sx={{ mb: 2 }}>{t(upload.status)}</DialogContentText>
          <LinearProgress aria-label={t('Upload progress')} variant={upload.progress === null ? 'indeterminate' : 'determinate'} value={upload.progress === null ? undefined : upload.progress} />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

// The link of an image that was uploaded when its terminal was already gone.
export function RetainDialog({ state, ui }) {
  const url = state.retainUrl;
  return (
    <Dialog className="h5-upload-overlay" open={url !== null} onClose={() => ui.actions.retainClose()} fullWidth maxWidth="xs" transitionDuration={0}>
      <DialogTitle sx={{ fontSize: 16 }}>{t('Image uploaded; the original terminal was switched or disconnected. Copy the link manually:')}</DialogTitle>
      <DialogContent>
        <TextField fullWidth size="small" value={url || ''} slotProps={{ htmlInput: { readOnly: true, 'aria-label': t('Uploaded image link'), onClick: event => event.target.select() } }} />
      </DialogContent>
      <DialogActions><Button onClick={() => ui.actions.retainClose()}>{t('Close')}</Button></DialogActions>
    </Dialog>
  );
}

const DURATIONS = { info: 3500, success: 2500, error: 6000 };

// The floating notice (what Toast did): the last message, which goes by itself.
export function Notice({ state }) {
  const notice = state.notice;
  const [shown, setShown] = useState(null);
  useEffect(() => { if (notice) setShown(notice); }, [notice]);
  const close = (event, reason) => { if (reason !== 'clickaway') setShown(null); };
  const type = shown && DURATIONS[shown.type] ? shown.type : 'info';
  return (
    <Snackbar
      key={shown ? shown.id : 'none'} open={Boolean(shown)} onClose={close} autoHideDuration={DURATIONS[type]}
      anchorOrigin={{ vertical: 'top', horizontal: 'center' }} sx={{ top: 'max(12px, env(safe-area-inset-top))' }}
    >
      <Alert severity={type} variant="filled" onClose={() => setShown(null)} role="status" sx={{ width: '100%', overflowWrap: 'anywhere' }}>{shown ? shown.message : ''}</Alert>
    </Snackbar>
  );
}
