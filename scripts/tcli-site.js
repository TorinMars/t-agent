#!/usr/bin/env node
// `tcli site ...`: the site capability library of the browser feature, from a T-Agent terminal (shared contract v1 section 7; "Site library" in
// DESIGN.md). It reads and writes one entry per host through the relay /api/tcli/site/* (routes/browser-sites.js). The entries sync to linked
// devices. The core branch puts `tcli browser` in scripts/tcli-browser.js the same way; this file is the `tcli site` half, wired into scripts/tcli.js
// with one GROUPS.site line. The shared HTTP helpers live in scripts/tcli.js and are required lazily (so loading this file never loops back into it).
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const tcli = () => require('./tcli'); // lazy: tcli.js requires this file while defining GROUPS, so we must not require it at load time
const call = (relay, method, route, opts) => tcli().callJson(relay, method, route, opts);
const usage = message => tcli().usage(message);

const HELP = `tcli site: the site capability library (what the
model has learnt about each website, shared
across linked devices)

Usage: tcli site <command> [options]

Commands
  list [--query Q]       known sites (one line
                         each; Q filters host /
                         title / summary)
  show <site>            the full entry
    --json               the raw JSON entry
  save <site> --file F   replace the entry from a
                         file: F.json is the whole
                         entry, F.md is its summary
  edit <site> ...        change an existing entry
    field=value ...      set title, summary or
                         notes (empty value clears)
    --set field=value    the same, one field
    --file F             merge a .json partial, or
                         a .md file as the summary
  rm <site> --yes        delete the entry
  search <text>          find text in summaries,
                         actions and APIs

<site> is a host like github.com (lowercased,
without www.). Options: --json prints the raw
JSON answer. Entries never hold raw secrets: the
server redacts a saved entry and refuses one that
still looks like a token (SITE_HAS_SECRET).
`;

// ── Output ──
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const shortTime = ms => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : '-');

function formatList(items) {
  if (!items.length) return 'No sites yet. A model builds this up with `tcli site save` after exploring with `tcli browser`.';
  const width = Math.min(28, items.reduce((max, item) => Math.max(max, item.site.length), 0));
  return items.map(item => {
    const counts = [plural(item.actions, 'action'), plural(item.apis, 'API')].join(', ');
    const title = item.title && item.title !== item.site ? `  ${item.title}` : '';
    return `${item.site.padEnd(width)}  ${counts}${title}`;
  }).join('\n');
}

function formatEntry(entry) {
  const lines = [entry.title ? `${entry.title} (${entry.site})` : entry.site];
  lines.push(`  updated  ${shortTime(entry.updated_at)}${entry.updated_by ? ` by ${entry.updated_by}` : ''}  (v${entry.version || 1})`);
  if (entry.summary) { lines.push('', entry.summary.trim()); }
  if (Array.isArray(entry.pages) && entry.pages.length) {
    lines.push('', 'Pages');
    for (const page of entry.pages) lines.push(`  ${page.pattern}${page.purpose ? ` — ${page.purpose}` : ''}`);
  }
  if (Array.isArray(entry.actions) && entry.actions.length) {
    lines.push('', 'Actions');
    for (const action of entry.actions) {
      lines.push(`  ${action.name}${action.description ? ` — ${action.description}` : ''}`);
      for (const step of action.steps || []) lines.push(`      ${step}`);
    }
  }
  if (Array.isArray(entry.apis) && entry.apis.length) {
    lines.push('', 'APIs');
    for (const api of entry.apis) {
      lines.push(`  ${api.name}${api.method || api.url ? `  ${[api.method, api.url].filter(Boolean).join(' ')}` : ''}`);
      if (api.description) lines.push(`      ${api.description}`);
      if (api.auth) lines.push(`      auth: ${api.auth}`);
    }
  }
  if (entry.notes) lines.push('', 'Notes', `  ${entry.notes.trim().split('\n').join('\n  ')}`);
  return lines.join('\n');
}

function formatSearch(results, text) {
  if (!results.length) return `No site mentions "${text}".`;
  const lines = [];
  for (const result of results) {
    lines.push(result.title && result.title !== result.site ? `${result.site} (${result.title})` : result.site);
    for (const match of result.matches) lines.push(`  ${match.where}: ${match.snippet}`);
  }
  return lines.join('\n');
}

// ── File input ──
function readEntryFile(file, cwd) {
  const full = path.resolve(cwd, file);
  let text;
  try { text = fs.readFileSync(full, 'utf8'); } catch { throw usage(`Cannot read ${full}`); }
  if (/\.json$/i.test(file)) {
    let value;
    try { value = JSON.parse(text); } catch (error) { throw usage(`${full} is not valid JSON: ${error.message}`); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw usage(`${full} must hold a JSON object (the entry)`);
    return value;
  }
  // A .md (or any other) file is the entry's Markdown summary.
  return { summary: text };
}

// A `field=value` pair for edit: only the simple top-level text fields. An empty value clears the field (sent as null).
const EDIT_FIELDS = new Set(['title', 'summary', 'notes']);
function parsePair(token) {
  const eq = token.indexOf('=');
  if (eq < 0) throw usage(`Not a field=value pair: ${token}`);
  const field = token.slice(0, eq).trim();
  if (!EDIT_FIELDS.has(field)) throw usage(`edit can set only ${[...EDIT_FIELDS].join(', ')} as field=value (use --file for the rest); not "${field}"`);
  const value = token.slice(eq + 1);
  return [field, value === '' ? null : value];
}

// ── Commands ──
async function siteList({ relay, flags, positional, out }) {
  if (positional.length) throw usage('Usage: tcli site list [--query Q]');
  const answer = await call(relay, 'GET', '/site/list', { query: { query: flags.query } });
  out(flags.json ? JSON.stringify(answer, null, 2) : formatList(answer.sites || []));
  return tcli().EXIT.ok;
}

async function siteShow({ relay, flags, positional, out }) {
  if (positional.length !== 1) throw usage('Usage: tcli site show <site> [--json]');
  const answer = await call(relay, 'GET', '/site/show', { query: { site: positional[0] } });
  out(flags.json ? JSON.stringify(answer.site, null, 2) : formatEntry(answer.site));
  return tcli().EXIT.ok;
}

async function siteSave({ relay, flags, positional, out, cwd }) {
  if (positional.length !== 1) throw usage('Usage: tcli site save <site> --file f.md|f.json');
  if (!flags.file) throw usage('save needs --file f.md|f.json');
  const entry = readEntryFile(flags.file, cwd);
  const answer = await call(relay, 'POST', '/site/save', { body: { site: positional[0], entry } });
  out(flags.json ? JSON.stringify(answer.site, null, 2) : `Saved ${answer.site.site} (v${answer.site.version})`);
  return tcli().EXIT.ok;
}

async function siteEdit({ relay, flags, positional, out, cwd }) {
  if (positional.length < 1) throw usage('Usage: tcli site edit <site> [field=value ...] [--set field=value] [--file F]');
  const site = positional[0];
  let changes = {};
  if (flags.file) changes = readEntryFile(flags.file, cwd);
  for (const token of positional.slice(1)) { const [field, value] = parsePair(token); changes[field] = value; }
  if (flags.set) { const [field, value] = parsePair(flags.set); changes[field] = value; }
  if (!Object.keys(changes).length) throw usage('edit needs at least one field=value, --set or --file');
  const answer = await call(relay, 'POST', '/site/edit', { body: { site, changes } });
  out(flags.json ? JSON.stringify(answer.site, null, 2) : `Saved ${answer.site.site} (v${answer.site.version})`);
  return tcli().EXIT.ok;
}

async function siteRm({ relay, flags, positional, out }) {
  if (positional.length !== 1) throw usage('Usage: tcli site rm <site> --yes');
  if (!flags.yes) throw usage('rm needs --yes (it deletes the entry for good)');
  const answer = await call(relay, 'POST', '/site/rm', { body: { site: positional[0], confirm: true } });
  out(flags.json ? JSON.stringify(answer, null, 2) : (answer.removed ? `Removed ${answer.site}` : `No entry for ${answer.site}`));
  return tcli().EXIT.ok;
}

async function siteSearch({ relay, flags, positional, out }) {
  if (!positional.length) throw usage('Usage: tcli site search <text>');
  const text = positional.join(' ');
  const answer = await call(relay, 'GET', '/site/search', { query: { q: text } });
  out(flags.json ? JSON.stringify(answer, null, 2) : formatSearch(answer.results || [], text));
  return tcli().EXIT.ok;
}

const GROUP = {
  help: HELP,
  commands: {
    list: { run: siteList, values: ['query'] },
    show: { run: siteShow },
    save: { run: siteSave, values: ['file'] },
    edit: { run: siteEdit, values: ['file', 'set'] },
    rm: { run: siteRm, bools: ['yes'] },
    search: { run: siteSearch },
  },
};

module.exports = { GROUP, HELP, formatList, formatEntry, formatSearch };
