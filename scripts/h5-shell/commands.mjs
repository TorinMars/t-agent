// The preset commands of the "Saved commands" list (row 2 of the phone bottom bar), chosen by the kind of the open terminal.
// Edit these tables to change the presets (there is no user editing yet). `command` is typed into the terminal like a paste,
// WITHOUT Enter, so the user checks it and presses Enter. `note` is the short English description shown under it
// (its Chinese text is in public/js/i18n-zh-ui.js, keyed by the exact English text; test/i18n.test.js checks it).
//
// Sources, checked 2026-11-05:
//   Claude Code: https://code.claude.com/docs/en/commands (built-in commands)
//   Codex CLI:   https://learn.chatgpt.com/docs/developer-commands?surface=cli (slash commands; was developers.openai.com/codex/cli/slash-commands)
// Only commands listed there are used. Check them again when the agents change.

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
  },
};

// A plain shell terminal: the commands that start (or resume) an agent, plus a quick look at the repository.
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

// The list for a terminal of this agent ('claude', 'codex', or null / anything else for a plain shell).
export const commandsFor = agent => AGENT_COMMANDS[agent] || SHELL_COMMANDS;
