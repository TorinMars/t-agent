# 用户级规则与默认配置（远程源）

`scripts/agent-sync.py` 在每次启动 `claude` / `codex` 前从本目录拉取下面四个文件，合并到本机：

| 远程文件 | 本机目标 | 合并方式 |
|---|---|---|
| `claude/CLAUDE.md` | `~/.claude/CLAUDE.md` | 只替换文件中由 `<!-- t-agent:managed:begin/end -->` 圈出的区块，区块之外的本机规则原样保留 |
| `claude/settings.json` | `~/.claude/settings.json` | 递归合并：远程有的键以远程为准，本机独有的键保留；数组取并集 |
| `codex/AGENTS.md` | `~/.codex/AGENTS.md` | 同 `CLAUDE.md` |
| `codex/config.toml` | `~/.codex/config.toml` | 只覆盖远程列出的键（支持顶层键和 `[表]` 下的单行键值），其余内容和注释保留 |

**注意**

- 本仓库是公开的，这里不能写任何密钥、令牌或内部信息。
- 修改这些文件并推送到 `main` 后，各机器下次启动 `claude` / `codex` 时生效（GitHub 缓存通常有几分钟延迟）。
- 远程列出的键每次都会覆盖本机同名键；只想在某台机器上临时改动请用命令行参数（如 `claude --model opus`）。
- 从远程删除某个键或某条数组项不会同步删除本机已有的内容。
- `codex/config.toml` 的值必须是单行；`claude/settings.json` 必须是合法 JSON。
