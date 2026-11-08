import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Typography from '@mui/material/Typography';
import { api, errorText, t } from './common.jsx';
import { copyText } from './Attention.jsx';
import { BASE } from './attention-feed.mjs';
import { codeGroups, countdownText, secondsLeft } from './plugins-model.mjs';

// "Another machine…" in the claude listener row (Settings → T-Attention → Plugins): a pairing code for `t-attention pair` on another machine
// (POST /api/attention/pairing { origin }, see "T-Attention: easy listener install" in DESIGN.md). The code is shown big with a countdown and
// the command to copy; GET /pairing is read every 3 s to see when the other machine used it. Closing the dialog ends a code that was not used.
export function PairingDialog({ open, onClose, onPaired }) {
  const [pairing, setPairing] = useState(null);
  const [left, setLeft] = useState(0);
  const [claimed, setClaimed] = useState(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const live = useRef(false);

  const create = async () => {
    setError(''); setClaimed(null); setCopied(false);
    try {
      const made = await api('POST', `${BASE}/pairing`, { origin: location.origin });
      setPairing(made);
      setLeft(secondsLeft(made.expiresAt));
    } catch (failure) {
      setPairing(null);
      setError(`${t('Failed')}: ${errorText(failure)}`);
    }
  };

  useEffect(() => {
    live.current = open;
    if (open) void create();
    else { setPairing(null); setClaimed(null); setError(''); }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps -- a new code each time the dialog opens

  // The countdown, and the claim check every third second.
  useEffect(() => {
    if (!open || !pairing || claimed) return undefined;
    let ticks = 0;
    const timer = setInterval(async () => {
      setLeft(secondsLeft(pairing.expiresAt));
      ticks += 1;
      if (ticks % 3) return;
      try {
        const status = await api('GET', `${BASE}/pairing`);
        if (live.current && !status.active && status.claimed) { setClaimed(status.claimed); if (onPaired) onPaired(); }
      } catch { /* the next tick tries again */ }
    }, 1000);
    return () => clearInterval(timer);
  }, [open, pairing, claimed]); // eslint-disable-line react-hooks/exhaustive-deps -- onPaired is only called

  const close = () => {
    if (pairing && !claimed && left > 0) void api('DELETE', `${BASE}/pairing`).catch(() => {});
    onClose();
  };
  const copy = async () => { setCopied(await copyText(pairing.command)); };
  const expired = Boolean(pairing) && !claimed && left <= 0;

  return (
    <Dialog id="h5-pairing" open={open} onClose={close} fullWidth maxWidth="xs" aria-labelledby="h5-pairing-title">
      <DialogTitle id="h5-pairing-title" sx={{ fontSize: 18 }}>{t('Connect another machine')}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
        {error ? <Typography variant="body2" color="error" id="h5-pairing-error" sx={{ overflowWrap: 'anywhere' }}>{error}</Typography> : null}
        {!pairing && !error ? <Typography variant="body2" color="text.secondary">{t('Loading…')}</Typography> : null}
        {claimed ? (
          <Typography variant="body1" id="h5-pairing-done" role="status" sx={{ overflowWrap: 'anywhere' }}>{t('Connected:')} <span translate="no">{claimed.name}</span></Typography>
        ) : null}
        {pairing && !claimed ? (
          <>
            <Typography variant="body2" color="text.secondary">{t('Run this on the other machine. It needs T-Agent installed there (it has the t-attention command).')}</Typography>
            <Box id="h5-pairing-code" translate="no" aria-label={t('Pairing code')} sx={{ fontSize: 40, fontWeight: 700, letterSpacing: 4, textAlign: 'center', fontVariantNumeric: 'tabular-nums', opacity: expired ? 0.4 : 1 }}>{codeGroups(pairing.code)}</Box>
            <Typography variant="body2" id="h5-pairing-countdown" role="timer" color={expired ? 'error' : 'text.secondary'} sx={{ textAlign: 'center' }}>
              {expired ? t('The code expired') : `${t('Valid for')} ${countdownText(left)}`}
            </Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, p: 1, borderRadius: 1, bgcolor: 'action.hover' }}>
              <Box component="code" id="h5-pairing-command" translate="no" sx={{ flex: '1 1 auto', minWidth: 0, fontSize: 13, overflowWrap: 'anywhere', userSelect: 'all' }}>{pairing.command}</Box>
              <Button size="small" variant="outlined" id="h5-pairing-copy" disabled={expired} onClick={() => void copy()} sx={{ flex: '0 0 auto' }}>{copied ? t('Copied') : t('Copy')}</Button>
            </Box>
            <Typography variant="caption" color="text.secondary">{t('The code works once. The other machine gets its own token, which you can revoke under CLI tokens.')}</Typography>
          </>
        ) : null}
      </DialogContent>
      <DialogActions>
        {expired || error ? <Button id="h5-pairing-new" onClick={() => void create()}>{t('New code')}</Button> : null}
        <Button id="h5-pairing-close" onClick={close}>{claimed ? t('Done') : t('Close')}</Button>
      </DialogActions>
    </Dialog>
  );
}
