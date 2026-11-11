import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as api from './api.js';
import { PERMISSIONS, useCoworkRoute } from '../useCowork.js';
import { personForEmail } from '../fixtures.js';
import { safeFileName, uniqueFileName } from '../../state/useDiskWorkspace.js';

// Cowork live mode: the same interface as the preview (useCowork), backed by
// Supabase. Shared projects, people and invitations come from the server;
// each file is saved on its own a moment after typing stops, over the
// revision it was opened at. A save that fails keeps the edit here and the
// status shows Unsaved.

const SAVE_DELAY = 700;
const MAX_UPLOAD = 1024 * 1024;
const at = (iso) => (iso ? Date.parse(iso) : Date.now());

export function useCoworkLive({ notify }) {
  const { route, go } = useCoworkRoute();
  const [me, setMe] = useState(null); // { id, email }
  const [overview, setOverview] = useState(null); // from cowork_overview
  const [loading, setLoading] = useState(false);
  const [opened, setOpened] = useState(null); // the open project
  const [sync, setSync] = useState('saved'); // saved | saving | unsaved
  const [arrival, setArrival] = useState(null);

  // Saving: per file, the revision it was opened at, a pending timer, and
  // whether its last save failed.
  const filesRef = useRef({});
  const revisions = useRef({});
  const timers = useRef(new Map());
  const inflight = useRef(new Set());
  const failed = useRef(new Map()); // path -> message
  const openedRef = useRef(null);
  openedRef.current = opened;

  // ------------------------------------------------------------ people
  // Everyone is known by email; members also by their user id.
  const people = useMemo(() => {
    const all = {};
    const add = (email, id) => {
      if (!email) return;
      const person = { ...personForEmail(email), ...(id ? { id } : {}) };
      all[email] = all[email] && !id ? all[email] : person;
      if (id) all[id] = person;
    };
    if (me) add(me.email, me.id);
    for (const p of overview?.projects || []) for (const m of p.members || []) add(m.email, m.user_id);
    for (const i of overview?.invitations || []) {
      add(i.invited_by_email);
      for (const m of i.members || []) add(m.email);
    }
    for (const m of opened?.members || []) add(m.email, m.user_id);
    for (const i of opened?.invitations || []) add(i.email);
    return all;
  }, [me, overview, opened]);
  const viewer = me ? people[me.id] : null;

  // ------------------------------------------------------------ loading
  const refresh = useCallback(async ({ quiet = false } = {}) => {
    setLoading(true);
    try {
      setOverview(await api.overview());
      return true;
    } catch (e) {
      if (!quiet) notify(e.message);
      return false;
    } finally {
      setLoading(false);
    }
  }, [notify]);

  // Removed from a project, or it was archived: back to the list.
  const lostAccess = useCallback(
    (e) => {
      if (e.code === 'PT403' || (e.code === 'PT409' && /archived/.test(e.message))) {
        notify(e.message);
        setOpened(null);
        go('home');
        refresh({ quiet: true });
        return true;
      }
      return false;
    },
    [notify, go, refresh]
  );

  const projectId = route.screen === 'project' ? route.id : null;
  useEffect(() => {
    if (!me || !projectId) {
      setOpened(null);
      return undefined;
    }
    if (openedRef.current?.id === projectId) return undefined;
    let live = true;
    setOpened({ id: projectId, loading: true });
    api.openProject(projectId).then(
      (p) => {
        if (!live) return;
        filesRef.current = Object.fromEntries(p.files.map((f) => [f.path, f.content]));
        revisions.current = Object.fromEntries(p.files.map((f) => [f.path, f.revision]));
        failed.current.clear();
        setSync('saved');
        const first = p.files.map((f) => f.path).find((x) => /\.(py|ipynb)$/.test(x)) || p.files[0]?.path;
        setOpened({ ...p, files: filesRef.current, open: first ? [first] : [], active: first || null });
      },
      (e) => {
        if (!live) return;
        setOpened(null);
        if (!lostAccess(e)) {
          notify(e.message);
          go('home');
        }
      }
    );
    return () => {
      live = false;
    };
  }, [me, projectId, lostAccess, notify, go]);

  // Reload the open project's people and invitations (after changes there).
  const reloadPeople = useCallback(async () => {
    const id = openedRef.current?.id;
    if (!id) return;
    try {
      const p = await api.openProject(id);
      setOpened((o) => (o && o.id === id ? { ...o, name: p.name, role: p.role, members: p.members, invitations: p.invitations } : o));
    } catch (e) {
      lostAccess(e);
    }
  }, [lostAccess]);

  // ------------------------------------------------------------ shapes the UI uses
  const asProject = useCallback(
    (p) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      members: (p.members || []).map((m) => ({ id: m.user_id, role: m.role })),
      invites: (p.invitations || []).map((i) => ({ id: i.id, email: i.email, role: i.role, by: i.invited_by_email, at: at(i.created_at) })),
      edited: { by: p.updated_by_email, at: at(p.updated_at) },
      archived: p.archived_at ? { by: p.archived_by_email, at: at(p.archived_at) } : null,
    }),
    []
  );
  const listed = useMemo(() => (overview?.projects || []).map(asProject), [overview, asProject]);
  const projects = useMemo(() => listed.filter((p) => !p.archived), [listed]);
  const archived = useMemo(() => listed.filter((p) => p.archived), [listed]);
  const invitations = useMemo(
    () =>
      (overview?.invitations || []).map((i) => ({
        project: { id: i.project_id, name: i.project_name, members: (i.members || []).map((m) => ({ id: m.email, role: m.role })) },
        invite: { id: i.id, role: i.role, at: at(i.created_at), email: me?.email },
        from: people[i.invited_by_email] || personForEmail(i.invited_by_email || 'someone@unknown'),
      })),
    [overview, people, me]
  );
  const project = useMemo(
    () => (opened && !opened.loading ? { ...asProject(opened), files: opened.files, open: opened.open, active: opened.active } : null),
    [opened, asProject]
  );
  const roleIn = useCallback((p) => p?.role || p?.members?.find((m) => m.id === me?.id)?.role || null, [me]);
  const can = useCallback((p, action) => {
    const role = roleIn(p);
    return !!(role && PERMISSIONS.find((r) => r.id === action)?.[role]);
  }, [roleIn]);

  const screen =
    route.screen === 'local' ? 'local' : !me ? 'signin' : route.screen === 'project' ? (project ? 'project' : 'opening') : 'home';

  // ------------------------------------------------------------ saving
  const settle = useCallback(() => {
    if (failed.current.size) setSync('unsaved');
    else if (timers.current.size || inflight.current.size) setSync('saving');
    else setSync('saved');
  }, []);

  const copyDraft = (path) => {
    const text = filesRef.current[path] ?? '';
    navigator.clipboard?.writeText(text).then(
      () => notify(`Copied your version of ${path}.`),
      () => notify('Couldn’t copy here. Select the text in the editor and copy it.')
    );
  };

  const save = useCallback(
    async (path) => {
      timers.current.delete(path);
      const id = openedRef.current?.id;
      if (!id || inflight.current.has(path)) return;
      const content = filesRef.current[path];
      if (content === undefined) return;
      inflight.current.add(path);
      settle();
      try {
        const r = await api.saveFile(id, path, content, revisions.current[path]);
        revisions.current[path] = r.revision;
        failed.current.delete(path);
      } catch (e) {
        if (lostAccess(e)) return;
        const first = !failed.current.has(path);
        failed.current.set(path, e.message);
        if (first) {
          const stale = e.code === 'PT409' || e.code === 'PT404';
          notify(`Unsaved: ${e.message} Copy the draft before closing the app if it still fails.`, stale
            ? { label: 'Copy draft', onClick: () => copyDraft(path) }
            : { label: 'Retry', onClick: () => save(path) });
        }
      } finally {
        inflight.current.delete(path);
        // Typed again while saving: save the newer text too.
        if (filesRef.current[path] !== content && !failed.current.has(path)) save(path);
        settle();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settle, lostAccess, notify]
  );

  const setFile = useCallback(
    (path, text) => {
      if (filesRef.current[path] === text) return;
      filesRef.current = { ...filesRef.current, [path]: text };
      setOpened((o) => (o ? { ...o, files: filesRef.current } : o));
      clearTimeout(timers.current.get(path));
      timers.current.set(path, setTimeout(() => save(path), SAVE_DELAY));
      settle();
    },
    [save, settle]
  );

  const flush = useCallback(async () => {
    const paths = [...timers.current.keys()];
    paths.forEach((p) => clearTimeout(timers.current.get(p)));
    await Promise.all(paths.map((p) => save(p)));
  }, [save]);

  // Leaving a project with edits still waiting: save them first.
  useEffect(() => {
    if (!projectId) flush();
  }, [projectId, flush]);

  // ------------------------------------------------------------ files
  const showFiles = (fn) => setOpened((o) => (o ? fn(o) : o));
  const openFile = useCallback((path) => showFiles((o) => ({ ...o, open: o.open.includes(path) ? o.open : [...o.open, path], active: path })), []);
  const closeTab = useCallback(
    (path) =>
      showFiles((o) => {
        const index = o.open.indexOf(path);
        const open = o.open.filter((x) => x !== path);
        return { ...o, open, active: o.active === path ? open[Math.min(index, open.length - 1)] || null : o.active };
      }),
    []
  );
  const addLocal = (path, content, revision, { open = true } = {}) => {
    filesRef.current = { ...filesRef.current, [path]: content };
    revisions.current[path] = revision;
    showFiles((o) => ({ ...o, files: filesRef.current, ...(open ? { open: o.open.includes(path) ? o.open : [...o.open, path], active: path } : {}) }));
  };

  const createFile = useCallback(
    async (path, text = '') => {
      const id = openedRef.current?.id;
      try {
        const r = await api.createFile(id, path, text);
        addLocal(path, text, r.revision);
      } catch (e) {
        if (!lostAccess(e)) throw e; // the New file dialog shows it
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lostAccess]
  );

  const uploadFiles = useCallback(
    async (list) => {
      const id = openedRef.current?.id;
      const chosen = Array.from(list || []);
      if (!id || !chosen.length) return;
      const taken = new Set(Object.keys(filesRef.current));
      const added = [];
      const skipped = [];
      for (const file of chosen) {
        if (file.size > MAX_UPLOAD) {
          skipped.push(`${file.name} is larger than 1 MB`);
          continue;
        }
        let text;
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          if (bytes.subarray(0, 8192).includes(0)) throw new Error('binary');
          text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
          skipped.push(`${file.name} isn’t UTF-8 text`);
          continue;
        }
        const path = uniqueFileName(safeFileName(file.name), taken);
        try {
          const r = await api.createFile(id, path, text);
          taken.add(path);
          addLocal(path, text, r.revision, { open: !added.length });
          added.push(path);
        } catch (e) {
          if (lostAccess(e)) return;
          skipped.push(`${file.name}: ${e.message}`);
        }
      }
      if (added.length) notify(added.length === 1 ? `Uploaded ${added[0]}.` : `Uploaded ${added.length} files: ${added.join(', ')}.`);
      if (skipped.length) notify(`Not uploaded: ${skipped.join('; ')}. Shared projects take UTF-8 text files up to 1 MB.`);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lostAccess, notify]
  );

  // Returns an error message, or null when renamed.
  const renameFile = useCallback(
    async (from, to) => {
      const id = openedRef.current?.id;
      const path = to.trim().replace(/^\.\//, '');
      if (path === from) return null;
      if (path in filesRef.current) return `${path} already exists.`;
      await flush();
      try {
        const r = await api.renameFile(id, from, path);
        const files = {};
        for (const [k, v] of Object.entries(filesRef.current)) files[k === from ? path : k] = v;
        filesRef.current = files;
        revisions.current[path] = r.revision;
        delete revisions.current[from];
        failed.current.delete(from);
        showFiles((o) => ({ ...o, files, open: o.open.map((x) => (x === from ? path : x)), active: o.active === from ? path : o.active }));
        return null;
      } catch (e) {
        if (lostAccess(e)) return null;
        return e.message;
      }
    },
    [flush, lostAccess]
  );

  const removeFile = useCallback(
    async (path) => {
      const id = openedRef.current?.id;
      const content = filesRef.current[path];
      clearTimeout(timers.current.get(path));
      timers.current.delete(path);
      try {
        await api.removeFile(id, path);
      } catch (e) {
        if (!lostAccess(e)) notify(e.message);
        return;
      }
      const files = { ...filesRef.current };
      delete files[path];
      filesRef.current = files;
      delete revisions.current[path];
      failed.current.delete(path);
      settle();
      showFiles((o) => {
        const open = o.open.filter((x) => x !== path);
        return { ...o, files, open, active: o.active === path ? open[0] || null : o.active };
      });
      notify(`Removed ${path} for everyone in ${openedRef.current?.name}.`, {
        label: 'Undo',
        onClick: () => createFile(path, content).catch((e) => notify(e.message)),
      });
    },
    [lostAccess, notify, settle, createFile]
  );

  const workspace = useMemo(() => {
    if (!project) return null;
    const files = opened.files;
    const open = opened.open.filter((p) => p in files);
    return {
      files,
      fileOrder: Object.keys(files).sort(),
      openTabs: open,
      activePath: open.includes(opened.active) ? opened.active : open[0] || null,
      breakpoints: {},
      loading: false,
      project: { name: opened.name, root: `cowork:${opened.id}` },
      openFile,
      closeTab,
      setFile,
      createFile,
      uploadFiles,
      renameFile,
      removeFile,
      flush,
      toggleBreakpoint: () => {},
      resetFile: () => {},
      reset: () => {},
      reload: () => {},
      noteFile: () => {},
      addFiles: null,
    };
  }, [project, opened, openFile, closeTab, setFile, createFile, uploadFiles, renameFile, removeFile, flush]);

  // ------------------------------------------------------------ sign in
  const sendCode = useCallback((email) => api.sendCode(email), []);
  const verifyCode = useCallback(async (email, code) => {
    const user = await api.verifyCode(email, code);
    return { id: user.id, email: (user.email || email).toLowerCase(), name: personForEmail((user.email || email).toLowerCase()).name };
  }, []);
  const completeSignIn = useCallback(
    async (user) => {
      setMe({ id: user.id, email: user.email });
      await refresh();
    },
    [refresh]
  );
  const signOut = useCallback(async () => {
    await flush();
    await api.signOut();
    setMe(null);
    setOverview(null);
    setOpened(null);
    go('home');
    notify('Signed out of Tandem Cowork.');
  }, [flush, go, notify]);

  // ------------------------------------------------------------ projects and people
  const run = useCallback(
    async (fn, { after, message } = {}) => {
      try {
        const result = await fn();
        if (message) notify(message);
        await after?.();
        return result ?? true;
      } catch (e) {
        if (!lostAccess(e)) notify(e.message);
        return false;
      }
    },
    [notify, lostAccess]
  );

  const createProject = useCallback(
    async (name) => {
      const p = await run(() => api.createProject(name), { after: () => refresh({ quiet: true }) });
      if (p?.id) go('project', p.id);
      return p?.id;
    },
    [run, refresh, go]
  );

  // Joining: accept on the server first (the invitation card shows
  // "Joining…"); enter() then opens the project.
  const join = useCallback(
    async (projectId) => {
      const inv = (overview?.invitations || []).find((i) => i.project_id === projectId);
      if (!inv) return false;
      return run(() => api.acceptInvitation(inv.id));
    },
    [overview, run]
  );
  const enter = useCallback(
    async (projectId) => {
      await refresh({ quiet: true });
      setArrival({ project: projectId, person: me?.id, at: Date.now() });
      setTimeout(() => setArrival((a) => (a?.project === projectId ? null : a)), 4000);
      go('project', projectId);
      const name = (overview?.invitations || []).find((i) => i.project_id === projectId)?.project_name;
      if (name) notify(`Welcome to ${name}.`);
    },
    [refresh, me, go, overview, notify]
  );
  const decline = useCallback(
    async (projectId) => {
      const inv = (overview?.invitations || []).find((i) => i.project_id === projectId);
      if (!inv) return false;
      return run(() => api.declineInvitation(inv.id), { message: `Declined the invitation to ${inv.project_name}.`, after: () => refresh({ quiet: true }) });
    },
    [overview, run, refresh]
  );

  // Returns an error message, or null.
  const invite = useCallback(
    async (projectId, email, role) => {
      try {
        await api.invite(projectId, email, role);
        await reloadPeople();
        return null;
      } catch (e) {
        if (lostAccess(e)) return null;
        return e.message;
      }
    },
    [reloadPeople, lostAccess]
  );
  const cancelInvite = useCallback(
    (projectId, email) => {
      const inv = (openedRef.current?.invitations || []).find((i) => i.email === email);
      if (inv) run(() => api.cancelInvitation(inv.id), { after: reloadPeople });
    },
    [run, reloadPeople]
  );
  const setRole = useCallback((projectId, userId, role) => run(() => api.setRole(projectId, userId, role), { after: reloadPeople }), [run, reloadPeople]);
  const removeMember = useCallback(
    (projectId, userId) =>
      run(() => api.removeMember(projectId, userId), {
        after: userId === me?.id ? () => refresh({ quiet: true }) : reloadPeople,
      }),
    [run, reloadPeople, refresh, me]
  );

  const renameProject = useCallback(
    async (projectId, name) => {
      try {
        const r = await api.renameProject(projectId, name);
        setOpened((o) => (o && o.id === projectId ? { ...o, name: r.name } : o));
        refresh({ quiet: true });
        return null;
      } catch (e) {
        if (lostAccess(e)) return null;
        return e.message;
      }
    },
    [refresh, lostAccess]
  );
  const restoreProject = useCallback(
    (projectId) => run(() => api.setArchived(projectId, false), { message: 'Restored the project.', after: () => refresh({ quiet: true }) }),
    [run, refresh]
  );
  const archiveProject = useCallback(
    async (projectId) => {
      const name = openedRef.current?.name || 'the project';
      await flush();
      const ok = await run(() => api.setArchived(projectId, true));
      if (!ok) return;
      setOpened(null);
      go('home');
      await refresh({ quiet: true });
      notify(`Archived ${name}.`, { label: 'Undo', onClick: () => restoreProject(projectId) });
    },
    [flush, run, go, refresh, notify, restoreProject]
  );

  return {
    live: true,
    configProblem: api.LIVE_PROBLEM,
    screen,
    loading,
    opening: screen === 'opening',
    project,
    projects,
    archived,
    invitations,
    people,
    viewer,
    roleIn,
    can,
    sync,
    presence: [],
    workspace,
    go,
    refresh,
    refreshPeople: reloadPeople,
    createProject,
    join,
    enter,
    decline,
    invite,
    cancelInvite,
    setRole,
    removeMember,
    renameProject,
    archiveProject,
    restoreProject,
    arrival,
    signedIn: !!me,
    sendCode,
    verifyCode,
    completeSignIn,
    signOut,
  };
}
