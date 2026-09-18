#!/usr/bin/env bash
# Local: ./docker-client.sh --domain agent.example.com
# Remote: curl -fsSL https://raw.githubusercontent.com/TorinMars/t-agent/main/docker-client.sh | bash -s -- --domain agent.example.com
set -euo pipefail
ORIGINAL_ARGS=("$@")
DOMAIN=""
CLIENT_PORT=""
STORAGE_DIR=""
CODEX_SOURCE="${HOME}/.codex"
BUILD=0
fail() { printf '错误：%s\n' "$*" >&2; exit 1; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --domain|--port|--data-dir|--codex-source)
      [ "$#" -ge 2 ] && [ -n "$2" ] || fail "$1 需要参数"
      case "$1" in
        --domain) DOMAIN="$2" ;;
        --port) CLIENT_PORT="$2" ;;
        --data-dir) STORAGE_DIR="$2" ;;
        --codex-source) CODEX_SOURCE="$2" ;;
      esac
      shift 2 ;;
    --build) BUILD=1; shift ;;
    -h|--help)
      printf '%s\n' '用法：docker-client.sh [--domain 域名] [--port 3000] [--data-dir 绝对路径] [--codex-source 路径] [--build]' \
        '默认拉取镜像；--build 改为本机构建。已有配置和 Codex 副本保留，显式参数更新对应配置。' \
        'curl 执行时下载源码至 ~/.torin/t-agent-client-app，可通过 T_AGENT_CLIENT_APP_DIR 指定。'
      exit 0 ;;
    *) fail "未知参数：$1" ;;
  esac
done
if [ -n "$CLIENT_PORT" ]; then
  [[ "$CLIENT_PORT" =~ ^[1-9][0-9]{0,4}$ ]] && [ "$CLIENT_PORT" -le 65535 ] || fail '端口必须是 1-65535 的整数'
fi
if [ -n "$DOMAIN" ]; then
  [[ "$DOMAIN" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]$ ]] || fail '请只填写域名，不含 https://、端口或路径'
fi
if [ -n "$STORAGE_DIR" ]; then
  [[ "$STORAGE_DIR" = /* && "$STORAGE_DIR" != *$'\n'* && "$STORAGE_DIR" != *$'\r'* ]] || fail '数据目录必须是绝对路径且不能包含换行'
fi
command -v docker >/dev/null 2>&1 || fail '请先安装 Docker Engine 和 Docker Compose v2'
docker compose version >/dev/null 2>&1 || fail '需要 Docker Compose v2'
docker info >/dev/null 2>&1 || fail '无法连接 Docker，请启动 Docker 并确认当前用户有访问权限'

PROJECT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
fi
if [ -z "$PROJECT_DIR" ] || [ ! -f "$PROJECT_DIR/compose.client.yml" ]; then
  command -v git >/dev/null 2>&1 || fail '首次下载需要 Git'
  APP_DIR="${T_AGENT_CLIENT_APP_DIR:-$HOME/.torin/t-agent-client-app}"
  if [ ! -e "$APP_DIR" ]; then
    mkdir -p "$(dirname "$APP_DIR")"
    git clone --branch main --single-branch https://github.com/TorinMars/t-agent.git "$APP_DIR"
  fi
  [ -f "$APP_DIR/docker-client.sh" ] && [ -f "$APP_DIR/compose.client.yml" ] || fail "目录已存在但不含启动脚本：$APP_DIR；请更新源码或设置 T_AGENT_CLIENT_APP_DIR"
  exec bash "$APP_DIR/docker-client.sh" "${ORIGINAL_ARGS[@]}"
fi

ENV_FILE="$PROJECT_DIR/docker/client.env"
umask 077
if [ ! -f "$ENV_FILE" ]; then cp "$PROJECT_DIR/docker/client.env.example" "$ENV_FILE"; fi
save_setting() {
  local key="$1" value="$2" temp
  value="${value//\\/\\\\}"
  value="${value//\$/\$\$}"
  value="${value//\"/\\\"}"
  temp="$(mktemp "$ENV_FILE.XXXXXX")"
  awk -v key="$key" '$0 !~ "^" key "=" { print }' "$ENV_FILE" > "$temp"
  printf '%s="%s"\n' "$key" "$value" >> "$temp"
  mv "$temp" "$ENV_FILE"
}
if [ -n "$CLIENT_PORT" ]; then save_setting T_AGENT_CLIENT_PORT "$CLIENT_PORT"; export T_AGENT_CLIENT_PORT="$CLIENT_PORT"; fi
if [ -n "$STORAGE_DIR" ]; then save_setting T_AGENT_CLIENT_STORAGE_DIR "$STORAGE_DIR"; export T_AGENT_CLIENT_STORAGE_DIR="$STORAGE_DIR"; fi
if [ -n "$DOMAIN" ]; then save_setting T_AGENT_CLIENT_DOMAIN "$DOMAIN"; export T_AGENT_CLIENT_DOMAIN="$DOMAIN"; fi
compose=(docker compose --env-file "$ENV_FILE" -f "$PROJECT_DIR/compose.client.yml")
# Let Compose parse quotes, ${HOME} and caller overrides instead of sourcing .env.
resolved="$("${compose[@]}" config --environment)"
STORAGE_DIR="$(printf '%s\n' "$resolved" | sed -n 's/^T_AGENT_CLIENT_STORAGE_DIR=//p')"
CLIENT_PORT="$(printf '%s\n' "$resolved" | sed -n 's/^T_AGENT_CLIENT_PORT=//p')"
DOMAIN="$(printf '%s\n' "$resolved" | sed -n 's/^T_AGENT_CLIENT_DOMAIN=//p')"
[[ "$STORAGE_DIR" = /* ]] || fail 'T_AGENT_CLIENT_STORAGE_DIR 必须是绝对路径'
mkdir -p "$STORAGE_DIR/data" "$STORAGE_DIR/tasks"
bash "$PROJECT_DIR/scripts/docker-client-copy-codex.sh" "$STORAGE_DIR/codex" "$CODEX_SOURCE"
if [ "$BUILD" -eq 1 ]; then
  "${compose[@]}" build client
else
  "${compose[@]}" pull client || fail '镜像拉取失败；检查镜像权限和网络，或加 --build 使用源码构建'
fi
if ! "${compose[@]}" up -d --no-build --pull never --wait --wait-timeout 120 client; then
  "${compose[@]}" logs --tail=50 client >&2 || true
  fail 'Client 未通过启动检查，请查看以上日志'
fi
printf '\nClient 已启动并通过健康检查。\n数据目录：%s\n反向代理上游：http://127.0.0.1:%s\n' "$STORAGE_DIR" "${CLIENT_PORT:-3000}"
printf 'Nginx HTTPS/WSS 配置示例：%s\n' "$PROJECT_DIR/docker/client.nginx.conf.example"
printf '\n首次使用请执行身份验证器绑定：\n'
printf '%q ' "${compose[@]}" exec client node scripts/client-auth-setup.js
printf '\n\n'
if [ -n "$DOMAIN" ]; then
  printf '配置 HTTPS 反向代理后，请在浏览器打开：https://%s\n' "$DOMAIN"
else
  printf '配置 HTTPS 反向代理后，请在浏览器打开你的 HTTPS 域名。可通过 --domain 指定提示地址。\n'
fi
