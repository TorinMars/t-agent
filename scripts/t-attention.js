#!/usr/bin/env node
// t-attention: the command line of T-Attention (the attention hub). It talks to /api/attention of a T-Agent Client
// with a token (Settings -> T-Attention -> CLI tokens) through lib/attention-client.js.
// See "T-Attention: CLI and Claude listener" in DESIGN.md. Node built-ins only.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const client = require('../lib/attention-client');
const pluginsLocal = require('../lib/attention-plugins-local');
const listenerInstall = require('../lib/listener-install');
const importer = require('../lib/attention-import');

const EXIT = { ok: 0, usage: 1, auth: 2, notFound: 3, server: 4 };
const STATUSES = ['todo', 'working', 'waiting_user', 'review', 'done', 'failed', 'cancelled'];
const STATUS_VERBS = { done: 'done', review: 'review', fail: 'failed', cancel: 'cancelled', wait: 'waiting_user', work: 'working' };
const GROUPS = [
  { label: 'Needs you', statuses: ['waiting_user'] },
  { label: 'Review', statuses: ['review'] },
  { label: 'Working', statuses: ['working'] },
  { label: 'To do', statuses: ['todo'] },
  { label: 'Done & failed', statuses: ['done', 'failed', 'cancelled'] },
];
const STATUS_LABELS = { todo: 'To do', working: 'Working', waiting_user: 'Needs you', review: 'Review', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' };
const VALUE_FLAGS = new Set(['url', 'token', 'title', 'notes', 'priority', 'due', 'status', 'ref', 'reason', 'link', 'label', 'note', 'q', 'limit', 'timeout', 'name', 'kind', 'parent', 'custom-status', 'result', 'before', 'after', 'source']);
const BOOL_FLAGS = new Set(['json', 'all', 'help', 'no-check', 'no-hooks', 'yes', 'purge', 'top', 'bottom', 'tree', 'dry-run']);
// Status spellings: the names above and SELF-ATTENTION's ("In Progress", "Completed — Awaiting Confirmation", ...), compared in lower case
// without anything but letters.
const STATUS_ALIASES = {
  todo: 'todo', working: 'working', waitinguser: 'waiting_user', review: 'review', done: 'done', failed: 'failed', cancelled: 'cancelled', canceled: 'cancelled',
  notstarted: 'todo', inprogress: 'working', awaitingresponse: 'waiting_user', completedawaitingconfirmation: 'review', completedconfirmed: 'done',
};
const normalizeStatus = value => STATUS_ALIASES[String(value || '').toLowerCase().replace(/[^a-z]/g, '')] || null;
// The home view (list --tree): the groups in this order; finished items are only counted.
const TREE_GROUPS = [
  { key: 'needs_you', label: 'Needs you', statuses: ['waiting_user', 'review'] },
  { key: 'working', label: 'Working', statuses: ['working'] },
  { key: 'todo', label: 'To do', statuses: ['todo'] },
];
// confirm, reject, handled: status helpers on top of PATCH. from: the statuses they accept.
const HELPERS = {
  confirm: { from: ['review'], body: () => ({ status: 'done' }) },
  reject: { from: ['review'], body: reason => ({ status: 'working', attention_reason: null, activity: { kind: 'note', text: reason ? `Rejected: ${reason}` : 'Rejected' } }) },
  handled: { from: ['waiting_user'], body: () => ({ status: 'working', attention_reason: null, activity: { kind: 'note', text: 'Handled' } }) },
};
const MARKET_TIMEOUT_MS = 120000; // a download may take up to 60 s on the server
// CLI flag -> API field; an empty value clears the field (null).
const FIELD_FLAGS = { title: 'title', notes: 'notes', priority: 'priority', due: 'due_date', status: 'status', reason: 'attention_reason', link: 'link_url', label: 'link_label', 'custom-status': 'custom_status', result: 'result' };
const ITEM_FLAGS = ['title', 'notes', 'priority', 'due', 'status', 'ref', 'reason', 'link', 'label', 'parent', 'custom-status', 'result'];
const LISTENER_HOOK = path.resolve(__dirname, '..', 'plugins', 'listeners', 'claude', 'hook.js');

const HELP = `t-attention: tasks that need you (T-Attention)

Usage: t-attention <command> [options]

Commands
  add <title>             create a task (prints its id)
  list                    open tasks, grouped
    --status a,b          only these statuses
    --all                 include done, failed, cancelled
    --q <text>            search title, notes, reason
    --tree                the home view (also: tree):
                          subtasks under their parent
  show <id|ref:R>         one task and its history
  update <id|ref:R>       change fields (see below)
  done|review|fail|cancel|wait|work <id|ref:R> [--reason T]
                          set the status
  confirm <id|ref:R>      review -> done
  reject <id|ref:R> [--reason T]
                          review -> working, with a note
  handled <id|ref:R>      waiting_user -> working
  move <id|ref:R> --before T | --after T | --top
    | --bottom [--status S] [--reason T]
                          reorder inside its group
  upsert --ref R          create or update by ref
  rm <id|ref:R>           delete a task (not one that
                          has subtasks)
  import-tasks-md <file> [--dry-run] [--source S]
                          import a SELF-ATTENTION
                          TASKS.md (again: updates)
  login --url U --token T save the server and token,
                          then add the Claude Code hooks
  pair <code> --url U     connect this machine with a
                          pairing code from the page
    --name N              name of this machine
  plugins                 listeners and notifiers of
                          the server, and this machine
  plugins search [text]   the marketplace
    --kind listener|notifier
  plugins install <name|git-url> [--yes]
                          download, show what it
                          contains, ask, then install
                          (git-url: https://... or
                          git@host:path, #ref:folder)
  plugins update [name] [--yes]
                          install newer commits
  plugins remove <name> [--purge]
                          --purge: forget its settings
  plugins link <path>     use a local folder (dev)
  plugins unlink <name>
                          These need a token with
                          "Can manage plugins".

Fields
  --title T  --notes T  --priority high|medium|low|none
  --due YYYY-MM-DD  --status S  --ref R  --reason T
  --link URL  --label T     (an empty value clears it)
  --parent <id|ref:R>  --custom-status T  --result T
  --note T                  update, upsert: add a note
                            to the task's timeline

Statuses: todo working waiting_user review
  done failed cancelled (also In Progress,
  Not Started, Completed - Confirmed, ...)

Options
  --json                  print JSON
  --url U  --token T      server and token for this run
  --timeout <seconds>     default 10
  --no-check              login: save without testing
  --no-hooks              login, pair: leave
                          ~/.claude/settings.json alone

Config: flags > env TA_ATTENTION_URL, TA_ATTENTION_TOKEN
  > <data folder>/attention-client.json (~/.tagent;
  TAGENT_HOME moves it).

Exit codes: 0 ok, 1 usage, 2 auth, 3 not found,
  4 server or network
`;

class UsageError extends Error {}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (arg === '-h') { flags.help = true; continue; }
    if (!arg.startsWith('--') || arg === '-') { positional.push(arg); continue; }
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    if (BOOL_FLAGS.has(name)) {
      if (eq !== -1) throw new UsageError(`--${name} takes no value`);
      flags[name] = true;
    } else if (VALUE_FLAGS.has(name)) {
      if (eq !== -1) flags[name] = arg.slice(eq + 1);
      else {
        if (i + 1 >= argv.length) throw new UsageError(`--${name} needs a value`);
        flags[name] = argv[i += 1];
      }
    } else {
      throw new UsageError(`Unknown option: --${name}`);
    }
  }
  return { flags, positional };
}

function fieldsFrom(flags) {
  const body = {};
  for (const [flag, field] of Object.entries(FIELD_FLAGS)) {
    if (flags[flag] === undefined) continue;
    const value = String(flags[flag]);
    if (field === 'title') {
      if (!value.trim()) throw new UsageError('The title cannot be empty');
      body.title = value.trim();
    } else if (field === 'status') {
      body.status = statusFlag(value);
    } else if (field === 'priority') {
      body.priority = value || 'none';
    } else {
      body[field] = value === '' ? null : value;
    }
  }
  if (flags.parent !== undefined) {
    const value = String(flags.parent).trim();
    if (!value) body.parent_id = null;
    else if (/^ref:./.test(value)) body.parent_ref = value.slice(4);
    else if (/^#?\d+$/.test(value)) body.parent_id = Number(value.replace('#', ''));
    else throw new UsageError(`--parent needs a task id or ref:<ref>: ${value}`);
  }
  return body;
}

function statusFlag(value) {
  const status = normalizeStatus(value);
  if (!status) throw new UsageError(`Unknown status: ${value} (use ${STATUSES.join(', ')})`);
  return status;
}

function only(flags, allowed, command) {
  const common = new Set(['json', 'url', 'token', 'timeout', 'help']);
  for (const name of Object.keys(flags)) {
    if (!common.has(name) && !allowed.includes(name)) throw new UsageError(`${command} does not take --${name}`);
  }
}

// --note "text" -> an activity of kind 'note' (an event in the task's timeline; at most 500 characters).
function addNote(body, flags) {
  if (flags.note === undefined) return;
  const text = oneLine(flags.note);
  if (!text) throw new UsageError('--note cannot be empty');
  if (Array.from(text).length > 500) throw new UsageError('--note can be at most 500 characters');
  body.activity = { kind: 'note', text };
}

// <id> or ref:<external_ref>
function target(value, command) {
  if (value === undefined) throw new UsageError(`${command} needs a task id or ref:<ref>`);
  if (/^ref:./.test(value)) return { ref: value.slice(4) };
  if (/^#?\d+$/.test(value)) return { id: Number(value.replace('#', '')) };
  throw new UsageError(`Not a task id or ref:<ref>: ${value}`);
}

async function resolveId(api, spec) {
  if (spec.id) return spec.id;
  const item = await api.findByRef(spec.ref);
  if (!item) throw notFoundRef(spec.ref);
  return item.id;
}

function notFoundRef(ref) {
  return new client.AttentionClientError('not_found', `No task has the ref ${ref}`, { status: 404, code: 'NOT_FOUND' });
}

// ---------- human output (narrow terminals: short lines, no tables) ----------
function width() {
  const columns = Number(process.stdout.columns) || 80;
  return Math.max(30, Math.min(columns, 100));
}

function clip(text, max) {
  const chars = Array.from(String(text));
  return chars.length > max ? `${chars.slice(0, Math.max(1, max - 3)).join('')}...` : chars.join('');
}

function oneLine(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function extras(item) {
  const parts = [];
  if (item.priority && item.priority !== 'none') parts.push(`!${item.priority}`);
  if (item.due_date) parts.push(`due ${item.due_date}`);
  if (item.custom_status) parts.push(`[${oneLine(item.custom_status)}]`);
  if (item.status === 'failed' || item.status === 'cancelled') parts.push(STATUS_LABELS[item.status].toLowerCase());
  return parts.length ? `  ${parts.join(' ')}` : '';
}

function itemLines(item, idWidth) {
  const cols = width();
  const id = `#${item.id}`.padEnd(idWidth + 1);
  const head = `  ${id} `;
  const lines = [head + clip(oneLine(item.title), cols - head.length - extras(item).length) + extras(item)];
  if (item.attention_reason) lines.push(' '.repeat(head.length) + clip(oneLine(item.attention_reason), cols - head.length));
  return lines;
}

function formatList(items) {
  if (!items.length) return 'Nothing here.';
  const idWidth = Math.max(...items.map(item => String(item.id).length));
  const out = [];
  for (const group of GROUPS) {
    const members = items.filter(item => group.statuses.includes(item.status));
    if (!members.length) continue;
    if (out.length) out.push('');
    out.push(`${group.label} (${members.length})`);
    for (const item of members) out.push(...itemLines(item, idWidth));
  }
  return out.join('\n');
}

// MM-DD HH:MM in local time.
function shortTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = value => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// The items of one group, depth-first: children under their parent (sort_order order among siblings, as the list comes). A child whose parent is
// in another group (or not in the list) is a top-level row. -> [{ item, depth, prefix }]
function treeRows(items) {
  const ids = new Set(items.map(item => item.id));
  const children = new Map();
  const roots = [];
  for (const item of items) {
    const parent = item.parent_id;
    if (parent !== null && parent !== undefined && parent !== item.id && ids.has(parent)) {
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(item);
    } else {
      roots.push(item);
    }
  }
  const out = [];
  const seen = new Set();
  const visit = (item, lead, last, depth) => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    out.push({ item, depth, prefix: depth === 0 ? '' : `${lead}${last ? '\u2514 ' : '\u251c '}` });
    const kids = children.get(item.id) || [];
    const next = depth === 0 ? '' : `${lead}${last ? '  ' : '\u2502 '}`;
    kids.forEach((kid, index) => visit(kid, next, index === kids.length - 1, depth + 1));
  };
  for (const root of roots) visit(root, '', true, 0);
  for (const item of items) visit(item, '', true, 0); // a parent loop: shown as top-level rows
  return out;
}

// The second line of a home-view row: what the person must do for waiting_user, else the result (or the reason of a review).
function treeDetail(item) {
  if (item.status === 'waiting_user') return item.attention_reason || item.result || '';
  if (item.status === 'review') return item.result || item.attention_reason || '';
  return item.result || '';
}

// groups: [{ key, label, rows: [{ item, depth, prefix }] }]
function treeGroups(items) {
  return TREE_GROUPS.map(group => ({
    ...group,
    rows: group.statuses.flatMap(status => treeRows(items.filter(item => item.status === status))),
  }));
}

function formatTree(items, doneCount) {
  const cols = width();
  const out = [];
  for (const group of treeGroups(items)) {
    if (!group.rows.length && group.key !== 'needs_you') continue;
    if (out.length) out.push('');
    out.push(`${group.label} (${group.rows.length})`);
    if (!group.rows.length) out.push('  Nothing needs you.');
    for (const { item, prefix } of group.rows) {
      const head = `  ${prefix}#${item.id} `;
      const tail = `  ${STATUS_LABELS[item.status] || item.status}${item.custom_status ? ` \u00b7 ${oneLine(item.custom_status)}` : ''}${item.updated_at ? `  ${shortTime(item.updated_at)}` : ''}`;
      const room = Math.max(12, cols - head.length - tail.length);
      out.push(clip(head + clip(oneLine(item.title), room) + tail, cols));
      const detail = oneLine(treeDetail(item));
      if (detail) out.push(clip(`${' '.repeat(head.length)}${detail}`, cols));
    }
  }
  if (out.length) out.push('');
  out.push(`Done: ${doneCount}`);
  return out.join('\n');
}

function ago(iso, now = Date.now()) {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const min = Math.round(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hours = Math.round(min / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function firstLines(text, count, cols) {
  return String(text || '').split('\n').map(line => line.trim()).filter(Boolean).slice(0, count).map(line => clip(line, cols));
}

const ACTIVITY_LABELS = { prompt: 'Prompt', permission: 'Permission', question: 'Question', resumed: 'Resumed', turn_end: 'Turn ended', error: 'Error', session_end: 'Session ended', note: 'Note' };

function eventLine(event) {
  const when = String(event.at || '').slice(0, 16).replace('T', ' ');
  let what;
  if (event.type === 'activity' && event.data) {
    what = `${ACTIVITY_LABELS[event.data.kind] || event.data.kind}: ${oneLine(event.data.text)}`;
  } else if (event.type === 'created') {
    what = `Created${event.to_status ? ` (${STATUS_LABELS[event.to_status] || event.to_status})` : ''}`;
  } else if (event.type === 'status' || (event.from_status !== event.to_status && event.to_status)) {
    what = `${STATUS_LABELS[event.from_status] || event.from_status || '-'} -> ${STATUS_LABELS[event.to_status] || event.to_status}`;
  } else {
    what = event.type;
  }
  return clip(`  ${when} ${what}`, width());
}

// The context card first (goal, progress, what is needed, files, how to resume), then the fields and the history.
function formatItem(item, events) {
  const cols = width();
  const indent = '  ';
  const context = item.context && typeof item.context === 'object' ? item.context : {};
  const out = [`#${item.id} ${oneLine(item.title)}`, `${STATUS_LABELS[item.status] || item.status}${item.updated_at ? ` - ${ago(item.updated_at)}` : ''}`];
  const section = (label, lines) => { if (lines.length) out.push('', label, ...lines.map(line => indent + line)); };

  if (context.summary && context.summary.text) section('Summary', firstLines(context.summary.text, 3, cols - 2));
  if (context.goal) section('Goal', firstLines(context.goal, 3, cols - 2));
  const progress = [];
  if (context.last_reply) progress.push(...firstLines(context.last_reply, 3, cols - 2));
  else if (context.latest_prompt && context.latest_prompt !== context.goal) progress.push(`Asked: ${clip(oneLine(context.latest_prompt), cols - 9)}`);
  const facts = [];
  if (context.turns) facts.push(`${context.turns} turn${context.turns === 1 ? '' : 's'}`);
  if (context.turn_started_at) facts.push(`turn started ${ago(context.turn_started_at)}`);
  if (facts.length) progress.push(facts.join(', '));
  if (Array.isArray(context.files) && context.files.length) {
    progress.push(`${context.files.length} changed file${context.files.length === 1 ? '' : 's'}:`);
    for (const file of context.files.slice(0, 10)) progress.push(`  ${clip(file.path, cols - 16)} +${file.added || 0} -${file.deleted || 0}`);
    if (context.files.length > 10) progress.push(`  ... ${context.files.length - 10} more`);
  }
  section('Progress', progress);
  const needs = [];
  if (context.pending && context.pending.text) {
    needs.push(...firstLines(context.pending.text, 3, cols - 2));
    if (context.pending.tool) needs.push(`Tool: ${context.pending.tool}`);
    if (context.pending.command) needs.push(...firstLines(context.pending.command, 5, cols - 4).map(line => `$ ${line}`));
  } else if (item.attention_reason && (item.status === 'waiting_user' || item.status === 'failed')) {
    needs.push(...firstLines(item.attention_reason, 3, cols - 2));
  }
  section('Needs you', needs);

  const where = [];
  const folder = context.cwd || (item.meta && item.meta.cwd);
  if (folder) where.push(`${folder}${context.branch ? ` (${context.branch})` : ''}`);
  const host = context.host || (item.meta && item.meta.host);
  if (host) where.push(`on ${host}`);
  if (context.tagent && context.tagent.task_id) where.push(`T-Agent task ${context.tagent.task_id}, terminal ${context.tagent.terminal_id}`);
  if (context.session && context.session.resume) where.push('Resume:', `  ${context.session.resume}`);
  section('Where', where);

  const fields = [];
  if (item.custom_status) fields.push(`Custom:   ${item.custom_status}`);
  if (item.result) fields.push(`Result:   ${item.result}`);
  if (item.parent_id) fields.push(`Parent:   #${item.parent_id}`);
  if (item.priority && item.priority !== 'none') fields.push(`Priority: ${item.priority}`);
  if (item.due_date) fields.push(`Due:      ${item.due_date}`);
  if (item.attention_reason && !needs.length) fields.push(`Reason:   ${item.attention_reason}`);
  if (item.link_url) fields.push(`Link:     ${item.link_label ? `${item.link_label} ` : ''}${item.link_url}`);
  if (item.external_ref) fields.push(`Ref:      ${item.external_ref}`);
  fields.push(`Source:   ${item.source || 'user'}`);
  if (!folder && item.meta && item.meta.cwd) fields.push(`Folder:   ${item.meta.cwd}`);
  fields.push(`Updated:  ${item.updated_at || ''}`);
  out.push('', ...fields);
  if (item.notes) out.push('', item.notes);
  if (events && events.length) {
    out.push('', 'History');
    // Oldest first, like a timeline; the API gives newest first.
    for (const event of events.slice(0, 20).reverse()) out.push(eventLine(event));
  }
  return out.join('\n');
}

// ---------- commands ----------
function connect(flags, env) {
  const config = client.resolveConfig({ flags, env });
  if (!config.url || !config.token) {
    throw new client.AttentionClientError('config', `Not logged in: run t-attention login --url <server> --token <token> (or set TA_ATTENTION_URL and TA_ATTENTION_TOKEN)`);
  }
  if (!client.normalizeUrl(config.url)) throw new UsageError(`The server URL is not a valid http(s) URL: ${config.url}`);
  return client.createClient({ url: config.url, token: config.token, timeoutMs: timeoutOf(flags) });
}

function timeoutOf(flags) {
  if (flags.timeout === undefined) return client.DEFAULT_TIMEOUT_MS;
  const seconds = Number(flags.timeout);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new UsageError('--timeout needs a number of seconds');
  return Math.round(seconds * 1000);
}

async function run(argv, { env = process.env, print, printError, ask = defaultAsk } = {}) {
  const { flags, positional } = parseArgs(argv);
  const [command, ...args] = positional;
  const json = Boolean(flags.json);
  const show = (value, human) => print(json ? JSON.stringify(value, null, 2) : human);

  if (!command || command === 'help' || flags.help) {
    if (!command && !flags.help) { printError(HELP); return EXIT.usage; }
    print(HELP.trimEnd());
    return EXIT.ok;
  }

  if (command === 'add') {
    only(flags, ITEM_FLAGS.filter(flag => flag !== 'title'), 'add');
    const title = oneLine(args.join(' '));
    if (!title) throw new UsageError('add needs a title: t-attention add "Buy milk"');
    const body = { ...fieldsFrom(flags), title, source: 'cli' };
    if (flags.ref !== undefined) body.external_ref = flags.ref;
    const item = await connect(flags, env).create(body);
    show(item, `Added #${item.id} ${oneLine(item.title)} (${STATUS_LABELS[item.status] || item.status})`);
    return EXIT.ok;
  }

  if (command === 'tree' || ((command === 'list' || command === 'ls') && flags.tree)) {
    only(flags, ['tree'], command);
    if (args.length) throw new UsageError(`${command} takes no arguments`);
    const api = connect(flags, env);
    const open = await api.list({ limit: 1000 });
    const finished = await api.list({ status: 'done,failed,cancelled', limit: 1000 });
    if (json) {
      const groups = treeGroups(open).map(group => ({ key: group.key, label: group.label, items: group.rows.map(row => ({ ...row.item, depth: row.depth })) }));
      print(JSON.stringify({ groups, done: finished.length }, null, 2));
    } else {
      print(formatTree(open, finished.length));
    }
    return EXIT.ok;
  }

  if (command === 'list' || command === 'ls') {
    only(flags, ['status', 'all', 'q', 'limit'], 'list');
    if (args.length) throw new UsageError('list takes no arguments; use --q <text> to search');
    let status;
    if (flags.status !== undefined) {
      const wanted = String(flags.status).split(',').map(s => s.trim()).filter(Boolean);
      const bad = wanted.filter(s => !normalizeStatus(s));
      if (bad.length || !wanted.length) throw new UsageError(`Unknown status: ${bad.join(', ') || '(empty)'}`);
      status = [...new Set(wanted.map(normalizeStatus))].join(',');
    }
    const items = await connect(flags, env).list({ status, q: flags.q, limit: flags.limit, include_done: flags.all ? 1 : undefined });
    if (json) print(JSON.stringify({ items }, null, 2));
    else print(formatList(items));
    return EXIT.ok;
  }

  if (command === 'show') {
    only(flags, [], 'show');
    const api = connect(flags, env);
    const spec = target(args[0], 'show');
    let detail;
    if (spec.ref) {
      detail = await api.getByRef(spec.ref);
      if (!detail) throw notFoundRef(spec.ref);
      if (!detail.events) detail = await api.get(detail.item.id); // an older server: no events from the list
    } else {
      detail = await api.get(spec.id);
    }
    show(detail, formatItem(detail.item, detail.events));
    return EXIT.ok;
  }

  if (command === 'update') {
    only(flags, [...ITEM_FLAGS, 'note'], 'update');
    const spec = target(args[0], 'update');
    const body = fieldsFrom(flags);
    if (flags.ref !== undefined) body.external_ref = flags.ref === '' ? null : flags.ref;
    addNote(body, flags);
    if (!Object.keys(body).length) throw new UsageError('update needs at least one field, for example --status review');
    const api = connect(flags, env);
    const item = await api.update(await resolveId(api, spec), body);
    show(item, `Updated #${item.id} ${oneLine(item.title)} (${STATUS_LABELS[item.status] || item.status})`);
    return EXIT.ok;
  }

  if (Object.prototype.hasOwnProperty.call(STATUS_VERBS, command)) {
    only(flags, ['reason'], command);
    const spec = target(args[0], command);
    const body = { status: STATUS_VERBS[command] };
    if (flags.reason !== undefined) body.attention_reason = flags.reason === '' ? null : flags.reason;
    const api = connect(flags, env);
    const item = await api.update(await resolveId(api, spec), body);
    show(item, `#${item.id} ${oneLine(item.title)}: ${STATUS_LABELS[item.status] || item.status}`);
    return EXIT.ok;
  }

  if (Object.prototype.hasOwnProperty.call(HELPERS, command)) {
    only(flags, command === 'reject' ? ['reason'] : [], command);
    const helper = HELPERS[command];
    const api = connect(flags, env);
    const spec = target(args[0], command);
    const current = spec.ref ? await api.findByRef(spec.ref) : (await api.get(spec.id)).item;
    if (!current) throw notFoundRef(spec.ref);
    if (!helper.from.includes(current.status)) {
      const wanted = helper.from.map(status => STATUS_LABELS[status]).join(' or ');
      throw new client.AttentionClientError('invalid', `#${current.id} is ${STATUS_LABELS[current.status] || current.status}, not ${wanted}: ${command} does not apply`, { status: 400, code: 'WRONG_STATUS' });
    }
    let reason = '';
    if (flags.reason !== undefined) {
      reason = oneLine(flags.reason);
      if (Array.from(reason).length > 480) throw new UsageError('--reason can be at most 480 characters');
    }
    const item = await api.update(current.id, helper.body(reason));
    show(item, `#${item.id} ${oneLine(item.title)}: ${STATUS_LABELS[item.status] || item.status}`);
    return EXIT.ok;
  }

  if (command === 'move') {
    only(flags, ['before', 'after', 'top', 'bottom', 'status', 'reason'], 'move');
    const placements = ['before', 'after', 'top', 'bottom'].filter(name => flags[name] !== undefined);
    if (placements.length !== 1) throw new UsageError('move needs exactly one of --before T, --after T, --top or --bottom');
    const spec = target(args[0], 'move');
    const api = connect(flags, env);
    const body = {};
    const where = placements[0];
    if (where === 'top' || where === 'bottom') body.position = where;
    else body[where] = await resolveId(api, target(flags[where], `--${where}`));
    if (flags.status !== undefined) body.status = statusFlag(flags.status);
    if (flags.reason !== undefined && oneLine(flags.reason)) body.reason = oneLine(flags.reason);
    const result = await api.move(await resolveId(api, spec), body);
    const others = result.items.filter(entry => entry.id !== result.item.id).length;
    show(result, `Moved #${result.item.id} ${oneLine(result.item.title)} (${STATUS_LABELS[result.item.status] || result.item.status})${others ? `; ${others} other task${others === 1 ? '' : 's'} renumbered` : ''}`);
    return EXIT.ok;
  }

  if (command === 'import-tasks-md') {
    only(flags, ['dry-run', 'source'], command);
    if (args.length !== 1) throw new UsageError('import-tasks-md needs the path of a TASKS.md file');
    const source = flags.source === undefined ? importer.SOURCE : String(flags.source).trim();
    if (!/^[A-Za-z0-9._:@-]{1,64}$/.test(source)) throw new UsageError('--source may only contain letters, digits and . _ : @ -');
    let text;
    try { text = fs.readFileSync(args[0], 'utf8'); } catch (error) { throw new UsageError(`Cannot read ${args[0]}: ${error.code || error.message}`); }
    const parsed = importer.parseTasksMd(text);
    if (!parsed.hasHistory && !parsed.rows.length) throw new UsageError(`${args[0]} does not look like a SELF-ATTENTION TASKS.md (no task rows, no "## Status history")`);
    const plan = importer.planImport(parsed, { source });
    if (flags['dry-run']) {
      show({ dry_run: true, file: args[0], rows: plan.entries.map(entry => ({ id: entry.id, ref: entry.ref, status: entry.fields.status, parent: entry.parent, history: entry.history.length, title: entry.fields.title })), skipped: plan.skipped, warnings: plan.warnings }, formatImportPlan(args[0], plan));
      return EXIT.ok;
    }
    const summary = await importer.runImport(connect(flags, env), plan);
    show({ file: args[0], ...summary }, formatImportSummary(args[0], summary));
    return EXIT.ok;
  }

  if (command === 'upsert') {
    only(flags, [...ITEM_FLAGS, 'note'], 'upsert');
    if (!flags.ref) throw new UsageError('upsert needs --ref <ref>');
    if (args.length) throw new UsageError('upsert takes no arguments; give the title with --title');
    const body = { ...fieldsFrom(flags), source: 'cli' };
    addNote(body, flags);
    const result = await connect(flags, env).upsertByRef(flags.ref, body);
    show(result.item, `${result.created ? 'Added' : 'Updated'} #${result.item.id} ${oneLine(result.item.title)} (${STATUS_LABELS[result.item.status] || result.item.status})`);
    return EXIT.ok;
  }

  if (command === 'rm' || command === 'delete') {
    only(flags, [], command);
    const api = connect(flags, env);
    const id = await resolveId(api, target(args[0], command));
    await api.remove(id);
    show({ deleted: id }, `Deleted #${id}`);
    return EXIT.ok;
  }

  if (command === 'login') {
    only(flags, ['no-check', 'no-hooks'], 'login');
    const config = client.resolveConfig({ flags, env });
    if (!config.url || !config.token) throw new UsageError('login needs --url <server> and --token <token>');
    const url = client.normalizeUrl(config.url);
    if (!url) throw new UsageError(`The server URL is not a valid http(s) URL: ${config.url}`);
    if (!flags['no-check']) {
      await client.createClient({ url, token: config.token, timeoutMs: timeoutOf(flags) }).list({ limit: 1 });
    }
    const file = client.writeConfig({ url, token: config.token }, { env });
    const hooks = syncHooks(flags, env);
    const result = { config: file, url, checked: !flags['no-check'], claude_hook: hooks.pointer, hooks: hooks.result };
    show(result, [
      `Saved ${file} (mode 600)`,
      `Server: ${url}${flags['no-check'] ? ' (not tested)' : ' (token works)'}`,
      ...hooks.lines,
    ].join('\n'));
    return EXIT.ok;
  }

  if (command === 'pair') {
    only(flags, ['name', 'no-hooks'], 'pair');
    if (flags.token !== undefined) throw new UsageError('pair takes no --token: the pairing code gives one');
    const code = String(args[0] || '').replace(/[\s-]/g, '');
    if (!/^\d{6}$/.test(code)) throw new UsageError('pair needs the 6-digit code from the page: t-attention pair 123456 --url <server>');
    const url = client.normalizeUrl(flags.url || '');
    if (!url) throw new UsageError(flags.url ? `The server URL is not a valid http(s) URL: ${flags.url}` : 'pair needs --url <server> (the address of the page that shows the code)');
    const name = flags.name !== undefined ? oneLine(flags.name) : os.hostname();
    const claimed = await claimPairing(url, { code, name }, timeoutOf(flags));
    // The address given here reached the server, so it is the one saved.
    await client.createClient({ url, token: claimed.token, timeoutMs: timeoutOf(flags) }).list({ limit: 1 });
    const file = client.writeConfig({ url, token: claimed.token }, { env });
    const hooks = syncHooks(flags, env);
    const result = { config: file, url, token_name: claimed.name || null, claude_hook: hooks.pointer, hooks: hooks.result };
    show(result, [
      `Paired: this machine has the token "${claimed.name || 'claude listener'}" (revoke it under Settings -> T-Attention -> CLI tokens)`,
      `Saved ${file} (mode 600)`,
      `Server: ${url} (token works)`,
      ...hooks.lines,
    ].join('\n'));
    return EXIT.ok;
  }

  if (command === 'plugins') {
    if (args.length && MARKET_COMMANDS.has(args[0])) return marketCommand(args[0], args.slice(1), flags, env, { json, print, printError, ask });
    only(flags, [], 'plugins');
    if (args.length) throw new UsageError(`Unknown plugins command: ${args[0]} (search, install, update, remove, link, unlink)`);
    return pluginsCommand(flags, env, { json, print, printError });
  }

  throw new UsageError(`Unknown command: ${command} (t-attention --help)`);
}

// ---------- import ----------
function importLines(skipped, warnings) {
  const out = [];
  if (skipped.length) out.push('', 'Skipped', ...skipped.map(entry => clip(`  ${entry.id}: ${oneLine(entry.reason)}`, width())));
  if (warnings.length) out.push('', 'Warnings', ...warnings.map(text => clip(`  ${oneLine(text)}`, width())));
  return out;
}

function formatImportPlan(file, plan) {
  const cols = width();
  const out = [`Dry run, nothing was sent: ${plan.entries.length} task${plan.entries.length === 1 ? '' : 's'} from ${file}`];
  for (const entry of plan.entries) {
    const facts = [entry.fields.status, entry.parent ? `under ${entry.parent}` : '', entry.history.length ? `${entry.history.length} history` : ''].filter(Boolean).join(', ');
    out.push(clip(`  ${entry.id} -> ${entry.ref} (${facts}) ${oneLine(entry.fields.title)}`, cols));
  }
  out.push(...importLines(plan.skipped, plan.warnings));
  return out.join('\n');
}

function formatImportSummary(file, summary) {
  const cols = width();
  const out = [`Imported ${file}: ${summary.created} created, ${summary.updated} updated, ${summary.skipped.length} skipped, ${summary.notes} history note${summary.notes === 1 ? '' : 's'}`];
  for (const row of summary.rows) {
    out.push(clip(`  ${row.id} -> #${row.item_id} ${STATUS_LABELS[row.status] || row.status}${row.parent_id ? ` (under #${row.parent_id})` : ''} ${oneLine(row.title)}`, cols));
  }
  out.push(...importLines(summary.skipped, summary.warnings));
  return out.join('\n');
}

// ---------- plugins ----------
// This machine (where the CLI runs; it may not be the server's machine): each listener of this install, checked like the server does.
function localPlugins(env, serverUrl) {
  const homedir = () => (String(env.HOME || '').trim() || os.homedir());
  const dataDir = client.dataHome({ env, homedir });
  const listeners = pluginsLocal.readListeners().map(listener => {
    const check = listener.error ? { hookPath: false, loggedIn: false, toolHooks: null } : pluginsLocal.checkListener(listener.name, { dataDir, home: homedir() });
    const hints = [];
    if (!listener.error && (!check.hookPath || !check.loggedIn)) hints.push(`run: t-attention login --url ${serverUrl || '<server>'} --token <token>`);
    if (!listener.error && check.toolHooks === false) hints.push('run ta once to sync the hooks');
    return { name: listener.name, version: listener.version, error: listener.error, ...check, hints };
  });
  return { dataDir, listeners };
}

const yesNo = (value, yes, no) => (value === true ? yes : value === false ? no : null);

function listenerLine(listener, now) {
  if (listener.error) return `  ${listener.name} ${listener.version || '?'}  broken: ${oneLine(listener.error)}`;
  const state = listener.local || {};
  const parts = [state.hookPath && state.loggedIn ? 'installed here' : 'not installed here', yesNo(state.toolHooks, 'hooks synced', 'hooks not synced')];
  parts.push(`${state.itemCount || 0} open`);
  if (state.lastEventAt) parts.push(`last ${ago(state.lastEventAt, now)}`);
  return `  ${listener.name} ${listener.version || '?'}  ${parts.filter(Boolean).join(' \u00b7 ')}`;
}

function notifierLine(notifier) {
  const head = `  ${notifier.name} ${notifier.version || '?'}  `;
  if (!notifier.loaded) return `${head}failed to load: ${oneLine(notifier.error || 'unknown error')}`;
  const modes = Object.entries(notifier.statuses || {}).map(([status, mode]) => `${status}: ${mode}`).join(', ');
  const parts = [notifier.enabled === false ? 'disabled' : null, yesNo(notifier.configured, 'configured', 'not configured'), modes || 'no statuses notified'];
  if (notifier.error) parts.push(oneLine(notifier.error));
  const lines = [head + parts.filter(Boolean).join(' \u00b7 ')];
  if (notifier.summary) lines.push(`    ${clip(oneLine(notifier.summary), width() - 4)}`);
  return lines.join('\n');
}

function formatPlugins(server, localState, now = Date.now()) {
  const out = [];
  if (server) {
    const listeners = Array.isArray(server.listeners) ? server.listeners : [];
    const notifiers = Array.isArray(server.notifiers) ? server.notifiers : [];
    out.push('Listeners', ...(listeners.length ? listeners.map(item => listenerLine(item, now)) : ['  none']));
    out.push('', 'Notifiers', ...(notifiers.length ? notifiers.map(notifierLine) : ['  none']));
    out.push('');
  }
  out.push('This machine:');
  if (!localState.listeners.length) out.push('  no listeners in this install');
  for (const listener of localState.listeners) {
    if (listener.error) { out.push(`  ${listener.name}  broken: ${oneLine(listener.error)}`); continue; }
    const parts = [listener.hookPath ? 'hook path set' : 'no hook path', listener.loggedIn ? 'logged in' : 'not logged in', yesNo(listener.toolHooks, 'hooks synced', 'hooks not synced')];
    out.push(`  ${listener.name}  ${parts.filter(Boolean).join(' \u00b7 ')}`);
    for (const hint of listener.hints) out.push(`    ${hint}`);
  }
  return out.join('\n');
}

// The server part needs the config and the network; the local part always runs. Without the server: exit 4 (2 for a refused token).
async function pluginsCommand(flags, env, { json, print, printError }) {
  const config = client.resolveConfig({ flags, env });
  const serverUrl = client.normalizeUrl(config.url) || '';
  const localState = localPlugins(env, serverUrl);
  let server = null;
  let failure = null;
  try {
    if (!config.url || !config.token) throw new client.AttentionClientError('config', 'Not logged in: run t-attention login --url <server> --token <token>');
    server = (await connect(flags, env).request('GET', '/plugins')).body;
  } catch (error) {
    failure = error;
  }
  const code = !failure ? EXIT.ok : failure.kind === 'auth' ? EXIT.auth : failure instanceof UsageError ? EXIT.usage : EXIT.server;
  if (json) {
    print(JSON.stringify({ server, local: localState, ...(failure ? { error: failure.message } : {}) }, null, 2));
  } else {
    print(formatPlugins(server, localState));
    if (failure) {
      const older = failure.kind === 'not_found' ? ' (the server may be older than this CLI)' : '';
      printError(`t-attention: the server part is not shown: ${failure.message}${older}`);
    }
  }
  return code;
}

// ---------- plugins marketplace (/api/attention/market; a token with "Can manage plugins") ----------
const MARKET_COMMANDS = new Set(['search', 'install', 'update', 'remove', 'link', 'unlink']);

function marketClient(flags, env) {
  const config = client.resolveConfig({ flags, env });
  if (!config.url || !config.token) throw new client.AttentionClientError('config', 'Not logged in: run t-attention login --url <server> --token <token>');
  if (!client.normalizeUrl(config.url)) throw new UsageError(`The server URL is not a valid http(s) URL: ${config.url}`);
  return client.createClient({ url: config.url, token: config.token, timeoutMs: flags.timeout === undefined ? MARKET_TIMEOUT_MS : timeoutOf(flags) });
}

const isGitUrl = text => /^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^git@/.test(text);
const sizeText = bytes => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MiB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KiB` : `${bytes} B`);

function marketLine(entry) {
  const state = entry.builtIn ? 'built in' : entry.updateAvailable ? 'update available' : entry.installed ? 'installed' : null;
  const head = `  ${entry.name} ${entry.version || ''}`.trimEnd();
  const lines = [`${head}  ${[entry.kind, state].filter(Boolean).join(' \u00b7 ')}`];
  if (entry.description) lines.push(`    ${clip(oneLine(entry.description), width() - 4)}`);
  return lines.join('\n');
}

function formatPreview(preview) {
  const source = preview.source || {};
  const out = [
    `${preview.name} ${preview.manifest && preview.manifest.version ? preview.manifest.version : ''} (${preview.kind})`.replace('  ', ' '),
    `  ${clip(oneLine((preview.manifest && preview.manifest.description) || ''), width() - 2)}`,
    `Source:  ${source.url}${source.ref ? ` #${source.ref}` : ''}${source.path ? ` :${source.path}` : ''}`,
    `Commit:  ${preview.shortCommit} (pinned)`,
    `Files:   ${preview.files.count}, ${sizeText(preview.files.totalBytes)}`,
  ];
  if (preview.events && preview.events.length) out.push(`Events:  ${preview.events.join(', ')}`);
  if (preview.config && preview.config.length) out.push(`Settings: ${preview.config.map(field => field.label).join(', ')}`);
  if (preview.dependencies && preview.dependencies.length) out.push(`Dependencies (not installed): ${preview.dependencies.join(', ')}`);
  if (preview.update) out.push(`Update:  ${preview.update.from.version || '?'} -> ${preview.update.to.version || '?'}, ${preview.update.filesChanged} file${preview.update.filesChanged === 1 ? '' : 's'} changed`);
  for (const warning of preview.warnings || []) out.push(`Warning: ${warning}`);
  out.push('A plugin runs code on the server; install only plugins you trust.');
  return out.join('\n');
}

// Prepare -> preview -> y/N (or --yes) -> install. Returns the installed plugin, or null when the user said no.
async function prepareAndInstall(api, body, flags, { json, print, printError, ask }) {
  const preview = (await api.request('POST', '/market/prepare', { body })).body;
  if (!json) print(formatPreview(preview));
  if (!flags.yes) {
    const ok = await ask(`Install ${preview.name} at ${preview.shortCommit}? [y/N] `);
    if (!ok) { if (json) print(JSON.stringify({ installed: false, preview }, null, 2)); else printError('Not installed.'); return null; }
  }
  const result = (await api.request('POST', '/market/install', { body: { prepareId: preview.prepareId, confirm: true } })).body;
  if (json) print(JSON.stringify({ installed: true, preview, plugin: result.plugin }, null, 2));
  else print(`${preview.update ? 'Updated' : 'Installed'} ${preview.name} ${preview.manifest.version} (${preview.shortCommit})`);
  return result.plugin;
}

async function marketCommand(sub, args, flags, env, io) {
  const { json, print } = io;
  const show = (value, human) => print(json ? JSON.stringify(value, null, 2) : human);
  if (sub === 'search') {
    only(flags, ['kind'], 'plugins search');
    if (flags.kind !== undefined && !['listener', 'notifier'].includes(flags.kind)) throw new UsageError('--kind must be listener or notifier');
    const result = (await marketClient(flags, env).request('GET', '/market', { query: { q: args.join(' ').trim(), kind: flags.kind } })).body;
    if (json) { print(JSON.stringify(result, null, 2)); return EXIT.ok; }
    const plugins = Array.isArray(result.plugins) ? result.plugins : [];
    print(plugins.length ? plugins.map(marketLine).join('\n') : 'No plugins found.');
    for (const source of result.sources || []) {
      if (source.error) io.printError(`t-attention: index ${source.url}: ${source.error}${source.stale ? ' (showing the saved copy)' : ''}`);
    }
    return EXIT.ok;
  }
  if (sub === 'install') {
    only(flags, ['yes'], 'plugins install');
    if (args.length !== 1) throw new UsageError('plugins install needs one plugin name or Git URL');
    const target = args[0];
    const body = isGitUrl(target) ? { source: target } : { source: { name: target } };
    await prepareAndInstall(marketClient(flags, env), body, flags, io);
    return EXIT.ok;
  }
  if (sub === 'update') {
    only(flags, ['yes'], 'plugins update');
    if (args.length > 1) throw new UsageError('plugins update takes at most one name');
    const api = marketClient(flags, env);
    const { updates = [] } = (await api.request('GET', '/market/updates')).body || {};
    const wanted = args[0];
    if (wanted && !updates.some(item => item.name === wanted)) throw new client.AttentionClientError('not_found', `${wanted} is not installed from the marketplace or Git`, { status: 404 });
    const due = updates.filter(item => item.updateAvailable && (!wanted || item.name === wanted));
    for (const item of updates.filter(entry => entry.error && (!wanted || entry.name === wanted))) io.printError(`t-attention: ${item.name}: ${item.error}`);
    if (!due.length) { show({ updates, updated: [] }, wanted ? `${wanted} is up to date.` : 'Everything is up to date.'); return EXIT.ok; }
    const updated = [];
    for (const item of due) {
      const plugin = await prepareAndInstall(api, { update: item.name }, flags, { ...io, json: false, print: json ? () => {} : print });
      if (plugin) updated.push(item.name);
    }
    if (json) print(JSON.stringify({ updates, updated }, null, 2));
    return EXIT.ok;
  }
  if (sub === 'remove') {
    only(flags, ['purge'], 'plugins remove');
    if (args.length !== 1) throw new UsageError('plugins remove needs one plugin name');
    const result = (await marketClient(flags, env).request('DELETE', `/market/plugins/${encodeURIComponent(args[0])}`, { query: { purge: flags.purge ? 1 : undefined } })).body;
    show(result, `Removed ${result.name}${result.purged ? ' and its settings' : ''}`);
    return EXIT.ok;
  }
  if (sub === 'link') {
    only(flags, [], 'plugins link');
    if (args.length !== 1) throw new UsageError('plugins link needs the path of a local plugin folder');
    const result = (await marketClient(flags, env).request('POST', '/market/link', { body: { path: path.resolve(args[0]) } })).body;
    show(result, `Linked ${result.plugin.name} (${result.plugin.kind}, dev) from ${result.plugin.folder}`);
    return EXIT.ok;
  }
  // unlink
  only(flags, [], 'plugins unlink');
  if (args.length !== 1) throw new UsageError('plugins unlink needs one plugin name');
  const result = (await marketClient(flags, env).request('DELETE', `/market/link/${encodeURIComponent(args[0])}`)).body;
  show(result, `Unlinked ${result.name}`);
  return EXIT.ok;
}

// y/N from stdin: true only for y or yes. No terminal input (closed stdin) is a no.
function defaultAsk(question) {
  return new Promise(resolve => {
    process.stderr.write(question);
    const readline = require('node:readline');
    const rl = readline.createInterface({ input: process.stdin });
    let answered = false;
    rl.once('line', line => { answered = true; rl.close(); resolve(/^\s*y(?:es)?\s*$/i.test(line)); });
    rl.once('close', () => { if (!answered) resolve(false); });
  });
}

// After login / pair: the hook path and the Claude Code hooks (lib/listener-install.js), or only the hook path with --no-hooks.
// A ~/.claude/settings.json that cannot be merged is left alone and reported; the login itself has succeeded.
function syncHooks(flags, env) {
  if (flags['no-hooks']) {
    const pointer = writeHookPointer(env);
    return { pointer, result: null, lines: [pointer ? `Claude listener: ${LISTENER_HOOK}` : 'Claude listener: could not record its path', 'Claude Code hooks: skipped (--no-hooks)'] };
  }
  const home = String(env.HOME || '').trim() || os.homedir();
  try {
    const result = listenerInstall.installClaudeHooks({ dataDir: client.dataHome({ env }), home, hookPath: LISTENER_HOOK });
    const what = !result.changed ? 'already in place'
      : [result.added ? `added ${result.added} ${result.added === 1 ? 'entry' : 'entries'}` : '', result.updated ? `updated ${result.updated}` : ''].filter(Boolean).join(', ');
    const lines = [`Claude listener: ${LISTENER_HOOK}`, `Claude Code hooks: ${what} in ${result.settingsFile}`];
    if (result.backup) lines.push(`  a copy of the file before the change: ${result.backup}`);
    return { pointer: result.pathFile, result: { settings: result.settingsFile, changed: result.changed, added: result.added, updated: result.updated, backup: result.backup }, lines };
  } catch (error) {
    const pointer = writeHookPointer(env);
    return { pointer, result: { error: error.message }, lines: [pointer ? `Claude listener: ${LISTENER_HOOK}` : 'Claude listener: could not record its path', `Claude Code hooks: not changed: ${error.message}`] };
  }
}

// POST <url>/api/attention/pairing/claim { code, name } -> { url, token, name }. No token is sent: the code is the credential.
function claimPairing(url, body, timeoutMs) {
  const target = new URL(`${url}${client.API_BASE}/pairing/claim`);
  const payload = Buffer.from(JSON.stringify(body));
  const transport = target.protocol === 'https:' ? require('node:https') : require('node:http');
  return new Promise((resolve, reject) => {
    const req = transport.request(target, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Content-Length': payload.length } }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 65536) req.destroy(); else chunks.push(chunk); });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { parsed = null; }
        if (res.statusCode === 201 && parsed && typeof parsed.token === 'string') return resolve(parsed);
        const message = parsed && typeof parsed.message === 'string' ? parsed.message : `The server answered HTTP ${res.statusCode}${res.statusCode === 404 ? ' (it may be older than this CLI, or the URL is wrong)' : ''}`;
        const kind = res.statusCode === 400 ? 'invalid' : res.statusCode === 404 ? 'not_found' : 'server';
        return reject(new client.AttentionClientError(kind, message, { status: res.statusCode, code: parsed && parsed.error }));
      });
      res.on('error', error => reject(new client.AttentionClientError('network', `Network error: ${error.message}`)));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new client.AttentionClientError('timeout', `The server did not answer within ${Math.round(timeoutMs / 100) / 10} s`)));
    req.on('error', error => reject(error instanceof client.AttentionClientError ? error : new client.AttentionClientError('network', `Cannot reach the server: ${error.code || error.message}`)));
    req.end(payload);
  });
}

// The Claude Code hook in rules/claude/settings.json is the same on every machine; it finds this install's hook
// script through <data folder>/listeners/claude-hook.path, written here.
function writeHookPointer(env) {
  try {
    const dir = path.join(client.dataHome({ env }), 'listeners');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, 'claude-hook.path');
    fs.writeFileSync(file, `${LISTENER_HOOK}\n`, { mode: 0o600 });
    return file;
  } catch {
    return null;
  }
}

function exitFor(error) {
  if (error instanceof UsageError) return EXIT.usage;
  switch (error && error.kind) {
    case 'config': case 'auth': return EXIT.auth;
    case 'not_found': return EXIT.notFound;
    case 'invalid': case 'conflict': return EXIT.usage;
    case 'server': case 'network': case 'timeout': return EXIT.server;
    default: return EXIT.server;
  }
}

async function main(argv = process.argv.slice(2), options = {}) {
  const print = options.print || (text => process.stdout.write(`${text}\n`));
  const printError = options.printError || (text => process.stderr.write(`${text}\n`));
  const json = argv.includes('--json');
  try {
    return await run(argv, { env: options.env || process.env, print, printError, ask: options.ask || defaultAsk });
  } catch (error) {
    const code = exitFor(error);
    if (json) {
      printError(JSON.stringify({ error: (error && error.code) || (error instanceof UsageError ? 'USAGE' : String((error && error.kind) || 'ERROR').toUpperCase()), message: error.message, exit: code }));
    } else {
      let message = error.message;
      if (error && error.kind === 'auth' && error.status && error.status !== 403) message = `${message} (check the token: t-attention login)`;
      if (error && error.kind === 'conflict' && error.body && error.body.id) message = `${message} (#${error.body.id})`;
      if (error && error.kind === 'conflict' && error.body && Array.isArray(error.body.children)) message = `${message} (subtasks: ${error.body.children.map(id => `#${id}`).join(', ')})`;
      printError(`t-attention: ${message}`);
      if (error instanceof UsageError) printError('Run t-attention --help for usage.');
    }
    return code;
  }
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; });
}

module.exports = { main, parseArgs, formatList, formatItem, formatTree, formatPlugins, normalizeStatus, EXIT };
