// The mouse ball's chunk (lazy-screens.jsx `MouseBallScreen`): the ball over the phone terminal (MouseBall.jsx). It is off by default, so the first
// screen does not carry it; the chunk is loaded when it is turned on (or at start on a device where it is on).
//
// shell-core.mjs is imported only to keep the first screen's modules in one shared chunk (see there).
import './shell-core.mjs';

export { MouseBall } from './MouseBall.jsx';
