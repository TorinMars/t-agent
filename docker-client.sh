#!/usr/bin/env bash
# Local: ./docker-client.sh --domain agent.example.com
# Remote: curl -fsSL https://raw.githubusercontent.com/TorinMars/t-agent/main/docker-client.sh | bash -s -- --domain agent.example.com
set -euo pipefail
ORIGINAL_ARGS=("$@")
DOMAIN=""
CLIENT_PORT=""
STORAGE_DIR=""
WORK_DIR=""
WORK_DIR_SET=0
REMOTE_ACCESS=""
CONFIGURE=0
NON_INTERACTIVE=0
CODEX_SOURCE="${HOME}/.codex"
BUILD=0
fail() { printf '错误：%s\n' "$*" >&2; exit 1; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --domain|--port|--data-dir|--codex-source|--work-dir|--remote-access)
      [ "$#" -ge 2 ] || fail "$1 需要参数"
      [ -n "$2" ] || [ "$1" = "--work-dir" ] || fail "$1 需要参数"
      case "$1" in
        --domain) DOMAIN="$2" ;;
        --port) CLIENT_PORT="$2" ;;
        --data-dir) STORAGE_DIR="$2" ;;
        --codex-source) CODEX_SOURCE="$2" ;;
        --work-dir) WORK_DIR="$2"; WORK_DIR_SET=1 ;;
        --remote-access) REMOTE_ACCESS="$2" ;;
      esac
      shift 2 ;;
    --build) BUILD=1; shift ;;
    --configure) CONFIGURE=1; shift ;;
    --non-interactive) NON_INTERACTIVE=1; shift ;;
    -h|--help)
      printf '%s\n' '用法：docker-client.sh [--domain 域名] [--port 3000] [--data-dir 绝对路径] [--work-dir 宿主机路径] [--remote-access yes|no] [--configure] [--non-interactive] [--codex-source 路径] [--build]' \
        '首次安装交互选择任务工作目录、宿主机端口及是否开放远程连接；--configure 可重新配置。' \
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
if [ -n "$WORK_DIR" ]; then
  [[ "$WORK_DIR" = /* && "$WORK_DIR" != *$'\n'* && "$WORK_DIR" != *$'\r'* ]] || fail '任务工作目录必须是绝对路径且不能包含换行'
fi
[ -z "$REMOTE_ACCESS" ] || [ "$REMOTE_ACCESS" = yes ] || [ "$REMOTE_ACCESS" = no ] || fail '--remote-access 只能是 yes 或 no'
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
FIRST_INSTALL=0
if [ ! -f "$ENV_FILE" ]; then cp "$PROJECT_DIR/docker/client.env.example" "$ENV_FILE"; FIRST_INSTALL=1; fi
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
if [ "$WORK_DIR_SET" -eq 1 ]; then save_setting T_AGENT_CLIENT_WORKSPACE_DIR "$WORK_DIR"; export T_AGENT_CLIENT_WORKSPACE_DIR="$WORK_DIR"; fi
if [ -n "$REMOTE_ACCESS" ]; then
  if [ "$REMOTE_ACCESS" = yes ]; then BIND=0.0.0.0; else BIND=127.0.0.1; fi
  save_setting T_AGENT_CLIENT_BIND "$BIND"; export T_AGENT_CLIENT_BIND="$BIND"
fi
PORT_EXPLICIT="$CLIENT_PORT"
compose=(docker compose --env-file "$ENV_FILE" -f "$PROJECT_DIR/compose.client.yml")
# Let Compose parse quotes, ${HOME} and caller overrides instead of sourcing .env.
read_configuration() {
  local resolved
  resolved="$("${compose[@]}" config --environment)" || fail 'Compose 配置无效'
  STORAGE_DIR="$(printf '%s\n' "$resolved" | sed -n 's/^T_AGENT_CLIENT_STORAGE_DIR=//p')"
  CLIENT_PORT="$(printf '%s\n' "$resolved" | sed -n 's/^T_AGENT_CLIENT_PORT=//p')"
  DOMAIN="$(printf '%s\n' "$resolved" | sed -n 's/^T_AGENT_CLIENT_DOMAIN=//p')"
  WORK_DIR="$(printf '%s\n' "$resolved" | sed -n 's/^T_AGENT_CLIENT_WORKSPACE_DIR=//p')"
  WORK_DIR="${WORK_DIR:-$STORAGE_DIR/tasks}"
  BIND="$(printf '%s\n' "$resolved" | sed -n 's/^T_AGENT_CLIENT_BIND=//p')"
  BIND="${BIND:-127.0.0.1}"
  CLIENT_PORT="${CLIENT_PORT:-3000}"
}
read_configuration
if [ "$NON_INTERACTIVE" -eq 0 ] && { [ "$FIRST_INSTALL" -eq 1 ] || [ "$CONFIGURE" -eq 1 ]; }; then
  HAS_TERMINAL=0
  if [ -t 0 ]; then exec 9<&0; HAS_TERMINAL=1
  elif { exec 9<>/dev/tty; } 2>/dev/null; then HAS_TERMINAL=1; fi
  if [ "$HAS_TERMINAL" -eq 1 ]; then
    printf '\n配置 Docker Client（容器内工作目录为 /workspace，内部端口为 3000）\n'
    if [ "$WORK_DIR_SET" -eq 0 ]; then
      printf '任务工作目录（宿主机）[%s]，回车保持，default 恢复默认：' "$WORK_DIR"
      IFS= read -r answer <&9 || fail '安装已取消'
      if [ -n "$answer" ]; then
        [ "$answer" != default ] || answer=""
        [[ -z "$answer" || ( "$answer" = /* && "$answer" != *$'\r'* ) ]] || fail '任务工作目录必须是绝对路径'
        save_setting T_AGENT_CLIENT_WORKSPACE_DIR "$answer"; export T_AGENT_CLIENT_WORKSPACE_DIR="$answer"
      fi
    fi
    if [ -z "$PORT_EXPLICIT" ]; then
      printf '宿主机端口 [%s]：' "$CLIENT_PORT"
      IFS= read -r answer <&9 || fail '安装已取消'
      if [ -n "$answer" ]; then
        [[ "$answer" =~ ^[1-9][0-9]{0,4}$ ]] && [ "$answer" -le 65535 ] || fail '端口必须是 1-65535 的整数'
        save_setting T_AGENT_CLIENT_PORT "$answer"; export T_AGENT_CLIENT_PORT="$answer"
      fi
    fi
    if [ -z "$REMOTE_ACCESS" ]; then
      default_access=no; [ "$BIND" = 127.0.0.1 ] || default_access=yes
      printf '允许远程连接此端口？yes=所有网卡，no=仅本机 [%s]：' "$default_access"
      IFS= read -r answer <&9 || fail '安装已取消'
      if [ -n "$answer" ]; then
        case "$answer" in
          y|Y|yes|YES) BIND=0.0.0.0 ;;
          n|N|no|NO) BIND=127.0.0.1 ;;
          *) fail '请填写 yes 或 no' ;;
        esac
        save_setting T_AGENT_CLIENT_BIND "$BIND"; export T_AGENT_CLIENT_BIND="$BIND"
      fi
    fi
    exec 9<&-
    read_configuration
  elif [ "$CONFIGURE" -eq 1 ]; then
    fail '交互配置需要终端；自动化请使用 --work-dir、--port、--remote-access 和 --non-interactive'
  else
    printf '未检测到交互终端，使用现有配置和默认值；可通过命令行参数指定。\n'
  fi
fi
[[ "$STORAGE_DIR" = /* && "$WORK_DIR" = /* ]] || fail '数据目录和任务工作目录必须是绝对路径'
printf '\n任务工作目录：%s → /workspace\n端口映射：%s:%s → 容器 3000\n' "$WORK_DIR" "$BIND" "$CLIENT_PORT"
if [ "$BIND" != 127.0.0.1 ]; then
  printf '已允许远程连接（仍受防火墙限制）；当前网页登录仍需 HTTPS，开放端口不会自动配置 TLS。\n'
else
  printf '仅允许服务器本机连接；远程浏览器通过 HTTPS 反向代理访问。\n'
fi
mkdir -p "$STORAGE_DIR/data" "$WORK_DIR"
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
print_binding_command() {
  printf '%q ' "${compose[@]}" exec client node scripts/client-auth-setup.js
  printf '\n'
}
get_auth_status() {
  "${compose[@]}" exec -T client node -e '
fetch("http://127.0.0.1:" + (process.env.PORT || 3000) + "/auth/status", {signal: AbortSignal.timeout(10000)})
  .then(async response => {
    if (!response.ok) throw new Error("HTTP_" + response.status);
    const status = await response.json();
    if (typeof status.bound !== "boolean") throw new Error("INVALID_AUTH_STATUS");
    console.log(status.bound ? "bound" : "unbound");
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
' </dev/null
}
AUTH_STATUS="$(get_auth_status)" || fail '无法检查身份验证器绑定状态，请检查容器后重试'
case "$AUTH_STATUS" in
  bound) printf '\n身份验证器已绑定，保留现有绑定。\n' ;;
  unbound)
    if [ "$NON_INTERACTIVE" -eq 1 ]; then
      printf '\n身份验证器尚未绑定，自动化模式不读取验证码。使用前请执行：\n'
      print_binding_command
    else
      AUTH_TERMINAL=0
      if [ -t 0 ]; then exec 9<&0; AUTH_TERMINAL=1
      elif { exec 9<>/dev/tty; } 2>/dev/null; then AUTH_TERMINAL=1; fi
      if [ "$AUTH_TERMINAL" -eq 0 ]; then
        printf '\n身份验证器尚未绑定。请在交互终端重跑安装脚本，或执行：\n'
        print_binding_command
        fail '绑定未完成：没有可用的交互终端'
      fi
      printf '\n开始绑定身份验证器：请用手机扫码并输入验证码，完成后保存恢复码。\n'
      if ! "${compose[@]}" exec -T client node scripts/client-auth-setup.js <&9; then
        exec 9<&-
        printf '\n重新绑定命令：\n'
        print_binding_command
        fail '绑定未完成；容器保持运行，可以重试，不会重置已有绑定'
      fi
      exec 9<&-
      AUTH_STATUS="$(get_auth_status)" || fail '绑定后状态检查失败，请检查容器后重试'
      [ "$AUTH_STATUS" = bound ] || fail '绑定未完成，请重跑脚本继续绑定'
    fi ;;
  *) fail '容器返回了无效的身份验证器绑定状态' ;;
esac
printf '\n'
if [ -n "$DOMAIN" ]; then
  printf '配置 HTTPS 反向代理后，请在浏览器打开：https://%s\n' "$DOMAIN"
else
  printf '配置 HTTPS 反向代理后，请在浏览器打开你的 HTTPS 地址（域名或 IP）。可通过 --domain 指定域名提示。\n'
fi
