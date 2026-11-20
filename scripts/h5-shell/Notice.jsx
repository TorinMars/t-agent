// The floating notice of the page (`ui.notify`, state.notice): drawn at start, unlike the dialogs of Dialogs.jsx, which are a chunk of their own
// (screen-dialogs.jsx, lazy-screens.jsx).
import { useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Snackbar from '@mui/material/Snackbar';
import SnackbarContent from '@mui/material/SnackbarContent';
import IconButton from '@mui/material/IconButton';
import { t } from './common.jsx';
import { Icon } from './Icons.jsx';
import { TOUCH } from './theme.mjs';

const DURATIONS = { info: 3500, success: 2500, error: 6000 };
const ACTION_MS = 8000; // a notice with an action stays longer (MD2: 4 to 10 seconds), so the action can be reached

// A blue notice: a one-line chip that covers little of the terminal; the button opens it in place to the whole text.
// The button is outside the role="status" box, so a screen reader reads the message without the button's name, and the text is cut by CSS only.
// Open, the button shrinks to the icon: it keeps its element (and the keyboard focus) and closes the message again. It never takes the focus from the terminal.
const CHIP = {
  minHeight: 28, py: 0, px: 1.25, alignItems: 'center', typography: 'body2', borderRadius: 14,
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
        sx={{ position: 'absolute', zIndex: 1, p: 0, border: 0, borderRadius: '14px', background: 'transparent', '&:hover, &:active, &:focus': { background: 'transparent' }, WebkitTapHighlightColor: 'transparent', cursor: 'pointer', '&:focus-visible': { outline: '2px solid', outlineColor: 'common.white', outlineOffset: -2 }, ...area }}
      />
      <Alert
        severity="info" variant="filled" role="status" onClose={expanded ? onClose : undefined}
        sx={expanded ? { width: '100%', overflowWrap: 'anywhere', '& .MuiAlert-message': { maxHeight: '70dvh' } } : CHIP}
      >{message}</Alert>
    </Box>
  );
}

// A notice with one action (`ui.notify(message, type, { action: { label, run } })`): an MD2 snackbar, the message in body2 and the action as a text
// button in the primary colour at its end. The action closes the notice and runs; the notice goes by itself after ACTION_MS like the others.
// With `lead` the message is a name, in bold after those words (`translate="no"`); `detail` is a second line; `close` adds a close button.
function ActionNotice({ message, action, lead = '', detail = '', close = false, onClose, ref, ...transition }) {
  const text = lead ? <>{t(lead)} <Box component="strong" translate="no" sx={{ fontWeight: 'fontWeightBold' }}>{message}</Box></> : message;
  const body = detail ? <><Box className="h5-notice-title">{text}</Box><Box className="h5-notice-detail" sx={{ typography: 'caption', color: 'text.secondary' }}>{t(detail)}</Box></> : text;
  return (
    <SnackbarContent
      ref={ref} {...transition} className="h5-notice-action" role="status" message={body}
      action={<>
        <Button className="h5-notice-action-button" color="primary" size="small" onClick={() => { onClose(); action.run(); }}>{t(action.label)}</Button>
        {close ? <IconButton className="h5-notice-close" size="small" color="inherit" aria-label={t('Close')} title={t('Close')} onClick={onClose} sx={{ ml: 0.5, [TOUCH]: { width: 44, height: 44 } }}><Icon name="close" size={18} /></IconButton> : null}
      </>}
      sx={{ pointerEvents: 'auto', width: '100%', maxWidth: 672, minHeight: 48, flexWrap: 'nowrap', bgcolor: 'grey.800', color: 'text.primary', typography: 'body2', overflowWrap: 'anywhere', '& .MuiSnackbarContent-message': { flex: '1 1 auto', minWidth: 0 }, '& .MuiSnackbarContent-action': { flex: '0 0 auto', mr: -1 } }}
    />
  );
}

// The floating notice (what Toast did): the last message, which goes by itself. Only a blue notice that is opened stays until it is closed or replaced.
// It stays at the top centre, not at the bottom where MD2 puts a snackbar: the bottom of the terminal is its prompt and cursor, the place most tapped,
// and a notice there would take those taps ("Floating notices" in docs/design/toast.md).
export function Notice({ state }) {
  const notice = state.notice;
  const [shown, setShown] = useState(null);
  const [expandedId, setExpandedId] = useState(null); // by id, so a newer notice starts collapsed
  useEffect(() => { if (notice) setShown(notice); }, [notice]);
  const close = (event, reason) => { if (reason !== 'clickaway') setShown(null); };
  const type = shown && DURATIONS[shown.type] ? shown.type : 'info';
  const expanded = Boolean(shown) && expandedId === shown.id;
  const action = shown && shown.action ? shown.action : null;
  return (
    <Snackbar
      key={shown ? shown.id : 'none'} open={Boolean(shown)} onClose={close} autoHideDuration={expanded ? null : action ? shown.ms || ACTION_MS : DURATIONS[type]}
      anchorOrigin={{ vertical: 'top', horizontal: 'center' }} sx={{ top: 'max(12px, env(safe-area-inset-top))', ...(type === 'info' && !action ? { pointerEvents: 'none' } : null) }}
    >
      {action ? <ActionNotice message={shown.message} action={action} lead={shown.lead} detail={shown.detail} close={shown.close} onClose={() => setShown(null)} />
        : type === 'info'
        ? <InfoNotice message={shown ? shown.message : ''} expanded={expanded} onToggle={() => setExpandedId(expanded ? null : shown.id)} onClose={() => setShown(null)} />
        : <Alert severity={type} variant="filled" onClose={() => setShown(null)} role="status" sx={{ width: '100%', maxWidth: 672, alignItems: 'center', overflowWrap: 'anywhere' }}>{shown ? shown.message : ''}</Alert>}
    </Snackbar>
  );
}
