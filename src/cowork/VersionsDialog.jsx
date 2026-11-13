import { useEffect, useMemo, useState } from 'react';
import { ArchiveRestore, Bookmark, ChevronDown, Clock, Eye, FileText, Loader2, Pencil, RotateCcw, Save, Trash2, Undo2 } from 'lucide-react';
import Dialog from '../components/Dialog.jsx';
import { timeAgo } from './SharedProjectsPage.jsx';

// Backups of a shared project (useVersions, 005_cowork_versions.sql): back up
// now, and restore the whole project (owners) or one file (everyone) from any
// backup. Restoring backs up what is there first, so it can be undone.

export const sizeText = (bytes) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const titleOf = (v) =>
  v.name || (v.reason === 'before-restore' ? 'Before a restore' : v.auto ? 'Automatic backup' : 'Backup');

// Lines added and removed, roughly (for "what changed since").
function lineChanges(from, to) {
  const a = (from || '').split('\n');
  const b = (to || '').split('\n');
  const count = (lines) => lines.reduce((m, l) => m.set(l, (m.get(l) || 0) + 1), new Map());
  const ca = count(a);
  const cb = count(b);
  let added = 0;
  let removed = 0;
  for (const [l, n] of cb) added += Math.max(0, n - (ca.get(l) || 0));
  for (const [l, n] of ca) removed += Math.max(0, n - (cb.get(l) || 0));
  return { added, removed };
}

function FileView({ versions, version, path, current, onClose, onRestore, busy }) {
  const [text, setText] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    versions.fileText(version.id, path).then(
      (r) => live && setText(r.content ?? ''),
      (e) => live && setError(e.message || 'Couldn’t open it.')
    );
    return () => {
      live = false;
    };
  }, [versions, version.id, path]);
  const changes = text != null && current != null ? lineChanges(current, text) : null;
  const lines = text?.split('\n') || [];
  return (
    <div className="versions-view" role="region" aria-label={`${path} in ${titleOf(version)}`}>
      <div className="versions-view-head">
        <FileText size={14} aria-hidden="true" />
        <span className="mono">{path}</span>
        <span className="versions-muted">in {titleOf(version)}</span>
        {changes && (
          <span className="versions-muted">
            {current === text ? '· same as now' : current == null ? '· not in the project now' : `· restoring: +${changes.added} −${changes.removed} lines`}
          </span>
        )}
        <span className="push-right" />
        <button type="button" className="btn btn-primary btn-sm" onClick={onRestore} disabled={busy || text == null || current === text}>
          <RotateCcw size={13} aria-hidden="true" /> Restore this file
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
          Close
        </button>
      </div>
      {error ? (
        <p className="field-error">{error}</p>
      ) : text == null ? (
        <p className="versions-muted">
          <Loader2 size={13} className="spin" aria-hidden="true" /> Opening…
        </p>
      ) : (
        <pre className="versions-text mono">
          {lines.slice(0, 400).join('\n')}
          {lines.length > 400 ? `\n… ${lines.length - 400} more lines` : ''}
        </pre>
      )}
    </div>
  );
}

function VersionRow({ v, versions, isOwner, isMine, files, onRestoreAll, onRestoreFile, busy }) {
  const [open, setOpen] = useState(false);
  const [viewing, setViewing] = useState(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState(v.name || '');
  const Icon = v.name ? Bookmark : v.reason === 'before-restore' ? Undo2 : v.auto ? Clock : Save;
  const now = useMemo(() => new Set(Object.keys(files)), [files]);
  const missing = [...now].filter((p) => !v.files.some((f) => f.path === p));
  return (
    <li className={`versions-row ${open ? 'is-open' : ''}`}>
      <div className="versions-row-main">
        <span className={`versions-icon ${v.name ? 'is-named' : ''}`} aria-hidden="true">
          <Icon size={15} />
        </span>
        <span className="versions-row-text">
          {naming ? (
            <form
              className="versions-name-form"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!name.trim()) return;
                await versions.rename(v.id, name.trim());
                setNaming(false);
              }}
            >
              <input className="field-input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} aria-label="Backup name" autoFocus />
              <button type="submit" className="btn btn-secondary btn-sm">
                Save
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setNaming(false)}>
                Cancel
              </button>
            </form>
          ) : (
            <span className="versions-title">{titleOf(v)}</span>
          )}
          <span className="versions-muted">
            {timeAgo(new Date(v.created_at).getTime())}
            {v.created_by ? ` · ${v.created_by}` : ''} · {v.file_count} file{v.file_count === 1 ? '' : 's'} · {sizeText(v.total_size)}
          </span>
        </span>
        <span className="versions-actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            Files <ChevronDown size={13} aria-hidden="true" className={open ? 'is-open' : ''} />
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => onRestoreAll(v)}
            disabled={!isOwner || busy}
            data-tooltip={isOwner ? 'Put every file back as it was in this backup' : 'Only owners restore the whole project. Open Files to restore one file.'}
          >
            <RotateCcw size={13} aria-hidden="true" /> Restore
          </button>
          {!naming && (
            <button type="button" className="icon-btn icon-btn-sm" aria-label="Name this backup" data-tooltip={v.name ? 'Rename' : 'Name it (named backups are kept)'} onClick={() => setNaming(true)}>
              <Pencil size={13} aria-hidden="true" />
            </button>
          )}
          {(isOwner || isMine) && (
            <button type="button" className="icon-btn icon-btn-sm" aria-label="Delete this backup" data-tooltip="Delete" onClick={() => versions.remove(v.id)}>
              <Trash2 size={13} aria-hidden="true" />
            </button>
          )}
        </span>
      </div>
      {open && (
        <div className="versions-files">
          <ul>
            {v.files.map((f) => {
              const cur = files[f.path];
              const status = cur == null ? 'not in the project now' : null;
              return (
                <li key={f.path} className="versions-file">
                  <FileText size={13} aria-hidden="true" />
                  <span className="mono">{f.path}</span>
                  <span className="versions-muted">
                    {sizeText(f.size)}
                    {status ? ` · ${status}` : ''}
                  </span>
                  <span className="push-right" />
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setViewing(f.path)}>
                    <Eye size={13} aria-hidden="true" /> View
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => onRestoreFile(v, f.path)} disabled={busy}>
                    <RotateCcw size={13} aria-hidden="true" /> Restore file
                  </button>
                </li>
              );
            })}
          </ul>
          {missing.length > 0 && (
            <p className="versions-muted versions-note">
              Added since this backup: {missing.join(', ')}. Restoring the whole project removes {missing.length === 1 ? 'it' : 'them'}.
            </p>
          )}
          {viewing && (
            <FileView
              versions={versions}
              version={v}
              path={viewing}
              current={files[viewing] ?? null}
              busy={busy}
              onClose={() => setViewing(null)}
              onRestore={() => onRestoreFile(v, viewing)}
            />
          )}
        </div>
      )}
    </li>
  );
}

export default function VersionsDialog({ versions, project, isOwner, me, files, onClose, notify }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(null); // { version } to restore the whole project
  useEffect(() => {
    versions.load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (fn) => {
    setBusy(true);
    try {
      return await fn();
    } catch (e) {
      notify(e.message || 'That didn’t work. Try again.');
      return null;
    } finally {
      setBusy(false);
    }
  };
  const undoWith = (backupId) => (backupId ? { label: 'Undo', onClick: () => run(() => versions.restore(backupId)) } : undefined);

  const backUp = () =>
    run(async () => {
      await versions.backUp(name.trim());
      notify(name.trim() ? `Backed up as “${name.trim()}”.` : 'Backed up.');
      setName('');
    });
  const restoreAll = (v) =>
    run(async () => {
      setConfirm(null);
      const r = await versions.restore(v.id);
      const n = (r.restored?.length || 0) + (r.removed?.length || 0);
      notify(n ? `Restored “${titleOf(v)}”: ${n} file${n === 1 ? '' : 's'} changed.` : `Nothing to restore: the files are already as in “${titleOf(v)}”.`, undoWith(n && r.backup));
    });
  const restoreFile = (v, path) =>
    run(async () => {
      const r = await versions.restore(v.id, path);
      notify(r.restored?.length ? `Restored ${path} from “${titleOf(v)}”.` : `${path} is already as in “${titleOf(v)}”.`, undoWith(r.restored?.length && r.backup));
    });

  return (
    <Dialog title="Backups" onClose={onClose} className="dialog-versions">
      <div className="versions-head">
        <span className="versions-head-icon" aria-hidden="true">
          <ArchiveRestore size={18} />
        </span>
        <div>
          <h2 className="dialog-title">Backups of {project.name}</h2>
          <p className="dialog-text">
            Back up any time; Tandem also backs up by itself every 30 minutes while the project changes. Restore one file, or the whole project, from
            any backup. What is there now is backed up first, so a restore can be undone.
          </p>
        </div>
      </div>

      <form
        className="versions-new"
        onSubmit={(e) => {
          e.preventDefault();
          backUp();
        }}
      >
        <input className="field-input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Name (optional), e.g. Before the big change" aria-label="Backup name" />
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <Save size={14} aria-hidden="true" />} Back up now
        </button>
      </form>

      {confirm && (
        <div className="versions-confirm" role="alertdialog" aria-label="Restore the whole project">
          <p>
            <strong>Restore “{titleOf(confirm)}”?</strong> Every file goes back to how it was {timeAgo(new Date(confirm.created_at).getTime())}; files added since are
            removed. Everyone in the project sees it at once. What is there now is backed up first, so you can undo this.
          </p>
          <div className="versions-confirm-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => restoreAll(confirm)} disabled={busy} data-autofocus>
              <RotateCcw size={13} aria-hidden="true" /> Restore project
            </button>
          </div>
        </div>
      )}

      {versions.unsupported ? (
        <p className="callout callout-warning">Backups need the 005 database update on the server (supabase/migrations/005_cowork_versions.sql).</p>
      ) : versions.error ? (
        <p className="field-error">{versions.error}</p>
      ) : versions.loading && !versions.versions.length ? (
        <p className="versions-muted">
          <Loader2 size={13} className="spin" aria-hidden="true" /> Loading backups…
        </p>
      ) : versions.versions.length ? (
        <ul className="versions-list">
          {versions.versions.map((v) => (
            <VersionRow
              key={v.id}
              v={v}
              versions={versions}
              isOwner={isOwner}
              isMine={v.created_by === me}
              files={files}
              busy={busy}
              onRestoreAll={(x) => setConfirm(x)}
              onRestoreFile={restoreFile}
            />
          ))}
        </ul>
      ) : (
        <p className="share-empty">No backups yet. “Back up now” keeps the project as it is.</p>
      )}

      <div className="dialog-actions versions-footer">
        {versions.budget > 0 && (
          <span className="versions-muted">
            Backups use {sizeText(versions.storage)} of {sizeText(versions.budget)}
          </span>
        )}
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Done
        </button>
      </div>
    </Dialog>
  );
}
