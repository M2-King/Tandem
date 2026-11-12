"""Tandem Cowork: shared projects run from a working copy on this computer."""

import json
import time
from pathlib import Path

import pytest

from conftest import PORT, TOKEN, first, output_text

PID = "0b9c7a52-6f1e-4c55-9d1a-2c3e4f5a6b7c"
OTHER = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f"


def shared_root(config_dir: Path) -> Path:
    return config_dir / "shared"


def use_shared_python(config_dir: Path, python: Path) -> None:
    settings = shared_root(config_dir) / ".tandem" / "settings.json"
    settings.parent.mkdir(parents=True, exist_ok=True)
    settings.write_text(json.dumps({"python": str(python)}))


def sync(client, files: dict, project: str = PID):
    r = client.put(f"/api/shared/{project}/files", json={"files": files})
    assert r.status_code == 200, r.text
    return r.json()


def run_shared(client, path: str, project: str = PID, timeout: float = 120):
    events = []
    with client.websocket_connect(f"ws://127.0.0.1:{PORT}/ws?token={TOKEN}") as ws:
        ws.send_text(json.dumps({"type": "run.start", "id": "s1", "path": path, "shared": project}))
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            event = json.loads(ws.receive_text())
            events.append(event)
            if event["type"] in ("run.exit", "run.rejected"):
                return events
    raise AssertionError("run did not finish in time")


def test_working_copy_runs_a_script_that_imports_another_project_file(client, project, config_dir, python):
    use_shared_python(config_dir, python)
    (project / "helpers.py").write_text("WHERE = 'device project'\n")  # must not be the one imported
    result = sync(client, {
        "main.py": "import os\nfrom helpers import greet\nfrom pkg.util import double\n"
                   "print(greet('team'), double(21))\nprint(os.getcwd())\n"
                   "open('result.csv', 'w').write('a,b\\n1,2\\n')\n",
        "helpers.py": "def greet(who):\n    return f'hello {who}'\n",
        "pkg/__init__.py": "",
        "pkg/util.py": "def double(x):\n    return 2 * x\n",
    })
    root = shared_root(config_dir).resolve() / PID
    assert Path(result["root"]) == root
    assert sorted(result["written"]) == ["helpers.py", "main.py", "pkg/__init__.py", "pkg/util.py"]

    events = run_shared(client, "main.py")
    exit_ = first(events, "run.exit")
    assert exit_ and exit_["status"] == "success", output_text(events)
    lines = output_text(events, "out").splitlines()
    assert lines[0] == "hello team 42"
    assert Path(lines[1]).resolve() == root  # runs inside the working copy
    assert Path(first(events, "run.started")["python"]).parent.parent == python.parent.parent
    # A file the run made stays in the working copy, not in the device project.
    assert (root / "result.csv").read_text() == "a,b\n1,2\n"
    assert not (project / "result.csv").exists()


def test_sync_writes_only_changes_and_removes_deleted_files(client, config_dir):
    sync(client, {"a.py": "print(1)\n", "b.py": "print(2)\n", "data/x.txt": "x"})
    root = shared_root(config_dir).resolve() / PID
    (root / "chart.png").write_bytes(b"made by a run")
    again = sync(client, {"a.py": "print(1)\n", "b.py": "print(22)\n"})
    assert again["written"] == ["b.py"]
    assert sorted(again["removed"]) == ["data/x.txt"]
    assert not (root / "data").exists()  # emptied folder removed
    assert (root / "b.py").read_text() == "print(22)\n"
    assert (root / "chart.png").read_bytes() == b"made by a run"  # never part of the project: kept


def test_projects_have_separate_working_copies(client, config_dir):
    sync(client, {"a.py": "print('one')\n"}, PID)
    sync(client, {"a.py": "print('two')\n"}, OTHER)
    base = shared_root(config_dir).resolve()
    assert (base / PID / "a.py").read_text() == "print('one')\n"
    assert (base / OTHER / "a.py").read_text() == "print('two')\n"


@pytest.mark.parametrize("files", [
    {"../escape.py": "x"},
    {"/abs.py": "x"},
    {".tandem/synced.json": "{}"},
])
def test_sync_refuses_paths_outside_the_working_copy(client, files, config_dir):
    r = client.put(f"/api/shared/{PID}/files", json={"files": files})
    assert r.status_code == 400
    assert not (shared_root(config_dir).parent / "escape.py").exists()


def test_bad_project_ids_are_refused(client):
    assert client.put("/api/shared/..%2F..%2Fetc/files", json={"files": {}}).status_code in (400, 404, 405)
    assert client.put("/api/shared/not-a-uuid/files", json={"files": {}}).status_code == 400


def test_a_run_needs_a_working_copy(client):
    events = run_shared(client, "main.py", project=OTHER)
    assert first(events, "run.rejected")["message"] == "This shared project has no working copy here yet."


def test_trust_is_remembered_per_project(client):
    assert client.get(f"/api/shared/{PID}/trust").json() == {"trusted": False}
    assert client.put(f"/api/shared/{PID}/trust", json={"trusted": True}).json() == {"trusted": True}
    assert client.get(f"/api/shared/{PID}/trust").json() == {"trusted": True}
    assert client.get(f"/api/shared/{OTHER}/trust").json() == {"trusted": False}


def test_shared_projects_choose_their_own_python(client, project, config_dir, python):
    r = client.put("/api/envs/select?scope=shared", json={"python": str(python)})
    assert r.status_code == 200, r.text
    assert r.json()["selected"] == str(python)
    # The device project's choice is untouched.
    assert not (project / ".tandem" / "settings.json").exists()
    assert json.loads((shared_root(config_dir) / ".tandem" / "settings.json").read_text())["python"] == str(python)


def test_notebook_kernel_in_a_working_copy(client, config_dir, python):
    use_shared_python(config_dir, python)
    sync(client, {"nb.ipynb": "{}", "helpers.py": "VALUE = 20.0\n"})
    with client.websocket_connect(f"ws://127.0.0.1:{PORT}/ws?token={TOKEN}") as ws:
        ws.send_text(json.dumps({"type": "kernel.start", "id": "k1", "path": "nb.ipynb", "shared": PID}))
        outputs, deadline = [], time.monotonic() + 120
        started = False
        while time.monotonic() < deadline:
            event = json.loads(ws.receive_text())
            if event["type"] == "kernel.rejected":
                pytest.fail(event["message"])
            if event["type"] == "kernel.status" and event.get("state") == "idle" and not started:
                started = True
                ws.send_text(json.dumps({"type": "kernel.execute", "id": "k1", "cell": "c1",
                                         "code": "import os, helpers\nprint(helpers.VALUE, os.path.basename(os.getcwd()))"}))
            if event["type"] == "kernel.output":
                outputs.append(event["output"])
            if event["type"] == "kernel.done":
                break
        ws.send_text(json.dumps({"type": "kernel.shutdown", "id": "k1"}))
    text = "".join(o.get("text", "") for o in outputs if o.get("output_type") == "stream")
    assert text.strip() == f"20.0 {PID}"
