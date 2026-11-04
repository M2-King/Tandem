"""End-to-end check of a built Tandem.exe (or any `tandem` command).

    python smoke.py <path to Tandem.exe> <python for project code>

Starts the app in serve mode on a temporary project, then over the real HTTP
API and WebSocket: reads the status, runs the acceptance script (DataFrame
output and a matplotlib figure), checks a real traceback, and stops an endless
loop. Exits non-zero on any failure.
"""

import json
import os
import re
import subprocess
import sys
import tempfile
import textwrap
import time
import urllib.request
from pathlib import Path

from websockets.sync.client import connect

ACCEPTANCE = textwrap.dedent('''\
    import numpy as np
    import pandas as pd
    import matplotlib.pyplot as plt
    data = pd.DataFrame({
        "x": np.arange(1, 6),
        "y": [2, 4, 6, 8, 10]
    })
    print(data)
    plt.plot(data["x"], data["y"])
    plt.title("Runtime Test")
    plt.show()
''')


def check(condition, message):
    if not condition:
        raise SystemExit(f"FAILED: {message}")
    print(f"ok   {message}", flush=True)


def get(url, token=None, method="GET", body=None):
    headers = {"x-tandem-token": token} if token else {}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, headers=headers, method=method, data=data)
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8")


def run(ws, run_id, path, stop_on_output=False, timeout=120):
    ws.send(json.dumps({"type": "run.start", "id": run_id, "path": path}))
    events, stopped_at = [], None
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        event = json.loads(ws.recv(timeout=timeout))
        events.append(event)
        if event["type"] in ("run.exit", "run.rejected"):
            return events, stopped_at
        if stop_on_output and stopped_at is None and event["type"] == "run.output":
            ws.send(json.dumps({"type": "run.stop", "id": run_id}))
            stopped_at = time.monotonic()
    raise SystemExit(f"FAILED: {path} did not finish")


def main():
    app, python = sys.argv[1], sys.argv[2]
    project = Path(tempfile.mkdtemp(prefix="tandem-smoke-"))
    (project / "check.py").write_text(ACCEPTANCE, encoding="utf-8")
    (project / "boom.py").write_text("values = {'a': 1}\nprint('about to fail')\nprint(values['missing'])\n", encoding="utf-8")
    (project / "loop.py").write_text("import time\nprint('tick', flush=True)\nwhile True:\n    time.sleep(0.05)\n", encoding="utf-8")

    config = Path(tempfile.mkdtemp(prefix="tandem-smoke-config-"))
    proc = subprocess.Popen([app, "serve", str(project), "--port", "0", "--print-url", "--python", python],
                            stdout=subprocess.PIPE, text=True, env={**os.environ, "TANDEM_CONFIG_DIR": str(config)})
    try:
        url = proc.stdout.readline().strip()
        check(url.startswith("http://127.0.0.1:"), f"runtime started at {url}")
        page = get(url)
        token = json.loads(re.search(r'<script id="tandem-runtime" type="application/json">(.*?)</script>', page).group(1))["token"]
        check('<div id="root">' in page, "bundled UI is served")

        try:
            get(url + "api/status")
            check(False, "API refuses requests without the session key")
        except urllib.error.HTTPError as exc:
            check(exc.code == 403, "API refuses requests without the session key")

        status = json.loads(get(url + "api/status", token))
        check(status["python"]["ok"], f"project Python found: {status['python'].get('version')} ({status['python']['source']})")

        ws_url = url.replace("http://", "ws://") + f"ws?token={token}"
        with connect(ws_url, open_timeout=30) as ws:
            events, _ = run(ws, "a", "check.py")
            out = "".join(e["text"] for e in events if e["type"] == "run.output" and e["stream"] == "out")
            expected = subprocess.run([python, "-c", "import numpy as np, pandas as pd; print(pd.DataFrame({'x': np.arange(1, 6), 'y': [2, 4, 6, 8, 10]}))"],
                                      capture_output=True, text=True, check=True).stdout
            exit_ = events[-1]
            if exit_.get("status") != "success":
                print(json.dumps(events)[:3000])  # show what happened before failing
            check(exit_.get("status") == "success" and exit_.get("exit_code") == 0, "acceptance script succeeded")
            check(out == expected, "DataFrame printed exactly as plain Python prints it")
            figure = next((e for e in events if e["type"] == "run.figure"), None)
            check(figure is not None and figure["title"] == "Runtime Test" and "<svg" in figure["data"], "real matplotlib figure received")

            events, _ = run(ws, "b", "boom.py")
            error = events[-1].get("error") or {}
            check(events[-1]["status"] == "error" and error.get("type") == "KeyError" and error.get("line") == 3,
                  "exception reported with its type and line")

            events, stopped_at = run(ws, "c", "loop.py", stop_on_output=True)
            check(events[-1]["status"] == "stopped" and time.monotonic() - stopped_at < 8, "Stop ended an endless loop")
        key = "sk-smoke-0123456789abcdef"
        saved = get(url + "api/ai/settings", token, "PUT",
                    {"provider": "anthropic", "api_key": key, "base_url": "http://127.0.0.1:9"})
        check(key not in saved and json.loads(saved)["providers"]["anthropic"]["has_key"], "AI key saved and never returned")
        result = json.loads(get(url + "api/ai/test", token, "POST", {"provider": "anthropic"}))
        check(result["ok"] is False and "Couldn't reach" in result["message"],
              f"AI connection test runs in the app ({result['message']})")
        print("\nAll smoke checks passed.")
    finally:
        if sys.platform == "win32":
            # A one-file exe is two processes (launcher + app): end the whole tree.
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)
        proc.kill()
        proc.wait()


if __name__ == "__main__":
    main()
