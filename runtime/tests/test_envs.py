"""Environment manager: discovery, creating and selecting environments,
packages, missing imports and approved installs."""

import json
import sys
import time
from pathlib import Path

import pytest

from tandem_runtime import envs
from conftest import PORT, TOKEN, env_python, first, output_text, run_script, use_python


def base_of(version: str) -> str | None:
    """The Python installation a test environment was made from."""
    py = env_python(version)
    if not py.exists():
        return None
    cfg = (py.parent.parent / "pyvenv.cfg").read_text()
    for line in cfg.splitlines():
        if line.startswith("executable"):
            return line.split("=", 1)[1].strip()
    home = next(line.split("=", 1)[1].strip() for line in cfg.splitlines() if line.startswith("home"))
    return str(Path(home) / ("python.exe" if sys.platform == "win32" else f"python{version}"))


def run_job(client, message: dict, timeout: float = 300):
    events = []
    with client.websocket_connect(f"ws://127.0.0.1:{PORT}/ws?token={TOKEN}") as ws:
        ws.send_text(json.dumps({"type": "job.start", "id": "j1", **message}))
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            event = json.loads(ws.receive_text())
            events.append(event)
            if event["type"] in ("job.finished", "job.rejected"):
                return events
    raise AssertionError("job did not finish in time")


def log_of(events) -> str:
    return "".join(e["text"] for e in events if e["type"] == "job.output")


@pytest.fixture
def bases():
    found = {v: base_of(v) for v in ("3.11", "3.12")}
    if not all(found.values()):
        pytest.skip("Python 3.11 and 3.12 test environments not built")
    return found


def test_discovers_python_installations(bases):
    found = envs.interpreters(refresh=True)
    assert found, "at least one Python installation"
    versions = {".".join(i["version"].split(".")[:2]) for i in found}
    if sys.platform != "win32":
        assert {"3.11", "3.12"} <= versions


def test_create_select_and_run_in_two_environments(client, project, bases):
    (project / "v.py").write_text("import sys\nprint(sys.version.split()[0], sys.prefix)\n")
    v311, v312 = bases["3.11"], bases["3.12"]

    done = first(run_job(client, {"kind": "create-env", "base": v311, "name": ".venv"}), "job.finished")
    assert done["status"] == "success", done
    assert done["selected"] is True and (project / ".venv" / "pyvenv.cfg").exists()
    events, _ = run_script(client, "v.py")
    assert output_text(events).startswith("3.11.") and ".venv" in output_text(events)

    done = first(run_job(client, {"kind": "create-env", "base": v312, "name": ".venv-3.12"}), "job.finished")
    assert done["status"] == "success", done
    events, _ = run_script(client, "v.py")
    assert output_text(events).startswith("3.12.") and ".venv-3.12" in output_text(events)

    listed = client.get("/api/envs").json()
    assert {e["name"] for e in listed["project"]} == {".venv", ".venv-3.12"}
    assert listed["current"]["version"].startswith("3.12") and listed["current"]["source"] == "project setting"

    # Back to the first one, then to automatic (the project's .venv).
    client.put("/api/envs/select", json={"python": next(e["path"] for e in listed["project"] if e["name"] == ".venv")})
    events, _ = run_script(client, "v.py")
    assert output_text(events).startswith("3.11.")
    auto = client.put("/api/envs/select", json={"python": None}).json()
    assert auto["selected"] is None and "project environment" in auto["current"]["source"]

    # Environments never show up as project files.
    assert not any(".venv" in f["path"] for f in client.get("/api/files").json()["files"])


def test_create_refuses_bad_names_and_existing_folders(client, project, bases):
    rejected = first(run_job(client, {"kind": "create-env", "base": bases["3.12"], "name": "../out"}), "job.rejected")
    assert "folder name" in rejected["message"]
    (project / "taken").mkdir()
    rejected = first(run_job(client, {"kind": "create-env", "base": bases["3.12"], "name": "taken"}), "job.rejected")
    assert "already exists" in rejected["message"]


def test_packages_and_missing_imports(client, project, python):
    use_python(project, python)
    (project / "helper.py").write_text("X = 1\n")
    (project / "main.py").write_text(
        "import os, json\nimport numpy as np\nimport helper\nfrom sklearn.linear_model import LinearRegression\n"
        "import definitely_not_installed_pkg\nfrom . import nothing\n")
    data = client.get("/api/packages").json()
    names = {p["name"].lower() for p in data["packages"]}
    assert {"numpy", "scikit-learn", "pip"} <= names
    assert data["can_install"] is True
    missing = {m["module"]: m for m in data["missing"]}
    assert set(missing) == {"definitely_not_installed_pkg"}
    assert missing["definitely_not_installed_pkg"]["where"] == [{"path": "main.py", "line": 5}]


def test_missing_imports_name_the_package_to_install(client, project, bases):
    py = Path(bases["3.12"])
    use_python(project, py)  # a system Python without scikit-learn or yaml (here: nothing installed)
    (project / "a.py").write_text("import sklearn\nimport yaml\nimport PIL.Image\n")
    missing = {m["module"]: m["package"] for m in envs.missing_imports(project, py)}
    for module, package in (("sklearn", "scikit-learn"), ("yaml", "pyyaml"), ("PIL", "pillow")):
        if module in missing:
            assert missing[module] == package


def test_never_installs_into_a_system_python(client, project, bases):
    use_python(project, Path(bases["3.12"]))
    data = client.get("/api/packages").json()
    assert data["can_install"] is False and "system Python" in data["reason"]
    rejected = first(run_job(client, {"kind": "install", "packages": ["six"]}), "job.rejected")
    assert "system Python" in rejected["message"]


@pytest.mark.parametrize("spec", ["--index-url=http://evil", "-r requirements.txt", "../x", "six; rm -rf /", "a b"])
def test_install_refuses_anything_but_package_names(client, project, python, spec):
    use_python(project, python)
    rejected = first(run_job(client, {"kind": "install", "packages": [spec]}), "job.rejected")
    assert "isn't a package name" in rejected["message"]


def test_package_spec_accepts_names_extras_and_versions():
    for ok in ("numpy", "pandas>=2", "scikit-learn==1.5.2", "requests[socks]", "Django>=4.2,<5", "zope.interface"):
        assert envs.PACKAGE_SPEC.match(ok), ok


def test_approved_install_into_a_project_environment(client, project, bases):
    done = first(run_job(client, {"kind": "create-env", "base": bases["3.12"], "name": ".venv"}), "job.finished")
    assert done["status"] == "success", done
    (project / "uses.py").write_text("import six\nprint('six', six.__version__)\n")
    assert [m["package"] for m in client.get("/api/packages").json()["missing"]] == ["six"]
    events = run_job(client, {"kind": "install", "packages": ["six"]})
    started, finished = first(events, "job.started"), first(events, "job.finished")
    assert started["command"][1:5] == ["-m", "pip", "install", "--disable-pip-version-check"]
    assert started["command"][-1] == "six"
    if finished["status"] != "success" and ("connection" in log_of(events).lower() or "resolve" in log_of(events).lower()):
        pytest.skip("PyPI isn't reachable from this machine")
    assert finished["status"] == "success", log_of(events)[-2000:]
    assert client.get("/api/packages").json()["missing"] == []
    events, _ = run_script(client, "uses.py")
    assert output_text(events).startswith("six ")


def test_failed_install_is_explained(client, project, bases):
    first(run_job(client, {"kind": "create-env", "base": bases["3.12"], "name": ".venv"}), "job.finished")
    events = run_job(client, {"kind": "install", "packages": ["tandem-no-such-package-0xdeadbeef"]})
    finished = first(events, "job.finished")
    assert finished["status"] == "error"
    assert finished["message"].startswith(("pip couldn't find", "pip couldn't reach"))


def test_preview_shows_the_exact_command_before_anything_runs(client, project, bases):
    preview = client.post("/api/jobs/preview", json={"kind": "create-env", "base": bases["3.12"], "name": ".venv"}).json()
    assert preview["command"] == [bases["3.12"], "-m", "venv", str(project.resolve() / ".venv")]
    assert not (project / ".venv").exists()
    use_python(project, env_python("3.12"))
    bad = client.post("/api/jobs/preview", json={"kind": "install", "packages": ["--pre"]})
    assert bad.status_code == 400 and "isn't a package name" in bad.json()["detail"]
