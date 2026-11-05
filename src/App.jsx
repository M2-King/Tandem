import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Toolbar from './components/Toolbar.jsx';
import FileSidebar from './components/FileSidebar.jsx';
import NavRail from './components/NavRail.jsx';
import EditorPane from './components/EditorPane.jsx';
import AssistantPanel from './components/AssistantPanel.jsx';
import ResultsPanel from './components/ResultsPanel.jsx';
import ResultsDialog from './components/ResultsDialog.jsx';
import Resizer from './components/Resizer.jsx';
import Dialog from './components/Dialog.jsx';
import TooltipLayer from './components/Tooltip.jsx';
import Toasts, { useToasts } from './components/Toasts.jsx';
import { usePrefs } from './state/usePrefs.js';
import { useWallpaper } from './state/useWallpaper.js';
import { useDesktop } from './state/useDesktop.js';
import { DESKTOP } from './runtime/desktop.js';
import { applyGlass } from './lib/glass.js';
import { useWorkspace } from './state/useWorkspace.js';
import { useDiskWorkspace } from './state/useDiskWorkspace.js';
import { useRuntimeStatus } from './state/useRuntimeStatus.js';
import { IS_LOCAL, RUNTIME_CONFIG } from './runtime/config.js';
import { createLocalBackend } from './runtime/localBackend.js';
import { RuntimeStatus, DemoBadge } from './components/RuntimeStatus.jsx';
import NewFileDialog from './components/NewFileDialog.jsx';
import AISettingsDialog from './components/AISettingsDialog.jsx';
import { createRealAssistant } from './services/realAI.js';
import { useAssistant } from './state/useAssistant.js';
import { useExecution } from './state/useExecution.js';
import { useViewportWidth } from './state/useViewport.js';
import { runTargetFor } from './services/executionService.js';
import { TRACE, EXECUTABLE_LINES } from './services/traceService.js';
import { DEMO_PROMPTS } from './services/aiService.js';
import { DEBUG_FILE, PROJECT_NAME } from './data/sampleProject.js';
import { diffStats } from './lib/diff.js';
import { buildRunAnalysis, proposalForRun } from './services/analysisService.js';
import { shortHash } from './lib/text.js';

const DATA_FILE = 'data/housing.csv';

// Real mode talks to the local runtime; Demo mode never does. Decided once.
const backend = IS_LOCAL ? createLocalBackend(RUNTIME_CONFIG) : null;

// Rows and columns of the sample CSV, read from the file as it is now.
// The block of code that draws figure `index` in a script: each figure ends
// at a plt.show(), and its code is the unbroken block above it.
function figureLines(text, index) {
  const lines = text.split('\n');
  const shows = lines.map((l, i) => (/\bplt\.show\(\)/.test(l) ? i : -1)).filter((i) => i >= 0);
  const end = shows[index];
  if (end == null) return null;
  let start = end;
  while (start > 0 && lines[start - 1].trim() !== '' && start - 1 !== shows[index - 1]) start--;
  return { start: start + 1, end: end + 1 };
}

function datasetStats(text) {
  if (!text) return null;
  const lines = text.trim().split('\n').filter(Boolean);
  return { path: DATA_FILE, rows: Math.max(0, lines.length - 1), cols: lines[0] ? lines[0].split(',').length : 0 };
}

const MIN_EDITOR_WIDTH = 480;

const lineLabel = (start, end) => (start === end ? `Line ${start}` : `Lines ${start}–${end}`);

// Names of variables whose value differs from the previous step.
function changedVariables(step, prev) {
  if (!prev) return [];
  const before = new Map([...(prev.globals || []), ...(prev.locals || [])].map((v) => [v.name, v.value]));
  return [...(step.globals || []), ...(step.locals || [])]
    .filter((v) => before.get(v.name) !== v.value)
    .map((v) => v.name);
}

export default function App() {
  const viewportWidth = useViewportWidth();
  const { toasts, notify, dismiss, clear: clearToasts } = useToasts();
  const [saveState, setSaveState] = useState('saved');
  const onSave = useCallback((state) => setSaveState(state), []);

  const { prefs, update, setSidebarWidth, setAssistantWidth, setResultsHeight, changeFontSize, reset: resetPrefs } =
    usePrefs();
  const wall = useWallpaper(notify);
  const desktop = useDesktop(notify);
  // In the desktop app the glass sits over the person's own wallpaper; its brightness comes from the system.
  const backdropLuminance = desktop.active ? (desktop.luminance ?? 0.3) : wall.luminance;
  useEffect(() => applyGlass(prefs.glass, prefs.frost, backdropLuminance), [prefs.glass, prefs.frost, backdropLuminance]);
  // IS_LOCAL never changes while the page is open, so the hook order is stable.
  const ws = IS_LOCAL ? useDiskWorkspace(onSave, backend, { notify }) : useWorkspace(onSave);
  const exec = useExecution({ onSave, backend });
  const runtime = useRuntimeStatus(backend);
  const projectName = IS_LOCAL ? ws.project?.name || runtime.status?.project?.name || 'Project' : PROJECT_NAME;
  const runBlocked = !IS_LOCAL
    ? null
    : runtime.connection !== 'connected'
      ? 'The Tandem runtime is disconnected'
      : runtime.status && !runtime.status.python?.ok
        ? 'No Python interpreter found for this project'
        : null;
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [aiSettingsOpen, setAISettingsOpen] = useState(false);

  // Refs give async callbacks (AI requests, toasts) the latest state.
  const filesRef = useRef(ws.files);
  filesRef.current = ws.files;
  const activeRef = useRef(ws.activePath);
  activeRef.current = ws.activePath;
  // In Real mode the assistant asks the AI model chosen in AI settings.
  const [aiActive, setAIActive] = useState(null);
  const aiActiveRef = useRef(aiActive);
  aiActiveRef.current = aiActive;
  const runsRef = useRef(exec.runs);
  runsRef.current = exec.runs;
  const refreshAI = useCallback(() => {
    if (IS_LOCAL) backend.aiActive().then(setAIActive, () => {});
  }, []);
  useEffect(() => refreshAI(), [refreshAI]);
  const realRequest = useMemo(
    () =>
      IS_LOCAL
        ? createRealAssistant({
            backend,
            getLastRun: (path) => runsRef.current.filter((r) => r.path === path).at(-1) || null,
            getModelLabel: () => aiActiveRef.current?.model,
          })
        : undefined,
    []
  );
  const assistant = useAssistant({
    getFiles: useCallback(() => filesRef.current, []),
    getActivePath: useCallback(() => activeRef.current, []),
    onSave,
    request: realRequest,
  });
  const proposalsRef = useRef(assistant.proposals);
  proposalsRef.current = assistant.proposals;
  const sessionRef = useRef(exec.session);
  sessionRef.current = exec.session;

  /* ---------- layout ---------- */

  // On narrow windows the assistant becomes an overlay, then the sidebar.
  const narrow = viewportWidth - prefs.assistantWidth < MIN_EDITOR_WIDTH;
  const assistantDocked = !narrow && prefs.assistantOpen;
  const compact =
    viewportWidth - prefs.sidebarWidth - (assistantDocked ? prefs.assistantWidth : 0) < MIN_EDITOR_WIDTH;
  const [sidebarOverlay, setSidebarOverlay] = useState(false);
  const [assistantOverlay, setAssistantOverlay] = useState(false);
  const sidebarVisible = compact ? sidebarOverlay : prefs.sidebarOpen;
  const assistantVisible = narrow ? assistantOverlay : prefs.assistantOpen;

  const [resultsOpen, setResultsOpen] = useState(false);
  const [resultsTab, setResultsTab] = useState('Output');
  const [newCharts, setNewCharts] = useState(false);
  const [reviewingId, setReviewingId] = useState(null);
  const [flash, setFlash] = useState(null);
  const [revealRequest, setRevealRequest] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const composerRef = useRef(null);
  const assistantToggleRef = useRef(null);
  const centerRef = useRef(null);

  const toggleFiles = () => (compact ? setSidebarOverlay((o) => !o) : update({ sidebarOpen: !prefs.sidebarOpen }));
  const toggleAssistant = () =>
    narrow ? setAssistantOverlay((o) => !o) : update({ assistantOpen: !prefs.assistantOpen });
  const closeAssistant = () => {
    if (narrow) setAssistantOverlay(false);
    else update({ assistantOpen: false });
    assistantToggleRef.current?.focus();
  };
  const showAssistant = useCallback(() => {
    if (narrow) setAssistantOverlay(true);
    else update({ assistantOpen: true });
  }, [narrow, update]);
  const focusComposer = useCallback(() => setTimeout(() => composerRef.current?.focus(), 40), []);

  // Escape closes overlays and returns focus to their toggle.
  useEffect(() => {
    if (!sidebarOverlay && !assistantOverlay) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape' || document.querySelector('.dialog, .menu')) return;
      if (assistantOverlay) {
        setAssistantOverlay(false);
        assistantToggleRef.current?.focus();
      } else setSidebarOverlay(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [sidebarOverlay, assistantOverlay]);

  const openFile = (path) => {
    ws.openFile(path);
    if (compact) setSidebarOverlay(false);
  };

  /* ---------- AI requests and proposals ---------- */

  const sendPrompt = useCallback(
    async (prompt, options = {}) => {
      if (assistant.busy) return;
      const context = options.context ?? assistant.draftContext;
      if (!options.context) assistant.clearContext();
      showAssistant();
      const result = await assistant.send({ prompt, intent: options.intent, context });
      if (result?.proposalId) {
        // Show the diff in the editor as soon as the change is ready.
        setReviewingId(result.proposalId);
        ws.openFile(result.path);
      }
    },
    [assistant, showAssistant, ws]
  );

  const accept = (id, { force = false } = {}) => {
    const p = proposalsRef.current[id];
    if (!p || p.status !== 'pending') return;
    if (filesRef.current[p.path] !== p.baseContent) {
      notify(`${p.path} changed after this proposal was created. Regenerate it instead.`);
      return;
    }
    // Never change the code an active run or debug session represents.
    if (!force && sessionRef.current?.path === p.path) return;
    ws.setFile(p.path, p.newContent);
    assistant.updateProposal(id, { status: 'accepted', appliedAt: Date.now() });
    setReviewingId(null);
    ws.openFile(p.path);
    setFlash({ path: p.path, lines: diffStats(p.baseContent, p.newContent).changedLines, key: Date.now() });
    notify(`Applied change to ${p.path}`, { label: 'Undo', onClick: () => undo(id, { fromToast: true }) });
  };

  const undo = (id, { fromToast = false } = {}) => {
    const p = proposalsRef.current[id];
    if (!p || p.status !== 'accepted') return;
    if (sessionRef.current?.path === p.path) {
      notify(`Stop the current session before undoing changes to ${p.path}.`);
      return;
    }
    if (fromToast && filesRef.current[p.path] !== p.newContent) {
      // Edited since: ask for confirmation in the assistant instead.
      showAssistant();
      notify(`${p.path} was edited after the change. Use Undo in the assistant to confirm.`);
      return;
    }
    ws.setFile(p.path, p.baseContent);
    assistant.updateProposal(id, { status: 'undone' });
    ws.openFile(p.path);
    setFlash({ path: p.path, lines: diffStats(p.newContent, p.baseContent).changedLines, key: Date.now() });
    notify(`Undid change to ${p.path}`);
  };

  const proposalHandlers = {
    onReview: (id) => {
      const p = proposalsRef.current[id];
      setReviewingId((current) => (current === id ? null : id));
      if (p) ws.openFile(p.path);
    },
    onAccept: (id) => accept(id),
    onReject: (id) => {
      assistant.updateProposal(id, { status: 'rejected' });
      setReviewingId((current) => (current === id ? null : current));
    },
    onDiscard: (id) => {
      assistant.updateProposal(id, { status: 'discarded' });
      setReviewingId((current) => (current === id ? null : current));
    },
    onRegenerate: (id) => {
      const p = proposalsRef.current[id];
      assistant.updateProposal(id, { status: 'discarded' });
      setReviewingId(null);
      if (p) sendPrompt(p.request.prompt, { intent: p.request.intent, context: p.request.context });
    },
    onUndo: (id) => undo(id),
    // From an applied change back to the code it touched.
    onOpenFile: (id) => {
      const p = proposalsRef.current[id];
      if (!p) return;
      setReviewingId(null);
      openFile(p.path);
      setFlash({ path: p.path, lines: diffStats(p.baseContent, p.newContent).changedLines, key: Date.now() });
    },
    onStopAndApply: (id) => {
      exec.stop();
      accept(id, { force: true });
    },
  };

  const proposalView = (id) => {
    const p = assistant.proposals[id];
    if (!p) return null;
    const current = ws.files[p.path];
    const latestAccepted = Object.values(assistant.proposals)
      .filter((q) => q.path === p.path && q.status === 'accepted')
      .sort((a, b) => b.appliedAt - a.appliedAt)[0];
    return {
      proposal: p,
      stale: p.status === 'pending' && current !== p.baseContent,
      blockedBy: exec.session && exec.session.path === p.path ? exec.session : null,
      canUndo: p.status === 'accepted' && latestAccepted?.id === p.id,
      editedSinceApply: p.status === 'accepted' && current !== p.newContent,
      reviewing: reviewingId === id,
    };
  };

  const reviewProposal = reviewingId ? assistant.proposals[reviewingId] : null;
  const review = reviewProposal && reviewProposal.status === 'pending' ? proposalView(reviewingId) : null;

  const selectionChip = (sel) => ({
    type: 'selection',
    path: sel.path,
    label: `${sel.path} · ${lineLabel(sel.startLine, sel.endLine)}`,
    text: sel.text,
    startLine: sel.startLine,
    endLine: sel.endLine,
  });

  const askAboutSelection = (sel) => {
    if (!sel) return;
    assistant.addContext(selectionChip(sel));
    showAssistant();
    focusComposer();
  };

  const askToFixRun = (run) => {
    const { path, line, type } = run.error;
    sendPrompt(`Fix the ${type} in ${path}.`, {
      intent: 'fix',
      context: [{ type: 'error', path, line, label: `${path} · ${type} on line ${line}` }],
    });
  };

  const askToModifyChart = (run, figure) => {
    assistant.addContext({ type: 'chart', runId: run.id, label: `Chart · ${figure.title} · run #${run.number}` });
    setExpanded(null);
    showAssistant();
    focusComposer();
  };

  const resetFile = (path) => {
    ws.resetFile(path);
    exec.setNotice(null);
    ws.openFile(path);
    notify(`Restored ${path} to the sample version.`);
  };

  /* ---------- execution ---------- */

  const runTarget = runTargetFor(ws.activePath);
  const debugBreakpoints = ws.breakpoints[DEBUG_FILE] || [];

  const handleRun = () => {
    if (exec.session || runBlocked) return;
    exec.run(runTarget, ws.files, ws.flush);
    setResultsOpen(true);
    setResultsTab('Output');
  };
  // Every breakpoint in the project, for the real debugger.
  const allBreakpoints = (bps = ws.breakpoints) =>
    Object.entries(bps).flatMap(([path, lines]) => (lines || []).map((line) => ({ path, line })));

  const handleTrace = (mode) => {
    if (IS_LOCAL) {
      if (runBlocked) return;
      if (exec.session && !exec.session.finished) return;
      if (exec.session?.finished) exec.stop();
      setReviewingId(null);
      exec.startTrace(mode, ws.files, null, { path: runTarget, flush: ws.flush, breakpointList: allBreakpoints() });
      setResultsOpen(true);
      setResultsTab(mode === 'step' ? 'Variables' : 'Output');
      return;
    }
    if (exec.session?.mode === 'run') exec.stop();
    ws.openFile(DEBUG_FILE);
    setReviewingId(null);
    const ok = exec.startTrace(mode, ws.files, debugBreakpoints);
    setResultsOpen(true);
    setResultsTab(ok ? 'Variables' : 'Output');
  };

  // Point out new charts without switching tabs on the user.
  const runCount = exec.runs.length;
  useEffect(() => {
    const last = exec.runs.at(-1);
    if (last && last.figures.length) setNewCharts(true);
    // When the run used a change Tandem made, the assistant summarises the result.
    if (last && proposalForRun(last, proposalsRef.current)) {
      const analysis = buildRunAnalysis(last);
      if (analysis) assistant.addAnalysis(analysis);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runCount]);
  useEffect(() => {
    if (resultsTab === 'Charts' && resultsOpen) setNewCharts(false);
  }, [resultsTab, resultsOpen]);

  const session = exec.session;
  const traceSession = session && session.mode !== 'run' ? session : null;
  const traceView = useMemo(() => {
    if (!traceSession) return null;
    if (traceSession.real) {
      const p = traceSession.paused;
      const output = [...traceSession.output.map((l) => l.text), ...(traceSession.partial ? [traceSession.partial] : [])];
      if (traceSession.finished || !p) {
        return { finished: !!traceSession.finished, running: !traceSession.finished, globals: p?.globals || [], locals: null, output, changed: [], stepKey: 'end', real: true };
      }
      return {
        line: p.line,
        path: p.path,
        scope: p.function === '<module>' ? 'module' : `${p.function}()`,
        globals: p.globals,
        locals: p.locals,
        stack: p.stack,
        output,
        changed: changedVariables(p, traceSession.prevPaused),
        stepKey: p.count,
        finished: false,
        running: traceSession.running,
        real: true,
      };
    }
    if (traceSession.finished) {
      return {
        finished: true,
        globals: TRACE.finalGlobals,
        locals: null,
        output: TRACE.finalOutput,
        changed: [],
        stepKey: 'end',
      };
    }
    const step = TRACE.steps[traceSession.index];
    const prev = traceSession.prevIndex != null ? TRACE.steps[traceSession.prevIndex] : null;
    return { ...step, finished: false, changed: changedVariables(step, prev), stepKey: traceSession.index };
  }, [traceSession]);

  const execLine = traceSession?.real
    ? traceSession.paused && !traceSession.running && !traceSession.finished && traceSession.paused.path === ws.activePath
      ? traceSession.paused.line
      : null
    : traceSession && !traceSession.finished && traceSession.path === ws.activePath
      ? TRACE.steps[traceSession.index].line
      : null;

  // When the debugger stops in another file (a step into an imported
  // function), show that file.
  const pausedKey = traceSession?.real && traceSession.paused ? `${traceSession.paused.path}:${traceSession.paused.count}` : null;
  useEffect(() => {
    const p = sessionRef.current?.paused;
    if (pausedKey && p && p.path !== activeRef.current && filesRef.current[p.path] !== undefined) ws.openFile(p.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pausedKey]);

  const toggleBreakpoint = (line) => {
    if (IS_LOCAL) {
      const path = ws.activePath;
      const current = ws.breakpoints[path] || [];
      const next = current.includes(line) ? current.filter((l) => l !== line) : [...current, line];
      ws.toggleBreakpoint(path, line);
      // A running debug session picks up the change right away.
      if (exec.session?.real && !exec.session.finished) exec.updateBreakpoints(allBreakpoints({ ...ws.breakpoints, [path]: next }));
      return;
    }
    if (!EXECUTABLE_LINES.has(line)) {
      notify(`Line ${line} has no code to pause on.`);
      return;
    }
    ws.toggleBreakpoint(DEBUG_FILE, line);
  };

  const selectedRun = exec.runs.find((r) => r.id === exec.selectedRunId) || exec.runs.at(-1) || null;

  // Debugger keys while a real Step through / Debug session is paused.
  const pausedNow = !!(traceSession?.real && traceSession.paused && !traceSession.running && !traceSession.finished);
  useEffect(() => {
    if (!pausedNow) return undefined;
    const onKey = (e) => {
      const action =
        e.key === 'F10' ? exec.next : e.key === 'F11' ? (e.shiftKey ? exec.stepOut : exec.stepIn) : e.key === 'F5' ? () => exec.continueTrace() : null;
      if (!action) return;
      e.preventDefault();
      action();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pausedNow, exec]);

  const restartRef = useRef(null);
  const traceFinished = !!traceSession?.finished;
  useEffect(() => {
    if (traceFinished && restartRef.current) {
      const mode = restartRef.current;
      restartRef.current = null;
      handleTrace(mode);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [traceFinished]);

  const resultsActions = {
    onInput: exec.sendInput,
    onEndInput: exec.endInput,
    onRun: handleRun,
    onAskFix: askToFixRun,
    onGoToLine: (path, line) => {
      ws.openFile(path);
      setReviewingId(null);
      setRevealRequest({ path, line, key: Date.now() });
      setFlash({ path, lines: [line], key: Date.now() });
    },
    onResetFile: resetFile,
    isCodeCurrent: (run) => shortHash(ws.files[run.path] ?? '') === run.snapshotHash,
    onOpenRunFile: (run) => {
      setReviewingId(null);
      openFile(run.path);
    },
    // From a chart to the lines that draw it, in the file as it is now.
    onShowFigureCode: (run, index) => {
      const text = ws.files[run.path] ?? '';
      const range = figureLines(text, index);
      setReviewingId(null);
      openFile(run.path);
      if (!range) {
        notify(`${run.path} no longer has the code for this chart.`);
        return;
      }
      const lines = [];
      for (let l = range.start; l <= range.end; l++) lines.push(l);
      setRevealRequest({ path: run.path, line: range.start, key: Date.now() });
      setFlash({ path: run.path, lines, key: Date.now() });
      if (shortHash(text) !== run.snapshotHash) notify(`${run.path} has changed since run #${run.number}. Showing the current code.`);
    },
    onDismissNotice: () => exec.setNotice(null),
    onExpand: (a, b) => setExpanded({ a, b }),
    onAskModify: askToModifyChart,
    onSelectRun: (id) => {
      exec.setSelectedRunId(id);
      setResultsTab('Output');
    },
  };

  /* ---------- reset ---------- */

  const resetDemo = () => {
    exec.reset();
    assistant.reset();
    ws.reset();
    resetPrefs();
    setResultsOpen(false);
    setResultsTab('Output');
    setReviewingId(null);
    setExpanded(null);
    setNewCharts(false);
    setSidebarOverlay(false);
    setAssistantOverlay(false);
    setConfirmReset(false);
    clearToasts();
    notify('Demo reset. The sample project is restored.');
  };

  const composerSuggestions = assistant.draftContext.some((c) => c.type === 'chart') ? [DEMO_PROMPTS.sameChart] : [];
  const inertProps = (hidden) => (hidden ? { inert: '', 'aria-hidden': true } : {});

  return (
    <div className="app">
      <Toolbar
        projectName={projectName}
        modeBadge={IS_LOCAL ? <RuntimeStatus {...runtime} /> : <DemoBadge />}
        savesToDisk={IS_LOCAL}
        saveState={saveState}
        run={{
          session,
          runTarget,
          blockedReason: runBlocked,
          traceNote: null,
          onRun: handleRun,
          onStep: () => handleTrace('step'),
          onDebug: () => handleTrace('debug'),
          onStop: exec.stop,
        }}
        panels={{
          files: { open: sidebarVisible, toggle: toggleFiles },
          results: { open: resultsOpen, toggle: () => setResultsOpen((o) => !o) },
          assistant: { open: assistantVisible, toggle: toggleAssistant, toggleRef: assistantToggleRef },
        }}
        fontSize={prefs.fontSize}
        onFontSize={changeFontSize}
        diffInline={prefs.diffInline}
        onDiffInline={(inline) => update({ diffInline: inline })}
        onReset={IS_LOCAL ? null : () => setConfirmReset(true)}
        onAISettings={IS_LOCAL ? () => setAISettingsOpen(true) : null}
        desktop={{ ...desktop, setMaterial: (m) => desktop.setMaterial(m, { busy: !!exec.session }) }}
        onOpenFolder={
          DESKTOP
            ? async () => {
                await ws.flush?.(); // save edits before switching projects
                await DESKTOP.openFolder();
              }
            : null
        }
        glass={prefs.glass}
        onGlass={(glass) => update({ glass })}
        frost={prefs.frost}
        onFrost={(frost) => update({ frost })}
        wallpaper={wall.wallpaper}
        onWallpaper={wall.choose}
        onWallpaperFile={wall.pickImage}
      />

      <div className="workspace">
        <NavRail
          filesOpen={sidebarVisible}
          onToggleFiles={toggleFiles}
          resultsOpen={resultsOpen}
          resultsTab={resultsTab}
          newCharts={newCharts}
          onResultsView={(tab) => {
            if (resultsOpen && resultsTab === tab) setResultsOpen(false);
            else {
              setResultsTab(tab);
              setResultsOpen(true);
            }
          }}
        />
        <aside
          className={`sidebar ${compact ? 'is-overlay' : ''} ${sidebarVisible ? 'is-open' : 'is-closed'}`}
          style={{ '--w': `${prefs.sidebarWidth}px` }}
          {...inertProps(!sidebarVisible)}
        >
          <FileSidebar
            paths={ws.fileOrder}
            activePath={ws.activePath}
            onOpen={openFile}
            projectName={projectName}
            runCount={exec.runs.length}
            onNewFile={IS_LOCAL ? () => setNewFileOpen(true) : null}
          />
        </aside>
        {!compact && sidebarVisible && (
          <Resizer
            orientation="vertical"
            label="Resize files panel"
            value={prefs.sidebarWidth}
            onResize={(start, delta) => setSidebarWidth(start + delta)}
          />
        )}

        <main className="center" ref={centerRef}>
          <EditorPane
            openTabs={ws.openTabs}
            activePath={ws.activePath}
            files={ws.files}
            onSelectTab={ws.openFile}
            onCloseTab={ws.closeTab}
            onChange={ws.setFile}
            onOpenFile={openFile}
            fontSize={prefs.fontSize}
            diffInline={prefs.diffInline}
            breakpoints={IS_LOCAL ? ws.breakpoints[ws.activePath] || [] : ws.activePath === DEBUG_FILE ? debugBreakpoints : []}
            glyphEnabled={IS_LOCAL ? /\.py$/.test(ws.activePath || '') : ws.activePath === DEBUG_FILE}
            onToggleBreakpoint={toggleBreakpoint}
            execLine={execLine}
            readOnlyMessage={
              traceSession && traceSession.path === ws.activePath
                ? 'Editing is paused while stepping through. Stop to edit.'
                : null
            }
            flash={flash}
            revealRequest={revealRequest}
            review={review}
            reviewHandlers={{
              onAccept: () => accept(reviewingId),
              onReject: () => proposalHandlers.onReject(reviewingId),
              onClose: () => setReviewingId(null),
              onRegenerate: () => proposalHandlers.onRegenerate(reviewingId),
              onDiscard: () => proposalHandlers.onDiscard(reviewingId),
              onStopAndApply: () => proposalHandlers.onStopAndApply(reviewingId),
            }}
            session={session}
            sessionHandlers={{
              onNext: exec.next,
              onStepIn: exec.stepIn,
              onStepOut: exec.stepOut,
              onContinue: () => exec.continueTrace(debugBreakpoints),
              onRestart: () => {
                if (!traceSession) return;
                if (traceSession.real && !traceSession.finished) {
                  // Stop first; the run restarts once Python has ended.
                  restartRef.current = traceSession.mode;
                  exec.stop();
                } else handleTrace(traceSession.mode);
              },
              onStop: exec.stop,
            }}
            notice={exec.notice}
            onResetFile={resetFile}
            onDismissNotice={() => exec.setNotice(null)}
            onAskAI={askAboutSelection}
            onExplain={(sel) =>
              sel &&
              sendPrompt(`Explain ${lineLabel(sel.startLine, sel.endLine).toLowerCase()} of ${sel.path}.`, {
                intent: 'explain',
                context: [selectionChip(sel)],
              })
            }
            onFix={(sel) =>
              sel &&
              sendPrompt(`Fix ${lineLabel(sel.startLine, sel.endLine).toLowerCase()} of ${sel.path}.`, {
                intent: 'fix',
                context: [selectionChip(sel)],
              })
            }
          />
          <div
            className={`results ${resultsOpen ? 'is-open' : 'is-closed'}`}
            style={{ '--h': `${prefs.resultsHeight}px` }}
            {...inertProps(!resultsOpen)}
          >
            {resultsOpen && (
              <Resizer
                orientation="horizontal"
                label="Resize results panel"
                value={prefs.resultsHeight}
                onResize={(start, delta) =>
                  setResultsHeight(start - delta, (centerRef.current?.clientHeight || 600) - 180)
                }
              />
            )}
            <ResultsPanel
              tab={resultsTab}
              onTab={setResultsTab}
              session={session}
              traceView={traceView}
              notice={exec.notice}
              runs={exec.runs}
              run={selectedRun}
              runTarget={runTarget}
              newCharts={newCharts}
              actions={resultsActions}
              onClose={() => setResultsOpen(false)}
            />
          </div>
        </main>

        {!narrow && assistantVisible && (
          <Resizer
            orientation="vertical"
            label="Resize assistant panel"
            value={prefs.assistantWidth}
            onResize={(start, delta) => setAssistantWidth(start - delta)}
          />
        )}
        <aside
          className={`assistant ${narrow ? 'is-overlay' : ''} ${assistantVisible ? 'is-open' : 'is-closed'}`}
          style={{ '--w': `${prefs.assistantWidth}px` }}
          {...inertProps(!assistantVisible)}
        >
          <AssistantPanel
            messages={assistant.messages}
            busy={assistant.busy}
            proposalView={proposalView}
            handlers={proposalHandlers}
            draftContext={assistant.draftContext}
            onRemoveContext={assistant.removeContext}
            onSend={(text) => sendPrompt(text)}
            onCancel={assistant.cancel}
            onSuggestion={(text) => sendPrompt(text)}
            onAction={(action) =>
              action.type === 'reset-file' ? resetFile(action.path) : action.type === 'open-ai-settings' && setAISettingsOpen(true)
            }
            aiModel={aiActive}
            onRetry={(r) => sendPrompt(r.prompt, { intent: r.intent, context: r.context })}
            composerRef={composerRef}
            onClose={closeAssistant}
            onConnectAI={IS_LOCAL ? () => setAISettingsOpen(true) : null}
            composerSuggestions={composerSuggestions}
            onGoToCode={(chip) => {
              ws.openFile(chip.path);
              setReviewingId(null);
              const lines = [];
              for (let l = chip.startLine; l <= chip.endLine; l++) lines.push(l);
              setRevealRequest({ path: chip.path, line: chip.startLine, key: Date.now() });
              setFlash({ path: chip.path, lines, key: Date.now() });
            }}
            onShowResults={(tab) => {
              setResultsTab(tab);
              setResultsOpen(true);
            }}
            project={{
              name: projectName,
              files: IS_LOCAL ? ws.fileOrder : null,
              activePath: ws.activePath,
              activeLines: ws.activePath ? (ws.files[ws.activePath] || '').split('\n').length : 0,
              dataset: datasetStats(ws.files[DATA_FILE]),
              lastRun: exec.runs.at(-1) || null,
            }}
          />
        </aside>

        {((compact && sidebarOverlay) || (narrow && assistantOverlay)) && (
          <div
            className="scrim"
            aria-hidden="true"
            onPointerDown={() => {
              setSidebarOverlay(false);
              setAssistantOverlay(false);
            }}
          />
        )}
      </div>

      <Toasts toasts={toasts} dismiss={dismiss} />
      <TooltipLayer />

      {expanded && exec.runs.length > 0 && (
        <ResultsDialog
          runs={exec.runs}
          initialA={expanded.a}
          initialB={expanded.b}
          onClose={() => setExpanded(null)}
          onAskModify={askToModifyChart}
        />
      )}

      {aiSettingsOpen && (
        <AISettingsDialog
          backend={backend}
          onClose={() => {
            setAISettingsOpen(false);
            refreshAI();
          }}
          onSaved={(message) => notify(message)}
        />
      )}

      {newFileOpen && (
        <NewFileDialog
          existing={ws.fileOrder}
          onClose={() => setNewFileOpen(false)}
          onCreate={async (path) => {
            await ws.createFile(path, '');
            setNewFileOpen(false);
            notify(`Created ${path}`);
          }}
        />
      )}

      {confirmReset && (
        <Dialog title="Reset demo" onClose={() => setConfirmReset(false)} className="dialog-confirm">
          <h2 className="dialog-title">Reset the demo?</h2>
          <p className="dialog-text">
            This restores the sample files and clears the conversation, runs, and layout settings saved in this
            browser.
          </p>
          <div className="dialog-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setConfirmReset(false)} data-autofocus>
              Cancel
            </button>
            <button type="button" className="btn btn-danger" onClick={resetDemo}>
              Reset demo
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
