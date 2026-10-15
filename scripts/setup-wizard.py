#!/usr/bin/env python3
"""Local install wizard: tick and run the dev environment, Mac apps and proxy setup scripts in a browser.

Security boundaries:
- Listens on 127.0.0.1 only; for a remote server use SSH port forwarding.
- A random token is generated at every start; every request from the page must carry it, and Host and Origin are checked so other web pages cannot call it.
- Only the two install scripts in --scripts-dir can be run; the arguments are built from an allowlist and arbitrary commands from the page are not accepted.
- The subscription link is only passed to child processes through an environment variable, never on the command line; it is masked in the output and not kept by the server.
- It exits automatically after a period without activity.
Uses only the Python 3.6+ standard library.
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
DEV_SKIPS = ("claude", "codex", "ssh", "sync", "ta", "pm2")
HOME = os.path.expanduser("~")


def bad_subscription_url(url):
    if not isinstance(url, str) or not re.match(r"^https?://[^\s\"'\\]+$", url) or len(url) > 4096:
        return "The subscription link must start with http:// or https:// and must not contain whitespace, quotes or backslashes"
    return None


def port_arg(value, name):
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise ValueError("%s must be a number" % name)
    if number < 1024 or number > 65535:
        raise ValueError("%s must be between 1024 and 65535" % name)
    return str(number)


def build_job(payload, scripts_dir, system):
    """Convert the options submitted by the page into (display name, argv, extra environment variables, strings to mask). Only allowlisted arguments are permitted."""
    action = payload.get("action")
    if action == "dev-env":
        argv = ["bash", os.path.join(scripts_dir, "install-claude-code.sh")]
        skip = payload.get("skip") or []
        if not isinstance(skip, list) or any(item not in DEV_SKIPS for item in skip):
            raise ValueError("skip only supports claude, codex, ssh, sync, ta, pm2")
        for item in skip:
            argv += ["--skip", item]
        if payload.get("check"):
            argv.append("--check")
        if payload.get("upgrade"):
            argv.append("--upgrade")
        if payload.get("with_apps"):
            if system != "macos":
                raise ValueError("Mac apps are only supported on macOS")
            argv.append("--with-apps")
        return "Dev environment", argv, {}, []
    if action == "proxy":
        argv = ["bash", os.path.join(scripts_dir, "install-proxy.sh")]
        mode = payload.get("mode", "install")
        if mode not in ("install", "update", "status"):
            raise ValueError("invalid mode")
        if mode == "update":
            argv.append("--update")
        elif mode == "status":
            argv.append("--status")
        if payload.get("core") or system == "linux":
            argv.append("--core")
        if payload.get("port"):
            argv += ["--port", port_arg(payload["port"], "proxy port")]
        if payload.get("controller_port"):
            argv += ["--controller-port", port_arg(payload["controller_port"], "controller port")]
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
        return "Proxy", argv, env, secrets_list
    raise ValueError("Unknown action")


def which_in_user_path(name):
    path = os.pathsep.join([os.path.join(HOME, ".local", "bin"), os.path.join(HOME, ".local", "node", "bin"), os.environ.get("PATH", "")])
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
            "pm2": bool(which_in_user_path("pm2")),
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
            self._append("Cannot start: %s" % error)
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
            raise ValueError("Script not found: %s" % os.path.basename(argv[1]))
        with self.lock:
            if self.job is not None and not self.job.done:
                raise RuntimeError("A task is already running; wait for it to finish")
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

        def log_message(self, *args): # the request path contains the token, so no access log is written
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
                self._json(403, {"error": "Invalid Host"})
                return False
            supplied = self.headers.get("X-Wizard-Token", "")
            if not secrets.compare_digest(supplied, wizard.token):
                self._json(403, {"error": "Invalid token; use the full address printed at startup"})
                return False
            origin = self.headers.get("Origin")
            if origin and hostname_of(origin.split("://", 1)[-1]) not in LOOPBACK_HOSTS:
                self._json(403, {"error": "Invalid Origin"})
                return False
            wizard.last_activity = time.time()
            return True

        def do_GET(self):
            parsed = urlparse(self.path)
            if parsed.path == "/":
                token = (parse_qs(parsed.query).get("token") or [""])[0]
                if not self._host_ok() or not secrets.compare_digest(token, wizard.token):
                    self._send(403, "403: use the full address printed by the start script.", "text/plain; charset=utf-8")
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
                self._json(415, {"error": "application/json is required"})
                return
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = -1
            if length < 0 or length > MAX_BODY:
                self._json(413, {"error": "Request too large"})
                return
            try:
                payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
                if not isinstance(payload, dict):
                    raise ValueError("Malformed request")
            except ValueError:
                self._json(400, {"error": "The request is not valid JSON"})
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
    raise SystemExit("No free port found (%d-%d)" % (start, start + 19))


def main():
    parser = argparse.ArgumentParser(description="Local install wizard")
    parser.add_argument("--scripts-dir", default=os.path.dirname(os.path.abspath(__file__)))
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--idle-timeout", type=int, default=IDLE_TIMEOUT, help="seconds of inactivity before exiting automatically")
    args = parser.parse_args()

    html_path = os.path.join(args.scripts_dir, "setup-wizard.html")
    if not os.path.isfile(html_path):
        sys.exit("Missing page file: %s" % html_path)
    with open(html_path, encoding="utf-8") as handle:
        html = handle.read()

    token = secrets.token_urlsafe(24)
    wizard = Wizard(os.path.abspath(args.scripts_dir), token)
    port = find_port(args.port)
    wizard.server = Server(("127.0.0.1", port), make_handler(wizard, html))
    url = "http://127.0.0.1:%d/?token=%s" % (port, token)

    print("")
    print("The install wizard has started (listening on 127.0.0.1 only):")
    print("  %s" % url)
    if os.environ.get("SSH_CONNECTION"):
        print("")
        print("This is an SSH login. On your own computer open another terminal, set up the port forward, then open the address above in a browser:")
        print("  ssh -L %d:127.0.0.1:%d <Username>@<Server address>" % (port, port))
    print("")
    print("Press Ctrl+C or click “Quit wizard” on the page to finish; it exits automatically after %d minutes without activity." % (args.idle_timeout // 60))
    sys.stdout.flush()

    if not args.no_browser and sys.platform == "darwin" and not os.environ.get("SSH_CONNECTION"):
        threading.Thread(target=webbrowser.open, args=(url,), daemon=True).start()

    def watchdog():
        while True:
            time.sleep(5)
            if not wizard.busy() and time.time() - wizard.last_activity > args.idle_timeout:
                print("No activity for a long time; the wizard exited automatically.")
                wizard.server.shutdown()
                return
    threading.Thread(target=watchdog, daemon=True).start()

    try:
        wizard.server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        wizard.server.server_close()
        print("The wizard has exited.")


if __name__ == "__main__":
    main()
