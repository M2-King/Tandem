import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from './api.js';

// Backups of the open shared project (005_cowork_versions.sql): the list,
// backing up, restoring (a file, or the whole project for owners) and undoing
// a restore. While the project is open and changes, the app asks for an
// automatic backup every 30 minutes; the server skips it if nothing changed or
// the last backup is recent. `cowork` is the live project (useCoworkLive).
const AUTO_EVERY = 30 * 60 * 1000;
const AUTO_CHECK = 5 * 60 * 1000;

export function useVersions({ cowork, projectId }) {
  const [state, setState] = useState({ loading: false, versions: [], storage: 0, budget: 0, error: null, unsupported: false });
  const coworkRef = useRef(cowork);
  coworkRef.current = cowork;
  const current = useRef(projectId);
  current.current = projectId;

  const load = useCallback(async () => {
    const id = current.current;
    if (!id) return;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const r = await api.versions(id);
      if (current.current === id) setState({ loading: false, versions: r.versions || [], storage: r.storage || 0, budget: r.budget || 0, error: null, unsupported: false });
    } catch (e) {
      const unsupported = /cowork_versions|Could not find the function/i.test(e.message || '') || e.code === 'PGRST202';
      if (current.current === id) setState((s) => ({ ...s, loading: false, unsupported, error: unsupported ? null : e.message || 'Couldn’t load the backups.' }));
    }
  }, []);

  useEffect(() => {
    setState({ loading: false, versions: [], storage: 0, budget: 0, error: null, unsupported: false });
  }, [projectId]);

  // Saved edits go first: a backup takes the files as saved.
  const flush = () => coworkRef.current.flushSaves?.().catch(() => {});

  const backUp = useCallback(
    async (name) => {
      await flush();
      const v = await api.createVersion(current.current, name);
      await load();
      return v;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [load]
  );

  // A file (path) or the whole project (path null). Returns the server's
  // answer: { restored, removed, backup } (backup: what was there before).
  const restore = useCallback(
    async (versionId, path = null) => {
      await flush();
      const r = await api.restoreVersion(current.current, versionId, path);
      const changed = [...(r.restored || []), ...(r.removed || [])];
      coworkRef.current.announceChanged?.(changed);
      await coworkRef.current.reloadProject?.();
      await load();
      return r;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [load]
  );

  const rename = useCallback(
    async (versionId, name) => {
      await api.nameVersion(current.current, versionId, name);
      await load();
    },
    [load]
  );
  const remove = useCallback(
    async (versionId) => {
      await api.deleteVersion(current.current, versionId);
      await load();
    },
    [load]
  );
  const fileText = useCallback((versionId, path) => api.versionFile(current.current, versionId, path), []);

  // Automatic backups while the project is open and changes.
  const lastSeen = useRef(null);
  const lastAuto = useRef(0);
  const updatedAt = cowork.project?.edited?.at ?? null; // when the project last changed
  const updatedRef = useRef(updatedAt);
  updatedRef.current = updatedAt;
  useEffect(() => {
    if (!projectId) return undefined;
    lastSeen.current = updatedRef.current;
    lastAuto.current = Date.now();
    const t = setInterval(async () => {
      if (document.visibilityState !== 'visible' || Date.now() - lastAuto.current < AUTO_EVERY) return;
      if (updatedRef.current === lastSeen.current) return; // nothing changed since the last one
      lastAuto.current = Date.now();
      lastSeen.current = updatedRef.current;
      try {
        await api.autoVersion(current.current);
      } catch {
        // a server without 005, or offline: next time
      }
    }, AUTO_CHECK);
    return () => clearInterval(t);
  }, [projectId]);

  return { ...state, load, backUp, restore, rename, remove, fileText };
}
