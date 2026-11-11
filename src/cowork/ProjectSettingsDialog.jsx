import { useState } from 'react';
import { Archive, Check, Lock, Minus, X } from 'lucide-react';
import Dialog from '../components/Dialog.jsx';
import { PERMISSIONS } from './useCowork.js';

// Project settings. Owners rename or archive the project; members see the
// same page read-only. Both see who can do what.
export default function ProjectSettingsDialog({ cowork, project, onClose, notify }) {
  const role = cowork.roleIn(project);
  const isOwner = cowork.can(project, 'settings');
  const [name, setName] = useState(project.name);
  const [error, setError] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const owners = project.members.filter((m) => m.role === 'owner').map((m) => cowork.people[m.id]?.name);

  const save = (e) => {
    e.preventDefault();
    if (name.trim() === project.name) return;
    const problem = cowork.renameProject(project.id, name);
    if (problem) return setError(problem);
    setError(null);
    notify(`Renamed the project to ${name.trim()}.`);
    return undefined;
  };

  return (
    <Dialog title="Project settings" onClose={onClose} className="dialog-share dialog-settings">
      <div className="share-head">
        <h2 className="dialog-title">Project settings</h2>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <p className="dialog-text share-intro">
        You’re {role === 'owner' ? 'an owner' : 'a member'} of {project.name}. Preview: changes here stay in this page.
      </p>

      <section className="settings-section" aria-labelledby="settings-name">
        <h3 className="share-section-title" id="settings-name">
          Name
        </h3>
        {isOwner ? (
          <form className="settings-rename" onSubmit={save} noValidate>
            <input
              className="field-input"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              aria-label="Project name"
              aria-invalid={!!error}
              aria-describedby={error ? 'settings-error' : undefined}
              data-autofocus
              autoComplete="off"
            />
            <button type="submit" className="btn btn-primary" disabled={!name.trim() || name.trim() === project.name}>
              Rename
            </button>
            {error && (
              <p className="field-error share-msg" id="settings-error" role="alert">
                {error}
              </p>
            )}
          </form>
        ) : (
          <p className="settings-readonly">
            <span>{project.name}</span>
          </p>
        )}
      </section>

      <section className="settings-section" aria-labelledby="settings-roles">
        <h3 className="share-section-title" id="settings-roles">
          Who can do what
        </h3>
        <table className="perm-table">
          <thead>
            <tr>
              <th scope="col">
                <span className="sr-only">Action</span>
              </th>
              <th scope="col" className={role === 'owner' ? 'is-you' : ''}>
                Owners{role === 'owner' ? ' (you)' : ''}
              </th>
              <th scope="col" className={role === 'member' ? 'is-you' : ''}>
                Members{role === 'member' ? ' (you)' : ''}
              </th>
            </tr>
          </thead>
          <tbody>
            {PERMISSIONS.map((p) => (
              <tr key={p.id}>
                <th scope="row">{p.label}</th>
                {['owner', 'member'].map((r) => (
                  <td key={r} className={role === r ? 'is-you' : ''}>
                    {p[r] ? (
                      <Check size={15} aria-label="Yes" className="perm-yes" />
                    ) : (
                      <Minus size={15} aria-label="No" className="perm-no" />
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="settings-section" aria-labelledby="settings-archive">
        <h3 className="share-section-title" id="settings-archive">
          Archive
        </h3>
        {isOwner ? (
          confirming ? (
            <div className="settings-confirm" role="alert">
              <p>
                <strong>Archive {project.name}?</strong> It disappears from everyone’s Shared projects and can’t be opened until an owner
                restores it. Nothing is deleted.
              </p>
              <div className="settings-confirm-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setConfirming(false)} data-autofocus>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => {
                    onClose();
                    cowork.archiveProject(project.id);
                  }}
                >
                  <Archive size={14} aria-hidden="true" /> Archive project
                </button>
              </div>
            </div>
          ) : (
            <div className="settings-row">
              <p>Hide the project from everyone’s list when the work is done. Owners can restore it from Shared projects.</p>
              <button type="button" className="btn btn-secondary" onClick={() => setConfirming(true)}>
                <Archive size={14} aria-hidden="true" /> Archive…
              </button>
            </div>
          )
        ) : (
          <p className="share-member-note">
            <Lock size={14} aria-hidden="true" /> Only owners can rename or archive this project
            {owners.length ? ` (${owners.join(', ')})` : ''}.
          </p>
        )}
      </section>

      <div className="dialog-actions share-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose} data-autofocus={!isOwner || undefined}>
          Done
        </button>
      </div>
    </Dialog>
  );
}
