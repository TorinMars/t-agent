// Preloaded with `node -r` into a real server.js by test/attention-e2e.test.js: replaces the notifier plugins of services/attention-notify.js
// with one fake plugin that appends every notification (with the card text of the Telegram plugin) as one JSON line to TA_FAKE_NOTIFIER_LOG.
// It also records, for each in-process change that carried a transcript excerpt (onChangeInternal), the status and whether the excerpt holds
// TA_FAKE_EXCERPT_MARKER (a yes / no, never the text) in TA_FAKE_EXCERPT_LOG. Nothing in the shipped code knows about it; server.js calls `require('./services/attention-notify').start(...)`, which is wrapped here.
const fs = require('node:fs');
const notify = require('../../services/attention-notify');
const { messageText } = require('../../plugins/notifiers/telegram');

const out = process.env.TA_FAKE_NOTIFIER_LOG;
const plugin = {
  name: 'fake',
  label: 'Fake',
  configFields: [],
  async notify({ item, previous, reason, mode, link }) {
    fs.appendFileSync(out, `${JSON.stringify({ id: item.id, status: item.status, previous: previous ? previous.status : null, reason, mode, link, text: messageText({ item, link }), item })}\n`);
    return { outcome: 'sent' };
  },
  async test() { return { ok: true }; },
};
const start = notify.start;
notify.start = options => {
  const marker = process.env.TA_FAKE_EXCERPT_MARKER;
  if (process.env.TA_FAKE_EXCERPT_LOG && marker) {
    require('../../services/attention').defaultService().onChangeInternal(change => {
      if (change.excerpt) fs.appendFileSync(process.env.TA_FAKE_EXCERPT_LOG, `${JSON.stringify({ status: change.item.status, marker: change.excerpt.includes(marker) })}\n`);
    });
  }
  return start({ ...options, notifiers: [plugin] });
};
