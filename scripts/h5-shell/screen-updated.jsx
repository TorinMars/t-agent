// The "Updated to v…" chunk (lazy-screens.jsx `showUpdatedNotice`): loaded only when the updater's read of the update status says that this person
// has a notice about an update of this service to see (UpdatedNotice.jsx).
//
// shell-core.mjs is imported only to keep the first screen's modules in one shared chunk (see there).
import './shell-core.mjs';

export { showUpdatedNotice } from './UpdatedNotice.jsx';
