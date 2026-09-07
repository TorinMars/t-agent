#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
COMPOSE_FILE="$PROJECT_DIR/compose.engine.yml"
ENV_FILE="${T_AGENT_DOCKER_ENV_FILE:-$PROJECT_DIR/docker/engine.env}"
LOCK_DIR="${TMPDIR:-/tmp}/t-agent-engine-docker-update.lock"

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  printf '错误：需要 Docker Engine 和 Docker Compose v2\n' >&2
  exit 1
fi
if [ ! -f "$ENV_FILE" ]; then
  printf '错误：Docker 环境文件不存在：%s\n' "$ENV_FILE" >&2
  printf '请先复制 docker/engine.env.example 并按需修改。\n' >&2
  exit 1
fi
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  printf '已有 Docker Engine 更新任务正在运行，跳过本次检查。\n'
  exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

compose=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
printf '正在检查并拉取 T-Agent Engine 镜像……\n'
"${compose[@]}" pull engine
"${compose[@]}" up -d --no-deps engine

container_id="$("${compose[@]}" ps -q engine)"
if [ -z "$container_id" ]; then
  printf '错误：Engine 容器未创建。\n' >&2
  exit 1
fi

for _ in $(seq 1 30); do
  status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id")"
  if [ "$status" = "healthy" ]; then
    printf 'T-Agent Engine 镜像更新完成，容器健康。\n'
    exit 0
  fi
  if [ "$status" = "unhealthy" ] || [ "$status" = "exited" ] || [ "$status" = "dead" ]; then
    printf '错误：Engine 容器状态为 %s。\n' "$status" >&2
    "${compose[@]}" logs --tail=100 engine >&2 || true
    exit 1
  fi
  sleep 2
done

printf '错误：等待 Engine 健康检查超时。\n' >&2
"${compose[@]}" logs --tail=100 engine >&2 || true
exit 1

