"""Jupyter kernels for notebooks.

Each open notebook gets a real IPython kernel (ipykernel) running in the
project's selected environment, started and driven with jupyter_client. The
kernel listens on 127.0.0.1 only; its connection file (which holds the
signing key) is in a private temporary folder. Messages are relayed to the
window that started the kernel:

  kernel.status   starting | idle | busy | restarting | dead
  kernel.output   one nbformat output (stream, display_data, execute_result, error)
  kernel.clear    clear_output for a cell
  kernel.input    the code asked for input()
  kernel.done     a cell finished: ok | error | aborted, with its execution count

Outputs are in nbformat's own shape, so the notebook stores exactly what the
kernel sent.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Awaitable, Callable

from .interpreters import child_env

Send = Callable[[dict], Awaitable[None]]
MAX_KERNELS = 8
STREAM_RATE = 400_000  # characters a second of printed output, at most
STREAM_WINDOW = 0.25


class KernelError(Exception):
    def __init__(self, message: str, code: str | None = None):
        super().__init__(message)
        self.code = code


def has_ipykernel(python: Path) -> bool:
    flags = {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)} if sys.platform == "win32" else {}
    try:
        out = subprocess.run([str(python), "-c", "import ipykernel"], capture_output=True, timeout=30, **flags)
        return out.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def direct_python(python: Path) -> tuple[Path, dict]:
    """The interpreter to start for a kernel, and extra environment.

    On Windows a virtual environment's python.exe is a small launcher that
    starts the real Python as a child process. Stopping the kernel would then
    end only the launcher and leave the kernel running. So the real Python is
    started directly, with __PYVENV_LAUNCHER__ set as the launcher sets it:
    Python then runs in the environment exactly as through the launcher.
    """
    if sys.platform != "win32":
        return python, {}
    cfg = python.parent.parent / "pyvenv.cfg"
    if not cfg.is_file():
        return python, {}
    values = {}
    for line in cfg.read_text(encoding="utf-8", errors="replace").splitlines():
        key, sep, value = line.partition("=")
        if sep:
            values[key.strip().lower()] = value.strip()
    candidates = [values.get("executable"), values.get("home") and str(Path(values["home"]) / "python.exe")]
    for base in filter(None, candidates):
        if Path(base).is_file() and Path(base).name.lower() == "python.exe":
            return Path(base), {"__PYVENV_LAUNCHER__": str(python)}
    return python, {}


@dataclass
class Kernel:
    id: str
    path: str
    python: str
    send: Send
    km: object
    kc: object
    folder: str
    pending: dict = field(default_factory=dict)  # msg_id -> cell id
    replies: dict = field(default_factory=dict)  # msg_id -> execute_reply content
    idle: set = field(default_factory=set)  # msg_ids whose output has all arrived
    tasks: list = field(default_factory=list)
    closing: bool = False
    restarting: bool = False
    window_start: float = 0.0
    budget: int = 0
    skipped: int = 0
    ready: asyncio.Event = field(default_factory=asyncio.Event)
    heard: asyncio.Event = field(default_factory=asyncio.Event)  # an iopub message arrived


class KernelHub:
    def __init__(self, root: Path, interpreter: Callable[[], Path | None]):
        self.root = root
        self.interpreter = interpreter
        self.kernels: dict[str, Kernel] = {}

    async def start(self, kernel_id: str, path: str, send: Send) -> None:
        from jupyter_client.kernelspec import KernelSpec
        from jupyter_client.manager import AsyncKernelManager

        if kernel_id in self.kernels:
            raise KernelError("This kernel is already running.")
        if len(self.kernels) >= MAX_KERNELS:
            raise KernelError(f"At most {MAX_KERNELS} notebooks can have a running kernel. Close one first.")
        python = self.interpreter()
        if python is None:
            raise KernelError("No Python interpreter is selected for this project.")
        if not await asyncio.to_thread(has_ipykernel, python):
            raise KernelError(
                "This environment doesn't have ipykernel, the Jupyter kernel for Python. Install it (Packages…), "
                "then run the cell again.", code="missing-ipykernel")
        await send({"type": "kernel.status", "id": kernel_id, "state": "starting", "python": str(python)})
        direct, launcher_env = direct_python(python)
        folder = tempfile.mkdtemp(prefix="tandem-kernel-")  # 0700: the connection file holds the signing key
        # POSIX: Unix sockets inside the private folder. Windows: TCP on 127.0.0.1;
        # every message is signed with the key in the connection file.
        if sys.platform == "win32":
            km = AsyncKernelManager(connection_file=os.path.join(folder, "kernel.json"), ip="127.0.0.1", transport="tcp")
        else:
            km = AsyncKernelManager(connection_file=os.path.join(folder, "kernel.json"), ip=os.path.join(folder, "k"),
                                    transport="ipc")
        km._kernel_spec = KernelSpec(
            argv=[str(direct), "-m", "ipykernel_launcher", "-f", "{connection_file}"],
            display_name="Python 3 (ipykernel)", language="python", env={})
        env = child_env(python, {"PYTHONIOENCODING": "utf-8", "PYDEVD_DISABLE_FILE_VALIDATION": "1", **launcher_env})
        env.pop("MPLBACKEND", None)  # ipykernel shows matplotlib figures inline by itself
        try:
            await km.start_kernel(env=env, cwd=str(self.root))
            kc = km.client()
            kc.start_channels()
            await kc.wait_for_ready(timeout=90)
        except Exception as exc:
            with contextlib.suppress(Exception):
                await km.shutdown_kernel(now=True)
            shutil.rmtree(folder, ignore_errors=True)
            raise KernelError(f"The kernel didn't start: {exc}") from None
        kernel = Kernel(id=kernel_id, path=path, python=str(python), send=send, km=km, kc=kc, folder=folder)
        self.kernels[kernel_id] = kernel
        kernel.tasks = [asyncio.create_task(self._iopub(kernel)), asyncio.create_task(self._shell(kernel)),
                        asyncio.create_task(self._stdin(kernel)), asyncio.create_task(self._watch(kernel))]
        await send({"type": "kernel.status", "id": kernel_id, "state": "idle", "python": str(python)})

    # ---------------------------------------------------------- relays
    async def _iopub(self, k: Kernel) -> None:
        while True:
            try:
                msg = await k.kc.get_iopub_msg()
            except (asyncio.CancelledError, GeneratorExit):
                raise
            except Exception:
                if k.closing:
                    return
                await asyncio.sleep(0.05)
                continue
            k.heard.set()
            kind, content = msg["msg_type"], msg["content"]
            cell = k.pending.get(msg.get("parent_header", {}).get("msg_id"))
            if kind == "status":
                await k.send({"type": "kernel.status", "id": k.id, "state": content.get("execution_state"), "cell": cell})
                parent = msg.get("parent_header", {}).get("msg_id")
                if cell is not None and content.get("execution_state") == "idle":
                    k.idle.add(parent)
                    await self._maybe_done(k, parent)
                continue
            if cell is None:
                continue
            if kind == "execute_input":
                await k.send({"type": "kernel.count", "id": k.id, "cell": cell, "count": content.get("execution_count")})
            elif kind == "stream":
                text = self._throttle(k, content.get("text", ""))
                if text:
                    await k.send({"type": "kernel.output", "id": k.id, "cell": cell,
                                  "output": {"output_type": "stream", "name": content.get("name", "stdout"),
                                             "text": text}})
            elif kind in ("display_data", "execute_result"):
                output = {"output_type": kind, "data": content.get("data", {}), "metadata": content.get("metadata", {})}
                if kind == "execute_result":
                    output["execution_count"] = content.get("execution_count")
                await k.send({"type": "kernel.output", "id": k.id, "cell": cell, "output": output})
            elif kind == "error":
                await k.send({"type": "kernel.output", "id": k.id, "cell": cell,
                              "output": {"output_type": "error", "ename": content.get("ename", ""),
                                         "evalue": content.get("evalue", ""),
                                         "traceback": content.get("traceback", [])}})
            elif kind == "clear_output":
                await k.send({"type": "kernel.clear", "id": k.id, "cell": cell, "wait": bool(content.get("wait"))})

    @staticmethod
    def _throttle(k: Kernel, text: str) -> str:
        # A cell printing in a tight loop: forward at most STREAM_RATE characters
        # a second and say how much was skipped, so the notebook stays usable.
        now = time.monotonic()
        if now - k.window_start >= STREAM_WINDOW:
            k.window_start, k.budget = now, int(STREAM_RATE * STREAM_WINDOW)
        if len(text) > k.budget:
            k.skipped += len(text) - max(k.budget, 0)
            text = text[: max(k.budget, 0)]
        k.budget -= len(text)
        if k.skipped and text and k.budget > 0:
            text = f"\n… {k.skipped:,} characters of output skipped (printed faster than they can be shown) …\n" + text
            k.skipped = 0
        return text

    async def _shell(self, k: Kernel) -> None:
        while True:
            try:
                msg = await k.kc.get_shell_msg()
            except (asyncio.CancelledError, GeneratorExit):
                raise
            except Exception:
                if k.closing:
                    return
                await asyncio.sleep(0.05)
                continue
            if msg["msg_type"] == "kernel_info_reply":
                k.ready.set()
                continue
            if msg["msg_type"] != "execute_reply":
                continue
            parent = msg.get("parent_header", {}).get("msg_id")
            if parent in k.pending:
                k.replies[parent] = msg["content"]
                await self._maybe_done(k, parent)
                if parent in k.pending:
                    asyncio.create_task(self._done_soon(k, parent))

    async def _done_soon(self, k: Kernel, msg_id: str) -> None:
        # Safety net: if the kernel's "idle" for this cell never arrives (the
        # output connection was still reconnecting), the cell is done anyway.
        await asyncio.sleep(1.0)
        if msg_id in k.pending and msg_id in k.replies:
            k.idle.add(msg_id)
            await self._maybe_done(k, msg_id)

    async def _maybe_done(self, k: Kernel, msg_id: str) -> None:
        # Reply (shell) and output (iopub) come on different channels, in any
        # order: a cell is done once it has replied and the kernel went idle
        # for it, so no output arriving late is lost.
        if msg_id not in k.replies or msg_id not in k.idle:
            return
        cell = k.pending.pop(msg_id, None)
        content = k.replies.pop(msg_id)
        k.idle.discard(msg_id)
        if cell is not None:
            await k.send({"type": "kernel.done", "id": k.id, "cell": cell, "status": content.get("status", "ok"),
                          "count": content.get("execution_count")})

    async def _stdin(self, k: Kernel) -> None:
        while True:
            try:
                msg = await k.kc.get_stdin_msg()
            except (asyncio.CancelledError, GeneratorExit):
                raise
            except Exception:
                if k.closing:
                    return
                await asyncio.sleep(0.05)
                continue
            if msg["msg_type"] == "input_request":
                cell = k.pending.get(msg.get("parent_header", {}).get("msg_id"))
                await k.send({"type": "kernel.input", "id": k.id, "cell": cell,
                              "prompt": msg["content"].get("prompt", ""), "password": msg["content"].get("password", False)})

    async def _watch(self, k: Kernel) -> None:
        while not k.closing:
            await asyncio.sleep(1.5)
            if not k.closing and not k.restarting and not await k.km.is_alive():
                await self._abort_pending(k)
                await k.send({"type": "kernel.status", "id": k.id, "state": "dead"})
                return

    async def _abort_pending(self, k: Kernel) -> None:
        for cell in list(k.pending.values()):
            await k.send({"type": "kernel.done", "id": k.id, "cell": cell, "status": "aborted", "count": None})
        k.pending.clear()
        k.replies.clear()
        k.idle.clear()

    # ---------------------------------------------------------- commands
    def _get(self, kernel_id: str) -> Kernel:
        k = self.kernels.get(kernel_id)
        if k is None:
            raise KernelError("That kernel isn't running. Run the cell again to start it.")
        return k

    def execute(self, kernel_id: str, cell: str, code: str) -> None:
        k = self._get(kernel_id)
        msg_id = k.kc.execute(code, allow_stdin=True, stop_on_error=True)
        k.pending[msg_id] = cell

    def send_input(self, kernel_id: str, text: str) -> None:
        self._get(kernel_id).kc.input(text)

    async def interrupt(self, kernel_id: str) -> None:
        await self._get(kernel_id).km.interrupt_kernel()

    async def restart(self, kernel_id: str) -> None:
        k = self._get(kernel_id)
        await k.send({"type": "kernel.status", "id": k.id, "state": "restarting"})
        await self._abort_pending(k)
        k.restarting = True
        try:
            await k.km.restart_kernel(now=True)
            # The shell relay reads every reply, so readiness is its signal:
            # ask for kernel_info until the new kernel answers.
            # Ready = the new kernel answers on the shell channel *and* its
            # output (iopub) reaches us again, so no output is lost.
            k.ready.clear()
            k.heard.clear()
            deadline = asyncio.get_running_loop().time() + 90
            while not (k.ready.is_set() and k.heard.is_set()):
                if asyncio.get_running_loop().time() > deadline:
                    raise KernelError("The kernel didn't come back after the restart.")
                k.kc.kernel_info()
                with contextlib.suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(asyncio.gather(k.ready.wait(), k.heard.wait()), 1.0)
        finally:
            k.restarting = False
        await k.send({"type": "kernel.status", "id": k.id, "state": "idle", "restarted": True})

    async def shutdown(self, kernel_id: str) -> None:
        k = self.kernels.pop(kernel_id, None)
        if k is None:
            return
        k.closing = True
        for task in k.tasks:
            task.cancel()
        await asyncio.gather(*k.tasks, return_exceptions=True)
        with contextlib.suppress(Exception):
            k.kc.stop_channels()
        with contextlib.suppress(Exception):
            await k.km.shutdown_kernel(now=True)
        shutil.rmtree(k.folder, ignore_errors=True)

    async def shutdown_all(self, ids: set[str] | None = None) -> None:
        for kernel_id in list(self.kernels):
            if ids is None or kernel_id in ids:
                await self.shutdown(kernel_id)
