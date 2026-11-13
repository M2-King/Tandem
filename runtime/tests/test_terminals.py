"""The Terminal panel: a real shell in the project folder, with the project's environment first on PATH."""

import json
import re
import subprocess
import sys
import time
from pathlib import Path

from conftest import PORT, TOKEN, use_python

WIN = sys.platform == "win32"


ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[=>]")


def plain(text: str) -> str:
    """Terminal output without its escape sequences (ConPTY adds many)."""
    return ANSI.sub("", text).replace("\r", "")


def collect_until(ws, test, timeout=60):
    """Events until test(all output so far) is true (or the terminal ends)."""
    out, events = "", []
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        event = json.loads(ws.receive_text())
        events.append(event)
        if event["type"] == "term.output":
            out += event["data"]
        if event["type"] in ("term.rejected", "term.exit") or test(plain(out)):
            return plain(out), events
    raise AssertionError(f"timed out; output so far:\n{out[-2000:]}")


def test_a_terminal_runs_in_the_project_with_its_environment(client, project):
    env = project / ".venv"
    subprocess.run([sys.executable, "-m", "venv", "--without-pip", str(env)], check=True)
    python = env / ("Scripts/python.exe" if WIN else "bin/python")
    use_python(project, python)
    (project / "hello.py").write_text("import sys\nprint('PREFIX=' + sys.prefix)\n")
    with client.websocket_connect(f"ws://127.0.0.1:{PORT}/ws?token={TOKEN}") as ws:
        ws.send_text(json.dumps({"type": "term.start", "id": "t1", "cols": 100, "rows": 30}))
        started = json.loads(ws.receive_text())
        assert started["type"] == "term.started" and started["env"] == ".venv", started
        assert started["cwd"] == str(project)
        # `python` is the project's, and the shell starts in the project folder.
        ws.send_text(json.dumps({"type": "term.input", "id": "t1", "data": "python hello.py\r"}))
        out, _ = collect_until(ws, lambda o: re.search(r"^PREFIX=.*\n", o, re.M) is not None)
        line = next(l for l in out.splitlines() if l.startswith("PREFIX="))
        assert line.strip().lower() == ("PREFIX=" + str(env)).lower()
        ws.send_text(json.dumps({"type": "term.resize", "id": "t1", "cols": 120, "rows": 40}))
        ws.send_text(json.dumps({"type": "term.kill", "id": "t1"}))
        _, events = collect_until(ws, lambda o: False)
        assert events[-1]["type"] == "term.exit"


def test_a_terminal_ends_with_its_window_and_only_its_window_can_type_in_it(client, project):
    with client.websocket_connect(f"ws://127.0.0.1:{PORT}/ws?token={TOKEN}") as ws:
        ws.send_text(json.dumps({"type": "term.start", "id": "t2"}))
        started = json.loads(ws.receive_text())
        assert started["type"] == "term.started", started
        with client.websocket_connect(f"ws://127.0.0.1:{PORT}/ws?token={TOKEN}") as other:
            other.send_text(json.dumps({"type": "term.input", "id": "t2", "data": "echo SNEAKY\r"}))
            other.send_text(json.dumps({"type": "ping"}))
            assert json.loads(other.receive_text())["type"] == "pong"
        ws.send_text(json.dumps({"type": "term.input", "id": "t2", "data": "echo MINE\r"}))
        out, _ = collect_until(ws, lambda o: "MINE" in o.split("echo MINE")[-1])
        assert "SNEAKY" not in out
    # The window closed: its terminal is gone (a new window can't type in it either).
    with client.websocket_connect(f"ws://127.0.0.1:{PORT}/ws?token={TOKEN}") as ws:
        ws.send_text(json.dumps({"type": "term.start", "id": "t2"}))  # the id is free again
        assert json.loads(ws.receive_text())["type"] == "term.started"


def test_the_environment_stays_first_after_the_persons_own_startup_files(client, project, tmp_path, monkeypatch):
    import shutil

    import pytest

    bash = shutil.which("bash")
    if WIN or not bash:
        pytest.skip("bash startup files (POSIX)")
    env = project / ".venv"
    subprocess.run([sys.executable, "-m", "venv", "--without-pip", str(env)], check=True)
    use_python(project, env / "bin" / "python")
    home = tmp_path / "home"
    home.mkdir()
    # Like `pyenv init` or a conda block in ~/.bashrc: another Python first.
    (home / ".bashrc").write_text(f'export PATH="{Path(sys.executable).parent}:$PATH"\nexport FROM_BASHRC=yes\n')
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("SHELL", bash)
    with client.websocket_connect(f"ws://127.0.0.1:{PORT}/ws?token={TOKEN}") as ws:
        ws.send_text(json.dumps({"type": "term.start", "id": "t3"}))
        assert json.loads(ws.receive_text())["type"] == "term.started"
        ws.send_text(json.dumps({"type": "term.input", "id": "t3",
                                 "data": "echo RC=$FROM_BASHRC; python -c \"import sys; print('PREFIX=' + sys.prefix)\"\r"}))
        out, _ = collect_until(ws, lambda o: re.search(r"^PREFIX=.*\n", o, re.M) is not None)
        assert "RC=yes" in out  # their startup file ran
        assert next(l for l in out.splitlines() if l.startswith("PREFIX=")).strip() == f"PREFIX={env}"  # and the project's Python is first
        assert "(.venv)" in out  # activated, so the prompt says so
