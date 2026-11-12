import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { t } from './common.jsx';
import { registerAttentionSettings } from './attention-slots.mjs';

// The "Agent skill" line of the Settings group "T-Attention": the t-attention skill is installed with the other agent skills in Settings → Tasks and
// files → Agent skills (AgentSkillsSettings.jsx); this line only points there, and its button opens that part (`ui.actions.openSettings('agent-skills')`,
// settings-target.mjs). See "Agent skills" in DESIGN.md.
function SkillPointer({ ui }) {
  return (
    <Box id="h5-skill-pointer" sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, flexWrap: 'wrap' }}>
      <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere', flex: '1 1 12rem', minWidth: 0 }}>{t('Agent skill: Settings → Tasks and files → Agent skills')}</Typography>
      <Button id="h5-skill-open" variant="outlined" onClick={() => ui.actions.openSettings('agent-skills')}>{t('Open')}</Button>
    </Box>
  );
}

registerAttentionSettings({ id: 'skill', order: 40, Component: SkillPointer });
