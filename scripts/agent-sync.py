#!/usr/bin/env python3
"""同步 Claude Code / Codex 的用户级规则与默认配置。

用法：python3 agent-sync.py [claude|codex|all] [--base URL] [--dry-run] [--verbose]

每个工具同步两类内容（远程文件位于仓库的 rules/ 目录）：
  规则  claude/CLAUDE.md、codex/AGENTS.md  -> 只替换文件中由标记圈出的受管区块，区块之外的本机内容保留
  配置  claude/settings.json               -> 递归合并（远程键优先，本机独有的键保留，数组取并集）
        codex/config.toml                  -> 只覆盖远程列出的键，其余内容与注释保留

设计约束：
  - 启动前调用，所以必须快：带 ETag 的条件请求、总时限约 5 秒、失败后 10 分钟内不再联网；
    联网失败时改用上次缓存的内容，绝不阻止工具启动（退出码始终为 0，除非参数错误）。
  - 本机覆盖：~/.config/t-agent/overrides/claude/settings.json、codex/config.toml（可用环境变量
    T_AGENT_OVERRIDES_DIR 改目录）。先把远程配置和覆盖文件合并（覆盖优先），再写入工具的配置，
    所以远程改动其他键照常生效，只有在这里写了的键固定为本机的值。
  - 本机文件损坏（JSON/TOML 无法解析）时不覆盖，只提示。
  - 内容没有变化时不写文件；第一次修改前保留 .t-agent.bak 备份。
  - 只使用 Python 3.6+ 标准库。
"""
import argparse
import json
import os
import re
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

DEFAULT_BASE = "https://raw.githubusercontent.com/TorinMars/t-agent/main/rules"
FETCH_TIMEOUT = 3
TOTAL_DEADLINE = 5
BACKOFF_SECONDS = 600
FILE_SYNC_MARKER_SUFFIX = ".t-agent-file-sync-managed"
FILE_SYNC_MARKER_TTL = 60
BEGIN = "<!-- t-agent:managed:begin -->"
END = "<!-- t-agent:managed:end -->"
NOTICE = "<!-- 由 t-agent 从远程同步，请勿手动修改此区块；区块之外的内容会保留 -->"

HOME = os.path.expanduser("~")
CACHE_DIR = os.environ.get("T_AGENT_SYNC_CACHE") or os.path.join(HOME, ".cache", "t-agent-sync")


def overrides_dir():
    return os.environ.get("T_AGENT_OVERRIDES_DIR") or os.path.join(HOME, ".config", "t-agent", "overrides")


def tool_paths(tool):
    """返回 (规则远程路径, 规则本机路径, 配置远程路径, 配置本机路径, 配置类型)。"""
    if tool == "claude":
        root = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(HOME, ".claude")
        return ("claude/CLAUDE.md", os.path.join(root, "CLAUDE.md"),
                "claude/settings.json", os.path.join(root, "settings.json"), "json")
    root = os.environ.get("CODEX_HOME") or os.path.join(HOME, ".codex")
    return ("codex/AGENTS.md", os.path.join(root, "AGENTS.md"),
            "codex/config.toml", os.path.join(root, "config.toml"), "toml")


def extra_json_configs(tool):
    """除主配置外，还按 JSON 递归合并的文件：[(远程路径, 本机路径)]。Codex 的 hooks 不能写进只支持单行键值的 config.toml，放在 hooks.json。"""
    if tool == "codex":
        root = os.environ.get("CODEX_HOME") or os.path.join(HOME, ".codex")
        return [("codex/hooks.json", os.path.join(root, "hooks.json"))]
    return []


def managed_by_file_sync(config_path):
    """节点文件同步仍在管理此文件时，启动脚本不要再次改写配置。"""
    marker = config_path + FILE_SYNC_MARKER_SUFFIX
    try:
        with open(marker, encoding="utf-8") as handle:
            if handle.read() != "t-agent-file-sync\n":
                return False
        return time.time() - os.path.getmtime(marker) < FILE_SYNC_MARKER_TTL
    except OSError:
        return False


# ---------- 获取远程文件 ----------
class Fetcher(object):
    def __init__(self, base, offline=False):
        self.base = base.rstrip("/")
        self.offline = offline
        self.backoff_file = os.path.join(CACHE_DIR, "backoff")
        self.results = {}
        self.notes = []

    def _cache(self, rel):
        return os.path.join(CACHE_DIR, rel.replace("/", "__"))

    def _read_cache(self, rel):
        try:
            with open(self._cache(rel), encoding="utf-8") as handle:
                return handle.read()
        except OSError:
            return None

    def _backing_off(self):
        try:
            return time.time() - os.path.getmtime(self.backoff_file) < BACKOFF_SECONDS
        except OSError:
            return False

    def _fetch_one(self, rel):
        cached = self._read_cache(rel)
        if self.offline or self._backing_off():
            self.results[rel] = cached
            return
        request = urllib.request.Request("%s/%s" % (self.base, rel), headers={"User-Agent": "t-agent-sync"})
        try:
            etag = open(self._cache(rel) + ".etag", encoding="utf-8").read().strip()
            if etag and cached is not None:
                request.add_header("If-None-Match", etag)
        except OSError:
            pass
        try:
            with urllib.request.urlopen(request, timeout=FETCH_TIMEOUT) as response:
                text = response.read().decode("utf-8")
                os.makedirs(CACHE_DIR, exist_ok=True)
                with open(self._cache(rel), "w", encoding="utf-8") as handle:
                    handle.write(text)
                with open(self._cache(rel) + ".etag", "w", encoding="utf-8") as handle:
                    handle.write(response.headers.get("ETag", ""))
                self.results[rel] = text
        except urllib.error.HTTPError as error:
            if error.code == 304:
                self.results[rel] = cached
            elif error.code == 404:
                self.results[rel] = None  # 远程没有这个文件：不同步，也不删除本机内容
            else:
                self._failed(rel, "HTTP %s" % error.code, cached)
        except (urllib.error.URLError, OSError, ValueError) as error:
            self._failed(rel, str(getattr(error, "reason", error)), cached)

    def _failed(self, rel, why, cached):
        self.results[rel] = cached
        self.notes.append("无法获取 %s（%s），%s" % (rel, why, "使用上次缓存" if cached is not None else "已跳过"))
        try:
            os.makedirs(CACHE_DIR, exist_ok=True)
            with open(self.backoff_file, "w") as handle:
                handle.write(str(time.time()))
        except OSError:
            pass

    def fetch_all(self, rels):
        threads = [threading.Thread(target=self._fetch_one, args=(rel,), daemon=True) for rel in rels]
        for thread in threads:
            thread.start()
        deadline = time.time() + TOTAL_DEADLINE
        for thread in threads:
            thread.join(max(0.0, deadline - time.time()))
        for rel in rels:
            if rel not in self.results:  # 超时的请求：退回缓存
                self.results[rel] = self._read_cache(rel)
                self.notes.append("获取 %s 超时，使用上次缓存" % rel)
        return self.results


# ---------- 写文件 ----------
def read_text(path):
    try:
        with open(path, encoding="utf-8") as handle:
            return handle.read()
    except FileNotFoundError:
        return None


def write_text(path, text, default_mode=0o600):
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    try:
        mode = os.stat(path).st_mode & 0o777
    except FileNotFoundError:
        mode = default_mode
    else:
        backup = path + ".t-agent.bak"
        if not os.path.exists(backup):
            with open(path, "rb") as source, open(backup, "wb") as target:
                target.write(source.read())
            os.chmod(backup, mode)
    handle, temp = tempfile.mkstemp(prefix=".t-agent-", dir=directory)
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as out:
            out.write(text)
        os.chmod(temp, mode)
        os.replace(temp, path)
    except BaseException:
        if os.path.exists(temp):
            os.unlink(temp)
        raise


# ---------- 规则：受管区块 ----------
def merge_rules(local, remote):
    remote = remote.replace(BEGIN, "").replace(END, "").strip("\n")
    block = "%s\n%s\n%s\n%s" % (BEGIN, NOTICE, remote, END)
    local = local or ""
    start = local.find(BEGIN)
    end = local.find(END, start + len(BEGIN)) if start != -1 else -1
    if start != -1 and end != -1:
        return local[:start] + block + local[end + len(END):]
    prefix = local.rstrip("\n")
    return (prefix + "\n\n" if prefix.strip() else "") + block + "\n"


# ---------- 配置：JSON 递归合并 ----------
def merge_json(local, remote):
    if isinstance(local, dict) and isinstance(remote, dict):
        for key, value in remote.items():
            local[key] = merge_json(local[key], value) if key in local else value
        return local
    if isinstance(local, list) and isinstance(remote, list):
        return local + [item for item in remote if item not in local]
    return remote


# ---------- 配置：TOML 键覆盖（保留其余内容与注释） ----------
HEADER = re.compile(r"^\s*(\[\[?)\s*([^\[\]]+?)\s*\]\]?\s*(#.*)?$")
KEYVAL = re.compile(r"^\s*([A-Za-z0-9_\-\.\"']+)\s*=\s*(.*?)\s*$")


def parse_toml_keys(text):
    """把只含单行 key = value 的 TOML 解析成 {section: [(key, 原始行)]}；顶层 section 为 ''。"""
    sections, current = {"": []}, ""
    for number, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        header = HEADER.match(raw)
        if header:
            if header.group(1) == "[[":
                raise ValueError("远程 config.toml 第 %d 行：不支持 [[数组表]]" % number)
            current = header.group(2).strip()
            sections.setdefault(current, [])
            continue
        match = KEYVAL.match(raw)
        if not match or match.group(2).startswith(('"""', "'''")) or match.group(2).count("[") != match.group(2).count("]"):
            raise ValueError("远程 config.toml 第 %d 行：只支持单行 key = value" % number)
        sections[current].append((match.group(1), raw.rstrip()))
    return sections


def section_range(lines, name):
    """返回 name 对应 section 的 (起始, 结束) 行号区间（不含表头）；不存在返回 None。"""
    headers = [(i, HEADER.match(line)) for i, line in enumerate(lines)]
    headers = [(i, m) for i, m in headers if m]
    if name == "":
        return 0, (headers[0][0] if headers else len(lines))
    for position, (index, match) in enumerate(headers):
        if match.group(1) == "[" and match.group(2).strip() == name:
            return index + 1, (headers[position + 1][0] if position + 1 < len(headers) else len(lines))
    return None


def merge_toml(local, remote):
    lines = (local or "").splitlines()
    for name, entries in parse_toml_keys(remote).items():
        if not entries:
            continue
        found = section_range(lines, name)
        if found is None:
            if lines and lines[-1].strip():
                lines.append("")
            lines.append("[%s]" % name)
            lines.extend(raw for _, raw in entries)
            continue
        for key, raw in entries:
            start, end = section_range(lines, name)
            pattern = re.compile(r"^\s*%s\s*=" % re.escape(key))
            for index in range(start, end):
                if pattern.match(lines[index]):
                    lines[index] = raw
                    break
            else:
                insert_at = end
                while insert_at > start and not lines[insert_at - 1].strip():
                    insert_at -= 1
                lines.insert(insert_at, raw)
    return "\n".join(lines) + "\n"


def validate_toml(text):
    try:
        import tomllib  # Python 3.11+
    except ImportError:
        return None
    try:
        tomllib.loads(text)
    except Exception as error:  # noqa: BLE001
        return str(error)
    return None


# ---------- 同步一个工具 ----------
def sync_json(remote_config, override_text, override_path, config_path, dry_run):
    """把远程 JSON（再叠加本机覆盖）递归合并进本机文件；有变化返回 True。格式不合法抛 ValueError。"""
    remote_obj = json.loads(remote_config) if remote_config and remote_config.strip() else {}
    if not isinstance(remote_obj, dict):
        raise ValueError("远程 %s 必须是 JSON 对象" % os.path.basename(config_path))
    if override_text is not None:
        try:
            override_obj = json.loads(override_text)
        except ValueError as error:
            raise ValueError("本机覆盖 %s 不是合法 JSON（%s），本次未同步配置" % (override_path, error))
        if not isinstance(override_obj, dict):
            raise ValueError("本机覆盖 %s 必须是 JSON 对象，本次未同步配置" % override_path)
        remote_obj = merge_json(remote_obj, override_obj)
    local = read_text(config_path)
    local_obj = json.loads(local) if local and local.strip() else {}
    if not isinstance(local_obj, dict):
        raise ValueError("本机 %s 不是 JSON 对象，已跳过" % os.path.basename(config_path))
    before = json.dumps(local_obj, sort_keys=True)
    merged_obj = merge_json(local_obj, remote_obj)
    if json.dumps(merged_obj, sort_keys=True) == before and local:
        return False
    if not dry_run:
        write_text(config_path, json.dumps(merged_obj, indent=2, ensure_ascii=False) + "\n")
    return True


def sync_tool(tool, remote_files, dry_run):
    rules_rel, rules_path, config_rel, config_path, kind = tool_paths(tool)
    changed, problems = [], []

    remote_rules = remote_files.get(rules_rel)
    if remote_rules is not None:
        local = read_text(rules_path)
        merged = merge_rules(local, remote_rules)
        if merged != local:
            if not dry_run:
                write_text(rules_path, merged, 0o644)
            changed.append(os.path.basename(rules_path))

    remote_config = remote_files.get(config_rel)
    override_path = os.path.join(overrides_dir(), config_rel)
    override_text = read_text(override_path)
    has_override = override_text is not None and override_text.strip() != ""
    if (remote_config is not None or has_override) and not managed_by_file_sync(config_path):
        local = read_text(config_path)
        try:
            if kind == "json":
                if sync_json(remote_config, override_text if has_override else None, override_path, config_path, dry_run):
                    changed.append(os.path.basename(config_path))
            else:
                if has_override:
                    try:
                        remote_config = merge_toml(remote_config or "", override_text)
                    except ValueError as error:
                        raise ValueError("本机覆盖 %s：%s，本次未同步配置" % (override_path, str(error).replace("远程 config.toml ", "")))
                merged = merge_toml(local, remote_config)
                if (local or "") != merged:
                    error = validate_toml(merged)
                    if error:
                        raise ValueError("合并后的 config.toml 无法解析（%s），已跳过" % error)
                    if not dry_run:
                        write_text(config_path, merged)
                    changed.append(os.path.basename(config_path))
        except ValueError as error:
            problems.append("%s：%s" % (os.path.basename(config_path), error))

    for extra_rel, extra_path in extra_json_configs(tool):
        remote_extra = remote_files.get(extra_rel)
        extra_override = read_text(os.path.join(overrides_dir(), extra_rel))
        has_extra_override = bool(extra_override and extra_override.strip())
        if remote_extra is None and not has_extra_override:
            continue
        if managed_by_file_sync(extra_path):
            continue
        try:
            if sync_json(remote_extra, extra_override if has_extra_override else None,
                         os.path.join(overrides_dir(), extra_rel), extra_path, dry_run):
                changed.append(os.path.basename(extra_path))
        except ValueError as error:
            problems.append("%s：%s" % (os.path.basename(extra_path), error))
    return changed, problems


def main():
    parser = argparse.ArgumentParser(description="同步 Claude Code / Codex 的用户级规则与配置")
    parser.add_argument("tool", nargs="?", default="all", choices=["claude", "codex", "all"])
    parser.add_argument("--base", default=os.environ.get("T_AGENT_RULES_BASE") or DEFAULT_BASE)
    parser.add_argument("--dry-run", action="store_true", help="只显示会变化的文件，不写入")
    parser.add_argument("--offline", action="store_true", help="不联网，只使用缓存")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    tools = ["claude", "codex"] if args.tool == "all" else [args.tool]
    wanted = []
    for tool in tools:
        paths = tool_paths(tool)
        wanted += [paths[0], paths[2]] + [rel for rel, _ in extra_json_configs(tool)]
    fetcher = Fetcher(args.base, offline=args.offline)
    remote_files = fetcher.fetch_all(wanted)

    for note in fetcher.notes:
        if args.verbose:
            print("[t-agent] " + note, file=sys.stderr)
    for tool in tools:
        try:
            changed, problems = sync_tool(tool, remote_files, args.dry_run)
        except OSError as error:
            changed, problems = [], ["写入失败：%s" % error]
        label = "Claude" if tool == "claude" else "Codex"
        if changed:
            print("[t-agent] %s 已同步：%s%s" % (label, "、".join(changed), "（试运行，未写入）" if args.dry_run else ""), file=sys.stderr)
        elif args.verbose:
            print("[t-agent] %s 已是最新" % label, file=sys.stderr)
        for problem in problems:
            print("[t-agent] %s %s" % (label, problem), file=sys.stderr)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
