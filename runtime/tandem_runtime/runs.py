"""Running project scripts as managed child processes."""

from __future__ import annotations

import asyncio
import codecs
import hmac
import json
import os
import re
import secrets
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Awaitable, Callable

from .files import FileError, ProjectFiles
from .interpreters import child_env
from .procs import ProcessTree, spawn_options, wrapper_env

SUPPORT_DIR = Path(__file__).parent / "support"
WRAPPER = SUPPORT_DIR / "tandem_run.py"
STDERR_TAIL = 64 * 1024

Send = Callable[[dict], Awaitable[None]]

_FRAME = re.compile(r'^\s*File "(?P<file>.+)", line (?P<line>\d+)(?:, in (?P<func>.+))?$')
_EXC = re.compile(r"^(?P<type>[A-Za-z_][\w.]*(?:Error|Exception|Interrupt|Exit|Warning)|[A-Z]\w*Error)(?::\s?(?P<msg>.*))?$")


OUTPUT_RATE = 400_000  # characters a second forwarded per stream, at most
OUTPUT_WINDOW = 0.25  # seconds
TAIL_CHARS = 4000  # the end of skipped output, shown when the program finishes


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
    tree: ProcessTree
    events: "EventChannel"
    mode: str = "run"
    stopping: bool = False
    stderr_tail: str = ""
    tasks: list = field(default_factory=list)


class EventChannel:
    """Loopback socket the wrapper reports figures, variables and metrics on.

    Only a connection that first sends this run's random key is accepted, and
    only one; the listener closes as soon as the wrapper is connected.
    """

    def __init__(self):
        self.key = secrets.token_hex(16)
        self.server: asyncio.base_events.Server | None = None
        self.address = ""
        self.done = asyncio.Event()
        self._claimed = False
        self._on_event = None
        self.writer: asyncio.StreamWriter | None = None

    async def open(self, on_event) -> None:
        self._on_event = on_event
        self.server = await asyncio.start_server(self._handle, "127.0.0.1", 0, limit=64 * 1024 * 1024)
        host, port = self.server.sockets[0].getsockname()[:2]
        self.address = f"{host}:{port}"

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            try:
                first = await asyncio.wait_for(reader.readline(), 5)
            except asyncio.TimeoutError:
                return
            if self._claimed or not hmac.compare_digest(first.strip(), self.key.encode()):
                return
            self._claimed = True
            self.writer = writer
            self.close_listener()
            while True:
                line = await reader.readline()
                if not line:
                    break
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                await self._on_event(event)
        except (ConnectionError, asyncio.LimitOverrunError, ValueError):
            pass
        finally:
            writer.close()
            if self._claimed:
                self.done.set()

    async def send(self, message: dict) -> bool:
        """A command to the script (debug runs). False if it isn't connected."""
        if self.writer is None or self.writer.is_closing():
            return False
        try:
            self.writer.write((json.dumps(message) + "\n").encode("utf-8"))
            await self.writer.drain()
            return True
        except (ConnectionError, OSError):
            return False

    def close_listener(self) -> None:
        if self.server is not None:
            self.server.close()
            self.server = None

    async def finish(self, timeout: float = 3) -> None:
        """After the process exits: wait briefly for the last events, then close."""
        if self._claimed:
            try:
                await asyncio.wait_for(self.done.wait(), timeout)
            except asyncio.TimeoutError:
                pass
        self.close_listener()


class RunManager:
    """One script run per project at a time (runs would otherwise fight over files and output)."""

    def __init__(self, files: ProjectFiles, interpreter: Callable[[], Path | None]):
        self.files = files
        self.interpreter = interpreter
        self.current: Run | None = None

    async def start(self, run_id: str, path: str, send: Send, mode: str = "run",
                    breakpoints: list | None = None) -> None:
        if self.current is not None:
            raise RunError(f"{self.current.path} is still running. Stop it before starting another run.")
        script = self.files.resolve(path)
        if not script.is_file() or script.suffix != ".py":
            raise RunError(f"{path} isn't a Python file in this project.")
        python = self.interpreter()
        if python is None:
            raise RunError("No Python interpreter is selected for this project.")
        if mode not in ("run", "step", "debug"):
            raise RunError("Unknown run mode.")
        points = []
        for bp in breakpoints or []:
            try:
                points.append([str(self.files.resolve(str(bp["path"]))), int(bp["line"])])
            except (FileError, KeyError, TypeError, ValueError):
                continue

        run_box: dict = {}

        async def on_event(event: dict):
            kind = event.pop("type", "")
            if kind in {"figure", "figure-error", "variables", "metrics", "paused", "resumed"} and "run" in run_box:
                await send({"type": f"run.{kind}", "id": run_box["run"].id, **event})

        channel = EventChannel()
        await channel.open(on_event)
        env = child_env(python, {
            "PYTHONUNBUFFERED": "1",
            "PYTHONIOENCODING": "utf-8",
            "MPLBACKEND": "module://tandem_mpl",
            "PYTHONPATH": os.pathsep.join(filter(None, [str(SUPPORT_DIR), os.environ.get("PYTHONPATH", "")])),
            "TANDEM_EVENT_ADDR": channel.address,
            "TANDEM_EVENT_KEY": channel.key,
            "TANDEM_PROJECT_ROOT": str(self.files.root),
            **({"TANDEM_DEBUG": mode, "TANDEM_BREAKPOINTS": json.dumps(points)} if mode != "run" else {}),
            **wrapper_env(),
        })
        try:
            proc = await asyncio.create_subprocess_exec(
                str(python), "-u", str(WRAPPER), str(script),
                cwd=str(self.files.root),
                stdin=asyncio.subprocess.PIPE,  # input() reads what the person types in Tandem
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
                **spawn_options(),  # its own process group / job, so Stop reaches child processes too
            )
        except OSError as exc:
            channel.close_listener()
            raise RunError(f"Couldn't start {python}: {exc}") from exc

        run = Run(id=run_id, path=path, proc=proc, started=time.monotonic(), tree=ProcessTree(proc.pid),
                  events=channel, mode=mode)
        run_box["run"] = run
        self.current = run
        await send({"type": "run.started", "id": run_id, "path": path, "mode": mode, "python": str(python),
                    "cwd": str(self.files.root)})
        run.tasks = [
            asyncio.create_task(self._pump(run, proc.stdout, "out", send)),
            asyncio.create_task(self._pump(run, proc.stderr, "err", send)),
        ]
        asyncio.create_task(self._finish(run, send))

    async def _pump(self, run: Run, stream: asyncio.StreamReader, kind: str, send: Send) -> None:
        # The incremental decoder keeps a UTF-8 character split across reads intact.
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        # A program printing in a tight loop makes far more output than anyone
        # can read: forward at most OUTPUT_RATE characters a second and say how
        # much was skipped, so the window stays responsive and Stop is quick.
        window_start, budget, skipped, tail = time.monotonic(), int(OUTPUT_RATE * OUTPUT_WINDOW), 0, ""
        while True:
            chunk = await stream.read(65536)  # big reads: fewer messages when a program prints a lot
            text = decoder.decode(chunk, final=not chunk)
            if kind == "err":
                run.stderr_tail = (run.stderr_tail + text)[-STDERR_TAIL:]
            if text and run.stopping:
                text = ""  # stopping: the rest is not shown
            if text:
                now = time.monotonic()
                if now - window_start >= OUTPUT_WINDOW:
                    window_start, budget = now, int(OUTPUT_RATE * OUTPUT_WINDOW)
                if len(text) > budget:
                    cut = max(budget, 0)
                    skipped += len(text) - cut
                    tail = (tail + text[cut:])[-TAIL_CHARS:]  # the end is always shown
                    text = text[:cut]
                budget -= len(text)
                if skipped and text and budget > 0:
                    text = f"\n… {skipped:,} characters of output skipped (the program prints faster than it can be shown) …\n" + text
                    skipped, tail = 0, ""
                if text:
                    await send({"type": "run.output", "id": run.id, "stream": kind, "text": text})
            if not chunk:
                break
        if skipped and not run.stopping:
            # The program ended while output was being skipped: show how it ended.
            last = tail[tail.find("\n") + 1:] if "\n" in tail[:-1] else tail
            await send({"type": "run.output", "id": run.id, "stream": kind,
                        "text": f"\n… {skipped - len(last):,} characters of output skipped …\n{last}"})

    async def _finish(self, run: Run, send: Send) -> None:
        code = await run.proc.wait()
        await asyncio.gather(*run.tasks, return_exceptions=True)
        await run.events.finish()
        run.tree.close()
        duration = int((time.monotonic() - run.started) * 1000)
        if run.stopping:
            status = "stopped"
        else:
            status = "success" if code == 0 else "error"
        error = parse_traceback(run.stderr_tail, self.files.root) if status == "error" else None
        self.current = None
        await send({"type": "run.exit", "id": run.id, "status": status, "exit_code": code,
                    "duration_ms": duration, "error": error})

    async def stop(self, run_id: str, force: bool = False) -> None:
        """Interrupt, then terminate, the run's whole process tree. force: end it
        at once (the last, unconditional step), without asking it to stop."""
        run = self.current
        if run is None or run.id != run_id or run.proc.returncode is not None:
            return
        run.stopping = True
        steps = run.tree.steps()
        for action, wait in steps[-1:] if force else steps:
            if not action():
                return
            try:
                await asyncio.wait_for(asyncio.shield(run.proc.wait()), wait)
                return
            except asyncio.TimeoutError:
                continue

    def _current(self, run_id: str) -> Run | None:
        run = self.current
        return run if run is not None and run.id == run_id and run.proc.returncode is None else None

    async def send_input(self, run_id: str, text: str) -> bool:
        """A line the person typed, for input() (or anything reading stdin)."""
        run = self._current(run_id)
        if run is None or run.proc.stdin is None or run.proc.stdin.is_closing():
            return False
        try:
            run.proc.stdin.write((text + "\n").encode("utf-8"))
            await run.proc.stdin.drain()
            return True
        except (ConnectionError, OSError):
            return False

    async def close_input(self, run_id: str) -> None:
        """End of input (like Ctrl+D / Ctrl+Z in a terminal)."""
        run = self._current(run_id)
        if run is not None and run.proc.stdin is not None and not run.proc.stdin.is_closing():
            run.proc.stdin.close()

    async def debug_command(self, run_id: str, cmd: str, breakpoints: list | None = None) -> bool:
        """next / step / out / continue for a paused Step-through or Debug run."""
        run = self._current(run_id)
        if run is None or run.mode == "run":
            return False
        if cmd == "breakpoints":
            points = []
            for bp in breakpoints or []:
                try:
                    points.append([str(self.files.resolve(str(bp["path"]))), int(bp["line"])])
                except (FileError, KeyError, TypeError, ValueError):
                    continue
            return await run.events.send({"cmd": "breakpoints", "list": points})
        if cmd not in ("next", "step", "out", "continue"):
            return False
        return await run.events.send({"cmd": cmd})

    async def shutdown(self) -> None:
        if self.current is not None:
            await self.stop(self.current.id)

