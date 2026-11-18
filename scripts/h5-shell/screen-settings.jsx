// The Settings chunk (lazy-screens.jsx): the Settings sheet, and the modules of other T-Attention parts that register their content in the Settings group
// "T-Attention" (attention-slots.mjs). They are imported here for that side effect, so every part is registered before the sheet is first drawn.
//
// shell-core.mjs is imported only to keep the first screen's modules in one shared chunk (see there).
import './shell-core.mjs';
import './PluginSettings.jsx';
import './AttentionSkillSettings.jsx';
import './AttentionWidgetSettings.jsx';

export { SettingsDrawer } from './Settings.jsx';
