# Tandem

A coding workspace for Python: write code, ask the assistant for a change,
review the diff, accept it, run the code, and inspect results.

Tandem has two strictly separate modes:

- **Real mode** (the local runtime): your project folder on disk, run with a
  real Python interpreter on your computer. Every output, error and chart comes
  from actually running the code. If the runtime stops, Tandem says so and
  stops; it never falls back to simulated results.
- **Demo mode** (the hosted preview, or a plain `npm run dev`): prepared,
  deterministic sample results, clearly labelled "Demo" / "Simulated".
  Nothing is executed.

The mode is decided when the page loads: pages served by the local runtime
are in Real mode, everything else is the demo.

## Real Python on your computer

### Windows: download the app

Download **Tandem.exe** from the repository's Releases page and double-click it. Choose a project
folder; Tandem opens in your browser. Closing the console window stops it. Your project code needs
Python 3.11+ installed (python.org, or `winget install Python.Python.3.12`); Tandem uses the project's
`.venv` when it has one, otherwise the `py` launcher's Python. The exe isn't code-signed yet, so
SmartScreen may ask you to confirm (More info → Run anyway).

Build it yourself on Windows: `npm ci && npm run build`, then
`pip install ./runtime pyinstaller==6.11.1` and `pyinstaller packaging/windows/tandem.spec`
(use `--distpath out` so the exe doesn't land in the UI's `dist/` folder).
The `Windows app` GitHub workflow does this on every push, runs the tests on Windows, checks the exe
end to end with `packaging/windows/smoke.py`, and publishes a release for `v*` tags.

### AI settings

In Real mode, **AI settings** (in the assistant header or the ⋯ menu) connects a provider: Anthropic,
any OpenAI-compatible server, or a local Ollama. Keys are sent once to the local runtime and stored in
your user config folder (`%APPDATA%\Tandem` on Windows, `~/.config/tandem` on Linux,
`~/Library/Application Support/Tandem` on macOS), readable by you only. The browser never gets a key
back, and project code never sees it. *Test connection* lists the provider's models (no tokens used).
The assistant itself starts using the provider in the next phase; until then it stays the labelled demo.

### From source (macOS, Linux, Windows)

Requires Python 3.11+ and Node.js 18+.

```bash
# 1. Build the UI (once, and after UI changes)
npm install
npm run build

# 2. Install the runtime into its own environment
python3.12 -m venv runtime/.venv
runtime/.venv/bin/pip install -e runtime

# 3. Open a project folder
runtime/.venv/bin/tandem open /path/to/your/project
```

`tandem open` prints a local address (http://127.0.0.1:8765) and opens it.

Your code runs with the project's own interpreter, in this order: the one saved
in `<project>/.tandem/settings.json`, the project's `.venv` / `venv` / `env`,
`--python`, then `python3` on PATH. The runtime's own environment is never used
for project code. (Creating and switching environments from the UI comes next.)

What works in Real mode today: opening and creating files (saved to disk as you
type), Run with live stdout/stderr, exit codes, real tracebacks with the line
inside your project, Stop (interrupts, then terminates, the whole process tree),
variables at the end of the run, and matplotlib charts from `plt.show()`.
Metrics appear only if your program keeps them in a variable named `results`
(`{model: {"MAE": .., "RMSE": .., "R2": ..}}` or a DataFrame). Step through,
Debug and notebooks are not connected yet and are shown as unavailable rather
than simulated. Progress is tracked in `docs/runtime-checklist.md`.

### Safety

The runtime is a **local runtime for your own projects, not a sandbox**: code
runs with your user's permissions, exactly as if you ran `python` yourself.
Do not use it to run code you don't trust. What it does protect:

- It listens on 127.0.0.1 only, never on the network.
- Every API call and the live connection need a random per-launch session key;
  requests naming another host (DNS rebinding) or coming from another site's
  origin are refused.
- File access is confined to the project folder (no `..`, absolute paths or
  symlinks leading out).
- Each run is a managed process group: Stop reaches child processes too, and a
  run ends if the runtime itself dies.
- Only one script runs at a time per project.
- AI-proposed changes are never run automatically; you review, accept, then run.

Restarting `tandem` creates a new session key, so reload the page afterwards.

Runtime tests (needs the test environments described in `runtime/tests/conftest.py`):

```bash
runtime/.venv/bin/pip install -e "runtime[test]"
cd runtime && .venv/bin/python -m pytest
```

## Run the demo

Requires Node.js 18 or newer.

```bash
npm install
npm run dev        # open the URL it prints (usually http://localhost:5173)
```

`npm run build` creates a static build in `dist/`, and `npm run preview` serves it.

## Try the demo

1. The sample project `house-prices` opens with `main.py`.
2. In the assistant, click (or type) *"Add predictions for the test data, plot
   predicted versus actual values, and compare the model with a decision tree."*
   You can also select code first and choose **Ask AI**.
3. The diff opens in the editor. **Accept** applies it; **Reject** leaves the file unchanged.
4. Click **Run**. Output, variables, and charts appear in the results panel.
5. In **Charts**, choose **Ask AI to modify** → *"Show both models in the same chart."* Accept and run again.
6. In **Runs**, tick two runs and **Compare** them.
7. Use **Undo** on a change card in the assistant to restore the earlier version.

Also try: run `summary.py` (it has a bug) and choose **Ask AI to fix**, or use
**Step through** / **Debug** from the menu next to Run (they use `price_stats.py`).
**Reset demo** is in the ⋯ menu.

## What works in the demo

- Monaco editor with Python highlighting, tabs, per-file undo history, adjustable font size.
- Files, assistant, and results panels: resizable, collapsible, and remembered.
  On narrow windows the file list, then the assistant, become overlays.
- AI change flow: progress stages, cancel, diff review (inline or side by side),
  accept, reject, undo. Proposals become *stale* if their file changes after they
  were created, and must be regenerated or discarded instead of overwriting edits.
  Changes can't be applied to a file while it is running.
- Selection actions: Ask AI (adds a context chip such as `main.py · Lines 18–26`), Explain, Fix.
  Ctrl/⌘+L also adds the selection.
- Run with a running state and Stop; a success scenario (`main.py`) and an error
  scenario (`summary.py`) with a working "Ask AI to fix" repair.
- Step through and Debug with breakpoints, a highlighted next line, and a Variables
  panel that marks changed values.
- Run history with code-snapshot fingerprints, chart comparison, and metrics.
- Files, conversation, runs, and preferences are saved in the browser (localStorage).

## What is simulated in the demo

- **AI**: `src/services/aiService.js` recognises a few prepared requests (the model
  comparison, the combined chart, fixing `summary.py`, explaining sample code).
  Other requests get an honest "demo limitation" reply.
- **Python execution**: `src/services/executionService.js` recognises the sample
  files and the versions the assistant produces (comments and blank lines are
  ignored) and replays prepared results. Other code is reported as not runnable
  in the demo rather than faked.
- **Debugging**: `src/services/traceService.js` holds a predefined trace that
  mirrors `price_stats.py` line by line. If that file is edited, Step through and
  Debug ask you to reset it.
- **Results**: predictions in `src/data/sampleResults.js` were produced once with
  scikit-learn. All metrics (MAE, RMSE, R²) are calculated from those arrays by
  `src/lib/metrics.js`, so output, charts, and tables always agree.

## Where real backends plug in (demo services)

| Replace | With | Keep the same shape |
| --- | --- | --- |
| `sendAssistantRequest` in `src/services/aiService.js` | A call to your AI backend (keep API keys on the server) | Returns `{ kind: 'proposal', path, newContent, text, summary }`, `{ kind: 'answer', text }`, or `{ kind: 'limitation', text, suggestions }`; reports progress with `onStage`; honours the `AbortSignal` |
| `startRun` / `checkRunnable` in `src/services/executionService.js` | Already done for Real mode: `src/runtime/localBackend.js` talks to the local runtime | Streams lines via `onOutput`, finishes via `onFinish({ status, output, variables, figures, metrics, error })`, returns `{ stop }` |
| `TRACE` in `src/services/traceService.js` | A real debugger (e.g. debugpy) | An array of steps `{ line, scope, globals, locals, output }` |

The UI never talks to these services directly except through the hooks in
`src/state/`, so swapping them doesn't require component changes.

## Project structure

```
runtime/               Local Python runtime (FastAPI): files, runs, security; tests in runtime/tests
src/
  App.jsx              Layout and the glue between state and components
  runtime/             Mode detection and the client for the local runtime
  components/          UI pieces (toolbar, sidebar, editor, assistant, results, charts)
  state/               React hooks for workspace files, assistant, execution, preferences
  services/            Demo AI, execution, and debugger (used only in Demo mode)
  data/                Sample project files and fixed sample results
  lib/                 Small helpers (metrics, diff, storage, Monaco setup)
  styles/              Design tokens and app styles
```

Built with React (plain JavaScript), Vite, Monaco Editor, and lucide icons.
