import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { Pill, errorText, t } from './common.jsx';
import { Feedback, Hint, Section, useFeedback } from './Form.jsx';
import { ScopeLabel } from './ScopeLabel.jsx';
import { useDeviceTarget } from './DeviceTarget.jsx';

// "Agent skills", a part of the Settings group "Tasks and files" (`#h5-sec-agent-skills`): the skills that come with T-Agent (t-attention, tcli;
// services/agent-skills.js) for Claude Code and Codex on the machine that runs this Client, from GET /api/agent-skills, read each time the group
// opens. Install / Update writes one skill for both agents (POST /api/agent-skills/<name>/install); when the old task-tracker skill is still there,
// "Replace the old task-tracker skill" installs t-attention and then moves the old one into the Client's backups (POST .../t-attention/remove-old).
// Skill names, agent names and paths are not translated; a skill's description is the server's English text, translated by the dictionary.
// See "Agent skills" in DESIGN.md.
const BASE = '/api/agent-skills';
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
const agentName = key => AGENTS.find(agent => agent.key === key)?.name || key;

// The lines that say what an install did, per agent.
export function installLines(result) {
  return AGENTS.map(({ key, name }) => {
    const item = result && result.results && result.results[key];
    return item ? `${name}: ${t(ACTIONS[item.action] || item.action)}` : null;
  }).filter(Boolean);
}

// What the button of one skill says and whether it can be pressed: { label, disabled }.
export function skillButton(skill) {
  const states = skill ? AGENTS.map(agent => skill[agent.key]).filter(Boolean) : [];
  const writable = states.filter(state => !state.conflict);
  if (!skill || skill.error || !writable.length) return { label: 'Install', disabled: true };
  if (writable.every(state => state.installed && state.current)) return { label: 'Up to date', disabled: true };
  return { label: states.some(state => state.installed) ? 'Update' : 'Install', disabled: false };
}

function AgentRow({ agent, state }) {
  const chip = skillChip(state);
  return (
    <Box className="h5-skill-agent" data-agent={agent.key} sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, flexWrap: 'wrap' }}>
        <Box component="span" translate="no" sx={{ fontWeight: 600, fontSize: '0.875rem' }}>{agent.name}</Box>
        <Pill className="h5-skill-chip" data-state={chip.label} label={t(chip.label)} tone={chip.tone} sx={{ whiteSpace: 'normal', height: 'auto', minHeight: 24, py: 0.25, textAlign: 'center' }} />
      </Box>
      {state && state.path ? <Typography variant="caption" color="text.secondary" className="h5-skill-path" translate="no" sx={{ overflowWrap: 'anywhere' }}>{state.path}</Typography> : null}
    </Box>
  );
}

function SkillCard({ skill, busy, onInstall }) {
  const button = skillButton(skill);
  return (
    <Box
      component="article" className="h5-agent-skill" data-skill={skill.name} aria-labelledby={`h5-agent-skill-${skill.name}-name`}
      sx={{ display: 'flex', flexDirection: 'column', gap: 1.25, p: 1.5, borderRadius: 1, border: 1, borderColor: 'divider', minWidth: 0 }}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
        <Typography id={`h5-agent-skill-${skill.name}-name`} component="h4" variant="body1" translate="no" sx={{ fontWeight: 700, fontFamily: 'monospace', fontSize: '0.9375rem' }}>{skill.name}</Typography>
        <Typography variant="body2" color="text.secondary" className="h5-agent-skill-description" sx={{ overflowWrap: 'anywhere' }}>{t(skill.description || '')}</Typography>
      </Box>
      {AGENTS.map(agent => <AgentRow key={agent.key} agent={agent} state={skill[agent.key]} />)}
      {skill.error ? <Typography variant="body2" color="error" className="h5-agent-skill-error" sx={{ overflowWrap: 'anywhere' }}>{t(skill.error)}</Typography> : null}
      {/* A card's button is outlined, like the buttons of a device row (Actions in Form.jsx): the part has two cards, so neither is the part's main action. */}
      <Box>
        <Button id={`h5-agent-skill-install-${skill.name}`} className="h5-agent-skill-install" variant="outlined" disabled={busy || button.disabled} onClick={onInstall}>
          {t(button.label)}
        </Button>
      </Box>
    </Box>
  );
}

// The skills of the device chosen in "Settings for" (DeviceTarget.jsx): this one, or a linked one through the link.
export function AgentSkillsSection(props) {
  const device = useDeviceTarget();
  return <AgentSkillsPart key={device.key} {...props} call={device.api} remote={device.remote} name={device.name} />;
}
function AgentSkillsPart({ opened, call, remote, name }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [feedback, say] = useFeedback();
  const load = async () => {
    try { setData(await call('GET', BASE)); } catch (error) { say(`${t('Failed')}: ${errorText(error)}`, true); }
  };
  useEffect(() => { if (opened) void load(); }, [opened]); // eslint-disable-line react-hooks/exhaustive-deps -- read each time the group is opened
  const list = data && Array.isArray(data.skills) ? data.skills : [];
  const old = data && data.old_task_tracker ? AGENTS.filter(agent => data.old_task_tracker[agent.key]) : [];
  const synced = list.some(skill => AGENTS.some(agent => skill[agent.key] && skill[agent.key].conflict === 'rule-sync'));
  const run = async (skillName, replaceOld = false) => {
    setBusy(true);
    try {
      const result = await call('POST', `${BASE}/${encodeURIComponent(skillName)}/install`);
      const lines = installLines(result).map(line => `${skillName} · ${line}`);
      let next = result.status || null;
      if (replaceOld) {
        const moved = await call('POST', `${BASE}/t-attention/remove-old`);
        next = moved.status || next;
        for (const item of moved.moved || []) lines.push(`${agentName(item.agent)}: ${t('The old task-tracker skill was moved to')} ${item.to}`);
        for (const item of moved.skipped || []) if (item.reason !== 'missing') lines.push(`${agentName(item.agent)}: ${t(SKIPS[item.reason] || item.reason)}`);
      }
      if (next) setData(next); else await load();
      say(lines.join('\n'), !result.ok);
    } catch (error) { say(`${t('Failed')}: ${errorText(error)}`, true); }
    finally { setBusy(false); }
  };
  return (
    <Section id="agent-skills" title="Agent skills" aside={<ScopeLabel />}>
      <Hint>{remote ? t(`Skills teach Claude Code and Codex to use T-Agent’s commands. They are installed on ${name}, for both agents.`) : t('Skills teach Claude Code and Codex to use T-Agent’s commands. They are installed on the machine that runs this Client, for both agents.')}</Hint>
      <Box id="h5-agent-skills" aria-busy={data ? 'false' : 'true'} sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        {data ? list.map(skill => <SkillCard key={skill.name} skill={skill} busy={busy} onInstall={() => void run(skill.name)} />) : <Hint id="h5-agent-skills-loading">{t('Loading…')}</Hint>}
      </Box>
      {synced ? <Hint id="h5-skill-sync-note">{t('A skill folder that the rules and skills sync manages is never overwritten here. Update the skill on the source service instead.')}</Hint> : null}
      {old.length ? (
        <Box id="h5-skill-old" sx={{ display: 'flex', flexDirection: 'column', gap: 1, p: 1.5, borderRadius: 1, border: 1, borderColor: 'warning.main' }}>
          <Hint>{t('The old task-tracker skill is still installed. It teaches the earlier tracker, so agents could report to both. Replacing it installs t-attention and moves task-tracker into the backups folder of this Client (nothing is deleted).')}</Hint>
          <Typography variant="caption" color="text.secondary" translate="no">{old.map(agent => agent.name).join(', ')}</Typography>
          <Box><Button id="h5-skill-replace-old" variant="outlined" color="warning" disabled={busy} onClick={() => void run('t-attention', true)}>{t('Replace the old task-tracker skill')}</Button></Box>
        </Box>
      ) : null}
      <Feedback id="h5-agent-skills-feedback" feedback={feedback} />
    </Section>
  );
}
