import { Check, KeyRound, Users } from 'lucide-react';
import Dialog from '../components/Dialog.jsx';

// A shared project with a shared AI: "AI settings" first asks which AI the
// assistant uses here, on this device (useSharedAI keeps the answer per
// project). The own AI's settings stay as they are for other projects.
export default function AIChoiceDialog({ share, projectName, usingShared, ownAI, onUseShared, onUseOwn, onClose }) {
  // The person who shared it is the project's leader (an owner).
  const question = share.shared_by_me
    ? 'You already shared your AI with this project. Do you want to use it here?'
    : 'Your leader has already shared an AI setup. Do you want to use it in this project?';
  const who = share.shared_by_me ? 'You share' : `${share.shared_by} shares`;
  const left = share.shared_by_me
    ? 'Your own requests have no limit.'
    : `You’ve used ${share.used_today} of ${share.daily_limit} requests today.`;
  return (
    <Dialog title={question} onClose={onClose} className="dialog-confirm dialog-ai-choice">
      <h2 className="dialog-title">{question}</h2>
      <p className="dialog-text">
        {who} <span className="mono">{share.model}</span> with {projectName}. {left}
      </p>
      <div className="ai-choice-options">
        <button type="button" className={`ai-choice${usingShared ? ' is-current' : ''}`} onClick={onUseShared} data-autofocus>
          <span className="ai-choice-icon" aria-hidden="true">
            <Users size={18} />
          </span>
          <span className="ai-choice-text">
            <span className="ai-choice-title">Use the shared AI</span>
            <span className="ai-choice-detail">No key needed. Only for this project’s code and data.</span>
          </span>
          {usingShared && <Check size={16} aria-label="In use" className="ai-choice-check" />}
        </button>
        <button type="button" className={`ai-choice${usingShared ? '' : ' is-current'}`} onClick={onUseOwn}>
          <span className="ai-choice-icon" aria-hidden="true">
            <KeyRound size={18} />
          </span>
          <span className="ai-choice-text">
            <span className="ai-choice-title">Use my own AI</span>
            <span className="ai-choice-detail">
              {ownAI ? (
                <>
                  <span className="mono">{ownAI.model}</span> with your key. Opens AI settings.
                </>
              ) : (
                'Opens AI settings to connect your own model and key.'
              )}
            </span>
          </span>
          {!usingShared && <Check size={16} aria-label="In use" className="ai-choice-check" />}
        </button>
      </div>
      <p className="field-hint">Only for {projectName}, on this device. Change it any time from AI settings.</p>
      <div className="dialog-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Dialog>
  );
}
