"""runtime/remote/lite.py: Tandem on an SSH server without installing anything
(files, the Terminal and Run with the server's own python3, standard library
only). Started as the app starts it, then used through its HTTP API and
WebSocket as the page uses them.

Runs with this Python, and with each in TANDEM_TEST_LITE_PYTHONS (paths,
separated by the OS path separator), e.g. an old python3.8."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="servers are Linux or macOS")

LITE = Path(__file__).resolve().parents[1] / "remote" / "lite.py"
PYTHONS = [sys.executable] + [p for p in os.environ.get("TANDEM_TEST_LITE_PYTHONS", "").split(os.pathsep) if p]


@pytest.fixture(params=PYTHONS, ids=lambda p: Path(p).name)
def lite(request, tmp_path):
    project = tmp_path / "proj"
    project.mkdir()
    (project / "hello.py").write_text('name = input("name? ")\nprint("hi", name)\n')
    proc = subprocess.Popen([request.param, str(LITE), str(project)], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    url = proc.stdout.readline().strip()
    token = proc.stdout.readline().strip().split("=", 1)[1]
    port = int(url.rsplit(":", 1)[1].strip("/"))
    client = httpx.Client(base_url=url, headers={"x-tandem-token": token}, timeout=30)
    yield {"proc": proc, "url": url, "token": token, "port": port, "client": client, "project": project}
    client.close()
    if proc.poll() is None:
        proc.stdin.close()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


def socket(lite):
    from websockets.sync.client import connect

    return connect(f"ws://127.0.0.1:{lite['port']}/ws?token={lite['token']}", open_timeout=10)


def events(ws, until, timeout=30):
    """Events until one matches until(event)."""
    out = []
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        event = json.loads(ws.recv(timeout=max(0.1, deadline - time.monotonic())))
        out.append(event)
        if until(event):
            return out
    raise AssertionError(f"no matching event in {out}")


def test_only_this_host_with_the_token(lite):
    c = lite["client"]
    assert c.get("/api/status", headers={"host": "evil.example"}).status_code == 403
    assert httpx.get(lite["url"] + "api/status").status_code == 403
    assert c.get("/api/status", headers={"origin": "http://evil.example"}).status_code == 403
    status = c.get("/api/status").json()
    assert status["runtime"]["light"] is True
    assert status["python"]["ok"] is True
    assert status["project"]["name"] == "proj"


def test_files(lite):
    c = lite["client"]
    assert [f["path"] for f in c.get("/api/files").json()["files"]] == ["hello.py"]
    made = c.post("/api/file", json={"path": "pkg/new.py", "text": "x = 1\n"}).json()
    assert c.post("/api/file", json={"path": "pkg/new.py", "text": ""}).status_code == 400  # never overwrites
    read = c.get("/api/file", params={"path": "pkg/new.py"}).json()
    assert read["text"] == "x = 1\n" and read["hash"] == made["hash"]
    assert c.put("/api/file", json={"path": "pkg/new.py", "text": "x = 2\n", "base_hash": made["hash"]}).status_code == 200
    stale = c.put("/api/file", json={"path": "pkg/new.py", "text": "x = 3\n", "base_hash": made["hash"]})
    assert stale.status_code == 400 and "changed on disk" in stale.json()["detail"]
    assert c.get("/api/file", params={"path": "../outside.txt"}).status_code == 400
    assert c.get("/api/raw", params={"path": "missing.db"}).status_code == 404
    assert c.put("/api/raw", params={"path": "data.db"}, content=b"\x00\x01").status_code == 200
    assert c.get("/api/raw", params={"path": "data.db"}).content == b"\x00\x01"
    assert c.post("/api/upload", params={"path": "a b%.txt"}, content=b"hey").status_code == 200
    assert (lite["project"] / "a b%.txt").read_bytes() == b"hey"
    assert c.post("/api/complete", json={"text": "x", "line": 1, "column": 1}).json() == {"items": []}
    envs = c.get("/api/envs")
    assert envs.status_code == 501 and "full tools" in envs.json()["detail"]


def test_run_with_input_and_errors_and_stop(lite):
    (lite["project"] / "bad.py").write_text("x = 1\nraise ValueError('nope')\n")
    (lite["project"] / "slow.py").write_text("import time\nprint('start', flush=True)\ntime.sleep(60)\n")
    with socket(lite) as ws:
        ws.send(json.dumps({"type": "run.start", "id": "r1", "path": "hello.py", "mode": "run"}))
        got = events(ws, lambda e: e["type"] == "run.output" and "name?" in e.get("text", ""))
        assert got[0]["type"] == "run.started"
        ws.send(json.dumps({"type": "run.input", "id": "r1", "text": "Ada"}))
        got = events(ws, lambda e: e["type"] == "run.exit")
        assert "hi Ada" in "".join(e.get("text", "") for e in got)
        assert got[-1]["status"] == "success" and got[-1]["exit_code"] == 0

        ws.send(json.dumps({"type": "run.start", "id": "r2", "path": "bad.py", "mode": "run"}))
        end = events(ws, lambda e: e["type"] == "run.exit")[-1]
        assert end["status"] == "error"
        assert end["error"] == {"type": "ValueError", "message": "nope", "path": "bad.py", "line": 2}

        ws.send(json.dumps({"type": "run.start", "id": "r3", "path": "slow.py", "mode": "run"}))
        events(ws, lambda e: e["type"] == "run.output" and "start" in e.get("text", ""))
        ws.send(json.dumps({"type": "run.start", "id": "r4", "path": "hello.py", "mode": "run"}))
        assert "still running" in events(ws, lambda e: e["id"] == "r4")[-1]["message"]
        ws.send(json.dumps({"type": "run.stop", "id": "r3"}))
        assert events(ws, lambda e: e["type"] == "run.exit")[-1]["status"] == "stopped"

        ws.send(json.dumps({"type": "run.start", "id": "r5", "path": "hello.py", "mode": "debug"}))
        assert "full tools" in events(ws, lambda e: e["id"] == "r5")[-1]["message"]
        ws.send(json.dumps({"type": "kernel.start", "id": "k1", "path": "n.ipynb"}))
        rejected = events(ws, lambda e: e["id"] == "k1")[-1]
        assert rejected["type"] == "kernel.rejected" and rejected["code"] == "light"


def test_terminal(lite):
    with socket(lite) as ws:
        ws.send(json.dumps({"type": "term.start", "id": "t1", "cols": 100, "rows": 30}))
        started = events(ws, lambda e: e["type"] == "term.started")[-1]
        assert started["cwd"] == str(lite["project"].resolve())
        ws.send(json.dumps({"type": "term.input", "id": "t1", "data": "echo hi-$((40+2)) && pwd\n"}))
        events(ws, lambda e: e["type"] == "term.output" and "hi-42" in e["data"])
        ws.send(json.dumps({"type": "term.kill", "id": "t1"}))
        events(ws, lambda e: e["type"] == "term.exit")


def test_stops_when_the_connection_closes(lite):
    proc = lite["proc"]
    with socket(lite) as ws:
        ws.send(json.dumps({"type": "term.start", "id": "t1", "cols": 80, "rows": 24}))
        events(ws, lambda e: e["type"] == "term.started")
        proc.stdin.close()
        assert proc.wait(timeout=10) == 0
