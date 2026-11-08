// What kind of file a path names, and so how the file sheet (Design.jsx) reads and shows it. One table for the page: h5.js reads it through the shell
// (`H5UI.fileKinds`, set in entry.jsx), so the two sides never disagree. The server keeps its own table of the image and raw types (services/).
//
// Kinds: markdown | image | pdf | audio | video | json | csv | html | code. `code` is every other file: it is read as text, and a binary file is
// refused by the text read (FILE_UNSUPPORTED), which the sheet shows as "This is not a plain text file".

const EXTENSIONS = {
  markdown: ['md', 'markdown', 'mdx'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'],
  pdf: ['pdf'],
  audio: ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'flac', 'opus'],
  video: ['mp4', 'm4v', 'webm', 'mov', 'ogv'],
  json: ['json', 'jsonc', 'json5', 'geojson', 'webmanifest'],
  csv: ['csv', 'tsv'],
  html: ['html', 'htm'],
};
const BY_EXTENSION = new Map();
for (const [kind, list] of Object.entries(EXTENSIONS)) for (const ext of list) BY_EXTENSION.set(ext, kind);
const JSON_NAMES = new Set(['.babelrc', '.eslintrc']);

// The kinds that are read whole as bytes (`…/raw?path=`), not as text: the Engine needs the 'files:raw' capability for them.
export const RAW_KINDS = new Set(['pdf', 'audio', 'video']);

const baseName = filePath => String(filePath || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
const extension = name => { const dot = name.lastIndexOf('.'); return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''; };

export function kindOf(filePath) {
  const name = baseName(filePath);
  if (JSON_NAMES.has(name.toLowerCase())) return 'json';
  return BY_EXTENSION.get(extension(name)) || 'code';
}

// The highlight.js language of a text file, by its extension or its whole name (Dockerfile, Makefile, .env ...); null: plain text. Only languages
// that public/js/markdown-view.js registers (highlight.js "common" plus dockerfile and nginx) are named here.
const LANGUAGES = {
  javascript: ['js', 'mjs', 'cjs', 'jsx'],
  typescript: ['ts', 'mts', 'cts', 'tsx'],
  python: ['py', 'pyw', 'pyi'],
  bash: ['sh', 'bash', 'zsh', 'ksh', 'env', 'command'],
  go: ['go'],
  rust: ['rs'],
  java: ['java'],
  kotlin: ['kt', 'kts'],
  swift: ['swift'],
  c: ['c', 'h'],
  cpp: ['cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx', 'ino'],
  csharp: ['cs'],
  objectivec: ['m', 'mm'],
  ruby: ['rb', 'rake', 'gemspec'],
  php: ['php'],
  perl: ['pl', 'pm'],
  lua: ['lua'],
  r: ['r'],
  css: ['css'],
  scss: ['scss', 'sass'],
  less: ['less'],
  json: ['json', 'jsonc', 'json5', 'geojson', 'webmanifest', 'map'],
  yaml: ['yaml', 'yml'],
  ini: ['ini', 'toml', 'cfg', 'conf', 'properties', 'editorconfig', 'gitconfig'],
  sql: ['sql'],
  xml: ['xml', 'html', 'htm', 'xhtml', 'svg', 'vue', 'svelte', 'plist', 'xsd', 'xsl'],
  markdown: ['md', 'markdown', 'mdx'],
  diff: ['diff', 'patch'],
  graphql: ['graphql', 'gql'],
  makefile: ['mk', 'mak'],
  dockerfile: ['dockerfile'],
  nginx: ['nginx'],
  vbnet: ['vb'],
};
const LANGUAGE_BY_EXTENSION = new Map();
for (const [language, list] of Object.entries(LANGUAGES)) for (const ext of list) LANGUAGE_BY_EXTENSION.set(ext, language);
const LANGUAGE_BY_NAME = new Map([
  ['dockerfile', 'dockerfile'], ['containerfile', 'dockerfile'], ['makefile', 'makefile'], ['gnumakefile', 'makefile'],
  ['.env', 'bash'], ['.bashrc', 'bash'], ['.bash_profile', 'bash'], ['.zshrc', 'bash'], ['.profile', 'bash'],
  ['.babelrc', 'json'], ['.eslintrc', 'json'], ['.prettierrc', 'json'], ['.gitconfig', 'ini'], ['.editorconfig', 'ini'], ['.npmrc', 'ini'],
  ['gemfile', 'ruby'], ['rakefile', 'ruby'], ['podfile', 'ruby'], ['vagrantfile', 'ruby'], ['nginx.conf', 'nginx'],
]);

export function languageOf(filePath) {
  const name = baseName(filePath).toLowerCase();
  if (LANGUAGE_BY_NAME.has(name)) return LANGUAGE_BY_NAME.get(name);
  if (/^\.env(\.|$)/.test(name)) return 'bash'; // .env.local, .env.production ...
  if (/^dockerfile[.-]/.test(name) || name.endsWith('.dockerfile')) return 'dockerfile';
  return LANGUAGE_BY_EXTENSION.get(extension(name)) || null;
}
