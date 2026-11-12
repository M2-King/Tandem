"""The assistant asks the configured provider over real HTTP and turns its reply into an answer or a proposal."""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

KEY = "sk-test-0123456789abcdef"
FIXED = '''while True:
    raw = input("Please put your number or DONE for finish: ")
    if raw == "DONE":
        break
    print(float(raw) * 2)
'''


class Fake(BaseHTTPRequestHandler):
    seen = []
    reply = ""

    def log_message(self, *args):
        pass

    def _json(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        Fake.seen.append((self.path, dict(self.headers), body))
        if self.path.startswith("/anthropic/v1/messages"):
            return self._json(200, {"id": "msg_1", "type": "message", "role": "assistant", "model": body["model"],
                                    "content": [{"type": "text", "text": Fake.reply}], "stop_reason": "end_turn",
                                    "stop_sequence": None, "usage": {"input_tokens": 10, "output_tokens": 10}})
        if self.path == "/openai/v1/chat/completions":
            return self._json(200, {"choices": [{"message": {"role": "assistant", "content": Fake.reply}}]})
        if self.path == "/api/chat":
            return self._json(200, {"message": {"role": "assistant", "content": Fake.reply}})
        if self.path == "/functions/v1/cowork-ai":  # the shared AI (supabase/functions/cowork-ai)
            if self.headers.get("Authorization") != "Bearer member-token":
                return self._json(401, {"error": "Sign in again to use the shared AI."})
            if Fake.reply == "LIMIT":
                return self._json(429, {"error": "You've used today's 30 requests on the shared AI."})
            return self._json(200, {"text": Fake.reply, "stop_reason": "end_turn", "model": "claude-sonnet-5-5",
                                    "provider": "anthropic", "shared_by": "tim", "used_today": 3,
                                    "daily_limit": 30, "unlimited": False})
        self._json(404, {})


@pytest.fixture
def fake():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Fake)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    Fake.seen = []
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()


def request_for(project):
    (project / "test.py").write_text("n = float(input('Please put your number or DONE for finish: '))\nprint(n)\n")
    return {
        "prompt": "Fix the EOFError in test.py.",
        "intent": "fix",
        "context": [{"type": "error", "path": "test.py", "line": 1}],
        "files": {"test.py": (project / "test.py").read_text()},
        "active_path": "test.py",
        "last_run": {"path": "test.py", "status": "error", "exit_code": 1,
                     "output": "Traceback (most recent call last):\nEOFError: EOF when reading a line\n",
                     "error": {"type": "EOFError", "message": "EOF when reading a line", "path": "test.py", "line": 1}},
        "history": [],
    }


def test_without_a_provider_the_assistant_says_how_to_connect_one(client, project):
    result = client.post("/api/ai/assist", json=request_for(project)).json()
    assert result["kind"] == "setup" and "AI settings" in result["text"]


def test_fix_any_file_with_an_openai_compatible_model(client, project, fake):
    client.put("/api/ai/settings", json={"provider": "openai", "base_url": fake + "/openai/v1", "api_key": KEY,
                                         "model": "model-a", "activate": True})
    assert client.get("/api/ai/active").json()["active"]["model"] == "model-a"
    Fake.reply = f'input() needs typed input; loop until DONE.\n\n<tandem-file path="test.py">\n{FIXED}</tandem-file>\n\n- Read input in a loop\n- Stop on DONE\n'
    result = client.post("/api/ai/assist", json=request_for(project)).json()
    assert result["kind"] == "proposal" and result["path"] == "test.py"
    assert result["new_content"] == FIXED
    assert result["summary"] == ["Read input in a loop", "Stop on DONE"]
    assert result["text"].startswith("input() needs typed input")
    # The model saw the real file, the traceback and the request; the key went in the header only.
    path, headers, body = Fake.seen[-1]
    sent = json.dumps(body)
    assert "float(input(" in sent and "EOFError" in sent and "Fix the EOFError" in sent
    assert headers.get("Authorization") == f"Bearer {KEY}" and KEY not in sent
    assert (project / "test.py").read_text().startswith("n = float")  # nothing written


def test_anthropic_answer(client, project, fake):
    client.put("/api/ai/settings", json={"provider": "anthropic", "base_url": fake + "/anthropic", "api_key": KEY,
                                         "model": "claude-opus-5-5", "activate": True})
    Fake.reply = "Line 1 reads one number with input(); there is nothing else to explain."
    result = client.post("/api/ai/assist", json={**request_for(project), "intent": "explain",
                                                  "prompt": "Explain test.py"}).json()
    assert result["kind"] == "answer" and "input()" in result["text"]
    assert result["model"] == "claude-opus-5-5"
    path, headers, body = Fake.seen[-1]
    assert path.startswith("/anthropic/v1/messages") and body["model"] == "claude-opus-5-5"
    assert "Tandem" in json.dumps(body["system"])


def test_ollama_and_conversation_history(client, project, fake):
    client.put("/api/ai/settings", json={"provider": "ollama", "base_url": fake, "model": "llama3.2", "activate": True})
    Fake.reply = "Sure."
    req = request_for(project)
    req["history"] = [{"role": "user", "text": "hello"}, {"role": "assistant", "text": "Hi, what should I look at?"}]
    result = client.post("/api/ai/assist", json=req).json()
    assert result["kind"] == "answer"
    _, _, body = Fake.seen[-1]
    roles = [m["role"] for m in body["messages"]]
    assert roles == ["system", "user", "assistant", "user"] and body["stream"] is False


def test_changes_outside_the_project_are_refused(client, project, fake):
    client.put("/api/ai/settings", json={"provider": "ollama", "base_url": fake, "model": "llama3.2", "activate": True})
    Fake.reply = '<tandem-file path="../evil.py">\nimport os\n</tandem-file>'
    result = client.post("/api/ai/assist", json=request_for(project)).json()
    assert result["kind"] == "answer" and "outside this project" in result["text"]


def test_provider_errors_are_reported(client, project):
    client.put("/api/ai/settings", json={"provider": "ollama", "base_url": "http://127.0.0.1:9", "model": "x", "activate": True})
    result = client.post("/api/ai/assist", json=request_for(project)).json()
    assert result["kind"] == "error" and "Couldn't reach" in result["text"]


def shared_request(project, fake, token="member-token"):
    req = request_for(project)
    # A shared project: its files aren't this device's; the owner shares their AI.
    req["file_list"] = ["test.py", "data/prices.csv"]
    req["shared_ai"] = {"url": fake + "/functions/v1/cowork-ai", "apikey": "publishable", "token": token,
                        "project_id": "00000000-0000-0000-0000-000000000001"}
    return req


def test_without_own_ai_a_shared_project_uses_the_owners_shared_ai(client, project, fake):
    Fake.reply = f'Loop until DONE.\n\n<tandem-file path="test.py">\n{FIXED}</tandem-file>\n\n- Loop\n'
    result = client.post("/api/ai/assist", json=shared_request(project, fake)).json()
    assert result["kind"] == "proposal" and result["new_content"] == FIXED
    assert result["provider"] == "Shared by tim" and result["model"] == "claude-sonnet-5-5"
    assert result["shared"] == {"shared_by": "tim", "used_today": 3, "daily_limit": 30, "unlimited": False}
    path, headers, body = Fake.seen[-1]
    # The member's sign-in goes to the function; no provider key is involved here.
    assert headers.get("Authorization") == "Bearer member-token" and {k.lower(): v for k, v in headers.items()}.get("apikey") == "publishable"
    assert body["project_id"].endswith("0001") and "Tandem" in body["system"] and body["max_tokens"] <= 16000
    sent = json.dumps(body["messages"])
    assert "data/prices.csv" in sent and "EOFError" in sent  # the shared project's file list, the traceback


def test_own_ai_comes_before_the_shared_one(client, project, fake):
    client.put("/api/ai/settings", json={"provider": "ollama", "base_url": fake, "model": "llama3.2", "activate": True})
    Fake.reply = "Mine."
    result = client.post("/api/ai/assist", json=shared_request(project, fake)).json()
    assert result["kind"] == "answer" and Fake.seen[-1][0] == "/api/chat" and "Shared" not in result.get("provider", "")


def test_shared_ai_errors_are_shown_as_they_are(client, project, fake):
    Fake.reply = "LIMIT"
    result = client.post("/api/ai/assist", json=shared_request(project, fake)).json()
    assert result == {"kind": "error", "text": "You've used today's 30 requests on the shared AI."}
    result = client.post("/api/ai/assist", json=shared_request(project, fake, token="expired")).json()
    assert result["kind"] == "error" and "Sign in again" in result["text"]


def test_a_shared_project_without_ai_says_an_owner_can_share_one(client, project):
    req = request_for(project)
    req["file_list"] = ["test.py"]
    result = client.post("/api/ai/assist", json=req).json()
    assert result["kind"] == "setup" and "Share your AI" in result["text"]


def test_a_shared_project_proposal_never_reads_this_devices_file_of_the_same_name(client, project, fake):
    (project / "other.py").write_text("DEVICE PROJECT\n")
    Fake.reply = '<tandem-file path="other.py">\nprint("new")\n</tandem-file>'
    req = shared_request(project, fake)
    result = client.post("/api/ai/assist", json=req).json()
    assert result["kind"] == "proposal" and result["new_file"] is True
