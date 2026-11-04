"""Running project scripts as managed child processes."""

from __future__ import annotations

import asyncio
import codecs
import json
import os
import re
import signal
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Awaitable, Callable

from .files import ProjectFiles
from .interpreters import child_env

SUPPORT_DIR = Path(__file__).parent / "support"
WRAPPER = SUPPORT_DIR / "tandem_run.py"
STDERR_TAIL = 64 * 1024

Send = Callable[[dict], Awaitable[None]]

_FRAME = re.compile(r'^\s*File "(?P<file>.+)", line (?P<line>\d+)(?:, in (?P<func>.+))?$')
_EXC = re.compile(r"^(?P<type>[A-Za-z_][\w.]*(?:Error|Exception|Interrupt|Exit|Warning)|[A-Z]\w*Error)(?::\s?(?P<msg>.*))?$")


class RunError(Exception):
    """A run that couldn't start; the message is safe to show."""


def parse_traceback(stderr: str, root: Path) -> dict | None:
    """The error type and message, and the last traceback frame inside the project."""
    lines = stderr.rstrip().splitlines()
    start = max((i for i, l in enumerate(lines) if l.startswith("Traceback (most recent call last)")), default=None)
    if start is None:
        return None
    frame = None
    for line in lines[start:]:
        m = _FRAME.match(line)
        if not m:
            continue
        try:
            rel = Path(m["file"]).resolve().relative_to(root.resolve()).as_posix()
        except ValueError:
            continue  # library code
        frame = {"path": rel, "line": int(m["line"]), "function": (m["func"] or "").strip()}
    last = next((l for l in reversed(lines[start:]) if l and not l.startswith(" ")), "")
    m = _EXC.match(last.strip())
    err_type, message = (m["type"], m["msg"] or "") if m else (last.split(":")[0] or "Error", last)
    return {"type": err_type.split(".")[-1], "message": message.strip(), **(frame or {})}


@dataclass
class Run:
    id: str
    path: str
    proc: asyncio.subprocess.Process
    started: float
    stopping: bool = False
    stderr_tail: str = ""
    tasks: list = field(default_factory=list)


class RunManager:
    """One script run per project at a time (runs would otherwise fight over files and output)."""

    def __init__(self, files: ProjectFiles, interpreter: Callable[[], Path | None]):
        self.files = files
        self.interpreter = interpreter
        self.current: Run | None = None

    async def start(self, run_id: str, path: str, send: Send) -> None:
        if self.current is not None:
            raise RunError(f"{self.current.path} is still running. Stop it before starting another run.")
        script = self.files.resolve(path)
        if not script.is_file() or script.suffix != ".py":
            raise RunError(f"{path} isn't a Python file in this project.")
        python = self.interpreter()
        if python is None:
            raise RunError("No Python interpreter is selected for this project.")

        read_fd, write_fd = os.pipe()
        env = child_env(python, {
            "PYTHONUNBUFFERED": "1",
            "PYTHONIOENCODING": "utf-8",
            "MPLBACKEND": "module://tandem_mpl",
            "PYTHONPATH": os.pathsep.join(filter(None, [str(SUPPORT_DIR), os.environ.get("PYTHONPATH", "")])),
            "TANDEM_EVENT_FD": str(write_fd),
            "TANDEM_WATCH_PARENT": "1",
        })
        try:
            proc = await asyncio.create_subprocess_exec(
                str(python), "-u", str(WRAPPER), str(script),
                cwd=str(self.files.root),
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
                pass_fds=(write_fd,),
                start_new_session=True,  # its own process group, so Stop reaches child processes too
            )
        except OSError as exc:
            os.close(read_fd)
            raise RunError(f"Couldn't start {python}: {exc}") from exc
        finally:
            os.close(write_fd)

        run = Run(id=run_id, path=path, proc=proc, started=time.monotonic())
        self.current = run
        await send({"type": "run.started", "id": run_id, "path": path, "python": str(python), "cwd": str(self.files.root)})
        run.tasks = [
            asyncio.create_task(self._pump(run, proc.stdout, "out", send)),
            asyncio.create_task(self._pump(run, proc.stderr, "err", send)),
            asyncio.create_task(self._events(run, read_fd, send)),
        ]
        asyncio.create_task(self._finish(run, send))

    async def _pump(self, run: Run, stream: asyncio.StreamReader, kind: str, send: Send) -> None:
        # The incremental decoder keeps a UTF-8 character split across reads intact.
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        while True:
            chunk = await stream.read(4096)
            text = decoder.decode(chunk, final=not chunk)
            if kind == "err":
                run.stderr_tail = (run.stderr_tail + text)[-STDERR_TAIL:]
            if text:
                await send({"type": "run.output", "id": run.id, "stream": kind, "text": text})
            if not chunk:
                break

    async def _events(self, run: Run, fd: int, send: Send) -> None:
        loop = asyncio.get_running_loop()
        reader = asyncio.StreamReader(limit=64 * 1024 * 1024)
        transport, _ = await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), os.fdopen(fd, "rb"))
        try:
            while True:
                line = await reader.readline()
                if not line:
                    break
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                kind = event.pop("type", "")
                if kind in {"figure", "figure-error", "variables", "metrics"}:
                    await send({"type": f"run.{kind}", "id": run.id, **event})
        finally:
            transport.close()

    async def _finish(self, run: Run, send: Send) -> None:
        code = await run.proc.wait()
        await asyncio.gather(*run.tasks, return_exceptions=True)
        duration = int((time.monotonic() - run.started) * 1000)
        if run.stopping:
            status = "stopped"
        else:
            status = "success" if code == 0 else "error"
        error = parse_traceback(run.stderr_tail, self.files.root) if status == "error" else None
        self.current = None
        await send({"type": "run.exit", "id": run.id, "status": status, "exit_code": code,
                    "duration_ms": duration, "error": error})

    async def stop(self, run_id: str) -> None:
        """Interrupt, then terminate, then kill the run's whole process group."""
        run = self.current
        if run is None or run.id != run_id or run.proc.returncode is not None:
            return
        run.stopping = True
        for sig, wait in ((signal.SIGINT, 1.5), (signal.SIGTERM, 1.5), (signal.SIGKILL, 5)):
            try:
                os.killpg(run.proc.pid, sig)
            except ProcessLookupError:
                return
            try:
                await asyncio.wait_for(asyncio.shield(run.proc.wait()), wait)
                return
            except asyncio.TimeoutError:
                continue

    async def shutdown(self) -> None:
        if self.current is not None:
            await self.stop(self.current.id)


if sys.platform == "win32":  # pragma: no cover - documented limitation
    raise ImportError("The Tandem runtime currently supports Linux and macOS; Windows process handling is not implemented yet.")
