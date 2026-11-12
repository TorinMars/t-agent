import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { Pill, api, errorText, t } from './common.jsx';
import { Feedback, Hint, useFeedback } from './Form.jsx';
import { BASE } from './attention-feed.mjs';
import { registerAttentionSettings } from './attention-slots.mjs';

// The "Agent skill" part of the Settings group "T-Attention": the t-attention skill (rules/skills/t-attention/SKILL.md) for Claude Code and Codex on the
// machine that runs this Client, from GET /api/attention/skill (services/attention-skill.js), read each time the group opens. Install / Update writes it
// for both (POST /install); when the old task-tracker skill is still there, "Replace the old task-tracker skill" installs and then moves the old one into
// the Client's backups (POST /remove-old). Agent names and paths are not translated. See "T-Attention agent skill" in DESIGN.md.
const SKILL = `${BASE}/skill`;
const AGENTS = [{ key: 'claude', name: 'Claude Code' }, { key: 'codex', name: 'Codex' }];

// One agent's state as a chip: { label, tone }.
export function skillChip(state) {
  if (!state) return { label: 'Unknown', tone: 'default' };
  if (state.conflict === 'rule-sync') return { label: 'Managed by the rules and skills sync', tone: 'warning' };
  if (state.conflict) return { label: 'Not a plain folder', tone: 'warning' };
  if (!state.installed) return { label: 'Not installed', tone: 'default' };
  if (!state.current) return { label: 'Update available', tone: 'warning' };
  return { label: 'Installed', tone: 'success' };
}

const ACTIONS = { installed: 'Installed', updated: 'Updated', unchanged: 'Already up to date', refused: 'Not changed: this folder is managed elsewhere' };
const SKIPS = { missing: 'Not found', 'not-installed': 'Kept: the new skill is not installed there', 'rule-sync': 'Kept: the rules and skills sync manages it' };

// The lines that say what an install did, per agent.
export function installLines(result) {
  return AGENTS.map(({ key, name }) => {
    const item = result && result.results && result.results[key];
    return item ? `${name}: ${t(ACTIONS[item.action] || item.action)}` : null;
  }).filter(Boolean);
}

function AgentRow({ agent, state }) {
  const chip = skillChip(state);
  return (
    <Box className="h5-skill-agent" data-agent={agent.key} sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, flexWrap: 'wrap' }}>
        <Box component="strong" translate="no">{agent.name}</Box>
        <Pill className="h5-skill-chip" data-state={chip.label} label={t(chip.label)} tone={chip.tone} sx={{ whiteSpace: 'normal', height: 'auto', minHeight: 24, py: 0.25, textAlign: 'center' }} />
      </Box>
      {state && state.path ? <Typography variant="caption" color="text.secondary" className="h5-skill-path" translate="no" sx={{ overflowWrap: 'anywhere' }}>{state.path}</Typography> : null}
    </Box>
  );
}

function SkillSlot({ opened }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [feedback, say] = useFeedback();
  const load = async () => {
    try { setData(await api('GET', SKILL)); } catch (error) { say(`${t('Failed')}: ${errorText(error)}`, true); }
  };
  useEffect(() => { if (opened) void load(); }, [opened]); // eslint-disable-line react-hooks/exhaustive-deps -- read each time the group is opened
  const states = data ? AGENTS.map(agent => data[agent.key]).filter(Boolean) : [];
  const writable = states.filter(state => !state.conflict);
  const anyInstalled = states.some(state => state.installed);
  const upToDate = writable.length > 0 && writable.every(state => state.installed && state.current);
  const old = data && data.old_task_tracker ? AGENTS.filter(agent => data.old_task_tracker[agent.key]) : [];
  const run = async replaceOld => {
    setBusy(true);
    try {
      const result = await api('POST', `${SKILL}/install`);
      const lines = installLines(result);
      let next = result.status || null;
      if (replaceOld) {
        const moved = await api('POST', `${SKILL}/remove-old`);
        next = moved.status || next;
        for (const item of moved.moved || []) lines.push(`${AGENTS.find(agent => agent.key === item.agent)?.name || item.agent}: ${t('The old task-tracker skill was moved to')} ${item.to}`);
        for (const item of moved.skipped || []) if (item.reason !== 'missing') lines.push(`${AGENTS.find(agent => agent.key === item.agent)?.name || item.agent}: ${t(SKIPS[item.reason] || item.reason)}`);
      }
      if (next) setData(next); else await load();
      say(lines.join('\n'), !result.ok);
    } catch (error) { say(`${t('Failed')}: ${errorText(error)}`, true); }
    finally { setBusy(false); }
  };
  return (
    <>
      <Typography variant="subtitle2" component="h3" sx={{ fontWeight: 700, mt: 1 }}>{t('Agent skill')}</Typography>
      <Hint>{t('The t-attention skill teaches Claude Code and Codex to register their work and their sub-agents here, to ask you when they need you, and to wait for your confirmation of finished work. It is installed on the machine that runs this Client.')}</Hint>
      <Box id="h5-skill" aria-busy={data ? 'false' : 'true'} sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        {data ? AGENTS.map(agent => <AgentRow key={agent.key} agent={agent} state={data[agent.key]} />) : <Hint id="h5-skill-loading">{t('Loading…')}</Hint>}
      </Box>
      {data && states.some(state => state.conflict === 'rule-sync') ? (
        <Hint id="h5-skill-sync-note">{t('A skill folder that the rules and skills sync manages is never overwritten here. Update the skill on the source service instead.')}</Hint>
      ) : null}
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
        <Button id="h5-skill-install" variant={upToDate ? 'outlined' : 'contained'} disabled={!data || busy || !writable.length || upToDate} onClick={() => void run(false)}>
          {upToDate ? t('Up to date') : anyInstalled ? t('Update') : t('Install')}
        </Button>
      </Box>
      {old.length ? (
        <Box id="h5-skill-old" sx={{ display: 'flex', flexDirection: 'column', gap: 1, p: 1.5, borderRadius: 1, border: 1, borderColor: 'warning.main' }}>
          <Hint>{t('The old task-tracker skill is still installed. It teaches the earlier tracker, so agents could report to both. Replacing it installs t-attention and moves task-tracker into the backups folder of this Client (nothing is deleted).')}</Hint>
          <Typography variant="caption" color="text.secondary" translate="no">{old.map(agent => agent.name).join(', ')}</Typography>
          <Box><Button id="h5-skill-replace-old" variant="outlined" color="warning" disabled={busy} onClick={() => void run(true)}>{t('Replace the old task-tracker skill')}</Button></Box>
        </Box>
      ) : null}
      <Feedback id="h5-skill-feedback" feedback={feedback} />
    </>
  );
}

registerAttentionSettings({ id: 'skill', order: 40, Component: SkillSlot });
