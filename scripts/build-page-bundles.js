#!/usr/bin/env node
// Builds the page's two React bundles in one esbuild run with code splitting (ES modules), so the code they share is one file the browser loads once:
//
// - public/js/h5-shell.js: the Material UI shell (scripts/h5-shell/entry.jsx), a `<script type="module">` of public/h5.html. It draws the first
//   screen; the screens that open on demand (Settings, T-Attention, the design and file sheets, see scripts/h5-shell/lazy-screens.jsx) are
//   `import()`ed when first opened.
// - public/js/agent-chat-ui.js: the chat view (scripts/agent-chat/entry.jsx), imported by public/js/agent-chat.js when the first chat opens. It uses
//   the shell's copy of React and react-dom, and the highlight.js of the design sheet's Markdown view: they are in shared chunks, so React and
//   react-dom always come from the same package (one node_modules, one build) and can never disagree.
// - public/js/chunks/<name>-<hash>.js: the shared code and the lazy screens. Their names carry the hash of their content, and the modules ask for each
//   other by those names (absolute /js/chunks/ URLs, no ?v=), so lib/static-assets.js caches them for a year by name. This folder is emptied first,
//   so it holds exactly the chunks of the current build (commit it with the bundles).
//
// `npm run build:h5-shell` and `npm run build:agent-chat` both run this file. Options: --metafile=<file> writes esbuild's metafile; --quiet.
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'js');
const CHUNKS = path.join(OUT, 'chunks');
const args = process.argv.slice(2);
const metafileArg = args.find(arg => arg.startsWith('--metafile='));
const quiet = args.includes('--quiet');

async function build() {
  fs.rmSync(CHUNKS, { recursive: true, force: true });
  const result = await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: { 'h5-shell': 'scripts/h5-shell/entry.jsx', 'agent-chat-ui': 'scripts/agent-chat/entry.jsx' },
    bundle: true,
    splitting: true,
    format: 'esm',
    minify: true,
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    outdir: OUT,
    entryNames: '[name]',
    chunkNames: 'chunks/[name]-[hash]',
    publicPath: '/js/',
    metafile: true,
    logLevel: quiet ? 'error' : 'warning',
  });
  if (metafileArg) fs.writeFileSync(metafileArg.slice('--metafile='.length), JSON.stringify(result.metafile));
  if (!quiet) report(result.metafile);
}

// The files the browser loads with each entry before it runs (its static imports, followed through), and their sizes.
function report(metafile) {
  const outputs = metafile.outputs;
  const name = file => path.relative(ROOT, path.resolve(ROOT, file));
  const statics = file => (outputs[file].imports || []).filter(entry => entry.kind === 'import-statement').map(entry => entry.path);
  for (const entry of Object.keys(outputs).filter(file => outputs[file].entryPoint)) {
    const seen = new Set();
    const visit = file => { if (seen.has(file)) return; seen.add(file); for (const next of statics(file)) visit(next); };
    visit(entry);
    const bytes = [...seen].reduce((sum, file) => sum + outputs[file].bytes, 0);
    console.log(`${name(entry)}: ${seen.size} file(s) before it runs, ${bytes} bytes`);
  }
  const lazy = Object.keys(outputs).filter(file => file.endsWith('.js') && !outputs[file].entryPoint);
  console.log(`${lazy.length} chunk(s) in ${name(CHUNKS)}`);
}

build().catch(error => { console.error(error.message || error); process.exit(1); });
