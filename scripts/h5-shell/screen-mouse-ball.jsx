// The mouse ball's chunk (lazy-screens.jsx `MouseBallScreen`): the ball over the terminal that comes out of the wheel strip (MouseBall.jsx). The
// first screen does not carry it; the chunk is loaded in touch input, after the first screen (and never in pointer input).
//
// shell-core.mjs is imported only to keep the first screen's modules in one shared chunk (see there).
import './shell-core.mjs';

export { MouseBall } from './MouseBall.jsx';
