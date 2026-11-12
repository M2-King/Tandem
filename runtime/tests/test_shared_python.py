"""Is this computer ready to run shared projects? (/api/shared/python, the
app's "Preparing Python" step.)"""

import json
from pathlib import Path

from starlette.testclient import TestClient

from conftest import PORT, TOKEN
from tandem_runtime.ai_settings import AISettings
from tandem_runtime.security import AccessPolicy
from tandem_runtime.server import create_app


def app_with_shared(tmp_path: Path, python: Path | None):
    shared = tmp_path / "shared"
    if python is not None:
        (shared / ".tandem").mkdir(parents=True)
        (shared / ".tandem" / "settings.json").write_text(json.dumps({"python": str(python)}))
    project = tmp_path / "project"
    project.mkdir()
    app = create_app(project, AccessPolicy(token=TOKEN, port=PORT), ui_dir=None,
                     ai_settings=AISettings(tmp_path / "config"), shared_root=shared)
    return TestClient(app, base_url=f"http://127.0.0.1:{PORT}", headers={"x-tandem-token": TOKEN})


def test_ready_with_a_python_that_has_the_packages(tmp_path, python):
    # The test environments have numpy, pandas, matplotlib and ipykernel.
    with app_with_shared(tmp_path, python) as client:
        state = client.get("/api/shared/python").json()
    assert state["python"] == str(python)
    assert state["source"] == "chosen for shared projects"
    assert state["missing"] == [] and state["ready"] is True
    assert state["packages"] == ["numpy", "pandas", "matplotlib", "ipykernel"]


def test_reports_a_base_to_make_the_environment_from(tmp_path):
    with app_with_shared(tmp_path, None) as client:
        state = client.get("/api/shared/python").json()
    assert set(state) >= {"python", "version", "source", "own_env", "missing", "ready", "base", "interpreters"}
    if state["base"] is not None:
        assert state["base"]["path"] in {i["path"] for i in state["interpreters"]}


def test_needs_the_session_token(tmp_path):
    with app_with_shared(tmp_path, None) as client:
        assert client.get("/api/shared/python", headers={"x-tandem-token": "wrong"}).status_code == 403
