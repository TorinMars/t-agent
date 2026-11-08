// The Telegram notifier (plugins/notifiers/telegram) with a mocked gramjs: login steps, message text, the requestCall / discardCall
// sequence and its timeout, the fallback on call errors, and that the session string, api_hash, code and password never reach a response or a log.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');
const Database = require('better-sqlite3');
const { createAttentionNotify } = require('../services/attention-notify');
const { HTMLParser } = require('telegram/extensions/html');
const { _parseMessageText } = require('telegram/client/messageParse');
const { createTelegramNotifier, messageText, messageHtml, dhHash, proxyFromEnv, MESSAGE_MAX, NETWORK_TIMEOUT_MS, UNREACHABLE } = require('../plugins/notifiers/telegram');

const SECRET = 'attention-telegram-test-secret-012345';
const API_HASH = '0123456789abcdef0123456789abcdef';
const SESSION = '1AgAOMTQ5LjE1NC4xNjcuNTAB-SESSION-SECRET';
const PASSWORD = 'my 2FA password';
const settle = async (rounds = 5) => { for (let i = 0; i < rounds; i += 1) await new Promise(resolve => setImmediate(resolve)); };

// A TL object: { className, ...args }, like gramjs objects.
function tlProxy(prefix = '') {
  return new Proxy({}, {
    get(_, key) {
      if (typeof key !== 'string') return undefined;
      const name = prefix ? `${prefix}.${key}` : key;
      if (/^[a-z]/.test(key)) return tlProxy(name);
      return function TL(args = {}) { return { className: name, ...args }; };
    },
  });
}
function rpcError(errorMessage, extra = {}) { return Object.assign(new Error(`RPCError ${errorMessage}`), { errorMessage, ...extra }); }

// The gramjs mock. `handlers` answers client.invoke by the request's className.
function mockGram() {
  const state = { clients: [], invokes: [], messages: [], handlers: {}, sendCode: null, entity: null };
  class TelegramClient {
    constructor(session, apiId, apiHash, params) {
      this.session = session; this.apiId = apiId; this.apiHash = apiHash; this.params = params; this.events = []; this.connected = false;
      state.clients.push(this);
    }
    connect() { if (state.connect) return state.connect(this); this.connected = true; return Promise.resolve(true); }
    async disconnect() { this.connected = false; }
    async destroy() { this.connected = false; this.destroyed = (this.destroyed || 0) + 1; }
    async sendCode(credentials, phone) { state.sendCodeArgs = { credentials, phone }; if (state.sendCode) return state.sendCode(); return { phoneCodeHash: 'hash-1', isCodeViaApp: true }; }
    async invoke(request) {
      state.invokes.push(request);
      const handler = state.handlers[request.className];
      if (!handler) return {};
      return handler(request, this);
    }
    async sendMessage(peer, options) { state.messages.push({ peer, ...options }); if (state.sendMessage) return state.sendMessage(); return {}; }
    async getMe() { return { id: 1001, firstName: 'Account', lastName: 'One', username: 'acc_one', phone: '8613800000078' }; }
    async _switchDC(dcId) { state.switchedTo = dcId; }
    async getDialogs() { state.dialogsRead = true; return []; }
    async getEntity(input) { state.entityInput = input; if (state.entity) return state.entity(input); return { className: 'User', id: 2002, accessHash: '-55', firstName: 'Account', lastName: 'Two', username: 'acc_two' }; }
    addEventHandler(fn) { this.events.push(fn); }
    removeEventHandler(fn) { this.events = this.events.filter(item => item !== fn); }
    emit(update) { for (const fn of this.events) fn(update); }
  }
  class StringSession { constructor(value) { this.value = value; } save() { return this.value || SESSION; } }
  const gram = {
    Api: tlProxy(), TelegramClient, sessions: { StringSession }, Logger: class { constructor(level) { this.level = level; } },
    helpers: { returnBigInt: value => `big:${value}` },
    password: { computeCheck: async (info, password) => ({ className: 'InputCheckPasswordSRP', srpId: info.srpId, ok: password === PASSWORD }) },
  };
  return { gram, state };
}
function fakeTimers() {
  let seq = 0;
  const list = new Map();
  return {
    setTimeout: (fn, ms) => { const id = ++seq; list.set(id, { fn, ms }); return id; },
    clearTimeout: id => list.delete(id),
    fireWhere(test) { for (const [id, timer] of list) if (test(timer)) { list.delete(id); timer.fn(); return true; } return false; },
    list,
  };
}
const dhConfig = () => {
  const p = crypto.randomBytes(256);
  p[0] |= 0x80; p[255] |= 1;
  return { className: 'messages.DhConfig', g: 3, p, version: 1, random: crypto.randomBytes(256) };
};
const savedConfig = extra => ({ apiId: 12345, apiHash: API_HASH, session: SESSION, phone: '+86*******78', account: { id: '1001', name: 'Account One', username: 'acc_one' }, target: { input: 'acc_two', id: '2002', accessHash: '-55', username: 'acc_two', name: 'Account Two' }, ...extra });

// The real gramjs HTML parser: [text, [{ type, offset, length, covered text, url }]].
function parsed(html) {
  const [text, entities] = HTMLParser.parse(html);
  return { text, entities: entities.map(entity => ({ type: entity.className.replace('MessageEntity', ''), text: text.slice(entity.offset, entity.offset + entity.length), ...(entity.url ? { url: entity.url } : {}) })) };
}
const NEEDS_YOU = '\u{1F64B}';
const LINK = 'https://t.example.com/?attention=4';
const fullItem = (extra = {}) => ({
  status: 'waiting_user', title: 'Fix the build', attention_reason: 'Blocked on approval', source: 'claude',
  context: {
    pending: { kind: 'permission', text: 'Claude wants to run a command', tool: 'Bash', command: 'npm test -- --watch' },
    latest_prompt: 'Make the build green\nand keep it short', summary: { text: 'Doing: build fix\nProgress: tests pass' }, last_reply: 'not used while there is a summary',
    files: [{ path: 'path/a.js', added: 40, deleted: 7 }, { path: 'path/b.js', added: 2, deleted: 0 }, { path: 'path/c.js', added: 0, deleted: 0 }],
    cwd: '/Users/me/work/app', branch: 'feat/x', host: 'mac',
  },
  ...extra,
});

test('the card with every optional line, in HTML and as parsed by the real gramjs parser', () => {
  const html = messageHtml({ item: fullItem(), link: LINK, reason: 'call_failed', error: 'no calls' });
  assert.equal(html, [
    `${NEEDS_YOU} <b>Needs you</b> \u00b7 <b>Fix the build</b>`, '',
    '<b>Needs:</b> Claude wants to run a command', '<pre>npm test -- --watch</pre>', '<b>Reason:</b> Blocked on approval', '',
    '<b>You asked:</b> Make the build green and keep it short', '<blockquote>Doing: build fix\nProgress: tests pass</blockquote>', '',
    '<b>Changed:</b> 3 files, +42 -7', '\u2022 path/a.js', '\u2022 path/b.js', '\u2022 path/c.js', '',
    '<i>(A call was not possible: no calls)</i>', '',
    '<code>/Users/me/work/app</code> \u00b7 <code>feat/x</code> \u00b7 mac \u00b7 claude', `<a href="${LINK}">Open in T-Agent</a>`,
  ].join('\n'));
  const { text, entities } = parsed(html);
  assert.equal(text, messageText({ item: fullItem(), link: LINK, reason: 'call_failed', error: 'no calls' }).replace(`Open: ${LINK}`, 'Open in T-Agent'), 'the plain card is the same text, with the address written out');
  assert.deepEqual(entities, [
    { type: 'Bold', text: 'Needs you' }, { type: 'Bold', text: 'Fix the build' }, { type: 'Bold', text: 'Needs:' }, { type: 'Pre', text: 'npm test -- --watch' }, { type: 'Bold', text: 'Reason:' },
    { type: 'Bold', text: 'You asked:' }, { type: 'Blockquote', text: 'Doing: build fix\nProgress: tests pass' }, { type: 'Bold', text: 'Changed:' },
    { type: 'Italic', text: '(A call was not possible: no calls)' }, { type: 'Code', text: '/Users/me/work/app' }, { type: 'Code', text: 'feat/x' }, { type: 'TextUrl', text: 'Open in T-Agent', url: LINK },
  ]);
});

test('every optional line is left out when it has no value, and no empty tag is written', () => {
  const header = `${NEEDS_YOU} <b>Needs you</b> \u00b7 <b>x</b>`;
  const card = (context, extra) => messageHtml({ item: { status: 'waiting_user', title: 'x', context, ...extra } });
  assert.equal(card(undefined), header);
  assert.equal(card('not json'), header);
  assert.equal(card({ pending: { text: '  ', command: '\u0007' }, latest_prompt: ' ', summary: { text: '\n \n' }, last_reply: '\n', files: [], cwd: '', branch: '', host: '' }), header);
  assert.equal(card({ pending: { text: 'go' } }), `${header}\n\n<b>Needs:</b> go`);
  assert.equal(card({ pending: { command: 'ls' } }), `${header}\n\n<pre>ls</pre>`);
  assert.equal(card({ latest_prompt: 'hello' }), `${header}\n\n<b>You asked:</b> hello`);
  assert.equal(card({ branch: 'main' }), `${header}\n\n<code>main</code>`);
  assert.equal(card({ host: 'mac' }), `${header}\n\nmac`);
  assert.equal(card(undefined, { attention_reason: 'because' }), `${header}\n\n<b>Reason:</b> because`);
  assert.equal(card(undefined, { source: 'cli' }), `${header}\n\ncli`);
  assert.equal(messageHtml({ item: { status: 'failed' } }), '\u274c <b>Failed</b>', 'no title, no separator');
  assert.equal(messageText({ item: { status: 'review', title: 'y' } }), '\u{1F440} Review \u00b7 y');
  assert.equal(card({ pending: { text: 'same' } }, { attention_reason: 'same' }), `${header}\n\n<b>Needs:</b> same`, 'a reason equal to the pending text is not repeated');
});

test('each status has its own emoji, and an unknown status still has a header', () => {
  const emoji = { waiting_user: '\u{1F64B}', review: '\u{1F440}', failed: '\u274c', working: '\u23f3', todo: '\u{1F4DD}', done: '\u2705', cancelled: '\u{1F6AB}' };
  assert.equal(new Set(Object.values(emoji)).size, 7);
  for (const [status, mark] of Object.entries(emoji)) assert.ok(messageHtml({ item: { status, title: 'x' } }).startsWith(`${mark} <b>`), status);
  assert.equal(messageHtml({ item: { status: 'odd<x>', title: 'x' } }), '\u{1F514} <b>odd&lt;x&gt;</b> \u00b7 <b>x</b>');
});

test('the quote is the summary (also from a JSON string), else the first three lines of the last reply', () => {
  const context = { last_reply: '\n\nFirst.\n\nSecond.\nThird.\nFourth.' };
  assert.match(messageHtml({ item: { status: 'review', title: 'x', context } }), /<blockquote>First\.\nSecond\.\nThird\.<\/blockquote>$/);
  const withSummary = messageHtml({ item: { status: 'review', title: 'x', context: JSON.stringify({ ...context, summary: { text: 'Doing: a\nNeeds: b', at: '2026-11-08T00:00:00Z', model: 'm' } }) } });
  assert.match(withSummary, /<blockquote>Doing: a\nNeeds: b<\/blockquote>$/);
  assert.equal(withSummary.includes('First.'), false);
});

test('text from users or the agent is escaped: tags, entities and Markdown appear literally', () => {
  const hostile = 'A <b>bold</b> </pre> </blockquote> &amp; &lt; <a href="http://evil">x</a> **m** __u__ `c` [l](http://evil) "q" \'s\'';
  const item = {
    status: 'failed', title: hostile, attention_reason: hostile, source: '<i>s</i>',
    context: { pending: { text: `${hostile}!`, command: hostile }, latest_prompt: hostile, summary: { text: hostile }, files: [{ path: '<b>a</b>&amp;.js' }], cwd: '</code>&amp;', branch: '<code>', host: '<u>h</u>' },
  };
  const { text, entities } = parsed(messageHtml({ item, link: LINK }));
  const body = text.split('\n');
  assert.equal(body[0], `\u274c Failed \u00b7 ${hostile}`);
  assert.ok(body.includes(`Needs: ${hostile}!`));
  assert.ok(body.includes(hostile), 'the command');
  assert.ok(body.includes(`Reason: ${hostile}`));
  assert.ok(body.includes(`You asked: ${hostile}`));
  assert.ok(body.includes('\u2022 <b>a</b>&amp;.js'));
  assert.ok(body.includes('</code>&amp; \u00b7 <code> \u00b7 <u>h</u> \u00b7 <i>s</i>'));
  assert.deepEqual(entities.map(entity => entity.type), ['Bold', 'Bold', 'Bold', 'Pre', 'Bold', 'Bold', 'Blockquote', 'Bold', 'Code', 'Code', 'TextUrl'], 'only the tags of the card');
  assert.deepEqual(entities.filter(entity => entity.url).map(entity => entity.url), [LINK], 'the address in the text made no link');
  assert.deepEqual(entities.find(entity => entity.type === 'Blockquote').text, hostile);
});

test('control and direction characters are removed in both formats', () => {
  const item = { status: 'failed', title: 'Ti\u0007tle\u202e one\u2066', context: { pending: { command: 'a\u0000b\u200b' }, latest_prompt: 'x\u2028y' } };
  for (const body of [messageText({ item }), parsed(messageHtml({ item })).text]) {
    assert.equal(/[\u0000-\u0009\u000b-\u001f\u007f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(body), false);
    assert.ok(body.includes('Ti tle one'));
    assert.ok(body.includes('You asked: x y'));
  }
});

test('values are cut before they are escaped, so no entity or tag is ever cut in half', () => {
  for (const fill of ['&', '<', '>', 'a&', '&amp;']) {
    const item = { status: 'failed', title: fill.repeat(1000), context: { pending: { text: fill.repeat(1000), command: fill.repeat(1000) }, latest_prompt: fill.repeat(1000), summary: { text: fill.repeat(1000) }, cwd: fill.repeat(1000) } };
    const html = messageHtml({ item, link: LINK });
    assert.equal(/&(?!amp;|lt;|gt;)/.test(html), false, `a broken entity with ${fill}`);
    const { text, entities } = parsed(html);
    assert.equal(entities.at(-1).url, LINK);
    assert.ok(text.split('\n')[0].endsWith('\u2026'), 'the title is cut with an ellipsis');
    assert.equal(text.includes('&amp;amp;'), false);
    const title = text.split('\n')[0].slice('\u274c Failed \u00b7 '.length);
    assert.ok(title.length <= 200, `the visible title is cut, not the escaped one: ${title.length}`);
  }
});

test('the link: only http(s) goes in the href, escaped; anything else is left out', () => {
  for (const link of ['javascript:alert(1)', 'tg://resolve?domain=x', 'data:text/html,x', 'file:///etc/passwd', '/relative/path', 'not a url', '', null, undefined, 5]) {
    const html = messageHtml({ item: { status: 'failed', title: 'x' }, link });
    assert.equal(html, '\u274c <b>Failed</b> \u00b7 <b>x</b>', String(link));
    assert.equal(messageText({ item: { status: 'failed', title: 'x' }, link }), '\u274c Failed \u00b7 x', String(link));
  }
  assert.match(messageHtml({ item: { status: 'failed', title: 'x' }, link: 'HTTP://t.example.com/a' }), /<a href="http:\/\/t\.example\.com\/a">Open in T-Agent<\/a>$/);
  const tricky = 'https://t.example.com/a\'b?x=1&y="><script>';
  const { entities } = parsed(messageHtml({ item: { status: 'failed', title: 'x' }, link: tricky }));
  assert.equal(entities.at(-1).type, 'TextUrl');
  assert.equal(entities.at(-1).url, new URL(tricky).href, 'the quotes and & are decoded back to the same address');
  const raw = messageHtml({ item: { status: 'failed', title: 'x' }, link: tricky });
  assert.equal(raw.includes('<script>'), false);
  assert.equal(/href="[^"]*'/.test(raw), false);
  assert.equal(messageHtml({ item: { status: 'failed', title: 'x' }, link: `https://t.example.com/${'a'.repeat(2000)}` }), '\u274c <b>Failed</b> \u00b7 <b>x</b>', 'too long to keep whole: left out, never cut');
});

test('a link gramjs would read as a mention is shown as text, because gramjs would drop it from the message', async () => {
  const lookups = [];
  const client = { getInputEntity: async value => { lookups.push(value); throw new Error('no such user'); } };
  const plus = 'https://t.example.com/a+b?q=1+2&x=1';
  const html = messageHtml({ item: { status: 'failed', title: 'x' }, link: plus });
  assert.equal(html.includes('<a '), false);
  const [text, entities] = await _parseMessageText(client, html, 'html');
  assert.ok(text.endsWith(`Open in T-Agent: ${plus}`), 'the whole address can still be followed');
  assert.deepEqual(lookups, [], 'gramjs looks nothing up');
  assert.deepEqual(entities.map(entity => entity.className), ['MessageEntityBold', 'MessageEntityBold']);
  const [, dropped] = await _parseMessageText(client, `<a href="${plus}">x</a>`, 'html');
  assert.deepEqual(dropped, [], 'why: as a link, gramjs would lose it');
  assert.equal(lookups.length, 1);
  const [, kept] = await _parseMessageText(client, messageHtml({ item: { status: 'failed', title: 'x' }, link: LINK }), 'html');
  assert.equal(kept.at(-1).url, LINK, 'an ordinary link stays a link through the whole send path');
  assert.equal(lookups.length, 1);
});

test('the file list shows at most 3 names with "and N more", and a long path keeps its end', () => {
  const files = n => Array.from({ length: n }, (_, index) => ({ path: `src/f${index}.js`, added: 1, deleted: 2 }));
  const card = list => parsed(messageHtml({ item: { status: 'review', title: 'x', context: { files: list } } })).text.split('\n').slice(2);
  assert.deepEqual(card(files(1)), ['Changed: 1 file, +1 -2', '\u2022 src/f0.js']);
  assert.deepEqual(card(files(3)), ['Changed: 3 files, +3 -6', '\u2022 src/f0.js', '\u2022 src/f1.js', '\u2022 src/f2.js']);
  assert.deepEqual(card(files(50)), ['Changed: 50 files, +50 -100', '\u2022 src/f0.js', '\u2022 src/f1.js', '\u2022 src/f2.js', 'and 47 more']);
  assert.deepEqual(card([{ path: 'a.js' }, { path: 'b.js' }]), ['Changed: 2 files', '\u2022 a.js', '\u2022 b.js'], 'no counts known: none shown');
  assert.deepEqual(card([{ path: 'a.js', added: 5 }]), ['Changed: 1 file, +5 -0', '\u2022 a.js']);
  assert.deepEqual(card([null, 'x', { path: '' }, { added: 1 }]), [], 'unusable entries are not counted');
  const [, long] = card([{ path: `${'d/'.repeat(100)}name.js` }]);
  assert.ok(long.endsWith('name.js') && long.startsWith('\u2022 \u2026') && long.length <= 102, long);
});

test('the length limit holds in the visible and raw text and keeps the header, the note, the footer and the link', () => {
  for (const fill of ['y', '&', '<', '\u{1F600}', '\u6d4b']) {
    const long = fill.repeat(5000);
    const input = {
      item: { status: 'failed', title: `Start ${long}`, attention_reason: long, source: long,
        context: { pending: { text: long, command: `${long}\n${long}` }, latest_prompt: long, summary: { text: `${long}\n${long}\n${long}` }, cwd: long, branch: long, host: long,
          files: Array.from({ length: 50 }, () => ({ path: long, added: 1, deleted: 1 })) } },
      link: LINK, reason: 'call_failed', error: long,
    };
    const html = messageHtml(input);
    const { text, entities } = parsed(html);
    const plain = messageText(input);
    assert.ok(text.length <= MESSAGE_MAX, `visible ${text.length} with ${fill}`);
    assert.ok(plain.length <= MESSAGE_MAX, `plain ${plain.length} with ${fill}`);
    assert.ok(MESSAGE_MAX <= 4096);
    assert.ok(html.length <= MESSAGE_MAX * 5 + 500, `raw ${html.length} with ${fill}`);
    assert.ok(text.startsWith('\u274c Failed \u00b7 Start'), 'the header');
    assert.ok(text.endsWith('Open in T-Agent'), 'the link text');
    assert.ok(plain.endsWith(`Open: ${LINK}`), 'the link in the plain card');
    assert.equal(entities.at(-1).url, LINK, 'the link entity');
    assert.ok(entities.some(entity => entity.type === 'Italic' && entity.text.startsWith('(A call was not possible')), 'the note');
    assert.ok(entities.filter(entity => entity.type === 'Code').length === 2, 'the folder and the branch');
    assert.equal(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text), false, 'no half emoji');
    for (const entity of entities) assert.ok(entity.text.length > 0);
  }
});

test('the longest allowed link still leaves the card under the limit', () => {
  const link = `https://t.example.com/${'a'.repeat(970)}`;
  const long = 'z'.repeat(5000);
  const input = { item: { status: 'failed', title: long, attention_reason: long, context: { pending: { text: long, command: long }, latest_prompt: long, summary: { text: long }, cwd: long, branch: long, host: long } }, link, reason: 'call_failed', error: long };
  const plain = messageText(input);
  assert.ok(plain.length <= MESSAGE_MAX, `plain ${plain.length}`);
  assert.ok(plain.endsWith(`Open: ${link}`));
  assert.ok(parsed(messageHtml(input)).text.length <= MESSAGE_MAX);
});

test('Chinese text in the fields stays intact', () => {
  const zh = '\u4fee\u590d\u767b\u5f55\u95ee\u9898';
  const input = { item: { status: 'review', title: zh, attention_reason: `${zh}\u539f\u56e0`, context: { pending: { text: `${zh}\u9700\u8981`, command: `echo ${zh}` }, latest_prompt: `${zh}\u8bf7\u6c42`, summary: { text: `${zh}\u6458\u8981` }, files: [{ path: `\u6587\u4ef6/${zh}.js`, added: 1, deleted: 1 }], cwd: `/\u9879\u76ee/${zh}`, branch: `\u5206\u652f-${zh}`, host: '\u4e3b\u673a' } }, link: LINK };
  const { text, entities } = parsed(messageHtml(input));
  for (const part of [zh, `Needs: ${zh}\u9700\u8981`, `echo ${zh}`, `Reason: ${zh}\u539f\u56e0`, `You asked: ${zh}\u8bf7\u6c42`, `${zh}\u6458\u8981`, `\u2022 \u6587\u4ef6/${zh}.js`, `/\u9879\u76ee/${zh} \u00b7 \u5206\u652f-${zh} \u00b7 \u4e3b\u673a`]) assert.ok(text.includes(part), part);
  assert.equal(entities.find(entity => entity.type === 'Pre').text, `echo ${zh}`, 'offsets stay right after wide characters and the emoji');
  assert.equal(entities.find(entity => entity.type === 'Blockquote').text, `${zh}\u6458\u8981`);
});

test('messages are sent as Telegram HTML, without a link preview', async () => {
  const { gram, state } = mockGram();
  const plugin = createTelegramNotifier({ loadGram: () => gram, timers: fakeTimers() });
  await plugin.notify({ item: { status: 'failed', title: '**bold** <b>' }, mode: 'message', config: savedConfig() });
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].parseMode, 'html');
  assert.equal(state.messages[0].linkPreview, false);
  assert.equal(state.messages[0].message, '\u274c <b>Failed</b> \u00b7 <b>**bold** &lt;b&gt;</b>');
  plugin.close();
});

test('when Telegram refuses the entities the card is sent once more as plain text, and the log holds no content', async () => {
  for (const refusal of ['ENTITY_BOUNDS_INVALID', 'ENTITY_TEXT_INVALID', 'ENTITIES_TOO_LONG', 'MESSAGE_EMPTY', 'MESSAGE_TOO_LONG']) {
    const { gram, state } = mockGram();
    const logs = [];
    const plugin = createTelegramNotifier({ loadGram: () => gram, timers: fakeTimers() });
    let calls = 0;
    state.sendMessage = () => { calls += 1; if (calls === 1) throw rpcError(refusal); return {}; };
    const item = fullItem({ title: 'Secret title <b>' });
    assert.deepEqual(await plugin.notify({ item, mode: 'message', config: savedConfig(), link: LINK, log: (level, message) => logs.push(`${level} ${message}`) }), { outcome: 'sent' }, refusal);
    assert.equal(state.messages.length, 2);
    assert.equal(state.messages[0].parseMode, 'html');
    assert.deepEqual([state.messages[1].parseMode, state.messages[1].linkPreview], [false, false]);
    assert.equal(state.messages[1].message, messageText({ item, link: LINK }));
    assert.ok(state.messages[1].message.includes('Secret title <b>'), 'plain text is not escaped');
    assert.deepEqual(state.messages[1].peer, state.messages[0].peer);
    assert.deepEqual(logs, [`warn formatted message refused (${refusal}), sending plain text`]);
    plugin.close();
  }
});

test('the plain copy is tried once only, and other errors are not retried', async () => {
  const { gram, state } = mockGram();
  const plugin = createTelegramNotifier({ loadGram: () => gram, timers: fakeTimers() });
  const send = () => plugin.notify({ item: { status: 'failed', title: 'x' }, mode: 'message', config: savedConfig() });
  state.sendMessage = () => { throw rpcError('ENTITY_BOUNDS_INVALID'); };
  await assert.rejects(send(), /Telegram error ENTITY_BOUNDS_INVALID/);
  assert.equal(state.messages.length, 2, 'one formatted and one plain attempt');
  state.messages.length = 0;
  for (const other of [rpcError('FLOOD', { seconds: 5 }), rpcError('USER_IS_BLOCKED'), new Error('socket closed')]) {
    state.sendMessage = () => { throw other; };
    await assert.rejects(send());
    assert.equal(state.messages.length, 1, String(other));
    state.messages.length = 0;
  }
  plugin.close();
});

test('the test message from Settings uses the same card with realistic sample content', async () => {
  const { gram, state } = mockGram();
  const plugin = createTelegramNotifier({ loadGram: () => gram, timers: fakeTimers() });
  assert.deepEqual(await plugin.test(savedConfig(), { kind: 'message', link: LINK }), { ok: true, outcome: 'sent' });
  assert.equal(state.messages[0].parseMode, 'html');
  const { text, entities } = parsed(state.messages[0].message);
  assert.ok(text.startsWith(`${NEEDS_YOU} Needs you \u00b7 Test message\n\n`));
  assert.match(text, /sample data/);
  assert.deepEqual([...new Set(entities.map(entity => entity.type))].sort(), ['Blockquote', 'Bold', 'Code', 'Pre', 'TextUrl']);
  assert.match(text, /\nand 1 more\n/);
  plugin.close();
});

test('the Diffie-Hellman hash is 32 bytes of sha256 over a 256-byte g^a', () => {
  const hash = dhHash(dhConfig());
  assert.equal(hash.length, 32);
});

test('notify(message) sends to the stored account 2 with the gramjs client of the saved session', async () => {
  const { gram, state } = mockGram();
  const plugin = createTelegramNotifier({ loadGram: () => gram, timers: fakeTimers() });
  assert.equal(plugin.ready({}), false);
  assert.equal(plugin.ready(savedConfig()), true);
  await plugin.notify({ item: { status: 'failed', title: 'Deploy', source: 'cli' }, mode: 'message', reason: 'status', config: savedConfig(), link: '' });
  await plugin.notify({ item: { status: 'review', title: 'Second' }, mode: 'message', reason: 'status', config: savedConfig(), link: '' });
  assert.equal(state.clients.length, 1, 'the connected client is reused');
  assert.equal(state.clients[0].session.value, SESSION);
  assert.equal(state.clients[0].params.baseLogger.level, 'none', 'gramjs logging is off');
  assert.deepEqual(state.messages[0].peer, { className: 'InputPeerUser', userId: 'big:2002', accessHash: 'big:-55' });
  assert.equal(state.messages[0].message, '\u274C <b>Failed</b> \u00b7 <b>Deploy</b>\n\ncli');
  state.sendMessage = () => { throw rpcError('FLOOD', { seconds: 42 }); };
  await assert.rejects(plugin.notify({ item: { status: 'failed', title: 'x' }, mode: 'message', config: savedConfig() }), /wait 42 seconds/);
  plugin.close();
});

test('a call: GetDhConfig, RequestCall with g_a_hash and protocol, then DiscardCall after the ring time', async () => {
  const { gram, state } = mockGram();
  const timers = fakeTimers();
  state.handlers['messages.GetDhConfig'] = () => dhConfig();
  state.handlers['phone.RequestCall'] = () => ({ className: 'phone.PhoneCall', phoneCall: { className: 'PhoneCallWaiting', id: '77', accessHash: '88' } });
  const plugin = createTelegramNotifier({ loadGram: () => gram, timers });
  const pending = plugin.notify({ item: { status: 'waiting_user', title: 'x' }, mode: 'call', reason: 'status', config: savedConfig({ callSeconds: 20 }) });
  await settle();
  const names = state.invokes.map(request => request.className);
  assert.deepEqual(names, ['messages.GetDhConfig', 'phone.RequestCall']);
  const request = state.invokes[1];
  assert.deepEqual(request.userId, { className: 'InputUser', userId: 'big:2002', accessHash: 'big:-55' });
  assert.equal(request.gAHash.length, 32);
  assert.equal(request.video, false);
  assert.equal(request.protocol.className, 'PhoneCallProtocol');
  assert.ok(request.protocol.udpP2p && request.protocol.udpReflector && request.protocol.maxLayer >= request.protocol.minLayer);
  assert.ok(timers.fireWhere(timer => timer.ms === 20000), 'rings 20 seconds');
  assert.deepEqual(await pending, { outcome: 'call_timeout' });
  const discard = state.invokes[2];
  assert.equal(discard.className, 'phone.DiscardCall');
  assert.deepEqual(discard.peer, { className: 'InputPhoneCall', id: '77', accessHash: '88' });
  assert.equal(discard.reason.className, 'PhoneCallDiscardReasonMissed');
  assert.equal(discard.duration, 0);
  assert.equal(state.clients[0].events.length, 0, 'the update handler is removed');
  plugin.close();
});

test('a call ends at once when account 2 answers (hang up) or declines (nothing to discard)', async () => {
  const { gram, state } = mockGram();
  state.handlers['messages.GetDhConfig'] = () => dhConfig();
  state.handlers['phone.RequestCall'] = () => ({ phoneCall: { id: '77', accessHash: '88' } });
  const plugin = createTelegramNotifier({ loadGram: () => gram, timers: fakeTimers() });
  const answered = plugin.notify({ item: { status: 'failed', title: 'x' }, mode: 'call', config: savedConfig() });
  await settle();
  state.clients[0].emit({ className: 'UpdatePhoneCall', phoneCall: { className: 'PhoneCallAccepted', id: '99' } }); // another call: ignored
  state.clients[0].emit({ className: 'UpdatePhoneCall', phoneCall: { className: 'PhoneCallAccepted', id: '77' } });
  assert.deepEqual(await answered, { outcome: 'call_answered' });
  assert.equal(state.invokes.at(-1).className, 'phone.DiscardCall');
  assert.equal(state.invokes.at(-1).reason.className, 'PhoneCallDiscardReasonHangup');
  const before = state.invokes.length;
  const declined = plugin.notify({ item: { status: 'failed', title: 'x' }, mode: 'call', config: savedConfig() });
  await settle();
  state.clients[0].emit({ className: 'UpdatePhoneCall', phoneCall: { className: 'PhoneCallDiscarded', id: '77' } });
  assert.deepEqual(await declined, { outcome: 'call_declined' });
  assert.deepEqual(state.invokes.slice(before).map(request => request.className), ['messages.GetDhConfig', 'phone.RequestCall']);
  plugin.close();
});

test('call errors (privacy, flood wait) return a message fallback and are logged without secrets', async () => {
  const { gram, state } = mockGram();
  state.handlers['messages.GetDhConfig'] = () => dhConfig();
  const logs = [];
  const plugin = createTelegramNotifier({ loadGram: () => gram, timers: fakeTimers() });
  state.handlers['phone.RequestCall'] = () => { throw rpcError('USER_PRIVACY_RESTRICTED'); };
  const privacy = await plugin.notify({ item: { status: 'failed', title: 'x' }, mode: 'call', config: savedConfig(), log: (level, message) => logs.push(message) });
  assert.deepEqual(privacy, { fallback: 'message', error: 'The privacy settings of account 2 do not allow calls from account 1' });
  state.handlers['phone.RequestCall'] = () => { throw rpcError('FLOOD', { seconds: 300 }); };
  const flood = await plugin.notify({ item: { status: 'failed', title: 'x' }, mode: 'call', config: savedConfig(), log: (level, message) => logs.push(message) });
  assert.match(flood.error, /wait 300 seconds/);
  assert.equal(logs.length, 2);
  assert.equal(logs.join('\n').includes(SESSION) || logs.join('\n').includes(API_HASH), false);
  plugin.close();
});

test('end to end through the service: a failed call becomes a fallback message on Telegram', async () => {
  const { gram, state } = mockGram();
  state.handlers['messages.GetDhConfig'] = () => dhConfig();
  state.handlers['phone.RequestCall'] = () => { throw rpcError('USER_PRIVACY_RESTRICTED'); };
  const plugin = createTelegramNotifier({ loadGram: () => gram, timers: fakeTimers() });
  const db = new Database(':memory:');
  db.exec('CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
  const listeners = [];
  const logs = [];
  const service = createAttentionNotify({ db, sessionSecret: SECRET, onChange: fn => { listeners.push(fn); return () => {}; }, getOwner: () => 'owner', notifiers: [plugin], log: (level, message) => logs.push(message) });
  service.saveRules('owner', { modes: { telegram: { waiting_user: 'call' } } });
  require('../lib/token-crypto');
  db.prepare("INSERT INTO system_state (key, value) VALUES ('attention-notify:telegram:owner', ?)").run(require('../lib/token-crypto').encryptToken(JSON.stringify(savedConfig()), SECRET));
  listeners[0]({ kind: 'updated', item: { id: 5, title: 'Approve', status: 'waiting_user', source: 'claude' }, previous: { id: 5, status: 'working' }, event: { actor: 'claude' } });
  await settle(10);
  assert.equal(state.messages.length, 1);
  assert.ok(state.messages[0].message.startsWith(`${NEEDS_YOU} <b>Needs you</b> \u00b7 <b>Approve</b>\n\n<i>(A call was not possible: The privacy settings`), state.messages[0].message);
  assert.equal(logs.join('\n').includes(SESSION), false);
  plugin.close();
});

// The login endpoints through the real service router.
async function loginServer(options = {}) {
  const { gram, state } = mockGram();
  const timers = fakeTimers();
  const plugin = createTelegramNotifier({ loadGram: () => gram, timers, ...options });
  const db = new Database(':memory:');
  db.exec('CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
  const logs = [];
  const service = createAttentionNotify({ db, sessionSecret: SECRET, onChange: null, getOwner: () => 'owner', notifiers: [plugin], log: (level, message) => logs.push(message) });
  const app = express();
  let statusPolls = 0;
  app.use((req, res, next) => { req.session = { user: { login: 'owner' } }; const poll = req.originalUrl.endsWith('/qr/status'); next(); if (poll) statusPolls++; });
  app.use('/api/attention-notify', service.createRouter({ requireAuth: (req, res, next) => next() }));
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/attention-notify/telegram`;
  const bodies = [];
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: body ? JSON.stringify(body) : undefined });
    const raw = await res.text();
    bodies.push(raw);
    return { status: res.status, data: JSON.parse(raw) };
  };
  return { gram, state, timers, plugin, db, logs, server, call, bodies, statusPolls: () => statusPolls, close: () => { plugin.close(); server.close(); } };
}

test('login: start sends the code, verify asks for the 2FA password, password finishes; secrets never leave the server', async () => {
  const ctx = await loginServer();
  try {
    const { call, state, db } = ctx;
    assert.equal((await call('GET', '/status')).data.step, 'none');
    assert.equal((await call('POST', '/start', { api_id: 'x', api_hash: API_HASH, phone: '+8613800000078' })).status, 400);
    assert.equal((await call('POST', '/start', { api_id: 12345, api_hash: 'short', phone: '+8613800000078' })).status, 400);
    assert.equal((await call('POST', '/verify', { code: '12345' })).status, 409, 'verify before start');
    const started = await call('POST', '/start', { api_id: 12345, api_hash: API_HASH, phone: '+86 138 0000 0078' });
    assert.equal(started.status, 200);
    assert.equal(started.data.step, 'code');
    assert.equal(started.data.codeVia, 'app');
    assert.equal(started.data.phone, '+86*********78');
    assert.deepEqual(state.sendCodeArgs, { credentials: { apiId: 12345, apiHash: API_HASH }, phone: '+8613800000078' });
    state.handlers['auth.SignIn'] = request => { if (request.phoneCode !== '24680') throw rpcError('PHONE_CODE_INVALID'); throw rpcError('SESSION_PASSWORD_NEEDED'); };
    const wrong = await call('POST', '/verify', { code: '11111' });
    assert.deepEqual([wrong.status, wrong.data.error], [502, 'The code is wrong']);
    const verified = await call('POST', '/verify', { code: '24 680' });
    assert.equal(verified.data.step, 'password');
    assert.equal(state.invokes.filter(request => request.className === 'auth.SignIn').at(-1).phoneCodeHash, 'hash-1');
    state.handlers['account.GetPassword'] = () => ({ className: 'account.Password', srpId: 7 });
    state.handlers['auth.CheckPassword'] = request => { if (!request.password.ok) throw rpcError('PASSWORD_HASH_INVALID'); return {}; };
    const badPassword = await call('POST', '/password', { password: 'nope' });
    assert.deepEqual([badPassword.status, badPassword.data.error], [502, 'The password is wrong']);
    const done = await call('POST', '/password', { password: PASSWORD });
    assert.equal(done.status, 200);
    assert.equal(done.data.loggedIn, true);
    assert.deepEqual(done.data.account, { id: '1001', name: 'Account One', username: 'acc_one' });
    assert.equal(done.data.hasApiHash, true);
    const stored = db.prepare("SELECT value FROM system_state WHERE key = 'attention-notify:telegram:owner'").get().value;
    assert.equal(stored.includes(SESSION) || stored.includes(API_HASH), false, 'stored encrypted');
    // Account 2 by username, then by numeric id (the dialogs are read first so the id is known).
    const target = await call('PUT', '/config', { target: '@acc_two', callSeconds: 45 });
    assert.deepEqual(target.data.target, { input: 'acc_two', name: 'Account Two', username: 'acc_two' });
    assert.equal(target.data.callSeconds, 45);
    await call('PUT', '/config', { target: '2002' });
    assert.equal(state.dialogsRead, true);
    assert.equal(state.entityInput, 'big:2002');
    state.entity = () => ({ className: 'User', id: 1001, self: true });
    assert.equal((await call('PUT', '/config', { target: 'acc_one' })).status, 400, 'account 1 itself is refused');
    state.entity = () => ({ className: 'Channel', id: 5 });
    assert.equal((await call('PUT', '/config', { target: 'somechannel' })).status, 400);
    assert.equal((await call('PUT', '/config', { callSeconds: 500 })).status, 400);
    // The test message reaches account 2.
    state.entity = null;
    await call('PUT', '/config', { target: 'acc_two' });
    const tested = await call('POST', '/test', { kind: 'message' });
    assert.deepEqual(tested.data, { ok: true, outcome: 'sent' });
    assert.ok(state.messages.at(-1).message.startsWith(`${NEEDS_YOU} <b>Needs you</b> \u00b7 <b>Test message</b>`));
    // Log out ends the session on Telegram and forgets it here.
    const out = await call('POST', '/logout');
    assert.equal(out.data.loggedIn, false);
    assert.ok(state.invokes.some(request => request.className === 'auth.LogOut'));
    assert.equal(db.prepare("SELECT COUNT(*) n FROM system_state WHERE key = 'attention-notify:telegram:owner'").get().n, 0);
    const everything = ctx.bodies.join('\n') + ctx.logs.join('\n');
    for (const secret of [SESSION, API_HASH, PASSWORD, '24680', 'hash-1']) assert.equal(everything.includes(secret), false, `${secret} must not leave the server`);
  } finally { ctx.close(); }
});

test('login: a started login expires after 10 minutes and a direct sign-in without 2FA finishes at verify', async () => {
  const ctx = await loginServer();
  try {
    const { call, state, timers } = ctx;
    await call('POST', '/start', { api_id: 12345, api_hash: API_HASH, phone: '+447700900123' });
    assert.ok(timers.fireWhere(timer => timer.ms === 10 * 60 * 1000));
    assert.equal((await call('POST', '/verify', { code: '12345' })).status, 409);
    await call('POST', '/start', { api_id: 12345, phone: '+447700900123', api_hash: API_HASH });
    state.handlers['auth.SignIn'] = () => ({ className: 'auth.Authorization' });
    const done = await call('POST', '/verify', { code: '12345' });
    assert.equal(done.data.loggedIn, true);
    assert.equal(done.data.step, 'done');
    state.sendCode = () => { throw rpcError('PHONE_NUMBER_INVALID'); };
    const bad = await call('POST', '/start', { api_id: 12345, api_hash: API_HASH, phone: '+10000000' });
    assert.deepEqual([bad.status, bad.data.error], [502, 'The phone number is invalid']);
    assert.equal((await call('POST', '/test', { kind: 'message' })).status, 409, 'no account 2 yet');
  } finally { ctx.close(); }
});

test('status(config, owner) is the plugin overview hook: configured and a summary with the phone masked and no secret', () => {
  const plugin = createTelegramNotifier({ loadGram: () => { throw new Error('gramjs is not needed for the status'); } });
  const none = plugin.status({}, 'local');
  assert.equal(none.configured, false);
  assert.equal(none.summary, 'Not logged in');
  const full = plugin.status(savedConfig(), 'local');
  assert.equal(full.configured, true);
  assert.equal(full.summary, 'Logged in as Account One (+86*******78) → account 2 Account Two');
  // An unmasked phone (an older saved config) is masked; no target means not configured.
  const raw = plugin.status(savedConfig({ phone: '+8613800000078', target: undefined, account: { id: '1', name: '', username: 'acc_one' } }), 'local');
  assert.equal(raw.configured, false);
  assert.equal(raw.summary, 'Logged in as @acc_one (+86*********78) → account 2 not chosen');
  for (const state of [none, full, raw]) {
    const text = JSON.stringify({ configured: state.configured, summary: state.summary });
    for (const secret of [SESSION, API_HASH, '13800000078', '12345']) assert.equal(text.includes(secret), false, `no ${secret}`);
  }
});

test('the notifier overview shows the Telegram state and the per-status modes, and never a stored secret', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
  const plugin = createTelegramNotifier({ loadGram: () => { throw new Error('not needed'); } });
  const service = createAttentionNotify({ db, sessionSecret: SECRET, notifiers: [plugin], getOwner: () => 'local', log: () => {} });
  const store = config => db.prepare("INSERT OR REPLACE INTO system_state (key, value) VALUES ('attention-notify:telegram:local', ?)").run(require('../lib/token-crypto').encryptToken(JSON.stringify(config), SECRET));
  store(savedConfig());
  service.saveRules('local', { statuses: ['waiting_user', 'review'], modes: { telegram: { waiting_user: 'call' } } });
  const [entry] = service.overview('local');
  assert.deepEqual(entry, { name: 'telegram', version: null, description: null, loaded: true, error: null, enabled: true, configured: true, summary: 'Logged in as Account One (+86*******78) → account 2 Account Two', statuses: { waiting_user: 'call', review: 'message' }, settings: false, test: true, customUi: null, origin: 'builtin', dev: false });
  // A summary that would carry a stored secret is dropped.
  store(savedConfig({ account: { id: '1', name: SESSION } }));
  assert.equal(service.overview('local')[0].summary, null);
  service.stop();
});

// ---- QR login ----
const TOKEN_1 = Buffer.from('qr-token-one-secret');
const TOKEN_2 = Buffer.from('qr-token-two-secret');
const urlOf = token => `tg://login?token=${token.toString('base64url')}`;
const exports_ = state => state.invokes.filter(request => request.className === 'auth.ExportLoginToken');

test('QR login: start shows a server-rendered SVG, the token refreshes when it expires, the scan finishes the login', async () => {
  let clock = 1_000_000_000_000;
  const ctx = await loginServer({ now: () => clock });
  try {
    const { call, state, db } = ctx;
    assert.equal((await call('POST', '/qr/start', { api_id: 'x', api_hash: API_HASH })).status, 400);
    assert.equal((await call('POST', '/qr/start', { api_id: 12345, api_hash: 'short' })).status, 400);
    const tokens = [TOKEN_1, TOKEN_2];
    state.handlers['auth.ExportLoginToken'] = () => {
      const token = tokens.shift();
      return token ? { className: 'auth.LoginToken', token, expires: Math.floor(clock / 1000) + 30 } : { className: 'auth.LoginTokenSuccess', authorization: { className: 'auth.Authorization' } };
    };
    const started = await call('POST', '/qr/start', { api_id: 12345, api_hash: API_HASH });
    assert.equal(started.status, 200);
    assert.equal(started.data.step, 'qr');
    assert.equal(started.data.url, urlOf(TOKEN_1));
    assert.match(started.data.svg, /^<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"[\s\S]*<\/svg>\s*$/, 'rendered on the server with qrcode');
    assert.equal(started.data.expiresAt, new Date(clock + 30000).toISOString());
    const request = exports_(state)[0];
    assert.deepEqual([request.apiId, request.apiHash, request.exceptIds], [12345, API_HASH, []]);
    assert.equal(state.clients.at(-1).session.value, '', 'a fresh session');
    // Polling before expiry does not ask Telegram again.
    clock += 2000;
    assert.equal((await call('GET', '/qr/status')).data.url, urlOf(TOKEN_1));
    assert.equal(exports_(state).length, 1);
    // After expiry the next poll gets a new token and a new QR.
    clock += 29000;
    const refreshed = await call('GET', '/qr/status');
    assert.equal(refreshed.data.step, 'qr');
    assert.equal(refreshed.data.url, urlOf(TOKEN_2));
    assert.notEqual(refreshed.data.svg, started.data.svg);
    assert.equal(exports_(state).length, 2);
    // Account 1 scans and accepts: UpdateLoginToken, then the export returns LoginTokenSuccess.
    state.clients.at(-1).emit({ className: 'UpdateLoginToken' });
    clock += 2000;
    const done = await call('GET', '/qr/status');
    assert.equal(done.data.step, 'done');
    assert.equal(done.data.loggedIn, true);
    assert.equal(done.data.phone, '+86*********78', 'the phone of account 1 comes from getMe, masked');
    assert.deepEqual(done.data.account, { id: '1001', name: 'Account One', username: 'acc_one' });
    assert.equal(done.data.url, undefined);
    assert.equal(state.clients.at(-1).connected, false, 'the login client is closed');
    assert.equal((await call('GET', '/qr/status')).data.step, 'done', 'still done on the next poll');
    assert.equal((await call('GET', '/status')).data.step, 'done');
    const stored = db.prepare("SELECT value FROM system_state WHERE key = 'attention-notify:telegram:owner'").get().value;
    assert.equal(stored.includes(SESSION) || stored.includes(API_HASH), false, 'stored encrypted');
    const everything = ctx.bodies.join('\n') + ctx.logs.join('\n');
    for (const secret of [SESSION, API_HASH]) assert.equal(everything.includes(secret), false, `${secret} must not leave the server`);
  } finally { ctx.close(); }
});

test('QR login: a DC migration switches the data center and imports the token there', async () => {
  let clock = 1_000_000_000_000;
  const ctx = await loginServer({ now: () => clock, renderQr: async url => `<svg>${url.length}</svg>` });
  try {
    const { call, state } = ctx;
    let scanned = false;
    state.handlers['auth.ExportLoginToken'] = () => (scanned
      ? { className: 'auth.LoginTokenMigrateTo', dcId: 4, token: TOKEN_2 }
      : { className: 'auth.LoginToken', token: TOKEN_1, expires: Math.floor(clock / 1000) + 30 });
    state.handlers['auth.ImportLoginToken'] = request => {
      assert.equal(state.switchedTo, 4, 'the switch happens before the import');
      assert.equal(Buffer.compare(request.token, TOKEN_2), 0);
      return { className: 'auth.LoginTokenSuccess', authorization: { className: 'auth.Authorization' } };
    };
    assert.equal((await call('POST', '/qr/start', { api_id: 12345, api_hash: API_HASH })).data.svg, `<svg>${urlOf(TOKEN_1).length}</svg>`);
    scanned = true;
    state.clients.at(-1).emit({ className: 'UpdateLoginToken' });
    const done = await call('GET', '/qr/status');
    assert.equal(done.data.step, 'done');
    assert.equal(state.switchedTo, 4);
    assert.ok(state.invokes.some(request => request.className === 'auth.ImportLoginToken'));
  } finally { ctx.close(); }
});

test('QR login: SESSION_PASSWORD_NEEDED after the scan moves to the 2FA password step, which finishes the login', async () => {
  const clock = 1_000_000_000_000;
  const ctx = await loginServer({ now: () => clock, renderQr: async () => '<svg></svg>' });
  try {
    const { call, state } = ctx;
    let scanned = false;
    state.handlers['auth.ExportLoginToken'] = () => { if (scanned) throw rpcError('SESSION_PASSWORD_NEEDED'); return { className: 'auth.LoginToken', token: TOKEN_1, expires: clock / 1000 + 30 }; };
    await call('POST', '/qr/start', { api_id: 12345, api_hash: API_HASH });
    scanned = true;
    state.clients.at(-1).emit({ className: 'UpdateLoginToken' });
    const asked = await call('GET', '/qr/status');
    assert.equal(asked.data.step, 'password');
    assert.equal(asked.data.url, undefined);
    assert.equal(asked.data.svg, undefined);
    assert.equal((await call('GET', '/status')).data.step, 'password');
    state.handlers['account.GetPassword'] = () => ({ className: 'account.Password', srpId: 7 });
    state.handlers['auth.CheckPassword'] = request => { if (!request.password.ok) throw rpcError('PASSWORD_HASH_INVALID'); return {}; };
    assert.equal((await call('POST', '/password', { password: 'nope' })).data.error, 'The password is wrong');
    const done = await call('POST', '/password', { password: PASSWORD });
    assert.equal(done.data.loggedIn, true);
    assert.equal((await call('GET', '/qr/status')).data.step, 'done');
    const everything = ctx.bodies.join('\n') + ctx.logs.join('\n');
    for (const secret of [SESSION, API_HASH, PASSWORD]) assert.equal(everything.includes(secret), false, `${secret} must not leave the server`);
  } finally { ctx.close(); }
});

test('QR login: it expires after 10 minutes or on cancel, overlapping polls export once, and Telegram errors are explained', async () => {
  let clock = 1_000_000_000_000;
  const ctx = await loginServer({ now: () => clock, renderQr: async () => '<svg></svg>' });
  try {
    const { call, state, timers } = ctx;
    assert.equal((await call('GET', '/qr/status')).data.step, 'expired', 'nothing started');
    let release;
    state.handlers['auth.ExportLoginToken'] = () => ({ className: 'auth.LoginToken', token: TOKEN_1, expires: Math.floor(clock / 1000) + 30 });
    await call('POST', '/qr/start', { api_id: 12345, api_hash: API_HASH });
    state.handlers['auth.ExportLoginToken'] = () => new Promise(resolve => { release = () => resolve({ className: 'auth.LoginToken', token: TOKEN_2, expires: Math.floor(clock / 1000) + 30 }); });
    clock += 31000;
    const polls = [call('GET', '/qr/status'), call('GET', '/qr/status')];
    await until(() => ctx.statusPolls() === 3 && release, 'both polls in the route (the first status call above counts too)');
    release();
    const answers = await Promise.all(polls);
    assert.deepEqual(answers.map(answer => answer.data.url), [urlOf(TOKEN_2), urlOf(TOKEN_2)]);
    assert.equal(exports_(state).length, 2, 'one export for two overlapping polls');
    assert.ok(timers.fireWhere(timer => timer.ms === 10 * 60 * 1000));
    const expired = await call('GET', '/qr/status');
    assert.equal(expired.data.step, 'expired');
    assert.equal(expired.data.loggedIn, false);
    assert.equal(state.clients.at(-1).connected, false);
    // Cancel ends it too.
    state.handlers['auth.ExportLoginToken'] = () => ({ className: 'auth.LoginToken', token: TOKEN_1, expires: Math.floor(clock / 1000) + 30 });
    assert.equal((await call('POST', '/qr/start', { api_id: 12345, api_hash: API_HASH })).data.step, 'qr');
    await call('POST', '/cancel');
    assert.equal((await call('GET', '/qr/status')).data.step, 'expired');
    // A bad api_id pair, and a flood wait during a refresh, come back as short messages.
    state.handlers['auth.ExportLoginToken'] = () => { throw rpcError('API_ID_INVALID'); };
    const bad = await call('POST', '/qr/start', { api_id: 12345, api_hash: API_HASH });
    assert.deepEqual([bad.status, bad.data.error], [502, 'The api_id / api_hash pair is invalid']);
    assert.equal((await call('GET', '/qr/status')).data.step, 'expired');
    state.handlers['auth.ExportLoginToken'] = () => ({ className: 'auth.LoginToken', token: TOKEN_1, expires: Math.floor(clock / 1000) + 30 });
    await call('POST', '/qr/start', { api_id: 12345, api_hash: API_HASH });
    state.handlers['auth.ExportLoginToken'] = () => { throw rpcError('FLOOD', { seconds: 9 }); };
    clock += 31000;
    const flood = await call('GET', '/qr/status');
    assert.deepEqual([flood.status, flood.data.error], [502, 'Telegram asks to wait 9 seconds before trying again']);
    assert.equal((await call('GET', '/qr/status')).data.step, 'expired');
    assert.equal(ctx.bodies.join('\n').includes(API_HASH), false);
  } finally { ctx.close(); }
});

// ---- Network: the SOCKS proxy from the environment, and timeouts ----
const never = () => new Promise(() => {});
const until = async (check, what) => {
  for (let i = 0; i < 400; i += 1) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail(`timed out waiting for ${what}`);
};
const networkTimer = timer => timer.ms === NETWORK_TIMEOUT_MS;
const hasNetworkTimer = timers => [...timers.list.values()].some(networkTimer);
const fireNetworkTimer = async timers => { await until(() => hasNetworkTimer(timers), 'the network timer'); assert.ok(timers.fireWhere(networkTimer)); };

test('proxyFromEnv reads a SOCKS proxy in order and ignores http and malformed values', () => {
  assert.deepEqual(proxyFromEnv({ ALL_PROXY: 'socks5h://us%40er:p%3Ass@127.0.0.1:7897' }), { ip: '127.0.0.1', port: 7897, socksType: 5, timeout: 10, username: 'us@er', password: 'p:ss' });
  assert.deepEqual(proxyFromEnv({ all_proxy: 'socks4://10.0.0.1:1081' }), { ip: '10.0.0.1', port: 1081, socksType: 4, timeout: 10 });
  assert.equal(proxyFromEnv({ all_proxy: 'socks4a://h:1' }).socksType, 4);
  assert.equal(proxyFromEnv({ all_proxy: 'socks5://h:1' }).socksType, 5);
  assert.equal(proxyFromEnv({ all_proxy: 'SOCKS://h:1' }).socksType, 5);
  assert.deepEqual(proxyFromEnv({ all_proxy: 'socks5://[::1]' }), { ip: '::1', port: 1080, socksType: 5, timeout: 10 }, 'IPv6 without brackets, default port');
  assert.equal(proxyFromEnv({ ALL_PROXY: 'socks5://first:1', all_proxy: 'socks5://second:2', HTTPS_PROXY: 'socks5://third:3' }).ip, 'first');
  assert.equal(proxyFromEnv({ all_proxy: 'socks5://second:2', HTTPS_PROXY: 'socks5://third:3' }).ip, 'second');
  assert.equal(proxyFromEnv({ HTTPS_PROXY: 'socks5://third:3', https_proxy: 'socks5://fourth:4' }).ip, 'third');
  assert.equal(proxyFromEnv({ https_proxy: 'socks5h://fourth:4' }).ip, 'fourth');
  assert.equal(proxyFromEnv({ ALL_PROXY: 'http://127.0.0.1:7897', HTTPS_PROXY: 'socks5://third:3' }).ip, 'third', 'an unusable value is skipped');
  for (const env of [{}, { ALL_PROXY: '' }, { ALL_PROXY: 'http://127.0.0.1:7897' }, { HTTPS_PROXY: 'http://127.0.0.1:7897', https_proxy: 'https://127.0.0.1:7897' }, { ALL_PROXY: 'not a url' }, { ALL_PROXY: 'socks5://' }, { ALL_PROXY: 'socks5://h:0' }, { ALL_PROXY: 'socks5://h:99999' }, { ALL_PROXY: 'socks5://%E0%A4%A:x@h:1' }, { ALL_PROXY: 'ftp://h:1' }]) {
    assert.equal(proxyFromEnv(env), null, JSON.stringify(env));
  }
});

test('the proxy reaches TelegramClient only when the environment has a usable one, and is not returned or logged', async () => {
  const params = async env => {
    const { gram, state } = mockGram();
    const plugin = createTelegramNotifier({ loadGram: () => gram, timers: fakeTimers(), env });
    await plugin.notify({ item: { status: 'failed', title: 'x' }, mode: 'message', config: savedConfig() });
    plugin.close();
    return state.clients[0].params;
  };
  assert.deepEqual((await params({ ALL_PROXY: 'socks5h://user:secret@127.0.0.1:7897' })).proxy, { ip: '127.0.0.1', port: 7897, socksType: 5, timeout: 10, username: 'user', password: 'secret' });
  assert.deepEqual((await params({ all_proxy: 'socks4://127.0.0.1:1081' })).proxy, { ip: '127.0.0.1', port: 1081, socksType: 4, timeout: 10 });
  for (const env of [{}, { ALL_PROXY: 'http://127.0.0.1:7897' }, { ALL_PROXY: 'nonsense' }]) assert.equal('proxy' in await params(env), false, JSON.stringify(env));
  const ctx = await loginServer({ env: { ALL_PROXY: 'socks5h://proxy-user:proxy-secret@127.0.0.1:7897' } });
  try {
    ctx.state.handlers['auth.ExportLoginToken'] = () => ({ className: 'auth.LoginToken', token: TOKEN_1, expires: 2_000_000_000 });
    assert.equal((await ctx.call('POST', '/qr/start', { api_id: 12345, api_hash: API_HASH })).status, 200);
    assert.equal(ctx.state.clients.at(-1).params.proxy.password, 'proxy-secret', 'QR login uses it too');
    const everything = ctx.bodies.join('\n') + ctx.logs.join('\n');
    assert.equal(everything.includes('proxy-secret') || everything.includes('proxy-user'), false);
  } finally { ctx.close(); }
});

test('QR login: a connect that never resolves ends in the error, nothing is registered, and a late connect is stopped again', async () => {
  const ctx = await loginServer();
  try {
    const { call, state, timers } = ctx;
    let connected;
    state.connect = () => new Promise(resolve => { connected = resolve; });
    const pending = call('POST', '/qr/start', { api_id: 12345, api_hash: API_HASH });
    await fireNetworkTimer(timers);
    const answer = await pending;
    assert.deepEqual([answer.status, answer.data.error], [504, UNREACHABLE]);
    const client = state.clients.at(-1);
    assert.equal(client.destroyed, 1, 'the abandoned client is destroyed');
    assert.equal((await call('GET', '/status')).data.step, 'none');
    assert.equal((await call('GET', '/qr/status')).data.step, 'expired');
    connected(true);
    await settle();
    assert.equal(client.destroyed, 2, 'stopped again once it did connect');
    assert.equal((await call('GET', '/status')).data.step, 'none', 'a late connect registers nothing');
    assert.equal(hasNetworkTimer(timers), false, 'no timer left');
    assert.equal(state.invokes.length, 0, 'nothing was asked of a client that timed out');
  } finally { ctx.close(); }
});

test('phone login: connect failing (timeout, or gramjs answering false) ends in the error', async () => {
  const ctx = await loginServer();
  try {
    const { call, state, timers } = ctx;
    state.connect = never;
    const pending = call('POST', '/start', { api_id: 12345, api_hash: API_HASH, phone: '+8613800000078' });
    await fireNetworkTimer(timers);
    const answer = await pending;
    assert.deepEqual([answer.status, answer.data.error], [504, UNREACHABLE]);
    assert.equal(state.clients.at(-1).destroyed, 1);
    state.connect = async () => false;
    const refused = await call('POST', '/start', { api_id: 12345, api_hash: API_HASH, phone: '+8613800000078' });
    assert.deepEqual([refused.status, refused.data.error], [504, UNREACHABLE]);
    assert.equal(state.sendCodeArgs, undefined, 'no code is requested without a connection');
    assert.equal((await call('GET', '/status')).data.step, 'none');
  } finally { ctx.close(); }
});

test('QR login: an export that never resolves ends in the error for /qr/start and drops the login', async () => {
  const ctx = await loginServer();
  try {
    const { call, state, timers } = ctx;
    let answerExport;
    state.handlers['auth.ExportLoginToken'] = () => new Promise(resolve => { answerExport = resolve; });
    const pending = call('POST', '/qr/start', { api_id: 12345, api_hash: API_HASH });
    await fireNetworkTimer(timers);
    const answer = await pending;
    assert.deepEqual([answer.status, answer.data.error], [504, UNREACHABLE]);
    assert.equal(state.clients.at(-1).destroyed, 1);
    assert.equal((await call('GET', '/status')).data.step, 'none');
    // The late answer changes nothing, not even a success.
    answerExport({ className: 'auth.LoginTokenSuccess', authorization: { className: 'auth.Authorization' } });
    await settle();
    const after = await call('GET', '/status');
    assert.deepEqual([after.data.step, after.data.loggedIn], ['none', false]);
    assert.equal(ctx.db.prepare("SELECT COUNT(*) n FROM system_state WHERE key = 'attention-notify:telegram:owner'").get().n, 0);
  } finally { ctx.close(); }
});

test('QR login: when a refresh export never resolves, /qr/status and an overlapping poll end in the error, not an endless wait', async () => {
  let clock = 1_000_000_000_000;
  const ctx = await loginServer({ now: () => clock, renderQr: async () => '<svg></svg>' });
  try {
    const { call, state, timers } = ctx;
    state.handlers['auth.ExportLoginToken'] = () => ({ className: 'auth.LoginToken', token: TOKEN_1, expires: Math.floor(clock / 1000) + 30 });
    await call('POST', '/qr/start', { api_id: 12345, api_hash: API_HASH });
    let answerExport;
    state.handlers['auth.ExportLoginToken'] = () => new Promise(resolve => { answerExport = resolve; });
    clock += 31000;
    const polls = [call('GET', '/qr/status'), call('GET', '/qr/status')];
    await until(() => ctx.statusPolls() === 2, 'both polls in the route'); // the overlap this test is about: the timer must not fire before the second poll joins
    await fireNetworkTimer(timers);
    const answers = await Promise.all(polls);
    assert.deepEqual(answers.map(answer => [answer.status, answer.data.error]), [[504, UNREACHABLE], [504, UNREACHABLE]]);
    assert.equal(exports_(state).length, 2);
    assert.equal(state.clients.at(-1).destroyed, 1, 'dropped once');
    assert.equal((await call('GET', '/qr/status')).data.step, 'expired', 'the page leaves the QR step');
    assert.equal((await call('GET', '/status')).data.step, 'none');
    answerExport({ className: 'auth.LoginTokenMigrateTo', dcId: 4, token: TOKEN_2 });
    await settle();
    assert.equal(state.switchedTo, undefined, 'a late migration does not connect a dropped client again');
  } finally { ctx.close(); }
});

test('notifications: a timed-out connect is removed so the next notification retries with a new client', async () => {
  const { gram, state } = mockGram();
  const timers = fakeTimers();
  const plugin = createTelegramNotifier({ loadGram: () => gram, timers });
  const item = { status: 'failed', title: 'x' };
  state.connect = never;
  const first = plugin.notify({ item, mode: 'message', config: savedConfig() });
  await fireNetworkTimer(timers);
  await assert.rejects(first, error => error.message === UNREACHABLE && error.statusCode === 502);
  assert.equal(state.clients[0].destroyed, 1);
  await settle();
  assert.equal(timers.list.size, 0, 'neither the idle timer nor the network timer is left');
  state.connect = null;
  await plugin.notify({ item, mode: 'message', config: savedConfig() });
  assert.equal(state.clients.length, 2, 'a new client');
  assert.equal(state.messages.length, 1);
  plugin.close();
});
