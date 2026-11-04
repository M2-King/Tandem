import json
import subprocess
import sys
import time
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from tandem_runtime.ai_settings import AISettings
from tandem_runtime.security import AccessPolicy
from tandem_runtime.server import create_app

HERE = Path(__file__).resolve().parent
ENVS = HERE.parent / ".test-envs"
PORT = 8765
TOKEN = "test-token"


def env_python(version: str) -> Path:
    env = ENVS / f"py{version.replace('.', '')}"
    return env / "Scripts" / "python.exe" if sys.platform == "win32" else env / "bin" / "python"


def pid_alive(pid: int) -> bool:
    """Is the process still running (a zombie counts as gone)?"""
    if sys.platform == "win32":
        import ctypes

        k = ctypes.WinDLL("kernel32", use_last_error=True)
        k.OpenProcess.restype = ctypes.c_void_p
        handle = k.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        code = ctypes.c_ulong()
        k.GetExitCodeProcess(ctypes.c_void_p(handle), ctypes.byref(code))
        k.CloseHandle(ctypes.c_void_p(handle))
        return code.value == 259  # STILL_ACTIVE
    state = subprocess.run(["ps", "-p", str(pid), "-o", "stat="], capture_output=True, text=True).stdout.strip()
    return state != "" and not state.startswith("Z")


@pytest.fixture(autouse=True)
def utf8_test_files(monkeypatch):
    """Test files are written as UTF-8 with \n line endings, as an editor would,
    instead of Windows' default code page and CRLF."""
    original = Path.write_text

    def write_text(self, data, encoding="utf-8", errors=None, newline="\n"):
        return original(self, data, encoding=encoding, errors=errors, newline=newline)

    monkeypatch.setattr(Path, "write_text", write_text)


@pytest.fixture(params=["3.11", "3.12"], ids=["py3.11", "py3.12"])
def python(request) -> Path:
    py = env_python(request.param)
    if not py.exists():
        pytest.skip(f"Python {request.param} test environment not built at {py.parent.parent}")
    return py


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "project"
    root.mkdir()
    return root


def use_python(root: Path, python: Path) -> None:
    (root / ".tandem").mkdir(exist_ok=True)
    (root / ".tandem" / "settings.json").write_text(json.dumps({"python": str(python)}))


@pytest.fixture
def config_dir(tmp_path: Path) -> Path:
    return tmp_path / "config"


@pytest.fixture
def client(project: Path, config_dir: Path):
    app = create_app(project, AccessPolicy(token=TOKEN, port=PORT), ui_dir=None, ai_settings=AISettings(config_dir))
    with TestClient(app, base_url=f"http://127.0.0.1:{PORT}") as c:
        c.headers.update({"x-tandem-token": TOKEN})
        yield c


def run_script(client: TestClient, path: str, *, stop_after_output: bool = False, timeout: float = 120):
    """Start a run over the WebSocket and collect its events until it exits."""
    events = []
    with client.websocket_connect(f"ws://127.0.0.1:{PORT}/ws?token={TOKEN}") as ws:
        ws.send_text(json.dumps({"type": "run.start", "id": "r1", "path": path}))
        deadline = time.monotonic() + timeout
        stop_sent_at = None
        while time.monotonic() < deadline:
            event = json.loads(ws.receive_text())
            events.append(event)
            if event["type"] in ("run.exit", "run.rejected"):
                break
            if stop_after_output and stop_sent_at is None and event["type"] == "run.output":
                ws.send_text(json.dumps({"type": "run.stop", "id": "r1"}))
                stop_sent_at = time.monotonic()
        else:
            raise AssertionError("run did not finish in time")
    return events, stop_sent_at


def output_text(events, stream=None) -> str:
    return "".join(e["text"] for e in events if e["type"] == "run.output" and (stream is None or e["stream"] == stream))


def first(events, kind):
    return next((e for e in events if e["type"] == kind), None)
