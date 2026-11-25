#!/usr/bin/env node
const { parseArgs } = require('node:util');
const { createInterface } = require('node:readline/promises');
const { readFileSync } = require('node:fs');
const { createLearnSentences } = require('../services/learn-sentences');

function parseOptions(args) {
  const { values } = parseArgs({
    args,
    options: {
      'dry-run': { type: 'boolean' },
      apply: { type: 'boolean' },
      limit: { type: 'string' },
      'delay-ms': { type: 'string' },
      owner: { type: 'string' },
      yes: { type: 'boolean' },
    },
  });
  if (values.apply && values['dry-run']) throw new Error('Choose either --apply or --dry-run.');
  const integer = (key, fallback, min, max) => {
    const raw = values[key];
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`--${key} must be an integer from ${min} to ${max}.`);
    }
    return value;
  };
  const owner = values.owner?.trim();
  if (values.owner !== undefined && !owner) throw new Error('--owner needs a name.');
  return {
    apply: values.apply, yes: values.yes, owner,
    limit: integer('limit', Infinity, 1, Number.MAX_SAFE_INTEGER),
    delayMs: integer('delay-ms', 800, 0, 2_147_483_647),
  };
}

async function confirmApply() {
  if (!process.stdin.isTTY) return false;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(?:es)?$/i.test((await prompt.question('Generate and save these example sentences? [y/N] ')).trim());
  } finally {
    prompt.close();
  }
}

async function runBackfill(options, {
  db, owner, translator, level, isCompany, now = Date.now, log = console, confirm = confirmApply,
}) {
  if (isCompany()) throw new Error('This is a company computer. Run the backfill on the computer that keeps your Learn data.');
  const isConfigured = name => {
    try { return translator.isConfigured(name); } catch { return false; }
  };
  if (!isConfigured(owner)) throw new Error('No usable translation model is configured for this owner.');
  const service = createLearnSentences({
    db, converse: (...args) => translator.converse(...args), isConfigured,
    level, isCompany, now, perDay: Number.MAX_SAFE_INTEGER, runner: () => true,
  });
  const plan = service.backfillPreview(owner, options);
  log.info(`${options.apply ? 'Apply' : 'Dry run'}: ${plan.groups} groups, ${plan.cards} cards (${plan.learning} still learning, ${plan.learned} learned).`);
  if (plan.examples.length) log.info(`Example words: ${plan.examples.map(word => JSON.stringify(word)).join(', ')}`);
  if (!options.apply) return 0;

  let out = { done: 0, none: 0, failed: 0, skipped: 0, stop: null };
  if (plan.cards && (options.yes || await confirm(plan))) {
    out = await service.backfill(owner, {
      limit: plan.cards, sleepMs: options.delayMs,
      onProgress: ({ word, status, length }) => log.info(`${JSON.stringify(word)}: ${status} (${length} characters)`),
    });
  } else if (plan.cards) {
    log.info('Backfill cancelled. Use --yes to apply without an interactive prompt.');
    out.skipped = plan.cards;
  }
  if (out.stop === 'model-failures') log.warn('Stopped after 3 consecutive model failures. Run the script again to resume.');
  if (out.stop === 'unavailable') log.warn('Stopped because this computer or its translation model became unavailable.');
  log.info(`Summary: ${out.done} done, ${out.none} none, ${out.failed} failed, ${out.skipped} skipped.`);
  return out.failed || out.stop ? 1 : 0;
}

// Open the existing SQLite database directly. Importing ../db runs the server's
// startup migrations, including task document updates, even for a dry run.
async function main(args) {
  const options = parseOptions(args);
  const config = require('../config');
  const dataHome = require('../lib/data-home');
  const { root, dbPath, secretPath } = dataHome.paths();
  console.info(`Data directory: ${JSON.stringify(root)} (database: ${JSON.stringify(dbPath)})`);
  const Database = require('better-sqlite3');
  const db = new Database(dbPath, { readonly: !options.apply, fileMustExist: true, timeout: 5000 });
  try {
    if (db.pragma('user_version', { simple: true }) !== dataHome.codeSchemaVersion()) {
      throw new Error('The database schema does not match this checkout. Run the script with the T-Agent version that opened this database.');
    }
    const { STATE_KEY } = require('../services/single-user');
    const state = key => db.prepare('SELECT value FROM system_state WHERE key = ?').get(key);
    const owner = options.owner || state(STATE_KEY)?.value || config.singleUserId || 'local';
    console.info(`Owner: ${JSON.stringify(owner)}`);
    const { createLearnSync } = require('../services/learn-sync');
    const tier = require('../services/device-tier').createDeviceTier({ db });
    const sync = createLearnSync({ db, tier });
    const isCompany = () => sync.company();
    const learn = sync.service();
    // Read the same key as config.sessionSecret without the getter's first-start
    // file creation and data-directory preparation.
    const translator = state(`translator:${owner}`) && !isCompany()
      ? require('../services/translator').createTranslator({ db, sessionSecret: readFileSync(secretPath, 'utf8').trim() })
      : { isConfigured: () => false };
    return await runBackfill(options, { db, owner, translator, level: name => learn.level(name), isCompany });
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { parseOptions, runBackfill };
