import { useState } from 'react';
import { FileCode2, Undo2, AlertTriangle, RefreshCw, CircleCheck, CircleSlash, ChevronRight } from 'lucide-react';
import { formatInline } from './Markdown.jsx';

// Applied changes say so in their status row; the others lose their summary
// colour, so the file row names what happened.
const STATUS_LABEL = {
  rejected: 'Rejected',
  discarded: 'Discarded',
  undone: 'Undone',
};

// The assistant's proposed change: which file, what changed, and where it
// stands. The file row is the link to the editor (review it while pending,
// open the file once applied). Accept and Reject live only in the review bar
// above the code, so they're never duplicated here.
export default function ProposalCard({ view, handlers }) {
  const { proposal, stale, blockedBy, canUndo, editedSinceApply, reviewing } = view;
  const [confirmUndo, setConfirmUndo] = useState(false);
  const { id, path, status } = proposal;
  const pending = status === 'pending';
  const fileAction = pending && !stale ? () => handlers.onReview(id) : status === 'accepted' ? () => handlers.onOpenFile(id) : null;
  const fileHint = pending && !stale ? (reviewing ? 'In the editor' : 'Review') : status === 'accepted' ? 'Open' : null;
  const FileRow = fileAction ? 'button' : 'div';

  return (
    <div className={`proposal-card status-${status} ${reviewing ? 'is-reviewing' : ''}`}>
      <FileRow
        {...(fileAction ? { type: 'button', onClick: fileAction, 'aria-pressed': pending ? reviewing : undefined } : {})}
        className="proposal-head"
        aria-label={fileAction ? `${fileHint} ${path}` : undefined}
      >
        <FileCode2 size={16} strokeWidth={1.75} aria-hidden="true" className="proposal-file-icon" />
        <span className="proposal-file">{path}</span>
        <span className="diff-stat">
          <span className="diff-add" aria-label={`${proposal.added} lines added`}>+{proposal.added}</span>{' '}
          <span className="diff-del" aria-label={`${proposal.removed} lines removed`}>−{proposal.removed}</span>
        </span>
        {STATUS_LABEL[status] && <span className={`proposal-status-tag tag-${status}`}>{STATUS_LABEL[status]}</span>}
        {fileHint && (
          <span className="proposal-go" aria-hidden="true">
            {fileHint}
            {!reviewing && <ChevronRight size={14} />}
          </span>
        )}
      </FileRow>
      <ul className="proposal-summary">
        {proposal.summary.map((line, i) => (
          <li key={i}>{formatInline(line, `s${i}`)}</li>
        ))}
      </ul>

      {pending && stale && (
        <div className="proposal-state state-warning" role="status">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>{path} changed after this proposal was created, so it can’t be applied safely.</span>
          {!reviewing && (
            <div className="proposal-actions">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => handlers.onDiscard(id)}>
                Discard
              </button>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => handlers.onRegenerate(id)}>
                <RefreshCw size={16} aria-hidden="true" /> Regenerate
              </button>
            </div>
          )}
        </div>
      )}

      {pending && !stale && blockedBy && (
        <p className="proposal-note">{path} is being run. Stop the run before applying changes to it.</p>
      )}

      {status === 'accepted' && (
        <div className="proposal-state state-success">
          <CircleCheck size={16} aria-hidden="true" />
          <span>Applied to {path}</span>
          {canUndo && !confirmUndo && (
            <button
              type="button"
              className="btn btn-ghost btn-sm push-right"
              onClick={() => (editedSinceApply ? setConfirmUndo(true) : handlers.onUndo(id))}
            >
              <Undo2 size={16} aria-hidden="true" /> Undo
            </button>
          )}
          {!canUndo && <span className="state-hint push-right">A later change to {path} must be undone first</span>}
        </div>
      )}
      {status === 'accepted' && confirmUndo && (
        <div className="proposal-state state-warning" role="alertdialog" aria-label="Confirm undo">
          <AlertTriangle size={16} aria-hidden="true" />
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
          <Undo2 size={16} aria-hidden="true" />
          <span>{path} was restored to the version before this change.</span>
        </div>
      )}
      {(status === 'rejected' || status === 'discarded') && (
        <div className="proposal-state state-muted">
          <CircleSlash size={16} aria-hidden="true" />
          <span>{path} is unchanged.</span>
        </div>
      )}
    </div>
  );
}
