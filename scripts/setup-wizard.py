#!/usr/bin/env python3
"""本地安装向导：在浏览器里勾选并运行开发环境、Mac 应用和代理配置脚本。

安全边界：
- 只监听 127.0.0.1；远程服务器请用 SSH 端口转发访问。
- 每次启动生成随机令牌；页面所有请求都必须携带，并检查 Host 与 Origin，防止其他网页借机调用。
- 只能运行 --scripts-dir 里的两个安装脚本，参数由白名单构造，不接受页面传来的任意命令。
- 订阅链接只通过环境变量交给子进程，不放进命令行参数，输出中自动打码，服务端不保留。
- 一段时间无操作会自动退出。
仅使用 Python 3.6+ 标准库。
"""
import argparse
import json
import os
import platform
import re
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn
from urllib.parse import parse_qs, urlparse

LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}
MAX_BODY = 64 * 1024
IDLE_TIMEOUT = 30 * 60
DEV_SKIPS = ("claude", "codex", "ssh", "sync", "ta")
HOME = os.path.expanduser("~")


def bad_subscription_url(url):
    if not isinstance(url, str) or not re.match(r"^https?://[^\s\"'\\]+$", url) or len(url) > 4096:
        return "订阅链接必须以 http:// 或 https:// 开头，且不能包含空白、引号或反斜杠"
    return None


def port_arg(value, name):
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise ValueError("%s 必须是数字" % name)
    if number < 1024 or number > 65535:
        raise ValueError("%s 必须在 1024-65535 之间" % name)
    return str(number)


def build_job(payload, scripts_dir, system):
    """把页面提交的选项转换成 (显示名, argv, 额外环境变量, 需要打码的字符串)。只允许白名单参数。"""
    action = payload.get("action")
    if action == "dev-env":
        argv = ["bash", os.path.join(scripts_dir, "install-claude-code.sh")]
        skip = payload.get("skip") or []
        if not isinstance(skip, list) or any(item not in DEV_SKIPS for item in skip):
            raise ValueError("skip 只支持 claude、codex、ssh、sync、ta")
        for item in skip:
            argv += ["--skip", item]
        if payload.get("check"):
            argv.append("--check")
        if payload.get("upgrade"):
            argv.append("--upgrade")
        if payload.get("with_apps"):
            if system != "macos":
                raise ValueError("Mac 应用只支持 macOS")
            argv.append("--with-apps")
        return "开发环境", argv, {}, []
    if action == "proxy":
        argv = ["bash", os.path.join(scripts_dir, "install-proxy.sh")]
        mode = payload.get("mode", "install")
        if mode not in ("install", "update", "status"):
            raise ValueError("mode 不合法")
        if mode == "update":
            argv.append("--update")
        elif mode == "status":
            argv.append("--status")
        if payload.get("core") or system == "linux":
            argv.append("--core")
        if payload.get("port"):
            argv += ["--port", port_arg(payload["port"], "代理端口")]
        if payload.get("controller_port"):
            argv += ["--controller-port", port_arg(payload["controller_port"], "控制端口")]
        if payload.get("no_service"):
            argv.append("--no-service")
        env, secrets_list = {}, []
        url = payload.get("subscription")
        if mode == "install" and url:
            problem = bad_subscription_url(url)
            if problem:
                raise ValueError(problem)
            env["T_AGENT_PROXY_SUB_URL"] = url
            secrets_list = [url]
            argv.append("--reconfigure")
        return "代理", argv, env, secrets_list
    raise ValueError("未知操作")


def which_in_user_path(name):
    path = os.pathsep.join([os.path.join(HOME, ".local", "bin"), os.environ.get("PATH", "")])
    return shutil.which(name, path=path)


def collect_state(scripts_dir):
    system = "macos" if sys.platform == "darwin" else "linux" if sys.platform.startswith("linux") else sys.platform
    def app(name):
        return any(os.path.isdir(os.path.join(base, name)) for base in ("/Applications", os.path.join(HOME, "Applications")))
    ssh_keys = [n for n in ("id_ed25519", "id_rsa", "id_ecdsa", "id_dsa") if os.path.isfile(os.path.join(HOME, ".ssh", n))]
    return {
        "platform": system,
        "arch": platform.machine(),
        "ssh_session": bool(os.environ.get("SSH_CONNECTION")),
        "scripts_ready": all(os.path.isfile(os.path.join(scripts_dir, n)) for n in ("install-claude-code.sh", "install-proxy.sh")),
        "installed": {
            "claude": bool(which_in_user_path("claude")),
            "codex": bool(which_in_user_path("codex")),
            "ssh_key": bool(ssh_keys),
            "ta": os.path.isfile(os.path.join(HOME, ".local", "bin", "ta")),
            "sync": os.path.isfile(os.path.join(HOME, ".local", "share", "t-agent", "agent-sync.py")),
            "maccy": app("Maccy.app"),
            "snipaste": app("Snipaste.app"),
            "clash_verge": app("Clash Verge.app"),
            "mihomo": os.path.isfile(os.path.join(HOME, ".local", "bin", "mihomo")),
            "proxy_subscription_saved": os.path.isfile(os.path.join(HOME, ".config", "mihomo", "subscription.url")),
        },
    }


class Job(object):
    def __init__(self, name, argv, env, secrets_list):
        self.name, self.argv, self.extra_env, self.secrets = name, argv, env, secrets_list
        self.lines, self.done, self.code = [], False, None
        self.lock = threading.Lock()
        self.started = time.time()

    def _redact(self, text):
        for secret in self.secrets:
            text = text.replace(secret, "***")
        return text

    def _append(self, text):
        with self.lock:
            self.lines.append(self._redact(text))

    def start(self):
        env = dict(os.environ)
        env.update(self.extra_env)
        env["LC_ALL"] = env.get("LC_ALL") or "en_US.UTF-8"
        try:
            self.proc = subprocess.Popen(self.argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                         stderr=subprocess.STDOUT, env=env)
        except OSError as error:
            self._append("无法启动：%s" % error)
            self.done, self.code = True, 127
            return
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self):
        for raw in iter(self.proc.stdout.readline, b""):
            self._append(raw.decode("utf-8", "replace").rstrip("\r\n"))
        self.code = self.proc.wait()
        self.done = True

    def snapshot(self, since):
        with self.lock:
            return {"name": self.name, "lines": self.lines[since:], "next": len(self.lines),
                    "done": self.done, "code": self.code}


class Wizard(object):
    def __init__(self, scripts_dir, token):
        self.scripts_dir, self.token = scripts_dir, token
        self.job = None
        self.lock = threading.Lock()
        self.last_activity = time.time()
        self.server = None

    def run(self, payload):
        system = "macos" if sys.platform == "darwin" else "linux"
        name, argv, env, secrets_list = build_job(payload, self.scripts_dir, system)
        if not os.path.isfile(argv[1]):
            raise ValueError("找不到脚本：%s" % os.path.basename(argv[1]))
        with self.lock:
            if self.job is not None and not self.job.done:
                raise RuntimeError("已有任务正在运行，请等它结束")
            self.job = Job(name, argv, env, secrets_list)
            self.job.start()

    def busy(self):
        return self.job is not None and not self.job.done


def hostname_of(header_value):
    if not header_value:
        return None
    try:
        return urlparse("//" + header_value).hostname
    except ValueError:
        return None


def make_handler(wizard, html):
    class Handler(BaseHTTPRequestHandler):
        server_version = "SetupWizard"

        def log_message(self, *args):  # 请求路径里有令牌，不写访问日志
            pass

        def _send(self, status, body, content_type="application/json; charset=utf-8"):
            data = body if isinstance(body, bytes) else body.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy", "default-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'")
            self.end_headers()
            self.wfile.write(data)

        def _json(self, status, obj):
            self._send(status, json.dumps(obj, ensure_ascii=False))

        def _host_ok(self):
            return hostname_of(self.headers.get("Host")) in LOOPBACK_HOSTS

        def _api_ok(self):
            if not self._host_ok():
                self._json(403, {"error": "Host 不合法"})
                return False
            supplied = self.headers.get("X-Wizard-Token", "")
            if not secrets.compare_digest(supplied, wizard.token):
                self._json(403, {"error": "令牌无效，请使用启动时打印的完整地址"})
                return False
            origin = self.headers.get("Origin")
            if origin and hostname_of(origin.split("://", 1)[-1]) not in LOOPBACK_HOSTS:
                self._json(403, {"error": "Origin 不合法"})
                return False
            wizard.last_activity = time.time()
            return True

        def do_GET(self):
            parsed = urlparse(self.path)
            if parsed.path == "/":
                token = (parse_qs(parsed.query).get("token") or [""])[0]
                if not self._host_ok() or not secrets.compare_digest(token, wizard.token):
                    self._send(403, "403：请使用启动脚本打印的完整地址访问。", "text/plain; charset=utf-8")
                    return
                wizard.last_activity = time.time()
                self._send(200, html.replace("__TOKEN__", wizard.token), "text/html; charset=utf-8")
            elif parsed.path == "/api/state":
                if self._api_ok():
                    state = collect_state(wizard.scripts_dir)
                    state["busy"] = wizard.busy()
                    self._json(200, state)
            elif parsed.path == "/api/job":
                if self._api_ok():
                    since = int((parse_qs(parsed.query).get("since") or ["0"])[0] or 0)
                    self._json(200, wizard.job.snapshot(since) if wizard.job else {"name": None, "lines": [], "next": 0, "done": True, "code": None})
            else:
                self._send(404, "not found", "text/plain; charset=utf-8")

        def do_POST(self):
            if not self._api_ok():
                return
            if not (self.headers.get("Content-Type") or "").startswith("application/json"):
                self._json(415, {"error": "需要 application/json"})
                return
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = -1
            if length < 0 or length > MAX_BODY:
                self._json(413, {"error": "请求过大"})
                return
            try:
                payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
                if not isinstance(payload, dict):
                    raise ValueError("请求格式不正确")
            except ValueError:
                self._json(400, {"error": "请求不是有效的 JSON"})
                return
            path = urlparse(self.path).path
            if path == "/api/run":
                try:
                    wizard.run(payload)
                except ValueError as error:
                    self._json(400, {"error": str(error)})
                except RuntimeError as error:
                    self._json(409, {"error": str(error)})
                else:
                    self._json(200, {"ok": True})
            elif path == "/api/shutdown":
                self._json(200, {"ok": True})
                threading.Thread(target=wizard.server.shutdown, daemon=True).start()
            else:
                self._json(404, {"error": "not found"})

    return Handler


class Server(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def find_port(start):
    for port in range(start, start + 20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            try:
                probe.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise SystemExit("找不到可用端口（%d-%d）" % (start, start + 19))


def main():
    parser = argparse.ArgumentParser(description="本地安装向导")
    parser.add_argument("--scripts-dir", default=os.path.dirname(os.path.abspath(__file__)))
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--idle-timeout", type=int, default=IDLE_TIMEOUT, help="无操作自动退出的秒数")
    args = parser.parse_args()

    html_path = os.path.join(args.scripts_dir, "setup-wizard.html")
    if not os.path.isfile(html_path):
        sys.exit("缺少页面文件：%s" % html_path)
    with open(html_path, encoding="utf-8") as handle:
        html = handle.read()

    token = secrets.token_urlsafe(24)
    wizard = Wizard(os.path.abspath(args.scripts_dir), token)
    port = find_port(args.port)
    wizard.server = Server(("127.0.0.1", port), make_handler(wizard, html))
    url = "http://127.0.0.1:%d/?token=%s" % (port, token)

    print("")
    print("安装向导已启动（只监听本机 127.0.0.1）：")
    print("  %s" % url)
    if os.environ.get("SSH_CONNECTION"):
        print("")
        print("当前是 SSH 登录。请在你自己的电脑上另开一个终端建立端口转发，然后用浏览器打开上面的地址：")
        print("  ssh -L %d:127.0.0.1:%d <用户名>@<服务器地址>" % (port, port))
    print("")
    print("按 Ctrl+C 或在页面点“退出向导”结束；%d 分钟无操作会自动退出。" % (args.idle_timeout // 60))
    sys.stdout.flush()

    if not args.no_browser and sys.platform == "darwin" and not os.environ.get("SSH_CONNECTION"):
        threading.Thread(target=webbrowser.open, args=(url,), daemon=True).start()

    def watchdog():
        while True:
            time.sleep(5)
            if not wizard.busy() and time.time() - wizard.last_activity > args.idle_timeout:
                print("长时间无操作，向导自动退出。")
                wizard.server.shutdown()
                return
    threading.Thread(target=watchdog, daemon=True).start()

    try:
        wizard.server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        wizard.server.server_close()
        print("向导已退出。")


if __name__ == "__main__":
    main()
