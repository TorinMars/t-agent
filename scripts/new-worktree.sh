#!/usr/bin/env bash
# Creates a git worktree for a task, from the latest origin/main, with node_modules linked so tests run at once.
#   scripts/new-worktree.sh <name> [branch]       branch defaults to feat/<name>
# The worktree goes to ../t-agent-worktrees/<name> (next to this checkout).
set -euo pipefail

name="${1:?Usage: scripts/new-worktree.sh <name> [branch]}"
branch="${2:-feat/$name}"
root="$(git rev-parse --show-toplevel)"
# From inside a worktree, use the main checkout (the first entry of the list) as the base.
main="$(git -C "$root" worktree list --porcelain | awk '/^worktree /{print substr($0, 10); exit}')"
target="$(dirname "$main")/$(basename "$main")-worktrees/$name"

[ -e "$target" ] && { echo "Already exists: $target" >&2; exit 1; }
git -C "$main" fetch -q origin
git -C "$main" worktree add -q -b "$branch" "$target" origin/main
[ -d "$main/node_modules" ] && ln -s "$main/node_modules" "$target/node_modules"
echo "$target ($branch from $(git -C "$target" rev-parse --short HEAD))"
