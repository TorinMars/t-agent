// The VS Code launcher's chunk (lazy-screens.jsx `openVscode`): loaded the first time "Open in VS Code" is chosen in the session header's More
// (VscodeLaunch.jsx).
//
// shell-core.mjs is imported only to keep the first screen's modules in one shared chunk (see there).
import './shell-core.mjs';

export { runVscode } from './VscodeLaunch.jsx';
