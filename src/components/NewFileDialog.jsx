import { useState } from 'react';
import Dialog from './Dialog.jsx';

// Name a new file in the project (for example `analysis.py` or `src/util.py`).
function problemWith(path, existing) {
  const p = path.trim();
  if (!p) return 'Enter a file name.';
  if (p.startsWith('/') || p.includes('..') || p.includes('\\')) return 'Use a path inside the project, like src/util.py.';
  if (p.endsWith('/')) return 'Add a file name after the folder.';
  if (existing.includes(p)) return `${p} already exists.`;
  return null;
}

export default function NewFileDialog({ existing, onCreate, onClose }) {
  const [path, setPath] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    const problem = problemWith(path, existing);
    if (problem) return setError(problem);
    setBusy(true);
    try {
      await onCreate(path.trim());
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
    return undefined;
  };

  return (
    <Dialog title="New file" onClose={onClose} className="dialog-confirm">
      <form onSubmit={submit}>
        <h2 className="dialog-title">New file</h2>
        <label className="field">
          <span className="field-label">Name</span>
          <input
            className="field-input mono"
            value={path}
            onChange={(e) => {
              setPath(e.target.value);
              setError(null);
            }}
            placeholder="analysis.py"
            spellCheck={false}
            autoComplete="off"
            data-autofocus
            aria-invalid={!!error}
            aria-describedby={error ? 'new-file-error' : undefined}
          />
        </label>
        {error ? (
          <p className="field-error" id="new-file-error" role="alert">
            {error}
          </p>
        ) : (
          <p className="field-hint">Created in your project folder. Folders are created as needed.</p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Create
          </button>
        </div>
      </form>
    </Dialog>
  );
}
