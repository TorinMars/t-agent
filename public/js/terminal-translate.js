// Cleans a translation before it is typed into a terminal. The page's translate-and-send (public/js/h5.js) calls `sanitize`; translation itself runs
// on the Client (POST /api/translate), so remote terminals work too. The old desktop translate form that lived here was removed in 2.88.1.
const TerminalTranslate = (() => {
  // Control characters (including ESC) in the translation must not go into the terminal as-is, otherwise a translation result could inject key sequences; multiple lines are collapsed into one so nothing is submitted early.
  const CONTROLS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]+', 'g');
  const sanitize = value => String(value).replace(CONTROLS, ' ').replace(/\s+/g, ' ').trim();
  return { sanitize };
})();
if (typeof window !== 'undefined') window.TerminalTranslate = TerminalTranslate;
