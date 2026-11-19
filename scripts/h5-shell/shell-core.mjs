// Every module the first screen is made of: the static imports of entry.jsx (test/page-bundles.test.js checks that none is missing). The chunks of
// the screens that open on demand (screen-*.jsx, loaded by lazy-screens.jsx) import this file for nothing but that: a module reached from the shell
// entry and from every screen chunk alike is put by esbuild in ONE shared chunk, instead of one small chunk per combination of screens that use it
// (scripts/build-page-bundles.js), so the page loads a few files at start, not a dozen. Importing them here runs nothing: they have no side effects.
import 'react-dom';
import 'react-dom/client';
import './App.jsx';
import './store.mjs';
import './back.mjs';
import './attention-feed.mjs';
import './pane.mjs';
import './common.jsx';
import './file-kinds.mjs';
import './task-order.mjs';
import './recent-sessions.mjs';
import './Columns.jsx';
import './lazy-screens.jsx';
