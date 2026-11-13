import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import { api, t } from './common.jsx';
import { Feedback, Hint, Section, failure, useFeedback } from './Form.jsx';

// "Let other clients connect to this one", in Settings → Devices → Advanced (Engines.jsx; until the sheet was tidied up the group "Remote service"):
// this machine's connect address, the pairing codes (POST /api/remote-tokens/pairing, valid for 10 minutes, single use) and the engine tokens made
// with them (GET /api/remote-tokens, revoke with DELETE /api/remote-tokens/:id). It is one-way: the other client sees this one, not the other way round.
// The list is read each time "Advanced" opens (`opened` goes up).
export function RemoteAccessSection({ opened }) {
  const [tokens, setTokens] = useState([]);
  const [code, setCode] = useState('');
  const [copyLabel, setCopyLabel] = useState('Copy');
  const [busy, setBusy] = useState(false);
  const [feedback, say] = useFeedback();
  const codeNode = useRef(null);
  const load = async () => {
    try { setTokens(await api('GET', '/api/remote-tokens')); say(''); }
    catch (error) { say(failure(error), true); }
  };
  useEffect(() => { if (opened) void load(); }, [opened]); // eslint-disable-line react-hooks/exhaustive-deps -- load only reads
  const revoke = async token => {
    if (!confirm(t('Once revoked, remote connections using it stop working immediately.'))) return;
    try { await api('DELETE', `/api/remote-tokens/${token.id}`); await load(); }
    catch (error) { say(failure(error), true); }
  };
  const create = async () => {
    setBusy(true);
    try {
      const created = await api('POST', '/api/remote-tokens/pairing', {});
      setCode(created.code);
      setCopyLabel('Copy');
      say('Pairing code created. Valid for 10 minutes, single use.');
    } catch (error) { say(failure(error), true); }
    finally { setBusy(false); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(code); setCopyLabel('Copied'); }
    catch {
      const range = document.createRange();
      range.selectNodeContents(codeNode.current);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      setCopyLabel('Press and hold to copy');
    }
  };
  return (
    <Section id="remote" title="Let other clients connect to this one" level={4}>
      <Hint>{t('Another client can add this one as a remote engine and reach its tasks, files and terminals: there, choose Devices → Advanced → “Connect remote service” and enter this address and a pairing code (valid for 10 minutes, single use).')}</Hint>
      <Hint>{t('Connect address:')} <code id="h5-remote-origin">{location.origin}</code></Hint>
      <Box id="h5-token-list" className="h5-token-list" sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        {tokens.length ? tokens.map(token => (
          <Paper key={token.id} variant="outlined" className="h5-token-row" sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, p: 1 }}>
            <Box sx={{ minWidth: 0 }}>
              <Box component="strong" sx={{ fontSize: '0.875rem', fontWeight: 600, overflowWrap: 'anywhere' }}>{token.name}</Box>
              <Typography variant="caption" component="small" color="text.secondary" sx={{ display: 'block', overflowWrap: 'anywhere' }}>{`${token.token_prefix}… · ${token.scopes}`}</Typography>
            </Box>
            <Button size="small" onClick={() => void revoke(token)}>{t('Revoke')}</Button>
          </Paper>
        )) : <Hint>{t('No tokens created yet')}</Hint>}
      </Box>
      <Button id="h5-token-create" variant="outlined" disabled={busy} onClick={() => void create()}>{t('Generate pairing code')}</Button>
      {code ? (
        <Paper id="h5-token-created" variant="outlined" className="h5-token-created" sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, p: 1 }}>
          <code id="h5-token-code" ref={codeNode} style={{ fontSize: 18, letterSpacing: 1, overflowWrap: 'anywhere', userSelect: 'all' }}>{code}</code>
          <Button id="h5-token-copy" size="small" variant="outlined" onClick={() => void copy()}>{t(copyLabel)}</Button>
        </Paper>
      ) : <span id="h5-token-created" hidden />}
      <Feedback id="h5-remote-feedback" feedback={feedback} />
    </Section>
  );
}
