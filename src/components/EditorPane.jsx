import { useEffect, useRef, useState } from 'react';
import { PencilLine, CornerDownLeft, X, ChevronUp, ChevronDown, FileCode2, FileSpreadsheet, FileDiff, MessageSquarePlus, MessageSquareText, Wrench, Check, AlertTriangle, StepForward, FastForward, RotateCcw, Square, Bug, Footprints, Info, CircleCheck, ArrowDownToLine, ArrowUpFromLine, Loader2 } from 'lucide-react';
import CodeEditor from './CodeEditor.jsx';
import { focusLastEditor } from '../lib/editorRegistry.js';
import NotebookView from './NotebookView.jsx';
import { isDatabase, typeOf } from '../lib/fileTypes.js';
import DiffReview from './DiffReview.jsx';
import { TRACE } from '../services/traceService.js';
import { SAMPLE_FILES } from '../data/sampleProject.js';

const iconFor = (path) => (path.endsWith('.csv') ? FileSpreadsheet : FileCode2);
const fileName = (path) => path.split('/').pop();

// "Python · 64 lines" / "CSV · 40 rows", from the file as it is now.
function fileMeta(path, text = '') {
  const lines = text.split('\n').length;
  if (path.endsWith('.ipynb')) {
    try {
      return `Notebook · ${JSON.parse(text).cells.length} cells`;
    } catch {
      return 'Notebook';
    }
  }
  if (path.endsWith('.csv')) return `CSV · ${Math.max(0, text.trim().split('\n').length - 1)} rows`;
  return `${typeOf(path)?.label ?? 'Text'} · ${lines} lines`;
}

function Tabs({ openTabs, activePath, onSelect, onClose, reviewPath, files }) {
  return (
    <div className="tab-bar">
      <div className="tab-list" role="tablist" aria-label="Open files">
      {openTabs.map((path) => {
        const Icon = iconFor(path);
        const active = path === activePath;
        const edited = path in SAMPLE_FILES && files[path] !== SAMPLE_FILES[path];
        return (
          <div key={path} className={`tab ${active ? 'is-active' : ''}`}>
            <button
              type="button"
              role="tab"
              aria-selected={active}
              className="tab-label"
              onClick={() => onSelect(path)}
              onAuxClick={(e) => e.button === 1 && onClose(path)}
              title={path}
            >
              <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
              <span>{fileName(path)}</span>
              {edited && (
                <span className="tab-edited" data-tooltip="Changed from the sample">
                  <span className="sr-only">(edited)</span>
                </span>
              )}
              {path === reviewPath && (
                <span className="tab-badge" data-tooltip="Change ready for review">
                  Review
                </span>
              )}
            </button>
            <button
              type="button"
              className="tab-close"
              aria-label={`Close ${fileName(path)}`}
              onClick={() => onClose(path)}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        );
      })}
      </div>
      {activePath && <span className="editor-meta">{fileMeta(activePath, files[activePath])}</span>}
    </div>
  );
}

const MOD_KEY = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

// One place to review a change: what it is and why, step through each
// changed section, then accept or reject. Shortcuts: F7 / Shift+F7 move
// between changes, Ctrl/⌘ Enter accepts, Esc (in the editor) goes back to editing.
function ReviewBar({ review, nav, onAccept, onReject, onClose, onRegenerate, onDiscard, onStopAndApply }) {
  const { proposal, stale, blockedBy } = review;
  if (stale) {
    return (
      <div className="editor-banner banner-warning" role="status">
        <AlertTriangle size={16} aria-hidden="true" />
        <span className="banner-text">
          <strong>{proposal.path} changed after this proposal was created.</strong> Applying it could overwrite your newer
          edits.
        </span>
        <div className="banner-actions">
          <button type="button" className="btn btn-secondary btn-sm" onClick={onDiscard}>
            Discard proposal
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={onRegenerate}>
            Regenerate
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="editor-banner banner-review" role="region" aria-label="Review proposed change">
      <FileDiff size={16} aria-hidden="true" className="banner-icon-accent" />
      <div className="banner-text review-text">
        <span className="review-title">
          <strong>Review proposed change</strong>
          <span className="diff-stat">
            <span className="diff-add">+{proposal.added}</span> <span className="diff-del">−{proposal.removed}</span>
          </span>
        </span>
        {proposal.reason && <span className="review-reason">{proposal.reason}</span>}
        {blockedBy && <span className="banner-note">Stop the current run before applying.</span>}
      </div>
      <div className="banner-actions">
        {nav && nav.count > 1 && (
          <div className="change-nav" role="group" aria-label="Changed sections">
            <button
              type="button"
              className="icon-btn icon-btn-sm"
              aria-label="Previous change"
              data-tooltip="Previous change (Shift+F7)"
              onClick={nav.prev}
            >
              <ChevronUp size={16} aria-hidden="true" />
            </button>
            <span className="change-count" aria-live="polite">
              {nav.index >= 0 ? nav.index + 1 : '–'} of {nav.count}
            </span>
            <button
              type="button"
              className="icon-btn icon-btn-sm"
              aria-label="Next change"
              data-tooltip="Next change (F7)"
              onClick={nav.next}
            >
              <ChevronDown size={16} aria-hidden="true" />
            </button>
          </div>
        )}
        {nav && nav.count === 1 && <span className="change-count">1 change</span>}
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} data-tooltip="Esc">
          Back to editing
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onReject}>
          <X size={16} aria-hidden="true" /> Reject
        </button>
        {blockedBy ? (
          <button type="button" className="btn btn-primary btn-sm" onClick={onStopAndApply}>
            <Square size={12} fill="currentColor" aria-hidden="true" /> Stop and accept
          </button>
        ) : (
          <button type="button" className="btn btn-primary btn-sm" onClick={onAccept} data-tooltip={`Accept (${MOD_KEY} Enter)`}>
            <Check size={16} aria-hidden="true" /> Accept
          </button>
        )}
      </div>
    </div>
  );
}

// Step through / Debug of real code (Python's debugger in the runtime).
function RealSessionBar({ session, onNext, onStepIn, onStepOut, onContinue, onRestart, onStop }) {
  const isDebug = session.mode === 'debug';
  const p = session.paused;
  const paused = p && !session.running && !session.finished;
  let message;
  if (session.finished) {
    message =
      session.noBreakpointHit ? (
        <>
          <strong>No breakpoints were hit.</strong> Click beside a line number to add one, then restart.
        </>
      ) : (
        <>
          <strong>{session.status === 'stopped' ? 'Stopped.' : session.status === 'error' ? 'Ended with an error.' : 'Finished.'}</strong>
          <span className="banner-sub">Results are in the Output and Runs tabs.</span>
        </>
      );
  } else if (paused) {
    message = (
      <>
        <strong>{p.reason === 'breakpoint' ? `Breakpoint · line ${p.line}` : `Next line: ${p.line}`}</strong>
        <span className="banner-sub">
          {p.function === '<module>' ? p.path : `in ${p.function}() · ${p.path}`}
        </span>
      </>
    );
  } else {
    message = (
      <>
        <strong>Running…</strong>
        <span className="banner-sub">{isDebug ? 'until a breakpoint' : 'to the next line'}</span>
      </>
    );
  }
  return (
    <div className="editor-banner banner-session" role="region" aria-label={isDebug ? 'Debugger' : 'Step through'}>
      {session.finished ? (
        <CircleCheck size={16} aria-hidden="true" className="banner-icon-success" />
      ) : !paused ? (
        <Loader2 size={16} aria-hidden="true" className="banner-icon-accent spin" />
      ) : isDebug ? (
        <Bug size={16} aria-hidden="true" className="banner-icon-accent" />
      ) : (
        <Footprints size={16} aria-hidden="true" className="banner-icon-accent" />
      )}
      <span className="banner-text" aria-live="polite">
        {message}
      </span>
      <div className="banner-actions">
        {!session.finished && (
          <>
            <button type="button" className="btn btn-primary btn-sm" onClick={onNext} disabled={!paused} data-tooltip="Run this line (F10)">
              <StepForward size={16} aria-hidden="true" /> Next
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={onStepIn} disabled={!paused} data-tooltip="Go into the function this line calls (F11)">
              <ArrowDownToLine size={16} aria-hidden="true" /> Into
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={onStepOut} disabled={!paused || p?.function === '<module>'} data-tooltip="Finish this function (Shift+F11)">
              <ArrowUpFromLine size={16} aria-hidden="true" /> Out
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={onContinue} disabled={!paused} data-tooltip="Run to the next breakpoint (F5)">
              <FastForward size={16} aria-hidden="true" /> Continue
            </button>
          </>
        )}
        <button type="button" className="btn btn-secondary btn-sm" onClick={onRestart}>
          <RotateCcw size={16} aria-hidden="true" /> Restart
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onStop}>
          {session.finished ? 'Close' : 'Stop'}
        </button>
      </div>
    </div>
  );
}

function SessionBar(props) {
  const { session, onNext, onContinue, onRestart, onStop } = props;
  if (session.real) return <RealSessionBar {...props} />;
  const step = TRACE.steps[session.index];
  const total = TRACE.steps.length;
  const isDebug = session.mode === 'debug';
  let message;
  if (session.finished) {
    message = session.noBreakpointHit ? (
      <>
        <strong>No breakpoints were hit.</strong> Click beside a line number to add one, then restart.
      </>
    ) : (
      <>
        <strong>Finished.</strong> The program ran to the end.
      </>
    );
  } else {
    message = (
      <>
        <strong>{isDebug ? `Paused at line ${step.line}` : `Next line: ${step.line}`}</strong>
        <span className="banner-sub">
          {isDebug ? 'Breakpoint · ' : ''}Step {session.index + 1} of {total}
        </span>
      </>
    );
  }
  return (
    <div className="editor-banner banner-session" role="region" aria-label={isDebug ? 'Debugger' : 'Step through'}>
      {session.finished ? (
        <CircleCheck size={16} aria-hidden="true" className="banner-icon-success" />
      ) : isDebug ? (
        <Bug size={16} aria-hidden="true" className="banner-icon-accent" />
      ) : (
        <Footprints size={16} aria-hidden="true" className="banner-icon-accent" />
      )}
      <span className="banner-text" aria-live="polite">
        {message}
        <span className="sim-tag" data-tooltip="Uses a prepared trace of the sample code. Nothing is executed.">
          Simulated
        </span>
      </span>
      <div className="banner-actions">
        {!session.finished && (
          <>
            <button type="button" className="btn btn-primary btn-sm" onClick={onNext}>
              <StepForward size={16} aria-hidden="true" /> {isDebug ? 'Step' : 'Next'}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={onContinue}>
              <FastForward size={16} aria-hidden="true" /> Continue
            </button>
          </>
        )}
        <button type="button" className="btn btn-secondary btn-sm" onClick={onRestart}>
          <RotateCcw size={16} aria-hidden="true" /> Restart
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onStop}>
          {session.finished ? 'Close' : 'Stop'}
        </button>
      </div>
    </div>
  );
}

function NoticeBar({ notice, onReset, onDismiss }) {
  return (
    <div className="editor-banner banner-warning" role="status">
      <Info size={16} aria-hidden="true" />
      <span className="banner-text">
        <strong>{notice.title}.</strong> Your edits are saved.
      </span>
      <div className="banner-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onDismiss}>
          Dismiss
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => onReset(notice.resetPath)}>
          <RotateCcw size={16} aria-hidden="true" /> Reset {fileName(notice.resetPath)}
        </button>
      </div>
    </div>
  );
}

// Ctrl/Cmd+K: a one-line prompt under the selection; the change comes back as a diff to review.
function InlineEdit({ target, onSubmit, onClose }) {
  const [text, setText] = useState('');
  const inputRef = useRef(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, [target.key]);
  const lines = target.startLine === target.endLine ? `line ${target.startLine}` : `lines ${target.startLine}–${target.endLine}`;
  const where = target.cell ? `${lines} of cell ${target.cell}` : lines;
  const submit = () => {
    if (!text.trim()) return;
    onSubmit(text.trim());
  };
  return (
    <form
      className="inline-edit"
      style={{ top: target.visible ? target.top : 12 }}
      role="dialog"
      aria-label="Edit with AI"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onClose(true);
        }
      }}
    >
      <PencilLine size={16} aria-hidden="true" className="inline-edit-icon" />
      <input
        ref={inputRef}
        className="inline-edit-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={`Edit ${where} with AI: describe the change`}
        aria-label={`Describe the change to ${where}`}
        spellCheck={false}
        autoComplete="off"
      />
      <button type="submit" className="btn btn-primary btn-sm" disabled={!text.trim()}>
        <CornerDownLeft size={14} aria-hidden="true" /> Edit
      </button>
      <button type="button" className="icon-btn icon-btn-sm" aria-label="Cancel (Esc)" data-tooltip="Cancel (Esc)" onClick={() => onClose(true)}>
        <X size={14} aria-hidden="true" />
      </button>
    </form>
  );
}

function SelectionActions({ selection, onAskAI, onEdit, onExplain, onFix }) {
  if (!selection || !selection.visible) return null;
  const keep = (e) => e.preventDefault(); // don't steal focus from the editor
  return (
    <div
      className="selection-actions"
      style={{ top: selection.top, left: Math.max(56, selection.left - 40) }}
      role="toolbar"
      aria-label="Selection actions"
    >
      <button
        type="button"
        className="sel-btn sel-btn-primary"
        onMouseDown={keep}
        onClick={onAskAI}
        data-tooltip="Add the selection to the assistant"
        aria-keyshortcuts="Control+L Meta+L"
      >
        <MessageSquarePlus size={16} aria-hidden="true" /> Ask AI
        <kbd className="sel-kbd">{MOD_KEY === '⌘' ? '⌘L' : 'Ctrl L'}</kbd>
      </button>
      <button
        type="button"
        className="sel-btn"
        onMouseDown={keep}
        onClick={onEdit}
        data-tooltip="Describe a change to these lines"
        aria-keyshortcuts="Control+K Meta+K"
      >
        <PencilLine size={16} aria-hidden="true" /> Edit
        <kbd className="sel-kbd">{MOD_KEY === '⌘' ? '⌘K' : 'Ctrl K'}</kbd>
      </button>
      <span className="sel-divider" aria-hidden="true" />
      <button type="button" className="sel-btn" onMouseDown={keep} onClick={onExplain}>
        <MessageSquareText size={16} aria-hidden="true" /> Explain
      </button>
      <button type="button" className="sel-btn" onMouseDown={keep} onClick={onFix}>
        <Wrench size={16} aria-hidden="true" /> Fix
      </button>
    </div>
  );
}

export default function EditorPane(props) {
  const {
    openTabs,
    activePath,
    files,
    onSelectTab,
    onCloseTab,
    onChange,
    onOpenFile,
    fontSize,
    diffInline,
    breakpoints,
    glyphEnabled,
    onToggleBreakpoint,
    execLine,
    readOnlyMessage,
    flash,
    revealRequest,
    review,
    reviewHandlers,
    session,
    sessionHandlers,
    notice,
    onResetFile,
    onDismissNotice,
    onAskAI,
    onExplain,
    onFix,
    onInlineEdit,
    notebook,
    onInstallPackage,
    onRunShortcut,
    onCaret,
    onOpenDatabase,
  } = props;
  const [selection, setSelection] = useState(null);
  const [inlineEdit, setInlineEdit] = useState(null); // Ctrl/Cmd+K target: a selection plus a key
  const [diffNav, setDiffNav] = useState(null);

  // Hide the selection actions when code changes under them (accept/undo).
  useEffect(() => setSelection(null), [flash]);

  const showDiff = review && !review.stale && review.proposal.path === activePath;
  const showReviewBar = review && review.proposal.path === activePath;
  const showSession = session && session.mode !== 'run' && (session.real || session.path === activePath);
  const showNotice = notice && notice.kind === 'trace' && notice.path === activePath && !showSession;

  const currentSelection = selection && selection.path === activePath && !showDiff ? selection : null;
  const currentInlineEdit = inlineEdit && inlineEdit.path === activePath && !showDiff ? inlineEdit : null;
  const startInlineEdit = (sel) => sel && setInlineEdit({ ...sel, key: Date.now() });
  const closeInlineEdit = (refocus) => {
    setInlineEdit(null);
    if (refocus) focusLastEditor();
  };
  const inlineEditUI = currentInlineEdit && (
    <InlineEdit
      target={currentInlineEdit}
      onClose={closeInlineEdit}
      onSubmit={(text) => {
        onInlineEdit?.(currentInlineEdit, text);
        closeInlineEdit(false);
      }}
    />
  );

  // Review shortcuts, only while the diff is on screen. Typing in the
  // assistant or a menu is never intercepted.
  const reviewKeys = useRef(null);
  reviewKeys.current = showDiff && review && !review.stale ? { nav: diffNav, review, handlers: reviewHandlers } : null;
  useEffect(() => {
    const onKey = (e) => {
      const ctx = reviewKeys.current;
      if (!ctx) return;
      const t = e.target;
      const inEditor = !!t.closest?.('.editor-pane');
      if (!inEditor && t !== document.body && t.closest?.('textarea, input, select, [role="menu"], [role="dialog"]')) return;
      if (e.key === 'F7') {
        e.preventDefault();
        e.stopPropagation();
        (e.shiftKey ? ctx.nav?.prev : ctx.nav?.next)?.();
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        e.stopPropagation();
        (ctx.review.blockedBy ? ctx.handlers.onStopAndApply : ctx.handlers.onAccept)();
      } else if (e.key === 'Escape' && inEditor) {
        // Only from the editor: elsewhere Esc already closes drawers and menus.
        e.preventDefault();
        ctx.handlers.onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  return (
    <section className="editor-pane" aria-label="Editor">
      <Tabs
        openTabs={openTabs}
        activePath={activePath}
        onSelect={onSelectTab}
        onClose={onCloseTab}
        reviewPath={review && !review.stale ? review.proposal.path : null}
        files={files}
      />
      {showReviewBar && <ReviewBar review={review} nav={showDiff ? diffNav : null} {...reviewHandlers} />}
      {showSession && <SessionBar session={session} {...sessionHandlers} />}
      {showNotice && <NoticeBar notice={notice} onReset={onResetFile} onDismiss={onDismissNotice} />}
      <div className="editor-body">
        {!activePath ? (
          <div className="empty-state">
            <p className="empty-title">No file open</p>
            <p className="empty-text">Choose a file from the sidebar.</p>
            <button type="button" className="btn btn-secondary" onClick={() => onOpenFile('main.py')}>
              Open main.py
            </button>
          </div>
        ) : files[activePath] === undefined ? (
          <div className="empty-state">
            <p className="empty-title">{fileName(activePath)} can’t be opened here</p>
            <p className="empty-text">Only text files up to 2 MB open in the editor. The file on disk is unchanged.</p>
          </div>
        ) : isDatabase(activePath) ? (
          <div className="empty-state">
            <p className="empty-title">{fileName(activePath)} is a SQLite database</p>
            <p className="empty-text">Explore and query it in the SQL workspace.</p>
            {onOpenDatabase && (
              <button type="button" className="btn btn-primary" onClick={() => onOpenDatabase(activePath)}>
                Open in the SQL workspace
              </button>
            )}
          </div>
        ) : notebook && !showDiff ? (
          <>
            <NotebookView
              key={activePath}
              session={notebook}
              path={activePath}
              fontSize={fontSize}
              onInstallPackage={onInstallPackage}
              setSelection={setSelection}
              onAskAI={onAskAI}
              onInlineEdit={startInlineEdit}
            />
            {!currentInlineEdit && (
              <SelectionActions
                selection={currentSelection}
                onAskAI={() => onAskAI(currentSelection)}
                onEdit={() => startInlineEdit(currentSelection)}
                onExplain={() => onExplain(currentSelection)}
                onFix={() => onFix(currentSelection)}
              />
            )}
            {inlineEditUI}
          </>
        ) : showDiff ? (
          <DiffReview proposal={review.proposal} inline={diffInline} fontSize={fontSize} onChanges={setDiffNav} />
        ) : (
          <>
            <CodeEditor
              path={activePath}
              files={files}
              onChange={onChange}
              readOnly={!!readOnlyMessage}
              readOnlyMessage={readOnlyMessage}
              fontSize={fontSize}
              breakpoints={breakpoints}
              execLine={execLine}
              flash={flash}
              glyphEnabled={glyphEnabled}
              onGlyphClick={onToggleBreakpoint}
              onSelection={setSelection}
              onAskAI={() => currentSelection && onAskAI(currentSelection)}
              onInlineEdit={startInlineEdit}
              revealRequest={revealRequest}
              onRunShortcut={onRunShortcut}
              onCaret={onCaret}
            />
            {!currentInlineEdit && (
              <SelectionActions
                selection={currentSelection}
                onAskAI={() => onAskAI(currentSelection)}
                onEdit={() => startInlineEdit(currentSelection)}
                onExplain={() => onExplain(currentSelection)}
                onFix={() => onFix(currentSelection)}
              />
            )}
            {inlineEditUI}
          </>
        )}
      </div>
    </section>
  );
}
