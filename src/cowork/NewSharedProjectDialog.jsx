import { useState } from 'react';
import { X } from 'lucide-react';
import Dialog from '../components/Dialog.jsx';

// A new shared project: a name; it starts with main.py and a notebook, and
// you are its owner. Invite people from Share once it is open.
export default function NewSharedProjectDialog({ existing, onCreate, onClose, startsEmpty = false }) {
  const [name, setName] = useState('');
  const [error, setError] = useState(null);

  const submit = (e) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return setError('Enter a name for the project.');
    if (existing.some((p) => p.name.toLowerCase() === n.toLowerCase())) return setError(`You already have a project called ${n}.`);
    onCreate(n);
    return undefined;
  };

  return (
    <Dialog title="New shared project" onClose={onClose} className="dialog-confirm dialog-new-shared">
      <form onSubmit={submit} noValidate>
        <div className="share-head">
          <h2 className="dialog-title">New shared project</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <label className="field">
          <span className="field-label">Project name</span>
          <input
            className="field-input"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            placeholder="Group assignment"
            autoComplete="off"
            data-autofocus
            aria-invalid={!!error}
            aria-describedby={error ? 'new-shared-error' : 'new-shared-hint'}
          />
        </label>
        {error ? (
          <p className="field-error" id="new-shared-error" role="alert">
            {error}
          </p>
        ) : (
          <p className="field-hint" id="new-shared-hint">
            {startsEmpty ? (
              'You’ll be the owner. It starts empty: add or upload files, then invite people from Share.'
            ) : (
              <>
                You’ll be the owner. It starts with <span className="mono">main.py</span> and <span className="mono">notebook.ipynb</span>; invite
                people from Share.
              </>
            )}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary">
            Create project
          </button>
        </div>
      </form>
    </Dialog>
  );
}
