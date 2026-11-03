# Tandem

A browser-based AI coding workspace prototype: write Python, ask the assistant
for a change, review the diff, accept it, run the code, and inspect results.

This is a **frontend prototype**. AI responses and Python execution are
simulated with prepared, deterministic sample data. Nothing is sent to a
server and no code is executed. Simulated parts are labelled "Demo" or
"Simulated" in the interface.

## Run it

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

## What works

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

## What is simulated

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

## Where real backends plug in

| Replace | With | Keep the same shape |
| --- | --- | --- |
| `sendAssistantRequest` in `src/services/aiService.js` | A call to your AI backend (keep API keys on the server) | Returns `{ kind: 'proposal', path, newContent, text, summary }`, `{ kind: 'answer', text }`, or `{ kind: 'limitation', text, suggestions }`; reports progress with `onStage`; honours the `AbortSignal` |
| `startRun` / `checkRunnable` in `src/services/executionService.js` | A Python runner (server endpoint, or Pyodide in a worker) | Streams lines via `onOutput`, finishes via `onFinish({ status, output, variables, figures, metrics, error })`, returns `{ stop }` |
| `TRACE` in `src/services/traceService.js` | A real debugger (e.g. debugpy) | An array of steps `{ line, scope, globals, locals, output }` |

The UI never talks to these services directly except through the hooks in
`src/state/`, so swapping them doesn't require component changes.

## Project structure

```
src/
  App.jsx              Layout and the glue between state and components
  components/          UI pieces (toolbar, sidebar, editor, assistant, results, charts)
  state/               React hooks for workspace files, assistant, execution, preferences
  services/            Mock AI, execution, and debugger (replace for real backends)
  data/                Sample project files and fixed sample results
  lib/                 Small helpers (metrics, diff, storage, Monaco setup)
  styles/              Design tokens and app styles
```

Built with React (plain JavaScript), Vite, Monaco Editor, and lucide icons.
