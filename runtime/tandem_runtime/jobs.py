"""Long tasks with a live log: creating an environment, installing packages.

One job at a time. Each runs the exact command the person approved, streams
its output to the window that started it, and can be cancelled. The job ends
with a plain-language explanation when it fails.
"""

from __future__ import annotations

import asyncio
import codecs
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Awaitable, Callable

from .interpreters import child_env
from .procs import ProcessTree, spawn_options

Send = Callable[[dict], Awaitable[None]]


class JobError(Exception):
    pass


@dataclass
class Job:
    id: str
    kind: str
    command: list[str]
    proc: asyncio.subprocess.Process
    tree: ProcessTree
    started: float
    log: str = ""
    cancelled: bool = False
    tasks: list = field(default_factory=list)


class JobManager:
    def __init__(self):
        self.current: Job | None = None

    async def start(self, job_id: str, kind: str, command: list[str], cwd: Path, send: Send,
                    on_done: Callable[[Job, int], Awaitable[dict]]) -> None:
        """Run command; on_done(job, exit code) returns extra fields for the finish event."""
        if self.current is not None:
            raise JobError("Another environment task is still running. Wait for it to finish, or cancel it.")
        python = Path(command[0])
        env = child_env(python, {"PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8", "PIP_NO_INPUT": "1"})
        try:
            proc = await asyncio.create_subprocess_exec(
                *command, cwd=str(cwd), stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, env=env, **spawn_options())
        except OSError as exc:
            raise JobError(f"Couldn't start {command[0]}: {exc}") from exc
        job = Job(id=job_id, kind=kind, command=command, proc=proc, tree=ProcessTree(proc.pid),
                  started=time.monotonic())
        self.current = job
        await send({"type": "job.started", "id": job_id, "kind": kind, "command": command})
        job.tasks = [asyncio.create_task(self._pump(job, send))]
        asyncio.create_task(self._finish(job, send, on_done))

    async def _pump(self, job: Job, send: Send) -> None:
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        while True:
            chunk = await job.proc.stdout.read(4096)
            text = decoder.decode(chunk, final=not chunk)
            if text:
                job.log = (job.log + text)[-200_000:]
                await send({"type": "job.output", "id": job.id, "text": text})
            if not chunk:
                break

    async def _finish(self, job: Job, send: Send, on_done) -> None:
        code = await job.proc.wait()
        await asyncio.gather(*job.tasks, return_exceptions=True)
        job.tree.close()
        extra: dict = {}
        if not job.cancelled:
            try:
                extra = await on_done(job, code)
            except Exception as exc:  # report, don't lose the job
                extra = {"message": str(exc), "ok": False}
        self.current = None
        status = "cancelled" if job.cancelled else ("success" if code == 0 and extra.get("ok", True) else "error")
        await send({"type": "job.finished", "id": job.id, "kind": job.kind, "status": status, "exitCode": code,
                    "durationMs": int((time.monotonic() - job.started) * 1000), **extra})

    async def cancel(self, job_id: str) -> None:
        job = self.current
        if job is None or job.id != job_id:
            return
        job.cancelled = True
        for action, wait in job.tree.steps():
            action()
            try:
                await asyncio.wait_for(job.proc.wait(), wait)
                return
            except asyncio.TimeoutError:
                continue

    async def shutdown(self) -> None:
        if self.current is not None:
            await self.cancel(self.current.id)
