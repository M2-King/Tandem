"""Reference server for Tandem on iPad (development and tests).

The iPad app (ipad/App/Sources/LocalServer.swift) serves exactly this API on
127.0.0.1. This Python version runs the same web app in a desktop browser, so
the iPad build can be tested without an iPad.

    python ipad/devserver.py --projects <folder> --pyodide <folder> [--port 8780] [--token T]

* /                      the Tandem UI (dist/), with the iPad config tag
* /pyodide/...           Pyodide and its packages
* /api/status            project name
* /api/files, /api/file  project files (text), same as the desktop runtime
* /api/raw               project files as bytes (Python's view of the project)
* /api/projects          list / create / open projects
* /api/wallpaper         the person's wallpaper photo (kept by the app)
* /api/ai/settings       provider settings; keys are kept here, never returned
* /api/ai/proxy/<p>/...  requests to the AI provider, with the key added here

Every response is cross-origin isolated (COOP/COEP), which the page needs for
SharedArrayBuffer (input() and the debugger wait on shared memory).
"""

from __future__ import annotations

import argparse
import hmac
import json
import mimetypes
import re
import secrets
import sys
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "runtime"))

from tandem_runtime.ai_settings import PROVIDERS, AISettings, SettingsError  # noqa: E402
from tandem_runtime.files import FileError, ProjectFiles  # noqa: E402

PLACEHOLDER_KEY = "tandem-proxy-key"
PROJECT_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$")
ISOLATION = {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "same-origin",
}
STARTER = 'name = input("What is your name? ")\nprint(f"Hello, {name}!")\n'


class State:
    def __init__(self, projects: Path, pyodide: Path, ui: Path, token: str, port: int, config: Path, selftest: bool = False):
        self.selftest = selftest
        self.projects = projects
        self.pyodide = pyodide
        self.ui = ui
        self.token = token
        self.port = port
        self.config = config
        self.ai = AISettings(config)
        self.projects.mkdir(parents=True, exist_ok=True)
        existing = sorted(p.name for p in projects.iterdir() if p.is_dir() and not p.name.startswith("."))
        if not existing:
            (projects / "My Project").mkdir()
            (projects / "My Project" / "hello.py").write_text(STARTER, encoding="utf-8")
            existing = ["My Project"]
        self.current = existing[0]

    @property
    def files(self) -> ProjectFiles:
        return ProjectFiles(self.projects / self.current)


def make_handler(state: State):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass

        # ---------------- responses
        def send(self, code: int, body: bytes, content_type: str, extra: dict | None = None):
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            for k, v in {**ISOLATION, **(extra or {})}.items():
                self.send_header(k, v)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def json(self, data, code: int = 200):
            self.send(code, json.dumps(data).encode(), "application/json", {"Cache-Control": "no-store"})

        def error(self, code: int, detail: str):
            self.json({"detail": detail}, code)

        def body(self) -> bytes:
            length = int(self.headers.get("Content-Length") or 0)
            return self.rfile.read(length) if length else b""

        # ---------------- security
        def allowed(self, protected: bool) -> bool:
            host = (self.headers.get("Host") or "").lower()
            if host not in (f"127.0.0.1:{state.port}", f"localhost:{state.port}"):
                self.error(403, "Unexpected host")
                return False
            if not protected:
                return True
            origin = self.headers.get("Origin")
            if origin and origin not in (f"http://127.0.0.1:{state.port}", f"http://localhost:{state.port}"):
                self.error(403, "Origin not allowed")
                return False
            if not hmac.compare_digest((self.headers.get("x-tandem-token") or "").encode(), state.token.encode()):
                self.error(403, "Missing or wrong session token")
                return False
            return True

        # ---------------- routing
        def do_HEAD(self):
            self.do_GET()

        def do_GET(self):
            self.route("GET")

        def do_PUT(self):
            self.route("PUT")

        def do_POST(self):
            self.route("POST")

        def route(self, method: str):
            url = urllib.parse.urlsplit(self.path)
            path = urllib.parse.unquote(url.path)
            query = {k: v[0] for k, v in urllib.parse.parse_qs(url.query).items()}
            protected = path.startswith("/api/")
            if not self.allowed(protected):
                return
            try:
                if path.startswith("/api/ai/proxy/"):
                    return self.proxy(method, path[len("/api/ai/proxy/"):], url.query)
                if protected:
                    return self.api(method, path, query)
                return self.static(path)
            except FileError as exc:
                return self.error(400, str(exc))
            except SettingsError as exc:
                return self.error(400, str(exc))

        def api(self, method, path, query):
            files = state.files
            if path == "/api/status" and method == "GET":
                return self.json({"runtime": {"version": "ipad", "platform": "iPadOS"},
                                  "project": {"root": state.current, "name": state.current}, "busy": None})
            if path == "/api/files" and method == "GET":
                return self.json({"files": files.list()})
            if path == "/api/file":
                if method == "GET":
                    return self.json(files.read(query.get("path", "")))
                data = json.loads(self.body() or b"{}")
                if method == "PUT":
                    return self.json(files.write(data["path"], data["text"], base_hash=data.get("base_hash")))
                if method == "POST":
                    return self.json(files.write(data["path"], data.get("text", ""), create=True))
            if path == "/api/raw":
                target = files.resolve(query.get("path", ""))
                if method == "GET":
                    if not target.is_file():
                        return self.error(404, "No such file.")
                    return self.send(200, target.read_bytes(), "application/octet-stream", {"Cache-Control": "no-store"})
                if method == "PUT":
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(self.body())
                    return self.json({"path": query.get("path")})
            if path == "/api/projects":
                if method == "GET":
                    names = sorted(p.name for p in state.projects.iterdir() if p.is_dir() and not p.name.startswith("."))
                    return self.json({"projects": names, "current": state.current, "stored_in": "Files › On My iPad › Tandem"})
                if method == "POST":
                    data = json.loads(self.body() or b"{}")
                    name = str(data.get("name", "")).strip()
                    if not PROJECT_NAME.match(name):
                        return self.error(400, "Use letters, numbers, spaces, dots, dashes or underscores.")
                    folder = state.projects / name
                    if data.get("create"):
                        if folder.exists():
                            return self.error(400, f"{name} already exists.")
                        folder.mkdir()
                        (folder / "main.py").write_text('print("Hello from Tandem")\n', encoding="utf-8")
                    elif not folder.is_dir():
                        return self.error(404, f"There is no project called {name}.")
                    state.current = name
                    return self.json({"current": name})
            if path == "/api/wallpaper":
                stored = state.config / "wallpaper.json"
                if method == "GET":
                    if not stored.is_file():
                        return self.json({})
                    return self.send(200, stored.read_bytes(), "application/json", {"Cache-Control": "no-store"})
                if method == "PUT":
                    body = self.body()
                    if len(body) > 24 * 1024 * 1024:
                        return self.error(400, "That image is too large.")
                    image = json.loads(body or b"{}").get("image")
                    if not isinstance(image, str) or not image.startswith("data:image/"):
                        return self.error(400, "That isn't an image.")
                    stored.parent.mkdir(parents=True, exist_ok=True)
                    stored.write_bytes(body)
                    return self.json({"ok": True})
            if path == "/api/selftest" and method == "POST":
                body = self.body()
                (state.projects / ".selftest.json").write_bytes(body)
                print("TANDEM-SELFTEST " + body.decode("utf-8", "replace"), flush=True)
                return self.json({"ok": True})
            if path == "/api/ai/settings":
                if method == "GET":
                    return self.json({**state.ai.public(), "stored_in": "iPad Keychain"})
                if method == "PUT":
                    d = json.loads(self.body() or b"{}")
                    out = state.ai.update(d.get("provider", ""), model=d.get("model"), base_url=d.get("base_url"),
                                          api_key=d.get("api_key"), clear_key=bool(d.get("clear_key")), activate=d.get("activate"))
                    return self.json({**out, "stored_in": "iPad Keychain"})
            return self.error(404, "Not found")

        def proxy(self, method, rest, query):
            provider, _, sub = rest.partition("/")
            if provider not in PROVIDERS:
                return self.error(404, "Unknown provider")
            base = state.ai.provider_config(provider)["base_url"].rstrip("/")
            key = state.ai.key(provider) or ""
            target = f"{base}/{sub}" + (f"?{query}" if query else "")
            headers = {}
            for k, v in self.headers.items():
                if k.lower() in ("host", "origin", "referer", "x-tandem-token", "content-length", "connection",
                                 "accept-encoding", "cookie"):
                    continue
                if PLACEHOLDER_KEY in v:
                    if not key:
                        continue
                    v = v.replace(PLACEHOLDER_KEY, key)
                headers[k] = v
            data = self.body() if method in ("POST", "PUT") else None
            request = urllib.request.Request(target, data=data, method=method, headers=headers)
            try:
                with urllib.request.urlopen(request, timeout=300) as r:
                    return self.send(r.status, r.read(), r.headers.get("Content-Type", "application/json"))
            except urllib.error.HTTPError as exc:
                return self.send(exc.code, exc.read(), exc.headers.get("Content-Type", "application/json"))
            except (urllib.error.URLError, OSError) as exc:
                return self.error(502, f"Couldn't reach {urllib.parse.urlsplit(target).netloc} ({getattr(exc, 'reason', exc)}).")

        def static(self, path):
            if path.startswith("/pyodide/"):
                base, rel = state.pyodide, path[len("/pyodide/"):]
            else:
                base, rel = state.ui, path.lstrip("/")
            candidate = (base / rel).resolve() if rel else None
            if candidate and candidate.is_file() and base.resolve() in candidate.parents:
                ctype = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
                if candidate.suffix == ".mjs":
                    ctype = "text/javascript"
                if candidate.suffix == ".wasm":
                    ctype = "application/wasm"
                return self.send(200, candidate.read_bytes(), ctype, {"Cache-Control": "max-age=3600"})
            if path.startswith("/pyodide/") or path.startswith("/assets/"):
                return self.error(404, "Not found")
            html = (state.ui / "index.html").read_text(encoding="utf-8")
            config = json.dumps({"mode": "local", "platform": "ipad", "token": state.token, "selftest": state.selftest}).replace("</", "<\\/")
            html = html.replace("</head>", f'<script id="tandem-runtime" type="application/json">{config}</script></head>', 1)
            return self.send(200, html.encode(), "text/html; charset=utf-8", {"Cache-Control": "no-store"})

    return Handler


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--projects", type=Path, required=True)
    ap.add_argument("--pyodide", type=Path, required=True)
    ap.add_argument("--ui", type=Path, default=ROOT / "dist")
    ap.add_argument("--config", type=Path, help="folder for AI settings (default: <projects>/.config)")
    ap.add_argument("--port", type=int, default=8780)
    ap.add_argument("--token", default=None)
    ap.add_argument("--selftest", action="store_true", help="the page runs the self-test and reports to .selftest.json")
    args = ap.parse_args()
    token = args.token or secrets.token_urlsafe(24)
    state = State(args.projects, args.pyodide, args.ui, token, args.port, args.config or args.projects / ".config", args.selftest)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(state))
    print(f"http://127.0.0.1:{args.port}/", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
