# Docker Engine 部署

Docker 部署只面向独立 Engine。Client 仍建议原生安装，以便直接使用 Finder、VS Code 和本机终端。

镜像使用 Node.js 22，并在 Debian Bookworm 构建阶段编译 `better-sqlite3` 和 `node-pty`。宿主机不再需要 Node.js、npm、Python 或 C++ 编译器，只需要 Docker Engine 与 Docker Compose v2。

## 首次启动

```bash
git clone https://github.com/TorinMars/t-agent.git
cd t-agent
cp docker/engine.env.example docker/engine.env
mkdir -p "$HOME/.torin/t-agent-data/data" "$HOME/.torin/t-agent-data/tasks"

docker compose --env-file docker/engine.env -f compose.engine.yml pull
docker compose --env-file docker/engine.env -f compose.engine.yml up -d
```

如果 GHCR 镜像尚未发布或当前账号无权拉取，可以直接在服务器上构建；编译发生在构建容器中，仍不依赖宿主机 GCC：

```bash
docker compose --env-file docker/engine.env -f compose.engine.yml build engine
docker compose --env-file docker/engine.env -f compose.engine.yml up -d
```

默认只把端口发布到宿主机的 `127.0.0.1:3100`，适合由 Nginx 反向代理。需要直接通过服务器 IP 访问时，将 `docker/engine.env` 中的 `T_AGENT_ENGINE_BIND` 改为 `0.0.0.0`，并配置防火墙。

首次启动后生成 owner Token：

```bash
docker compose --env-file docker/engine.env -f compose.engine.yml \
  exec engine node scripts/create-engine-token.js owner 'Initial Client'
```

Token 明文只输出一次。把它和 Engine 地址填入 Client 后即可连接。

检查状态和日志：

```bash
docker compose --env-file docker/engine.env -f compose.engine.yml ps
docker compose --env-file docker/engine.env -f compose.engine.yml logs -f engine
curl http://127.0.0.1:3100/v1/health
```

## 数据与工作目录

Compose 默认挂载：

| 宿主机 | 容器 | 用途 |
| --- | --- | --- |
| `~/.torin/t-agent-data/data` | `/var/lib/t-agent` | SQLite、Engine ID、Token、终端历史和更新状态 |
| `~/.torin/t-agent-data/tasks` | `/workspace` | 默认任务工作目录和 Markdown 文件 |

任务 API 没有目录白名单，但容器只能看到镜像内目录和显式挂载的宿主机目录。需要使用其他目录时，应在 `compose.engine.yml` 的 `volumes` 中按相同绝对路径增加挂载，例如：

```yaml
volumes:
  - /home/root/projects:/home/root/projects
  - /www/wwwroot:/www/wwwroot
```

随后任务可以分别把工作目录设为 `/home/root/projects/example` 或 `/www/wwwroot/example`。容器运行账号还必须拥有这些目录的文件权限。

## 从现有 Engine 迁移

先停止旧 Engine，避免两个进程同时写数据库：

```bash
pm2 stop t-agent-engine
# 或 sudo systemctl stop t-agent-engine
```

停止服务后，将旧数据复制到统一持久化目录：

```bash
mkdir -p "$HOME/.torin/t-agent-data/data" "$HOME/.torin/t-agent-data/tasks"
cp -a /home/root/t-agent/data/. "$HOME/.torin/t-agent-data/data/"
cp -a /home/root/t-agent/tasks/. "$HOME/.torin/t-agent-data/tasks/"
```

如果数据库中的旧任务路径以 `/home/root/t-agent/tasks` 开头，在 `docker/engine.env` 中让容器继续使用这个路径：

```env
T_AGENT_ENGINE_STORAGE_DIR=${HOME}/.torin/t-agent-data
T_AGENT_ENGINE_WORKSPACE_CONTAINER=/home/root/t-agent/tasks
```

工作目录的容器路径与原路径保持一致后，数据库里的已有任务无需修改。若已有任务分布在多个目录，还需要逐项添加同路径挂载。启动容器并确认任务、Token 和终端正常后，再移除旧 PM2/systemd 服务。

## 更新与自动更新

Docker Engine 可以检查 GitHub 版本，但不会在容器内部覆盖自身。手动更新使用：

```bash
./scripts/docker-engine-update.sh
```

该脚本只操作 `engine` 服务：拉取新镜像、重建容器并等待健康检查。数据库和任务目录通过挂载保留，更新期间现有终端会断开。

需要自动更新时，在宿主机 `crontab -e` 中添加：

```cron
*/10 * * * * /绝对路径/t-agent/scripts/docker-engine-update.sh >> /绝对路径/t-agent/docker-update.log 2>&1
```

更新脚本在宿主机运行；Engine 容器不会挂载 `/var/run/docker.sock`。因此远程 Engine 页面会展示新版本和“Docker 镜像更新”，但不会提供容器内的“立即更新”按钮。

`main` 分支的 GitHub Actions 会发布以下镜像：

```text
ghcr.io/torinmars/t-agent-engine:latest
ghcr.io/torinmars/t-agent-engine:sha-<commit>
```

GitHub Release 标签还会生成对应 SemVer 镜像标签。首次发布后需要确认 GHCR Package 允许服务器读取；私有镜像应先执行 `docker login ghcr.io`。

## 终端工具与凭证

基础镜像包含 Bash、Git、curl 和 OpenSSH Client，不默认安装 Codex、Claude 等第三方 CLI。需要这些工具时应基于 Engine 镜像创建自己的镜像，例如：

```dockerfile
FROM ghcr.io/torinmars/t-agent-engine:latest
RUN npm install -g @openai/codex
```

CLI 的认证目录也要显式挂载，例如将宿主机的 `/root/.codex` 挂载到容器的 `/root/.codex`。只挂载必要目录，尤其不要把 Docker Socket 挂给 Engine。
