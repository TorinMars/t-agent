# 用户级规则与默认配置（远程源）

`scripts/agent-sync.py` 在每次启动 `claude` / `codex` 前从本目录拉取下面五个文件，合并到本机：

| 远程文件 | 本机目标 | 合并方式 |
|---|---|---|
| `claude/CLAUDE.md` | `~/.claude/CLAUDE.md` | 只替换文件中由 `<!-- t-agent:managed:begin/end -->` 圈出的区块，区块之外的本机规则原样保留 |
| `claude/settings.json` | `~/.claude/settings.json` | 递归合并：远程有的键以远程为准，本机独有的键保留；数组取并集 |
| `codex/AGENTS.md` | `~/.codex/AGENTS.md` | 同 `CLAUDE.md` |
| `codex/hooks.json` | `~/.codex/hooks.json` | 同 `claude/settings.json` 的 JSON 递归合并：本机已有 hook 保留，远程 hook 追加，重复同步不产生重复项。用于向 t-agent 上报终端状态；Codex 首次需在 `/hooks` 中信任 |
| `codex/config.toml` | `~/.codex/config.toml` | 只覆盖远程列出的键（支持顶层键和 `[表]` 下的单行键值），其余内容和注释保留 |

**注意**

- 本仓库是公开的，这里不能写任何密钥、令牌或内部信息。
- 修改这些文件并推送到 `main` 后，各机器下次启动 `claude` / `codex` 时生效（GitHub 缓存通常有几分钟延迟）。
- 远程列出的键每次都会覆盖本机同名键；只想在某台机器上临时改动请用命令行参数（如 `claude --model opus`），想让这台机器长期不同请用下面的“本机覆盖”。
- 从远程删除某个键或某条数组项不会同步删除本机已有的内容。
- `codex/config.toml` 的值必须是单行；`claude/settings.json` 必须是合法 JSON。

## 本机覆盖（只改某一台机器）

在那台机器上创建覆盖文件，格式和上面的远程文件完全一样，只写你想固定的键：

| 覆盖文件 | 作用于 |
|---|---|
| `~/.config/t-agent/overrides/claude/settings.json` | `~/.claude/settings.json` |
| `~/.config/t-agent/overrides/codex/config.toml` | `~/.codex/config.toml` |

同步时先把远程配置和覆盖文件合并（**覆盖优先**），再写入工具的配置。所以远程改了别的键照常生效，只有你在覆盖文件里写的键固定为本机的值。例如：

```json
{ "model": "opus" }
```

```toml
model = "gpt-5.5"
```

- 目录可用环境变量 `T_AGENT_OVERRIDES_DIR` 更换。
- 覆盖文件写错（JSON 不合法、TOML 有多行值）时，该工具的配置本次不同步、本机配置不动，并提示原因；规则同步不受影响。
- 覆盖文件不能“删除”远程的键或数组项；数组是并集，只能追加。
- 删除覆盖文件后，下次同步恢复为远程的值。
