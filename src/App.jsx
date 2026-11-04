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
import { applyGlass } from './lib/glass.js';
import { useWorkspace } from './state/useWorkspace.js';
import { useAssistant } from './state/useAssistant.js';
import { useExecution } from './state/useExecution.js';
import { useViewportWidth } from './state/useViewport.js';
import { runTargetFor } from './services/executionService.js';
import { TRACE, EXECUTABLE_LINES } from './services/traceService.js';
import { DEMO_PROMPTS } from './services/aiService.js';
import { DEBUG_FILE, PROJECT_NAME } from './data/sampleProject.js';
import { diffStats } from './lib/diff.js';
import { buildRunAnalysis, proposalForRun } from './services/analysisService.js';

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
  useEffect(() => applyGlass(prefs.glass), [prefs.glass]);
  const ws = useWorkspace(onSave);
  const exec = useExecution({ onSave });

  // Refs give async callbacks (AI requests, toasts) the latest state.
  const filesRef = useRef(ws.files);
  filesRef.current = ws.files;
  const activeRef = useRef(ws.activePath);
  activeRef.current = ws.activePath;
  const assistant = useAssistant({
    getFiles: useCallback(() => filesRef.current, []),
    getActivePath: useCallback(() => activeRef.current, []),
    onSave,
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
    if (exec.session) return;
    exec.run(runTarget, ws.files);
    setResultsOpen(true);
    setResultsTab('Output');
  };
  const handleTrace = (mode) => {
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

  const execLine =
    traceSession && !traceSession.finished && traceSession.path === ws.activePath
      ? TRACE.steps[traceSession.index].line
      : null;

  const toggleBreakpoint = (line) => {
    if (!EXECUTABLE_LINES.has(line)) {
      notify(`Line ${line} has no code to pause on.`);
      return;
    }
    ws.toggleBreakpoint(DEBUG_FILE, line);
  };

  const selectedRun = exec.runs.find((r) => r.id === exec.selectedRunId) || exec.runs.at(-1) || null;

  const resultsActions = {
    onRun: handleRun,
    onAskFix: askToFixRun,
    onGoToLine: (path, line) => {
      ws.openFile(path);
      setReviewingId(null);
      setRevealRequest({ path, line, key: Date.now() });
      setFlash({ path, lines: [line], key: Date.now() });
    },
    onResetFile: resetFile,
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
        projectName={PROJECT_NAME}
        saveState={saveState}
        run={{
          session,
          runTarget,
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
        onReset={() => setConfirmReset(true)}
        glass={prefs.glass}
        onGlass={(glass) => update({ glass })}
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
            projectName={PROJECT_NAME}
            runCount={exec.runs.length}
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
            breakpoints={ws.activePath === DEBUG_FILE ? debugBreakpoints : []}
            glyphEnabled={ws.activePath === DEBUG_FILE}
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
              onContinue: () => exec.continueTrace(debugBreakpoints),
              onRestart: () => traceSession && handleTrace(traceSession.mode),
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
            onAction={(action) => action.type === 'reset-file' && resetFile(action.path)}
            onRetry={(r) => sendPrompt(r.prompt, { intent: r.intent, context: r.context })}
            composerRef={composerRef}
            onClose={closeAssistant}
            composerSuggestions={composerSuggestions}
            project={{ name: PROJECT_NAME, activePath: ws.activePath, lastRun: exec.runs.at(-1) || null }}
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
