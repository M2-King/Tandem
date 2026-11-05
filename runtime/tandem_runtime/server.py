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
from .ai_chat import AssistError, active_provider, assist
from .ai_settings import AISettings, SettingsError, test_connection
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


class AISettingsBody(BaseModel):
    provider: str
    model: str | None = None
    base_url: str | None = None
    api_key: str | None = None
    clear_key: bool = False
    activate: bool | None = None


class AITestBody(BaseModel):
    provider: str


class AssistBody(BaseModel):
    prompt: str
    intent: str = "chat"
    context: list[dict] = []
    files: dict[str, str] = {}
    active_path: str | None = None
    last_run: dict | None = None
    history: list[dict] = []


def create_app(project_root: Path, policy: AccessPolicy, ui_dir: Path | None, cli_python: str | None = None,
               ai_settings: AISettings | None = None) -> FastAPI:
    files = ProjectFiles(project_root)
    ai = ai_settings or AISettings()

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

    # ---------------- AI provider settings ----------------
    # Keys go in, never out: responses only say whether a key is saved.

    @app.get("/api/ai/settings")
    def get_ai_settings():
        return ai.public()

    @app.put("/api/ai/settings")
    def put_ai_settings(body: AISettingsBody):
        try:
            return ai.update(body.provider, model=body.model, base_url=body.base_url, api_key=body.api_key,
                             clear_key=body.clear_key, activate=body.activate)
        except SettingsError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None

    @app.post("/api/ai/test")
    def post_ai_test(body: AITestBody):
        try:
            return test_connection(ai, body.provider)
        except SettingsError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None

    @app.get("/api/ai/active")
    def get_ai_active():
        return {"active": active_provider(ai)}

    @app.post("/api/ai/assist")
    def post_ai_assist(body: AssistBody):
        if not body.prompt.strip():
            raise HTTPException(status_code=400, detail="Empty request.")
        try:
            return assist(ai, files, body.model_dump())
        except AssistError as exc:
            return {"kind": "error", "text": str(exc)}

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
                        await runs.start(run_id, str(message.get("path", "")), send,
                                         mode=str(message.get("mode") or "run"),
                                         breakpoints=message.get("breakpoints") if isinstance(message.get("breakpoints"), list) else None)
                        mine.add(run_id)
                    except (RunError, FileError) as exc:
                        await send({"type": "run.rejected", "id": run_id, "message": str(exc)})
                elif kind == "run.stop":
                    await runs.stop(str(message.get("id")))
                elif kind == "run.input" and str(message.get("id")) in mine:
                    await runs.send_input(str(message.get("id")), str(message.get("text", ""))[:100_000])
                elif kind == "run.input-end" and str(message.get("id")) in mine:
                    await runs.close_input(str(message.get("id")))
                elif kind == "debug.command" and str(message.get("id")) in mine:
                    bps = message.get("breakpoints")
                    await runs.debug_command(str(message.get("id")), str(message.get("cmd", "")),
                                             bps if isinstance(bps, list) else None)
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
