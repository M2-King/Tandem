"""AI provider settings: keys go in, never come out; connection tests make real HTTP requests."""

import json
import os
import stat
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from conftest import output_text, run_script, use_python

KEY = "sk-test-0123456789abcdef"


class FakeProviders(BaseHTTPRequestHandler):
    """Answers like the Anthropic, OpenAI-compatible and Ollama model-list endpoints."""
    seen = []

    def log_message(self, *args):
        pass

    def _json(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        FakeProviders.seen.append((self.path, dict(self.headers)))
        if self.path.startswith("/anthropic/v1/models"):
            # SDK 2.x sends the key as a bearer token; older clients used x-api-key.
            if KEY not in (self.headers.get("x-api-key"), (self.headers.get("Authorization") or "").removeprefix("Bearer ")):
                return self._json(401, {"type": "error", "error": {"type": "authentication_error", "message": "invalid x-api-key"}})
            return self._json(200, {"data": [{"type": "model", "id": "claude-opus-5-5", "display_name": "Claude Opus 5.5",
                                              "created_at": "2026-01-01T00:00:00Z"}],
                                    "has_more": False, "first_id": "claude-opus-5-5", "last_id": "claude-opus-5-5"})
        if self.path == "/openai/v1/models":
            if self.headers.get("Authorization") != f"Bearer {KEY}":
                return self._json(401, {"error": {"message": "bad key"}})
            return self._json(200, {"object": "list", "data": [{"id": "model-b"}, {"id": "model-a"}]})
        if self.path == "/api/tags":
            return self._json(200, {"models": [{"name": "llama3.2:latest"}, {"name": "qwen2.5-coder:7b"}]})
        self._json(404, {})


@pytest.fixture
def fake():
    server = ThreadingHTTPServer(("127.0.0.1", 0), FakeProviders)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    FakeProviders.seen = []
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()


def test_key_is_saved_privately_and_never_returned(client, config_dir):
    r = client.put("/api/ai/settings", json={"provider": "anthropic", "api_key": KEY, "activate": True})
    assert r.status_code == 200
    body = r.text
    assert KEY not in body
    data = r.json()
    assert data["active"] == "anthropic"
    assert data["providers"]["anthropic"]["has_key"] is True
    assert data["providers"]["anthropic"]["key_hint"] == "…cdef"
    assert KEY not in client.get("/api/ai/settings").text
    secrets = config_dir / "secrets.json"
    assert json.loads(secrets.read_text())["api_keys"]["anthropic"] == KEY
    if sys.platform != "win32":
        assert stat.S_IMODE(os.stat(secrets).st_mode) == 0o600


def test_settings_need_the_session_token(client):
    client.headers.pop("x-tandem-token")
    assert client.get("/api/ai/settings").status_code == 403
    assert client.put("/api/ai/settings", json={"provider": "anthropic", "api_key": KEY}).status_code == 403


def test_remove_key(client):
    client.put("/api/ai/settings", json={"provider": "openai", "api_key": KEY})
    data = client.put("/api/ai/settings", json={"provider": "openai", "clear_key": True}).json()
    assert data["providers"]["openai"]["has_key"] is False


def test_bad_input_is_refused(client):
    assert client.put("/api/ai/settings", json={"provider": "nope"}).status_code == 400
    assert client.put("/api/ai/settings", json={"provider": "openai", "api_key": "has space"}).status_code == 400
    r = client.put("/api/ai/settings", json={"provider": "openai", "base_url": "http://example.com/v1"})
    assert r.status_code == 400 and "https" in r.json()["detail"]


def test_anthropic_connection_uses_the_saved_key(client, fake):
    client.put("/api/ai/settings", json={"provider": "anthropic", "base_url": fake + "/anthropic", "api_key": KEY})
    result = client.post("/api/ai/test", json={"provider": "anthropic"}).json()
    assert result["ok"] and result["models"] == ["claude-opus-5-5"] and result["model_found"] is True
    path, headers = FakeProviders.seen[-1]
    assert path.startswith("/anthropic/v1/models")
    assert KEY in (headers.get("x-api-key"), headers.get("Authorization", "").removeprefix("Bearer "))
    assert headers.get("anthropic-version")
    assert KEY not in json.dumps(result)


def test_wrong_key_is_reported_plainly(client, fake):
    client.put("/api/ai/settings", json={"provider": "anthropic", "base_url": fake + "/anthropic", "api_key": "sk-wrong-000000000000"})
    result = client.post("/api/ai/test", json={"provider": "anthropic"}).json()
    assert result["ok"] is False and "401" in result["message"]


def test_openai_compatible_and_ollama(client, fake):
    client.put("/api/ai/settings", json={"provider": "openai", "base_url": fake + "/openai/v1", "api_key": KEY, "model": "model-x"})
    result = client.post("/api/ai/test", json={"provider": "openai"}).json()
    assert result["ok"] and result["models"] == ["model-a", "model-b"] and result["model_found"] is False
    client.put("/api/ai/settings", json={"provider": "ollama", "base_url": fake})
    result = client.post("/api/ai/test", json={"provider": "ollama"}).json()
    assert result["ok"] and "llama3.2:latest" in result["models"]


def test_unreachable_server(client):
    client.put("/api/ai/settings", json={"provider": "ollama", "base_url": "http://127.0.0.1:9"})
    result = client.post("/api/ai/test", json={"provider": "ollama"}).json()
    assert result["ok"] is False and "Couldn't reach" in result["message"]


def test_project_code_never_sees_the_key(client, project, python):
    client.put("/api/ai/settings", json={"provider": "anthropic", "api_key": KEY})
    use_python(project, python)
    (project / "peek.py").write_text("import os\nprint(any('" + KEY + "' in v for v in os.environ.values()))\n")
    events, _ = run_script(client, "peek.py")
    assert output_text(events, "out") == "False\n"
