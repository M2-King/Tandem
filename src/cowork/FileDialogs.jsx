import { useEffect, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import Dialog from '../components/Dialog.jsx';

// Rename a file in a shared project. A folder in the name moves it there.
export function RenameFileDialog({ path, onRename, onClose }) {
  const [value, setValue] = useState(path);
  const [error, setError] = useState(null);
  const input = useRef(null);

  // Select the name without its extension, ready to type over.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    const slash = path.lastIndexOf('/') + 1;
    const dot = path.lastIndexOf('.');
    el.focus();
    el.setSelectionRange(slash, dot > slash ? dot : path.length);
  }, [path]);

  const submit = (e) => {
    e.preventDefault();
    const problem = onRename(value);
    if (problem) setError(problem);
    else onClose();
  };

  return (
    <Dialog title="Rename file" onClose={onClose} className="dialog-confirm dialog-file">
      <form onSubmit={submit} noValidate>
        <h2 className="dialog-title">Rename file</h2>
        <label className="field">
          <span className="field-label">New name</span>
          <input
            ref={input}
            className="field-input mono"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={!!error}
            aria-describedby={error ? 'rename-error' : 'rename-hint'}
          />
        </label>
        {error ? (
          <p className="field-error" id="rename-error" role="alert">
            {error}
          </p>
        ) : (
          <p className="field-hint" id="rename-hint">
            Renamed for everyone. Code that opens this file by name needs the new name too.
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary">
            Rename
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// Remove a file (owners). Undo is offered afterwards.
export function RemoveFileDialog({ path, projectName, onRemove, onClose }) {
  return (
    <Dialog title="Remove file" onClose={onClose} className="dialog-confirm dialog-file">
      <h2 className="dialog-title">Remove {path.split('/').pop()}?</h2>
      <p className="dialog-text">
        <span className="mono">{path}</span> is removed for everyone in {projectName}. You can undo this right after.
      </p>
      <div className="dialog-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose} data-autofocus>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => {
            onRemove();
            onClose();
          }}
        >
          <Trash2 size={14} aria-hidden="true" /> Remove file
        </button>
      </div>
    </Dialog>
  );
}
