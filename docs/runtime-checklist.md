# Real runtime checklist

Status of the Python and Jupyter runtime work. Each item is marked:
**done** (verified against real Python), **pending**, or **blocked** (with the reason).

## Phase 1: Real Python execution — done

| Item | Status | How it was verified |
| --- | --- | --- |
| Local runtime binds 127.0.0.1 only | done | CLI binds the socket itself; no option to bind elsewhere |
| Session token on every API call and the WebSocket | done | `test_security_files.py`; curl without token → 403 |
| Host check (DNS rebinding) and Origin check | done | tests + curl with a foreign Host → 403 |
| Files confined to the project (no `..`, absolute, symlink escape) | done | tests |
| Open, edit (saved to disk), create files; conflict if changed on disk | done | tests + browser |
| Interpreter resolution: settings → project venv → `--python` → PATH | done | tests on 3.11 and 3.12 report the expected `sys.executable` |
| Run with live stdout/stderr (streamed, UTF‑8 safe) | done | tests + browser |
| Exit code, duration, working directory = project root | done | tests |
| Exceptions: real traceback, last frame inside the project, Go to line | done | tests + browser (`KeyError`, line 3) |
| Stop: SIGINT → SIGTERM → SIGKILL to the whole process group | done | test stops a script and its child process; browser stop in 0.4 s |
| A run ends if the runtime dies | done | test kills the runtime with SIGKILL; the script exits |
| One run at a time per project | done | test |
| Variables summary at the end of a run | done | tests + browser |
| matplotlib `plt.show()` → real SVG chart | done | acceptance script shows the "Runtime Test" chart |
| Metrics only from the program's own `results` variable | done | tests (present / absent) |
| Real mode never falls back to simulated results | done | disconnect test: run marked Error with "Lost the connection"; Run disabled |
| Clear mode and status indicator; how to start the runtime | done | toolbar status / Demo badge popover |
| Demo mode unchanged and labelled | done | existing demo browser tests re-run |

## Pending

- Phase 2: environment manager (discover interpreters, create 3.11/3.12 venvs, switch, package list, approved installs, missing-import detection).
- Phase 3: Jupyter notebooks (real kernels, run/interrupt/restart, nbformat round-trip).
- Phase 4: Step Run and Debug Run on debugpy (currently shown as unavailable in Real mode).
- Phase 5: machine-learning sample project with real scikit-learn metrics.
- Phase 6: AI providers (Anthropic, OpenAI-compatible, Ollama) with keys on the local backend; the assistant is labelled "Demo assistant" in Real mode until then.
- Phase 7: end-to-end verification and screenshots in Real mode.
- Run history in Real mode is kept in memory only (lost on reload).
- Development proxy so `npm run dev` can talk to the runtime (today the runtime serves the built UI).

## Blocked / not testable here

- Windows: process-group handling is not implemented yet; the runtime refuses to start runs on Windows.
- Real cloud AI and Ollama: no key or Ollama in this environment; will be tested only against a local mock server unless one is provided.

## Not a sandbox

The runtime runs your code with your user's permissions. It protects the
connection (localhost, token, Host/Origin checks), confines file access to the
project and manages process lifetimes, but it does not isolate code from your
computer.
