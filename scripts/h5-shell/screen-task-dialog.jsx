// The task dialogs chunk (lazy-screens.jsx): delete, working directory, archive and visibility of a task (TaskDialogs.jsx). They open only from a
// task's menu, so the first screen does not carry them; the chunk is loaded when one opens for the first time.
//
// shell-core.mjs is imported only to keep the first screen's modules in one shared chunk (see there).
import './shell-core.mjs';

export { TaskDialog } from './TaskDialogs.jsx';
