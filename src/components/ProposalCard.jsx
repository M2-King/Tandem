import { useState } from 'react';
import { FileCode2, Check, X, Eye, Undo2, AlertTriangle, RefreshCw, Square, CircleCheck, CircleSlash } from 'lucide-react';
import { formatInline } from './Markdown.jsx';

// The assistant's proposed change, with its current state and actions.
export default function ProposalCard({ view, handlers }) {
  const { proposal, stale, blockedBy, canUndo, editedSinceApply, reviewing } = view;
  const [confirmUndo, setConfirmUndo] = useState(false);
  const { id, path, status } = proposal;

  return (
    <div className={`proposal-card status-${status}`}>
      <div className="proposal-head">
        <FileCode2 size={14} strokeWidth={1.75} aria-hidden="true" />
        <span className="proposal-file">{path}</span>
        <span className="diff-stat">
          <span className="diff-add" aria-label={`${proposal.added} lines added`}>+{proposal.added}</span>{' '}
          <span className="diff-del" aria-label={`${proposal.removed} lines removed`}>−{proposal.removed}</span>
        </span>
      </div>
      <ul className="proposal-summary">
        {proposal.summary.map((line, i) => (
          <li key={i}>{formatInline(line, `s${i}`)}</li>
        ))}
      </ul>

      {status === 'pending' && stale && (
        <div className="proposal-state state-warning" role="status">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>{path} changed after this proposal was created, so it can’t be applied safely.</span>
          <div className="proposal-actions">
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => handlers.onDiscard(id)}>
              Discard
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => handlers.onRegenerate(id)}>
              <RefreshCw size={13} aria-hidden="true" /> Regenerate
            </button>
          </div>
        </div>
      )}

      {status === 'pending' && !stale && (
        <>
          {blockedBy && (
            <p className="proposal-note">
              {path} is being run. Stop the run before applying changes to it.
            </p>
          )}
          <div className="proposal-actions">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => handlers.onReview(id)}
              aria-pressed={reviewing}
            >
              <Eye size={14} aria-hidden="true" /> {reviewing ? 'Reviewing' : 'Review'}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => handlers.onReject(id)}>
              <X size={14} aria-hidden="true" /> Reject
            </button>
            {blockedBy ? (
              <button type="button" className="btn btn-primary btn-sm" onClick={() => handlers.onStopAndApply(id)}>
                <Square size={11} fill="currentColor" aria-hidden="true" /> Stop and accept
              </button>
            ) : (
              <button type="button" className="btn btn-primary btn-sm" onClick={() => handlers.onAccept(id)}>
                <Check size={14} aria-hidden="true" /> Accept
              </button>
            )}
          </div>
        </>
      )}

      {status === 'accepted' && (
        <div className="proposal-state state-success">
          <CircleCheck size={14} aria-hidden="true" />
          <span>Applied to {path}</span>
          {canUndo && !confirmUndo && (
            <button
              type="button"
              className="btn btn-ghost btn-sm push-right"
              onClick={() => (editedSinceApply ? setConfirmUndo(true) : handlers.onUndo(id))}
            >
              <Undo2 size={14} aria-hidden="true" /> Undo
            </button>
          )}
          {!canUndo && <span className="state-hint push-right">A later change to {path} must be undone first</span>}
        </div>
      )}
      {status === 'accepted' && confirmUndo && (
        <div className="proposal-state state-warning" role="alertdialog" aria-label="Confirm undo">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>{path} has edits made after this change. Undo restores the earlier version and removes them.</span>
          <div className="proposal-actions">
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirmUndo(false)}>
              Keep edits
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={() => {
                setConfirmUndo(false);
                handlers.onUndo(id);
              }}
            >
              Undo anyway
            </button>
          </div>
        </div>
      )}
      {status === 'undone' && (
        <div className="proposal-state state-muted">
          <Undo2 size={14} aria-hidden="true" />
          <span>Undone. {path} was restored to the version before this change.</span>
        </div>
      )}
      {status === 'rejected' && (
        <div className="proposal-state state-muted">
          <CircleSlash size={14} aria-hidden="true" />
          <span>Rejected. {path} is unchanged.</span>
        </div>
      )}
      {status === 'discarded' && (
        <div className="proposal-state state-muted">
          <CircleSlash size={14} aria-hidden="true" />
          <span>Discarded. {path} is unchanged.</span>
        </div>
      )}
    </div>
  );
}
