// The version banner chunk (lazy-screens.jsx `VersionSkewBanner`): drawn at the top of the task list only while the update status says that an engine
// runs an older version lacking something the engines share (VersionSkew.jsx).
//
// shell-core.mjs is imported only to keep the first screen's modules in one shared chunk (see there).
import './shell-core.mjs';

export { VersionSkewBanner } from './VersionSkew.jsx';
