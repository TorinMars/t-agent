import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import Paper from '@mui/material/Paper';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Typography from '@mui/material/Typography';
import TextField from './TextField.jsx';
import { Pill, api, t } from './common.jsx';
import { useDeviceTarget } from './DeviceTarget.jsx';
import { Feedback, Hint, Section, failure, useFeedback } from './Form.jsx';
import { ScopeLabel } from './ScopeLabel.jsx';
import { SharedClaudeSettings } from './SharedClaudeSettings.jsx';

// "Rules and skills sync", a part of Settings → Devices (GET / PUT /api/rule-sync and its actions, routes/rule-sync.js): one linked service is the source of a shared layer of
// Claude rules, chosen skills and the same rules for Codex; services that receive only take it and never send anything. The shared rules can be edited
// here on every service (GET / PUT /api/rule-sync/shared): the text is always saved on the source. A receiver shows the local edits its guard replaced.
// See "Rules and skills sync" in DESIGN.md.

const BASE = '/api/rule-sync';
const ROLES = [
  ['off', 'Off'],
  ['source', 'Source: share my rules and skills'],
  ['receive', 'Receive only: never sends anything'],
];
const STATUS = {
  'up-to-date': ['Up to date', 'success'],
  'not-receiving': ['Not receiving', 'default'],
  unsupported: ['Too old for sync', 'warning'],
  'other-source': ['Follows another source', 'warning'],
  offline: ['Offline', 'error'],
  error: ['Failed', 'error'],
  unknown: ['Not checked yet', 'default'],
};
const ERRORS = {
  RULE_SYNC_NOT_SOURCE: 'Only a source can sync',
  RULE_SYNC_NOT_RECEIVING: 'That service does not receive',
  RULE_SYNC_OTHER_SOURCE: 'It follows another source; reset it on that service first',
  RULE_SYNC_TOO_LARGE: 'The shared layer is over a size limit',
  RULE_SYNC_INVALID_SETTINGS: 'Invalid settings',
  RULE_SYNC_INVALID_BUNDLE: 'The other service refused the data',
  RULE_SYNC_FILE_UNSAFE: 'A file is a link that points nowhere; fix it first',
  REMOTE_TIMEOUT: 'Timed out',
  LINK_OFFLINE: 'Offline',
  REMOTE_CONNECTION_FAILED: 'Could not connect',
  RULE_SYNC_NO_SOURCE: 'No linked service is the source yet',
  RULE_SYNC_SEVERAL_SOURCES: 'Several linked services are set as the source',
  RULE_SYNC_EDIT_UNSUPPORTED: 'The source is too old to edit from here; update it first',
  RULE_SYNC_INVALID_CONTENT: 'The text cannot be saved',
  RULE_SYNC_SHARED_CHANGED: 'The shared rules were changed meanwhile',
  ENGINE_OFFLINE: 'The source cannot be reached',
  ENGINE_UNAUTHORIZED: 'The source did not accept the token of this service',
};
const LIMITS = {
  file: 'A file is over 1 MiB',
  files: 'A skill has over 200 files',
  skills: 'More than 100 skills are chosen',
  total: 'Over 20 MiB in total',
};
const CONFLICTS = {
  local: 'a local skill has this name',
  symlink: 'a link has this name',
  'not-a-directory': 'a file has this name',
};
const WARNINGS = { symlink: 'a link, not sent', missing: 'not found', skipped: 'not a regular file, not sent' };

const codeText = code => (ERRORS[code] ? t(ERRORS[code]) : code || '');
const short = revision => (revision ? revision.slice(0, 8) : '');
const when = value => (value ? new Date(value).toLocaleString() : '');
const conflictText = item => `${item.skill}: ${t(CONFLICTS[item.reason] || item.reason)}`;
const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13, overflowWrap: 'anywhere' };
// The text of a failed request about the shared rules: the known code, with the names the server sent.
function sharedError(error) {
  const data = error.data || {};
  if (error.message === 'RULE_SYNC_TOO_LARGE') return t('The text is over 1 MiB');
  const known = ERRORS[error.message];
  if (!known) return failure(error);
  if (Array.isArray(data.sources) && data.sources.length) return `${t(known)}: ${data.sources.join(', ')}`;
  if (data.source && data.source.name && error.message !== 'RULE_SYNC_NO_SOURCE') return `${t(known)}: ${data.source.name}`;
  return t(known);
}

function Heading({ children }) {
  return <Typography variant="subtitle2" component="strong" className="h5-setting-minor" sx={{ mt: 1, fontWeight: 600 }}>{children}</Typography>;
}

function Targets({ targets, revision }) {
  if (!targets.length) return <Hint id="h5-rule-sync-no-targets">{t('No linked devices yet. Link one under “Link a device” above.')}</Hint>;
  return (
    <Box id="h5-rule-sync-targets" sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      {targets.map(target => {
        const [label, tone] = STATUS[target.status] || STATUS.unknown;
        // An older receiver gets the bundle without the shared Claude settings, so its revision is `expected_revision`.
        const expected = target.expected_revision || revision;
        const behind = target.status === 'up-to-date' && expected && target.revision !== expected;
        return (
          <Paper key={target.id} variant="outlined" className="h5-rule-sync-target" data-target={target.id} sx={{ p: 1.25, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, minWidth: 0 }}>
              <Typography variant="body2" component="span" translate="no" sx={{ fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={target.name}>{target.name}</Typography>
              <Pill className="h5-rule-sync-status" tone={behind ? 'warning' : tone} label={t(behind ? 'Behind' : label)} />
            </Box>
            {target.revision ? <Hint>{`${t('Revision')} ${short(target.revision)}${target.last_push_at ? ` · ${when(target.last_push_at)}` : ''}`}</Hint> : null}
            {target.last_error ? <Typography variant="body2" color="error" className="h5-rule-sync-error" sx={{ overflowWrap: 'anywhere' }}>{codeText(target.last_error)}</Typography> : null}
            {target.claude_settings_supported === false ? <Typography variant="body2" color="text.secondary" className="h5-rule-sync-no-settings" sx={{ overflowWrap: 'anywhere' }}>{t('Gets the rules and skills only; update T-Agent there to share Claude settings.')}</Typography> : null}
            {(target.conflicts || []).length ? (
              <Typography variant="body2" color="warning.main" className="h5-rule-sync-conflicts" sx={{ overflowWrap: 'anywhere' }}>
                {`${t('Not synced')}: ${target.conflicts.map(conflictText).join('; ')}`}
              </Typography>
            ) : null}
          </Paper>
        );
      })}
    </Box>
  );
}

function SourcePart({ data, busy, save, act }) {
  const chosen = data.skills.filter(skill => skill.shared).map(skill => skill.name);
  const toggle = (name, on) => save({ skills: on ? [...chosen, name] : chosen.filter(item => item !== name) });
  return (
    <>
      <Heading>{t('Shared rules file')}</Heading>
      <Typography id="h5-rule-sync-path" component="code" translate="no" sx={mono}>{data.shared_rules_path}</Typography>
      {data.shared_rules_exists
        ? <Hint>{t('Edit it with Edit shared rules, or edit the file on this machine. Changes are sent to the receivers within a few seconds.')}</Hint>
        : (
          <>
            <Hint id="h5-rule-sync-missing">{t('The file does not exist yet.')}</Hint>
            <Button id="h5-rule-sync-create" variant="outlined" disabled={busy} onClick={() => void act('create-shared', 'Created')}>{t('Create it')}</Button>
          </>
        )}
      <Heading>{t('Shared skills')}</Heading>
      {data.skills.length ? (
        <Box id="h5-rule-sync-skills" sx={{ display: 'flex', flexDirection: 'column' }}>
          {data.skills.map(skill => {
            const note = skill.symlink ? 'a link, cannot be shared' : skill.missing ? 'not found' : skill.synced ? 'received from a source' : '';
            return (
              <FormControlLabel
                key={skill.name} className="h5-rule-sync-skill" data-skill={skill.name} sx={{ minHeight: 44, mr: 0, '& .MuiFormControlLabel-label': { minWidth: 0, overflowWrap: 'anywhere' } }}
                control={<Checkbox checked={skill.shared} disabled={busy || (skill.symlink && !skill.shared)} onChange={event => void toggle(skill.name, event.target.checked)} slotProps={{ input: { id: `h5-rule-sync-skill-${skill.name}` } }} />}
                label={<span><span translate="no">{skill.name}</span>{note ? <Typography component="span" variant="body2" color="text.secondary">{` (${t(note)})`}</Typography> : null}</span>}
              />
            );
          })}
        </Box>
      ) : <Hint id="h5-rule-sync-no-skills">{t('No skills on this machine yet.')}</Hint>}
      <SharedClaudeSettings data={data} busy={busy} save={save} />
      {data.bundle_error ? (
        <Typography id="h5-rule-sync-bundle-error" variant="body2" color="error" sx={{ overflowWrap: 'anywhere' }}>
          {`${t(LIMITS[data.bundle_error.limit] || codeText(data.bundle_error.code))}${data.bundle_error.item ? `: ${data.bundle_error.item}` : ''}. ${t('Nothing is sent until it is fixed.')}`}
        </Typography>
      ) : null}
      {data.warnings.length ? (
        <Hint id="h5-rule-sync-warnings">{`${t('Skipped')}: ${data.warnings.map(item => `${item.skill}${item.path ? `/${item.path}` : ''} (${t(WARNINGS[item.warning] || item.warning)})`).join('; ')}`}</Hint>
      ) : null}
      <Heading>{t('Receivers')}</Heading>
      <Targets targets={data.targets} revision={data.revision} />
      {data.revision ? <Hint id="h5-rule-sync-revision">{`${t('Current revision')} ${short(data.revision)}${data.last_change_at ? ` · ${t('changed')} ${when(data.last_change_at)}` : ''}`}</Hint> : null}
      <Button id="h5-rule-sync-push" variant="contained" disabled={busy} onClick={() => void act('push', 'Sync finished')}>{t('Sync now')}</Button>
    </>
  );
}

function ReceivePart({ data, busy, save, act }) {
  const conflicts = (data.received && data.received.conflicts) || [];
  return (
    <>
      <Heading>{t('Source')}</Heading>
      {data.following ? (
        <>
          <Hint id="h5-rule-sync-following">{t(`Follows ${data.following.name || data.following.instance_id}`)}</Hint>
          {data.received && data.received.synced_at ? <Hint>{`${t('Last synced')} ${when(data.received.synced_at)} · ${t('Revision')} ${short(data.received.revision)}`}</Hint> : null}
          <Hint>{t('Bundles from any other source are refused until you reset this.')}</Hint>
          <Button id="h5-rule-sync-reset" variant="outlined" disabled={busy} onClick={() => void act('reset-source', 'The next source that sends is followed')}>{t('Reset the source')}</Button>
        </>
      ) : <Hint id="h5-rule-sync-following">{t('No source yet. The first source that sends is followed.')}</Hint>}
      {conflicts.length ? (
        <Box id="h5-rule-sync-conflicts">
          <Heading>{t('Not synced')}</Heading>
          {conflicts.map(item => <Hint key={item.skill}>{conflictText(item)}</Hint>)}
          <Hint>{t('Your own skills are never overwritten. Rename one of them to sync it.')}</Hint>
        </Box>
      ) : null}
      <SharedClaudeSettings data={data} busy={busy} save={save} />
    </>
  );
}

// The editor of the shared rules: full screen on a phone, a large dialog on a wide screen. Saves to the source with the revision the text was loaded at;
// when the file changed meanwhile (409) the person chooses to load the latest text or to overwrite it. Ctrl+S / Cmd+S saves.
function SharedRulesDialog({ open, wide, onClose, onSaved, call = api }) {
  const [loaded, setLoaded] = useState(null); // the last text read from or saved on the source: { content, content_revision, source }
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(null); // the source's current { content, content_revision } after a 409
  const [asking, setAsking] = useState(false); // the unsaved-changes question
  const [feedback, say] = useFeedback();
  const dirty = Boolean(loaded) && text !== loaded.content;
  const name = loaded && loaded.source ? loaded.source.name : '';

  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    setLoaded(null); setText(''); setConflict(null); setAsking(false); say('');
    setBusy(true);
    call('GET', `${BASE}/shared`)
      .then(data => { if (live) { setLoaded(data); setText(data.content); } })
      .catch(error => { if (live) say(sharedError(error), true); })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [open]);

  const save = async base => {
    if (busy || !loaded) return;
    setBusy(true);
    const content = text;
    try {
      const answer = await call('PUT', `${BASE}/shared`, { content, base_revision: base || loaded.content_revision });
      setLoaded(current => ({ ...current, content, content_revision: answer.content_revision, source: answer.source || current.source }));
      setConflict(null);
      say('Saved. The receivers get it automatically within a few seconds. Running Claude and Codex sessions read it after a restart.');
      if (onSaved) onSaved();
    } catch (error) {
      if (error.message === 'RULE_SYNC_SHARED_CHANGED' && error.data && error.data.current) { setConflict(error.data.current); say(''); }
      else say(`${t('Not saved')}: ${sharedError(error)}`, true);
    } finally { setBusy(false); }
  };
  const loadLatest = () => {
    setLoaded(current => ({ ...current, content: conflict.content, content_revision: conflict.content_revision }));
    setText(conflict.content);
    setConflict(null);
    say('The latest version is loaded');
  };
  const requestClose = () => { if (busy) return; if (dirty) setAsking(true); else onClose(); };
  const onKeyDown = event => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && (event.key === 's' || event.key === 'S')) {
      event.preventDefault();
      if (dirty && !conflict) void save();
    }
  };

  return (
    <>
      <Dialog id="h5-rule-sync-editor" open={open} onClose={requestClose} onKeyDown={onKeyDown} fullScreen={!wide} fullWidth maxWidth="md" aria-labelledby="h5-rule-sync-editor-title">
        <DialogTitle id="h5-rule-sync-editor-title" sx={{ pb: 0.5 }}>{t('Edit shared rules')}</DialogTitle>
        <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
          {loaded ? <Hint id="h5-rule-sync-editor-target">{`${t(`Saved on ${name || t('this service')}`)}${loaded.source && loaded.source.local && name ? ` (${t('this service')})` : ''}`}</Hint> : null}
          {loaded ? (
            <TextField
              id="h5-rule-sync-editor-text" fullWidth multiline minRows={wide ? 20 : 14} value={text} onChange={event => setText(event.target.value)}
              sx={{ '& textarea': { ...mono, lineHeight: 1.5 } }}
              slotProps={{ htmlInput: { 'aria-label': t('Shared rules'), spellCheck: false, autoCapitalize: 'off', autoCorrect: 'off', autoComplete: 'off' } }}
            />
          ) : (busy ? <Hint>{t('Loading')}</Hint> : null)}
          {conflict ? (
            <Paper id="h5-rule-sync-conflict" variant="outlined" sx={{ p: 1.25, display: 'flex', flexDirection: 'column', gap: 1, borderColor: 'warning.main' }}>
              <Typography variant="body2" color="warning.main" sx={{ overflowWrap: 'anywhere' }}>{t(`The shared rules were changed on ${name} while you edited them.`)}</Typography>
              <Hint>{t('Load the latest replaces your text. Overwrite saves your text over the other change.')}</Hint>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                <Button id="h5-rule-sync-load-latest" variant="outlined" disabled={busy} onClick={loadLatest}>{t('Load the latest')}</Button>
                <Button id="h5-rule-sync-overwrite" variant="outlined" color="warning" disabled={busy} onClick={() => void save(conflict.content_revision)}>{t('Overwrite')}</Button>
              </Box>
            </Paper>
          ) : null}
          <Feedback id="h5-rule-sync-editor-feedback" feedback={feedback} />
        </DialogContent>
        <DialogActions sx={{ flexWrap: 'wrap', gap: 0.5 }}>
          <Button id="h5-rule-sync-editor-cancel" disabled={busy} onClick={requestClose}>{t(dirty ? 'Cancel' : 'Close')}</Button>
          <Button id="h5-rule-sync-editor-save" variant="contained" disabled={busy || !dirty || Boolean(conflict)} onClick={() => void save()}>{t('Save')}</Button>
        </DialogActions>
      </Dialog>
      <Dialog id="h5-rule-sync-discard" open={asking} onClose={() => setAsking(false)} aria-labelledby="h5-rule-sync-discard-title">
        <DialogTitle id="h5-rule-sync-discard-title">{t('Discard your changes?')}</DialogTitle>
        <DialogContent><Hint>{t('Your changes to the shared rules are not saved.')}</Hint></DialogContent>
        <DialogActions sx={{ flexWrap: 'wrap', gap: 0.5 }}>
          <Button id="h5-rule-sync-keep-editing" onClick={() => setAsking(false)}>{t('Keep editing')}</Button>
          <Button id="h5-rule-sync-discard-confirm" color="error" onClick={() => { setAsking(false); onClose(); }}>{t('Discard')}</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

// Where the shared rules are edited, on every role: the source that was found, or why there is none.
function SharedRules({ shared, busy, onEdit }) {
  return (
    <>
      <Heading>{t('Shared rules')}</Heading>
      {!shared ? <Hint id="h5-rule-sync-shared-state">{t('Looking for the source')}</Hint> : shared.error ? (
        <Hint id="h5-rule-sync-shared-state">{shared.error}</Hint>
      ) : (
        <>
          <Hint id="h5-rule-sync-shared-state">{shared.source.local ? t('This service is the source. The text is saved here.') : t(`The text is saved on ${shared.source.name}, the source.`)}</Hint>
          <Button id="h5-rule-sync-edit" variant="outlined" disabled={busy} onClick={onEdit}>{t('Edit shared rules')}</Button>
        </>
      )}
    </>
  );
}

// The local edits of synced files that this receiver saved and replaced (newest first), with a dismiss.
function LocalChanges({ changes, busy, act }) {
  if (!changes || !changes.length) return null;
  const shown = changes.slice(0, 5);
  return (
    <Paper id="h5-rule-sync-local-changes" variant="outlined" sx={{ p: 1.25, display: 'flex', flexDirection: 'column', gap: 1, borderColor: 'warning.main' }}>
      {shown.map(entry => (
        <Box key={`${entry.at}-${entry.backup_dir || ''}`} className="h5-rule-sync-local-change" sx={{ display: 'flex', flexDirection: 'column', gap: 0.25, minWidth: 0 }}>
          <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>{t(`Local changes in ${entry.paths.join(', ')} were replaced with the version from ${entry.source || t('the source')}.`)}</Typography>
          {entry.backup_dir ? <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>{t(`Your edited copy was saved to ${entry.backup_dir}.`)}</Typography> : null}
          <Hint>{when(entry.at)}</Hint>
        </Box>
      ))}
      {changes.length > shown.length ? <Hint>{t(`${changes.length - shown.length} more`)}</Hint> : null}
      <Button id="h5-rule-sync-dismiss" variant="outlined" disabled={busy} onClick={() => void act('dismiss-local-changes', '')}>{t('Dismiss')}</Button>
    </Paper>
  );
}

// `opened` goes up each time the Devices group opens: the settings are read again then. The settings are those of the device chosen in
// "Settings for" (DeviceTarget.jsx): this one, or a linked one through the link.
export function RuleSyncSection(props) {
  const device = useDeviceTarget();
  return <RuleSyncPart key={device.key} {...props} call={device.api} />;
}
function RuleSyncPart({ state, opened, call }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [shared, setShared] = useState(null); // where the shared rules are saved: { source } or { error }; null while it is looked up
  const [editing, setEditing] = useState(false);
  const [feedback, say] = useFeedback();
  const findSource = async () => {
    setShared(null);
    try { setShared({ source: (await call('GET', `${BASE}/shared`)).source }); }
    catch (error) { setShared({ error: error.status === 404 && !ERRORS[error.message] ? t('This service does not support it') : sharedError(error) }); }
  };
  const load = async () => {
    try { setData(await call('GET', BASE)); say(''); void findSource(); }
    catch (error) { say(error.status === 404 ? 'This service does not support it' : failure(error), true); }
  };
  const run = async (work, done, after) => {
    setBusy(true);
    try { setData(await work()); say(done || ''); if (after) after(); }
    catch (error) {
      const known = ERRORS[error.message];
      say(known ? `${t('Failed')}: ${t(known)}` : failure(error), true);
    } finally { setBusy(false); }
  };
  // A new role can change where the source is.
  const save = changes => run(() => call('PUT', BASE, changes), 'Saved', changes.role ? () => void findSource() : null);
  const act = (action, done) => run(() => call('POST', `${BASE}/${action}`, {}), done, action === 'reset-source' ? () => void findSource() : null);
  useEffect(() => { if (opened) void load(); }, [opened]); // eslint-disable-line react-hooks/exhaustive-deps -- load only reads
  return (
    <Section id="rule-sync" title="Rules and skills sync" aside={<ScopeLabel id="rule-sync" />}>
      <Hint>{t('Share one set of Claude rules and skills (and the rules for Codex) from one linked service to the others. Your own CLAUDE.md content and unmarked skills are never sent or changed.')}</Hint>
      {data ? (
        <>
          <RadioGroup id="h5-rule-sync-role" value={data.role} onChange={event => void save({ role: event.target.value })} aria-label={t('Role')}>
            {ROLES.map(([value, label]) => (
              <FormControlLabel key={value} value={value} disabled={busy} sx={{ minHeight: 44, mr: 0 }} control={<Radio slotProps={{ input: { id: `h5-rule-sync-role-${value}` } }} />} label={t(label)} />
            ))}
          </RadioGroup>
          <FormControlLabel
            sx={{ minHeight: 44, mr: 0 }}
            control={<Checkbox checked={data.codex} disabled={busy} onChange={event => void save({ codex: event.target.checked })} slotProps={{ input: { id: 'h5-rule-sync-codex' } }} />}
            label={t('Also put the shared rules into Codex (AGENTS.md)')}
          />
          <LocalChanges changes={data.local_changes} busy={busy} act={act} />
          <SharedRules shared={shared} busy={busy} onEdit={() => setEditing(true)} />
          {data.role !== 'off' ? <Hint id="h5-rule-sync-import">{`${t('Claude reads the shared rules through this line at the top of')} ${data.claude_md_path}: ${data.import_line}`}</Hint> : null}
          {data.role === 'source' ? <SourcePart data={data} busy={busy} save={save} act={act} /> : null}
          {data.role === 'receive' ? <ReceivePart data={data} busy={busy} save={save} act={act} /> : null}
          {data.role === 'off' && (data.import_line_present || data.codex_block_present) ? (
            <>
              <Hint id="h5-rule-sync-leftover">{t('The import line (and the managed block in Codex AGENTS.md) are still there. The shared files and synced skills stay until you delete them.')}</Hint>
              <Button id="h5-rule-sync-remove-import" variant="outlined" disabled={busy} onClick={() => void act('remove-import', 'Removed')}>{t('Remove the import line')}</Button>
            </>
          ) : null}
          {data.local_error ? <Typography variant="body2" color="error">{codeText(data.local_error)}</Typography> : null}
          <Hint>{t('Running Claude and Codex sessions read the new rules when they start again.')}</Hint>
        </>
      ) : null}
      <Feedback id="h5-rule-sync-feedback" feedback={feedback} />
      <SharedRulesDialog open={editing} wide={Boolean(state && state.wide)} onClose={() => setEditing(false)} onSaved={() => { if (data && data.role === 'source') void load(); }} call={call} />
    </Section>
  );
}
