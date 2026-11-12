import { useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import Paper from '@mui/material/Paper';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Typography from '@mui/material/Typography';
import { Pill, api, t } from './common.jsx';
import { Feedback, Group, Hint, failure, useFeedback } from './Form.jsx';

// Settings "Rules and skills sync" (GET / PUT /api/rule-sync and its actions, routes/rule-sync.js): one linked service is the source of a shared layer of
// Claude rules, chosen skills and the same rules for Codex; services that receive only take it and never send anything. See "Rules and skills sync" in
// DESIGN.md.

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

function Heading({ children }) {
  return <Typography variant="subtitle2" component="strong" sx={{ mt: 0.5 }}>{children}</Typography>;
}

function Targets({ targets, revision }) {
  if (!targets.length) return <Hint id="h5-rule-sync-no-targets">{t('No linked services yet. Link one under Linked services.')}</Hint>;
  return (
    <Box id="h5-rule-sync-targets" sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      {targets.map(target => {
        const [label, tone] = STATUS[target.status] || STATUS.unknown;
        const behind = target.status === 'up-to-date' && revision && target.revision !== revision;
        return (
          <Paper key={target.id} variant="outlined" className="h5-rule-sync-target" data-target={target.id} sx={{ p: 1.25, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, minWidth: 0 }}>
              <Typography variant="body2" component="span" translate="no" sx={{ fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={target.name}>{target.name}</Typography>
              <Pill className="h5-rule-sync-status" tone={behind ? 'warning' : tone} label={t(behind ? 'Behind' : label)} />
            </Box>
            {target.revision ? <Hint>{`${t('Revision')} ${short(target.revision)}${target.last_push_at ? ` · ${when(target.last_push_at)}` : ''}`}</Hint> : null}
            {target.last_error ? <Typography variant="body2" color="error" className="h5-rule-sync-error" sx={{ overflowWrap: 'anywhere' }}>{codeText(target.last_error)}</Typography> : null}
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
        ? <Hint>{t('Edit this file on this machine. Changes are sent to the receivers within a few seconds.')}</Hint>
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

function ReceivePart({ data, busy, act }) {
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
    </>
  );
}

export function RuleSyncGroup() {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [feedback, say] = useFeedback();
  const load = async () => {
    try { setData(await api('GET', BASE)); say(''); }
    catch (error) { say(error.status === 404 ? 'This service does not support it' : failure(error), true); }
  };
  const run = async (work, done) => {
    setBusy(true);
    try { setData(await work()); say(done || ''); }
    catch (error) {
      const known = ERRORS[error.message];
      say(known ? `${t('Failed')}: ${t(known)}` : failure(error), true);
    } finally { setBusy(false); }
  };
  const save = changes => run(() => api('PUT', BASE, changes), 'Saved');
  const act = (action, done) => run(() => api('POST', `${BASE}/${action}`, {}), done);
  return (
    <Group id="rule-sync" title="Rules and skills sync" onOpen={load}>
      <Hint>{t('Share one set of Claude rules and skills (and the same rules for Codex) from one linked service to the others. Your own CLAUDE.md content and skills without the sync marker are never sent or changed.')}</Hint>
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
          {data.role !== 'off' ? <Hint id="h5-rule-sync-import">{`${t('Claude reads the shared rules through this line at the top of')} ${data.claude_md_path}: ${data.import_line}`}</Hint> : null}
          {data.role === 'source' ? <SourcePart data={data} busy={busy} save={save} act={act} /> : null}
          {data.role === 'receive' ? <ReceivePart data={data} busy={busy} act={act} /> : null}
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
    </Group>
  );
}
