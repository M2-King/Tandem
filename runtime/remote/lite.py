"""Tandem on an SSH server, without installing anything: the project's files,
the Terminal and Run, with the server's own python3 (3.6 or newer) and only
Python's standard library. Nothing is downloaded.

    python3 lite.py <project folder>

It speaks the same API as Tandem's runtime (runtime/tandem_runtime), for
what it offers:

* files: list, read, write, create, add, raw bytes (/api/files, /api/file,
  /api/raw, /api/upload), confined to the project folder;
* the Terminal: a shell in a pseudo-terminal, in the project folder, with the
  project's environment first on PATH (term.* on /ws);
* Run: `python -u <file>` with the project's Python, its output, input() and
  Stop (run.* on /ws).

Notebooks, Step through and Debug, environments and packages, and code
completion need Tandem's full runtime on the server; they say so here.

Security is the runtime's: it listens on the server's 127.0.0.1 only, every
request must name 127.0.0.1:<port> as its host, and the API and WebSocket
need the random token printed at start (the app reads it over SSH) and, from
a browser, this origin. It stops when its standard input closes (the SSH
connection that started it).
"""

import base64
import codecs
import fcntl
import hashlib
import hmac
import json
import os
import platform
import pty
import re
import secrets
import shutil
import signal
import socket
import socketserver
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

VERSION = "light-1"
FULL = "connect again with “Also install notebooks and the debugger” ticked."


def needs_full(what):
    """What a feature missing here says: what needs the full tools, and how to get them."""
    return "{} on this server need Tandem's full tools: {}".format(what, FULL)

# ---------------------------------------------------------------- files
# As runtime/tandem_runtime/files.py.

SKIP_DIRS = {".git", ".hg", ".svn", ".venv", "venv", "env", "__pycache__", "node_modules", ".tandem",
             ".ipynb_checkpoints", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".idea", ".vscode"}
MAX_TEXT_BYTES = 2 * 1024 * 1024
MAX_FILES = 2000
MAX_UPLOAD_BYTES = 25 * 1024 * 1024
MAX_RAW_BYTES = 50 * 1024 * 1024
MAX_NOTEBOOK_BYTES = 25 * 1024 * 1024
MAX_BODY = MAX_RAW_BYTES + 1024 * 1024


class FileError(Exception):
    """A request the file API refuses; the message is safe to show."""


def content_hash(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


class ProjectFiles:
    def __init__(self, root):
        self.root = Path(root).resolve()

    def resolve(self, rel):
        if not rel or rel.startswith(("/", "\\")) or ":" in rel.split("/")[0]:
            raise FileError("Paths must be relative to the project folder.")
        target = (self.root / rel).resolve()
        if target != self.root and self.root not in target.parents:
            raise FileError("That path is outside the project folder.")
        return target

    def list(self):
        out = []
        for dirpath, dirnames, filenames in os.walk(str(self.root)):
            dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")
                                 and not (Path(dirpath) / d / "pyvenv.cfg").exists())
            for name in sorted(filenames):
                if name.startswith(".") and name not in {".gitignore", ".env.example"}:
                    continue
                full = Path(dirpath) / name
                try:
                    self.resolve(full.relative_to(self.root).as_posix())
                    size = full.stat().st_size
                except (FileError, OSError):
                    continue
                out.append({"path": full.relative_to(self.root).as_posix(), "size": size})
                if len(out) >= MAX_FILES:
                    return out
        return out

    def read(self, rel):
        path = self.resolve(rel)
        if not path.is_file():
            raise FileError("{} doesn't exist.".format(rel))
        size = path.stat().st_size
        if size > (MAX_NOTEBOOK_BYTES if path.suffix == ".ipynb" else MAX_TEXT_BYTES):
            return {"path": rel, "text": None, "reason": "too-large", "size": size}
        data = path.read_bytes()
        if b"\x00" in data[:8192]:
            return {"path": rel, "text": None, "reason": "binary", "size": size}
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            return {"path": rel, "text": None, "reason": "not-utf8", "size": size}
        return {"path": rel, "text": text, "hash": content_hash(text), "size": size}

    def _replace(self, path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(".{}.tandem-tmp".format(path.name))
        tmp.write_bytes(data)
        os.replace(str(tmp), str(path))

    def write(self, rel, text, base_hash=None, create=False):
        path = self.resolve(rel)
        if path.exists() and not path.is_file():
            raise FileError("{} is a folder.".format(rel))
        if create and path.exists():
            raise FileError("{} already exists.".format(rel))
        if not create and not path.exists():
            raise FileError("{} doesn't exist.".format(rel))
        if base_hash and path.exists():
            current = self.read(rel)
            if current.get("hash") and current["hash"] != base_hash:
                raise FileError("{} changed on disk since it was opened.".format(rel))
        limit = MAX_NOTEBOOK_BYTES if path.suffix == ".ipynb" else MAX_TEXT_BYTES
        if len(text.encode("utf-8")) > limit:
            raise FileError("{} is larger than {} MB.".format(rel, limit // (1024 * 1024)))
        self._replace(path, text.encode("utf-8"))
        return {"path": rel, "hash": content_hash(text), "size": path.stat().st_size}

    def add(self, rel, data):
        path = self.resolve(rel)
        if path.exists():
            raise FileError("{} already exists.".format(rel))
        if len(data) > MAX_UPLOAD_BYTES:
            raise FileError("{} is larger than 25 MB.".format(rel))
        self._replace(path, data)
        return {"path": rel, "size": len(data)}

    def read_bytes(self, rel):
        path = self.resolve(rel)
        if not path.is_file():
            raise FileError("{} doesn't exist.".format(rel))
        if path.stat().st_size > MAX_RAW_BYTES:
            raise FileError("{} is larger than {} MB.".format(rel, MAX_RAW_BYTES // (1024 * 1024)))
        return path.read_bytes()

    def put_bytes(self, rel, data):
        path = self.resolve(rel)
        if path.exists() and not path.is_file():
            raise FileError("{} is a folder.".format(rel))
        if len(data) > MAX_RAW_BYTES:
            raise FileError("{} would be larger than {} MB.".format(rel, MAX_RAW_BYTES // (1024 * 1024)))
        self._replace(path, data)
        return {"path": rel, "size": len(data)}


# ---------------------------------------------------------------- Python
# As runtime/tandem_runtime/interpreters.py: the project's setting, its
# environment (.venv, venv, env), else python3 on PATH.

VENV_DIRS = (".venv", "venv", "env")


def project_python(root):
    try:
        saved = json.loads((root / ".tandem" / "settings.json").read_text(encoding="utf-8")).get("python")
    except (OSError, ValueError, AttributeError):
        saved = None
    if saved and Path(saved).exists():
        return Path(saved), "project setting"
    for name in VENV_DIRS:
        candidate = root / name / "bin" / "python"
        if candidate.exists():
            return candidate, "project environment ({})".format(name)
    found = shutil.which("python3") or shutil.which("python")
    return (Path(found), "PATH") if found else (None, "none")


def describe(python):
    probe = ("import json, sys, platform;"
             "print(json.dumps({'version': platform.python_version(), 'executable': sys.executable,"
             " 'prefix': sys.prefix, 'base_prefix': getattr(sys, 'base_prefix', sys.prefix),"
             " 'implementation': platform.python_implementation()}))")
    try:
        out = subprocess.run([str(python), "-c", probe], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             universal_newlines=True, timeout=15, check=True)
        info = json.loads(out.stdout.strip().splitlines()[-1])
    except (OSError, subprocess.SubprocessError, ValueError, IndexError) as exc:
        return {"path": str(python), "ok": False, "error": "Couldn't start {}: {}".format(python, exc)}
    info["path"] = str(python)
    info["ok"] = True
    info["is_venv"] = info["prefix"] != info["base_prefix"]
    return info


def environment_dir(python):
    if python is None:
        return None
    here = Path(python).parent
    for root in (here.parent, here):
        if (root / "pyvenv.cfg").is_file() or (root / "conda-meta").is_dir():
            return root
    return None


# ---------------------------------------------------------------- Terminal
# As runtime/tandem_runtime/terminals.py (POSIX).

MAX_TERMINALS = 8


def _q(text):
    return "'" + text.replace("'", "'\\''") + "'"


def shell_env(python):
    env = dict(os.environ)
    env["TERM"] = "xterm-256color"
    env.setdefault("COLORTERM", "truecolor")
    if python is None:
        return env, None
    env["PATH"] = str(Path(python).parent) + os.pathsep + env.get("PATH", "")
    found = environment_dir(python)
    if found is None:
        return env, None
    if (found / "pyvenv.cfg").is_file():
        env["VIRTUAL_ENV"] = str(found)
        env["VIRTUAL_ENV_PROMPT"] = found.name
        env.pop("PYTHONHOME", None)
    else:
        env["CONDA_PREFIX"] = str(found)
    return env, found.name


def shell_command(python, env, scratch):
    found = environment_dir(python)
    venv = found if found is not None and (found / "pyvenv.cfg").is_file() else None
    bindir = str(Path(python).parent) if python else None
    shell = os.environ.get("SHELL") or shutil.which("bash") or "/bin/sh"
    name = Path(shell).name
    if venv is not None and (venv / "bin" / "activate").is_file():
        activate = ". {}".format(_q(str(venv / "bin" / "activate")))
    elif bindir:
        activate = "export PATH={}:\"$PATH\"".format(_q(bindir))
    else:
        activate = ""
    if not activate:
        return [shell, "-i"]
    scratch.mkdir(parents=True, exist_ok=True)
    if name == "bash":
        rc = scratch / "bashrc"
        rc.write_text("[ -f /etc/bash.bashrc ] && . /etc/bash.bashrc\n"
                      "[ -f ~/.bashrc ] && . ~/.bashrc\n" + activate + "\n", encoding="utf-8")
        return [shell, "--rcfile", str(rc), "-i"]
    if name == "zsh":
        home = env.get("ZDOTDIR") or env.get("HOME") or os.path.expanduser("~")
        (scratch / ".zshenv").write_text("[ -f {0} ] && . {0}\n".format(_q(home + "/.zshenv")), encoding="utf-8")
        (scratch / ".zshrc").write_text("ZDOTDIR={}\n[ -f {} ] && . {}\n{}\n".format(
            _q(home), _q(home + "/.zshrc"), _q(home + "/.zshrc"), activate), encoding="utf-8")
        env["ZDOTDIR"] = str(scratch)
        return [shell, "-i"]
    return [shell, "-i"]


class Terminal:
    def __init__(self, term_id, argv, cwd, env, cols, rows, send, on_end):
        self.id, self.send, self.on_end = term_id, send, on_end
        self.master, slave = pty.openpty()
        self.resize(cols, rows)
        self.proc = subprocess.Popen(argv, stdin=slave, stdout=slave, stderr=slave, cwd=cwd, env=env,
                                     start_new_session=True, close_fds=True)
        os.close(slave)
        self.closed = False
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self):
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        while True:
            try:
                data = os.read(self.master, 65536)
            except OSError:
                data = b""
            if not data:
                break
            text = decoder.decode(data)
            if text:
                self.send({"type": "term.output", "id": self.id, "data": text})
        self.closed = True
        try:
            os.close(self.master)
        except OSError:
            pass
        try:
            code = self.proc.wait(timeout=1)
        except subprocess.TimeoutExpired:
            code = None
        self.on_end(self)
        self.send({"type": "term.exit", "id": self.id, "code": code})

    def write(self, text):
        if not self.closed:
            try:
                os.write(self.master, text.encode("utf-8"))
            except OSError:
                pass

    def resize(self, cols, rows):
        try:
            fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", max(2, int(rows)), max(2, int(cols)), 0, 0))
        except (OSError, ValueError):
            pass

    def kill(self):
        if self.proc.poll() is None:
            _signal_group(self.proc.pid, signal.SIGHUP)
            threading.Timer(2, lambda: self.proc.poll() is None and _signal_group(self.proc.pid, signal.SIGKILL)).start()


def _signal_group(pid, sig):
    try:
        os.killpg(pid, sig)
    except OSError:
        pass


# ---------------------------------------------------------------- Run

OUTPUT_RATE = 200000  # characters a second shown, at most (a print loop makes far more)
TRACEBACK_LINE = re.compile(r'^\s*File "(.+)", line (\d+)')


def parse_error(stderr, root):
    """The error a run ended with, from the end of its traceback: {type, message, path, line}."""
    lines = [l for l in stderr.splitlines() if l.strip()]
    if not lines:
        return None
    last = lines[-1]
    match = re.match(r"^([A-Za-z_][\w.]*(?:Error|Exception|Exit|Interrupt|Warning)?)(?::\s?(.*))?$", last)
    if not match or " " in match.group(1):
        return None
    error = {"type": match.group(1), "message": match.group(2) or ""}
    for line in reversed(lines):
        found = TRACEBACK_LINE.match(line)
        if found:
            try:
                rel = Path(found.group(1)).resolve().relative_to(root).as_posix()
            except ValueError:
                continue
            error["path"], error["line"] = rel, int(found.group(2))
            break
    return error


class Run:
    def __init__(self, run_id, path, python, script, root, send, on_end):
        self.id, self.path, self.send, self.on_end, self.root = run_id, path, send, on_end, root
        env = dict(os.environ, PYTHONUNBUFFERED="1", PYTHONIOENCODING="utf-8")
        env.pop("PYTHONHOME", None)
        self.proc = subprocess.Popen([str(python), "-u", str(script)], cwd=str(root), env=env,
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     start_new_session=True)
        self.started = time.monotonic()
        self.stopping = False
        self.stderr_tail = ""
        self.lock = threading.Lock()
        self.pumps = [threading.Thread(target=self._pump, args=(self.proc.stdout, "out"), daemon=True),
                      threading.Thread(target=self._pump, args=(self.proc.stderr, "err"), daemon=True)]

    def start(self):
        """Its output and its end, once run.started has gone out."""
        for t in self.pumps:
            t.start()
        threading.Thread(target=self._finish, daemon=True).start()

    def _pump(self, stream, kind):
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        window, budget, skipped = time.monotonic(), OUTPUT_RATE, 0
        fd = stream.fileno()
        while True:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                chunk = b""
            text = decoder.decode(chunk, final=not chunk)
            if kind == "err":
                self.stderr_tail = (self.stderr_tail + text)[-20000:]
            if text and not self.stopping:
                now = time.monotonic()
                if now - window >= 1:
                    window, budget = now, OUTPUT_RATE
                if len(text) > budget:
                    skipped += len(text) - max(budget, 0)
                    text = text[:max(budget, 0)]
                budget -= len(text)
                if skipped and budget > 0:
                    text = "\n… {:,} characters of output skipped (the program prints faster than it can be shown) …\n".format(skipped) + text
                    skipped = 0
                if text:
                    self.send({"type": "run.output", "id": self.id, "stream": kind, "text": text})
            if not chunk:
                break

    def _finish(self):
        code = self.proc.wait()
        for t in self.pumps:
            t.join(timeout=5)
        status = "stopped" if self.stopping else ("success" if code == 0 else "error")
        error = parse_error(self.stderr_tail, self.root) if status == "error" else None
        self.on_end(self)
        self.send({"type": "run.exit", "id": self.id, "status": status, "exit_code": code,
                   "duration_ms": int((time.monotonic() - self.started) * 1000), "error": error})

    def stop(self, force=False):
        if self.proc.poll() is not None:
            return
        self.stopping = True

        def steps():
            for sig, wait in ([] if force else [(signal.SIGINT, 2), (signal.SIGTERM, 2)]) + [(signal.SIGKILL, 0)]:
                if self.proc.poll() is not None:
                    return
                _signal_group(self.proc.pid, sig)
                try:
                    self.proc.wait(timeout=wait or None)
                    return
                except subprocess.TimeoutExpired:
                    continue
        threading.Thread(target=steps, daemon=True).start()

    def input(self, text):
        with self.lock:
            try:
                self.proc.stdin.write((text + "\n").encode("utf-8"))
                self.proc.stdin.flush()
            except (OSError, ValueError):
                pass

    def close_input(self):
        with self.lock:
            try:
                self.proc.stdin.close()
            except (OSError, ValueError):
                pass


# ---------------------------------------------------------------- the server

class App:
    def __init__(self, root, token):
        self.files = ProjectFiles(root)
        self.token = token
        self.port = 0
        self.lock = threading.Lock()
        self.terminals = {}
        self.run = None

    def hosts(self):
        return {"127.0.0.1:{}".format(self.port), "localhost:{}".format(self.port)}

    def python(self):
        return project_python(self.files.root)

    def status(self):
        python, source = self.python()
        info = describe(python) if python else {"ok": False, "error": "No Python interpreter found."}
        info["source"] = source
        return {
            "runtime": {"version": VERSION, "platform": platform.system(), "light": True},
            "project": {"root": str(self.files.root), "name": self.files.root.name},
            "python": info,
            "busy": self.run.path if self.run else None,
            "shared": {"root": ""},
        }

    def stop_all(self):
        with self.lock:
            terms, run = list(self.terminals.values()), self.run
        for term in terms:
            term.kill()
        if run:
            run.stop(force=True)


class Handler(BaseHTTPRequestHandler):
    server_version = "Tandem"
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # quiet: stdout is the app's channel
        pass

    @property
    def app(self):
        return self.server.app

    # ---- checks, as runtime/tandem_runtime/security.py

    def refused(self):
        host = (self.headers.get("Host") or "").lower()
        if host not in self.app.hosts():
            return "Unexpected host"
        path = urlsplit(self.path).path
        if path.startswith("/api/") or path == "/ws":
            origin = self.headers.get("Origin")
            if origin is not None and origin not in {"http://" + h for h in self.app.hosts()}:
                return "Origin not allowed"
            presented = self.headers.get("x-tandem-token")
            if presented is None and path == "/ws":
                presented = (parse_qs(urlsplit(self.path).query).get("token") or [None])[0]
            if presented is None or not hmac.compare_digest(presented, self.app.token):
                return "Missing or wrong session token"
        return None

    def reply(self, status, body, content_type="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raise FileError("That's larger than Tandem accepts.")
        return self.rfile.read(length) if length else b""

    def json_body(self):
        try:
            value = json.loads(self.body().decode("utf-8") or "{}")
        except ValueError:
            raise FileError("The request wasn't valid JSON.")
        if not isinstance(value, dict):
            raise FileError("The request wasn't valid JSON.")
        return value

    def query(self, name):
        return (parse_qs(urlsplit(self.path).query, keep_blank_values=True).get(name) or [""])[0]

    def handle_any(self, method):
        reason = self.refused()
        if reason:
            return self.reply(403, {"detail": reason})
        path = urlsplit(self.path).path
        files = self.app.files
        try:
            if method == "GET" and path == "/ws" and self.headers.get("Upgrade", "").lower() == "websocket":
                return self.websocket()
            if path == "/api/status" and method == "GET":
                return self.reply(200, self.app.status())
            if path == "/api/files" and method == "GET":
                return self.reply(200, {"files": files.list()})
            if path == "/api/file":
                if method == "GET":
                    return self.reply(200, files.read(self.query("path")))
                body = self.json_body()
                text = body.get("text", "")
                if not isinstance(text, str) or not isinstance(body.get("path"), str):
                    raise FileError("A path and text are needed.")
                if method == "PUT":
                    return self.reply(200, files.write(body["path"], text, base_hash=body.get("base_hash")))
                if method == "POST":
                    return self.reply(200, files.write(body["path"], text, create=True))
            if path == "/api/raw":
                if method == "GET":
                    try:
                        data = files.read_bytes(self.query("path"))
                    except FileError as exc:
                        return self.reply(404 if "doesn't exist" in str(exc) else 400, {"detail": str(exc)})
                    return self.reply(200, data, "application/octet-stream")
                if method == "PUT":
                    return self.reply(200, files.put_bytes(self.query("path"), self.body()))
            if path == "/api/upload" and method == "POST":
                if int(self.headers.get("Content-Length") or 0) > MAX_UPLOAD_BYTES:
                    raise FileError("{} is larger than 25 MB.".format(self.query("path")))
                return self.reply(200, files.add(self.query("path"), self.body()))
            if path == "/api/complete" and method == "POST":
                self.body()
                return self.reply(200, {"items": []})
            if path == "/api/complete/detail" and method == "POST":
                self.body()
                return self.reply(200, {"signature": None, "doc": None})
            if path.startswith("/api/"):
                self.body()
                what = "Environments and packages" if path.startswith(("/api/envs", "/api/packages", "/api/jobs")) else "Some features"
                return self.reply(501, {"detail": needs_full(what), "light": True})
            return self.reply(503, {"detail": "This Tandem runtime serves no UI: the app shows its own."})
        except FileError as exc:
            return self.reply(400, {"detail": str(exc)})

    def do_GET(self):
        self.handle_any("GET")

    def do_PUT(self):
        self.handle_any("PUT")

    def do_POST(self):
        self.handle_any("POST")

    # ---- the WebSocket (RFC 6455), as the runtime's /ws

    def websocket(self):
        key = self.headers.get("Sec-WebSocket-Key", "")
        accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
        self.send_response(101, "Switching Protocols")
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()
        self.wfile.flush()
        self.close_connection = True
        sock = self.connection
        send_lock = threading.Lock()
        open_ = [True]
        mine_terms, mine_runs = set(), set()
        app = self.app

        def send_frame(opcode, payload):
            header = bytes([0x80 | opcode])
            n = len(payload)
            if n < 126:
                header += bytes([n])
            elif n < 65536:
                header += bytes([126]) + struct.pack("!H", n)
            else:
                header += bytes([127]) + struct.pack("!Q", n)
            with send_lock:
                if not open_[0]:
                    return
                try:
                    sock.sendall(header + payload)
                except OSError:
                    open_[0] = False

        def send(event):
            send_frame(0x1, json.dumps(event).encode("utf-8"))

        def read_exact(n):
            data = b""
            while len(data) < n:
                chunk = sock.recv(n - len(data))
                if not chunk:
                    raise ConnectionError
                data += chunk
            return data

        def read_message():
            parts, kind = [], None
            while True:
                b1, b2 = read_exact(2)
                opcode, masked, n = b1 & 0x0F, b2 & 0x80, b2 & 0x7F
                if n == 126:
                    n = struct.unpack("!H", read_exact(2))[0]
                elif n == 127:
                    n = struct.unpack("!Q", read_exact(8))[0]
                if n > MAX_BODY:
                    raise ConnectionError
                mask = read_exact(4) if masked else b"\0\0\0\0"
                payload = bytes(c ^ mask[i % 4] for i, c in enumerate(read_exact(n)))
                if opcode == 0x8:
                    raise ConnectionError
                if opcode == 0x9:
                    send_frame(0xA, payload)
                    continue
                if opcode == 0xA:
                    continue
                if opcode in (0x1, 0x2):
                    kind = opcode
                parts.append(payload)
                if b1 & 0x80:
                    return kind, b"".join(parts)

        def term_ended(term):
            with app.lock:
                if app.terminals.get(term.id) is term:
                    app.terminals.pop(term.id, None)

        def run_ended(run):
            with app.lock:
                if app.run is run:
                    app.run = None

        def on_message(message):
            kind, mid = message.get("type"), str(message.get("id"))
            if kind == "term.start":
                with app.lock:
                    if mid in app.terminals:
                        return send({"type": "term.rejected", "id": mid, "message": "That terminal is already open."})
                    if len(app.terminals) >= MAX_TERMINALS:
                        return send({"type": "term.rejected", "id": mid,
                                     "message": "At most {} terminals can be open.".format(MAX_TERMINALS)})
                python = app.python()[0]
                env, env_name = shell_env(python)
                scratch = Path(tempfile.mkdtemp(prefix="tandem-term-"))
                argv = shell_command(python, env, scratch)
                try:
                    term = Terminal(mid, argv, str(app.files.root), env, message.get("cols") or 80,
                                    message.get("rows") or 24, send,
                                    lambda t: (term_ended(t), shutil.rmtree(str(scratch), ignore_errors=True)))
                except Exception as exc:
                    shutil.rmtree(str(scratch), ignore_errors=True)
                    return send({"type": "term.rejected", "id": mid, "message": "The terminal didn't start: {}".format(exc)})
                with app.lock:
                    app.terminals[mid] = term
                mine_terms.add(mid)
                send({"type": "term.started", "id": mid, "cwd": str(app.files.root), "env": env_name, "shell": argv[0]})
            elif kind in ("term.input", "term.resize", "term.kill"):
                term = app.terminals.get(mid)
                if term is None:
                    return
                if kind == "term.input":
                    term.write(str(message.get("data", "")))
                elif kind == "term.resize":
                    term.resize(message.get("cols") or 80, message.get("rows") or 24)
                else:
                    with app.lock:
                        app.terminals.pop(mid, None)
                    term.kill()
            elif kind == "run.start":
                if (message.get("mode") or "run") != "run":
                    return send({"type": "run.rejected", "id": mid, "message": needs_full("Step through and Debug")})
                if message.get("shared"):
                    return send({"type": "run.rejected", "id": mid, "message": "Shared projects run on this device, not on a server."})
                rel = str(message.get("path", ""))
                try:
                    script = app.files.resolve(rel)
                    if not script.is_file():
                        raise FileError("{} doesn't exist.".format(rel))
                except FileError as exc:
                    return send({"type": "run.rejected", "id": mid, "message": str(exc)})
                python, _source = app.python()
                if python is None:
                    return send({"type": "run.rejected", "id": mid, "message": "There's no python3 on this server to run it with."})
                with app.lock:
                    if app.run is not None:
                        return send({"type": "run.rejected", "id": mid, "message": "{} is still running. Stop it first.".format(app.run.path)})
                    try:
                        app.run = Run(mid, rel, python, script, app.files.root, send, run_ended)
                    except OSError as exc:
                        return send({"type": "run.rejected", "id": mid, "message": "Couldn't start {}: {}".format(python, exc)})
                    mine_runs.add(mid)
                    send({"type": "run.started", "id": mid, "path": rel, "mode": "run", "python": str(python),
                          "cwd": str(app.files.root)})
                    app.run.start()
            elif kind in ("run.stop", "run.input", "run.input-end"):
                run = app.run
                if run is None or run.id != mid or mid not in mine_runs:
                    return
                if kind == "run.stop":
                    run.stop(force=bool(message.get("force")))
                elif kind == "run.input":
                    run.input(str(message.get("text", ""))[:100000])
                else:
                    run.close_input()
            elif kind == "kernel.start":
                send({"type": "kernel.rejected", "id": mid, "message": needs_full("Notebooks"), "code": "light"})
            elif kind == "job.start":
                send({"type": "job.rejected", "id": mid, "message": needs_full("Environments and packages")})

        try:
            while True:
                opcode, payload = read_message()
                if opcode != 0x1:
                    continue
                try:
                    message = json.loads(payload.decode("utf-8"))
                except ValueError:
                    continue
                if isinstance(message, dict):
                    on_message(message)
        except (ConnectionError, OSError, ValueError):
            pass
        finally:
            with send_lock:
                open_[0] = False
            # This window's terminals and run end with it, as in the runtime.
            for term_id in mine_terms:
                with app.lock:
                    term = app.terminals.pop(term_id, None)
                if term:
                    term.kill()
            run = app.run
            if run is not None and run.id in mine_runs:
                run.stop(force=True)


class Server(socketserver.ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def server_bind(self):
        # As HTTPServer's, without its reverse DNS lookup of the address
        # (socket.getfqdn), which can take seconds on some servers.
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]


def main(argv):
    if len(argv) != 2:
        print("usage: python3 lite.py <project folder>", file=sys.stderr)
        return 2
    root = Path(os.path.expanduser(argv[1]))
    if not root.is_dir():
        print("tandem-error There's no folder {} on this server.".format(root), flush=True)
        return 1
    app = App(root, secrets.token_urlsafe(32))
    server = Server(("127.0.0.1", 0), Handler)
    server.app = app
    app.port = server.server_address[1]

    # Stop when the SSH connection that started this closes (its stdin ends).
    def watch_stdin():
        try:
            while sys.stdin.buffer.read(65536):
                pass
        except (OSError, ValueError):
            pass
        app.stop_all()
        time.sleep(0.5)
        os._exit(0)

    threading.Thread(target=watch_stdin, daemon=True).start()
    print("http://127.0.0.1:{}/".format(app.port), flush=True)
    print("token={}".format(app.token), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        app.stop_all()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
