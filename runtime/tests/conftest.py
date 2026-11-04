import json
import time
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from tandem_runtime.security import AccessPolicy
from tandem_runtime.server import create_app

HERE = Path(__file__).resolve().parent
ENVS = HERE.parent / ".test-envs"
PORT = 8765
TOKEN = "test-token"


def env_python(version: str) -> Path:
    return ENVS / f"py{version.replace('.', '')}" / "bin" / "python"


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
def client(project: Path):
    app = create_app(project, AccessPolicy(token=TOKEN, port=PORT), ui_dir=None)
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
