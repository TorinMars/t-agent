// The mouse ball's chunk (lazy-screens.jsx `MouseBallScreen`): the mouse handle over the terminal, which scrolls, and the ball that comes out of it
// (MouseBall.jsx). The first screen does not carry it; the chunk is loaded after the first screen, in both input modes.
//
// shell-core.mjs is imported only to keep the first screen's modules in one shared chunk (see there).
import './shell-core.mjs';

export { MouseBall } from './MouseBall.jsx';
