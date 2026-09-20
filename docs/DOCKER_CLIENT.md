# Docker Client：远程服务器部署

Client 镜像包含网页、本地 Engine、终端及 Codex CLI。容器中的“本地任务”运行在容器内；也可以添加独立远程 Engine。默认只向服务器的 `127.0.0.1:3000` 发布端口，通过 Nginx 的 HTTPS/WSS 域名访问。

## 一键启动

服务器已安装 Docker Engine、Docker Compose v2 和 Git 后，执行（替换为自己的域名）：

```bash
curl -fsSL https://raw.githubusercontent.com/TorinMars/t-agent/main/docker-client.sh | bash -s -- --domain agent.example.com
```

首次运行时，脚本依次提示：任务工作目录（宿主机路径，映射到容器 `/workspace`）、宿主机端口（默认 `3000`）、是否允许远程连接（默认 `no`，仅本机；选择 `yes` 监听 `0.0.0.0`）、是否允许可信内网 HTTP 登录（默认 `no`）。回车保留显示值；工作目录输入 `default` 恢复继承数据目录下的 `tasks`。随后下载/构建镜像、首次复制独立 Codex 配置并等待容器健康。容器就绪后自动检查身份验证器：未绑定时直接在安装终端显示二维码并等待验证码，绑定后显示一次性恢复码；已绑定时保留并跳过。结束时显示域名 URL 和代理上游。HTTPS 证书及反向代理按下文配置；`--domain` 仅指定访问提示，不会自动签发证书或修改 Nginx。

已有源码可运行 `./docker-client.sh --domain agent.example.com`。可选参数：`--work-dir /srv/projects`、`--port 13500`、`--remote-access yes|no`、`--allow-http yes|no`、`--data-dir /srv/t-agent-client`、`--codex-source /path/to/.codex`、`--build`（改为本机构建）。已有安装可加 `--configure` 重新交互配置。自动化使用 `--non-interactive`；未提供的参数沿用现有配置或默认值。该模式不读取验证码，尚未绑定时会显示补绑命令；正常交互安装若绑定失败或中断，不会报告绑定完成，可重跑脚本继续。配置写入 `docker/client.env`，再次执行保留已有配置及 Codex 副本；显式参数只更新对应字段。源码默认存放在 `~/.torin/t-agent-client-app`，可通过 `T_AGENT_CLIENT_APP_DIR` 修改。启动超时或镜像拉取失败会返回失败并显示原因。

## 首次部署

服务器需要 Docker Engine、Docker Compose v2 和 Git。默认 HTTPS 部署还需域名和有效 TLS 证书；可信内网也可按下文显式开启 HTTP，用 IP 或主机名加端口访问。

```bash
git clone https://github.com/TorinMars/t-agent.git
cd t-agent
cp docker/client.env.example docker/client.env
mkdir -p "$HOME/.torin/t-agent-client/data" "$HOME/.torin/t-agent-client/tasks"

# 首次复制宿主机 ~/.codex 到 Client 专用副本，不共用原目录。
./scripts/docker-client-copy-codex.sh "$HOME/.torin/t-agent-client/codex"

docker compose --env-file docker/client.env -f compose.client.yml pull client
docker compose --env-file docker/client.env -f compose.client.yml up -d client
```

若修改 `T_AGENT_CLIENT_STORAGE_DIR`，上述目录和复制目标也要同步修改。`T_AGENT_CLIENT_WORKSPACE_DIR` 可单独指定宿主机任务工作目录；留空时继承 `${T_AGENT_CLIENT_STORAGE_DIR}/tasks`，容器路径仍为 `/workspace`。`T_AGENT_CLIENT_PORT` 是宿主机端口，容器内部保持 `3000`。已有副本不会再次复制或覆盖。可以用第二个参数指定源 Codex 目录；源目录不存在时创建空的专用目录，之后在容器中登录。此脚本只复制文件，不读取宿主机操作系统的钥匙串；源登录必须保存在可复制的 Codex 文件中。

镜像未发布或不能拉取时，可在服务器构建：

```bash
docker compose --env-file docker/client.env -f compose.client.yml build client
docker compose --env-file docker/client.env -f compose.client.yml up -d --pull never client
```

## HTTPS/WSS 反向代理

将 [Nginx 示例](../docker/client.nginx.conf.example) 放入 Nginx 的 `http` 配置上下文，替换 `agent.example.com` 和证书路径，再执行 `nginx -t` 并重载 Nginx。若修改宿主机发布端口，同时修改 `proxy_pass`。示例同时支持普通 HTTP 请求、文件保存和终端 WebSocket。

Compose 默认将端口发布到服务器回环地址；选择允许远程连接后会发布到所有网卡，仍受宿主机防火墙/安全组限制。开放端口不代表已提供 HTTPS；默认生产登录仍须通过 HTTPS 代理访问，可信内网可显式开启下述 HTTP 登录。Nginx 示例假设代理运行在宿主机。若代理也在容器中，应让代理和 Client 加入同一个 Docker 网络，并把上游改为 `http://client:3000`，不要把容器里的 `127.0.0.1` 当作宿主机。保留正确的 Host、X-Forwarded-Proto 和 WebSocket Upgrade 请求头。容器化 Nginx 会缓存上游地址，Client 容器重建后应重新加载或重启代理，使其重新解析 `client`；宿主机 Nginx 使用固定回环端口不受此影响。

默认生产会话要求 Secure Cookie。启用内网 HTTP 后，HTTP 会话可正常保存，HTTPS 会话仍使用 Secure Cookie，身份验证器和接口鉴权保持不变。默认回环发布方式遵循 [Docker 端口发布说明](https://docs.docker.com/engine/network/port-publishing/)。

## 首次绑定身份验证器

Docker 转发和反向代理请求不被视为“本机首次绑定”。交互安装会自动执行这一流程，无需另开窗口。手动部署或非交互安装后，可在服务器终端执行：

```bash
docker compose --env-file docker/client.env -f compose.client.yml \
  exec client node scripts/client-auth-setup.js
```

扫描终端二维码（或手动添加显示的密钥），输入验证码，并保存只显示一次的恢复码。此命令通过容器内回环地址调用现有绑定 API，不放宽远程绑定限制；已有绑定时会拒绝重置。然后在浏览器打开自己的 HTTPS 域名，例如 `https://agent.example.com`，等待身份验证器生成下一组验证码后登录。

首次启动会生成权限为 `0600` 的 `data/client-session-secret`。容器重建继续读取同一密钥，数据库里的身份验证器、远程 Token 和登录会话保持可用。不要删除或替换这个文件。

## Codex 登录与数据隔离

镜像默认安装 Codex。首次部署将宿主机 `~/.codex` 复制到 Client 专用目录，容器仅挂载这个副本。宿主机、Client、独立 Engine 三者不共用同一目录；容器产生的新配置、登录刷新和会话不会写回宿主机原始 `~/.codex`。

```bash
docker compose --env-file docker/client.env -f compose.client.yml exec client codex --version
docker compose --env-file docker/client.env -f compose.client.yml exec client codex login status
```

没有可复制登录时，可在任务终端或 `docker compose ... exec client codex` 中完成登录。镜像更新不会清空专用副本，因此无需仅因更新而重新登录；账号凭证被撤销或过期时仍按 Codex 提示处理。

## 持久化、备份和已有数据迁移

| 宿主机默认路径 | 容器路径 | 内容 |
| --- | --- | --- |
| `~/.torin/t-agent-client/data` | `/var/lib/t-agent` | SQLite、身份验证器、会话密钥、远程连接、终端历史 |
| `~/.torin/t-agent-client/tasks` | `/workspace` | 任务文件 |
| `~/.torin/t-agent-client/codex` | `/root/.codex` | 宿主机首次复制的独立 Codex 副本 |

更新会继续使用这些目录。备份时先停止容器，再一起备份三个目录；恢复时也要一起恢复。不要把 Client 与 Engine 指向同一个数据根目录。

已有原生 Client 迁移前先停止原服务，复制其数据库和任务，并将原 `.env` 中的 `SESSION_SECRET` 原样写入 `data/client-session-secret`（权限 `0600`）；不能为已有加密数据生成新密钥。旧任务的绝对路径需要在 Compose 中增加相同路径的挂载，或按实际新目录调整配置。

容器只能访问镜像和挂载目录。Finder/本机 VS Code 打开功能不能操作浏览器所在电脑；使用网页文件面板或自己的远程开发工具。若要连接宿主机 Engine，不能在容器中使用 `127.0.0.1`，应使用容器可达的服务器地址或相同 Docker 网络的服务名。

## 更新、状态和日志

如果通过 `--build` 自行构建，先更新源码再重新构建启动：

```bash
cd ~/.torin/t-agent-client-app
git pull --ff-only
./docker-client.sh --build
```

已有身份验证器绑定会自动跳过。若使用了自定义源码目录，在该目录执行以上命令。使用预构建镜像则执行：


```bash
docker compose --env-file docker/client.env -f compose.client.yml pull client
docker compose --env-file docker/client.env -f compose.client.yml up -d --no-deps client
docker compose --env-file docker/client.env -f compose.client.yml ps
docker compose --env-file docker/client.env -f compose.client.yml logs --tail=100 client
```

更新会重建容器，正在运行的终端进程会停止；数据库、任务和 Codex 登录副本保留。网页可以检查版本，但 Docker 安装由宿主机更新镜像，不在容器内更新应用代码。再次运行首次复制脚本也不会覆盖现有副本。

`main` 推送分别构建 `ghcr.io/torinmars/t-agent-client:latest` 和 Engine 镜像，并生成 `sha-<commit>` 标签。首次使用前确认镜像构建成功及 GHCR 读取权限。

## 可信内网 HTTP 登录

已有容器安装可更新安装脚本并使用远程镜像开启 HTTP，无需本地构建：

```bash
cd ~/.torin/t-agent-client-app
git pull --ff-only
./docker-client.sh --remote-access yes --allow-http yes
```

然后访问 `http://服务器IP:端口/auth/login`（也可用内网主机名），用已有身份验证器登录，无需重新绑定。默认端口 3000；脚本沿用已有端口、数据目录和绑定。重建容器会中断正在运行的终端进程。首次安装和 `--configure` 会询问是否允许内网 HTTP，默认 `no`；已有配置保留，`--allow-http no` 可恢复 HTTPS 要求。

开关写入 `docker/client.env` 的 `T_AGENT_CLIENT_ALLOW_HTTP=true`，Compose 传入 `CLIENT_ALLOW_HTTP=true`。原生 Client 也可在 `.env` 配置 `CLIENT_ALLOW_HTTP=true` 并重启。只有精确的 `true` 会启用。HTTP 会明文传输验证码和会话，仅适用于可信内网；该开关不自动判断来源 IP，访问范围仍需由端口绑定、防火墙或安全组限制。首次绑定仍通过服务器安装命令完成，不允许远程未登录用户重新绑定。浏览器要求安全上下文的能力（如 PWA 安装及部分剪贴板 API）仍受 HTTP 限制。
