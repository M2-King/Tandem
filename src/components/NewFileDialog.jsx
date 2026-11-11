import { useMemo, useState } from 'react';
import Dialog from './Dialog.jsx';
import { FILE_TYPES, extensionOf, fileTypeById, typeOf } from '../lib/fileTypes.js';

// A new file: choose what kind it is, then name it. The extension is added
// for you (a name that already has one keeps it), and the file starts with
// a small template for its kind. "Other" takes any name as it is.
const OTHER = 'other';

function problemWith(path, existing) {
  const p = path.trim();
  if (!p) return 'Enter a file name.';
  if (p.startsWith('/') || p.includes('..') || p.includes('\\')) return 'Use a path inside the project, like src/util.py.';
  if (p.endsWith('/')) return 'Add a file name after the folder.';
  if (existing.includes(p)) return `${p} already exists.`;
  return null;
}

export default function NewFileDialog({ existing, onCreate, onClose, initialType = 'python' }) {
  const [typeId, setTypeId] = useState(initialType);
  const [name, setName] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const type = fileTypeById(typeId);

  // The full path: the name, plus the chosen type's extension unless the name already has one.
  const path = useMemo(() => {
    const n = name.trim();
    if (!n || !type || extensionOf(n)) return n;
    return `${n}.${type.ext}`;
  }, [name, type]);

  const submit = async (e) => {
    e.preventDefault();
    const problem = problemWith(path, existing);
    if (problem) return setError(problem);
    setBusy(true);
    try {
      const kind = typeOf(path);
      const base = path.split('/').pop().replace(/\.[^.]+$/, '');
      await onCreate(path, kind ? { text: kind.template(base), binary: !!kind.binary, type: kind.id } : { text: '', type: null });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
    return undefined;
  };

  return (
    <Dialog title="New file" onClose={onClose} className="dialog-confirm dialog-newfile">
      <form onSubmit={submit}>
        <h2 className="dialog-title">New file</h2>
        <div className="newfile-types" role="radiogroup" aria-label="Kind of file">
          {[...FILE_TYPES, { id: OTHER, label: 'Other', ext: '' }].map((t) => (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={typeId === t.id}
              className={`newfile-type ${typeId === t.id ? 'is-active' : ''}`}
              onClick={() => {
                setTypeId(t.id);
                setError(null);
              }}
            >
              <span>{t.label}</span>
              {t.ext && <span className="newfile-ext mono">.{t.ext}</span>}
            </button>
          ))}
        </div>
        <label className="field">
          <span className="field-label">Name</span>
          <span className="newfile-name">
            <input
              className="field-input mono"
              value={name}
              onChange={(e) => {
                const value = e.target.value;
                setName(value);
                setError(null);
                // A typed extension picks its kind (analysis.sql → SQL).
                const kind = typeOf(value);
                if (kind && kind.id !== typeId) setTypeId(kind.id);
              }}
              placeholder={type ? (type.id === 'notebook' ? 'analysis' : type.id === 'sql' ? 'queries' : 'untitled') : 'any-name.ext'}
              spellCheck={false}
              autoComplete="off"
              data-autofocus
              aria-invalid={!!error}
              aria-describedby={error ? 'new-file-error' : 'new-file-hint'}
            />
            {type && !extensionOf(name) && <span className="newfile-suffix mono">.{type.ext}</span>}
          </span>
        </label>
        {error ? (
          <p className="field-error" id="new-file-error" role="alert">
            {error}
          </p>
        ) : (
          <p className="field-hint" id="new-file-hint">
            {path ? (
              <>
                Creates <span className="mono">{path}</span> in your project. Folders (like <span className="mono">src/</span>) are created as needed.
              </>
            ) : (
              'Created in your project folder. Folders are created as needed.'
            )}
          </p>
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
