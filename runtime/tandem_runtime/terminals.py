"""Terminals: a shell the person types into (Tandem's Terminal panel).

Each terminal is a real shell in a pseudo-terminal, started in the project
folder with the project's environment first on PATH (as activating it
would), so `python`, `pip` and the project's tools are the ones Tandem runs
with. POSIX uses the standard pty module; Windows uses ConPTY through
pywinpty. The UI is a terminal emulator (xterm.js) on the WebSocket.

Nothing is typed here on anyone's behalf: the assistant never uses these.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import signal
import sys
import tempfile
import threading
from pathlib import Path

MAX_TERMINALS = 8
READ_CHUNK = 65536


class TerminalError(Exception):
    """A readable reason a terminal can't start."""


def environment_dir(python: Path | None) -> Path | None:
    """The environment a project interpreter belongs to (a venv or conda env), if any."""
    if python is None:
        return None
    here = Path(python).parent
    for root in (here.parent, here):  # venv: <env>/bin/python, <env>\Scripts\python.exe; conda on Windows: <env>\python.exe
        if (root / "pyvenv.cfg").is_file() or (root / "conda-meta").is_dir():
            return root
    return None


def shell_env(python: Path | None) -> tuple[dict, str | None]:
    """The shell's environment variables, and the environment's name for the prompt."""
    env = dict(os.environ)
    for key in ("TANDEM_TOKEN", "TANDEM_CONFIG_DIR"):
        env.pop(key, None)
    env["TERM"] = "xterm-256color"
    env.setdefault("COLORTERM", "truecolor")
    if python is None:
        return env, None
    # The project's Python first, whatever it is; an environment also as activating it would.
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


def _q(text: str) -> str:
    """Single-quoted for POSIX shells and PowerShell alike (' doubled differently)."""
    return "'" + text.replace("'", "'\\''") + "'"


def shell_command(python: Path | None, env: dict, scratch: Path) -> list[str]:
    """The shell to start. The project's environment is activated after the
    person's own startup files (which may put other Pythons first), as
    activating it by hand would: PowerShell runs Activate.ps1 after its
    profile; bash and zsh get a startup file that reads theirs first."""
    found = environment_dir(python)
    venv = found if found is not None and (found / "pyvenv.cfg").is_file() else None
    bindir = str(Path(python).parent) if python else None
    if sys.platform == "win32":
        shell = shutil.which("pwsh.exe") or shutil.which("powershell.exe") or "powershell.exe"
        steps = []
        if venv is not None and (venv / "Scripts" / "Activate.ps1").is_file():
            steps.append("& '" + str(venv / "Scripts" / "Activate.ps1").replace("'", "''") + "'")
        elif bindir:
            steps.append("$env:PATH = '" + bindir.replace("'", "''") + ";' + $env:PATH")
            if found is not None:
                tag = f"({found.name}) ".replace("'", "''")
                steps.append("function global:prompt { '" + tag + "PS ' + (Get-Location) + '> ' }")
        return [shell, "-NoLogo", "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", "; ".join(steps) or "$null"]

    shell = os.environ.get("SHELL") or shutil.which("bash") or "/bin/sh"
    name = Path(shell).name
    if venv is not None and (venv / "bin" / "activate").is_file():
        activate = f". {_q(str(venv / 'bin' / 'activate'))}"
    elif bindir:
        activate = f"export PATH={_q(bindir)}:\"$PATH\""
    else:
        activate = ""
    if not activate:
        return [shell, "-i"]
    scratch.mkdir(parents=True, exist_ok=True)
    if name == "bash":
        rc = scratch / "bashrc"
        rc.write_text("[ -f /etc/bash.bashrc ] && . /etc/bash.bashrc\n"
                      "[ -f ~/.bashrc ] && . ~/.bashrc\n"
                      f"{activate}\n", encoding="utf-8")
        return [shell, "--rcfile", str(rc), "-i"]
    if name == "zsh":
        home = env.get("ZDOTDIR") or env.get("HOME") or os.path.expanduser("~")
        (scratch / ".zshenv").write_text(f"[ -f {_q(home + '/.zshenv')} ] && . {_q(home + '/.zshenv')}\n", encoding="utf-8")
        (scratch / ".zshrc").write_text(f"ZDOTDIR={_q(home)}\n"
                                        f"[ -f {_q(home + '/.zshrc')} ] && . {_q(home + '/.zshrc')}\n"
                                        f"{activate}\n", encoding="utf-8")
        env["ZDOTDIR"] = str(scratch)
        return [shell, "-i"]
    return [shell, "-i"]  # other shells: the environment's PATH above


class _PosixTerminal:
    def __init__(self, argv, cwd, env, cols, rows, on_output, on_exit, loop):
        import fcntl
        import pty
        import struct
        import termios

        self._fcntl, self._struct, self._termios = fcntl, struct, termios
        self.master, slave = pty.openpty()
        self._resize(cols, rows)
        import subprocess

        self.proc = subprocess.Popen(argv, stdin=slave, stdout=slave, stderr=slave, cwd=cwd, env=env,
                                     start_new_session=True, close_fds=True)
        os.close(slave)
        self.loop = loop
        self.on_output, self.on_exit = on_output, on_exit
        os.set_blocking(self.master, False)
        loop.add_reader(self.master, self._readable)
        self.closed = False

    def _resize(self, cols, rows):
        size = self._struct.pack("HHHH", max(2, rows), max(2, cols), 0, 0)
        self._fcntl.ioctl(self.master, self._termios.TIOCSWINSZ, size)

    def _readable(self):
        try:
            data = os.read(self.master, READ_CHUNK)
        except BlockingIOError:
            return
        except OSError:
            data = b""
        if data:
            self.on_output(data.decode("utf-8", "replace"))
            return
        self._finish()

    def _finish(self):
        if self.closed:
            return
        self.closed = True
        with _quiet():
            self.loop.remove_reader(self.master)
        with _quiet():
            os.close(self.master)
        code = self.proc.poll()
        if code is None:
            with _quiet():
                self.proc.wait(timeout=0.5)
            code = self.proc.returncode
        self.on_exit(code)

    def write(self, text: str):
        if not self.closed:
            with _quiet():
                os.write(self.master, text.encode("utf-8"))

    def resize(self, cols, rows):
        if not self.closed:
            with _quiet():
                self._resize(cols, rows)

    def kill(self):
        # Hang up, as closing a terminal window does; the shell's end shows
        # as the end of its output. Whatever ignores that goes 2 s later.
        if self.proc.poll() is None:
            with _quiet():
                os.killpg(self.proc.pid, signal.SIGHUP)
            self.loop.call_later(2, self._force)

    def _force(self):
        if self.proc.poll() is None:
            with _quiet():
                os.killpg(self.proc.pid, signal.SIGKILL)


class _WindowsTerminal:
    def __init__(self, argv, cwd, env, cols, rows, on_output, on_exit, loop):
        try:
            from winpty import PtyProcess
        except ImportError as exc:  # pragma: no cover - Windows only
            raise TerminalError(f"The terminal needs pywinpty ({exc}).") from None
        import subprocess

        self.proc = PtyProcess.spawn(subprocess.list2cmdline(argv), cwd=cwd, env=env, dimensions=(max(2, rows), max(2, cols)))
        self.loop = loop
        self.on_output, self.on_exit = on_output, on_exit
        self.closed = False
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self):
        while True:
            try:
                data = self.proc.read(READ_CHUNK)
            except EOFError:
                break
            except Exception:
                break
            if data:
                self.loop.call_soon_threadsafe(self.on_output, data)
            elif not self.proc.isalive():
                break
        self.loop.call_soon_threadsafe(self._finish)

    def _finish(self):
        if self.closed:
            return
        self.closed = True
        code = None
        with _quiet():
            code = self.proc.exitstatus
        self.on_exit(code)

    def write(self, text: str):
        if not self.closed:
            with _quiet():
                self.proc.write(text)

    def resize(self, cols, rows):
        if not self.closed:
            with _quiet():
                self.proc.setwinsize(max(2, rows), max(2, cols))

    def kill(self):
        with _quiet():
            self.proc.terminate(force=True)


class _quiet:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return exc[0] is not None and issubclass(exc[0], Exception)


class TerminalHub:
    """The terminals one runtime has open, by id."""

    def __init__(self):
        self.open: dict[str, object] = {}

    async def start(self, term_id: str, cwd: Path, python: Path | None, cols: int, rows: int, send) -> None:
        if term_id in self.open:
            raise TerminalError("That terminal is already open.")
        if len(self.open) >= MAX_TERMINALS:
            raise TerminalError(f"At most {MAX_TERMINALS} terminals can be open.")
        env, env_name = shell_env(python)
        scratch = Path(tempfile.mkdtemp(prefix="tandem-term-"))
        argv = shell_command(python, env, scratch)
        loop = asyncio.get_running_loop()

        def on_output(text: str):
            loop.create_task(send({"type": "term.output", "id": term_id, "data": text}))

        def on_exit(code):
            if self.open.get(term_id) is term_ref[0]:
                self.open.pop(term_id, None)
            shutil.rmtree(scratch, ignore_errors=True)
            loop.create_task(send({"type": "term.exit", "id": term_id, "code": code}))

        term_ref = [None]
        kind = _WindowsTerminal if sys.platform == "win32" else _PosixTerminal
        try:
            term = term_ref[0] = kind(argv, str(cwd), env, int(cols or 80), int(rows or 24), on_output, on_exit, loop)
        except TerminalError:
            shutil.rmtree(scratch, ignore_errors=True)
            raise
        except Exception as exc:
            shutil.rmtree(scratch, ignore_errors=True)
            raise TerminalError(f"The terminal didn't start: {exc}") from None
        self.open[term_id] = term
        await send({"type": "term.started", "id": term_id, "cwd": str(cwd), "env": env_name, "shell": argv[0]})

    def write(self, term_id: str, text: str) -> None:
        term = self.open.get(term_id)
        if term:
            term.write(text)

    def resize(self, term_id: str, cols: int, rows: int) -> None:
        term = self.open.get(term_id)
        if term:
            term.resize(int(cols), int(rows))

    async def kill(self, term_id: str) -> None:
        term = self.open.pop(term_id, None)
        if term:
            term.kill()  # its end (term.exit) follows when the shell has gone

    async def kill_all(self, ids) -> None:
        for term_id in list(ids):
            await self.kill(term_id)
