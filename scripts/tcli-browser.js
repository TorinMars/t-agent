// `tcli browser ...`: drives the person's browser through the T-Agent browser extension ("Browser extension" in docs/design/browser-extension.md). Every command is one
// call to the relay /api/tcli/browser (routes/browser-ext.js) with the terminal's hook token; T-Agent passes it to the extension over its socket
// (services/browser-bridge.js). The default output is short text for a person or a model; --json prints the answer as it came.
// Loaded by scripts/tcli.js, which hands over its HTTP and error helpers. Node built-ins only.
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_TIMEOUT_MS = 30_000;
const HTTP_EXTRA_MS = 15_000; // the relay answers a timeout itself; this only guards against a T-Agent that stopped answering
const BODY_PREVIEW = 4000;
const UPLOAD_MAX_BYTES = 100 * 1024 * 1024; // the limit of services/browser-upload.js, checked there again
const SINCE_EPOCH = 1e11; // console --since below this is a duration (ms back from now), above an epoch time
const CONSOLE_LEVELS = ['error', 'warn', 'warning', 'log', 'info', 'debug', 'dialog'];

const HELP = `tcli browser: drive this computer's browser
through the T-Agent extension (pair it in
Settings > Tasks and files > Browser extension)

Usage: tcli browser <command> [options]

Tabs (only tabs T-Agent opened, in the
"T-Agent" tab group, or tabs the person handed
over with the extension button)
  status                 the connected browser
    --verbose            + methods, recent events
  tabs                   tabs T-Agent may use
  open <url>             new tab in the group, in
                         T-Agent's own window
                         behind the person's: it
                         never takes their focus
    --active             show it to the person
    --keep               keep it open after your
                         turn (tell the person)
    --record             record from the first
                         load (takes the record
                         start options), in a
                         new window in front, for
                         the person to use; the
                         tabs the page opens
                         join the recording
    --background         with --record: its own
                         window behind (you
                         drive the page)
  close [tab]            close (a handed tab is
                         released, never closed)
  go [tab] <url>         navigate (--no-wait)
  back | forward | reload
  activate <tab>         bring a tab to the front
                         (only when the person
                         asked to see it)

  Your tabs close by themselves 2 minutes after
  your turn ends, when the terminal closes, or
  after 30 minutes unused. A tab the person
  clicks or types in becomes theirs. Page
  dialogs are answered while the debugger runs
  (alert accepted, confirm and prompt dismissed)
  and reported as "dialog: <type> <message>";
  else a dialog blocks the page: see dialog.

Page
  snapshot               one line per element:
                         e12 button "Sign in"
                         (with open shadow DOM and
                         same-origin iframes; a
                         node keeps its ref until
                         the address changes)
    --text | --html      text or HTML instead
    --selector S         only inside S
    --filter interactive only what you can click
                         or type in
    --diff               only what was added (+),
                         removed (-) or changed (~)
                         since the last snapshot
    --max-bytes N        (200000)
  query <selector>       elements matching S
    --all [--limit N]    every match (50)
  click <target>         --right --middle
                         --double --modifiers M
  type <target> <text>   --clear --submit
  press <key>            Enter, Tab, ArrowDown, a
                         (--modifiers Shift,Meta)
  hover <target>
  scroll [target]        --dy N (600) --dx N
  select <target> <value...>
  fill <target>=<value>...  several fields at once:
                         text, select (value or
                         label), checkbox / radio
                         (true|false), date
                         (2026-01-31), time (09:30)
    --json '{"e3":"Ann"}'  the fields as JSON (also
                         --fields; then --json is
                         the output)
  check <target>         tick a checkbox or radio
    --off                untick it
  drag <target> <to>     to a target or x,y
    --steps N (10)       mouse moves on the way
    --html5 | --mouse    force the kind of drag
  upload <target> <file...>  files for an
                         input type=file (at most
                         20, 100 MiB each)
  dialog [status]        is an alert / confirm /
                         prompt blocking the page?
  dialog accept [--text T] | dialog dismiss
  eval <js>              run JS in the page
    --file f.js          from a file
    --no-await           do not await a promise
  wait                   until one of these:
    --selector S | --text T | --url U |
    --idle MS (network idle)  [--timeout MS]
  shot [-o file.png]     screenshot (--full,
                         --target T, --jpeg,
                         --quality N; -o - for
                         stdout); the tab need
                         not be active
    --zoom x,y,w,h       a part of the viewport,
                         enlarged (--scale N, 2)
    --annotate           the refs of the last
                         snapshot drawn on it
  console                console lines and errors
    --level error,warn,log,info  only these
    --pattern RE         matching text (any case)
    --since MS           the last MS milliseconds
                         (or since an epoch time)
    --limit N

  <target> is e12 (a ref of the last snapshot),
  css:<selector>, text:<visible text> or x,y.

Network (uses Chrome's debugger: a yellow bar
shows while it runs)
  net start              start capturing
    --filter U --type XHR,Fetch --no-bodies
    --max-body N
  net stop
  net list               --filter U --type T
                         --since MS --limit N
  net get <req_id>       one request in full
    --raw                real secret values (only
                         to you; never stored)
    --no-body | --body-out file
  fetch <url>            fetch inside the page
                         (its cookies are sent)
    -X M  -H 'K: V'...  -d body  --raw
    --no-credentials  --body-out file

Recordings (clicks, input, navigation, network,
DOM changes; kept 14 days in T-Agent; actions of
your commands have source "agent", the person's
"user")
  record start           --no-network --no-dom
                         --no-bodies
    --types T            bodies only for these
                         types: XHR,Fetch,Document
    --drop-other-types   and no items for others
    --max-body N         cut bodies at N bytes
  record stop [id]
  record list
  record show <id>
  record items <id>      JSON lines (-o file)
    --kind net,click,..  request response ws
                         click input change
                         submit key nav dom
                         console (net = the 3
                         network kinds)
    --type XHR,Fetch     resource type
    --source agent|user  who did it
    --tab T              one tab of it
    --url U | /regex/    --status 4xx,500
    --limit N --offset N
  record requests <id>   request + response as
                         one line per request;
                         no Script, Stylesheet,
                         Image, Font, Media
    --all | --type T     keep them / only T
    --url U --status S --limit N --offset N
    --tab T              one tab (a tab column
                         shows when the lines
                         come from several tabs)
    --json | -o file     JSON lines with headers
                         and bodies
  record rm <id> --yes

Options (every command)
  --tab T                the tab (else the last
                         one used, else the active
                         one)
  --browser B            a paired browser's id
  --timeout MS           how long to wait (30000)
  --json                 print the JSON answer

Secrets (cookies, tokens, passwords) are shown
as <redacted:N> unless --raw is given.
`;

function createBrowserGroup(h) {
  const { send, readJson, failureOf, networkFailure, CliError, usage, EXIT, humanSize } = h;
  // record items / record requests (scripts/tcli-browser-records.js): reading a recording with filters.
  const records = require('./tcli-browser-records').createRecordCommands(h);

  // ── Arguments ──
  // spec: { values, bools, multi } (names without --), plus the options every command takes. `-X`, `-H`, `-d`, `-o` are short names.
  const SHORT = { '-X': 'method', '-H': 'header', '-d': 'data', '-o': 'output', '-h': 'help' };
  function parse(argv, { values = [], bools = [], multi = [] } = {}) {
    const allowedValues = new Set([...values, ...multi, 'tab', 'browser', 'timeout']);
    const allowedBools = new Set([...bools, 'json', 'help']);
    const repeated = new Set(multi);
    const flags = {};
    const positional = [];
    for (let i = 0; i < argv.length; i += 1) {
      let arg = argv[i];
      if (arg === '--') { positional.push(...argv.slice(i + 1)); break; }
      if (SHORT[arg]) arg = `--${SHORT[arg]}`;
      if (!arg.startsWith('--')) { positional.push(arg); continue; }
      let name = arg.slice(2);
      let value;
      const eq = name.indexOf('=');
      if (eq >= 0) { value = name.slice(eq + 1); name = name.slice(0, eq); }
      if (allowedBools.has(name)) {
        if (value !== undefined) throw usage(`--${name} takes no value`);
        flags[name] = true;
      } else if (allowedValues.has(name)) {
        if (value === undefined) {
          if (i + 1 >= argv.length) throw usage(`--${name} needs a value`);
          value = argv[i += 1];
        }
        if (repeated.has(name)) (flags[name] = flags[name] || []).push(value);
        else flags[name] = value;
      } else throw usage(`Unknown option --${name}; see tcli browser help`);
    }
    return { flags, positional };
  }

  const wholeNumber = (value, name, { min = 0 } = {}) => {
    if (value === undefined) return undefined;
    if (!/^-?\d+$/.test(String(value)) || Number(value) < min) throw usage(`${name} must be a whole number${min > 0 ? ` of at least ${min}` : ''}`);
    return Number(value);
  };
  const tabNumber = value => wholeNumber(value, 'The tab', { min: 0 });

  // e12 | css:<selector> | text:<visible text> | x,y
  function target(text) {
    if (typeof text !== 'string' || !text) throw usage('A target is needed: e12, css:<selector>, text:<visible text> or x,y');
    if (/^e\d+$/.test(text)) return { ref: text };
    if (text.startsWith('css:') && text.length > 4) return { selector: text.slice(4) };
    if (text.startsWith('text:') && text.length > 5) return { text: text.slice(5) };
    const point = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(text);
    if (point) return { x: Number(point[1]), y: Number(point[2]) };
    throw usage(`"${text}" is not a target: use e12 (a ref from snapshot), css:<selector>, text:<visible text> or x,y`);
  }
  // fill: the `=` between target and value is the first one outside [...] and quotes, so css:input[name=email]=a@b.c works.
  function splitPair(text) {
    let depth = 0;
    let quoteChar = null;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (quoteChar) { if (ch === quoteChar) quoteChar = null; continue; }
      if (ch === '"' || ch === "'") quoteChar = ch;
      else if (ch === '[' || ch === '(') depth += 1;
      else if (ch === ']' || ch === ')') depth = Math.max(0, depth - 1);
      else if (ch === '=' && depth === 0) return i;
    }
    return -1;
  }
  const modifiers = value => (value ? String(value).split(',').map(item => item.trim()).filter(Boolean) : undefined);
  const list = value => (value ? String(value).split(',').map(item => item.trim()).filter(Boolean) : undefined);
  const prune = object => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));

  // The params every command shares: --tab and --browser.
  const common = flags => prune({ tab_id: tabNumber(flags.tab), browser_id: flags.browser });

  // The options of `record start` and `open --record`. --types takes CDP resource types in any case (--type is the same).
  const RESOURCE_TYPES = ['Document', 'Stylesheet', 'Image', 'Media', 'Font', 'Script', 'TextTrack', 'XHR', 'Fetch', 'Prefetch', 'EventSource', 'WebSocket', 'Manifest', 'SignedExchange', 'Ping', 'CSPViolationReport', 'Preflight', 'Other'];
  const RECORD_VALUES = ['types', 'type', 'max-body'];
  const RECORD_BOOLS = ['no-network', 'no-dom', 'no-bodies', 'drop-other-types'];
  function recordParams(flags) {
    let types;
    if (flags.types !== undefined || flags.type !== undefined) {
      const given = [...(list(flags.types) || []), ...(list(flags.type) || [])];
      if (!given.length) throw usage('--types needs a list such as XHR,Fetch,Document');
      types = [...new Set(given.map(name => {
        const known = RESOURCE_TYPES.find(type => type.toLowerCase() === name.toLowerCase());
        if (!known) throw usage(`--types: "${name}" is not a resource type; use ${RESOURCE_TYPES.join(', ')}`);
        return known;
      }))];
    }
    if (flags['drop-other-types'] && !types) throw usage('--drop-other-types needs --types');
    return prune({
      network: flags['no-network'] ? false : undefined, dom: flags['no-dom'] ? false : undefined, bodies: flags['no-bodies'] ? false : undefined,
      types, drop_other_types: flags['drop-other-types'] ? true : undefined, max_body_bytes: wholeNumber(flags['max-body'], '--max-body', { min: 0 }),
    });
  }

  // ── HTTP ──
  function request(relay, method, route, { body, timeoutMs = DEFAULT_TIMEOUT_MS + HTTP_EXTRA_MS, stream = null } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const req = send(relay, method, route, {
        timeoutMs,
        headers: { Accept: 'application/json', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}) },
      });
      req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'TIMEOUT' })));
      req.on('error', error => reject(error instanceof CliError ? error : networkFailure(error)));
      req.on('response', async response => {
        try {
          if (stream && response.statusCode === 200) {
            req.setTimeout(0);
            response.on('error', error => reject(networkFailure(error)));
            stream.target.on('error', error => reject(new CliError(`Cannot write: ${error.message}`, EXIT.usage)));
            const done = () => resolve(null);
            if (stream.isStdout) { response.on('end', done); response.pipe(stream.target, { end: false }); }
            else { stream.target.on('finish', done); response.pipe(stream.target); }
            return;
          }
          const answer = await readJson(response);
          if (response.statusCode >= 200 && response.statusCode < 300) resolve(answer);
          else reject(failureOf(response.statusCode, answer));
        } catch (error) { reject(networkFailure(error)); }
      });
      req.end(payload || undefined);
    });
  }

  // Page dialogs (alert, confirm, prompt, beforeunload) the extension answered since the tab's last command come with the next result: one
  // line each on stderr, so the text output stays as it was ("Focus and dialogs" in docs/design/browser-extension.md).
  async function cmd(ctx, method, params = {}, { timeoutMs } = {}) {
    const wait = timeoutMs || DEFAULT_TIMEOUT_MS;
    const inner = Number.isFinite(params.timeout_ms) ? params.timeout_ms + 5000 : 0;
    const answer = await request(ctx.relay(), 'POST', '/browser/cmd', {
      body: prune({ method, params, timeout_ms: timeoutMs }),
      timeoutMs: Math.max(wait, inner) + HTTP_EXTRA_MS,
    });
    for (const dialog of (answer && Array.isArray(answer.dialogs) ? answer.dialogs : [])) {
      ctx.stderr.write(`dialog: ${dialog.type} ${quote(oneLine(dialog.message, 200))} (${dialog.handled || 'answered'})\n`);
    }
    return answer;
  }

  // ── Output ──
  const quote = text => JSON.stringify(String(text));
  const oneLine = (text, max = 120) => {
    const flat = String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  };
  const time = ms => {
    const date = new Date(Number(ms));
    return Number.isFinite(date.getTime()) ? date.toISOString().slice(11, 23) : '--:--:--';
  };
  const when = value => (typeof value === 'string' && value.length >= 16 ? value.slice(0, 16).replace('T', ' ') : '-');

  function tabLine(tab) {
    if (!tab) return '';
    const marks = [tab.how === 'handed' ? 'handed' : 'group'];
    if (tab.keep) marks.push('keep');
    if (tab.capturing) marks.push('net');
    if (tab.recording_id) marks.push(`rec ${tab.recording_id}`);
    return `${String(tab.tab_id).padStart(5)}${tab.active ? '*' : ' '} [${marks.join(', ')}] ${oneLine(tab.title, 60) || '(no title)'}  ${tab.url || ''}`;
  }

  function elementLine(element) {
    const kind = element.role || element.tag || 'element';
    const label = element.name || element.text || '';
    const parts = [`${element.ref || '-'} ${kind}`];
    if (label) parts.push(quote(oneLine(label, 80)));
    if (element.type && element.tag === 'input') parts.push(`type=${element.type}`);
    if (element.value !== undefined && element.value !== null && element.value !== '') parts.push(`value=${quote(oneLine(element.value, 60))}`);
    if (element.href) parts.push(`-> ${oneLine(element.href, 100)}`);
    if (element.checked) parts.push('[checked]');
    if (element.disabled) parts.push('[disabled]');
    if (element.in_viewport === false) parts.push('(off screen)');
    if (element.frame) parts.push('(in frame)');
    if (element.shadow) parts.push('(in shadow DOM)');
    return parts.join(' ');
  }
  // snapshot --diff: + added, - removed, ~ changed (with what it was).
  function diffLines(diff) {
    const lines = [];
    for (const element of diff.added || []) lines.push(`+ ${elementLine(element)}`);
    for (const element of diff.removed || []) lines.push(`- ${elementLine(element)}`);
    for (const element of diff.changed || []) {
      const was = Object.entries(element.was || {}).map(([key, value]) => `${key}=${value === null ? '-' : quote(oneLine(value, 60))}`).join(' ');
      lines.push(`~ ${elementLine(element)}  (was ${was})`);
    }
    return lines;
  }

  // `status` without --verbose: the connection, each paired browser (name, extension version, browser, paired, connected since) and counts; the
  // method names and the recent events only with --verbose.
  function slimStatus(answer) {
    const browsers = (answer && answer.browsers) || [];
    return {
      protocol: answer && answer.protocol, connected: Boolean(answer && answer.connected), active_browser_id: (answer && answer.active_browser_id) || null,
      method_count: Array.isArray(answer && answer.methods) ? answer.methods.length : null,
      ...(answer && answer.extension_version ? { extension_version: answer.extension_version } : {}),
      browsers: browsers.map(browser => ({
        browser_id: browser.browser_id, name: browser.name, version: browser.version || null,
        browser: browser.browser && browser.browser.name ? browser.browser.name : null,
        online: Boolean(browser.online), active: Boolean(browser.active),
        paired_at: browser.created_at || null, connected_at: browser.connected_at || null, last_seen_at: browser.last_seen_at || null,
        methods: Number.isFinite(browser.methods) ? browser.methods : null,
        recent_event_count: Array.isArray(browser.recent_events) ? browser.recent_events.length : 0,
      })),
    };
  }

  function statusText(answer, { verbose = false } = {}) {
    const browsers = (answer && answer.browsers) || [];
    const lines = [];
    const active = browsers.find(browser => browser.active);
    if (active) {
      const kind = active.browser && active.browser.name ? ` · ${active.browser.name}` : '';
      lines.push(`Connected: ${active.name} (${active.browser_id}) · extension ${active.version || '?'}${kind}`);
      lines.push(`  connected since ${when(active.connected_at)} · paired ${when(active.created_at)}${Number.isFinite(active.methods) ? ` · ${active.methods} methods` : ''}`);
      if (answer.extension_version && active.version && olderVersion(active.version, answer.extension_version)) {
        lines.push(`  T-Agent has extension ${answer.extension_version}: it reloads itself from 1.0.5 on; reload it once in chrome://extensions if it stays at ${active.version}`);
      }
    } else lines.push('No browser is connected.');
    for (const browser of browsers.filter(item => !item.active)) {
      lines.push(`  ${browser.name} (${browser.browser_id}): ${browser.online ? 'online' : `offline, last seen ${when(browser.last_seen_at)}`}`);
    }
    if (!browsers.length) lines.push('Pair one in T-Agent: Settings > Tasks and files > Browser extension.');
    else if (!active) lines.push('Open Chrome with the T-Agent extension on this computer; it connects by itself.');
    if (verbose) {
      if (Array.isArray(answer && answer.methods)) lines.push(`Methods: ${answer.methods.join(', ')}`);
      for (const browser of browsers) {
        const events = browser.recent_events || [];
        if (!events.length) continue;
        lines.push(`Recent events of ${browser.name}:`);
        for (const event of events) lines.push(`  ${when(event.at)} ${event.event}${event.tab_id === null || event.tab_id === undefined ? '' : ` tab ${event.tab_id}`}${event.url ? `  ${event.url}` : ''}`);
      }
    }
    return lines.join('\n');
  }

  const olderVersion = (a, b) => {
    const x = String(a).split('.').map(Number);
    const y = String(b).split('.').map(Number);
    if (x.some(Number.isNaN) || y.some(Number.isNaN)) return false;
    for (let i = 0; i < Math.max(x.length, y.length); i += 1) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
    return false;
  };

  function requestLine(entry) {
    const size = Number.isFinite(entry.size) ? humanSize(entry.size) : '-';
    const duration = Number.isFinite(entry.duration_ms) ? `${Math.round(entry.duration_ms)}ms` : '-';
    const status = entry.failed ? 'FAIL' : entry.status === undefined || entry.status === null ? '...' : String(entry.status);
    return `${String(entry.req_id).padEnd(8)} ${String(entry.method || '').padEnd(6)} ${status.padStart(4)} ${String(entry.type || '').padEnd(9)} ${size.padStart(7)} ${duration.padStart(7)}${entry.from_cache ? ' cache' : ''}  ${entry.url || ''}`;
  }

  const headerLines = (headers, indent = '  ') => {
    if (!headers) return [];
    const entries = Array.isArray(headers) ? headers.map(item => [item.name, item.value]) : Object.entries(headers);
    return entries.map(([name, value]) => `${indent}${name}: ${Array.isArray(value) ? value.join(', ') : value}`);
  };

  function bodyText(part, { full = false } = {}) {
    if (!part) return [];
    if (typeof part.body === 'string') {
      const cut = !full && part.body.length > BODY_PREVIEW;
      const lines = [cut ? `${part.body.slice(0, BODY_PREVIEW)}…` : part.body];
      if (cut) lines.push(`(${part.body.length} characters; the whole body: --body-out file or --json)`);
      if (part.body_truncated || part.truncated) lines.push('(the browser cut this body at its size limit)');
      return lines;
    }
    if (typeof part.body_base64 === 'string') return [`(binary body, ${humanSize(Math.floor(part.body_base64.length * 0.75))}; save it with --body-out file)`];
    return [];
  }

  function netGetText(answer) {
    const lines = [`${answer.method || ''} ${answer.url || ''}`, `${answer.status === undefined ? '' : `Status ${answer.status}`}${answer.type ? ` · ${answer.type}` : ''}${answer.response && answer.response.mime ? ` · ${answer.response.mime}` : ''}`];
    if (answer.request) {
      lines.push('Request headers:', ...headerLines(answer.request.headers));
      if (typeof answer.request.post_data === 'string') lines.push('Request body:', answer.request.post_data + (answer.request.post_data_truncated ? '…' : ''));
    }
    if (answer.response) {
      lines.push('Response headers:', ...headerLines(answer.response.headers));
      const body = bodyText(answer.response);
      if (body.length) lines.push('Response body:', ...body);
    }
    if (Array.isArray(answer.frames)) {
      lines.push(`Frames (${answer.frames.length}):`);
      for (const frame of answer.frames.slice(-50)) lines.push(`  ${time(frame.at)} ${frame.dir === 'sent' ? '>' : '<'} ${oneLine(frame.data, 200)}`);
    }
    return lines.join('\n');
  }

  function writeBody(file, part, cwd) {
    const target = path.resolve(cwd, file);
    if (typeof part.body_base64 === 'string') fs.writeFileSync(target, Buffer.from(part.body_base64, 'base64'));
    else fs.writeFileSync(target, typeof part.body === 'string' ? part.body : '');
    return target;
  }

  const rawWarning = ctx => ctx.stderr.write('tcli: --raw shows real cookies and tokens. Use them only for this task; never save or share them.\n');

  function summaryText(summary) {
    const lines = [
      summary.recording_id,
      `  started   ${summary.started_at || '-'}`,
      `  stopped   ${summary.stopped_at ? `${summary.stopped_at}${summary.stop_reason ? ` (${summary.stop_reason})` : ''}` : 'still recording'}`,
      `  items     ${summary.items}${summary.truncated ? ` (+${summary.dropped_items} dropped at the size limit)` : ''} · ${humanSize(summary.bytes)}`,
      `  tab       ${summary.tab_id === null || summary.tab_id === undefined ? '-' : summary.tab_id}`,
      ...(summary.tabs && Object.keys(summary.tabs).length > 1 ? [`  tabs      ${Object.entries(summary.tabs).map(([tab, count]) => `${tab} (${count} items)`).join(', ')}`] : []),
      `  origins   ${(summary.origins || []).join(' ') || '-'}`,
    ];
    const kinds = Object.entries(summary.kinds || {}).map(([kind, count]) => `${kind} ${count}`).join(', ');
    if (kinds) lines.push(`  kinds     ${kinds}`);
    const options = summary.options || {};
    const filters = [];
    if (Array.isArray(options.types)) filters.push(`${options.drop_other_types ? 'only' : 'bodies of'} ${options.types.join(',')}`);
    if (Number.isInteger(options.max_body_bytes)) filters.push(`bodies cut at ${humanSize(options.max_body_bytes)}`);
    for (const [key, text] of [['network', 'no network'], ['dom', 'no DOM'], ['bodies', 'no bodies']]) if (options[key] === false) filters.push(text);
    if (filters.length) lines.push(`  filters   ${filters.join(' · ')}`);
    if (summary.task_id !== null && summary.task_id !== undefined) lines.push(`  task      ${summary.task_id}${summary.terminal_id ? ` (terminal ${summary.terminal_id})` : ''}`);
    return lines.join('\n');
  }

  // ── Commands ──
  // Each: { values, bools, multi, run(ctx, flags, positional) -> exit code }. ctx: { relay(), out, stdout, stderr, cwd }.
  const print = (ctx, flags, answer, text) => { ctx.out(flags.json ? JSON.stringify(answer, null, 2) : text(answer)); return EXIT.ok; };
  const timeoutOf = flags => wholeNumber(flags.timeout, '--timeout', { min: 1 });
  const simple = (method, buildParams, text, spec = {}) => ({
    ...spec,
    run: async (ctx, flags, positional) => {
      const params = { ...common(flags), ...buildParams(flags, positional) };
      const answer = await cmd(ctx, method, prune(params), { timeoutMs: timeoutOf(flags) });
      return print(ctx, flags, answer, text);
    },
  });
  const navText = answer => (answer && answer.tab ? `Tab ${answer.tab.tab_id}: ${oneLine(answer.tab.title, 80) || '(no title)'}  ${answer.tab.url || ''}` : 'Done');
  const none = (positional, text) => { if (positional.length) throw usage(`Usage: ${text}`); };

  const COMMANDS = {
    status: {
      bools: ['verbose'],
      async run(ctx, flags) {
        const answer = await request(ctx.relay(), 'GET', '/browser/status');
        const shown = flags.verbose ? answer : slimStatus(answer);
        ctx.out(flags.json ? JSON.stringify(shown, null, 2) : statusText(answer, { verbose: flags.verbose }));
        return answer && answer.connected ? EXIT.ok : EXIT.server;
      },
    },
    tabs: simple('tabs.list', (flags, positional) => { none(positional, 'tcli browser tabs'); return {}; }, answer => {
      const tabs = (answer && answer.tabs) || [];
      if (!tabs.length) return 'No tabs T-Agent may use. Open one with: tcli browser open <url> (or the person hands one over with the extension button).';
      return [' tab  [how] title  url  (* = active)', ...tabs.map(tabLine)].join('\n');
    }),
    open: {
      values: RECORD_VALUES, bools: ['active', 'keep', 'record', 'background', ...RECORD_BOOLS],
      async run(ctx, flags, positional) {
        if (positional.length !== 1) throw usage('Usage: tcli browser open <url> [--active] [--keep] [--record [--background] [--types T] [--max-body N] ...]');
        const record = recordParams(flags);
        if (!flags.record && Object.keys(record).length) throw usage('The record options of open need --record');
        if (flags.background && !flags.record) throw usage('--background needs --record (a plain open is always behind the person\'s window)');
        // A recording gets its own window: in front for the person to use, or behind with --background ("Recording from the first load" in
        // docs/design/browser-extension.md).
        const window = flags.record ? (flags.background ? 'back' : 'front') : undefined;
        const answer = await cmd(ctx, 'tabs.open', prune({ browser_id: flags.browser, url: positional[0], active: flags.active ? true : undefined, keep: flags.keep ? true : undefined, record: flags.record ? record : undefined, window }), { timeoutMs: timeoutOf(flags) });
        return print(ctx, flags, answer, result => {
          const opened = result && result.tab ? `Opened tab ${result.tab.tab_id}: ${result.tab.url || positional[0]}` : 'Opened';
          const lines = [opened];
          if (window === 'front') lines.push('Opened a new window in front for the recording: the person can use the page while it records.');
          if (window === 'back') lines.push('Opened its own window in the background for the recording.');
          if (flags.keep) lines.push('It stays open after your turn: tell the person it is there (the "T-Agent" group in T-Agent\'s window).');
          if (result && result.recording_id) lines.push(`Recording ${result.recording_id} from the first load. Use the page, then: tcli browser record stop`);
          return lines.join('\n');
        });
      },
    },
    close: simple('tabs.close', (flags, positional) => {
      if (positional.length > 1) throw usage('Usage: tcli browser close [tab]');
      return positional.length ? { tab_id: tabNumber(positional[0]) } : {};
    }, answer => (answer && answer.released ? 'Released the tab (the person handed it over, so it stays open)' : 'Closed the tab')),
    go: {
      bools: ['no-wait'],
      async run(ctx, flags, positional) {
        if (positional.length < 1 || positional.length > 2) throw usage('Usage: tcli browser go [tab] <url>');
        const params = { ...common(flags), url: positional[positional.length - 1], wait: flags['no-wait'] ? 'none' : 'load' };
        if (positional.length === 2) params.tab_id = tabNumber(positional[0]);
        return print(ctx, flags, await cmd(ctx, 'tabs.navigate', params, { timeoutMs: timeoutOf(flags) }), navText);
      },
    },
    back: simple('tabs.navigate', (flags, positional) => { none(positional, 'tcli browser back'); return { action: 'back', wait: flags['no-wait'] ? 'none' : 'load' }; }, navText, { bools: ['no-wait'] }),
    forward: simple('tabs.navigate', (flags, positional) => { none(positional, 'tcli browser forward'); return { action: 'forward', wait: flags['no-wait'] ? 'none' : 'load' }; }, navText, { bools: ['no-wait'] }),
    reload: simple('tabs.navigate', (flags, positional) => { none(positional, 'tcli browser reload'); return { action: 'reload', wait: flags['no-wait'] ? 'none' : 'load' }; }, navText, { bools: ['no-wait'] }),
    activate: simple('tabs.activate', (flags, positional) => {
      if (positional.length !== 1) throw usage('Usage: tcli browser activate <tab>');
      return { tab_id: tabNumber(positional[0]) };
    }, navText),
    snapshot: {
      values: ['selector', 'max-bytes', 'filter'], bools: ['text', 'html', 'diff'],
      async run(ctx, flags, positional) {
        none(positional, 'tcli browser snapshot [--text|--html] [--selector S] [--filter interactive] [--diff] [--tab T]');
        if (flags.text && flags.html) throw usage('Choose --text or --html, not both');
        if (flags.filter !== undefined && flags.filter !== 'interactive') throw usage('--filter takes interactive');
        if ((flags.filter || flags.diff) && (flags.text || flags.html)) throw usage('--filter and --diff are for the element list, not --text or --html');
        const mode = flags.text ? 'text' : flags.html ? 'html' : 'outline';
        const answer = await cmd(ctx, 'page.snapshot', prune({ ...common(flags), mode, selector: flags.selector, filter: flags.filter, diff: flags.diff ? true : undefined, max_bytes: wholeNumber(flags['max-bytes'], '--max-bytes', { min: 1 }) }), { timeoutMs: timeoutOf(flags) });
        return print(ctx, flags, answer, result => {
          const head = `${oneLine(result.title, 100) || '(no title)'}  ${result.url || ''}`;
          const tail = result.truncated ? ['(cut at the size limit: narrow it with --selector, or raise --max-bytes)'] : [];
          if (mode === 'text') return [head, '', result.text || '', ...tail].join('\n');
          if (mode === 'html') return [result.html || '', ...tail].join('\n');
          if (result.diff && result.diff.base) {
            const d = result.diff;
            const lines = diffLines(d);
            return [head, `${(d.added || []).length} added, ${(d.removed || []).length} removed, ${(d.changed || []).length} changed, ${d.same || 0} the same`, ...lines, ...tail].join('\n');
          }
          const note = result.diff ? ['(no earlier snapshot of this page to compare with: the whole snapshot)'] : [];
          const elements = result.elements || [];
          const viewport = result.viewport ? ` · viewport ${result.viewport.w || result.viewport.width}x${result.viewport.h || result.viewport.height}` : '';
          return [head, ...note, `${elements.length} elements${viewport}`, ...elements.map(elementLine), ...tail].join('\n');
        });
      },
    },
    query: {
      values: ['limit'], bools: ['all'],
      async run(ctx, flags, positional) {
        if (positional.length !== 1) throw usage('Usage: tcli browser query <selector> [--all] [--limit N]');
        const answer = await cmd(ctx, 'page.query', prune({ ...common(flags), selector: positional[0], all: flags.all ? true : undefined, limit: wholeNumber(flags.limit, '--limit', { min: 1 }) }), { timeoutMs: timeoutOf(flags) });
        return print(ctx, flags, answer, result => ((result.elements || []).length ? result.elements.map(elementLine).join('\n') : `Nothing matches ${positional[0]}`));
      },
    },
    click: {
      values: ['button', 'count', 'modifiers'], bools: ['right', 'middle', 'double'],
      async run(ctx, flags, positional) {
        if (positional.length !== 1) throw usage('Usage: tcli browser click <target> [--right|--middle] [--double] [--modifiers Shift,Meta]');
        const button = flags.right ? 'right' : flags.middle ? 'middle' : flags.button;
        if (button !== undefined && !['left', 'right', 'middle'].includes(button)) throw usage('--button is left, right or middle');
        const count = flags.double ? 2 : wholeNumber(flags.count, '--count', { min: 1 });
        const answer = await cmd(ctx, 'input.click', prune({ ...common(flags), target: target(positional[0]), button, count, modifiers: modifiers(flags.modifiers) }), { timeoutMs: timeoutOf(flags) });
        return print(ctx, flags, answer, result => {
          const clicked = result && result.clicked;
          return clicked ? `Clicked ${clicked.ref ? `${clicked.ref} ` : ''}${clicked.tag || ''}${clicked.name ? ` ${quote(oneLine(clicked.name, 80))}` : ''}` : 'Clicked';
        });
      },
    },
    type: {
      bools: ['clear', 'submit'],
      async run(ctx, flags, positional) {
        if (positional.length !== 2) throw usage('Usage: tcli browser type <target> <text> [--clear] [--submit]');
        const answer = await cmd(ctx, 'input.type', prune({ ...common(flags), target: target(positional[0]), text: positional[1], clear: flags.clear ? true : undefined, submit: flags.submit ? true : undefined }), { timeoutMs: timeoutOf(flags) });
        return print(ctx, flags, answer, () => `Typed ${[...positional[1]].length} characters into ${positional[0]}${flags.submit ? ' and submitted' : ''}`);
      },
    },
    press: {
      values: ['modifiers'],
      async run(ctx, flags, positional) {
        if (positional.length !== 1) throw usage('Usage: tcli browser press <key> [--modifiers Shift,Meta]');
        const answer = await cmd(ctx, 'input.press', prune({ ...common(flags), key: positional[0], modifiers: modifiers(flags.modifiers) }), { timeoutMs: timeoutOf(flags) });
        return print(ctx, flags, answer, () => `Pressed ${[...(modifiers(flags.modifiers) || []), positional[0]].join('+')}`);
      },
    },
    hover: simple('input.hover', (flags, positional) => {
      if (positional.length !== 1) throw usage('Usage: tcli browser hover <target>');
      return { target: target(positional[0]) };
    }, () => 'Done'),
    scroll: {
      values: ['dx', 'dy'],
      async run(ctx, flags, positional) {
        if (positional.length > 1) throw usage('Usage: tcli browser scroll [target] [--dy N] [--dx N]');
        const params = prune({ ...common(flags), target: positional.length ? target(positional[0]) : undefined, dx: wholeNumber(flags.dx, '--dx', { min: -1e9 }), dy: wholeNumber(flags.dy, '--dy', { min: -1e9 }) });
        return print(ctx, flags, await cmd(ctx, 'input.scroll', params, { timeoutMs: timeoutOf(flags) }), () => 'Scrolled');
      },
    },
    select: simple('input.select', (flags, positional) => {
      if (positional.length < 2) throw usage('Usage: tcli browser select <target> <value...>');
      return { target: target(positional[0]), values: positional.slice(1) };
    }, () => 'Selected'),
    eval: {
      values: ['file'], bools: ['no-await'],
      async run(ctx, flags, positional) {
        if ((flags.file && positional.length) || (!flags.file && positional.length !== 1)) throw usage('Usage: tcli browser eval <js> | --file f.js [--no-await]');
        let expression = positional[0];
        if (flags.file) {
          try { expression = fs.readFileSync(path.resolve(ctx.cwd, flags.file), 'utf8'); } catch (error) { throw usage(`Cannot read ${flags.file}: ${error.message}`); }
        }
        const answer = await cmd(ctx, 'page.eval', prune({ ...common(flags), expression, await_promise: flags['no-await'] ? false : undefined }), { timeoutMs: timeoutOf(flags) });
        if (flags.json) { ctx.out(JSON.stringify(answer, null, 2)); return EXIT.ok; }
        const value = answer ? answer.value : undefined;
        ctx.out(answer && answer.type === 'undefined' ? 'undefined' : typeof value === 'string' ? value : JSON.stringify(value, null, 2));
        if (answer && answer.truncated) ctx.stderr.write('tcli: the value was cut at 1 MiB\n');
        return EXIT.ok;
      },
    },
    wait: {
      values: ['selector', 'text', 'url', 'idle'],
      async run(ctx, flags, positional) {
        none(positional, 'tcli browser wait [--selector S|--text T|--url U|--idle MS] [--timeout MS]');
        const params = prune({ ...common(flags), selector: flags.selector, text: flags.text, url_includes: flags.url, network_idle_ms: wholeNumber(flags.idle, '--idle', { min: 1 }), timeout_ms: timeoutOf(flags) });
        if (!['selector', 'text', 'url_includes', 'network_idle_ms'].some(name => name in params)) throw usage('wait needs --selector, --text, --url or --idle');
        const answer = await cmd(ctx, 'page.wait', params);
        return print(ctx, flags, answer, result => `Matched: ${result && result.matched ? result.matched : 'yes'}`);
      },
    },
    shot: {
      values: ['output', 'target', 'quality', 'format', 'zoom', 'scale'], bools: ['full', 'jpeg', 'force', 'annotate'],
      async run(ctx, flags, positional) {
        none(positional, 'tcli browser shot [--full] [--zoom x,y,w,h [--scale N]] [--annotate] [-o file.png]');
        const format = flags.jpeg ? 'jpeg' : flags.format;
        if (format !== undefined && !['png', 'jpeg'].includes(format)) throw usage('--format is png or jpeg');
        let zoom;
        if (flags.zoom !== undefined) {
          const parts = String(flags.zoom).split(',').map(Number);
          if (parts.length !== 4 || parts.some(n => !Number.isFinite(n)) || parts[2] <= 0 || parts[3] <= 0) throw usage('--zoom is x,y,w,h in viewport pixels, such as 0,0,400,300');
          if (flags.full || flags.target) throw usage('--zoom takes neither --full nor --target');
          zoom = { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
        }
        let scale;
        if (flags.scale !== undefined) {
          scale = Number(flags.scale);
          if (!Number.isFinite(scale) || scale < 0.1 || scale > 4) throw usage('--scale is 0.1 to 4');
          if (!zoom && !flags.target) throw usage('--scale needs --zoom or --target');
        }
        const params = prune({ ...common(flags), full_page: flags.full ? true : undefined, target: flags.target ? target(flags.target) : undefined, zoom, scale, annotate: flags.annotate ? true : undefined, format, quality: wholeNumber(flags.quality, '--quality', { min: 0 }) });
        const toStdout = flags.output === '-';
        let file = null;
        if (!toStdout) {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          file = path.resolve(ctx.cwd, flags.output || `shot-${stamp}.${format === 'jpeg' ? 'jpg' : 'png'}`);
          if (fs.existsSync(file) && !flags.force) throw usage(`${file} exists; add --force to overwrite it`);
        }
        const answer = await cmd(ctx, 'page.screenshot', params, { timeoutMs: timeoutOf(flags) });
        if (!answer || typeof answer.data_base64 !== 'string') throw new CliError('The browser sent no image', EXIT.server);
        const bytes = Buffer.from(answer.data_base64, 'base64');
        if (toStdout) { ctx.stdout.write(bytes); return EXIT.ok; }
        fs.writeFileSync(file, bytes);
        const { data_base64: _data, ...rest } = answer;
        const result = { ...rest, file, size: bytes.length };
        if (flags.annotate && answer.annotated === 0) ctx.stderr.write('tcli: no refs were drawn: take a snapshot first (shot --annotate draws the refs of the last one)\n');
        return print(ctx, flags, result, () => `Saved ${file} (${answer.width}x${answer.height}, ${humanSize(bytes.length)})${answer.truncated ? ' (cut at the size limit)' : ''}${Number.isFinite(answer.annotated) ? ` with ${answer.annotated} refs drawn` : ''}`);
      },
    },
    console: {
      values: ['since', 'limit', 'pattern', 'level'],
      async run(ctx, flags, positional) {
        none(positional, 'tcli browser console [--level error,warn] [--pattern RE] [--since MS] [--limit N]');
        // --since: a small number is the last MS milliseconds, a large one an epoch time in ms (what it always took).
        let since = wholeNumber(flags.since, '--since');
        if (since !== undefined && since < SINCE_EPOCH) since = Date.now() - since;
        const levels = list(flags.level);
        if (flags.level !== undefined) {
          if (!levels || !levels.length) throw usage('--level takes a list such as error,warn');
          for (const level of levels) if (!CONSOLE_LEVELS.includes(level)) throw usage(`--level: "${level}" is not one of ${CONSOLE_LEVELS.join(', ')}`);
        }
        if (flags.pattern !== undefined) {
          if (!flags.pattern || flags.pattern.length > 500) throw usage('--pattern takes a regular expression of at most 500 characters');
          try { new RegExp(flags.pattern, 'i'); } catch (error) { throw usage(`--pattern is not a regular expression: ${error.message}`); }
        }
        const answer = await cmd(ctx, 'page.console', prune({ ...common(flags), since, levels, pattern: flags.pattern, limit: wholeNumber(flags.limit, '--limit', { min: 1 }) }), { timeoutMs: timeoutOf(flags) });
        return print(ctx, flags, answer, result => {
          const entries = (result && result.entries) || [];
          if (!entries.length) return levels || flags.pattern || flags.since !== undefined ? 'No console lines match' : 'No console lines (they are collected while net capture or a recording runs, and for uncaught errors)';
          return entries.map(entry => `${time(entry.at)} ${String(entry.level || 'log').padEnd(5)} ${entry.text}`).join('\n');
        });
      },
    },
    fill: {
      values: ['fields'],
      async run(ctx, flags, positional) {
        // --json '{"e3":"Ann"}' is the fields as JSON (then the output is text); --fields '{...}' --json gives the JSON answer.
        const objects = positional.filter(arg => arg.trim().startsWith('{'));
        const pairs = positional.filter(arg => !arg.trim().startsWith('{'));
        if (flags.fields !== undefined) objects.push(flags.fields);
        if (!objects.length && !pairs.length) throw usage('Usage: tcli browser fill <target>=<value>... | --json \'{"e3":"Ann","e7":true}\'');
        const fields = [];
        for (const text of objects) {
          let map;
          try { map = JSON.parse(text); } catch (error) { throw usage(`The fields are not JSON: ${error.message}`); }
          if (!map || typeof map !== 'object' || Array.isArray(map)) throw usage('The fields JSON is an object of target: value');
          for (const [key, value] of Object.entries(map)) {
            if (!(typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' || (Array.isArray(value) && value.every(item => typeof item === 'string')))) throw usage(`${key}: a value is a string, true / false, or a list of strings`);
            fields.push({ label: key, target: target(key), value });
          }
        }
        for (const pair of pairs) {
          const at = splitPair(pair);
          if (at <= 0) throw usage(`"${pair}" is not <target>=<value> (such as e3=Ann or css:#email=a@b.c)`);
          fields.push({ label: pair.slice(0, at), target: target(pair.slice(0, at)), value: pair.slice(at + 1) });
        }
        if (fields.length > 100) throw usage('At most 100 fields at once');
        const jsonOut = flags.json && (flags.fields !== undefined || !objects.length);
        const answer = await cmd(ctx, 'input.fill', prune({ ...common(flags), fields }), { timeoutMs: timeoutOf(flags) });
        const results = (answer && answer.fields) || [];
        if (jsonOut) ctx.out(JSON.stringify(answer, null, 2));
        else {
          ctx.out(results.map(field => {
            if (!field.ok) return `${field.target}: failed: ${field.error} (${field.code})`;
            const extra = field.checked !== undefined ? `, ${field.checked ? 'checked' : 'not checked'}` : field.value !== undefined ? `, ${Array.isArray(field.value) ? field.value.join(',') : field.value}` : '';
            return `${field.target}: ok (${field.kind}${extra})`;
          }).join('\n'));
          ctx.out(`Filled ${answer && Number.isFinite(answer.filled) ? answer.filled : 0} of ${fields.length} fields`);
        }
        return results.some(field => !field.ok) ? EXIT.usage : EXIT.ok;
      },
    },
    check: {
      bools: ['off'],
      async run(ctx, flags, positional) {
        if (positional.length !== 1) throw usage('Usage: tcli browser check <target> [--off]');
        const answer = await cmd(ctx, 'input.check', prune({ ...common(flags), target: target(positional[0]), checked: !flags.off }), { timeoutMs: timeoutOf(flags) });
        return print(ctx, flags, answer, result => `${result && result.checked ? 'Checked' : 'Unchecked'} ${positional[0]}`);
      },
    },
    drag: {
      values: ['steps'], bools: ['html5', 'mouse'],
      async run(ctx, flags, positional) {
        if (positional.length !== 2) throw usage('Usage: tcli browser drag <target> <to: target or x,y> [--steps N] [--html5|--mouse]');
        if (flags.html5 && flags.mouse) throw usage('Choose --html5 or --mouse, not both');
        const params = prune({ ...common(flags), target: target(positional[0]), to: target(positional[1]), steps: wholeNumber(flags.steps, '--steps', { min: 1 }), mode: flags.html5 ? 'html5' : flags.mouse ? 'mouse' : undefined });
        if (params.steps > 100) throw usage('--steps is at most 100');
        const answer = await cmd(ctx, 'input.drag', params, { timeoutMs: timeoutOf(flags) });
        return print(ctx, flags, answer, result => {
          const how = { html5: 'an HTML5 drag and drop', mouse: 'the mouse', events: 'dispatched mouse events (DevTools holds the debugger)' }[result && result.how] || 'the mouse';
          const lines = [`Dragged ${positional[0]} to ${positional[1]} with ${how}`];
          if (result && result.dropped === false) lines.push(`The drop did not happen: ${result.reason || 'the target refused it'}`);
          return lines.join('\n');
        });
      },
    },
    upload: {
      async run(ctx, flags, positional) {
        if (positional.length < 2) throw usage('Usage: tcli browser upload <target> <file...>');
        // Only the files named here, each an existing regular file; T-Agent checks them again (limits, no credentials).
        const files = positional.slice(1).map(name => {
          const file = path.resolve(ctx.cwd, name);
          let stat;
          try { stat = fs.statSync(file); } catch { throw usage(`${name} does not exist`); }
          if (!stat.isFile()) throw usage(`${name} is not a file`);
          if (stat.size > UPLOAD_MAX_BYTES) throw usage(`${name} is larger than ${UPLOAD_MAX_BYTES / 1024 / 1024} MiB`);
          return file;
        });
        if (files.length > 20) throw usage('At most 20 files at once');
        const answer = await cmd(ctx, 'input.upload', prune({ ...common(flags), target: target(positional[0]), files }), { timeoutMs: timeoutOf(flags) });
        return print(ctx, flags, answer, result => `Set ${files.length} file${files.length === 1 ? '' : 's'} on ${positional[0]}: ${((result && result.files) || files.map(file => path.basename(file))).join(', ')}`);
      },
    },
    dialog: {
      values: ['text'],
      async run(ctx, flags, positional) {
        const action = positional[0] || 'status';
        if (positional.length > 1 || !['status', 'accept', 'dismiss'].includes(action)) throw usage('Usage: tcli browser dialog [status] | dialog accept [--text T] | dialog dismiss');
        if (flags.text !== undefined && action !== 'accept') throw usage('--text goes with dialog accept (the answer to a prompt)');
        const answer = await cmd(ctx, 'page.dialog', prune({ ...common(flags), action, text: flags.text }), { timeoutMs: timeoutOf(flags) });
        return print(ctx, flags, answer, result => {
          const what = result.type ? `${result.type} ${quote(oneLine(result.message, 200))}` : 'dialog';
          if (action !== 'status') return `${result.handled === 'accepted' ? 'Accepted' : 'Dismissed'} the ${what}`;
          if (result.automatic) return 'No dialog is waiting: while net capture or a recording runs, dialogs are answered at once';
          if (!result.open) return 'No dialog is open';
          if (result.known === false) return 'The page is blocked, most likely by a dialog that opened before T-Agent looked (its text cannot be read): dialog accept or dialog dismiss';
          return `Open: ${what}${result.default_prompt ? ` (default ${quote(oneLine(result.default_prompt, 80))})` : ''}`;
        });
      },
    },
    fetch: {
      values: ['method', 'data', 'body-out'], multi: ['header'], bools: ['raw', 'no-credentials', 'force'],
      async run(ctx, flags, positional) {
        if (positional.length !== 1) throw usage("Usage: tcli browser fetch <url> [-X M] [-H 'K: V']... [-d body] [--raw]");
        const headers = {};
        for (const line of flags.header || []) {
          const colon = line.indexOf(':');
          if (colon <= 0) throw usage(`-H needs 'Name: value', not "${line}"`);
          headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
        }
        const params = prune({
          ...common(flags), url: positional[0], method: flags.method ? flags.method.toUpperCase() : (flags.data !== undefined ? 'POST' : undefined),
          headers: Object.keys(headers).length ? headers : undefined, body: flags.data, credentials: flags['no-credentials'] ? 'omit' : undefined, raw: flags.raw ? true : undefined,
        });
        if (flags.raw) rawWarning(ctx);
        const answer = await cmd(ctx, 'page.fetch', params, { timeoutMs: timeoutOf(flags) });
        if (flags['body-out']) {
          const saved = writeBody(flags['body-out'], answer || {}, ctx.cwd);
          ctx.stderr.write(`Saved the body to ${saved}\n`);
        }
        return print(ctx, flags, answer, result => {
          const lines = [`Status ${result.status}`, ...headerLines(result.headers)];
          if (!flags['body-out']) { const body = bodyText(result); if (body.length) lines.push('', ...body); }
          return lines.join('\n');
        });
      },
    },
  };

  const NET = {
    start: {
      values: ['filter', 'type', 'max-body'], bools: ['no-bodies'],
      async run(ctx, flags, positional) {
        none(positional, 'tcli browser net start [--filter U] [--type XHR,Fetch] [--no-bodies]');
        const filter = prune({ url_includes: flags.filter, types: list(flags.type) });
        const params = prune({ ...common(flags), bodies: flags['no-bodies'] ? false : undefined, max_body_bytes: wholeNumber(flags['max-body'], '--max-body', { min: 1 }), filter: Object.keys(filter).length ? filter : undefined });
        return print(ctx, flags, await cmd(ctx, 'net.start', params, { timeoutMs: timeoutOf(flags) }), () => 'Capturing network traffic. List it with: tcli browser net list; stop with: tcli browser net stop');
      },
    },
    stop: simple('net.stop', (flags, positional) => { none(positional, 'tcli browser net stop'); return {}; }, answer => `Stopped capturing (${answer && Number.isFinite(answer.count) ? answer.count : 0} requests)`),
    list: {
      values: ['filter', 'type', 'since', 'limit'],
      async run(ctx, flags, positional) {
        none(positional, 'tcli browser net list [--filter U] [--type XHR,Fetch] [--since MS] [--limit N]');
        const params = prune({ ...common(flags), url_includes: flags.filter, types: list(flags.type), since: wholeNumber(flags.since, '--since'), limit: wholeNumber(flags.limit, '--limit', { min: 1 }) });
        return print(ctx, flags, await cmd(ctx, 'net.list', params, { timeoutMs: timeoutOf(flags) }), answer => {
          const requests = (answer && answer.requests) || [];
          if (!requests.length) return 'No requests captured (start with: tcli browser net start, then use the page)';
          return requests.map(requestLine).join('\n');
        });
      },
    },
    get: {
      values: ['body-out'], bools: ['raw', 'no-body'],
      async run(ctx, flags, positional) {
        if (positional.length !== 1) throw usage('Usage: tcli browser net get <req_id> [--raw] [--no-body] [--body-out file]');
        if (flags.raw) rawWarning(ctx);
        const answer = await cmd(ctx, 'net.get', prune({ ...common(flags), req_id: positional[0], raw: flags.raw ? true : undefined, body: flags['no-body'] ? false : undefined }), { timeoutMs: timeoutOf(flags) });
        if (flags['body-out']) {
          const saved = writeBody(flags['body-out'], (answer && answer.response) || {}, ctx.cwd);
          ctx.stderr.write(`Saved the response body to ${saved}\n`);
        }
        return print(ctx, flags, answer, netGetText);
      },
    },
  };

  const RECORD = {
    start: {
      values: RECORD_VALUES, bools: RECORD_BOOLS,
      async run(ctx, flags, positional) {
        none(positional, 'tcli browser record start [--no-network] [--no-dom] [--no-bodies] [--types T [--drop-other-types]] [--max-body N]');
        const params = { ...common(flags), ...recordParams(flags) };
        return print(ctx, flags, await cmd(ctx, 'record.start', params, { timeoutMs: timeoutOf(flags) }), answer => `Recording ${answer.recording_id}. Use the page (or let the person use it), then: tcli browser record stop`);
      },
    },
    stop: {
      async run(ctx, flags, positional) {
        if (positional.length > 1) throw usage('Usage: tcli browser record stop [id]');
        const params = positional.length ? prune({ browser_id: flags.browser, recording_id: positional[0] }) : common(flags);
        return print(ctx, flags, await cmd(ctx, 'record.stop', params, { timeoutMs: timeoutOf(flags) }), answer => `Stopped ${answer.recording_id}: ${answer.items} items in ${Math.round((answer.duration_ms || 0) / 1000)} s. See: tcli browser record show ${answer.recording_id}`);
      },
    },
    list: {
      async run(ctx, flags, positional) {
        none(positional, 'tcli browser record list');
        const answer = await request(ctx.relay(), 'GET', '/browser/recordings');
        return print(ctx, flags, answer, result => {
          const recordings = (result && result.recordings) || [];
          if (!recordings.length) return 'No recordings (start one with: tcli browser record start)';
          return recordings.map(item => `${item.recording_id}  ${when(item.started_at)}  ${item.stopped_at ? 'stopped' : 'recording'}  ${String(item.items).padStart(5)} items  ${humanSize(item.bytes).padStart(7)}  ${(item.origins || []).slice(0, 3).join(' ')}`).join('\n');
        });
      },
    },
    show: {
      async run(ctx, flags, positional) {
        if (positional.length !== 1) throw usage('Usage: tcli browser record show <id>');
        return print(ctx, flags, await request(ctx.relay(), 'GET', `/browser/recordings/${encodeURIComponent(positional[0])}`), summaryText);
      },
    },
    items: records.items,
    requests: records.requests,
    rm: {
      bools: ['yes'],
      async run(ctx, flags, positional) {
        if (positional.length !== 1) throw usage('Usage: tcli browser record rm <id> --yes');
        if (!flags.yes) throw usage('rm needs --yes (it deletes the recording for good)');
        return print(ctx, flags, await request(ctx.relay(), 'DELETE', `/browser/recordings/${encodeURIComponent(positional[0])}`), answer => `Removed ${answer.recording_id}`);
      },
    },
  };

  const SUBGROUPS = { net: NET, record: RECORD };

  // tcli browser <command> [...]: called by scripts/tcli.js after it handled `help`.
  async function run(commandName, rest, ctx) {
    let command = COMMANDS[commandName];
    let args = rest;
    let label = commandName;
    if (SUBGROUPS[commandName]) {
      const [sub, ...more] = rest;
      if (!sub || sub === 'help' || sub === '--help' || sub === '-h') { (sub ? ctx.stdout : ctx.stderr).write(HELP); return sub ? EXIT.ok : EXIT.usage; }
      command = SUBGROUPS[commandName][sub];
      if (!command) throw usage(`Unknown command "browser ${commandName} ${sub}"; see tcli browser help`);
      args = more;
      label = `${commandName} ${sub}`;
    }
    if (!command) throw usage(`Unknown command "browser ${label}"; see tcli browser help`);
    const { flags, positional } = parse(args, command);
    if (flags.help) { ctx.stdout.write(HELP); return EXIT.ok; }
    return command.run(ctx, flags, positional);
  }

  return { help: HELP, run, parse, target, commands: COMMANDS, net: NET, record: RECORD };
}

module.exports = { createBrowserGroup, HELP };
