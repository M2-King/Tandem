"""input() with typed lines, and Step through / Debug with the real debugger (bdb)."""

import json
import textwrap
import time

from conftest import PORT, TOKEN, use_python

PRICES = textwrap.dedent('''\
    def average(xs):
        total = sum(xs)
        return total / len(xs)
    prices = [1, 2, 3]
    mean = average(prices)
    print(mean)
''')


class Session:
    """A run over the WebSocket that a test can drive event by event."""

    def __init__(self, ws, run_id="r1"):
        self.ws = ws
        self.id = run_id
        self.events = []

    def send(self, **message):
        self.ws.send_text(json.dumps({"id": self.id, **message}))

    def until(self, kind, timeout=60):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            event = json.loads(self.ws.receive_text())
            self.events.append(event)
            if event["type"] == kind:
                return event
            if event["type"] in ("run.exit", "run.rejected") and kind != event["type"]:
                raise AssertionError(f"run ended while waiting for {kind}: {event}")
        raise AssertionError(f"no {kind} within {timeout}s")

    def output(self):
        return "".join(e["text"] for e in self.events if e["type"] == "run.output" and e["stream"] == "out")


def connect(client):
    return client.websocket_connect(f"ws://127.0.0.1:{PORT}/ws?token={TOKEN}")


def test_input_reads_what_the_person_types(client, project, python):
    use_python(project, python)
    (project / "ask.py").write_text("n = float(input('Your number: '))\nprint(n * 2)\n")
    with connect(client) as ws:
        s = Session(ws)
        s.send(type="run.start", path="ask.py")
        while "Your number: " not in s.output():
            s.until("run.output")
        s.send(type="run.input", text="21")
        exit_ = s.until("run.exit")
    assert exit_["status"] == "success"
    assert s.output() == "Your number: 42.0\n"


def test_ending_input_gives_eoferror(client, project, python):
    use_python(project, python)
    (project / "ask.py").write_text("input('more: ')\n")
    with connect(client) as ws:
        s = Session(ws)
        s.send(type="run.start", path="ask.py")
        s.until("run.output")
        s.send(type="run.input-end")
        exit_ = s.until("run.exit")
    assert exit_["status"] == "error" and exit_["error"]["type"] == "EOFError"


def test_step_through_follows_python(client, project, python):
    use_python(project, python)
    (project / "price_stats.py").write_text(PRICES)
    with connect(client) as ws:
        s = Session(ws)
        s.send(type="run.start", path="price_stats.py", mode="step")
        p = s.until("run.paused")
        assert (p["line"], p["function"], p["locals"]) == (1, "<module>", None)
        s.send(type="debug.command", cmd="next")
        assert s.until("run.paused")["line"] == 4
        s.send(type="debug.command", cmd="next")
        p = s.until("run.paused")
        assert p["line"] == 5
        assert {v["name"]: v["value"] for v in p["globals"]}["prices"] == "[1, 2, 3]"
        # Step into average(): real locals, and the call stack shows both frames.
        s.send(type="debug.command", cmd="step")
        p = s.until("run.paused")
        assert (p["line"], p["function"]) == (2, "average")
        assert {v["name"]: v["value"] for v in p["locals"]} == {"xs": "[1, 2, 3]"}
        assert [f["function"] for f in p["stack"]] == ["average", "<module>"]
        s.send(type="debug.command", cmd="next")
        p = s.until("run.paused")
        assert p["line"] == 3 and {v["name"]: v["value"] for v in p["locals"]}["total"] == "6"
        # Step out: back in the module, after the call.
        s.send(type="debug.command", cmd="out")
        p = s.until("run.paused")
        assert (p["line"], p["function"]) == (6, "<module>")
        assert {v["name"]: v["value"] for v in p["globals"]}["mean"] == "2.0"
        s.send(type="debug.command", cmd="continue")
        exit_ = s.until("run.exit")
    assert exit_["status"] == "success" and s.output() == "2.0\n"


def test_debug_stops_at_breakpoints_only(client, project, python):
    use_python(project, python)
    (project / "price_stats.py").write_text(PRICES)
    with connect(client) as ws:
        s = Session(ws)
        s.send(type="run.start", path="price_stats.py", mode="debug", breakpoints=[{"path": "price_stats.py", "line": 3}])
        p = s.until("run.paused")
        assert (p["line"], p["reason"], p["function"]) == (3, "breakpoint", "average")
        assert {v["name"]: v["value"] for v in p["locals"]}["total"] == "6"
        s.send(type="debug.command", cmd="continue")
        exit_ = s.until("run.exit")
    assert exit_["status"] == "success"
    assert sum(1 for e in s.events if e["type"] == "run.paused") == 1


def test_debug_without_breakpoints_runs_to_the_end(client, project, python):
    use_python(project, python)
    (project / "price_stats.py").write_text(PRICES)
    with connect(client) as ws:
        s = Session(ws)
        s.send(type="run.start", path="price_stats.py", mode="debug", breakpoints=[])
        exit_ = s.until("run.exit")
    assert exit_["status"] == "success" and not any(e["type"] == "run.paused" for e in s.events)


def test_debugger_never_pauses_in_library_code(client, project, python):
    use_python(project, python)
    (project / "lib_use.py").write_text("import json\ndata = json.dumps({'a': 1})\nprint(data)\n")
    with connect(client) as ws:
        s = Session(ws)
        s.send(type="run.start", path="lib_use.py", mode="step")
        lines = []
        while True:
            event = json.loads(ws.receive_text())
            s.events.append(event)
            if event["type"] == "run.paused":
                assert event["path"] == "lib_use.py"
                lines.append(event["line"])
                s.send(type="debug.command", cmd="step")  # step INTO, still never enters json
            if event["type"] == "run.exit":
                break
    assert lines == [1, 2, 3]


def test_stop_while_paused(client, project, python):
    use_python(project, python)
    (project / "price_stats.py").write_text(PRICES)
    with connect(client) as ws:
        s = Session(ws)
        s.send(type="run.start", path="price_stats.py", mode="step")
        s.until("run.paused")
        s.send(type="run.stop")
        exit_ = s.until("run.exit", timeout=15)
    assert exit_["status"] == "stopped"


def test_exceptions_in_debug_runs_show_the_users_traceback(client, project, python):
    use_python(project, python)
    (project / "boom.py").write_text("x = {}\nprint(x['k'])\n")
    with connect(client) as ws:
        s = Session(ws)
        s.send(type="run.start", path="boom.py", mode="debug", breakpoints=[])
        exit_ = s.until("run.exit")
    err = "".join(e["text"] for e in s.events if e["type"] == "run.output" and e["stream"] == "err")
    assert exit_["error"]["type"] == "KeyError" and exit_["error"]["line"] == 2
    assert "bdb.py" not in err and "tandem_run.py" not in err
