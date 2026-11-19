// The session switcher chunk (lazy-screens.jsx): loaded when the switch button is first reached (pointer, finger or focus) or pressed.
//
// shell-core.mjs is imported only to keep the first screen's modules in one shared chunk (see there).
import './shell-core.mjs';

export { Switcher } from './Switcher.jsx';
