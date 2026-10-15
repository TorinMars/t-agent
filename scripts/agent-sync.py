#!/usr/bin/env python3
"""Sync the user-level rules and default configuration of Claude Code / Codex.

Usage: python3 agent-sync.py [claude|codex|all] [--base URL] [--dry-run] [--verbose]

Two kinds of content are synced for each tool (the remote files live in the repository’s rules/ directory):
  Rules  claude/CLAUDE.md, codex/AGENTS.md  -> only the managed block enclosed by markers is replaced; local content outside it is kept
  Config  claude/settings.json              -> merged recursively (remote keys win, keys that exist only locally are kept, arrays are unioned)
        codex/config.toml                  -> only the keys listed remotely are overwritten; everything else, including comments, is kept

Design constraints:
  - It runs before the tool starts, so it must be fast: conditional requests with ETag, a total time limit of about 5 seconds, and no network access for 10 minutes after a failure;
    when the network fails it falls back to the last cached content and never blocks the tool from starting (exit code is always 0 unless the arguments are wrong).
  - Local overrides: ~/.config/t-agent/overrides/claude/settings.json and codex/config.toml (the directory can be changed with the environment variable
    T_AGENT_OVERRIDES_DIR). The remote configuration and the override file are merged first (overrides win) and then written to the tool’s configuration,
    so remote changes to other keys still take effect and only the keys written here stay fixed at the local value.
  - A corrupted local file (JSON/TOML that cannot be parsed) is not overwritten; only a notice is shown.
  - Nothing is written when the content is unchanged; a .t-agent.bak backup is kept before the first modification.
  - Uses only the Python 3.6+ standard library.
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
NOTICE = "<!-- Synced remotely by t-agent; do not edit this block by hand. Content outside the block is kept -->"

HOME = os.path.expanduser("~")
CACHE_DIR = os.environ.get("T_AGENT_SYNC_CACHE") or os.path.join(HOME, ".cache", "t-agent-sync")


def overrides_dir():
    return os.environ.get("T_AGENT_OVERRIDES_DIR") or os.path.join(HOME, ".config", "t-agent", "overrides")


def tool_paths(tool):
    """Returns (remote rules path, local rules path, remote config path, local config path, config type)."""
    if tool == "claude":
        root = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(HOME, ".claude")
        return ("claude/CLAUDE.md", os.path.join(root, "CLAUDE.md"),
                "claude/settings.json", os.path.join(root, "settings.json"), "json")
    root = os.environ.get("CODEX_HOME") or os.path.join(HOME, ".codex")
    return ("codex/AGENTS.md", os.path.join(root, "AGENTS.md"),
            "codex/config.toml", os.path.join(root, "config.toml"), "toml")


def extra_json_configs(tool):
    """Files other than the main config that are also merged recursively as JSON: [(remote path, local path)]. Codex hooks cannot go into config.toml, which only supports single-line key/values, so they live in hooks.json."""
    if tool == "codex":
        root = os.environ.get("CODEX_HOME") or os.path.join(HOME, ".codex")
        return [("codex/hooks.json", os.path.join(root, "hooks.json"))]
    return []


def managed_by_file_sync(config_path):
    """Node file sync is still managing this file, so the startup script must not rewrite the configuration again."""
    marker = config_path + FILE_SYNC_MARKER_SUFFIX
    try:
        with open(marker, encoding="utf-8") as handle:
            if handle.read() != "t-agent-file-sync\n":
                return False
        return time.time() - os.path.getmtime(marker) < FILE_SYNC_MARKER_TTL
    except OSError:
        return False


# ---------- Fetch remote files ----------
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
                self.results[rel] = None  # the remote has no such file: do not sync, and do not delete the local content
            else:
                self._failed(rel, "HTTP %s" % error.code, cached)
        except (urllib.error.URLError, OSError, ValueError) as error:
            self._failed(rel, str(getattr(error, "reason", error)), cached)

    def _failed(self, rel, why, cached):
        self.results[rel] = cached
        self.notes.append("Cannot fetch %s (%s), %s" % (rel, why, "using the last cache" if cached is not None else "skipped"))
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
            if rel not in self.results: # request that timed out: fall back to the cache
                self.results[rel] = self._read_cache(rel)
                self.notes.append("Fetching %s timed out, using the last cache" % rel)
        return self.results


# ---------- Write files ----------
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


# ---------- Rules: managed block ----------
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


# ---------- Config: recursive JSON merge ----------
def merge_json(local, remote):
    if isinstance(local, dict) and isinstance(remote, dict):
        for key, value in remote.items():
            local[key] = merge_json(local[key], value) if key in local else value
        return local
    if isinstance(local, list) and isinstance(remote, list):
        return local + [item for item in remote if item not in local]
    return remote


# ---------- Config: TOML key override (keep the rest of the content and comments) ----------
HEADER = re.compile(r"^\s*(\[\[?)\s*([^\[\]]+?)\s*\]\]?\s*(#.*)?$")
KEYVAL = re.compile(r"^\s*([A-Za-z0-9_\-\.\"']+)\s*=\s*(.*?)\s*$")


def parse_toml_keys(text):
    """Parse a TOML that only has single-line key = value entries into {section: [(key, raw line)]}; the top-level section is ''. """
    sections, current = {"": []}, ""
    for number, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        header = HEADER.match(raw)
        if header:
            if header.group(1) == "[[":
                raise ValueError("remote config.toml line %d: [[array tables]] are not supported" % number)
            current = header.group(2).strip()
            sections.setdefault(current, [])
            continue
        match = KEYVAL.match(raw)
        if not match or match.group(2).startswith(('"""', "'''")) or match.group(2).count("[") != match.group(2).count("]"):
            raise ValueError("remote config.toml line %d: only single-line key = value is supported" % number)
        sections[current].append((match.group(1), raw.rstrip()))
    return sections


def section_range(lines, name):
    """Return the (start, end) line range of the section named name (excluding the header); None if it does not exist."""
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
    except Exception as error: # noqa: BLE001
        return str(error)
    return None


# ---------- Sync one tool ----------
def sync_json(remote_config, override_text, override_path, config_path, dry_run):
    """Merge the remote JSON (with the local override layered on top) recursively into the local file; returns True if anything changed. Raises ValueError for invalid format."""
    remote_obj = json.loads(remote_config) if remote_config and remote_config.strip() else {}
    if not isinstance(remote_obj, dict):
        raise ValueError("remote %s must be a JSON object" % os.path.basename(config_path))
    if override_text is not None:
        try:
            override_obj = json.loads(override_text)
        except ValueError as error:
            raise ValueError("local override %s is not valid JSON (%s); the configuration was not synced this time" % (override_path, error))
        if not isinstance(override_obj, dict):
            raise ValueError("local override %s must be a JSON object; the configuration was not synced this time" % override_path)
        remote_obj = merge_json(remote_obj, override_obj)
    local = read_text(config_path)
    local_obj = json.loads(local) if local and local.strip() else {}
    if not isinstance(local_obj, dict):
        raise ValueError("local %s is not a JSON object; skipped" % os.path.basename(config_path))
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
                        raise ValueError("local override %s: %s; the configuration was not synced this time" % (override_path, str(error).replace("remote config.toml ", "")))
                merged = merge_toml(local, remote_config)
                if (local or "") != merged:
                    error = validate_toml(merged)
                    if error:
                        raise ValueError("the merged config.toml cannot be parsed (%s); skipped" % error)
                    if not dry_run:
                        write_text(config_path, merged)
                    changed.append(os.path.basename(config_path))
        except ValueError as error:
            problems.append("%s: %s" % (os.path.basename(config_path), error))

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
            problems.append("%s: %s" % (os.path.basename(extra_path), error))
    return changed, problems


def main():
    parser = argparse.ArgumentParser(description="Sync the user-level rules and configuration of Claude Code / Codex")
    parser.add_argument("tool", nargs="?", default="all", choices=["claude", "codex", "all"])
    parser.add_argument("--base", default=os.environ.get("T_AGENT_RULES_BASE") or DEFAULT_BASE)
    parser.add_argument("--dry-run", action="store_true", help="only show the files that would change; do not write")
    parser.add_argument("--offline", action="store_true", help="do not use the network, only the cache")
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
            changed, problems = [], ["Write failed: %s" % error]
        label = "Claude" if tool == "claude" else "Codex"
        if changed:
            print("[t-agent] %s synced: %s%s" % (label, ", ".join(changed), " (dry run, nothing written)" if args.dry_run else ""), file=sys.stderr)
        elif args.verbose:
            print("[t-agent] %s is already up to date" % label, file=sys.stderr)
        for problem in problems:
            print("[t-agent] %s %s" % (label, problem), file=sys.stderr)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
