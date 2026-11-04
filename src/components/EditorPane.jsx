import { useEffect, useRef, useState } from 'react';
import { X, ChevronUp, ChevronDown, FileCode2, FileSpreadsheet, FileDiff, MessageSquarePlus, MessageSquareText, Wrench, Check, AlertTriangle, StepForward, FastForward, RotateCcw, Square, Bug, Footprints, Info, CircleCheck } from 'lucide-react';
import CodeEditor from './CodeEditor.jsx';
import DiffReview from './DiffReview.jsx';
import { TRACE } from '../services/traceService.js';
import { SAMPLE_FILES } from '../data/sampleProject.js';

const iconFor = (path) => (path.endsWith('.csv') ? FileSpreadsheet : FileCode2);
const fileName = (path) => path.split('/').pop();

// "Python · 64 lines" / "CSV · 40 rows", from the file as it is now.
function fileMeta(path, text = '') {
  const lines = text.split('\n').length;
  if (path.endsWith('.csv')) return `CSV · ${Math.max(0, text.trim().split('\n').length - 1)} rows`;
  return `${path.endsWith('.py') ? 'Python' : 'Text'} · ${lines} lines`;
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

function SessionBar({ session, onNext, onContinue, onRestart, onStop }) {
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

function SelectionActions({ selection, onAskAI, onExplain, onFix }) {
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
  } = props;
  const [selection, setSelection] = useState(null);
  const [diffNav, setDiffNav] = useState(null);

  // Hide the selection actions when code changes under them (accept/undo).
  useEffect(() => setSelection(null), [flash]);

  const showDiff = review && !review.stale && review.proposal.path === activePath;
  const showReviewBar = review && review.proposal.path === activePath;
  const showSession = session && session.mode !== 'run' && session.path === activePath;
  const showNotice = notice && notice.kind === 'trace' && notice.path === activePath && !showSession;

  const currentSelection = selection && selection.path === activePath && !showDiff ? selection : null;

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
              revealRequest={revealRequest}
            />
            <SelectionActions
              selection={currentSelection}
              onAskAI={() => onAskAI(currentSelection)}
              onExplain={() => onExplain(currentSelection)}
              onFix={() => onFix(currentSelection)}
            />
          </>
        )}
      </div>
    </section>
  );
}
