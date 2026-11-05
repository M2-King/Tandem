import { useEffect, useState } from 'react';
import { X, FolderOpen, Plus } from 'lucide-react';
import Dialog from './Dialog.jsx';

// iPad: projects are folders in Files › On My iPad › Tandem.
export default function ProjectsDialog({ backend, onClose }) {
  const [data, setData] = useState(null);
  const [name, setName] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    backend.listProjects().then(setData, (e) => setError(e.message));
  }, [backend]);

  const open = async (project, create = false) => {
    setBusy(true);
    setError(null);
    try {
      await backend.openProject(project, create);
      window.location.reload(); // the editor, runs and assistant follow the new project
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  return (
    <Dialog title="Projects" onClose={onClose} className="dialog-ai">
      <div className="ai-settings-head">
        <h2 className="dialog-title">Projects</h2>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <p className="dialog-text">Each project is a folder in {data?.stored_in || 'the Files app'}. Add files there, or create them here.</p>
      <ul className="project-list">
        {data?.projects.map((p) => (
          <li key={p}>
            <button type="button" className={`project-row ${p === data.current ? 'is-current' : ''}`} disabled={busy || p === data.current} onClick={() => open(p)}>
              <FolderOpen size={16} aria-hidden="true" />
              <span>{p}</span>
              {p === data.current && <span className="sim-tag">Open</span>}
            </button>
          </li>
        ))}
      </ul>
      <form
        className="project-new"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) open(name.trim(), true);
        }}
      >
        <input className="field-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="New project name" aria-label="New project name" />
        <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
          <Plus size={16} aria-hidden="true" /> Create
        </button>
      </form>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
