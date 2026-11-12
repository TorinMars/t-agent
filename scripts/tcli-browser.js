// `tcli browser ...`: drives the person's browser through the T-Agent browser extension ("Browser extension" in DESIGN.md). Every command is one
// call to the relay /api/tcli/browser (routes/browser-ext.js) with the terminal's hook token; T-Agent passes it to the extension over its socket
// (services/browser-bridge.js). The default output is short text for a person or a model; --json prints the answer as it came.
// Loaded by scripts/tcli.js, which hands over its HTTP and error helpers. Node built-ins only.
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_TIMEOUT_MS = 30_000;
const HTTP_EXTRA_MS = 15_000; // the relay answers a timeout itself; this only guards against a T-Agent that stopped answering
const BODY_PREVIEW = 4000;

const HELP = `tcli browser: drive this computer's browser
through the T-Agent extension (pair it in
Settings > Tasks and files > Browser extension)

Usage: tcli browser <command> [options]

Tabs (only tabs T-Agent opened, in the
"T-Agent" tab group, or tabs the person handed
over with the extension button)
  status                 the connected browser
  tabs                   tabs T-Agent may use
  open <url> [--active]  new tab in the group
  close [tab]            close (a handed tab is
                         released, never closed)
  go [tab] <url>         navigate (--no-wait)
  back | forward | reload
  activate <tab>         bring a tab to the front

Page
  snapshot               one line per element:
                         e12 button "Sign in"
    --text | --html      text or HTML instead
    --selector S         only inside S
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
  eval <js>              run JS in the page
    --file f.js          from a file
    --no-await           do not await a promise
  wait                   until one of these:
    --selector S | --text T | --url U |
    --idle MS (network idle)  [--timeout MS]
  shot [-o file.png]     screenshot (--full,
                         --target T, --jpeg,
                         --quality N; -o - for
                         stdout)
  console                console lines and errors
    --since MS --limit N

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
DOM changes; kept 14 days in T-Agent)
  record start           --no-network --no-dom
                         --no-bodies
  record stop [id]
  record list
  record show <id>
  record items <id>      JSON lines (-o file)
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
  const modifiers = value => (value ? String(value).split(',').map(item => item.trim()).filter(Boolean) : undefined);
  const list = value => (value ? String(value).split(',').map(item => item.trim()).filter(Boolean) : undefined);
  const prune = object => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));

  // The params every command shares: --tab and --browser.
  const common = flags => prune({ tab_id: tabNumber(flags.tab), browser_id: flags.browser });

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

  function cmd(ctx, method, params = {}, { timeoutMs } = {}) {
    const wait = timeoutMs || DEFAULT_TIMEOUT_MS;
    const inner = Number.isFinite(params.timeout_ms) ? params.timeout_ms + 5000 : 0;
    return request(ctx.relay(), 'POST', '/browser/cmd', {
      body: prune({ method, params, timeout_ms: timeoutMs }),
      timeoutMs: Math.max(wait, inner) + HTTP_EXTRA_MS,
    });
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
    return parts.join(' ');
  }

  function statusText(answer) {
    const browsers = (answer && answer.browsers) || [];
    const lines = [];
    const active = browsers.find(browser => browser.active);
    if (active) {
      const kind = active.browser && active.browser.name ? ` · ${active.browser.name}` : '';
      lines.push(`Connected: ${active.name} (${active.browser_id}) · extension ${active.version || '?'}${kind}`);
    } else lines.push('No browser is connected.');
    for (const browser of browsers.filter(item => !item.active)) {
      lines.push(`  ${browser.name} (${browser.browser_id}): ${browser.online ? 'online' : `offline, last seen ${when(browser.last_seen_at)}`}`);
    }
    if (!browsers.length) lines.push('Pair one in T-Agent: Settings > Tasks and files > Browser extension.');
    else if (!active) lines.push('Open Chrome with the T-Agent extension on this computer; it connects by itself.');
    return lines.join('\n');
  }

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
      `  origins   ${(summary.origins || []).join(' ') || '-'}`,
    ];
    const kinds = Object.entries(summary.kinds || {}).map(([kind, count]) => `${kind} ${count}`).join(', ');
    if (kinds) lines.push(`  kinds     ${kinds}`);
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
      async run(ctx, flags) {
        const answer = await request(ctx.relay(), 'GET', '/browser/status');
        ctx.out(flags.json ? JSON.stringify(answer, null, 2) : statusText(answer));
        return answer && answer.connected ? EXIT.ok : EXIT.server;
      },
    },
    tabs: simple('tabs.list', (flags, positional) => { none(positional, 'tcli browser tabs'); return {}; }, answer => {
      const tabs = (answer && answer.tabs) || [];
      if (!tabs.length) return 'No tabs T-Agent may use. Open one with: tcli browser open <url> (or the person hands one over with the extension button).';
      return [' tab  [how] title  url  (* = active)', ...tabs.map(tabLine)].join('\n');
    }),
    open: {
      bools: ['active'],
      async run(ctx, flags, positional) {
        if (positional.length !== 1) throw usage('Usage: tcli browser open <url> [--active]');
        const answer = await cmd(ctx, 'tabs.open', prune({ browser_id: flags.browser, url: positional[0], active: flags.active ? true : undefined }), { timeoutMs: timeoutOf(flags) });
        return print(ctx, flags, answer, result => (result && result.tab ? `Opened tab ${result.tab.tab_id}: ${result.tab.url || positional[0]}` : 'Opened'));
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
      values: ['selector', 'max-bytes'], bools: ['text', 'html'],
      async run(ctx, flags, positional) {
        none(positional, 'tcli browser snapshot [--text|--html] [--selector S] [--tab T]');
        if (flags.text && flags.html) throw usage('Choose --text or --html, not both');
        const mode = flags.text ? 'text' : flags.html ? 'html' : 'outline';
        const answer = await cmd(ctx, 'page.snapshot', prune({ ...common(flags), mode, selector: flags.selector, max_bytes: wholeNumber(flags['max-bytes'], '--max-bytes', { min: 1 }) }), { timeoutMs: timeoutOf(flags) });
        return print(ctx, flags, answer, result => {
          const head = `${oneLine(result.title, 100) || '(no title)'}  ${result.url || ''}`;
          const tail = result.truncated ? ['(cut at the size limit: narrow it with --selector, or raise --max-bytes)'] : [];
          if (mode === 'text') return [head, '', result.text || '', ...tail].join('\n');
          if (mode === 'html') return [result.html || '', ...tail].join('\n');
          const elements = result.elements || [];
          const viewport = result.viewport ? ` · viewport ${result.viewport.w || result.viewport.width}x${result.viewport.h || result.viewport.height}` : '';
          return [head, `${elements.length} elements${viewport}`, ...elements.map(elementLine), ...tail].join('\n');
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
      values: ['output', 'target', 'quality', 'format'], bools: ['full', 'jpeg', 'force'],
      async run(ctx, flags, positional) {
        none(positional, 'tcli browser shot [--full] [-o file.png]');
        const format = flags.jpeg ? 'jpeg' : flags.format;
        if (format !== undefined && !['png', 'jpeg'].includes(format)) throw usage('--format is png or jpeg');
        const params = prune({ ...common(flags), full_page: flags.full ? true : undefined, target: flags.target ? target(flags.target) : undefined, format, quality: wholeNumber(flags.quality, '--quality', { min: 0 }) });
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
        return print(ctx, flags, result, () => `Saved ${file} (${answer.width}x${answer.height}, ${humanSize(bytes.length)})${answer.truncated ? ' (cut at the size limit)' : ''}`);
      },
    },
    console: {
      values: ['since', 'limit'],
      async run(ctx, flags, positional) {
        none(positional, 'tcli browser console [--since MS] [--limit N]');
        const answer = await cmd(ctx, 'page.console', prune({ ...common(flags), since: wholeNumber(flags.since, '--since'), limit: wholeNumber(flags.limit, '--limit', { min: 1 }) }), { timeoutMs: timeoutOf(flags) });
        return print(ctx, flags, answer, result => {
          const entries = (result && result.entries) || [];
          if (!entries.length) return 'No console lines (they are collected while net capture or a recording runs, and for uncaught errors)';
          return entries.map(entry => `${time(entry.at)} ${String(entry.level || 'log').padEnd(5)} ${entry.text}`).join('\n');
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
      bools: ['no-network', 'no-dom', 'no-bodies'],
      async run(ctx, flags, positional) {
        none(positional, 'tcli browser record start [--no-network] [--no-dom] [--no-bodies]');
        const params = prune({ ...common(flags), network: flags['no-network'] ? false : undefined, dom: flags['no-dom'] ? false : undefined, bodies: flags['no-bodies'] ? false : undefined });
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
    items: {
      values: ['output'], bools: ['force'],
      async run(ctx, flags, positional) {
        if (positional.length !== 1) throw usage('Usage: tcli browser record items <id> [-o file.jsonl]');
        const route = `/browser/recordings/${encodeURIComponent(positional[0])}/items`;
        if (flags.output && flags.output !== '-') {
          const file = path.resolve(ctx.cwd, flags.output);
          if (fs.existsSync(file) && !flags.force) throw usage(`${file} exists; add --force to overwrite it`);
          const part = `${file}.tcli-part-${process.pid}`;
          const target = fs.createWriteStream(part, { mode: 0o600 });
          try { await request(ctx.relay(), 'GET', route, { stream: { target, isStdout: false } }); }
          catch (error) { target.destroy(); fs.rmSync(part, { force: true }); throw error; }
          fs.renameSync(part, file);
          ctx.out(flags.json ? JSON.stringify({ file, size: fs.statSync(file).size }) : `Saved ${file} (${humanSize(fs.statSync(file).size)})`);
          return EXIT.ok;
        }
        await request(ctx.relay(), 'GET', route, { stream: { target: ctx.stdout, isStdout: true } });
        return EXIT.ok;
      },
    },
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
