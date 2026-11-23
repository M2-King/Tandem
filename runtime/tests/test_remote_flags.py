"""Flags for Tandem on an SSH server (runtime/remote/bootstrap.sh starts it with them)."""

import subprocess
import sys
import time
from pathlib import Path

import httpx


def start(project: Path, *extra):
    proc = subprocess.Popen(
        [sys.executable, "-m", "tandem_runtime", "serve", str(project), "--port", "0", "--print-url", *extra],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    url = proc.stdout.readline().strip()
    assert url.startswith("http://127.0.0.1:"), proc.stderr.read()
    return proc, url


def test_token_is_printed_only_when_asked(tmp_path):
    proc, url = start(tmp_path, "--print-token", "--no-ui", "--exit-with-stdin")
    try:
        line = proc.stdout.readline().strip()
        assert line.startswith("token=") and len(line) > 30
        token = line.split("=", 1)[1]
        port = url.rsplit(":", 1)[1].strip("/")
        status = httpx.get(f"{url}api/status", headers={"x-tandem-token": token, "host": f"127.0.0.1:{port}"})
        assert status.status_code == 200 and status.json()["project"]["root"] == str(tmp_path.resolve())
        assert httpx.get(f"{url}api/status").status_code == 403  # no token
        assert httpx.get(url).status_code == 503  # --no-ui: no UI served
    finally:
        proc.kill()
        proc.wait()

    proc, url = start(tmp_path)
    try:
        # Without --print-token the next output isn't a token line.
        proc.stdin.close()
        time.sleep(1)
        assert proc.poll() is None  # and without --exit-with-stdin it keeps running
    finally:
        proc.kill()
        proc.wait()


def test_exits_when_stdin_closes(tmp_path):
    proc, _ = start(tmp_path, "--print-token", "--exit-with-stdin", "--no-ui")
    proc.stdout.readline()
    proc.stdin.close()  # the SSH connection ended
    try:
        assert proc.wait(timeout=15) == 0
    finally:
        proc.kill()
