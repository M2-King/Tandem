import os

import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from tandem_runtime.security import AccessPolicy
from tandem_runtime.server import create_app

from conftest import PORT, TOKEN


def test_api_requires_token(client: TestClient):
    assert client.get("/api/files").status_code == 200
    assert client.get("/api/files", headers={"x-tandem-token": "wrong"}).status_code == 403
    bare = TestClient(client.app, base_url=f"http://127.0.0.1:{PORT}")
    assert bare.get("/api/files").status_code == 403


def test_unexpected_host_is_refused(project):
    app = create_app(project, AccessPolicy(token=TOKEN, port=PORT), ui_dir=None)
    rebinding = TestClient(app, base_url=f"http://evil.example:{PORT}")
    r = rebinding.get("/api/files", headers={"x-tandem-token": TOKEN})
    assert r.status_code == 403
    # The UI page (which carries the token) is refused too.
    assert rebinding.get("/").status_code == 403


def test_foreign_origin_is_refused(client: TestClient):
    r = client.put("/api/file", json={"path": "a.py", "text": ""}, headers={"origin": "https://evil.example"})
    assert r.status_code == 403


def test_websocket_requires_token(project):
    app = create_app(project, AccessPolicy(token=TOKEN, port=PORT), ui_dir=None)
    bare = TestClient(app, base_url=f"http://127.0.0.1:{PORT}")  # no token header
    with pytest.raises(WebSocketDisconnect) as refused:
        with bare.websocket_connect(f"ws://127.0.0.1:{PORT}/ws") as ws:
            ws.receive_text()
    assert refused.value.code == 4403
    with pytest.raises(WebSocketDisconnect):
        with bare.websocket_connect(f"ws://127.0.0.1:{PORT}/ws?token=wrong") as ws:
            ws.receive_text()


def test_ui_page_carries_the_session_token(project, tmp_path):
    ui = tmp_path / "ui"
    ui.mkdir()
    (ui / "index.html").write_text("<html><head><title>t</title></head><body></body></html>")
    app = create_app(project, AccessPolicy(token=TOKEN, port=PORT), ui_dir=ui)
    page = TestClient(app, base_url=f"http://127.0.0.1:{PORT}").get("/").text
    assert 'id="tandem-runtime"' in page and TOKEN in page


def test_files_list_read_write(client: TestClient, project):
    (project / "main.py").write_text("print('hi')\n")
    (project / ".venv").mkdir()
    (project / ".venv" / "x.py").write_text("")
    listed = [f["path"] for f in client.get("/api/files").json()["files"]]
    assert listed == ["main.py"]

    read = client.get("/api/file", params={"path": "main.py"}).json()
    assert read["text"] == "print('hi')\n"
    written = client.put("/api/file", json={"path": "main.py", "text": "print(2)\n", "base_hash": read["hash"]})
    assert written.status_code == 200
    assert (project / "main.py").read_text() == "print(2)\n"
    # Writing with an out-of-date hash is refused instead of overwriting.
    stale = client.put("/api/file", json={"path": "main.py", "text": "x", "base_hash": read["hash"]})
    assert stale.status_code == 400 and "changed on disk" in stale.json()["detail"]

    created = client.post("/api/file", json={"path": "pkg/new.py", "text": "# new\n"})
    assert created.status_code == 200 and (project / "pkg" / "new.py").exists()
    assert client.post("/api/file", json={"path": "pkg/new.py"}).status_code == 400


@pytest.mark.parametrize("path", ["../outside.py", "/etc/passwd", "a/../../outside.py"])
def test_paths_outside_the_project_are_refused(client: TestClient, path):
    assert client.get("/api/file", params={"path": path}).status_code == 400
    assert client.put("/api/file", json={"path": path, "text": "x"}).status_code == 400


def test_symlink_escape_is_refused(client: TestClient, project, tmp_path):
    secret = tmp_path / "secret.txt"
    secret.write_text("secret")
    os.symlink(secret, project / "link.txt")
    assert client.get("/api/file", params={"path": "link.txt"}).status_code == 400
    assert "link.txt" not in [f["path"] for f in client.get("/api/files").json()["files"]]
