// Builds the Monaco editor bundle (public/vendor/monaco/): the editor itself, its CSS and font, and the two workers. Same options as the old `esbuild`
// command line of `npm run build:monaco`, plus one redirect: monaco-editor ships its own old copy of DOMPurify (esm/vs/base/browser/dompurify) and imports it by
// a relative path, so the version in node_modules/dompurify (pinned by `overrides` in package.json) would never reach the bundle. The editor draws markdown
// hovers through DOMPurify, so the bundle is built with the maintained copy instead; its API is the same (sanitize, addHook, removeAllHooks).
const path = require('node:path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const out = name => path.join(root, 'public/vendor/monaco', name);
const patchedPurify = path.join(root, 'node_modules/dompurify/dist/purify.es.mjs');

let redirected = 0;
const maintainedDompurify = {
  name: 'maintained-dompurify',
  setup(build) {
    build.onResolve({ filter: /(^|\/)dompurify\/dompurify\.js$/ }, args => {
      if (!/[\\/]node_modules[\\/]monaco-editor[\\/]/.test(args.importer)) return undefined;
      redirected += 1;
      return { path: patchedPurify };
    });
    build.onEnd(() => {
      // A newer monaco-editor may import the npm package itself: then there is nothing to redirect and this plugin can go.
      if (!redirected) throw new Error('monaco-editor no longer imports its own copy of DOMPurify: remove the redirect from scripts/build-monaco.js');
    });
  },
};

(async () => {
  await esbuild.build({
    entryPoints: [path.join(root, 'scripts/monaco-entry.js')], bundle: true, minify: true, supported: { 'template-literal': false }, format: 'iife', globalName: 'MonacoBundle',
    loader: { '.ttf': 'file' }, assetNames: '[name]-[hash]', outfile: out('monaco.js'), plugins: [maintainedDompurify], logLevel: 'info',
  });
  await esbuild.build({
    entryPoints: [path.join(root, 'node_modules/monaco-editor/esm/vs/editor/editor.worker.js')], bundle: true, minify: true, format: 'iife', outfile: out('editor.worker.js'), logLevel: 'info',
  });
  await esbuild.build({
    entryPoints: [path.join(root, 'node_modules/monaco-editor/esm/vs/languages/features/json/json.worker.js')], bundle: true, minify: true, supported: { 'template-literal': false },
    format: 'iife', outfile: out('json.worker.js'), logLevel: 'info',
  });
})().catch(error => { console.error(error.message || error); process.exit(1); });
