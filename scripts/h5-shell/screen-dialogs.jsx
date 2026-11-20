// The terminal's dialogs chunk (lazy-screens.jsx): the copy view, the upload progress, the Paste sheet and the uploaded link (Dialogs.jsx). They open
// from the terminal and its menus, so the first screen does not carry them; the chunk is loaded when one opens for the first time, or earlier when the
// pointer, a finger or the focus reaches the terminal, the image button, the saved commands or a session menu.
//
// shell-core.mjs is imported only to keep the first screen's modules in one shared chunk (see there).
import './shell-core.mjs';

export { CopyDialog, PasteDialog, RetainDialog, UploadDialog } from './Dialogs.jsx';
