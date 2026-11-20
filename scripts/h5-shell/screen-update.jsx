// The Update dialog chunk (lazy-screens.jsx): the dialog of the Update button (UpdateDialog.jsx, with "Also update" of LinkedUpdates.jsx). The button,
// its red dot and the silent reload after an automatic update stay in the first screen (Update.jsx); the dialog is loaded when it first opens, or
// earlier when the pointer, a finger or the focus reaches an Update button.
//
// shell-core.mjs is imported only to keep the first screen's modules in one shared chunk (see there).
import './shell-core.mjs';

export { UpdateDialog } from './UpdateDialog.jsx';
