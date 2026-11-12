import Box from '@mui/material/Box';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import Typography from '@mui/material/Typography';
import { t } from './common.jsx';
import { Hint } from './Form.jsx';

// The "Claude settings" part of Settings > Rules and skills sync (rendered from RuleSync.jsx; `claude_settings` of GET /api/rule-sync). On the source:
// a checkbox per allowlisted key of its settings.json (PUT `claude_settings_keys`) and the status line scripts that go with them. On a receiver: the
// received keys, each with "Keep this device's own value" (PUT `keep_local`). The values are injected into the Claude sessions T-Agent starts on the
// receivers; no settings.json is written. See "Shared Claude settings (injected at session start)" in DESIGN.md.

const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13, overflowWrap: 'anywhere' };
const WARNINGS = {
  symlink: 'a link, not sent',
  missing: 'not found',
  skipped: 'not a regular file, not sent',
  name: 'the name has unusual characters, not sent',
  duplicate: 'another script has this name, not sent',
  'too-large': 'over 256 KiB, not sent',
  'too-many': 'more than 5 scripts, not sent',
};
const SETTINGS_ERRORS = {
  'invalid-json': 'settings.json is not valid JSON, so nothing is shared',
  'not-an-object': 'settings.json is not a JSON object, so nothing is shared',
  unreadable: 'settings.json cannot be read, so nothing is shared',
};

function Heading({ children }) {
  return <Typography variant="subtitle2" component="strong" sx={{ mt: 0.5 }}>{children}</Typography>;
}

// One key with its value in short: the key name in monospace, the preview below it.
function KeyLabel({ item }) {
  return (
    <Box component="span" sx={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <Typography component="span" variant="body2" translate="no" sx={{ ...mono, fontWeight: 600 }}>{item.key}</Typography>
      <Typography component="span" variant="body2" color="text.secondary" translate="no" className="h5-claude-settings-preview" sx={{ ...mono, fontSize: 12 }}>{item.preview}</Typography>
    </Box>
  );
}
const rowSx = { minHeight: 44, mr: 0, alignItems: 'flex-start', '& .MuiFormControlLabel-label': { minWidth: 0, pt: 1.1 } };

function SourceSettings({ view, busy, save }) {
  const toggle = (key, on) => save({ claude_settings_keys: on ? [...view.shared_keys, key] : view.shared_keys.filter(item => item !== key) });
  return (
    <Box id="h5-claude-settings" sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, minWidth: 0 }}>
      <Heading>{t('Claude settings')}</Heading>
      <Hint>{t('Applied to Claude sessions started by T-Agent on receiving devices; their own settings.json is not changed.')}</Hint>
      {view.settings_error ? <Typography id="h5-claude-settings-error" variant="body2" color="error" sx={{ overflowWrap: 'anywhere' }}>{t(SETTINGS_ERRORS[view.settings_error] || view.settings_error)}</Typography> : null}
      {view.available.length ? (
        <Box id="h5-claude-settings-keys" sx={{ display: 'flex', flexDirection: 'column' }}>
          {view.available.map(item => (
            <FormControlLabel
              key={item.key} className="h5-claude-settings-key" data-key={item.key} sx={rowSx}
              control={<Checkbox checked={item.shared} disabled={busy} onChange={event => void toggle(item.key, event.target.checked)} slotProps={{ input: { id: `h5-claude-settings-key-${item.key.replace(/\./g, '-')}` } }} />}
              label={<KeyLabel item={item} />}
            />
          ))}
        </Box>
      ) : <Hint id="h5-claude-settings-none">{t(`None of the settings that can be shared are in ${view.settings_path}.`)}</Hint>}
      {view.files.length ? (
        <Box id="h5-claude-settings-files" sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
          <Hint>{t('Status line scripts sent with it:')}</Hint>
          {view.files.map(file => <Typography key={file.path} component="code" translate="no" className="h5-claude-settings-file" sx={mono}>{file.path}</Typography>)}
        </Box>
      ) : null}
      {view.warnings.length ? (
        <Hint id="h5-claude-settings-warnings">{`${t('Skipped')}: ${view.warnings.map(item => `${item.path} (${t(WARNINGS[item.warning] || item.warning)})`).join('; ')}`}</Hint>
      ) : null}
      <Hint>{t('Only these keys can be shared. Credentials, environment variables, hooks, permission rules and MCP servers never are.')}</Hint>
    </Box>
  );
}

function ReceiverSettings({ view, busy, save }) {
  const toggle = (key, on) => save({ keep_local: on ? [...view.keep_local, key] : view.keep_local.filter(item => item !== key) });
  return (
    <Box id="h5-claude-settings" sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, minWidth: 0 }}>
      <Heading>{t('Claude settings')}</Heading>
      {view.file_error ? <Typography id="h5-claude-settings-error" variant="body2" color="error" sx={{ overflowWrap: 'anywhere' }}>{t(`${view.file_path} is not valid JSON, so no shared settings are added to new sessions.`)}</Typography> : null}
      {view.received.length ? (
        <>
          <Hint>{t('Added to the Claude sessions T-Agent starts on this device; settings.json is not changed. Tick a key to keep this device’s own value.')}</Hint>
          <Box id="h5-claude-settings-received" sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
            {view.received.map(item => (
              <Box key={item.key} className="h5-claude-settings-received" data-key={item.key} sx={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <KeyLabel item={item} />
                <FormControlLabel
                  sx={{ minHeight: 44, mr: 0 }}
                  control={<Checkbox checked={item.kept_local} disabled={busy} onChange={event => void toggle(item.key, event.target.checked)} slotProps={{ input: { id: `h5-claude-settings-keep-${item.key.replace(/\./g, '-')}` } }} />}
                  label={t('Keep this device’s own value')}
                />
              </Box>
            ))}
          </Box>
          {view.files.length ? <Hint id="h5-claude-settings-statusline">{t(`The status line runs the copies of its scripts in ${view.statusline_dir}.`)}</Hint> : null}
        </>
      ) : <Hint id="h5-claude-settings-none">{t('No Claude settings received yet.')}</Hint>}
    </Box>
  );
}

export function SharedClaudeSettings({ data, busy, save }) {
  const view = data && data.claude_settings;
  if (!view) return null;
  if (data.role === 'source' && Array.isArray(view.available)) return <SourceSettings view={view} busy={busy} save={save} />;
  if (data.role === 'receive' && Array.isArray(view.received)) return <ReceiverSettings view={view} busy={busy} save={save} />;
  return null;
}
