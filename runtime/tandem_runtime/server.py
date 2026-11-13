"""HTTP + WebSocket server for the Tandem UI."""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import platform
import shutil
from pathlib import Path
from urllib.parse import parse_qs

import anyio
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from pydantic import BaseModel

from . import __version__
from .ai_chat import AssistError, active_provider, assist
from .ai_settings import AISettings, SettingsError, test_connection
from .files import MAX_UPLOAD_BYTES, FileError, ProjectFiles
from . import completion, envs
from .interpreters import describe, resolve_interpreter
from .jobs import JobError, JobManager
from .kernels import KernelError, KernelHub
from .runs import RunError, RunManager
from .security import TOKEN_HEADER, AccessPolicy
from .shared import SharedError, SharedWorkspaces
from .terminals import TerminalError, TerminalHub

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


class CompleteBody(BaseModel):
    path: str = ""
    text: str
    line: int
    column: int
    name: str | None = None


class SelectEnvBody(BaseModel):
    python: str | None = None


class SharedFilesBody(BaseModel):
    files: dict[str, str]


class TrustBody(BaseModel):
    trusted: bool


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
    # Shared projects: their file list, and the owner's shared AI if there is one
    # ({url, apikey, token, project_id}: the cowork-ai Edge Function).
    file_list: list[str] | None = None
    shared_ai: dict | None = None


def create_app(project_root: Path, policy: AccessPolicy, ui_dir: Path | None, cli_python: str | None = None,
               ai_settings: AISettings | None = None, shared_root: Path | None = None) -> FastAPI:
    files = ProjectFiles(project_root)
    ai = ai_settings or AISettings()

    def interpreter():
        return resolve_interpreter(files.root, cli_python)[0]

    runs = RunManager(files, interpreter)
    jobs = JobManager()
    kernels = KernelHub(files.root, interpreter)
    terminals = TerminalHub()
    # Tandem Cowork: working copies of shared projects, each with its own runs
    # and kernels, apart from the project folder above (shared.py).
    shared = SharedWorkspaces(shared_root or (ai.folder / "shared"), cli_python)

    @contextlib.asynccontextmanager
    async def lifespan(_app):
        yield
        await runs.shutdown()
        await jobs.shutdown()
        await kernels.shutdown_all()
        await shared.shutdown()

    app = FastAPI(title="Tandem runtime", version=__version__, docs_url=None, redoc_url=None, openapi_url=None,
                  lifespan=lifespan)
    app.state.files = files
    app.state.runs = runs
    app.state.terminals = terminals
    app.state.shared = shared

    # Environments and packages apply to the device project (scope "project")
    # or to every shared project (scope "shared": one Python for all of them).
    def scope_root(scope: str | None, project: str | None = None) -> Path:
        if scope == "shared":
            if project:
                try:
                    return shared.get(project).root
                except SharedError as exc:
                    raise HTTPException(status_code=400, detail=str(exc)) from None
            shared.root.mkdir(parents=True, exist_ok=True)
            return shared.root
        return files.root

    def scope_python(scope: str | None) -> tuple[Path | None, str]:
        if scope == "shared":
            return shared.interpreter_and_source()
        return resolve_interpreter(files.root, cli_python)

    def scope_settings_root(scope: str | None) -> Path:
        return scope_root(scope) if scope == "shared" else files.root

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
            "shared": {"root": str(shared.root)},
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

    # ---------------- Code completion ----------------
    # Read-only: Jedi reads the code and asks the project's Python about packages.

    @app.post("/api/complete")
    def post_complete(body: CompleteBody):
        if len(body.text) > 2_000_000:
            return {"items": []}
        return completion.complete(files.root, interpreter(), body.path, body.text, body.line, body.column)

    @app.post("/api/complete/detail")
    def post_complete_detail(body: CompleteBody):
        if len(body.text) > 2_000_000 or not body.name:
            return {"signature": None, "doc": None}
        return completion.detail(files.root, interpreter(), body.path, body.text, body.line, body.column, body.name)

    @app.get("/api/raw")
    def get_raw(path: str):
        try:
            data = files.read_bytes(path)
        except FileError as exc:
            raise HTTPException(status_code=404 if "doesn't exist" in str(exc) else 400, detail=str(exc)) from None
        return Response(data, media_type="application/octet-stream", headers={"Cache-Control": "no-store"})

    @app.put("/api/raw")
    async def put_raw(path: str, request: Request):
        data = await request.body()
        try:
            return files.put_bytes(path, data)
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
    def get_envs(refresh: bool = False, scope: str | None = None):
        if refresh:
            envs.interpreters(refresh=True)
        python, source = scope_python(scope)
        return envs.environments(scope_settings_root(scope), python, source)

    @app.put("/api/envs/select")
    def put_env_select(body: SelectEnvBody, scope: str | None = None):
        busy = runs.current is not None if scope != "shared" else any(w.runs.current for w in shared.open.values())
        if busy:
            raise HTTPException(status_code=400, detail="Stop the run before switching environments.")
        try:
            envs.select(scope_settings_root(scope), body.python)
        except envs.EnvError as exc:
            env_error(exc)
        python, source = scope_python(scope)
        return envs.environments(scope_settings_root(scope), python, source)

    # Tandem Cowork: is this computer ready to run shared projects? The app's
    # "Preparing Python" step reads this, then creates Tandem's own
    # environment for shared projects (create-env, scope shared) from `base`
    # and installs `missing` into it (install, scope shared).
    @app.get("/api/shared/python")
    def get_shared_python(refresh: bool = False):
        python, source = shared.interpreter_and_source()
        shared.root.mkdir(parents=True, exist_ok=True)
        own = envs.venv_python(shared.root / ".venv")
        same = lambda a, b: os.path.normcase(os.path.abspath(str(a))) == os.path.normcase(os.path.abspath(str(b)))
        info = describe(python) if python else {"ok": False}
        missing = list(envs.SHARED_PACKAGES)
        if info.get("ok"):
            try:
                names = {p["name"].lower() for p in envs.installed_packages(python)}
                missing = [p for p in envs.SHARED_PACKAGES if p not in names]
            except envs.EnvError:
                pass
        found = envs.interpreters(refresh=refresh)
        return {
            "python": str(python) if python else None,
            "version": info.get("version") if info.get("ok") else None,
            "source": source,
            "own_env": bool(own and python and same(own, python)),
            "packages": list(envs.SHARED_PACKAGES),
            "missing": missing,
            "ready": bool(info.get("ok")) and not missing,
            "base": envs.preferred_base(found),
            "interpreters": found,
        }

    @app.get("/api/packages")
    def get_packages(scope: str | None = None, project: str | None = None):
        python, source = scope_python(scope)
        root = scope_root(scope, project)
        if python is None:
            raise HTTPException(status_code=400, detail="No Python interpreter is selected for this project.")
        can, reason = envs.can_install_into(python)
        out = {"python": {"path": str(python), "source": source}, "can_install": can, "reason": reason,
               "requirements": (root / "requirements.txt").is_file(), "packages": [], "missing": []}
        try:
            out["packages"] = envs.installed_packages(python)
        except envs.EnvError as exc:
            out["error"] = str(exc)
        out["missing"] = envs.missing_imports(root, python)
        return out

    # ---------------- Tandem Cowork: shared projects' working copies ----------------

    def shared_error(exc: Exception):
        raise HTTPException(status_code=400, detail=str(exc))

    @app.put("/api/shared/{project_id}/files")
    def put_shared_files(project_id: str, body: SharedFilesBody):
        try:
            return shared.sync(project_id, body.files)
        except SharedError as exc:
            shared_error(exc)

    @app.post("/api/shared/{project_id}/close")
    async def post_shared_close(project_id: str):
        await shared.close(project_id)
        return {"ok": True}

    @app.get("/api/shared/{project_id}/trust")
    def get_shared_trust(project_id: str):
        return {"trusted": shared.trusted(project_id)}

    @app.put("/api/shared/{project_id}/trust")
    def put_shared_trust(project_id: str, body: TrustBody):
        try:
            shared.set_trusted(project_id, body.trusted)
        except SharedError as exc:
            shared_error(exc)
        return {"trusted": shared.trusted(project_id)}

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

    def ai_environment(shared_scope: bool) -> dict:
        """What the assistant is told about where the code runs (and what it may install)."""
        python, source = scope_python("shared" if shared_scope else None)
        if python is None:
            return {"python": None}
        info = describe(python)
        can, reason = envs.can_install_into(python)
        env = {"python": str(python), "source": source, "version": info.get("version") if info.get("ok") else None,
               "can_install": can, "reason": reason}
        with contextlib.suppress(envs.EnvError):
            env["installed"] = [p["name"] for p in envs.installed_packages(python)]
        if not shared_scope:
            env["missing"] = envs.missing_imports(files.root, python)
        return env

    @app.post("/api/ai/assist")
    def post_ai_assist(body: AssistBody):
        if not body.prompt.strip():
            raise HTTPException(status_code=400, detail="Empty request.")
        request = body.model_dump()
        try:
            request["environment"] = ai_environment(isinstance(body.file_list, list))
        except Exception:  # never in the way of an answer
            request["environment"] = None
        try:
            return assist(ai, files, request)
        except AssistError as exc:
            return {"kind": "error", "text": str(exc)}

    # ---------------- WebSocket: runs ----------------

    def job_plan(message: dict):
        """(kind, command, on_done) for a requested job; raises EnvError with a readable reason."""
        kind = message.get("kind")
        scope = "shared" if message.get("scope") == "shared" else None
        settings_root = scope_settings_root(scope)
        if kind == "create-env":
            base = str(message.get("base") or "")
            command, target = envs.create_command(settings_root, base, str(message.get("name") or ".venv"))

            async def done(job, code):
                if code == 0 and envs.venv_python(target):
                    python = envs.created_python(target)
                    if scope == "shared" or runs.current is None:
                        envs.select(settings_root, str(python))
                    return {"ok": True, "python": str(python), "selected": scope == "shared" or runs.current is None}
                if target.exists():
                    await asyncio.to_thread(shutil.rmtree, target, True)  # a half-made environment
                return {"ok": False, "message": envs.explain_create_failure(job.log, describe(base).get("version"))}

            return kind, command, done
        if kind == "install":
            python, _ = scope_python(scope)
            if python is None:
                raise envs.EnvError("No Python interpreter is selected for this project.")
            if message.get("requirements"):
                req_root = files.root
                if scope == "shared":
                    try:
                        req_root = shared.get(str(message.get("project") or "")).root
                    except SharedError as exc:
                        raise envs.EnvError(str(exc)) from None
                if not (req_root / "requirements.txt").is_file():
                    raise envs.EnvError("This project has no requirements.txt.")
                command = envs.install_command(python, requirements=req_root / "requirements.txt")
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
        return {"kind": kind, "command": command, "cwd": str(scope_settings_root(body.get("scope")))}

    async def start_job(message: dict, send) -> None:
        job_id = str(message.get("id"))
        try:
            kind, command, done = job_plan(message)
            await jobs.start(job_id, kind, command, scope_settings_root(message.get("scope")), send, done)
        except (envs.EnvError, JobError) as exc:
            await send({"type": "job.rejected", "id": job_id, "message": str(exc)})

    async def kernel_command(kind: str, message: dict, send, kernels: KernelHub = kernels) -> None:
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
        my_terms: set[str] = set()
        # Which runs and kernels belong to a shared project's working copy.
        run_owner: dict[str, RunManager] = {}
        kernel_owner: dict[str, KernelHub] = {}

        def workspace_for(message: dict):
            project_id = message.get("shared")
            return shared.get(str(project_id)) if project_id else None

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
                        ws_ = workspace_for(message)
                        manager = ws_.runs if ws_ else runs
                        await manager.start(run_id, str(message.get("path", "")), send,
                                            mode=str(message.get("mode") or "run"),
                                            breakpoints=message.get("breakpoints") if isinstance(message.get("breakpoints"), list) else None)
                        mine.add(run_id)
                        run_owner[run_id] = manager
                    except (RunError, FileError, SharedError) as exc:
                        await send({"type": "run.rejected", "id": run_id, "message": str(exc)})
                elif kind == "run.stop":
                    run_id = str(message.get("id"))
                    await run_owner.get(run_id, runs).stop(run_id, force=bool(message.get("force")))
                elif kind == "run.input" and str(message.get("id")) in mine:
                    run_id = str(message.get("id"))
                    await run_owner.get(run_id, runs).send_input(run_id, str(message.get("text", ""))[:100_000])
                elif kind == "run.input-end" and str(message.get("id")) in mine:
                    run_id = str(message.get("id"))
                    await run_owner.get(run_id, runs).close_input(run_id)
                elif kind == "debug.command" and str(message.get("id")) in mine:
                    run_id = str(message.get("id"))
                    bps = message.get("breakpoints")
                    await run_owner.get(run_id, runs).debug_command(run_id, str(message.get("cmd", "")),
                                                                    bps if isinstance(bps, list) else None)
                elif kind == "kernel.start":
                    kernel_id = str(message.get("id"))
                    try:
                        ws_ = workspace_for(message)
                        hub, where = (ws_.kernels, ws_.files) if ws_ else (kernels, files)
                        path = str(message.get("path", ""))
                        where.resolve(path)
                        await hub.start(kernel_id, path, send)
                        my_kernels.add(kernel_id)
                        kernel_owner[kernel_id] = hub
                    except (KernelError, FileError, SharedError) as exc:
                        await send({"type": "kernel.rejected", "id": kernel_id, "message": str(exc),
                                    "code": getattr(exc, "code", None)})
                elif kind.startswith("kernel.") and str(message.get("id")) in my_kernels:
                    await kernel_command(kind, message, send, kernel_owner.get(str(message.get("id")), kernels))
                elif kind == "term.start":
                    # The Terminal panel: a shell in the project folder (or a
                    # shared project's working copy), its environment on PATH.
                    term_id = str(message.get("id"))
                    try:
                        ws_ = workspace_for(message)
                        cwd = ws_.root if ws_ else files.root
                        python, _ = scope_python("shared" if ws_ else None)
                        await terminals.start(term_id, cwd, python, message.get("cols") or 80, message.get("rows") or 24, send)
                        my_terms.add(term_id)
                    except (TerminalError, SharedError) as exc:
                        await send({"type": "term.rejected", "id": term_id, "message": str(exc)})
                elif kind == "term.input" and str(message.get("id")) in my_terms:
                    terminals.write(str(message.get("id")), str(message.get("data", ""))[:100_000])
                elif kind == "term.resize" and str(message.get("id")) in my_terms:
                    terminals.resize(str(message.get("id")), int(message.get("cols") or 80), int(message.get("rows") or 24))
                elif kind == "term.kill" and str(message.get("id")) in my_terms:
                    await terminals.kill(str(message.get("id")))
                elif kind == "job.start":
                    await start_job(message, send)
                elif kind == "job.cancel":
                    await jobs.cancel(str(message.get("id")))
                elif kind == "ping":
                    await send({"type": "pong"})
        except (WebSocketDisconnect, RuntimeError, ValueError):
            pass
        finally:
            # Shielded: the server may cancel this connection's task as the
            # window goes; the cleanup must still finish, or a run or kernel
            # would be left running with nobody to stop it.
            with anyio.CancelScope(shield=True):
                # A run belongs to the window that started it: don't leave it orphaned.
                for manager in {runs, *run_owner.values()}:
                    if manager.current is not None and manager.current.id in mine:
                        await manager.stop(manager.current.id)
                # So do its notebooks' kernels, and its terminals.
                for hub in {kernels, *kernel_owner.values()}:
                    await hub.shutdown_all(my_kernels)
                await terminals.kill_all(my_terms)

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
