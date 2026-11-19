// The Recent tab of the task list (lazy-screens.jsx): loaded when the tab is first reached (pointer, finger or focus) or chosen, or at start when it
// is the remembered tab.
//
// shell-core.mjs is imported only to keep the first screen's modules in one shared chunk (see there).
import './shell-core.mjs';

export { RecentList } from './RecentList.jsx';
