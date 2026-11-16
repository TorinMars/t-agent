'use strict';
// `tcli notify ...`: an agent session tells the user something on the notifiers the user set up in T-Attention (Telegram, email ... every plugin
// that takes direct messages), through the relay /api/tcli/notify (routes/tcli-notify.js). The server builds the "From" line from the terminal and
// applies the user's rules (the agent messages switch, quiet hours, a 60 s dedupe, the hourly limit). Wired into scripts/tcli.js with one GROUPS.notify
// line; it gets the shared helpers from there. See "tcli (agent command line)" in DESIGN.md.
const fs = require('node:fs');
const path = require('node:path');

const TEXT_MAX = 3000;
const TITLE_MAX = 200;
const STDIN_MAX = 64 * 1024;
const SEND_TIMEOUT_MS = 90_000; // a message relayed to the Telegram sender may take up to 45 s there

const HELP = `tcli notify: send the user a short message on
the notifiers set up in T-Attention (Telegram,
email ...)

Usage
  tcli notify <text...>    send the text
  tcli notify -            read the text from stdin
  tcli notify status       what can send now

Options
  --file F                 read the text from F
  --title T                a short title (200)
  --via telegram,email     only these notifiers
                           (default: all)
  --link URL               an http(s) link to add
                           (default: the T-Agent
                           page, when its address
                           is set in the rules)
  --json                   print the JSON answer

The text is at most ${TEXT_MAX} characters. The
message says which task and terminal it is from.
Quiet hours, the hourly limit and the switch
"Let agent sessions send messages (tcli notify)"
are the user's choice (Settings → T-Attention →
Rules): do not try to get around them. Never put
secrets in a message.

Exit codes: 0 sent (or relayed) on at least one
notifier, 1 usage, nothing set up, or everything
skipped (quiet hours, duplicate, limit), 2 not in
a T-Agent terminal or agent messages turned off,
4 server or network error, or every attempt
failed.
`;

const OUTCOME_TEXT = {
  sent: 'sent',
  quiet_hours: 'skipped: quiet hours',
  duplicate: 'skipped: the same message was sent less than a minute ago',
  rate_limited: 'skipped: hourly limit reached',
};
const FAILED = new Set(['error', 'relay_failed', 'relay_offline']);

// One line of text for one result, and whether it was sent / failed (else it was skipped).
function describe(result) {
  const outcome = String(result.outcome || 'unknown');
  const detail = result.detail ? String(result.detail) : '';
  if (outcome === 'relayed') {
    const inner = OUTCOME_TEXT[detail] || (detail === 'skipped' ? 'skipped there: not set up' : detail === 'error' ? 'failed there' : detail || 'unknown');
    return { text: `relayed through ${result.via || 'the sender device'} (${inner})`, sent: detail === 'sent', failed: detail === 'error' };
  }
  if (outcome === 'skipped') return { text: `skipped: ${detail || 'not set up'}`, sent: false, failed: false };
  if (outcome === 'relay_offline') return { text: `failed: the sender device${result.via ? ` ${result.via}` : ''} is offline`, sent: false, failed: true };
  if (outcome === 'relay_failed') return { text: `failed through ${result.via || 'the sender device'}: ${detail || 'the sender could not send it'}`, sent: false, failed: true };
  if (outcome === 'error') return { text: `failed: ${detail || 'error'}`, sent: false, failed: true };
  return { text: OUTCOME_TEXT[outcome] || outcome, sent: outcome === 'sent', failed: false };
}

function formatResults(results) {
  const width = results.reduce((max, result) => Math.max(max, String(result.notifier).length), 0);
  return results.map(result => `${String(result.notifier).padEnd(width)}  ${describe(result).text}`).join('\n');
}

function formatStatus(status) {
  const quiet = status.quietHours || {};
  const quietText = !quiet.enabled ? 'off' : `${quiet.start}-${quiet.end}${quiet.timeZone ? ` ${quiet.timeZone}` : ''}${quiet.active ? ', now (nothing is sent)' : ', not now'}`;
  const rows = [['Agent messages', status.agentMessages ? 'on' : 'off (Settings → T-Attention → Rules)'], ['Quiet hours', quietText]];
  const notifiers = Array.isArray(status.notifiers) ? status.notifiers : [];
  for (const notifier of notifiers) {
    const state = !notifier.enabled ? 'turned off' : !notifier.ready ? 'not set up' : notifier.via ? `ready (through ${notifier.via})` : 'ready';
    rows.push([notifier.name, state]);
  }
  if (!notifiers.length) rows.push(['Notifiers', 'none can send messages']);
  const width = rows.reduce((max, [name]) => Math.max(max, name.length), 0);
  return rows.map(([name, value]) => `${name.padEnd(width)}  ${value}`).join('\n');
}

function readStdin(stdin, usage) {
  return new Promise((resolve, reject) => {
    if (!stdin || stdin.isTTY) { reject(usage('Nothing to read: pipe the text in, or give it as arguments')); return; }
    const chunks = [];
    let size = 0;
    stdin.on('data', chunk => {
      size += chunk.length;
      if (size > STDIN_MAX) { stdin.destroy(); reject(usage(`The message is longer than ${TEXT_MAX} characters; shorten it`)); return; }
      chunks.push(chunk);
    });
    stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stdin.on('error', error => reject(usage(`Cannot read stdin: ${error.message}`)));
  });
}

function parseVia(value, usage) {
  if (value === undefined) return undefined;
  const names = String(value).split(',').map(name => name.trim().toLowerCase()).filter(Boolean);
  if (!names.length || names.some(name => !/^[a-z0-9][a-z0-9-]{0,40}$/.test(name))) throw usage('--via takes notifier names such as telegram,email (or all)');
  return names.includes('all') ? 'all' : names;
}

function createNotifyGroup({ parseArgs, callJson, usage, EXIT }) {
  async function status(ctx, json) {
    const answer = await callJson(ctx.relay(), 'GET', '/notify/status');
    ctx.out(json ? JSON.stringify(answer, null, 2) : formatStatus(answer));
    return EXIT.ok;
  }

  async function send(ctx, argv) {
    const { flags, positional } = parseArgs(argv, { values: ['file', 'title', 'via', 'link'] });
    if (flags.help) { ctx.stdout.write(HELP); return EXIT.ok; }
    const fromStdin = positional.length === 1 && positional[0] === '-';
    const sources = [flags.file !== undefined, fromStdin, positional.length > 0 && !fromStdin].filter(Boolean).length;
    if (sources === 0) throw usage('Usage: tcli notify <text...> | - | --file F [--title T] [--via telegram,email] [--link URL]');
    if (sources > 1) throw usage('Give the text one way: as arguments, - for stdin, or --file F');
    let text;
    if (flags.file === '-' || fromStdin) text = await readStdin(ctx.stdin, usage);
    else if (flags.file !== undefined) {
      const file = path.resolve(ctx.cwd, flags.file);
      try { text = fs.readFileSync(file, 'utf8'); } catch { throw usage(`Cannot read ${file}`); }
    } else text = positional.join(' ');
    if (!text.trim()) throw usage('The message is empty');
    if (text.trim().length > TEXT_MAX) throw usage(`The message is longer than ${TEXT_MAX} characters; shorten it`);
    if (flags.title !== undefined && flags.title.trim().length > TITLE_MAX) throw usage(`The title is longer than ${TITLE_MAX} characters`);
    const via = parseVia(flags.via, usage);
    // The relay is read only now: a usage error is reported first, also outside a T-Agent terminal.
    const relay = ctx.relay();
    const body = { text, ...(flags.title !== undefined ? { title: flags.title } : {}), ...(via !== undefined ? { via } : {}), ...(flags.link !== undefined ? { link: flags.link } : {}) };
    const answer = await callJson(relay, 'POST', '/notify', { body, timeoutMs: SEND_TIMEOUT_MS });
    const results = Array.isArray(answer && answer.results) ? answer.results : [];
    if (flags.json) ctx.out(JSON.stringify(answer, null, 2));
    else ctx.out(formatResults(results) || 'No notifier answered');
    const seen = results.map(describe);
    if (seen.some(result => result.sent)) return EXIT.ok;
    if (seen.some(result => result.failed)) {
      if (!flags.json) ctx.stderr.write('tcli: the message was not sent\n');
      return EXIT.server;
    }
    if (!flags.json) ctx.stderr.write('tcli: the message was not sent (skipped by the user\'s rules); do not try again to get around them\n');
    return EXIT.usage;
  }

  // `tcli notify status` (alone or with --json) is the status; anything else is a message (`tcli notify -- status` sends the word).
  async function run(commandName, rest, ctx) {
    const argv = [commandName, ...rest];
    if (commandName === 'status' && rest.every(arg => arg === '--json')) return status(ctx, rest.includes('--json'));
    return send(ctx, argv);
  }

  return { help: HELP, run, values: ['file', 'title', 'via', 'link'] };
}

module.exports = { createNotifyGroup, formatResults, formatStatus, describe, HELP, TEXT_MAX };
