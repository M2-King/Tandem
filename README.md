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

### Desktop app (Windows)

Tandem is a desktop app: download **Tandem-Setup** (installer) or the **portable** exe from the
repository's Releases page, start Tandem and choose a project folder. The Python runtime is bundled
inside; your project code runs with your own Python 3.11+ (python.org, or
`winget install Python.Python.3.12`), using the project's `.venv` when it has one.

The window has no wallpaper of its own: it is glass over your real desktop. Choose the glass under
⋯ → **Window glass**: *Frosted* (Windows acrylic, the default on Windows 11), *Mica* (tinted by your
wallpaper), or *Clear* (your desktop exactly as it is, behind tinted panels; also on Windows 10).
Changes apply at once (Clear reopens the window in place, so it waits while code is running).
The glass density adapts to your wallpaper's brightness; the wallpaper itself is never changed.
⋯ → **Open folder…** switches projects. The exe isn't code-signed yet, so SmartScreen may ask you to
confirm (More info → Run anyway).

The dusk image in the browser preview is only a stand-in: a web page can't see your desktop.

Build it yourself (on Windows): `npm ci && npm run build`; `pip install ./runtime pyinstaller==6.11.1`;
`pyinstaller --distpath out packaging/tandem-runtime.spec`; then in `desktop/`: `npm ci` and
`npx electron-builder --win`. During development, `npm start` in `desktop/` runs the app with the
runtime from `runtime/.venv`. The `Windows app` GitHub workflow builds and tests all of this on Windows
and publishes releases.

### iPad (branch `ipad`)

Tandem for iPad is a separate build on the `ipad` branch; the Windows app is unaffected. Python runs
inside the app (Pyodide: CPython 3.14 compiled to WebAssembly) with numpy, pandas, matplotlib and
scikit-learn included, offline; other Pyodide packages download the first time they're imported. Run,
typed input, Stop, tracebacks, charts, Step through, Debug and the AI assistant work as on Windows.
Projects are folders in Files › On My iPad › Tandem; AI keys are in the iPad Keychain. iPadOS can't show
the home-screen wallpaper behind an app, so the background is plain or a photo you choose.

The `iPad app` workflow builds an unsigned `Tandem-iPad.ipa`; sign it with Sideloadly, AltStore or similar.
Structure: `src/runtime/ipadBackend.js` and `src/runtime/ipad/` (Python worker, AI), `ipad/App/` (Swift app:
web view and the local server), `ipad/devserver.py` (the same server in Python, for tests),
`ipad/tests/web.cjs` (end-to-end checks).

### AI settings

In Real mode, **AI settings** (in the assistant header or the ⋯ menu) connects a provider: Anthropic,
any OpenAI-compatible server, or a local Ollama. Keys are sent once to the local runtime and stored in
your user config folder (`%APPDATA%\Tandem` on Windows, `~/.config/tandem` on Linux,
`~/Library/Application Support/Tandem` on macOS), readable by you only. The browser never gets a key
back, and project code never sees it. *Test connection* lists the provider's models (no tokens used).
The assistant then uses that model on your own files: ask for a change or press **Ask AI to fix** on an
error, and it sees the file, the traceback and the output, and proposes a new version of the file. The
change opens as a diff; nothing is written until you accept it, and nothing runs until you press Run.

**Tab autocomplete** (on by default once a model is connected; switch it off in AI settings or the
command palette): after a short pause in typing, the model suggests the next code in grey. Each
suggestion is one small request (at most 200 tokens) to the same model.

### Keyboard shortcuts (like Cursor)

⌘ on Mac and iPad, Ctrl on Windows and Linux. The command palette lists every command with its shortcut.

| Shortcut | What it does |
| --- | --- |
| Tab / Esc / Ctrl+→ (⌘→) | Accept the AI suggestion / dismiss it / accept one word |
| Ctrl/⌘+K | Edit the selection (or the current line) with AI: describe the change, review the diff |
| Ctrl/⌘+L | Add the selection to the assistant |
| Ctrl/⌘+I | Open the assistant (press again from it to close) |
| @ in the assistant | Add a file to the request |
| Ctrl/⌘+P | Go to a file by name (`>` for commands, `:12` for line 12) |
| Ctrl/⌘+Shift+P | Command palette |
| Ctrl/⌘+Shift+F | Search in all files, notebooks included (match case, whole word, regular expressions) |
| Ctrl/⌘+Shift+H | Replace in all files: one match, or all with Undo (`$1` works with regular expressions) |
| Ctrl/⌘+F, Ctrl+H (⌘⌥F) | Find, and find and replace, in the open file |
| Ctrl/⌘+D | Select the next match too |
| Alt+↑/↓ (⌥↑/↓) | Move the line up or down |
| Ctrl/⌘+/ | Comment or uncomment |
| F12 / F2 | Go to definition / rename (Python: the file, the notebook, and the project's other .py files) |
| Ctrl+\` | Show or hide the output panel (Tandem has no terminal) |

On iPad without a keyboard, the same things are on screen: **Search** on the left rail,
**Search and replace…** and **Commands…** in the ⋯ menu, and **Edit** in the bar under a selection.

### From source in a browser (macOS, Linux, Windows)

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
type), Run with live stdout/stderr, typing input for `input()` in the Output
panel, exit codes, real tracebacks with the line inside your project, Stop
(interrupts, then terminates, the whole process tree), variables at the end of
the run, matplotlib charts from `plt.show()`, and **Step through** and **Debug**
on your own code (Next F10, Into F11, Out Shift+F11, Continue F5; breakpoints
beside the line numbers; live variables and call stack). The debugger is
Python's own `bdb`, so nothing needs installing, and it never stops inside
libraries.
Metrics appear only if your program keeps them in a variable named `results`
(`{model: {"MAE": .., "RMSE": .., "R2": ..}}` or a DataFrame). Notebooks are not connected yet. Progress is tracked in `docs/runtime-checklist.md`.

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
- Selection actions: Ask AI (adds a context chip such as `main.py · Lines 18–26`), Edit (Ctrl/⌘+K),
  Explain, Fix. Ctrl/⌘+L also adds the selection. They work in notebook cells too.
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
desktop/               Desktop app (Electron): native glass window, starts the bundled runtime
runtime/               Local Python runtime (FastAPI): files, runs, security; tests in runtime/tests
packaging/             Runtime bundle (PyInstaller) and end-to-end checks of the built app
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
