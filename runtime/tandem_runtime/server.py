"""HTTP + WebSocket server for the Tandem UI."""

from __future__ import annotations

import asyncio
import contextlib
import json
import platform
import shutil
from pathlib import Path
from urllib.parse import parse_qs

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from pydantic import BaseModel

from . import __version__
from .ai_chat import AssistError, active_provider, assist
from .ai_settings import AISettings, SettingsError, test_connection
from .files import MAX_UPLOAD_BYTES, FileError, ProjectFiles
from . import envs
from .interpreters import describe, resolve_interpreter
from .jobs import JobError, JobManager
from .kernels import KernelError, KernelHub
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


class SelectEnvBody(BaseModel):
    python: str | None = None


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
    jobs = JobManager()
    kernels = KernelHub(files.root, interpreter)

    @contextlib.asynccontextmanager
    async def lifespan(_app):
        yield
        await runs.shutdown()
        await jobs.shutdown()
        await kernels.shutdown_all()

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

    @app.post("/api/upload")
    async def upload_file(path: str, request: Request):
        # Files added from elsewhere (Add files…, drag and drop), as raw bytes.
        if int(request.headers.get("content-length") or 0) > MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=400, detail=f"{path} is larger than 25 MB.")
        data = await request.body()
        try:
            return files.add(path, data)
        except FileError as exc:
            file_error(exc)

    # ---------------- Environments and packages ----------------
    # Reading is free; creating environments and installing packages run as
    # jobs over the WebSocket, only after the person confirms the command.

    def env_error(exc: Exception):
        raise HTTPException(status_code=400, detail=str(exc))

    @app.get("/api/envs")
    def get_envs(refresh: bool = False):
        if refresh:
            envs.interpreters(refresh=True)
        python, source = resolve_interpreter(files.root, cli_python)
        return envs.environments(files.root, python, source)

    @app.put("/api/envs/select")
    def put_env_select(body: SelectEnvBody):
        if runs.current is not None:
            raise HTTPException(status_code=400, detail="Stop the run before switching environments.")
        try:
            envs.select(files.root, body.python)
        except envs.EnvError as exc:
            env_error(exc)
        python, source = resolve_interpreter(files.root, cli_python)
        return envs.environments(files.root, python, source)

    @app.get("/api/packages")
    def get_packages():
        python, source = resolve_interpreter(files.root, cli_python)
        if python is None:
            raise HTTPException(status_code=400, detail="No Python interpreter is selected for this project.")
        can, reason = envs.can_install_into(python)
        out = {"python": {"path": str(python), "source": source}, "can_install": can, "reason": reason,
               "requirements": (files.root / "requirements.txt").is_file(), "packages": [], "missing": []}
        try:
            out["packages"] = envs.installed_packages(python)
        except envs.EnvError as exc:
            out["error"] = str(exc)
        out["missing"] = envs.missing_imports(files.root, python)
        return out

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

    def job_plan(message: dict):
        """(kind, command, on_done) for a requested job; raises EnvError with a readable reason."""
        kind = message.get("kind")
        if kind == "create-env":
            base = str(message.get("base") or "")
            command, target = envs.create_command(files.root, base, str(message.get("name") or ".venv"))

            async def done(job, code):
                if code == 0 and envs.venv_python(target):
                    python = envs.created_python(target)
                    if runs.current is None:
                        envs.select(files.root, str(python))
                    return {"ok": True, "python": str(python), "selected": runs.current is None}
                if target.exists():
                    await asyncio.to_thread(shutil.rmtree, target, True)  # a half-made environment
                return {"ok": False, "message": envs.explain_create_failure(job.log, describe(base).get("version"))}

            return kind, command, done
        if kind == "install":
            python, _ = resolve_interpreter(files.root, cli_python)
            if python is None:
                raise envs.EnvError("No Python interpreter is selected for this project.")
            if message.get("requirements"):
                if not (files.root / "requirements.txt").is_file():
                    raise envs.EnvError("This project has no requirements.txt.")
                command = envs.install_command(python, requirements=files.root / "requirements.txt")
            else:
                packages = message.get("packages")
                command = envs.install_command(python, packages if isinstance(packages, list) else [])

            async def done(job, code):
                if code == 0:
                    return {"ok": True}
                return {"ok": False, "message": envs.explain_install_failure(job.log)}

            return kind, command, done
        raise envs.EnvError("Unknown task.")

    @app.post("/api/jobs/preview")
    def preview_job(body: dict):
        # The exact command a job would run, shown to the person before they confirm it.
        try:
            kind, command, _ = job_plan(body)
        except envs.EnvError as exc:
            env_error(exc)
        return {"kind": kind, "command": command, "cwd": str(files.root)}

    async def start_job(message: dict, send) -> None:
        job_id = str(message.get("id"))
        try:
            kind, command, done = job_plan(message)
            await jobs.start(job_id, kind, command, files.root, send, done)
        except (envs.EnvError, JobError) as exc:
            await send({"type": "job.rejected", "id": job_id, "message": str(exc)})

    async def kernel_command(kind: str, message: dict, send) -> None:
        kernel_id = str(message.get("id"))
        try:
            if kind == "kernel.execute":
                kernels.execute(kernel_id, str(message.get("cell", "")), str(message.get("code", ""))[:2_000_000])
            elif kind == "kernel.input":
                kernels.send_input(kernel_id, str(message.get("text", ""))[:100_000])
            elif kind == "kernel.interrupt":
                await kernels.interrupt(kernel_id)
            elif kind == "kernel.restart":
                await kernels.restart(kernel_id)
            elif kind == "kernel.shutdown":
                await kernels.shutdown(kernel_id)
                await send({"type": "kernel.status", "id": kernel_id, "state": "shutdown"})
        except KernelError as exc:
            await send({"type": "kernel.error", "id": kernel_id, "message": str(exc)})
        except Exception as exc:  # a kernel that died mid-command
            await send({"type": "kernel.error", "id": kernel_id, "message": f"The kernel didn't respond: {exc}"})

    @app.websocket("/ws")
    async def ws(socket: WebSocket):
        await socket.accept()
        lock = asyncio.Lock()
        mine: set[str] = set()
        my_kernels: set[str] = set()

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
                elif kind == "kernel.start":
                    kernel_id = str(message.get("id"))
                    try:
                        path = str(message.get("path", ""))
                        files.resolve(path)
                        await kernels.start(kernel_id, path, send)
                        my_kernels.add(kernel_id)
                    except (KernelError, FileError) as exc:
                        await send({"type": "kernel.rejected", "id": kernel_id, "message": str(exc),
                                    "code": getattr(exc, "code", None)})
                elif kind.startswith("kernel.") and str(message.get("id")) in my_kernels:
                    await kernel_command(kind, message, send)
                elif kind == "job.start":
                    await start_job(message, send)
                elif kind == "job.cancel":
                    await jobs.cancel(str(message.get("id")))
                elif kind == "ping":
                    await send({"type": "pong"})
        except (WebSocketDisconnect, RuntimeError, ValueError):
            pass
        finally:
            # A run belongs to the window that started it: don't leave it orphaned.
            if runs.current is not None and runs.current.id in mine:
                await runs.stop(runs.current.id)
            # So do its notebooks' kernels.
            await kernels.shutdown_all(my_kernels)

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
