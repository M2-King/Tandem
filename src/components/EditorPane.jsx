import { useEffect, useState } from 'react';
import { X, FileCode2, FileSpreadsheet, Sparkles, MessageSquareText, Wrench, Check, AlertTriangle, StepForward, FastForward, RotateCcw, Square, Bug, Footprints, Info, CircleCheck } from 'lucide-react';
import CodeEditor from './CodeEditor.jsx';
import DiffReview from './DiffReview.jsx';
import { TRACE } from '../services/traceService.js';

const iconFor = (path) => (path.endsWith('.csv') ? FileSpreadsheet : FileCode2);
const fileName = (path) => path.split('/').pop();

function Tabs({ openTabs, activePath, onSelect, onClose, reviewPath }) {
  return (
    <div className="tab-bar" role="tablist" aria-label="Open files">
      {openTabs.map((path) => {
        const Icon = iconFor(path);
        const active = path === activePath;
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
              <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
              <span>{fileName(path)}</span>
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
              <X size={13} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function ReviewBar({ review, onAccept, onReject, onClose, onRegenerate, onDiscard, onStopAndApply }) {
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
      <Sparkles size={16} aria-hidden="true" className="banner-icon-accent" />
      <span className="banner-text">
        <strong>Review proposed change</strong>
        <span className="diff-stat">
          <span className="diff-add">+{proposal.added}</span> <span className="diff-del">−{proposal.removed}</span>
        </span>
        {blockedBy && <span className="banner-note">Stop the current run before applying.</span>}
      </span>
      <div className="banner-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
          Back to editing
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onReject}>
          <X size={14} aria-hidden="true" /> Reject
        </button>
        {blockedBy ? (
          <button type="button" className="btn btn-primary btn-sm" onClick={onStopAndApply}>
            <Square size={11} fill="currentColor" aria-hidden="true" /> Stop and accept
          </button>
        ) : (
          <button type="button" className="btn btn-primary btn-sm" onClick={onAccept}>
            <Check size={14} aria-hidden="true" /> Accept
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
              <StepForward size={14} aria-hidden="true" /> {isDebug ? 'Step' : 'Next'}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={onContinue}>
              <FastForward size={14} aria-hidden="true" /> Continue
            </button>
          </>
        )}
        <button type="button" className="btn btn-secondary btn-sm" onClick={onRestart}>
          <RotateCcw size={14} aria-hidden="true" /> Restart
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
          <RotateCcw size={14} aria-hidden="true" /> Reset {fileName(notice.resetPath)}
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
      <button type="button" className="sel-btn sel-btn-primary" onMouseDown={keep} onClick={onAskAI} data-tooltip="Add the selection to the assistant (Ctrl/⌘ L)">
        <Sparkles size={14} aria-hidden="true" /> Ask AI
      </button>
      <span className="sel-divider" aria-hidden="true" />
      <button type="button" className="sel-btn" onMouseDown={keep} onClick={onExplain}>
        <MessageSquareText size={14} aria-hidden="true" /> Explain
      </button>
      <button type="button" className="sel-btn" onMouseDown={keep} onClick={onFix}>
        <Wrench size={14} aria-hidden="true" /> Fix
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

  // Hide the selection actions when code changes under them (accept/undo).
  useEffect(() => setSelection(null), [flash]);

  const showDiff = review && !review.stale && review.proposal.path === activePath;
  const showReviewBar = review && review.proposal.path === activePath;
  const showSession = session && session.mode !== 'run' && session.path === activePath;
  const showNotice = notice && notice.kind === 'trace' && notice.path === activePath && !showSession;

  const currentSelection = selection && selection.path === activePath && !showDiff ? selection : null;

  return (
    <section className="editor-pane" aria-label="Editor">
      <Tabs
        openTabs={openTabs}
        activePath={activePath}
        onSelect={onSelectTab}
        onClose={onCloseTab}
        reviewPath={review && !review.stale ? review.proposal.path : null}
      />
      {showReviewBar && <ReviewBar review={review} {...reviewHandlers} />}
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
        ) : showDiff ? (
          <DiffReview proposal={review.proposal} inline={diffInline} fontSize={fontSize} />
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
