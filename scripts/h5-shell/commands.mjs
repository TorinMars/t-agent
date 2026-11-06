// The preset commands of the "Saved commands" list (row 2 of the phone bottom bar), chosen by the kind of the open terminal.
// Edit these tables to change the presets (there is no user editing yet). `command` is typed into the terminal like a paste,
// WITHOUT Enter, so the user checks it and presses Enter. `note` is the short English description shown under it
// (its Chinese text is in public/js/i18n-zh-ui.js, keyed by the exact English text; test/i18n.test.js checks it).
//
// `keys` (Claude Code and Codex only) are common key combinations, shown under a "Keys" header. Unlike a command, a key is SENT
// at once: `send` is the exact byte string (or a list of them, sent one after another with a short gap, so "Esc Esc" arrives as two presses).
// A latched Ctrl / Alt / Shift from row 1 is never added to them (h5.js drops the latch).
//
// Sources, commands checked 2026-11-05, keys checked 2026-11-06:
//   Claude Code commands: https://code.claude.com/docs/en/commands (built-in commands)
//   Claude Code keys:     https://code.claude.com/docs/en/interactive-mode ("Keyboard shortcuts": general controls, multiline input)
//   Codex CLI commands:   https://learn.chatgpt.com/docs/developer-commands?surface=cli (slash commands; was developers.openai.com/codex/cli/slash-commands)
//   Codex CLI keys:       the same page ("Interactive shortcuts": Ctrl+R, Esc twice, Ctrl+C), https://learn.chatgpt.com/docs/cli-customization (Ctrl+G),
//                         and the default keymap of the open source TUI, https://github.com/openai/codex (codex-rs/tui/src/keymap.rs: Esc interrupts the
//                         turn, Ctrl+T opens the transcript, Ctrl+J inserts a new line, Shift+Left edits the last queued message; Shift+Tab is the fixed
//                         "Change mode" key of bottom_pane/shortcut_overlay.rs). Main branch at commit b3c5a49.
// Only commands and keys listed there are used. Check them again when the agents change.

export const AGENT_COMMANDS = {
  claude: {
    title: 'Claude Code commands',
    commands: [
      { command: '/clear', note: 'Start a new conversation' },
      { command: '/compact', note: 'Summarize the conversation to free context' },
      { command: '/resume', note: 'Resume an earlier conversation' },
      { command: '/model', note: 'Switch the model' },
      { command: '/context', note: 'Show context usage' },
      { command: '/usage', note: 'Show cost and plan usage' },
      { command: '/diff', note: 'Review the changes in the working tree' },
      { command: '/rewind', note: 'Go back to an earlier point' },
      { command: '/review', note: 'Review the code changes' },
      { command: '/init', note: 'Create a CLAUDE.md guide' },
      { command: '/memory', note: 'Edit CLAUDE.md memory files' },
      { command: '/mcp', note: 'Manage MCP servers' },
    ],
    keys: [
      { label: 'Shift+Tab', send: '\x1b[Z', note: 'Cycle the permission modes' },
      { label: 'Esc', send: '\x1b', note: 'Interrupt Claude, or close a dialog' },
      { label: 'Esc Esc', send: ['\x1b', '\x1b'], note: 'Clear the input, or rewind when it is empty' },
      { label: 'Ctrl+C', send: '\x03', note: 'Interrupt, or clear the input' },
      { label: 'Ctrl+R', send: '\x12', note: 'Search the command history' },
      { label: 'Ctrl+O', send: '\x0f', note: 'Show or hide the transcript' },
      { label: 'Ctrl+G', send: '\x07', note: 'Edit the prompt in the text editor' },
      { label: 'Ctrl+J', send: '\n', note: 'Insert a new line' },
    ],
  },
  codex: {
    title: 'Codex commands',
    commands: [
      { command: '/new', note: 'Start a new chat' },
      { command: '/resume', note: 'Resume a saved chat' },
      { command: '/compact', note: 'Summarize the chat to free context' },
      { command: '/model', note: 'Choose the model and reasoning effort' },
      { command: '/permissions', note: 'Change what Codex can do without asking' },
      { command: '/status', note: 'Show the session settings and token usage' },
      { command: '/diff', note: 'Show the Git diff' },
      { command: '/review', note: 'Review the working tree' },
      { command: '/mention', note: 'Attach a file to the chat' },
      { command: '/plan', note: 'Switch to plan mode' },
      { command: '/init', note: 'Create an AGENTS.md file' },
      { command: '/mcp', note: 'List the MCP tools' },
    ],
    keys: [
      { label: 'Shift+Tab', send: '\x1b[Z', note: 'Change the mode (plan mode)' },
      { label: 'Shift+Left', send: '\x1b[1;2D', note: 'Edit the last queued message' },
      { label: 'Esc', send: '\x1b', note: 'Interrupt the running turn' },
      { label: 'Esc Esc', send: ['\x1b', '\x1b'], note: 'Edit the previous message (empty input)' },
      { label: 'Ctrl+C', send: '\x03', note: 'Interrupt, or quit when idle' },
      { label: 'Ctrl+R', send: '\x12', note: 'Search the prompt history' },
      { label: 'Ctrl+T', send: '\x14', note: 'Open the transcript' },
      { label: 'Ctrl+G', send: '\x07', note: 'Edit the prompt in the text editor' },
      { label: 'Ctrl+J', send: '\n', note: 'Insert a new line' },
    ],
  },
};

// A plain shell terminal (no `keys`: row 1 already has ^C, Esc and the arrows): the commands that start (or resume) an agent, plus a quick look at the repository.
// Slash commands mean nothing to the shell, so they are not shown here.
export const SHELL_COMMANDS = {
  title: 'Start an agent',
  commands: [
    { command: 'claude', note: 'Start Claude Code' },
    { command: 'claude --continue', note: 'Continue the last Claude Code conversation' },
    { command: 'claude --resume', note: 'Pick a Claude Code conversation to resume' },
    { command: 'codex', note: 'Start Codex' },
    { command: 'codex resume', note: 'Pick a Codex session to resume' },
    { command: 'git status', note: 'Show the state of the repository' },
  ],
};

// The list for a terminal of this agent ('claude', 'codex', or null / anything else for a plain shell): { title, commands, keys? }.
export const commandsFor = agent => AGENT_COMMANDS[agent] || SHELL_COMMANDS;
