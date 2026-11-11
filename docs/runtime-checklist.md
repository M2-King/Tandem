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

## Windows desktop app — done (verification in CI)

| Item | Status | How it was verified |
| --- | --- | --- |
| Runs on Windows: Job Object per run, Ctrl+Break → KeyboardInterrupt, tree ends if the runtime dies | done | full test suite on `windows-latest` (Python 3.11 and 3.12) |
| Script events over a keyed loopback socket (all platforms) | done | tests; the key is not visible to the script |
| Saves keep exact bytes (no CRLF rewriting) | done | test |
| `py` launcher discovery, Microsoft Store placeholder skipped | done | code path; CI uses an explicit interpreter |
| Desktop app (Electron): native window, installer and portable exe, Python runtime bundled | done | built in CI; packaged app tested end to end (`packaging/desktop-smoke.cjs`) |
| Window is glass over the real desktop (no app wallpaper): Frosted/Mica on Windows 11, Clear everywhere | done | desktop mode checks in the packaged app; screenshot from the Windows runner |
| Closing the app stops the runtime; the runtime also exits if the app crashes (`--watch-pid`) | done | tests and packaged-app check |
| Bundled runtime checked on its own (UI, token, run, chart, traceback, Stop, AI settings) | done | `packaging/windows/smoke.py` in CI |
| Release with installer and portable exe | done | workflow `release` job |
| Code signing | blocked | needs a certificate; SmartScreen will ask users to confirm |

## AI settings — done (provider calls from the assistant pending)

| Item | Status | How it was verified |
| --- | --- | --- |
| Settings window: Anthropic, OpenAI-compatible, Ollama; key, address, model | done | browser test (desktop and phone width) |
| Keys stored by the runtime only (0600 file in the user config folder) | done | tests; key absent from DOM, localStorage and every API response |
| Keys never reach project code | done | test |
| Test connection lists models (no tokens) | done | tests against a local fake provider; wrong key reported as 401 |
| Real Anthropic / OpenAI / Ollama accounts | untested | no keys or Ollama in this environment |

## Input, Step through, Debug and the AI assistant — done

| Item | Status | How it was verified |
| --- | --- | --- |
| `input()`: prompt shown as printed, typed lines sent to the program, End input = EOF | done | tests (3.11, 3.12); browser run of a looping input script |
| Step through: Next / Into / Out / Continue on the real program, current line highlighted | done | tests follow Python's real line order, into and out of a function |
| Debug: breakpoints in any project file, changed while running; never stops in libraries | done | tests; browser run hitting a gutter breakpoint |
| Variables and call stack at every pause, changes marked | done | tests and browser |
| Assistant uses the model from AI settings on any file; error, output and file sent as context | done | tests against fake Anthropic / OpenAI-compatible / Ollama servers; browser fix → review → accept → run |
| No model connected: says so and opens AI settings (no demo answers in the app) | done | test and browser |
| Model changes outside the project are refused | done | test |
| Window glass switches without restarting | done | live switching checked on Windows CI |

## Phase 2: Environment manager — done

| Item | Status | How it was verified |
| --- | --- | --- |
| Finds the Python installations on the computer and the project's environments | done | tests; browser (3.11, 3.12, 3.13 found here) |
| Creates an environment with a chosen Python (3.11 and 3.12), selects it; runs report that version | done | tests create both and run `sys.version`; browser creates `.venv` from 3.11 |
| Switch between environments, or back to automatic | done | tests |
| Package list (`pip list`) of the selected environment | done | tests; browser |
| Imports the environment can't satisfy, with the package to install (sklearn → scikit-learn, …); the project's own modules and the standard library are left out | done | tests; browser |
| Installs only after the exact command is shown and confirmed; live log; cancel; readable failures | done | tests install from PyPI; browser: ModuleNotFoundError → Install six… → approve → run works |
| Never installs into a system Python; no pip options can be passed | done | tests |
| Environment folders never appear as project files | done | test |
| iPad: one built-in Python (Pyodide). Packages lists what the code imports; Pyodide's own packages load by themselves; pure-Python packages from PyPI install with micropip after confirmation and are kept in the project for offline runs | done | web tests (detection locally; the PyPI install in CI with the full Pyodide bundle) |

## Phase 3: Jupyter notebooks — done

| Item | Status | How it was verified |
| --- | --- | --- |
| `.ipynb` opens as a notebook: code and Markdown cells, add / delete / move / change type | done | browser |
| Real kernel per notebook: ipykernel in the project's selected environment (jupyter_client), 127.0.0.1 only (Unix sockets in a private folder on macOS/Linux) | done | tests (3.11, 3.12); bundled runtime smoke test |
| Run cell (Shift+Enter, Ctrl/Cmd+Enter, Alt+Enter), Run all, Interrupt, Restart, Restart & run all, execution counts | done | tests and browser |
| Your two-cell test prints 20.0; after Restart cell 2 raises NameError until cell 1 runs again | done | tests, browser, bundled runtime |
| Outputs: text (streams, \r progress), errors with traceback, pandas tables (sanitized HTML), matplotlib charts (PNG/SVG), Markdown; input() asks in the notebook | done | tests and browser |
| ipykernel missing: says so, Install ipykernel… opens Packages with it filled in | done | test and browser |
| Saved as standard nbformat 4.5 with outputs; validates with nbformat | done | browser-made notebook validated with nbformat |
| Kernels end with their window or tab; can't be driven from another window | done | tests |
| iPad: one long-lived Pyodide per notebook (state carries over), IPython-style display, inline charts, input(), Interrupt, Restart | done | web tests (Chromium; WebKit and the simulator in CI) |

## SQL workspace and file types — done

| Item | Status | How it was verified |
| --- | --- | --- |
| Python / SQL switch in the toolbar; the SQL workspace has a database panel (tables, columns, row counts) and a results grid | done | browser (laptop), web tests (iPad) |
| Real SQLite (sql.js) in a worker, the same on laptop and iPad; Stop ends a runaway query and reopens the database as last saved | done | browser |
| Run the whole .sql file, or the selection (Ctrl/Cmd+Enter or ▶ Run); each statement's rows, changes, time; errors with statement and line; history; copy as CSV | done | browser |
| Changes are saved to the .db file in the project straight away; Python's sqlite3 reads the same file | done | browser + CPython sqlite3 (laptop); Pyodide sqlite3 (iPad web test) |
| Practice database (a made-up school) and practice.sql exercises | done | browser, web tests |
| New file: choose the kind (Python, notebook, SQL, SQLite database, Markdown, text, CSV, JSON, YAML, HTML, CSS, JavaScript, TypeScript, shell, R, Java, C, C++, XML, config, or any name); extension and a starter template are added; highlighting for each | done | browser |

## Pending

- Phase 5: machine-learning sample project with real scikit-learn metrics.
- Phase 7: end-to-end verification and screenshots in Real mode.
- Run history in Real mode is kept in memory only (lost on reload).
- Development proxy so `npm run dev` can talk to the runtime (today the runtime serves the built UI).

## Blocked / not testable here

- Real cloud AI and Ollama: no key or Ollama in this environment; will be tested only against a local mock server unless one is provided.

## Not a sandbox

The runtime runs your code with your user's permissions. It protects the
connection (localhost, token, Host/Origin checks), confines file access to the
project and manages process lifetimes, but it does not isolate code from your
computer.
