// Preloaded with `node -r` into a real server.js by test/attention-notify-relay.test.js: replaces the notifier plugins of services/attention-notify.js
// with one fake plugin NAMED telegram (the relay applies to Telegram only). It is set up when TA_FAKE_TELEGRAM_READY is 1, and appends every delivery
// (status, mode, reason, origin and the card text of the real Telegram plugin) as one JSON line to TA_FAKE_NOTIFIER_LOG. It never reaches Telegram.
// Nothing in the shipped code knows about it; server.js calls `require('./services/attention-notify').start(...)`, which is wrapped here.
const fs = require('node:fs');
const notify = require('../../services/attention-notify');
const { messageText } = require('../../plugins/notifiers/telegram');

const out = process.env.TA_FAKE_NOTIFIER_LOG;
const write = entry => fs.appendFileSync(out, `${JSON.stringify(entry)}\n`);
const plugin = {
  name: 'telegram',
  label: 'Telegram',
  configFields: [],
  ready: () => process.env.TA_FAKE_TELEGRAM_READY === '1',
  async notify({ item, reason, mode, link, origin }) {
    write({ kind: 'notify', id: item.id, title: item.title, status: item.status, reason, mode, origin: origin || null, text: messageText({ item, link, origin }) });
    return { outcome: 'sent' };
  },
  async test(config, { kind, origin } = {}) { write({ kind: 'test', test: kind, origin: origin || null }); return { ok: true, outcome: 'sent' }; },
};
const start = notify.start;
notify.start = options => start({ ...options, notifiers: [plugin] });
