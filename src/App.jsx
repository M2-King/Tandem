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
import { useUpdates } from './state/useUpdates.js';
import UpdateBanner, { UpdatingOverlay } from './components/UpdateBanner.jsx';
import { DESKTOP } from './runtime/desktop.js';
import { applyGlass } from './lib/glass.js';
import { useWorkspace } from './state/useWorkspace.js';
import { requestedFile, useDiskWorkspace } from './state/useDiskWorkspace.js';
import { useRuntimeStatus } from './state/useRuntimeStatus.js';
import { IS_IPAD, IS_LOCAL, RUNTIME_CONFIG } from './runtime/config.js';
import { setupIpadShell } from './runtime/ipadShell.js';
import { createLocalBackend } from './runtime/localBackend.js';
import { createIpadBackend } from './runtime/ipadBackend.js';
import { RuntimeStatus, DemoBadge } from './components/RuntimeStatus.jsx';
import NewFileDialog from './components/NewFileDialog.jsx';
import EnvironmentDialog from './components/EnvironmentDialog.jsx';
import DatabasePanel from './components/DatabasePanel.jsx';
import SqlResults from './components/SqlResults.jsx';
import { useSqlWorkspace } from './state/useSqlWorkspace.js';
import { registerPythonCompletion } from './lib/pythonCompletion.js';
import { isSqlFile } from './lib/fileTypes.js';
import { isNotebook } from './lib/notebook.js';
import { closeNotebookSession, notebookSession } from './state/notebookSession.js';
import AISettingsDialog from './components/AISettingsDialog.jsx';
import AIChoiceDialog from './cowork/AIChoiceDialog.jsx';
import ProjectsDialog from './components/ProjectsDialog.jsx';
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
import { RunModeContext, COWORK_LIVE_RUN_MODE, COWORK_RUN_MODE, DEMO_RUN_MODE } from './lib/runMode.js';
import { useCowork } from './cowork/useCowork.js';
import { useCoworkLive } from './cowork/live/useCoworkLive.js';
import { COWORK_LIVE } from './cowork/live/api.js';
import { createCoworkBackend } from './cowork/coworkBackend.js';
import { createSharedBackend } from './cowork/live/sharedBackend.js';
import { Loader2 } from 'lucide-react';
import { useSharedPython } from './cowork/useSharedPython.js';
import { useSharedAI } from './cowork/live/useSharedAI.js';
import PreparePythonDialog from './cowork/PreparePythonDialog.jsx';
import { CursorReportContext, LiveTextContext } from './cowork/cursorReport.js';
import { AvatarStack, BackupsButton, CoworkTitle, DeviceChip, LiveStatus, PreviewMenu, SettingsButton, ShareButton, SyncStatus } from './cowork/CoworkBits.jsx';
import VersionsDialog from './cowork/VersionsDialog.jsx';
import { useVersions } from './cowork/live/useVersions.js';
import ProjectSettingsDialog from './cowork/ProjectSettingsDialog.jsx';
import { RemoveFileDialog, RenameFileDialog } from './cowork/FileDialogs.jsx';
import SharedProjectsPage from './cowork/SharedProjectsPage.jsx';
import SignInPage from './cowork/SignInPage.jsx';
import ShareDialog from './cowork/ShareDialog.jsx';
import NewSharedProjectDialog from './cowork/NewSharedProjectDialog.jsx';

const DATA_FILE = 'data/housing.csv';

// Real mode talks to the local runtime; Demo mode never does. Decided once.
setupIpadShell();
const backend = IS_IPAD ? createIpadBackend(RUNTIME_CONFIG) : IS_LOCAL ? createLocalBackend(RUNTIME_CONFIG) : null;

// Cowork: the sample preview (UI review) or live mode (Supabase), chosen
// when the app is built (VITE_COWORK_MODE). Fixed for the page's life, so
// the hook order is stable.
const useCoworkMode = COWORK_LIVE ? useCoworkLive : useCowork;
// Live mode runs shared projects with this device's own Python (the desktop
// runtime or Pyodide on iPad); a page without either can't.
const NO_DEVICE_PYTHON = 'Shared projects run with the Tandem app’s Python on Windows or iPad. This page has none.';

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

// Cowork live: the bar on a file a teammate changed while it had an edit here.
function conflictBar(cowork, path) {
  const c = path && cowork.conflicts?.[path];
  if (!c) return null;
  const choose = (choice) => () => cowork.resolveConflict(path, choice);
  if (c.kind === 'pending') {
    return { path, tone: 'warning', title: 'Someone else saved this file first.', text: 'Getting their version…' };
  }
  if (c.kind === 'removed') {
    return {
      path,
      tone: 'warning',
      title: 'A teammate removed this file.',
      text: 'Your edits are only on this device.',
      actions: [
        { label: 'Use theirs', onClick: choose('theirs') },
        { label: 'Keep mine', onClick: choose('mine'), primary: true },
      ],
    };
  }
  return {
    path,
    tone: 'warning',
    title: `${c.by || 'A teammate'} saved a newer version.`,
    text: 'Your edits here aren’t saved yet. Use theirs replaces your edits; Keep mine saves your text over theirs.',
    actions: [
      { label: 'Use theirs', onClick: choose('theirs') },
      { label: 'Keep mine', onClick: choose('mine'), primary: true },
    ],
  };
}

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
  const wall = useWallpaper(notify, IS_IPAD ? backend : null);
  const desktop = useDesktop(notify);
  const updates = useUpdates({ notify });
  const [updateConfirm, setUpdateConfirm] = useState(null); // reasons to confirm before restarting
  // In the desktop app the glass sits over the person's own wallpaper; its brightness comes from the system.
  const backdropLuminance = desktop.active ? (desktop.luminance ?? 0.3) : wall.luminance;
  useEffect(() => applyGlass(prefs.glass, prefs.frost, backdropLuminance), [prefs.glass, prefs.frost, backdropLuminance]);
  // IS_LOCAL never changes while the page is open, so the hook order is stable.
  const deviceWs = IS_LOCAL ? useDiskWorkspace(onSave, backend, { notify }) : useWorkspace(onSave);
  const deviceExec = useExecution({ onSave, backend });
  const runtime = useRuntimeStatus(backend);
  const deviceProjectName = IS_LOCAL ? deviceWs.project?.name || runtime.status?.project?.name || 'Project' : PROJECT_NAME;

  // Cowork preview: shared projects (sample data). A shared project uses the
  // same layout with its own files, and runs on "this device" (sample results).
  const cowork = useCoworkMode({ notify });
  const inCowork = cowork.screen === 'project';
  const onSharedHome = ['home', 'signin', 'opening', 'restoring'].includes(cowork.screen);
  const coworkRef = useRef(cowork);
  coworkRef.current = cowork;
  // The first run in a shared project on this device asks first.
  const [trustAsk, setTrustAsk] = useState(null); // { project, resolve }
  const coworkBackend = useMemo(
    () =>
      COWORK_LIVE
        ? createSharedBackend({
            device: backend,
            getProject: () => coworkRef.current.project,
            getFiles: () => coworkRef.current.workspace?.files || {},
            confirmTrust: (project) => new Promise((resolve) => setTrustAsk({ project, resolve })),
          })
        : createCoworkBackend({
            getProjectId: () => coworkRef.current.project?.id,
            getFiles: () => coworkRef.current.workspace?.files || {},
          }),
    []
  );
  const answerTrust = (yes) => {
    trustAsk?.resolve(yes);
    setTrustAsk(null);
  };
  const coworkExec = useExecution({ onSave, backend: coworkBackend, real: true });
  // Getting this computer ready to run shared projects ("Preparing Python").
  const pythonPrep = useSharedPython({ backend, enabled: !!cowork.live && IS_LOCAL });
  const preparePython = (title = 'Preparing Python') => pythonPrep.ensure({ title });
  // A shared project's run that couldn't start for lack of Python: offer to prepare it.
  const coworkNotice = coworkExec.notice;
  useEffect(() => {
    if (cowork.live && IS_LOCAL && /No Python interpreter/i.test(coworkNotice?.detail || '')) {
      notify('Shared projects need Python on this computer.', { label: 'Prepare Python', onClick: () => preparePython() });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coworkNotice]);
  const ws = inCowork ? cowork.workspace : deviceWs;
  const exec = inCowork ? coworkExec : deviceExec;
  const projectName = inCowork ? cowork.project.name : deviceProjectName;
  const [shareOpen, setShareOpen] = useState(false);
  const [newSharedOpen, setNewSharedOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [renaming, setRenaming] = useState(null); // file path
  const [removing, setRemoving] = useState(null); // file path
  const notebookKey = (path) => (inCowork ? `cowork:${cowork.project.id}/${path}` : path);

  // Opening a shared project fades its workspace in.
  const [entering, setEntering] = useState(false);
  useEffect(() => {
    if (!cowork.project?.id) return undefined;
    setEntering(true);
    const timer = setTimeout(() => setEntering(false), 700);
    return () => clearTimeout(timer);
  }, [cowork.project?.id]);

  // Leaving a shared project ends its notebooks' kernels and its runs.
  const coworkProjectId = cowork.project?.id || null;
  const lastShared = useRef(null);
  useEffect(() => {
    const left = lastShared.current;
    lastShared.current = coworkProjectId ? { id: coworkProjectId, paths: Object.keys(cowork.workspace.files) } : null;
    if (left && left.id !== coworkProjectId) {
      left.paths.filter(isNotebook).forEach((path) => closeNotebookSession(`cowork:${left.id}/${path}`));
      if (coworkExec.session && !coworkExec.session.finished) coworkExec.stop();
      coworkExec.reset();
      if (COWORK_LIVE) backend?.shared?.close(left.id); // its runs and kernels on this device
      setShareOpen(false);
      setSettingsOpen(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coworkProjectId]);

  // Shared projects' Python on this device (one choice for all of them).
  const [sharedPython, setSharedPython] = useState(null);
  const [sharedEnvTick, setSharedEnvTick] = useState(0);
  const liveShared = inCowork && cowork.live && !!backend?.forScope;
  useEffect(() => {
    if (!liveShared) return undefined;
    let live = true;
    backend
      .forScope('shared', coworkProjectId)
      .envs()
      .then(
        (r) => live && setSharedPython(r.current),
        () => live && setSharedPython(null)
      );
    return () => {
      live = false;
    };
  }, [liveShared, coworkProjectId, sharedEnvTick, runtime.connection]);

  const runBlocked = inCowork
    ? cowork.live
      ? !backend
        ? NO_DEVICE_PYTHON
        : runtime.connection !== 'connected'
          ? 'The Tandem runtime is disconnected'
          : null
      : null
    : !IS_LOCAL
    ? null
    : runtime.connection !== 'connected'
      ? 'The Tandem runtime is disconnected'
      : runtime.status && !runtime.status.python?.ok
        ? 'No Python interpreter found for this project'
        : null;
  const [newFileOpen, setNewFileOpen] = useState(null); // null, or the kind of file to start with
  const [envDialog, setEnvDialog] = useState(null); // { tab, focusModule }
  // Add files…: copy files from elsewhere (any kind) into the project.
  const addFiles = ws.addFiles;
  const handleAddFiles = useCallback(
    async (list) => {
      const chosen = Array.from(list || []);
      if (!chosen.length || !addFiles) return;
      const { added, failed } = await addFiles(chosen);
      if (added.length) notify(added.length === 1 ? `Added ${added[0]} to the project.` : `Added ${added.length} files: ${added.join(', ')}.`);
      if (failed.length) notify(`Couldn't add ${failed.join('; ')}.`);
    },
    [addFiles, notify]
  );
  const [aiSettingsOpen, setAISettingsOpen] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(false);

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
  // A live shared project: the AI an owner shares with it, used when this
  // device has no AI of its own (cowork-ai Edge Function; the key stays there).
  const sharedAI = useSharedAI({ projectId: cowork.live && inCowork ? cowork.project.id : null });
  // Backups and restore of the open shared project (and its automatic backups).
  const versions = useVersions({ cowork, projectId: cowork.live && inCowork ? cowork.project.id : null });
  const [backupsOpen, setBackupsOpen] = useState(false);
  const sharedAIRef = useRef(sharedAI);
  sharedAIRef.current = sharedAI;
  const realRequest = useMemo(
    () =>
      IS_LOCAL
        ? createRealAssistant({
            backend,
            getLastRun: (path) => runsRef.current.filter((r) => r.path === path).at(-1) || null,
            getModelLabel: () =>
              sharedAIRef.current.usesShared(!!aiActiveRef.current) ? sharedAIRef.current.share.model : aiActiveRef.current?.model,
            getShared: async () => {
              const s = sharedAIRef.current;
              if (!s.available) return null;
              const useShared = s.usesShared(!!aiActiveRef.current);
              // The shared AI reads the files from the project: save edits still waiting first.
              if (useShared) await coworkRef.current.flushSaves?.().catch(() => {});
              const shared_ai = useShared ? await s.access() : null;
              return { file_list: Object.keys(filesRef.current), ...(shared_ai ? { shared_ai } : {}) };
            },
            onShared: (used) => sharedAIRef.current.noteUse(used),
          })
        : undefined,
    []
  );
  const share = sharedAI.share;
  const assistantModel =
    (sharedAI.usesShared(!!aiActive)
      ? {
          label: `Shared by ${share.shared_by_me ? 'you' : share.shared_by}`,
          model: share.model,
          shared: true,
          note: share.shared_by_me
            ? 'You share this AI with the project. Your own requests have no limit.'
            : `${share.used_today} of ${share.daily_limit} requests used today.`,
        }
      : null) || aiActive;
  // In a shared project with a shared AI, "AI settings" first asks which AI to use here.
  const [aiChoiceOpen, setAIChoiceOpen] = useState(false);
  const openAISettings = useCallback(() => (sharedAIRef.current.share ? setAIChoiceOpen(true) : setAISettingsOpen(true)), []);
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

  // Restart into a downloaded update. Edits are saved first; anything that
  // would be lost (a failed save, a shared file not yet saved, running code)
  // is confirmed. The desktop app then stops the Python runtime, installs
  // silently and reopens.
  const restartToUpdate = async (confirmed = false) => {
    const reasons = [];
    if (exec.session && !exec.session.finished) reasons.push('The code that is running will stop.');
    if (saveState === 'failed') reasons.push('A file couldn’t be saved to disk, so its latest changes will be lost.');
    if (['unsaved', 'saving', 'offline', 'conflict'].includes(cowork.sync)) reasons.push('A shared file has changes that aren’t saved yet. Copy them first if the save keeps failing.');
    if (!confirmed && reasons.length) {
      setUpdateConfirm(reasons);
      return;
    }
    setUpdateConfirm(null);
    try {
      await deviceWs.flush?.();
    } catch {
      // the save status shows the failure
    }
    const started = await updates.install().catch(() => false);
    if (!started) notify('The update isn’t ready to install. Try Check for updates in the ⋯ menu.');
  };
  const composerRef = useRef(null);
  const assistantToggleRef = useRef(null);
  const centerRef = useRef(null);

  // Moving between shared projects and this device closes the drawers.
  useEffect(() => {
    setSidebarOverlay(false);
    setAssistantOverlay(false);
  }, [cowork.screen, cowork.project?.id]);

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

  const runTarget = inCowork
    ? ws.activePath?.endsWith('.py')
      ? ws.activePath
      : ws.fileOrder.find((p) => p.endsWith('.py')) || ws.activePath
    : runTargetFor(ws.activePath);
  // The open notebook (a session per notebook tab keeps its kernel and outputs).
  const activeNotebook =
    (IS_LOCAL || inCowork) && isNotebook(ws.activePath) && ws.files[ws.activePath] !== undefined
      ? notebookSession(notebookKey(ws.activePath), {
          text: ws.files[ws.activePath],
          backend: inCowork ? coworkBackend : backend,
          save: ((path) => (text) => ws.setFile(path, text))(ws.activePath),
        })
      : null;
  // Shared projects: the open notebook follows its live document both ways
  // (cells typed live, cells added, moved and removed, outputs).
  const liveNotebookEntry = activeNotebook && inCowork && cowork.live ? cowork.liveText?.entry(ws.activePath) || null : null;
  useEffect(() => {
    if (!activeNotebook || !liveNotebookEntry) return undefined;
    const path = ws.activePath;
    return activeNotebook.attachLive({ entry: liveNotebookEntry, sync: (text) => coworkRef.current.liveText?.setText(path, text) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeNotebook, liveNotebookEntry]);
  // SQL workspace (the Python | SQL switch in the toolbar).
  const sqlMode = IS_LOCAL && !inCowork && prefs.workspace === 'sql';
  const sql = useSqlWorkspace({ backend, ws, notify, active: sqlMode });
  const caretRef = useRef({ path: null, text: null }); // the editor's last selection
  const runSql = (selected) => {
    const path = ws.activePath;
    if (!isSqlFile(path)) {
      notify('Open a .sql file to run SQL, or create one with + (choose SQL).');
      return;
    }
    const chosen = selected ?? (caretRef.current.path === path ? caretRef.current.text : null);
    sql.run(chosen || ws.files[path] || '', { label: chosen ? `Selection in ${path}` : null });
    setResultsOpen(true);
  };
  const setWorkspace = (workspace) => update({ workspace });
  // A file opened from Explorer ("Open with Tandem") shows in its own
  // workspace: SQL files in SQL, Python files and notebooks in Python.
  const workspaceFor = (path) => (isSqlFile(path) ? 'sql' : /\.(py|pyw|ipynb)$/i.test(path) ? 'python' : null);
  useEffect(() => {
    const opened = IS_LOCAL ? requestedFile() : null;
    if (opened && workspaceFor(opened)) update({ workspace: workspaceFor(opened) });
  }, []);
  // Files from Explorer belong to this device's project (never a shared one):
  // leave a shared project or the shared projects page for it.
  const openFromOutside = deviceWs.openFromOutside;
  const goLocal = cowork.go;
  useEffect(
    () =>
      DESKTOP?.onOpenFile?.(async (path) => {
        goLocal('local');
        if (!(await openFromOutside(path))) return;
        if (workspaceFor(path)) update({ workspace: workspaceFor(path) });
      }),
    [openFromOutside, goLocal, update]
  );
  // Python completion in the editor (Jedi via the runtime, or inside Python on iPad).
  useEffect(() => {
    if (IS_LOCAL) registerPythonCompletion(backend);
  }, []);

  // Stop from anywhere: Ctrl/Cmd+F2 (as in PyCharm) or Ctrl/Cmd+. — press
  // again to end the run at once.
  const stopKeys = useRef(null);
  stopKeys.current = () => {
    if (sqlMode && sql.status === 'running') return sql.stop();
    if (exec.session && !exec.session.finished) exec.stop();
    return undefined;
  };
  useEffect(() => {
    const onKey = (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === 'F2' || e.key === '.')) {
        e.preventDefault();
        e.stopPropagation();
        stopKeys.current?.();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const closeTab = (path) => {
    if (isNotebook(path)) closeNotebookSession(notebookKey(path));
    ws.closeTab(path);
  };
  const debugBreakpoints = ws.breakpoints[DEBUG_FILE] || [];

  const handleRun = () => {
    if (sqlMode) return runSql();
    if (activeNotebook) return activeNotebook.runAll(); // Run on a notebook: run all its cells
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
    onStop: IS_LOCAL || inCowork ? () => exec.stop() : null,
    onInstallModule: IS_LOCAL ? (module) => setEnvDialog({ tab: 'packages', focusModule: module }) : null,
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

  // Cowork: who is here and where. Teammates aren't shown while reconnecting.
  const offline = cowork.sync === 'reconnecting';
  const peers = inCowork && !offline ? cowork.presence : [];
  const cursorOf = (p) => ({ id: p.person, name: p.name, hue: p.hue, path: p.path, step: p.step });
  const remoteCursors = peers.filter((p) => !p.cell).map(cursorOf);
  const notebookPresence = {};
  peers.filter((p) => p.cell && p.path === ws.activePath).forEach((p) => (notebookPresence[p.cell] ||= []).push(cursorOf(p)));
  const filePresence = {};
  peers.forEach((p) => (filePresence[p.path] ||= []).push(cursorOf(p)));
  // You first, then everyone else in the project.
  const peopleEntries = inCowork
    ? [...cowork.project.members].sort((a, b) => (b.id === cowork.viewer.id) - (a.id === cowork.viewer.id)).map((m) => {
        const here = cowork.presence.find((p) => p.person === m.id);
        return { person: cowork.people[m.id], you: m.id === cowork.viewer.id, online: m.id === cowork.viewer.id || !!here, where: offline ? null : here?.path };
      })
    : [];
  const openShare = () => {
    setShareOpen(true);
    cowork.refreshPeople?.(); // live: who joined since the project was opened
  };
  // You, just joined: your avatar arrives in the people list.
  const arrivingId = inCowork && cowork.arrival?.project === cowork.project.id ? cowork.arrival.person : null;
  const coworkControls = inCowork && (
    <>
      <AvatarStack entries={peopleEntries} onClick={openShare} offline={offline} arrivingId={arrivingId} />
      <SyncStatus sync={cowork.sync} />
      {cowork.live && <LiveStatus state={cowork.presenceState} reason={cowork.presenceReason} />}
      {cowork.live && <BackupsButton onClick={() => setBackupsOpen(true)} />}
      <ShareButton onClick={openShare} />
      <SettingsButton onClick={() => setSettingsOpen(true)} />
    </>
  );
  // Files in a shared project: everyone renames; owners remove.
  const fileActions = inCowork
    ? {
        canRemove: cowork.can(cowork.project, 'removeFiles'),
        onRename: (path) => setRenaming(path),
        onRemove: (path) => setRemoving(path),
      }
    : null;
  const inertProps = (hidden) => (hidden ? { inert: '', 'aria-hidden': true } : {});

  return (
    <RunModeContext.Provider value={inCowork ? (cowork.live ? COWORK_LIVE_RUN_MODE : COWORK_RUN_MODE) : DEMO_RUN_MODE}>
    <CursorReportContext.Provider value={inCowork && cowork.live ? cowork.reportCursor : null}>
    <LiveTextContext.Provider value={inCowork && cowork.live ? cowork.liveText || null : null}>
    <div className={`app ${inCowork || onSharedHome ? 'is-cowork' : ''}`}>
      <Toolbar
        titleSlot={
          inCowork || onSharedHome ? (
            <CoworkTitle cowork={cowork}>{inCowork && <span className="cowork-inline">{coworkControls}</span>}</CoworkTitle>
          ) : undefined
        }
        beforeRun={
          inCowork && !cowork.live ? (
            <span className="toolbar-device">
              <DeviceChip />
            </span>
          ) : liveShared ? (
            <span className="toolbar-device shared-python" data-tooltip="Shared projects run here, with this device’s Python. Everyone runs on their own device.">
              <RuntimeStatus
                connection={runtime.connection}
                status={{ python: sharedPython ? { ok: true, ...sharedPython } : runtime.status?.python }}
                error={runtime.error}
                onOpenEnv={(tab) => setEnvDialog({ tab, scope: 'shared' })}
              />
            </span>
          ) : null
        }
        hideWork={onSharedHome}
        onSharedProjects={onSharedHome ? null : () => cowork.go('home')}
        projectName={projectName}
        modeBadge={IS_LOCAL ? <RuntimeStatus {...runtime} onOpenEnv={(tab) => setEnvDialog({ tab })} /> : <DemoBadge />}
        savesToDisk={IS_LOCAL}
        saveState={saveState}
        run={
          inCowork && !cowork.live
            ? {
                session,
                runTarget: activeNotebook ? ws.activePath : runTarget,
                simple: true,
                blockedReason: runBlocked,
                runTooltip: activeNotebook ? 'Run all cells on this device' : `Run ${runTarget} on this device`,
                onRun: handleRun,
                onStop: exec.stop,
              }
            : sqlMode
            ? {
                session: sql.status === 'running' ? { mode: 'run', path: 'SQL', finished: false } : null,
                runTarget: ws.activePath,
                simple: true,
                runTooltip: 'Run the SQL file, or only the selected part (Ctrl/Cmd+Enter)',
                onRun: handleRun,
                onStop: sql.stop,
              }
            : {
                session,
                runTarget,
                blockedReason: runBlocked,
                traceNote: null,
                onRun: handleRun,
                onStep: () => handleTrace('step'),
                onDebug: () => handleTrace('debug'),
                onStop: exec.stop,
              }
        }
        workspace={IS_LOCAL && !inCowork ? prefs.workspace || 'python' : null}
        onWorkspace={IS_LOCAL && !inCowork ? setWorkspace : null}
        panels={{
          files: { open: sidebarVisible, toggle: toggleFiles },
          results: { open: resultsOpen, toggle: () => setResultsOpen((o) => !o) },
          assistant: { open: assistantVisible, toggle: toggleAssistant, toggleRef: assistantToggleRef },
        }}
        fontSize={prefs.fontSize}
        onFontSize={changeFontSize}
        diffInline={prefs.diffInline}
        onDiffInline={(inline) => update({ diffInline: inline })}
        onReset={IS_LOCAL || inCowork || onSharedHome ? null : () => setConfirmReset(true)}
        onAISettings={IS_LOCAL ? openAISettings : null}
        onAddFiles={IS_LOCAL && !inCowork ? handleAddFiles : null}
        desktop={{ ...desktop, setMaterial: (m) => desktop.setMaterial(m, { busy: !!exec.session }) }}
        onOpenFolder={
          inCowork || onSharedHome
            ? null
            : IS_IPAD
            ? async () => {
                await ws.flush?.();
                setProjectsOpen(true);
              }
            : DESKTOP
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
        updates={updates.supported ? updates : null}
        onRestartToUpdate={() => restartToUpdate()}
      />
      {updates.banner && (
        <UpdateBanner
          kind={updates.banner}
          state={updates.state}
          onLater={updates.later}
          onDismiss={updates.dismiss}
          onRestart={() => restartToUpdate()}
        />
      )}
      {updates.installing && <UpdatingOverlay name={updates.state?.name || 'Tandem'} version={updates.installing} />}

      {inCowork && (
        // Narrow windows: the project's people, status and Share sit under the toolbar.
        <div className="cowork-strip" role="region" aria-label={`${cowork.project.name}: people and status`}>
          <AvatarStack entries={peopleEntries} onClick={openShare} offline={offline} arrivingId={arrivingId} />
          <SyncStatus sync={cowork.sync} />
          {cowork.live && <LiveStatus state={cowork.presenceState} reason={cowork.presenceReason} />}
          {!cowork.live && <PreviewMenu cowork={cowork} inProject />}
          {!cowork.live && <DeviceChip />}
          {cowork.live && <BackupsButton onClick={() => setBackupsOpen(true)} />}
          <ShareButton onClick={openShare} />
          <SettingsButton onClick={() => setSettingsOpen(true)} />
        </div>
      )}
      {onSharedHome ? (
        <div className="workspace">
          <NavRail shared={{ active: true, onOpen: () => {} }} home />
          <main className="center shared-center">
            {cowork.screen === 'signin' ? (
              <SignInPage cowork={cowork} localName={deviceProjectName} notify={notify} />
            ) : cowork.screen === 'restoring' ? (
              <div className="shared-page">
                <div className="shared-inner">
                  <p className="shared-opening" role="status">
                    <Loader2 size={14} className="spin" aria-hidden="true" /> Signing in…
                  </p>
                </div>
              </div>
            ) : (
              <SharedProjectsPage
                cowork={cowork}
                prepare={(name, then) =>
                  pythonPrep.ensure({ title: `Getting ready for ${name}`, quiet: true, final: then ? { label: `Opening “${name}”`, run: then } : null })
                }
                localName={deviceProjectName}
                onOpenLocal={() => cowork.go('local')}
                onNew={() => setNewSharedOpen(true)}
              />
            )}
          </main>
        </div>
      ) : (
      <div className={`workspace ${entering ? 'cw-enter' : ''}`}>
        <NavRail
          shared={{ active: false, onOpen: () => cowork.go('home'), badge: cowork.invitations.length > 0 }}
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
          <div className="sidebar-stack" style={{ '--w': `${prefs.sidebarWidth}px` }}>
          {sqlMode && (
            <DatabasePanel
              sql={sql}
              onNewDatabase={() => setNewFileOpen('database')}
              onPreview={(table) => {
                sql.preview(table);
                setResultsOpen(true);
              }}
            />
          )}
          <FileSidebar
            paths={ws.fileOrder}
            activePath={ws.activePath}
            onOpen={openFile}
            projectName={projectName}
            runCount={exec.runs.length}
            onNewFile={IS_LOCAL || inCowork ? () => setNewFileOpen(sqlMode ? 'sql' : 'python') : null}
            onAddFiles={inCowork ? ws.uploadFiles : IS_LOCAL ? handleAddFiles : null}
            addFilesLabel={inCowork ? 'Upload files…' : null}
            fileActions={fileActions}
            presence={filePresence}
            projectNav={{ label: 'Shared projects', back: inCowork, onClick: () => cowork.go('home') }}
            footerMeta={inCowork ? `${cowork.project.members.length} people` : null}
          />
          </div>
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
            onCloseTab={closeTab}
            notebook={activeNotebook}
            onInstallPackage={(name) => setEnvDialog({ tab: 'packages', focusModule: name })}
            onRunShortcut={sqlMode && isSqlFile(ws.activePath) ? (selected) => runSql(selected) : undefined}
            onCaret={(path, text) => {
              caretRef.current = { path, text };
            }}
            remoteCursors={remoteCursors}
            notebookPresence={notebookPresence}
            kernelNote={inCowork ? (cowork.live ? 'this device' : 'this device · preview') : null}
            fileBar={inCowork ? conflictBar(cowork, ws.activePath) : null}
            onOpenDatabase={
              IS_LOCAL && !inCowork
                ? (path) => {
                    setWorkspace('sql');
                    sql.open(path);
                  }
                : null
            }
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
            {sqlMode ? (
              <SqlResults sql={sql} onClose={() => setResultsOpen(false)} onRerun={(text) => sql.run(text)} notify={notify} />
            ) : (
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
            )}
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
              action.type === 'reset-file' ? resetFile(action.path) : action.type === 'open-ai-settings' && openAISettings()
            }
            aiModel={assistantModel}
            onRetry={(r) => sendPrompt(r.prompt, { intent: r.intent, context: r.context })}
            composerRef={composerRef}
            onClose={closeAssistant}
            onConnectAI={IS_LOCAL ? openAISettings : null}
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
              files: IS_LOCAL || inCowork ? ws.fileOrder : null,
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
      )}

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

      {projectsOpen && <ProjectsDialog backend={backend} onClose={() => setProjectsOpen(false)} />}

      {backupsOpen && inCowork && cowork.live && (
        <VersionsDialog
          versions={versions}
          project={cowork.project}
          isOwner={cowork.roleIn(cowork.project) === 'owner'}
          me={cowork.viewer?.id}
          files={ws.files}
          notify={notify}
          onClose={() => setBackupsOpen(false)}
        />
      )}
      {aiChoiceOpen && share && (
        <AIChoiceDialog
          share={share}
          projectName={projectName}
          usingShared={sharedAI.usesShared(!!aiActive)}
          ownAI={aiActive}
          onUseShared={() => {
            sharedAI.choose('shared');
            setAIChoiceOpen(false);
            notify(`${projectName} uses the shared AI on this device.`);
          }}
          onUseOwn={() => {
            sharedAI.choose('own');
            setAIChoiceOpen(false);
            setAISettingsOpen(true);
          }}
          onClose={() => setAIChoiceOpen(false)}
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

      {envDialog && backend && (
        <EnvironmentDialog
          backend={envDialog.scope === 'shared' ? backend.forScope('shared', coworkProjectId) : backend}
          initialTab={envDialog.tab}
          focusModule={envDialog.focusModule}
          runActive={!!exec.session && !exec.session.finished}
          onClose={() => setEnvDialog(null)}
          onChanged={() => {
            runtime.refresh();
            setSharedEnvTick((n) => n + 1);
          }}
        />
      )}
      {newFileOpen && (
        <NewFileDialog
          existing={ws.fileOrder}
          initialType={newFileOpen}
          onClose={() => setNewFileOpen(null)}
          onCreate={async (path, { text, type }) => {
            if (type === 'database' && inCowork) {
              notify('SQLite databases aren’t part of the Cowork preview yet.');
              return;
            }
            if (type === 'database') {
              // A SQLite database: a real (empty) database file, opened in the SQL workspace.
              await sql.create(path);
              setWorkspace('sql');
            } else {
              await ws.createFile(path, text);
              notify(`Created ${path}`);
            }
            setNewFileOpen(null);
          }}
        />
      )}

      {shareOpen && inCowork && (
        <ShareDialog cowork={cowork} project={cowork.project} presence={cowork.presence} onClose={() => setShareOpen(false)} notify={notify} sharedAI={sharedAI} />
      )}
      {settingsOpen && inCowork && (
        <ProjectSettingsDialog cowork={cowork} project={cowork.project} onClose={() => setSettingsOpen(false)} notify={notify} />
      )}
      {renaming && inCowork && (
        <RenameFileDialog
          path={renaming}
          onClose={() => setRenaming(null)}
          onRename={async (to) => {
            const from = renaming;
            const problem = await ws.renameFile(from, to);
            if (!problem && to.trim() !== from) {
              if (isNotebook(from)) closeNotebookSession(notebookKey(from));
              notify(`Renamed ${from} to ${to.trim()}.`);
            }
            return problem;
          }}
        />
      )}
      {removing && inCowork && (
        <RemoveFileDialog
          path={removing}
          projectName={cowork.project.name}
          onClose={() => setRemoving(null)}
          onRemove={() => {
            if (isNotebook(removing)) closeNotebookSession(notebookKey(removing));
            ws.removeFile(removing);
          }}
        />
      )}
      {newSharedOpen && (
        <NewSharedProjectDialog
          existing={cowork.projects}
          onClose={() => setNewSharedOpen(false)}
          startsEmpty={!!cowork.live}
          onCreate={async (name) => {
            setNewSharedOpen(false);
            // Get this computer ready (once), then create the project.
            let id = null;
            const ok = await pythonPrep.ensure({
              title: `Setting up ${name}`,
              final: {
                label: `Creating “${name}”`,
                run: async () => {
                  id = await cowork.createProject(name);
                  return !!id;
                },
                failed: 'The project couldn’t be created. Try again.',
              },
            });
            if (ok && id) notify(`Created ${name}. Invite people from Share.`);
          }}
        />
      )}

      <PreparePythonDialog prep={pythonPrep.state} onRetry={pythonPrep.retry} onSkip={pythonPrep.skip} onCancel={pythonPrep.cancel} />

      {trustAsk && (
        <Dialog title="Run shared code on this device" onClose={() => answerTrust(false)} className="dialog-confirm">
          <h2 className="dialog-title">Run code from {trustAsk.project.name}?</h2>
          <p className="dialog-text">
            Code in {trustAsk.project.name} runs on this device with your permissions. Run it only if you trust its members.
          </p>
          <p className="dialog-text">Tandem asks once for each shared project on this device.</p>
          <div className="dialog-actions">
            <button type="button" className="btn btn-secondary" onClick={() => answerTrust(false)} data-autofocus>
              Don’t run
            </button>
            <button type="button" className="btn btn-primary" onClick={() => answerTrust(true)}>
              Run on this device
            </button>
          </div>
        </Dialog>
      )}

      {updateConfirm && (
        <Dialog title="Restart to update" onClose={() => setUpdateConfirm(null)} className="dialog-confirm">
          <h2 className="dialog-title">Restart to update now?</h2>
          {updateConfirm.map((r) => (
            <p key={r} className="dialog-text">
              {r}
            </p>
          ))}
          <p className="dialog-text">Choose Later to keep working; the update installs when you quit Tandem.</p>
          <div className="dialog-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setUpdateConfirm(null);
                updates.later();
              }}
              data-autofocus
            >
              Later
            </button>
            <button type="button" className="btn btn-primary" onClick={() => restartToUpdate(true)}>
              Restart anyway
            </button>
          </div>
        </Dialog>
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
    </LiveTextContext.Provider>
    </CursorReportContext.Provider>
    </RunModeContext.Provider>
  );
}
