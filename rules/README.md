# User-level rules and default configuration (remote source)

Before every start of `claude` / `codex`, `scripts/agent-sync.py` pulls the following five files from this directory and merges them into the machine:

| Remote file | Local target | How it is merged |
|---|---|---|
| `claude/CLAUDE.md` | `~/.claude/CLAUDE.md` | Only the block enclosed by `<!-- t-agent:managed:begin/end -->` is replaced; local rules outside the block are kept as they are |
| `claude/settings.json` | `~/.claude/settings.json` | Recursive merge: for keys the remote has, the remote wins; keys that exist only locally are kept; arrays are unioned |
| `codex/AGENTS.md` | `~/.codex/AGENTS.md` | Same as `CLAUDE.md` |
| `codex/hooks.json` | `~/.codex/hooks.json` | Recursive JSON merge like `claude/settings.json`: hooks that already exist locally are kept, remote hooks are appended, and syncing again produces no duplicates. It is used to report terminal status to t-agent; Codex must trust it once in `/hooks` |
| `codex/config.toml` | `~/.codex/config.toml` | Only the keys listed remotely are overwritten (top-level keys and single-line key/values under a `[table]` are supported); everything else, including comments, is kept |

**Notes**

- This repository is public, so no secret, token or internal information may be written here.
- After these files are changed and pushed to `main`, each machine picks them up the next time it starts `claude` / `codex` (the GitHub cache usually adds a delay of a few minutes).
- Keys listed remotely overwrite the same-named keys on the machine every time; to change something temporarily on one machine use command-line arguments (such as `claude --model opus`), and to make one machine different for good use the "Local overrides" below.
- Deleting a key or an array item from the remote does not delete what already exists on the machine.
- Values in `codex/config.toml` must be single-line; `claude/settings.json` must be valid JSON.

## Local overrides (change only one machine)

Create an override file on that machine. Its format is exactly the same as the remote file above, and you write only the keys you want to pin:

| Override file | Applies to |
|---|---|
| `~/.config/t-agent/overrides/claude/settings.json` | `~/.claude/settings.json` |
| `~/.config/t-agent/overrides/codex/config.toml` | `~/.codex/config.toml` |

When syncing, the remote configuration and the override file are merged first (**the override wins**) and the result is then written to the tool's configuration. So remote changes to other keys still take effect, and only the keys you write in the override file stay fixed at the local value. For example:

```json
{ "model": "opus" }
```

```toml
model = "gpt-5.5"
```

- The directory can be changed with the environment variable `T_AGENT_OVERRIDES_DIR`.
- When the override file is wrong (invalid JSON, a multi-line value in TOML), that tool's configuration is not synced this time and the local configuration is left alone, with the reason shown; rule syncing is unaffected.
- An override file cannot "delete" a remote key or array item; arrays are a union and can only be appended to.
- After the override file is deleted, the next sync restores the remote values.
