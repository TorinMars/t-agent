import { useEffect, useSyncExternalStore } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import { api, t } from './common.jsx';
import { Hint, Section } from './Form.jsx';
import { deviceTargets } from './DeviceTarget.jsx';
import { columnNote, compareTools, deviceState, missingHints, orderColumns, summaryText } from './environment-compare.mjs';

// Settings → Devices → Environment ("Environment" in docs/design/environment-compare.md): the tools agent sessions rely on, a row per tool and a
// column per machine (this one and every linked device, by name), from each machine's own environment check: GET /api/environment/tools here and
// /api/device-settings/<id>/environment/tools for a linked device (POST to probe again, "Check again"). A version that is not the newest is orange, a
// missing tool red with the install hint of the check under the table. A linked device that is offline or too old says so in its column's header.
// The Devices row of the group list shows the same summary ("2 differences · 1 missing", `useEnvironmentSummary`): the lists are read when the
// sheet opens while a device is linked (each machine keeps its answer for ten minutes, so this is cheap) and again when the group opens after a minute.
const FRESH_MS = 60_000;
let snapshot = { columns: [], busy: false, at: 0 };
let run = 0;
const listeners = new Set();
const emit = next => { snapshot = next; for (const listener of listeners) listener(); };
const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };

// What a failed read of a linked device's list means for its column.
function failedState(error) {
  const code = error && error.message;
  if (code === 'DEVICE_SETTINGS_UNSUPPORTED' || code === 'DEVICE_SETTING_NOT_ALLOWED' || (error && error.status === 501)) return 'update';
  if (['REMOTE_OFFLINE', 'REMOTE_TIMEOUT', 'ENGINE_OFFLINE'].includes(code)) return 'offline';
  return 'failed';
}

// Reads every machine's list. `localName`: this machine's engine name; `fresh`: probe again; `maxAge`: skip while the last read is newer than this;
// `linkedOnly`: read nothing without a linked device (the sheet opening: one machine has nothing to compare, and no group has been opened).
export function refreshEnvironment({ localName = '', fresh = false, maxAge = 0, linkedOnly = false } = {}) {
  if (!fresh && maxAge && snapshot.at && Date.now() - snapshot.at < maxAge) return Promise.resolve();
  const devices = deviceTargets().devices || [];
  if (linkedOnly && !devices.length) return Promise.resolve();
  const mine = ++run;
  const previous = new Map(snapshot.columns.map(column => [column.key, column]));
  const keep = (key, state) => {
    const before = previous.get(key);
    return before && before.state === 'ready' && !state ? { state: 'ready', report: before.report } : { state: state || 'loading', report: null };
  };
  const columns = orderColumns([
    { key: 'local', name: localName || t('This device'), url: '/api/environment/tools', ...keep('local', '') },
    ...devices.map(device => {
      const state = deviceState(device);
      return { key: `remote:${device.id}`, name: device.name, url: `/api/device-settings/${device.id}/environment/tools`, ...keep(`remote:${device.id}`, state) };
    }),
  ]);
  emit({ columns, busy: true, at: Date.now() });
  const update = (key, change) => {
    if (mine !== run) return;
    emit({ ...snapshot, columns: snapshot.columns.map(column => (column.key === key ? { ...column, ...change } : column)) });
  };
  const reads = columns.filter(column => column.state === 'ready' || column.state === 'loading').map(column => api(fresh ? 'POST' : 'GET', column.url, fresh ? {} : undefined)
    .then(report => update(column.key, { state: 'ready', report }))
    .catch(error => update(column.key, { state: column.key === 'local' ? 'failed' : failedState(error), report: null })));
  return Promise.all(reads).then(() => { if (mine === run) emit({ ...snapshot, busy: false, at: Date.now() }); });
}

const read = () => snapshot;
const useEnvironment = () => useSyncExternalStore(subscribe, read);
// The summary of the Devices row in the group list: '' while nothing differs or nothing was read.
export function useEnvironmentSummary() {
  const { columns } = useEnvironment();
  return summaryText(compareTools(columns), t);
}

const TONE = { diff: 'warning.main', missing: 'error.main', na: 'text.disabled', unknown: 'text.secondary', none: 'text.disabled', same: 'text.primary' };
// The first column stays in place while a narrow screen scrolls the table sideways; it takes the card's colour (its elevation overlay too).
const STICKY = { position: 'sticky', left: 0, zIndex: 1, bgcolor: 'background.paper', backgroundImage: 'var(--Paper-overlay)' };

export function EnvironmentSection({ opened, localName }) {
  const { columns, busy } = useEnvironment();
  useEffect(() => { if (opened) void refreshEnvironment({ localName, maxAge: FRESH_MS }); }, [opened]); // eslint-disable-line react-hooks/exhaustive-deps -- each opening of the group
  const { rows, differences, missing, ready } = compareTools(columns);
  const summary = summaryText({ differences, missing }, t);
  const hints = missingHints(columns, rows);
  return (
    <Section id="environment" title="Environment">
      <Hint>{t('What agent sessions find on each machine. Differences are marked.')}</Hint>
      {rows.length ? (
        <TableContainer id="h5-env-table-wrap" sx={{ overflowX: 'auto', mx: -2, px: 2, width: 'auto' }}>
          <Table id="h5-env-table" size="small" aria-labelledby="h5-sec-environment-title" sx={{ minWidth: 100 + columns.length * 100, '& td, & th': { borderColor: 'divider', px: 1.5 } }}>
            <TableHead>
              <TableRow>
                <TableCell component="th" scope="col" sx={{ ...STICKY, zIndex: 2, color: 'text.secondary', fontWeight: 500, width: 132 }}>{t('Tool')}</TableCell>
                {columns.map(column => (
                  <TableCell key={column.key} component="th" scope="col" className="h5-env-machine" data-machine={column.key} sx={{ color: 'text.secondary', fontWeight: 500, verticalAlign: 'bottom' }}>
                    <Box component="span" translate="no" sx={{ display: 'block', overflowWrap: 'anywhere' }}>{column.name}</Box>
                    {columnNote(column) ? <Typography component="span" variant="caption" className="h5-env-note" color={column.state === 'update' || column.state === 'failed' ? 'warning.main' : 'text.secondary'} sx={{ display: 'block' }}>{t(columnNote(column))}</Typography> : null}
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map(row => (
                <TableRow key={row.id} className="h5-env-row" data-tool={row.id}>
                  <TableCell component="th" scope="row" sx={{ ...STICKY, color: 'text.primary' }}>{t(row.name)}</TableCell>
                  {row.cells.map((cell, index) => (
                    <TableCell key={columns[index].key} className="h5-env-cell" data-tone={cell.tone} sx={{ color: TONE[cell.tone], fontWeight: cell.tone === 'diff' || cell.tone === 'missing' ? 500 : 400, whiteSpace: 'nowrap' }}>
                      <span translate={cell.tone === 'same' || cell.tone === 'diff' ? 'no' : undefined}>{cell.tone === 'same' || cell.tone === 'diff' ? cell.text : t(cell.text)}</span>
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      ) : (
        <Hint id="h5-env-empty">{busy ? t('Checking…') : t('The tools could not be read.')}</Hint>
      )}
      {hints.length ? (
        <Box component="ul" id="h5-env-hints" sx={{ m: 0, pl: 2.5, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
          {hints.map(hint => (
            <Typography component="li" variant="body2" color="text.secondary" key={hint.key} className="h5-env-hint" sx={{ overflowWrap: 'anywhere' }}>
              <Box component="span" translate="no">{hint.machine}</Box>{' · '}{t(hint.tool)}{': '}{t(hint.fix)}
            </Typography>
          ))}
        </Box>
      ) : null}
      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 3, rowGap: 0.5 }}>
        <Typography id="h5-env-summary" variant="body2" color="text.secondary" role="status">
          {summary || (ready > 1 && !busy ? t('The same on every machine') : '')}
        </Typography>
        <Button id="h5-env-check" disabled={busy} onClick={() => void refreshEnvironment({ localName, fresh: true })}>{busy ? t('Checking…') : t('Check again')}</Button>
      </Box>
    </Section>
  );
}
