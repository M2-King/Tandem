"""Notebook kernels: real ipykernel in the project's environment."""

import json
import re
import time
from pathlib import Path

import pytest

from conftest import PORT, TOKEN, use_python


class Session:
    """A WebSocket session that drives one kernel."""

    def __init__(self, ws, kernel_id="k1"):
        self.ws = ws
        self.id = kernel_id
        self.events = []

    def send(self, kind, **fields):
        self.ws.send_text(json.dumps({"type": kind, "id": self.id, **fields}))

    def until(self, predicate, timeout=120):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            event = json.loads(self.ws.receive_text())
            self.events.append(event)
            if predicate(event):
                return event
        raise AssertionError(f"timed out; last events: {self.events[-5:]}")

    def start(self, path="nb.ipynb"):
        self.send("kernel.start", path=path)
        return self.until(lambda e: (e["type"] == "kernel.status" and e["state"] == "idle") or e["type"] == "kernel.rejected")

    def run(self, cell, code, timeout=120):
        """Execute a cell; returns (outputs, done event)."""
        start = len(self.events)
        self.send("kernel.execute", cell=cell, code=code)
        done = self.until(lambda e: e["type"] == "kernel.done" and e["cell"] == cell, timeout)
        outputs = [e["output"] for e in self.events[start:] if e["type"] == "kernel.output" and e["cell"] == cell]
        return outputs, done


def text_of(outputs):
    parts = []
    for o in outputs:
        if o["output_type"] == "stream":
            parts.append(o["text"])
        elif o["output_type"] in ("execute_result", "display_data"):
            parts.append(o["data"].get("text/plain", ""))
        elif o["output_type"] == "error":
            parts.append(f"{o['ename']}: {o['evalue']}")
    return "".join(parts)


@pytest.fixture
def session(client, project, python):
    use_python(project, python)
    with client.websocket_connect(f"ws://127.0.0.1:{PORT}/ws?token={TOKEN}") as ws:
        s = Session(ws)
        started = s.start()
        if started["type"] == "kernel.rejected":
            pytest.skip(f"kernel didn't start: {started['message']}")
        yield s
        s.send("kernel.shutdown")
        s.until(lambda e: e["type"] == "kernel.status" and e["state"] == "shutdown", 30)


def test_two_cells_share_state_and_restart_clears_it(session):
    outputs, done = session.run("c1", "x = 10")
    assert done["status"] == "ok" and outputs == []
    outputs, done = session.run("c2", "print(x * 2.0)")
    assert text_of(outputs) == "20.0\n" and done["count"] == 2

    session.send("kernel.restart")
    session.until(lambda e: e["type"] == "kernel.status" and e.get("restarted"))
    outputs, done = session.run("c2", "print(x * 2.0)")
    assert done["status"] == "error" and outputs[0]["ename"] == "NameError" and done["count"] == 1

    session.run("c1", "x = 10")
    outputs, done = session.run("c2", "print(x * 2.0)")
    assert text_of(outputs) == "20.0\n"


def test_results_tables_and_charts(session):
    outputs, _ = session.run("a", "1 + 1")
    assert outputs == [{"output_type": "execute_result", "data": {"text/plain": "2"}, "metadata": {}, "execution_count": 1}]
    outputs, _ = session.run("b", "import pandas as pd\npd.DataFrame({'x': [1, 2]})")
    assert "<table" in outputs[0]["data"]["text/html"]
    outputs, _ = session.run("c", "import matplotlib.pyplot as plt\nplt.plot([1, 2, 3])\nplt.show()")
    images = [o for o in outputs if o["output_type"] == "display_data" and "image/png" in o["data"]]
    assert len(images) == 1 and len(images[0]["data"]["image/png"]) > 1000


def test_errors_carry_the_traceback(session):
    outputs, done = session.run("e", "def f():\n    return 1 / 0\nf()")
    assert done["status"] == "error"
    error = outputs[-1]
    plain = re.sub(r"\x1b\[[0-9;]*m", "", "\n".join(error["traceback"]))  # Jupyter colours tracebacks
    assert error["ename"] == "ZeroDivisionError" and "return 1 / 0" in plain


def test_input_is_asked_for_and_answered(session):
    session.send("kernel.execute", cell="i", code="name = input('Name? ')\nprint('hi', name)")
    request = session.until(lambda e: e["type"] == "kernel.input")
    assert request["prompt"] == "Name? " and request["cell"] == "i"
    session.send("kernel.input", text="Ada")
    session.until(lambda e: e["type"] == "kernel.done" and e["cell"] == "i")
    assert "hi Ada" in text_of([e["output"] for e in session.events if e["type"] == "kernel.output"])


def test_interrupt_stops_a_long_cell(session):
    session.send("kernel.execute", cell="slow", code="import time\nfor _ in range(600):\n    time.sleep(0.1)")
    session.until(lambda e: e["type"] == "kernel.status" and e["state"] == "busy" and e.get("cell") == "slow")
    time.sleep(0.5)
    t0 = time.monotonic()
    session.send("kernel.interrupt")
    done = session.until(lambda e: e["type"] == "kernel.done" and e["cell"] == "slow", 30)
    assert done["status"] == "error" and time.monotonic() - t0 < 10
    errors = [e["output"] for e in session.events if e["type"] == "kernel.output" and e["output"]["output_type"] == "error"]
    assert errors[-1]["ename"] == "KeyboardInterrupt"
    outputs, done = session.run("after", "print('still alive')")
    assert text_of(outputs) == "still alive\n"


def test_cells_run_in_the_project_folder(session, project):
    (project / "data.csv").write_text("a\n1\n")
    outputs, _ = session.run("cwd", "import os\nprint(sorted(os.listdir('.')))")
    assert "data.csv" in text_of(outputs)


def test_missing_ipykernel_is_explained(client, project):
    from test_envs import base_of

    base = base_of("3.12")
    if base is None:
        pytest.skip("no Python 3.12 test environment")
    use_python(project, Path(base))  # a Python without ipykernel
    with client.websocket_connect(f"ws://127.0.0.1:{PORT}/ws?token={TOKEN}") as ws:
        s = Session(ws)
        started = s.start()
    if started["type"] == "kernel.status":
        pytest.skip("this Python happens to have ipykernel")
    assert started["code"] == "missing-ipykernel" and "ipykernel" in started["message"]


def test_kernel_ends_with_the_window(client, project, python):
    use_python(project, python)
    with client.websocket_connect(f"ws://127.0.0.1:{PORT}/ws?token={TOKEN}") as ws:
        s = Session(ws)
        assert s.start()["type"] == "kernel.status"
        outputs, _ = s.run("pid", "import os\nprint(os.getpid())")
        pid = int(text_of(outputs))
    from conftest import pid_alive

    deadline = time.monotonic() + 15
    while pid_alive(pid) and time.monotonic() < deadline:
        time.sleep(0.2)
    assert not pid_alive(pid), "the kernel should stop when its window goes away"


def test_commands_for_someone_elses_kernel_are_ignored(client, project, python):
    use_python(project, python)
    with client.websocket_connect(f"ws://127.0.0.1:{PORT}/ws?token={TOKEN}") as a, \
            client.websocket_connect(f"ws://127.0.0.1:{PORT}/ws?token={TOKEN}") as b:
        sa = Session(a)
        assert sa.start()["type"] == "kernel.status"
        b.send_text(json.dumps({"type": "kernel.execute", "id": "k1", "cell": "x", "code": "print('intruder')"}))
        outputs, _ = sa.run("own", "print('mine')")
        assert text_of(outputs) == "mine\n"
        assert not any(e["type"] == "kernel.output" and e["cell"] == "x" for e in sa.events)
