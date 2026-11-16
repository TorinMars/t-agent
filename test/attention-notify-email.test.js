// The email notifier (plugins/notifiers/email): Gmail / 163 presets and the custom server, ready / status with masked addresses, the item email
// (content and HTML escaping), call -> message fallback, direct messages, SMTP errors mapped without the password, the manifest loaded through
// services/attention-notify.js (settings, allowed modes) and one real nodemailer run against an in-process SMTP server on loopback.
// No network: the transport is a fake, or the SMTP server is a net.Server on 127.0.0.1.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const Database = require('better-sqlite3');
const notify = require('../services/attention-notify');
const email = require('../plugins/notifiers/email');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', 'notifiers', 'email', 'manifest.json'), 'utf8'));
const SECRET = 'attention-notify-email-test-secret-0123456789';
const PASSWORD = 'abcd efgh ijkl mnop';
const GMAIL = { provider: 'gmail', address: 'sam@gmail.com', password: PASSWORD, fromName: 'T-Agent' };

// A transport factory that records what nodemailer would get; `fail` makes sendMail throw.
function fakeTransports(fail = null) {
  const made = [];
  const createTransport = options => {
    const transport = { options, mails: [], closed: false, async sendMail(mail) { transport.mails.push(mail); if (fail) throw fail(); return { messageId: '<1@x>' }; }, close() { transport.closed = true; } };
    made.push(transport);
    return transport;
  };
  return { made, createTransport };
}
const makeDb = () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
  return db;
};
const ITEM = {
  id: 7, status: 'waiting_user', title: 'Fix <script>alert(1)</script> & "login"', source: 'claude', attention_reason: 'Approve the <b>command</b>', link_url: '/attention/7',
  context: {
    pending: { kind: 'permission', text: 'Claude wants to run a command', command: 'rm -rf "<dir>" && echo \'done\'' },
    latest_prompt: 'Make the <img src=x onerror=alert(1)> test pass', cwd: '/home/me/app', branch: 'fix/login', host: 'mac',
    summary: { text: 'Doing: the login\nNeeds: approval' },
    files: [{ path: 'src/a<b>.js', added: 3, deleted: 1 }, { path: 'src/b.js', added: 1, deleted: 0 }],
  },
};

test('Gmail and 163 are presets with implicit TLS on 465; the preset wins over host and port', () => {
  assert.deepEqual(email.serverOf({ provider: 'gmail', host: 'evil.example', port: 25, security: 'none' }), { provider: 'gmail', label: 'Gmail', host: 'smtp.gmail.com', port: 465, security: 'ssl' });
  assert.deepEqual(email.serverOf({ provider: '163', host: 'evil.example', port: 25 }), { provider: '163', label: '163 Mail', host: 'smtp.163.com', port: 465, security: 'ssl' });
  assert.equal(email.serverOf({}).host, 'smtp.gmail.com', 'no provider: Gmail, the manifest default');
  const gmail = email.transportOptions(email.serverOf(GMAIL), GMAIL);
  assert.equal(gmail.secure, true);
  assert.equal(gmail.requireTLS, false);
  assert.equal(gmail.ignoreTLS, false);
  assert.deepEqual(gmail.auth, { user: 'sam@gmail.com', pass: PASSWORD });
  for (const key of ['connectionTimeout', 'greetingTimeout', 'socketTimeout']) assert.equal(gmail[key], 20000);
});

test('a custom server: the port follows the security, STARTTLS is required, plain text only to this computer', () => {
  const custom = config => email.serverOf({ provider: 'custom', ...config });
  assert.deepEqual(custom({ host: 'smtp.example.com' }), { provider: 'custom', label: 'smtp.example.com', host: 'smtp.example.com', port: 465, security: 'ssl' });
  assert.equal(custom({ host: 'smtp.example.com', security: 'starttls' }).port, 587);
  assert.equal(custom({ host: 'smtp.example.com', security: 'starttls', port: 2525 }).port, 2525);
  const starttls = email.transportOptions(custom({ host: 'smtp.example.com', security: 'starttls' }), GMAIL);
  assert.deepEqual([starttls.secure, starttls.requireTLS, starttls.ignoreTLS], [false, true, false]);
  assert.throws(() => custom({ host: 'smtp.example.com', security: 'none' }), /only allowed for an SMTP server on this computer/);
  assert.throws(() => custom({ host: '10.0.0.5', security: 'none' }), /only allowed/);
  assert.deepEqual([custom({ host: '127.0.0.1', security: 'none' }).port, custom({ host: 'localhost', security: 'none', port: 1025 }).port], [25, 1025]);
  assert.throws(() => custom({}), /Enter the SMTP server/);
  assert.throws(() => custom({ host: 'smtp.example.com/x' }), /host name or an IP address/);
});

test('ready and status: masked addresses, never the password, no network', () => {
  const plugin = email.createEmailNotifier({ createTransport: () => { throw new Error('no network in status'); } });
  assert.equal(plugin.ready(GMAIL), true);
  assert.equal(plugin.ready({ ...GMAIL, password: '' }), false);
  assert.equal(plugin.ready({ ...GMAIL, address: 'not an address' }), false);
  assert.equal(plugin.ready({ ...GMAIL, provider: 'custom' }), false, 'a custom server needs its host');
  assert.equal(plugin.ready({ ...GMAIL, provider: 'custom', host: 'smtp.example.com' }), true);
  assert.deepEqual(plugin.status({}), { configured: false, summary: 'Not set up' });
  assert.deepEqual(plugin.status(GMAIL), { configured: true, summary: 'Gmail \u00b7 s***@gmail.com \u2192 s***@gmail.com' });
  assert.deepEqual(plugin.status({ ...GMAIL, provider: '163', address: 'ann@163.com', to: 'me@example.com, you@example.org' }), { configured: true, summary: '163 Mail \u00b7 a***@163.com \u2192 m***@example.com, y***@example.org' });
  assert.equal(plugin.status({ ...GMAIL, password: undefined }).summary, 'Gmail \u00b7 s***@gmail.com \u2192 s***@gmail.com \u00b7 no password saved');
  assert.equal(plugin.status({ ...GMAIL, provider: 'custom', host: 'mail.example.net' }).summary.startsWith('mail.example.net \u00b7 '), true);
  assert.ok(!JSON.stringify(plugin.status(GMAIL)).includes(PASSWORD));
  assert.equal(email.maskAddress('x@y.com'), 'x***@y.com');
  assert.equal(email.maskAddress('nobody'), '***');
});

test('the item email: subject, text and escaped HTML with the context fields; no script, no remote image, no unsafe link', async () => {
  const fake = fakeTransports();
  const plugin = email.createEmailNotifier({ createTransport: fake.createTransport });
  const result = await plugin.notify({ item: ITEM, reason: 'status', mode: 'message', config: { ...GMAIL, to: 'me@example.com' }, link: 'https://t.example.com/attention/7', origin: { name: 'Laptop' } });
  assert.deepEqual(result, { outcome: 'sent' });
  assert.equal(fake.made.length, 1);
  assert.equal(fake.made[0].closed, true, 'the transport is closed after the send');
  const mail = fake.made[0].mails[0];
  assert.deepEqual(mail.from, { name: 'T-Agent', address: 'sam@gmail.com' });
  assert.deepEqual(mail.to, ['me@example.com']);
  assert.equal(mail.subject, '[T-Attention] Needs you \u00b7 Fix <script>alert(1)</script> & "login"');
  assert.equal(mail.disableFileAccess, true);
  assert.equal(mail.disableUrlAccess, true);
  for (const part of ['Needs you \u00b7 Fix', 'From Laptop', 'Needs: Claude wants to run a command', 'rm -rf "<dir>"', 'Reason: Approve the <b>command</b>', 'You asked: Make the', 'Doing: the login\nNeeds: approval', 'Changed: 2 files, +4 -1', '- src/a<b>.js', '/home/me/app \u00b7 fix/login \u00b7 mac \u00b7 claude', 'Open in T-Agent: https://t.example.com/attention/7']) {
    assert.ok(mail.text.includes(part), `text has ${part}`);
  }
  const html = mail.html;
  // Only the plain tags of the layout, attributes only `style` and the one link; every value from the item is text.
  const tags = [...html.matchAll(/<([a-z0-9]+)([^>]*)>/gi)];
  assert.ok([...html.matchAll(/<\/([a-z0-9]+)>/gi)].every(tag => tags.some(open => open[1] === tag[1])));
  assert.deepEqual([...new Set(tags.map(tag => tag[1]))].sort(), ['a', 'blockquote', 'code', 'div', 'li', 'p', 'pre', 'strong', 'ul']);
  for (const [, name, attributes] of tags) assert.match(attributes, name === 'a' ? /^ href="https:\/\/t\.example\.com\/attention\/7"$/ : /^( style="[^"<>]*")?$/);
  assert.ok(html.includes('Fix &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;login&quot;'));
  assert.ok(html.includes('rm -rf &quot;&lt;dir&gt;&quot; &amp;&amp; echo &#39;done&#39;'));
  assert.ok(html.includes('<code>src/a&lt;b&gt;.js</code>'));
  assert.ok(html.includes('<a href="https://t.example.com/attention/7">Open in T-Agent</a>'));
  // A link that is not http(s) is left out; control characters and line breaks never reach the subject.
  await plugin.notify({ item: { ...ITEM, title: 'Line\r\nBcc: evil@example.com' }, reason: 'status', mode: 'message', config: GMAIL, link: 'javascript:alert(1)' });
  const second = fake.made[1].mails[0];
  assert.equal(second.subject, '[T-Attention] Needs you \u00b7 Line Bcc: evil@example.com');
  assert.ok(!second.html.includes('javascript:') && !second.text.includes('javascript:'));
  assert.deepEqual(second.to, ['sam@gmail.com'], 'no recipients: the sender address itself');
  // A message after a failed call says why.
  await plugin.notify({ item: ITEM, reason: 'call_failed', mode: 'message', config: GMAIL, error: 'call limit reached' });
  assert.ok(fake.made[2].mails[0].text.includes('(A call was not possible: call limit reached)'));
});

test('email cannot ring: a call falls back to a message without sending anything', async () => {
  const fake = fakeTransports();
  const plugin = email.createEmailNotifier({ createTransport: fake.createTransport });
  assert.deepEqual(await plugin.notify({ item: ITEM, reason: 'status', mode: 'call', config: GMAIL }), { fallback: 'message', error: 'Email cannot make calls' });
  assert.equal(fake.made.length, 0);
  await assert.rejects(plugin.notify({ item: ITEM, reason: 'status', mode: 'message', config: { ...GMAIL, password: '' } }), error => error.name === 'NotifyError' && /Email is not set up/.test(error.message));
});

test('a direct message: [T-Agent] subject from the title or the first line, the text, who sent it and the link', async () => {
  assert.equal(email.direct, true, 'the plugin says it takes free-form messages');
  const fake = fakeTransports();
  const plugin = email.createEmailNotifier({ createTransport: fake.createTransport });
  await plugin.notify({ reason: 'direct', mode: 'message', item: null, message: { title: 'Build <done>', text: 'All tests pass.\nSee the <report>.', from: 'Task Release \u00b7 Claude 2' }, link: 'https://t.example.com/t/1', config: GMAIL });
  const mail = fake.made[0].mails[0];
  assert.equal(mail.subject, '[T-Agent] Build <done>');
  assert.equal(mail.text, 'All tests pass.\nSee the <report>.\n\nFrom: Task Release \u00b7 Claude 2\n\nOpen in T-Agent: https://t.example.com/t/1');
  assert.ok(mail.html.includes('<strong>Build &lt;done&gt;</strong>'));
  assert.ok(mail.html.includes('See the &lt;report&gt;.'));
  assert.ok(mail.html.includes('From: Task Release \u00b7 Claude 2'));
  assert.ok(!mail.html.includes('<report>'));
  const long = `${'word '.repeat(40)}\nsecond line`;
  await plugin.notify({ reason: 'direct', mode: 'message', item: null, message: { text: long }, config: GMAIL });
  const untitled = fake.made[1].mails[0];
  assert.ok(untitled.subject.startsWith('[T-Agent] word word'));
  assert.ok(untitled.subject.length <= '[T-Agent] '.length + 80);
  assert.ok(untitled.subject.endsWith('\u2026'));
  assert.equal(untitled.text, long.replace(/ \n/, '\n').trim(), 'no From line and no link when they are not given');
  await assert.rejects(plugin.notify({ reason: 'direct', mode: 'message', item: null, message: { text: '  ' }, config: GMAIL }), /no text/);
});

test('SMTP errors become short messages; the password and its base64 forms never reach the error or the log', async () => {
  const base64 = Buffer.from(`\u0000sam@gmail.com\u0000${PASSWORD}`).toString('base64');
  const cases = [
    [() => Object.assign(new Error(`Invalid login: 535 5.7.8 rejected ${PASSWORD}`), { code: 'EAUTH', responseCode: 535, response: `535 5.7.8 ${base64}`, command: `AUTH PLAIN ${base64}` }), email.AUTH_FAILED],
    [() => Object.assign(new Error('connect ECONNREFUSED'), { code: 'ESOCKET', originalCode: 'ECONNREFUSED' }), 'Cannot reach the email server smtp.gmail.com:465'],
    [() => Object.assign(new Error('Greeting never received'), { code: 'ETIMEDOUT' }), 'Cannot reach the email server smtp.gmail.com:465'],
    [() => Object.assign(new Error('wrong version number'), { code: 'ETLS' }), 'The secure connection to the email server smtp.gmail.com:465 failed: check the security setting'],
    [() => Object.assign(new Error('No recipients defined'), { code: 'EENVELOPE' }), 'The email server refused the sender or a recipient address'],
    [() => Object.assign(new Error('Message failed'), { code: 'EMESSAGE', responseCode: 550, response: `550 5.4.5 Daily sending limit exceeded ${Buffer.from(PASSWORD).toString('base64')}` }), 'The email server refused the email (550): 5.4.5 Daily sending limit exceeded [hidden]'],
    [() => new Error(`boom ${PASSWORD}`), 'Sending the email failed'],
  ];
  for (const [fail, expected] of cases) {
    const fake = fakeTransports(fail);
    const logs = [];
    const plugin = email.createEmailNotifier({ createTransport: fake.createTransport });
    await assert.rejects(plugin.notify({ item: ITEM, reason: 'status', mode: 'message', config: GMAIL, log: (level, message) => logs.push(message) }), error => {
      assert.equal(error.name, 'NotifyError');
      assert.equal(error.message, expected);
      return true;
    });
    assert.equal(fake.made[0].closed, true);
    const seen = JSON.stringify(logs);
    assert.ok(!seen.includes(PASSWORD) && !seen.includes(base64), seen);
  }
});

test('the Settings test sends a short test email and names the masked recipients, with a hint when the address does not match the provider', async () => {
  const fake = fakeTransports();
  const plugin = email.createEmailNotifier({ createTransport: fake.createTransport });
  assert.deepEqual(await plugin.test(GMAIL, { kind: 'message', link: 'https://t.example.com/' }), { ok: true, outcome: 'sent', message: 'Test email sent to s***@gmail.com' });
  const mail = fake.made[0].mails[0];
  assert.equal(mail.subject, 'T-Agent test email');
  assert.ok(mail.text.startsWith('This is a test email from T-Agent.'));
  assert.ok(mail.text.includes('Open in T-Agent: https://t.example.com/'));
  const workspace = await plugin.test({ ...GMAIL, address: 'ann@company.example', to: 'me@example.com' }, {});
  assert.equal(workspace.message, 'Test email sent to m***@example.com. The sender address is not a Gmail address; that is fine for a Google Workspace mailbox');
  const netease = await plugin.test({ ...GMAIL, provider: '163', address: 'ann@126.com' }, {});
  assert.equal(netease.message, 'Test email sent to a***@126.com. The sender address does not end with @163.com; check the address');
  assert.equal((await plugin.test({ ...GMAIL, provider: '163', address: 'ann@163.com' }, {})).message, 'Test email sent to a***@163.com');
  await assert.rejects(plugin.test({ ...GMAIL, to: 'me@example.com, nope' }, {}), /Not a valid email address: nope/);
  await assert.rejects(plugin.test({ ...GMAIL, password: '' }, {}), error => error.statusCode === 409);
});

test('the manifest loads through the notify service: settings, secret kept back, allowed modes and refused calls', async t => {
  const scanned = notify.scanNotifiers(undefined, () => {});
  const entry = scanned.loaded.find(loaded => loaded.plugin.name === 'email');
  assert.ok(entry, `email is loaded: ${JSON.stringify(scanned.skipped)}`);
  assert.deepEqual(entry.manifest.modes, ['message', 'off']);
  assert.equal(entry.plugin.direct, true);
  const byKey = Object.fromEntries(entry.manifest.config.map(field => [field.key, field]));
  assert.deepEqual(byKey.provider.options.map(option => option.value), ['gmail', '163', 'custom']);
  assert.equal(byKey.provider.default, 'gmail');
  assert.match(byKey.provider.options[0].help, /https:\/\/myaccount\.google\.com\/apppasswords/);
  assert.match(byKey.provider.options[1].help, /authorization code/);
  assert.equal(byKey.password.type, 'secret');
  for (const key of ['host', 'port', 'security']) assert.deepEqual(byKey[key].showWhen, { key: 'provider', values: ['custom'] });

  const fake = fakeTransports();
  const plugin = email.createEmailNotifier({ createTransport: fake.createTransport });
  const service = notify.createAttentionNotify({ db: makeDb(), sessionSecret: SECRET, onChange: null, getOwner: () => 'owner', notifiers: [plugin], manifests: { email: MANIFEST }, log: () => {} });
  t.after(() => service.stop());
  assert.equal((await service.testPlugin('email', 'owner')).message, 'The plugin is not set up yet');
  const saved = service.savePluginConfig('email', 'owner', { values: { provider: '163', address: 'ann@163.com', password: PASSWORD, to: 'me@example.com' } });
  assert.deepEqual(saved.values.password, { set: true });
  assert.ok(!JSON.stringify(saved).includes(PASSWORD));
  assert.equal(saved.values.fromName, 'T-Agent');
  assert.equal(saved.values.security, 'ssl');
  assert.throws(() => service.savePluginConfig('email', 'owner', { values: { address: '' } }), /Sender email address is required/);
  const tested = await service.testPlugin('email', 'owner');
  assert.deepEqual(tested, { ok: true, message: 'Test email sent to m***@example.com' });
  assert.equal(fake.made[0].options.host, 'smtp.163.com');
  assert.equal(fake.made[0].options.auth.pass, PASSWORD);
  const overview = service.overview('owner').find(row => row.name === 'email');
  assert.equal(overview.configured, true);
  assert.equal(overview.summary, '163 Mail \u00b7 a***@163.com \u2192 m***@example.com');
  assert.deepEqual(overview.statuses, { waiting_user: 'message', failed: 'message', review: 'message' });
  // A status change sends an email (no wait).
  service.saveRules('owner', { messageDelayMinutes: 0 });
  await Promise.all(service.handle({ kind: 'updated', item: ITEM, previous: { ...ITEM, status: 'working' } }));
  assert.equal(fake.made.length, 2);
  assert.match(fake.made[1].mails[0].subject, /^\[T-Attention\] Needs you/);
  assert.equal(service.recent()[0].outcome, 'sent');
  // Calls are refused for email; a call saved before (or synced) counts as a message.
  assert.throws(() => service.saveRules('owner', { modes: { email: { waiting_user: 'call' } } }), /email cannot make calls/);
  service.saveRules('owner', { modes: { email: { waiting_user: 'off', failed: 'message' } } });
  assert.deepEqual(service.overview('owner').find(row => row.name === 'email').statuses, { waiting_user: 'off', failed: 'message', review: 'message' });
});

test('GET /api/attention-notify/config lists the modes each notifier allows', async t => {
  const plugin = email.createEmailNotifier({ createTransport: fakeTransports().createTransport });
  const other = { name: 'bell', label: 'Bell', async notify() { return { outcome: 'sent' }; }, async test() { return { ok: true }; } };
  const service = notify.createAttentionNotify({ db: makeDb(), sessionSecret: SECRET, onChange: null, getOwner: () => 'owner', notifiers: [plugin, other], manifests: { email: MANIFEST }, log: () => {} });
  const app = express();
  app.use((req, res, next) => { req.session = { user: { login: 'owner' } }; next(); });
  app.use('/api/attention-notify', service.createRouter({ requireAuth: (req, res, next) => next() }));
  const server = http.createServer(app).listen(0, '127.0.0.1');
  t.after(() => { server.close(); service.stop(); });
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/attention-notify`;
  const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
  const view = await (await fetch(`${base}/config`, { headers })).json();
  assert.deepEqual(view.modes, ['message', 'call', 'off']);
  assert.deepEqual(Object.fromEntries(view.notifiers.map(row => [row.name, row.modes])), { email: ['message', 'off'], bell: ['message', 'call', 'off'] });
  const refused = await fetch(`${base}/config`, { method: 'PUT', headers, body: JSON.stringify({ modes: { email: { failed: 'call' } } }) });
  assert.equal(refused.status, 400);
  assert.deepEqual(await refused.json(), { error: 'email cannot make calls' });
  const fine = await fetch(`${base}/config`, { method: 'PUT', headers, body: JSON.stringify({ modes: { email: { failed: 'message' }, bell: { failed: 'call' } } }) });
  assert.equal(fine.status, 200);
});

test('manifest checks: modes must be known, off is always allowed; showWhen must name a select and its options', () => {
  assert.deepEqual(notify.checkManifest({}).modes, ['message', 'call', 'off']);
  assert.deepEqual(notify.checkManifest({ modes: ['message'] }).modes, ['message', 'off']);
  assert.deepEqual(notify.checkManifest({ modes: ['call', 'message'] }).modes, ['message', 'call', 'off']);
  for (const modes of [[], ['ring'], ['message', 'message'], 'message']) assert.throws(() => notify.checkManifest({ modes }), /modes must be a list/);
  const select = { key: 'kind', label: 'Kind', type: 'select', options: ['a', { value: 'b', label: 'B', help: 'Only for b' }], default: 'a' };
  const checked = notify.validateConfigSchema([select, { key: 'host', label: 'Host', type: 'string', required: true, showWhen: { key: 'kind', values: ['b', 'b'] } }]);
  assert.deepEqual(checked[0].options, [{ value: 'a', label: 'a' }, { value: 'b', label: 'B', help: 'Only for b' }]);
  assert.deepEqual(checked[1].showWhen, { key: 'kind', values: ['b'] });
  assert.throws(() => notify.validateConfigSchema([select, { key: 'host', label: 'Host', type: 'string', showWhen: { key: 'nope', values: ['b'] } }]), /showWhen.key must name a select field/);
  assert.throws(() => notify.validateConfigSchema([select, { key: 'host', label: 'Host', type: 'string', showWhen: { key: 'kind', values: ['c'] } }]), /showWhen.values must be options of kind/);
  assert.throws(() => notify.validateConfigSchema([{ ...select, options: [{ value: 'a', label: 'A', help: 7 }] }]), /help must be text/);
  // A required field that is hidden is not required; once shown it is.
  assert.deepEqual(notify.normalizeConfigValues(checked, { kind: 'a' }), { kind: 'a' });
  assert.throws(() => notify.normalizeConfigValues(checked, { kind: 'b' }), /Host is required/);
  assert.equal(notify.fieldShown(checked[1], { kind: 'b' }), true);
  assert.equal(notify.fieldShown(checked[1], { kind: 'a' }), false);
});

// A tiny SMTP server on loopback: enough of the protocol for nodemailer (EHLO, AUTH PLAIN / LOGIN, MAIL, RCPT, DATA, QUIT), in plain text.
function smtpServer({ acceptPassword }) {
  const received = [];
  const server = net.createServer(socket => {
    socket.setEncoding('utf8');
    let buffer = '';
    let data = null;
    let login = null;
    const reply = line => socket.write(`${line}\r\n`);
    const checkAuth = (user, pass) => reply(pass === acceptPassword ? '235 2.7.0 Authentication successful' : '535 5.7.8 Authentication credentials invalid');
    reply('220 fake.local ESMTP');
    socket.on('data', chunk => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (data !== null) {
          if (line === '.') { received.push(data.join('\r\n')); data = null; reply('250 2.0.0 Queued'); } else data.push(line.startsWith('..') ? line.slice(1) : line);
          continue;
        }
        if (login === 'user') { login = Buffer.from(line, 'base64').toString(); reply(`334 ${Buffer.from('Password:').toString('base64')}`); continue; }
        if (typeof login === 'string' && login !== 'user') { const user = login; login = null; checkAuth(user, Buffer.from(line, 'base64').toString()); continue; }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO') { reply('250-fake.local'); reply('250-AUTH PLAIN LOGIN'); reply('250 8BITMIME'); }
        else if (verb === 'HELO') reply('250 fake.local');
        else if (/^AUTH PLAIN /i.test(line)) { const [, user, pass] = Buffer.from(line.slice(11), 'base64').toString().split('\u0000'); checkAuth(user, pass); }
        else if (/^AUTH LOGIN$/i.test(line)) { login = 'user'; reply(`334 ${Buffer.from('Username:').toString('base64')}`); }
        else if (verb === 'MAIL' || verb === 'RCPT' || verb === 'RSET' || verb === 'NOOP') reply('250 2.1.0 OK');
        else if (verb === 'DATA') { data = []; reply('354 End data with <CR><LF>.<CR><LF>'); }
        else if (verb === 'QUIT') { reply('221 Bye'); socket.end(); }
        else reply('502 5.5.2 Command not recognized');
      }
    });
    socket.on('error', () => {});
  });
  return { server, received };
}

test('a real nodemailer send to an SMTP server on this computer (security none is allowed on loopback); a wrong password maps to the login message', async t => {
  const fake = smtpServer({ acceptPassword: PASSWORD });
  await new Promise(resolve => fake.server.listen(0, '127.0.0.1', resolve));
  t.after(() => fake.server.close());
  const config = { provider: 'custom', host: '127.0.0.1', port: fake.server.address().port, security: 'none', address: 'me@example.com', password: PASSWORD, fromName: 'T-Agent', to: 'you@example.com' };
  const result = await email.test(config, { link: 'https://t.example.com/' });
  assert.equal(result.message, 'Test email sent to y***@example.com');
  assert.equal(fake.received.length, 1);
  const raw = fake.received[0];
  assert.match(raw, /^Subject: T-Agent test email$/m);
  assert.match(raw, /^From: "T-Agent" <me@example\.com>$/m);
  assert.match(raw, /^To: you@example\.com$/m);
  assert.match(raw, /^Auto-Submitted: auto-generated$/m);
  assert.match(raw, /multipart\/alternative/);
  const logs = [];
  await assert.rejects(email.notify({ item: ITEM, reason: 'status', mode: 'message', config: { ...config, password: 'wrong password' }, log: (level, message) => logs.push(message) }), error => error.message === email.AUTH_FAILED);
  assert.ok(!JSON.stringify(logs).includes('wrong password'));
  // A server that is not there: the connection error names it.
  const closed = net.createServer();
  await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
  const port = closed.address().port;
  await new Promise(resolve => closed.close(resolve));
  await assert.rejects(email.test({ ...config, port }, {}), error => error.message === `Cannot reach the email server 127.0.0.1:${port}`);
});

test('tcli notify reaches email: sendDirect sends a direct email through the real plugin, and an unset email leaves no line on a status change', async t => {
  const fake = fakeTransports();
  const plugin = email.createEmailNotifier({ createTransport: fake.createTransport });
  const service = notify.createAttentionNotify({ db: makeDb(), sessionSecret: SECRET, onChange: null, getOwner: () => 'owner', notifiers: [plugin], manifests: { email: MANIFEST }, log: () => {} });
  t.after(() => service.stop());
  service.saveRules('owner', { messageDelayMinutes: 0 });
  // Not set up: a status change plans nothing and logs nothing; a direct message is refused as not configured.
  await Promise.all(service.handle({ kind: 'updated', item: ITEM, previous: { ...ITEM, status: 'working' } }));
  assert.equal(service.recent().length, 0);
  await assert.rejects(service.sendDirect({ owner: 'owner', text: 'Build finished' }), error => error.code === 'NOTIFY_NOT_CONFIGURED');
  service.savePluginConfig('email', 'owner', { values: GMAIL });
  const answer = await service.sendDirect({ owner: 'owner', title: 'Build finished', text: 'All 1837 tests passed.\nReady to release.', from: 'Fix CI · Claude 1', link: 'https://t.example.com/', via: ['email'] });
  assert.deepEqual(answer.results, [{ notifier: 'email', outcome: 'sent' }]);
  const mail = fake.made.at(-1).mails[0];
  assert.equal(mail.subject, '[T-Agent] Build finished');
  assert.match(mail.text, /All 1837 tests passed\.\nReady to release\./);
  assert.match(mail.text, /Fix CI · Claude 1/);
  assert.match(mail.text, /https:\/\/t\.example\.com\//);
  assert.equal(fake.made.at(-1).options.host, 'smtp.gmail.com');
  assert.equal(service.recent()[0].kind, 'direct');
});
