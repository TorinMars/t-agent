#!/usr/bin/env node
// t-attention: the command line of T-Attention (the attention hub). It talks to /api/attention of a T-Agent Client
// with a token (Settings -> T-Attention -> CLI tokens) through lib/attention-client.js.
// See "T-Attention: CLI and Claude listener" in DESIGN.md. Node built-ins only.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const client = require('../lib/attention-client');
const pluginsLocal = require('../lib/attention-plugins-local');

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
const VALUE_FLAGS = new Set(['url', 'token', 'title', 'notes', 'priority', 'due', 'status', 'ref', 'reason', 'link', 'label', 'note', 'q', 'limit', 'timeout']);
const BOOL_FLAGS = new Set(['json', 'all', 'help', 'no-check']);
// CLI flag -> API field; an empty value clears the field (null).
const FIELD_FLAGS = { title: 'title', notes: 'notes', priority: 'priority', due: 'due_date', status: 'status', reason: 'attention_reason', link: 'link_url', label: 'link_label' };
const LISTENER_HOOK = path.resolve(__dirname, '..', 'plugins', 'listeners', 'claude', 'hook.js');

const HELP = `t-attention: tasks that need you (T-Attention)

Usage: t-attention <command> [options]

Commands
  add <title>             create a task
  list                    open tasks, grouped
    --status a,b          only these statuses
    --all                 include done, failed, cancelled
    --q <text>            search title, notes, reason
  show <id|ref:R>         one task and its history
  update <id|ref:R>       change fields (see below)
  done|review|fail|cancel|wait|work <id|ref:R> [--reason T]
                          set the status
  upsert --ref R          create or update by ref
  rm <id|ref:R>           delete a task
  login --url U --token T save the server and token
  plugins                 listeners and notifiers of
                          the server, and this machine

Fields
  --title T  --notes T  --priority high|medium|low|none
  --due YYYY-MM-DD  --status S  --ref R  --reason T
  --link URL  --label T     (an empty value clears it)
  --note T                  update, upsert: add a note
                            to the task's timeline

Statuses: todo working waiting_user review
  done failed cancelled

Options
  --json                  print JSON
  --url U  --token T      server and token for this run
  --timeout <seconds>     default 10
  --no-check              login: save without testing

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
      if (!STATUSES.includes(value)) throw new UsageError(`Unknown status: ${value} (use ${STATUSES.join(', ')})`);
      body.status = value;
    } else if (field === 'priority') {
      body.priority = value || 'none';
    } else {
      body[field] = value === '' ? null : value;
    }
  }
  return body;
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

async function run(argv, { env = process.env, print, printError } = {}) {
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
    only(flags, ['notes', 'priority', 'due', 'status', 'ref', 'reason', 'link', 'label'], 'add');
    const title = oneLine(args.join(' '));
    if (!title) throw new UsageError('add needs a title: t-attention add "Buy milk"');
    const body = { ...fieldsFrom(flags), title, source: 'cli' };
    if (flags.ref !== undefined) body.external_ref = flags.ref;
    const item = await connect(flags, env).create(body);
    show(item, `Added #${item.id} ${oneLine(item.title)} (${STATUS_LABELS[item.status] || item.status})`);
    return EXIT.ok;
  }

  if (command === 'list' || command === 'ls') {
    only(flags, ['status', 'all', 'q', 'limit'], 'list');
    if (args.length) throw new UsageError('list takes no arguments; use --q <text> to search');
    let status;
    if (flags.status !== undefined) {
      const wanted = String(flags.status).split(',').map(s => s.trim()).filter(Boolean);
      const bad = wanted.filter(s => !STATUSES.includes(s));
      if (bad.length || !wanted.length) throw new UsageError(`Unknown status: ${bad.join(', ') || '(empty)'}`);
      status = wanted.join(',');
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
    only(flags, ['title', 'notes', 'priority', 'due', 'status', 'ref', 'reason', 'link', 'label', 'note'], 'update');
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

  if (command === 'upsert') {
    only(flags, ['title', 'notes', 'priority', 'due', 'status', 'ref', 'reason', 'link', 'label', 'note'], 'upsert');
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
    only(flags, ['no-check'], 'login');
    const config = client.resolveConfig({ flags, env });
    if (!config.url || !config.token) throw new UsageError('login needs --url <server> and --token <token>');
    const url = client.normalizeUrl(config.url);
    if (!url) throw new UsageError(`The server URL is not a valid http(s) URL: ${config.url}`);
    if (!flags['no-check']) {
      await client.createClient({ url, token: config.token, timeoutMs: timeoutOf(flags) }).list({ limit: 1 });
    }
    const file = client.writeConfig({ url, token: config.token }, { env });
    const hookPointer = writeHookPointer(env);
    const result = { config: file, url, checked: !flags['no-check'], claude_hook: hookPointer };
    show(result, [
      `Saved ${file} (mode 600)`,
      `Server: ${url}${flags['no-check'] ? ' (not tested)' : ' (token works)'}`,
      hookPointer ? `Claude listener: ${LISTENER_HOOK}` : 'Claude listener: could not record its path',
    ].join('\n'));
    return EXIT.ok;
  }

  if (command === 'plugins') {
    only(flags, [], 'plugins');
    if (args.length) throw new UsageError('plugins takes no arguments');
    return pluginsCommand(flags, env, { json, print, printError });
  }

  throw new UsageError(`Unknown command: ${command} (t-attention --help)`);
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
  const parts = [yesNo(notifier.configured, 'configured', 'not configured'), modes || 'no statuses notified'];
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
    return await run(argv, { env: options.env || process.env, print, printError });
  } catch (error) {
    const code = exitFor(error);
    if (json) {
      printError(JSON.stringify({ error: (error && error.code) || (error instanceof UsageError ? 'USAGE' : String((error && error.kind) || 'ERROR').toUpperCase()), message: error.message, exit: code }));
    } else {
      let message = error.message;
      if (error && error.kind === 'auth' && error.status) message = `${message} (check the token: t-attention login)`;
      if (error && error.kind === 'conflict' && error.body && error.body.id) message = `${message} (#${error.body.id})`;
      printError(`t-attention: ${message}`);
      if (error instanceof UsageError) printError('Run t-attention --help for usage.');
    }
    return code;
  }
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; });
}

module.exports = { main, parseArgs, formatList, formatItem, formatPlugins, EXIT };
