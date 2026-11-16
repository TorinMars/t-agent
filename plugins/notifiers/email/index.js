// T-Attention notifier: email from the person's own mailbox over SMTP (npm package `nodemailer`, loaded only when an email is sent).
// Settings come from manifest.json (`config`, drawn by the generic form; the password is a manifest secret, so it is stored encrypted with the
// other plugin settings and never sent back to the browser). Gmail and 163 Mail are presets (host, port and implicit TLS are fixed); "Other SMTP
// server" takes a host, a port and the security. A password never goes over plain text to another computer: `none` is refused unless the host is
// this computer (loopback). Email cannot ring, so the manifest allows only "message" and "off", and a call that still arrives falls back to a message.
// Errors are mapped to short English messages; the password (and its base64 forms, which an SMTP AUTH line carries) is never in an error or a log.

const CONNECT_TIMEOUT_MS = 20 * 1000; // connecting, the greeting and an idle socket each give up after this long
const RECIPIENTS_MAX = 10;
const ADDRESS_MAX = 254;
const DIRECT_TEXT_MAX = 3000;
const DIRECT_TITLE_MAX = 200;
const LINK_MAX = 1000;
const FILES_SHOWN = 10;
const DEFAULT_FROM_NAME = 'T-Agent';
const LINK_LABEL = 'Open in T-Agent';
const STATUS_LABELS = { waiting_user: 'Needs you', review: 'Review', failed: 'Failed', working: 'Working', todo: 'To do', done: 'Done', cancelled: 'Cancelled' };

// The built-in providers: the server, port and security are fixed (they win over host / port / security in the settings).
const PRESETS = {
  gmail: { label: 'Gmail', host: 'smtp.gmail.com', port: 465, security: 'ssl', domains: ['gmail.com', 'googlemail.com'] },
  163: { label: '163 Mail', host: 'smtp.163.com', port: 465, security: 'ssl', domains: ['163.com'] },
};
const DEFAULT_PORTS = { ssl: 465, starttls: 587, none: 25 };
const SECURITIES = Object.keys(DEFAULT_PORTS);

const AUTH_FAILED = 'The email server refused the login: check the address and the app password / authorization code';
const NOT_SET_UP = 'Email is not set up: enter the sender address and the app password or authorization code';
const PLAIN_REFUSED = 'Security "None" is only allowed for an SMTP server on this computer; choose SSL/TLS or STARTTLS';
const DOMAIN_HINTS = {
  gmail: 'The sender address is not a Gmail address; that is fine for a Google Workspace mailbox',
  163: 'The sender address does not end with @163.com; check the address',
};

class EmailError extends Error {
  constructor(message, statusCode = 400) { super(message); this.name = 'NotifyError'; this.statusCode = statusCode; }
}

// ---- Text helpers: values are cleaned (control and direction characters removed) and cut before they are escaped ----
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
function cut(value, max) {
  if (value.length <= max) return value;
  const end = /[\ud800-\udbff]/.test(value[max - 2] || '') ? max - 2 : max - 1;
  return `${value.slice(0, Math.max(0, end)).trimEnd()}\u2026`;
}
const oneLine = (value, max) => cut(String(value ?? '').replace(LONE_SURROGATE, '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim(), max);
const lines = (value, max) => cut(String(value ?? '').replace(LONE_SURROGATE, '').replace(/\r\n?/g, '\n').split('\n')
  .map(line => line.replace(CONTROL, ' ').replace(/[ \t]+/g, ' ').trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim(), max);
const escapeHtml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const text = value => (typeof value === 'string' ? value.trim() : '');
const httpLink = value => {
  try {
    const url = new URL(String(value || '').trim());
    return /^https?:$/.test(url.protocol) && url.href.length <= LINK_MAX ? url.href : '';
  } catch { return ''; }
};

// ---- Addresses ----
const ADDRESS = /^[^\s@<>()[\]\\,;:"\u0000-\u001f\u007f]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const validAddress = value => typeof value === 'string' && value.length <= ADDRESS_MAX && ADDRESS.test(value);
function recipientsOf(config) {
  const list = text(config.to).split(/[,;\s]+/).filter(Boolean);
  for (const address of list) if (!validAddress(address)) throw new EmailError(`Not a valid email address: ${oneLine(address, 80)}`);
  if (list.length > RECIPIENTS_MAX) throw new EmailError(`At most ${RECIPIENTS_MAX} recipients`);
  return list.length ? [...new Set(list)] : [text(config.address)];
}
// s***@gmail.com: the first character of the mailbox name and the domain.
function maskAddress(value) {
  const address = text(value);
  const at = address.lastIndexOf('@');
  if (at < 1) return address ? '***' : '';
  return `${address[0]}***${address.slice(at)}`;
}

// ---- The SMTP server of the settings ----
const providerOf = config => (Object.hasOwn(PRESETS, config.provider) || config.provider === 'custom' ? config.provider : 'gmail');
const isLoopback = host => /^(localhost|127(\.\d{1,3}){3}|::1|\[::1\])$/i.test(host);
const HOST = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*|\[?[0-9A-Fa-f:.]+\]?)$/;
// { provider, label, host, port, security }; throws EmailError for a custom server that is incomplete or would send the password in plain text.
function serverOf(config) {
  const provider = providerOf(config);
  if (provider !== 'custom') {
    const preset = PRESETS[provider];
    return { provider, label: preset.label, host: preset.host, port: preset.port, security: preset.security };
  }
  const host = text(config.host).replace(/\.$/, '');
  if (!host) throw new EmailError('Enter the SMTP server');
  if (host.length > 253 || !HOST.test(host)) throw new EmailError('The SMTP server must be a host name or an IP address');
  const security = SECURITIES.includes(config.security) ? config.security : 'ssl';
  if (security === 'none' && !isLoopback(host)) throw new EmailError(PLAIN_REFUSED);
  const port = Number.isInteger(config.port) && config.port >= 1 && config.port <= 65535 ? config.port : DEFAULT_PORTS[security];
  return { provider, label: host, host: host.replace(/^\[|\]$/g, ''), port, security };
}
// The nodemailer transport options: implicit TLS (secure), STARTTLS that must succeed (requireTLS), or plain text to this computer only.
function transportOptions(server, config) {
  return {
    host: server.host,
    port: server.port,
    secure: server.security === 'ssl',
    requireTLS: server.security === 'starttls',
    ignoreTLS: server.security === 'none',
    auth: { user: text(config.address), pass: String(config.password) },
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: CONNECT_TIMEOUT_MS,
    logger: false,
    debug: false,
  };
}
// A short hint when the address does not look like the chosen provider (never a refusal: a Google Workspace address is fine for Gmail).
function domainHint(config) {
  const provider = providerOf(config);
  if (!PRESETS[provider]) return '';
  const domain = text(config.address).split('@').pop().toLowerCase();
  return PRESETS[provider].domains.includes(domain) ? '' : DOMAIN_HINTS[provider];
}

// ---- Errors: a short English message; the password and its base64 forms are removed from anything taken from the server's answer ----
function secretsOf(config) {
  const pass = typeof config.password === 'string' ? config.password : '';
  if (!pass) return [];
  const user = text(config.address);
  return [pass, Buffer.from(pass).toString('base64'), Buffer.from(`\u0000${user}\u0000${pass}`).toString('base64'), Buffer.from(`${user}\u0000${user}\u0000${pass}`).toString('base64')];
}
function scrub(value, config) {
  let out = String(value || '');
  for (const secret of secretsOf(config)) if (secret.length >= 3) out = out.split(secret).join('[hidden]');
  return out;
}
const NETWORK_CODES = new Set(['ECONNECTION', 'ESOCKET', 'ETIMEDOUT', 'EDNS', 'EPROXY', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);
function explain(error, server, config) {
  const code = String((error && error.code) || '');
  const responseCode = Number(error && error.responseCode) || 0;
  const where = server ? `${server.host}:${server.port}` : 'the email server';
  if (code === 'EAUTH' || code === 'ENOAUTH' || responseCode === 535 || responseCode === 534) return AUTH_FAILED;
  if (code === 'ETLS') return `The secure connection to the email server ${where} failed: check the security setting`;
  if (NETWORK_CODES.has(code) || (error && NETWORK_CODES.has(String(error.originalCode || '')))) return `Cannot reach the email server ${where}`;
  if (code === 'EENVELOPE') return 'The email server refused the sender or a recipient address';
  if (responseCode) {
    const answer = oneLine(scrub(error.response, config).replace(/^\d{3}[\s-]*/, ''), 160);
    return `The email server refused the email (${responseCode})${answer ? `: ${answer}` : ''}`;
  }
  return 'Sending the email failed';
}
const logCode = error => [error && error.code, error && error.responseCode].filter(Boolean).join(' ') || 'error';

// ---- The emails ----
function contextOf(item) {
  let context = item && item.context;
  if (typeof context === 'string') { try { context = JSON.parse(context); } catch { context = null; } }
  return context && typeof context === 'object' && !Array.isArray(context) ? context : {};
}
const count = value => (Number.isFinite(value) ? value : 0);
function changedFiles(context) {
  const files = (Array.isArray(context.files) ? context.files : []).filter(file => file && typeof file === 'object' && oneLine(file.path, 1));
  if (!files.length) return null;
  const counted = files.some(file => Number.isFinite(file.added) || Number.isFinite(file.deleted));
  const added = files.reduce((sum, file) => sum + count(file.added), 0);
  const deleted = files.reduce((sum, file) => sum + count(file.deleted), 0);
  return {
    summary: `${files.length} ${files.length === 1 ? 'file' : 'files'}${counted ? `, +${added} -${deleted}` : ''}`,
    paths: files.slice(0, FILES_SHOWN).map(file => oneLine(file.path, 200)),
    more: files.length > FILES_SHOWN ? `and ${files.length - FILES_SHOWN} more` : '',
  };
}
// The parts of an item email: like the Telegram card (what it is, what it needs, what was asked, what changed, where it is), without a size budget.
function partsOf({ item, link, reason, error, origin }) {
  const context = contextOf(item);
  const pending = context.pending && typeof context.pending === 'object' ? context.pending : null;
  const needs = pending ? oneLine(pending.text, 500) : '';
  const why = oneLine(item.attention_reason, 500);
  const summary = context.summary && typeof context.summary === 'object' ? lines(context.summary.text, 1500) : '';
  const lastReply = typeof context.last_reply === 'string' ? lines(context.last_reply.split(/\r?\n/).filter(line => line.trim()).slice(0, 6).join('\n'), 1000) : '';
  const fromName = origin && typeof origin === 'object' ? oneLine(origin.name, 60) : '';
  return {
    status: STATUS_LABELS[item.status] || oneLine(item.status, 30) || 'Update',
    title: oneLine(item.title, 200),
    from: fromName ? `From ${fromName}` : '',
    needs,
    command: pending ? lines(pending.command, 1000) : '',
    reason: why && why !== needs ? why : '',
    asked: oneLine(context.latest_prompt, 300),
    quote: summary || lastReply,
    files: changedFiles(context),
    note: reason === 'call_failed' ? `(A call was not possible: ${oneLine(error || 'unknown error', 200)})` : '',
    where: [oneLine(context.cwd, 200), oneLine(context.branch, 80), oneLine(context.host, 60), oneLine(item.source, 30)].filter(Boolean),
    href: httpLink(link),
  };
}
const STYLE = {
  body: 'font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#222',
  pre: 'white-space:pre-wrap;word-break:break-word;background:#f4f4f4;padding:8px;border-radius:4px;font-family:Menlo,Consolas,monospace;font-size:13px',
  quote: 'white-space:pre-wrap;margin:0;padding:4px 10px;border-left:3px solid #ccc;color:#444',
  muted: 'color:#666;font-size:12px',
};
function itemText(parts) {
  const groups = [
    [`${parts.status}${parts.title ? ` \u00b7 ${parts.title}` : ''}`, parts.from],
    [parts.needs && `Needs: ${parts.needs}`, parts.command, parts.reason && `Reason: ${parts.reason}`],
    [parts.asked && `You asked: ${parts.asked}`, parts.quote],
    parts.files ? [`Changed: ${parts.files.summary}`, ...parts.files.paths.map(path => `- ${path}`), parts.files.more] : [],
    [parts.note],
    [parts.where.join(' \u00b7 '), parts.href && `${LINK_LABEL}: ${parts.href}`],
  ];
  return groups.map(group => group.filter(Boolean).join('\n')).filter(Boolean).join('\n\n');
}
function itemHtml(parts) {
  const p = value => `<p style="margin:0 0 10px">${value}</p>`;
  const label = (name, value) => p(`<strong>${escapeHtml(name)}</strong> ${escapeHtml(value)}`);
  const out = [p(`<strong>${escapeHtml(parts.status)}</strong>${parts.title ? ` \u00b7 <strong>${escapeHtml(parts.title)}</strong>` : ''}`)];
  if (parts.from) out.push(p(escapeHtml(parts.from)));
  if (parts.needs) out.push(label('Needs:', parts.needs));
  if (parts.command) out.push(`<pre style="${STYLE.pre}">${escapeHtml(parts.command)}</pre>`);
  if (parts.reason) out.push(label('Reason:', parts.reason));
  if (parts.asked) out.push(label('You asked:', parts.asked));
  if (parts.quote) out.push(`<blockquote style="${STYLE.quote}">${escapeHtml(parts.quote)}</blockquote>`);
  if (parts.files) {
    out.push(label('Changed:', parts.files.summary));
    out.push(`<ul style="margin:0 0 10px;padding-left:20px">${parts.files.paths.map(path => `<li><code>${escapeHtml(path)}</code></li>`).join('')}</ul>`);
    if (parts.files.more) out.push(p(escapeHtml(parts.files.more)));
  }
  if (parts.note) out.push(p(`<em>${escapeHtml(parts.note)}</em>`));
  if (parts.where.length) out.push(`<p style="margin:0 0 10px;${STYLE.muted}">${parts.where.map(escapeHtml).join(' \u00b7 ')}</p>`);
  if (parts.href) out.push(p(`<a href="${escapeHtml(parts.href)}">${LINK_LABEL}</a>`));
  return `<div style="${STYLE.body}">${out.join('\n')}</div>`;
}
// { subject, text, html } of a status email.
function itemMail(input) {
  const parts = partsOf(input);
  return { subject: oneLine(`[T-Attention] ${parts.status}${parts.title ? ` \u00b7 ${parts.title}` : ''}`, 180), text: itemText(parts), html: itemHtml(parts) };
}
// { subject, text, html } of a direct message (`tcli notify` and similar): [T-Agent] <title, else the first line of the text>, the text,
// "From: <who sent it>" and the link.
function directMail({ message, link }) {
  const body = lines(message && message.text, DIRECT_TEXT_MAX);
  if (!body) throw new EmailError('The message has no text');
  const title = oneLine(message.title, DIRECT_TITLE_MAX);
  const from = oneLine(message.from, 200);
  const href = httpLink(link);
  const subject = oneLine(`[T-Agent] ${title || oneLine(body.split('\n')[0], 80)}`, 180);
  const textBody = [body, from && `From: ${from}`, href && `${LINK_LABEL}: ${href}`].filter(Boolean).join('\n\n');
  const html = [
    title ? `<p style="margin:0 0 10px"><strong>${escapeHtml(title)}</strong></p>` : '',
    `<div style="white-space:pre-wrap;margin:0 0 10px">${escapeHtml(body)}</div>`,
    from ? `<p style="margin:0 0 10px;${STYLE.muted}">From: ${escapeHtml(from)}</p>` : '',
    href ? `<p style="margin:0 0 10px"><a href="${escapeHtml(href)}">${LINK_LABEL}</a></p>` : '',
  ].filter(Boolean).join('\n');
  return { subject, text: textBody, html: `<div style="${STYLE.body}">${html}</div>` };
}
// What the Test button sends: a short note and the real layout with sample data.
const SAMPLE_ITEM = {
  status: 'waiting_user', title: 'Test message', attention_reason: 'This is a test from Settings; the details below are sample data', source: 'claude',
  context: {
    pending: { kind: 'permission', text: 'Claude wants to run a command', tool: 'Bash', command: 'npm test -- --watch' },
    latest_prompt: 'Fix the failing login test', cwd: '/home/me/work/app', branch: 'fix/login', host: 'my-laptop',
    summary: { text: 'Doing: fixing the login test\nProgress: the cause is found\nNeeds: approval to run the tests' },
    files: [{ path: 'src/login.js', added: 30, deleted: 5 }, { path: 'src/session.js', added: 8, deleted: 2 }],
  },
};
const TEST_NOTE = 'This is a test email from T-Agent. Emails about items that need you look like the sample below.';
function testMail({ link, origin }) {
  const sample = itemMail({ item: SAMPLE_ITEM, link, origin });
  return {
    subject: 'T-Agent test email',
    text: `${TEST_NOTE}\n\n---\n\n${sample.text}`,
    html: `<div style="${STYLE.body}"><p style="margin:0 0 10px">${escapeHtml(TEST_NOTE)}</p><hr style="border:0;border-top:1px solid #ddd">${sample.html}</div>`,
  };
}

// options: createTransport(options) -> { sendMail(mail), close() } (tests pass a fake; default nodemailer's, required on the first send).
function createEmailNotifier(options = {}) {
  const createTransport = options.createTransport || (transport => require('nodemailer').createTransport(transport));

  const settingsOf = (config, values) => ({ ...(values || {}), ...(config || {}) });
  function ready(config = {}) {
    if (!validAddress(text(config.address)) || typeof config.password !== 'string' || !config.password) return false;
    return providerOf(config) !== 'custom' || Boolean(text(config.host));
  }

  async function send(config, mail, log) {
    if (!ready(config)) throw new EmailError(NOT_SET_UP, 409);
    const server = serverOf(config);
    const to = recipientsOf(config);
    const fromName = oneLine(config.fromName, 80) || DEFAULT_FROM_NAME;
    let transport = null;
    try {
      transport = createTransport(transportOptions(server, config));
      await transport.sendMail({
        from: { name: fromName, address: text(config.address) }, to, subject: mail.subject, text: mail.text, html: mail.html,
        headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' },
        disableFileAccess: true, disableUrlAccess: true,
      });
      return to;
    } catch (failure) {
      if (failure instanceof EmailError) throw failure;
      if (log) log('warn', `send failed: ${logCode(failure)}`);
      throw new EmailError(explain(failure, server, config), 502);
    } finally {
      if (transport && typeof transport.close === 'function') { try { transport.close(); } catch { /* closing is best effort */ } }
    }
  }

  // ---- The contract interface ----
  async function notify({ item, reason, mode, config, values, log, link, error, origin, message } = {}) {
    const settings = settingsOf(config, values);
    if (!ready(settings)) throw new EmailError(NOT_SET_UP, 409);
    if (mode === 'call') return { fallback: 'message', error: 'Email cannot make calls' };
    const mail = reason === 'direct' ? directMail({ message, link }) : itemMail({ item: item || {}, link, reason, error, origin });
    await send(settings, mail, log);
    return { outcome: 'sent' };
  }
  async function test(config, { link = '', values, log, origin } = {}) {
    const settings = settingsOf(config, values);
    if (!ready(settings)) throw new EmailError(NOT_SET_UP, 409);
    const to = await send(settings, testMail({ link, origin }), log);
    const hint = domainHint(settings);
    return { ok: true, outcome: 'sent', message: `Test email sent to ${to.map(maskAddress).join(', ')}${hint ? `. ${hint}` : ''}` };
  }
  // The plugin overview's line: the provider, the masked sender and the masked recipients. No network, never the password.
  function status(config = {}) {
    const address = text(config.address);
    if (!address) return { configured: false, summary: 'Not set up' };
    const preset = PRESETS[providerOf(config)];
    const label = preset ? preset.label : oneLine(text(config.host), 80) || 'SMTP server';
    let recipients = '';
    try { recipients = recipientsOf(config).map(maskAddress).join(', '); } catch { recipients = 'recipient list is not valid'; }
    const missing = !config.password ? ' \u00b7 no password saved' : '';
    return { configured: ready(config), summary: `${label} \u00b7 ${maskAddress(address)} \u2192 ${recipients}${missing}` };
  }

  return {
    name: 'email',
    label: 'Email',
    configFields: [],
    direct: true,
    ready,
    notify,
    test,
    status,
  };
}

module.exports = createEmailNotifier();
module.exports.createEmailNotifier = createEmailNotifier;
module.exports.serverOf = serverOf;
module.exports.transportOptions = transportOptions;
module.exports.itemMail = itemMail;
module.exports.directMail = directMail;
module.exports.explain = explain;
module.exports.maskAddress = maskAddress;
module.exports.domainHint = domainHint;
module.exports.PRESETS = PRESETS;
module.exports.AUTH_FAILED = AUTH_FAILED;
module.exports.CONNECT_TIMEOUT_MS = CONNECT_TIMEOUT_MS;
