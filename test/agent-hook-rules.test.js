// The agent hooks T-Agent ships ("Two waiting kinds" and "Activity hooks come with the terminal" in docs/design/terminals.md): every terminal activity
// event the page relies on is in rules/claude/settings.json and rules/codex/hooks.json, with the waiting kind, and each command really posts the
// query the server reads (run with sh against a local server; curl as on the machines that run them). Nothing here reads or writes ~/.claude.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');

process.env.T_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't-agent-hook-rules-'));
const ROOT = path.join(__dirname, '..');
const claude = JSON.parse(fs.readFileSync(path.join(ROOT, 'rules', 'claude', 'settings.json'), 'utf8')).hooks;
const codex = JSON.parse(fs.readFileSync(path.join(ROOT, 'rules', 'codex', 'hooks.json'), 'utf8')).hooks;
const isActivity = group => group.hooks.length > 0 && group.hooks.every(hook => hook.command.includes('$TA_HOOK_URL'));
const isListener = group => group.hooks.some(hook => hook.command.includes('listeners/claude-hook.path'));
// { "<event> <matcher>": query } of the activity groups of one hooks object.
const queries = hooks => Object.fromEntries(Object.entries(hooks).flatMap(([event, groups]) => groups.filter(isActivity)
  .map(group => [`${event} ${group.matcher || '*'}`, group.hooks[0].command.match(/\$TA_HOOK_URL&([^"]+)"/)[1]])));

test('Claude: start, stop, end and both kinds of question, from the Notifications and from the question tools, which end with their PostToolUse', () => {
  assert.deepEqual(queries(claude), {
    'UserPromptSubmit *': 'event=start',
    'Stop *': 'event=stop',
    'Notification permission_prompt|worker_permission_prompt': 'event=attention&kind=accept',
    'Notification elicitation_dialog|elicitation_url_dialog|agent_needs_input': 'event=attention&kind=select',
    'PreToolUse AskUserQuestion': 'event=attention&kind=select&via=tool',
    'PreToolUse ExitPlanMode': 'event=attention&kind=accept&via=tool',
    'PostToolUse AskUserQuestion|ExitPlanMode': 'event=start',
    'PostToolUseFailure AskUserQuestion|ExitPlanMode': 'event=start',
    'SessionEnd *': 'event=end',
  });
  // Every command is quiet, short and never fails the agent (a PreToolUse hook that printed or failed could change the tool call).
  for (const groups of Object.values(claude)) {
    for (const group of groups.filter(isActivity)) {
      for (const hook of group.hooks) assert.match(hook.command, /^\[ -n "\$TA_HOOK_URL" \] && curl -s -m 1 -o \/dev\/null -X POST -H "X-TA-Token: \$TA_HOOK_TOKEN" "\$TA_HOOK_URL&[^"]+" \|\| true$/);
    }
  }
});

test('Claude: the T-Attention listener hears the same events, the question tools included', () => {
  const heard = Object.fromEntries(Object.entries(claude).map(([event, groups]) => [event, groups.filter(isListener).map(group => group.matcher || '*')]));
  assert.deepEqual(heard, {
    UserPromptSubmit: ['*'], Stop: ['*'], SessionEnd: ['*'], StopFailure: ['*'], PostToolUse: ['*'], PostToolUseFailure: ['*'], PermissionRequest: ['*'],
    Notification: ['permission_prompt|elicitation_dialog|elicitation_url_dialog|agent_needs_input|worker_permission_prompt'],
    PreToolUse: ['AskUserQuestion|ExitPlanMode'],
  });
});

test('Codex: its approval prompt (PermissionRequest) is a question of the accept kind', () => {
  assert.deepEqual(queries(codex), {
    'UserPromptSubmit *': 'event=start', 'Stop *': 'event=stop', 'PermissionRequest *': 'event=attention&kind=accept', 'SessionEnd *': 'event=end',
  });
});

test('each activity command posts its query with the terminal token, and does nothing outside a T-Agent terminal', async () => {
  const seen = [];
  const server = http.createServer((req, res) => { seen.push({ method: req.method, url: req.url, token: req.headers['x-ta-token'] }); res.statusCode = 204; res.end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/hooks/terminal-activity?task=7&terminal=t1`;
  const run = (command, env) => new Promise(resolve => execFile('/bin/sh', ['-c', command], { env: { PATH: process.env.PATH, ...env } }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, out: stdout + stderr })));
  try {
    const wanted = queries({ ...claude, ...Object.fromEntries(Object.entries(codex).map(([event, groups]) => [`codex ${event}`, groups])) });
    for (const [key, query] of Object.entries(wanted)) {
      const [event, ...rest] = key.split(' ');
      const groups = event === 'codex' ? codex[rest[0]] : claude[event];
      const matcher = event === 'codex' ? '*' : rest.join(' ');
      const group = groups.filter(isActivity).find(entry => (entry.matcher || '*') === matcher);
      seen.length = 0;
      const result = await run(group.hooks[0].command, { TA_HOOK_URL: base, TA_HOOK_TOKEN: 'secret-token' });
      assert.deepEqual(result, { code: 0, out: '' }, `${key}: quiet and successful`);
      assert.deepEqual(seen, [{ method: 'POST', url: `/hooks/terminal-activity?task=7&terminal=t1&${query}`, token: 'secret-token' }], key);
      seen.length = 0;
      assert.deepEqual(await run(group.hooks[0].command, {}), { code: 0, out: '' }, `${key}: no TA_HOOK_URL, no request, no failure`);
      assert.deepEqual(seen, []);
    }
  } finally { server.close(); }
});
