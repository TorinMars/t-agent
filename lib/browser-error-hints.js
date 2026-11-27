// The next step for each error code `tcli browser` can meet ("Errors with a next step" in docs/design/browser-extension.md): the CLI prints it as
// a `hint:` line under the error, and `--json` adds it to the error as `hint`. One table, so a new code gets its hint here; test/browser-error-hints.test.js
// collects the codes the extension, the bridge, the recordings, the relay and tcli can answer and fails when one has none. Node built-ins only.
const HINTS = Object.freeze({
  // The connection to the browser (services/browser-bridge.js)
  BROWSER_NOT_CONNECTED: 'Ask the person to open Chrome with the T-Agent extension (or pair it in Settings > Tasks and files > Browser extension); check with: tcli browser status',
  BROWSER_TIMEOUT: 'Try once more; for a slow page give it longer with --timeout MS (for example --timeout 60000)',
  BROWSER_NOT_FOUND: 'List the paired browsers with: tcli browser status, and pass one of their ids to --browser',
  METHOD_NOT_ALLOWED: 'This T-Agent does not know the command: tcli and T-Agent should come from the same install; update T-Agent',
  UNKNOWN_METHOD: 'The extension is older than T-Agent: ask the person to reload it in chrome://extensions, then check with: tcli browser status',
  EXTENSION_ERROR: 'Try once more; if it repeats, ask the person to reload the extension in chrome://extensions',
  PAIR_CODE_INVALID: 'Make a new pairing code in Settings > Tasks and files > Browser extension and enter it within 5 minutes',
  INVALID_NAME: 'Use a name of 1 to 60 characters on one line',
  TOO_MANY_BROWSERS: 'Remove a paired browser in Settings > Tasks and files > Browser extension first',
  // Answers of the extension (extensions/chrome/)
  TAB_NOT_ALLOWED: 'Use a tab T-Agent opened (tcli browser tabs, or tcli browser open <url>), or ask the person to hand this tab over with the extension button',
  TAB_NOT_SCRIPTABLE: 'Only http and https pages can be driven (not chrome://, file or Web Store pages): open an http(s) address',
  TAB_NOT_FOUND: 'The tab is gone: list the usable tabs with: tcli browser tabs, or open a new one with: tcli browser open <url>',
  REF_NOT_FOUND: 'The page changed since the last snapshot: take a new one (tcli browser snapshot) and use its refs',
  ELEMENT_NOT_FOUND: 'Nothing matches the target: look with tcli browser snapshot (or query <selector>), or wait for it with: tcli browser wait --selector S',
  ELEMENT_NOT_INTERACTABLE: 'The element is hidden, disabled, covered or not editable: scroll to it (tcli browser scroll <target>) or close the dialog in front of it, then take a new snapshot and try again',
  REQUEST_NOT_FOUND: 'List the captured requests with: tcli browser net list, and use one of their req_id values',
  DEBUGGER_BUSY: 'DevTools (or another debugger) is open on this tab: ask the person to close DevTools there, then try again',
  NO_DIALOG: 'No JavaScript dialog is open on this tab: check with tcli browser dialog status; if the page does not respond, ask the person to look at the tab in Chrome',
  NOT_CAPTURING: 'Nothing is capturing on this tab: start it first (tcli browser net start, or record start); for a recording id see: tcli browser record list',
  BAD_PARAMS: 'Check the options of the command: tcli browser help',
  EVAL_FAILED: 'The page script threw or the request failed: check the expression or the URL, and the page console (tcli browser console)',
  TIMEOUT: 'The page did not get there in time: retry with a longer --timeout MS, or look at the page with tcli browser shot or snapshot',
  INTERNAL: 'Try once more; if it repeats, ask the person to reload the extension in chrome://extensions',
  // Recordings (services/browser-recordings.js, lib/browser-recording-query.js)
  BAD_RECORDING_ID: 'Recording ids look like rec_...: list them with: tcli browser record list',
  RECORDING_NOT_FOUND: 'List the recordings with: tcli browser record list (they are kept for 14 days)',
  BAD_ITEMS: 'The extension sent a broken batch: ask the person to reload the extension in chrome://extensions',
  FRAME_NOT_FOUND: 'The picture is gone (removed, or past the limit): export again, or record again with --frames',
  BAD_FILTER: 'Check the filter values in: tcli browser help (Recordings)',
  // The relay (routes/browser-ext.js) and tcli itself (scripts/tcli.js)
  TCLI_AUTH_REQUIRED: 'Run tcli inside a T-Agent terminal, where TA_HOOK_URL and TA_HOOK_TOKEN are set',
  TCLI_AUTH_INVALID: 'The terminal token is not valid (the terminal restarted?): run the command in a current T-Agent terminal of this task',
  UNKNOWN_ROUTE: 'This T-Agent is older than tcli: update T-Agent',
  TOO_LARGE: 'Send less: a smaller --file for eval, or a smaller -d body for fetch',
  BAD_JSON: 'tcli sent a request T-Agent could not read: update T-Agent',
  INTERNAL_ERROR: 'T-Agent failed: try once more; if it repeats, tell the person',
  NETWORK: 'T-Agent cannot be reached: tell the person it may not be running (never start it yourself)',
});

const hintFor = code => (typeof code === 'string' && Object.prototype.hasOwnProperty.call(HINTS, code) ? HINTS[code] : null);

module.exports = { HINTS, hintFor };
