import json
import subprocess
import textwrap
import time

import pytest

from conftest import first, output_text, run_script, use_python

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


def test_acceptance_script(client, project, python):
    use_python(project, python)
    (project / "check.py").write_text(ACCEPTANCE)
    events, _ = run_script(client, "check.py")

    exit_ = first(events, "run.exit")
    assert exit_["status"] == "success" and exit_["exit_code"] == 0

    # The exact DataFrame pandas prints, computed independently in the same interpreter.
    expected = subprocess.run(
        [str(python), "-c", "import numpy as np, pandas as pd; print(pd.DataFrame({'x': np.arange(1, 6), 'y': [2, 4, 6, 8, 10]}))"],
        capture_output=True, text=True, check=True).stdout
    assert output_text(events, "out") == expected

    figure = first(events, "run.figure")
    assert figure is not None and figure["format"] == "svg" and figure["title"] == "Runtime Test"
    assert figure["data"].lstrip().startswith("<?xml") and "<svg" in figure["data"]
    names = {v["name"]: v for v in first(events, "run.variables")["variables"]}
    assert names["data"]["type"] == "DataFrame" and names["data"]["value"].startswith("5 rows × 2 columns")


def test_runs_with_the_selected_interpreter(client, project, python):
    use_python(project, python)
    (project / "v.py").write_text("import sys\nprint(sys.version.split()[0])\nprint(sys.prefix)\n")
    events, _ = run_script(client, "v.py")
    version, prefix = output_text(events).split()
    expected = subprocess.run([str(python), "-c", "import sys;print(sys.version.split()[0])"],
                              capture_output=True, text=True).stdout.strip()
    assert version == expected
    assert prefix == str(python.parent.parent)


def test_exception_reports_real_traceback_and_line(client, project, python):
    use_python(project, python)
    (project / "boom.py").write_text("x = 1\ny = {'a': 1}\nprint(y['missing'])\n")
    events, _ = run_script(client, "boom.py")
    exit_ = first(events, "run.exit")
    assert exit_["status"] == "error" and exit_["exit_code"] == 1
    err = output_text(events, "err")
    assert "Traceback (most recent call last)" in err and "KeyError: 'missing'" in err
    assert "tandem_run.py" not in err  # the wrapper's own frame is hidden
    assert exit_["error"] == {"type": "KeyError", "message": "'missing'", "path": "boom.py", "line": 3,
                              "function": "<module>"}
    # Variables defined before the error are still reported.
    names = {v["name"] for v in first(events, "run.variables")["variables"]}
    assert {"x", "y"} <= names


def test_exit_code_and_stderr(client, project, python):
    use_python(project, python)
    (project / "code.py").write_text("import sys\nprint('to err', file=sys.stderr)\nsys.exit(3)\n")
    events, _ = run_script(client, "code.py")
    exit_ = first(events, "run.exit")
    assert exit_["exit_code"] == 3 and exit_["status"] == "error" and exit_["error"] is None
    assert output_text(events, "err") == "to err\n"


def test_working_directory_is_the_project(client, project, python):
    use_python(project, python)
    (project / "data").mkdir()
    (project / "data" / "values.csv").write_text("a\n1\n2\n")
    (project / "src").mkdir()
    (project / "src" / "read.py").write_text("import os\nprint(os.getcwd())\nprint(open('data/values.csv').read().split())\n")
    events, _ = run_script(client, "src/read.py")
    cwd, values = output_text(events).splitlines()
    assert cwd == str(project.resolve()) and values == "['a', '1', '2']"


def test_output_streams_before_the_run_ends(client, project, python):
    use_python(project, python)
    (project / "slow.py").write_text("import time\nprint('first', flush=True)\ntime.sleep(1.5)\nprint('second')\n")
    events, _ = run_script(client, "slow.py")
    kinds = [(e["type"], e.get("text")) for e in events]
    first_out = kinds.index(("run.output", "first\n"))
    assert first_out < len(kinds) - 2  # 'first' arrived as its own message, well before exit


def test_stop_ends_a_long_running_script_and_its_children(client, project, python, tmp_path):
    use_python(project, python)
    marker = tmp_path / "child.pid"
    (project / "loop.py").write_text(textwrap.dedent(f'''\
        import subprocess, sys, time
        child = subprocess.Popen([sys.executable, "-c", "import time\\nwhile True: time.sleep(0.1)"])
        open({str(marker)!r}, "w").write(str(child.pid))
        print("running", flush=True)
        while True:
            time.sleep(0.05)
    '''))
    events, stop_at = run_script(client, "loop.py", stop_after_output=True)
    exit_ = first(events, "run.exit")
    assert exit_["status"] == "stopped"
    assert time.monotonic() - stop_at < 4
    child_pid = int(marker.read_text())
    time.sleep(0.3)
    alive = subprocess.run(["ps", "-p", str(child_pid), "-o", "stat="], capture_output=True, text=True).stdout.strip()
    assert alive == "" or alive.startswith("Z"), "the script's child process should be gone"


def test_only_one_run_at_a_time(client, project, python):
    use_python(project, python)
    (project / "wait.py").write_text("import time\nprint('go', flush=True)\ntime.sleep(30)\n")
    with client.websocket_connect("ws://127.0.0.1:8765/ws?token=test-token") as ws:
        ws.send_text(json.dumps({"type": "run.start", "id": "a", "path": "wait.py"}))
        while json.loads(ws.receive_text())["type"] != "run.output":
            pass
        ws.send_text(json.dumps({"type": "run.start", "id": "b", "path": "wait.py"}))
        rejected = None
        while rejected is None:
            e = json.loads(ws.receive_text())
            if e["type"] == "run.rejected":
                rejected = e
        assert rejected["id"] == "b" and "still running" in rejected["message"]
        ws.send_text(json.dumps({"type": "run.stop", "id": "a"}))
        while json.loads(ws.receive_text())["type"] != "run.exit":
            pass


def test_metrics_are_read_from_the_programs_results(client, project, python):
    use_python(project, python)
    (project / "m.py").write_text("results = {'Linear regression': {'MAE': 3.5, 'RMSE': 4.0, 'R²': 0.9}, 'note': 'x'}\n")
    events, _ = run_script(client, "m.py")
    assert first(events, "run.metrics")["metrics"] == {"Linear regression": {"mae": 3.5, "rmse": 4.0, "r2": 0.9}}


def test_no_metrics_without_results(client, project, python):
    use_python(project, python)
    (project / "n.py").write_text("mae = 3.2\n")
    events, _ = run_script(client, "n.py")
    assert first(events, "run.metrics") is None


def test_non_python_files_are_refused(client, project, python):
    use_python(project, python)
    (project / "notes.txt").write_text("hi")
    events, _ = run_script(client, "notes.txt")
    assert first(events, "run.rejected") is not None


def test_run_ends_if_the_runtime_dies(project, python, tmp_path):
    """Kill the server process outright: the script must not keep running."""
    import os
    import signal
    import sys

    use_python(project, python)
    pid_file = tmp_path / "script.pid"
    (project / "forever.py").write_text(
        f"import os, time\nopen({str(pid_file)!r}, 'w').write(str(os.getpid()))\nwhile True:\n    time.sleep(0.1)\n")
    host = tmp_path / "host.py"
    host.write_text(textwrap.dedent(f'''\
        import asyncio
        from pathlib import Path
        from tandem_runtime.files import ProjectFiles
        from tandem_runtime.runs import RunManager
        async def main():
            m = RunManager(ProjectFiles(Path({str(project)!r})), lambda: Path({str(python)!r}))
            async def send(e): pass
            await m.start("r", "forever.py", send)
            await asyncio.sleep(3600)
        asyncio.run(main())
    '''))
    server = subprocess.Popen([sys.executable, str(host)])
    deadline = time.monotonic() + 30
    while not pid_file.exists() and time.monotonic() < deadline:
        time.sleep(0.1)
    script_pid = int(pid_file.read_text())
    os.kill(server.pid, signal.SIGKILL)
    server.wait()
    gone_by = time.monotonic() + 5
    while time.monotonic() < gone_by:
        state = subprocess.run(["ps", "-p", str(script_pid), "-o", "stat="], capture_output=True, text=True).stdout.strip()
        if state == "" or state.startswith("Z"):
            break
        time.sleep(0.1)
    else:
        os.kill(script_pid, signal.SIGKILL)
        raise AssertionError("the script kept running after the runtime was killed")
