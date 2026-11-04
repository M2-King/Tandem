"""HTTP + WebSocket server for the Tandem UI."""

from __future__ import annotations

import asyncio
import contextlib
import json
import platform
from pathlib import Path
from urllib.parse import parse_qs

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from pydantic import BaseModel

from . import __version__
from .files import FileError, ProjectFiles
from .interpreters import describe, resolve_interpreter
from .runs import RunError, RunManager
from .security import TOKEN_HEADER, AccessPolicy

CONFIG_TAG_ID = "tandem-runtime"


class SecurityMiddleware:
    """Host check on everything; token and Origin checks on the API and WebSocket."""

    def __init__(self, app, policy: AccessPolicy):
        self.app = app
        self.policy = policy

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        path = scope.get("path", "")
        protected = path.startswith("/api/") or path == "/ws"
        reason = None
        if not self.policy.host_ok(headers.get("host")):
            reason = "Unexpected host"
        elif protected and not self.policy.origin_ok(headers.get("origin")):
            reason = "Origin not allowed"
        elif protected:
            presented = headers.get(TOKEN_HEADER)
            if presented is None and scope["type"] == "websocket":
                presented = (parse_qs(scope.get("query_string", b"").decode()).get("token") or [None])[0]
            if not self.policy.token_ok(presented):
                reason = "Missing or wrong session token"
        if reason is None:
            return await self.app(scope, receive, send)
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 4403, "reason": reason})
            return
        response = JSONResponse({"detail": reason}, status_code=403)
        await response(scope, receive, send)


class WriteBody(BaseModel):
    path: str
    text: str
    base_hash: str | None = None


class CreateBody(BaseModel):
    path: str
    text: str = ""


def create_app(project_root: Path, policy: AccessPolicy, ui_dir: Path | None, cli_python: str | None = None) -> FastAPI:
    files = ProjectFiles(project_root)

    def interpreter():
        return resolve_interpreter(files.root, cli_python)[0]

    runs = RunManager(files, interpreter)

    @contextlib.asynccontextmanager
    async def lifespan(_app):
        yield
        await runs.shutdown()

    app = FastAPI(title="Tandem runtime", version=__version__, docs_url=None, redoc_url=None, openapi_url=None,
                  lifespan=lifespan)
    app.state.files = files
    app.state.runs = runs

    # ---------------- API ----------------

    @app.get("/api/status")
    def status():
        python, source = resolve_interpreter(files.root, cli_python)
        info = describe(python) if python else {"ok": False, "error": "No Python interpreter found."}
        return {
            "runtime": {"version": __version__, "platform": platform.system()},
            "project": {"root": str(files.root), "name": files.root.name},
            "python": {**info, "source": source},
            "busy": runs.current.path if runs.current else None,
        }

    def file_error(exc: FileError):
        raise HTTPException(status_code=400, detail=str(exc))

    @app.get("/api/files")
    def list_files():
        return {"files": files.list()}

    @app.get("/api/file")
    def read_file(path: str):
        try:
            return files.read(path)
        except FileError as exc:
            file_error(exc)

    @app.put("/api/file")
    def write_file(body: WriteBody):
        try:
            return files.write(body.path, body.text, base_hash=body.base_hash)
        except FileError as exc:
            file_error(exc)

    @app.post("/api/file")
    def create_file(body: CreateBody):
        try:
            return files.write(body.path, body.text, create=True)
        except FileError as exc:
            file_error(exc)

    # ---------------- WebSocket: runs ----------------

    @app.websocket("/ws")
    async def ws(socket: WebSocket):
        await socket.accept()
        lock = asyncio.Lock()
        mine: set[str] = set()

        async def send(event: dict):
            async with lock:
                with contextlib.suppress(RuntimeError, WebSocketDisconnect):
                    await socket.send_text(json.dumps(event))

        try:
            while True:
                message = json.loads(await socket.receive_text())
                kind = message.get("type")
                if kind == "run.start":
                    run_id = str(message.get("id"))
                    try:
                        await runs.start(run_id, str(message.get("path", "")), send)
                        mine.add(run_id)
                    except (RunError, FileError) as exc:
                        await send({"type": "run.rejected", "id": run_id, "message": str(exc)})
                elif kind == "run.stop":
                    await runs.stop(str(message.get("id")))
                elif kind == "ping":
                    await send({"type": "pong"})
        except (WebSocketDisconnect, RuntimeError, ValueError):
            pass
        finally:
            # A run belongs to the window that started it: don't leave it orphaned.
            if runs.current is not None and runs.current.id in mine:
                await runs.stop(runs.current.id)

    # ---------------- UI ----------------

    def index_html() -> Response:
        if ui_dir is None or not (ui_dir / "index.html").exists():
            return HTMLResponse(
                "<!doctype html><title>Tandem runtime</title><p>The Tandem UI isn't built yet. "
                "Run <code>npm run build</code> in the Tandem folder, then reload.</p>",
                status_code=503,
            )
        html = (ui_dir / "index.html").read_text(encoding="utf-8")
        config = json.dumps({"mode": "local", "token": policy.token, "version": __version__}).replace("</", "<\\/")
        tag = f'<script id="{CONFIG_TAG_ID}" type="application/json">{config}</script>'
        html = html.replace("</head>", tag + "</head>", 1)
        return HTMLResponse(html, headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"})

    @app.get("/{rest:path}")
    def ui(rest: str, request: Request):
        if ui_dir is not None and rest:
            candidate = (ui_dir / rest).resolve()
            if candidate.is_file() and ui_dir.resolve() in candidate.parents:
                return FileResponse(candidate)
        return index_html()

    return SecurityMiddleware(app, policy)
