'use strict';
// `tcli attention ...`: every command of the t-attention command line (scripts/t-attention.js) under tcli, with the same arguments, output and exit
// codes: tasks (add, list, tree, show, update, the status verbs, confirm, reject, handled, move, upsert, rm), schedules (--at / --every, --prompt,
// --script, run-now, preview), import-tasks-md, login, pair and plugins. It runs t-attention's own main(), so the two can never drift apart.
// Credentials are t-attention's: inside a T-Agent terminal TA_ATTENTION_URL and TA_ATTENTION_TOKEN (the terminal's own token, which may read and
// change tasks but not set a script), elsewhere `tcli attention login`. Wired into scripts/tcli.js with one GROUPS.attention line.
// See "tcli attention" in docs/design/tcli.md.
const attention = require('./t-attention');

const NAME = 'tcli attention';

function createAttentionGroup() {
  return {
    help: attention.helpText(NAME),
    // tcli has already handled `tcli attention` alone and `tcli attention help`; everything else is t-attention's.
    run(command, args, ctx) {
      const stdout = ctx.stdout || process.stdout;
      const stderr = ctx.stderr || process.stderr;
      return attention.main([command, ...args], {
        env: ctx.env || process.env,
        name: NAME,
        print: text => stdout.write(`${text}\n`),
        printError: text => stderr.write(`${text}\n`),
      });
    },
  };
}

module.exports = { createAttentionGroup, NAME };
