import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as api from './api.js';
import { PERMISSIONS, useCoworkRoute } from '../useCowork.js';
import { normalizeUsername, passwordProblem, personForUsername, usernameProblem } from '../accounts.js';
import { safeFileName, uniqueFileName } from '../../state/useDiskWorkspace.js';
import { describeEvents, hasEdit, mergeProject, retab } from './merge.js';
import { usePresence } from './usePresence.js';
import { useLiveText, isMissingFunction } from './useLiveText.js';

// Cowork live mode: the same interface as the preview (useCowork), backed by
// Supabase. Shared projects, people and invitations come from the server;
// each file is saved on its own a moment after typing stops, over the
// revision this device last had.
//
// Staying in step: while a project is open and the app is visible, it is
// reloaded every 10 seconds, when the window gets focus or becomes visible
// again (iPad resume), and when the network comes back; each file is merged
// by revision (merge.js). A teammate's newer save replaces a file with no
// edit here, and marks a Conflict on one with an edit (Use theirs / Keep
// mine). A save refused because someone saved first becomes that Conflict;
// a save that fails for lack of network is kept and retried.
//
// Live typing (useLiveText, with 003_cowork_live_text.sql on the server):
// text files are edited through shared documents, so a teammate's typing
// shows as it happens. A live file is saved together with its document; a
// newer saved document is merged in instead of becoming a Conflict; a
// teammate's edits are saved here too if they haven't saved them a few
// seconds later. Notebooks, and everything when 003 isn't there, work as
// described above.

const SAVE_DELAY = 700;
const LIVE_SAVE_DELAY = 1200; // live files: typing travels at once, saving can wait a little
const BACKUP_SAVE_DELAY = 6000; // a teammate's edit not saved by them by then: saved from here
const PROJECT_POLL = 10 * 1000;
const OVERVIEW_POLL = 30 * 1000;
const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
const online = () => typeof navigator === 'undefined' || navigator.onLine !== false;
const MAX_UPLOAD = 1024 * 1024;
const at = (iso) => (iso ? Date.parse(iso) : Date.now());

export function useCoworkLive({ notify }) {
  const { route, go } = useCoworkRoute();
  const [me, setMe] = useState(null); // { id, username }
  // Signing in with the account kept from last time ("Keep me signed in").
  const [restoring, setRestoring] = useState(!api.LIVE_PROBLEM);
  const [overview, setOverview] = useState(null); // from cowork_overview
  const [loading, setLoading] = useState(false);
  const [opened, setOpened] = useState(null); // the open project
  const [sync, setSync] = useState('saved'); // saved | saving | offline | unsaved | conflict
  const [conflicts, setConflicts] = useState({}); // path -> conflict (merge.js)
  const [arrival, setArrival] = useState(null);
  // Breakpoints are this device's own (for Debug), per project and file.
  const [breakpoints, setBreakpoints] = useState({});

  // Saving: per file, the server copy this device is in step with
  // ({ content, revision }), a pending timer, and whether its last save
  // failed (network or otherwise).
  const filesRef = useRef({});
  const base = useRef({});
  const conflictsRef = useRef({});
  const timers = useRef(new Map());
  const inflight = useRef(new Set());
  const failed = useRef(new Map()); // path -> { message, offline }
  const resave = useRef(new Set()); // paths to save again at once (live typing turned off mid-save)
  const openedRef = useRef(null);
  const openGen = useRef(0); // bumped each time a project is opened
  openedRef.current = opened;
  const meRef = useRef(null);
  meRef.current = me;
  const backups = useRef(new Map()); // path -> timer: saving a teammate's live edits if they don't
  const savedPull = useRef(null); // a reload soon after a teammate saved

  // Live typing. Text changed by anything but typing here (a teammate, undo,
  // starting a file) is shown without counting as an edit of ours, except undo.
  const liveTextRef = useRef(null);
  const { live: typing, editorContext: liveEditor } = useLiveText({
    me,
    getText: (path) => filesRef.current[path],
    onText: (path, text, origin) => liveTextRef.current?.(path, text, origin),
    // A teammate saved a live file: no need to save their edits from here;
    // reload soon to be in step with that revision.
    onSaved: (path) => {
      clearTimeout(backups.current.get(path));
      backups.current.delete(path);
      clearTimeout(savedPull.current);
      savedPull.current = setTimeout(() => pullRef.current?.(), 600);
    },
  });

  // ------------------------------------------------------------ people
  // Everyone is known by username; members also by their user id.
  const people = useMemo(() => {
    const all = {};
    const add = (username, id) => {
      if (!username) return;
      const person = { ...personForUsername(username), ...(id ? { id } : {}) };
      all[username] = all[username] && !id ? all[username] : person;
      if (id) all[id] = person;
    };
    if (me) add(me.username, me.id);
    for (const p of overview?.projects || []) for (const m of p.members || []) add(m.username, m.user_id);
    for (const i of overview?.invitations || []) {
      add(i.invited_by);
      for (const m of i.members || []) add(m.username);
    }
    for (const m of opened?.members || []) add(m.username, m.user_id);
    for (const i of opened?.invitations || []) add(i.username);
    return all;
  }, [me, overview, opened]);
  const viewer = me ? people[me.id] : null;

  // ------------------------------------------------------------ loading
  // `background`: a periodic reload; no spinner, no message.
  const refresh = useCallback(async ({ quiet = false, background = false } = {}) => {
    if (!background) setLoading(true);
    try {
      setOverview(await api.overview());
      return true;
    } catch (e) {
      if (!quiet && !background) notify(e.message);
      return false;
    } finally {
      if (!background) setLoading(false);
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
      typing.end();
      return undefined;
    }
    if (openedRef.current?.id === projectId) return undefined;
    let live = true;
    openGen.current += 1; // reloads started before this opening are dropped
    setOpened({ id: projectId, loading: true });
    typing.end();
    api.openProject(projectId).then(
      async (p) => {
        // The saved live documents (null: live typing stays off for this opening).
        let docs = null;
        if (typing.supported) {
          try {
            docs = await api.fileDocs(projectId);
          } catch (e) {
            if (isMissingFunction(e)) typing.disable();
          }
        }
        if (!live) return;
        filesRef.current = Object.fromEntries(p.files.map((f) => [f.path, f.content]));
        base.current = Object.fromEntries(p.files.map((f) => [f.path, { content: f.content, revision: f.revision }]));
        failed.current.clear();
        conflictsRef.current = {};
        setConflicts({});
        setSync('saved');
        const first = p.files.map((f) => f.path).find((x) => /\.(py|ipynb)$/.test(x)) || p.files[0]?.path;
        setOpened({ ...p, files: filesRef.current, open: first ? [first] : [], active: first || null });
        if (docs) typing.begin(p.files, docs);
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
  }, [me, projectId, lostAccess, notify, go, typing]);

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
      invites: (p.invitations || []).map((i) => ({ id: i.id, username: i.username, role: i.role, by: i.invited_by, at: at(i.created_at) })),
      edited: { by: p.updated_by, at: at(p.updated_at) },
      archived: p.archived_at ? { by: p.archived_by, at: at(p.archived_at) } : null,
    }),
    []
  );
  const listed = useMemo(() => (overview?.projects || []).map(asProject), [overview, asProject]);
  const projects = useMemo(() => listed.filter((p) => !p.archived), [listed]);
  const archived = useMemo(() => listed.filter((p) => p.archived), [listed]);
  const invitations = useMemo(
    () =>
      (overview?.invitations || []).map((i) => ({
        project: { id: i.project_id, name: i.project_name, members: (i.members || []).map((m) => ({ id: m.username, role: m.role })) },
        invite: { id: i.id, role: i.role, at: at(i.created_at), username: me?.username },
        from: people[i.invited_by] || personForUsername(i.invited_by || 'someone'),
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
    route.screen === 'local' ? 'local' : !me ? (restoring ? 'restoring' : 'signin') : route.screen === 'project' ? (project ? 'project' : 'opening') : 'home';

  // ------------------------------------------------------------ saving
  const settle = useCallback(() => {
    const failures = [...failed.current.values()];
    if (Object.keys(conflictsRef.current).length) setSync('conflict');
    else if (failures.length) setSync(!online() || failures.some((f) => f.offline) ? 'offline' : 'unsaved');
    else if (timers.current.size || inflight.current.size) setSync('saving');
    else setSync('saved');
  }, []);

  const setConflictsNow = (next) => {
    conflictsRef.current = next;
    setConflicts(next);
  };

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
      clearTimeout(backups.current.get(path));
      backups.current.delete(path);
      const id = openedRef.current?.id;
      if (!id || inflight.current.has(path)) return;
      // A live file: its text and document, taken together.
      const snap = typing.isLive(path) ? typing.snapshot(path) : null;
      const content = snap ? snap.content : filesRef.current[path];
      if (content === undefined || conflictsRef.current[path] || !base.current[path]) return;
      if (content === base.current[path].content) {
        failed.current.delete(path);
        settle();
        return;
      }
      inflight.current.add(path);
      settle();
      try {
        const r = snap
          ? await api.saveFileDoc(id, path, content, base.current[path].revision, snap.doc)
          : await api.saveFile(id, path, content, base.current[path].revision);
        base.current[path] = { content, revision: r.revision };
        failed.current.delete(path);
        if (snap) typing.announceSaved(path, r.revision);
      } catch (e) {
        if (lostAccess(e)) return;
        if (snap && isMissingFunction(e)) {
          // The server lost (or never had) live typing: carry on without it.
          typing.disable();
          resave.current.add(path);
        } else if (snap && e.code === 'PT409') {
          // Someone saved first: their document is merged in by the reload
          // (no Conflict for live files), then this saves again if needed.
          failed.current.delete(path);
          pullRef.current?.();
        } else if (e.code === 'PT409' || e.code === 'PT404') {
          // Someone saved first (or renamed or removed the file): a Conflict,
          // settled once the newer copy is here.
          failed.current.delete(path);
          setConflictsNow({ ...conflictsRef.current, [path]: { kind: 'pending' } });
          pullRef.current?.();
        } else {
          const network = e.code === 'offline' || !online();
          const first = !failed.current.has(path);
          failed.current.set(path, { message: e.message, offline: network });
          if (first) {
            if (network) notify(`Offline: ${path} is kept on this device and saved when the connection is back.`, { label: 'Retry', onClick: () => save(path) });
            else notify(`Unsaved: ${e.message} Copy the draft before closing the app if it still fails.`, { label: 'Copy draft', onClick: () => copyDraft(path) });
          }
        }
      } finally {
        inflight.current.delete(path);
        // Typed again while saving: save the newer text too.
        if (resave.current.delete(path) || (filesRef.current[path] !== content && !failed.current.has(path) && !conflictsRef.current[path] && base.current[path]?.content === content)) save(path);
        settle();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settle, lostAccess, notify]
  );

  // Saves that failed for lack of network: try again (back online, or on the
  // next reload).
  const retryFailed = useCallback(() => {
    for (const [path, f] of failed.current) if (f.offline && !inflight.current.has(path)) save(path);
  }, [save]);

  // ------------------------------------------------------------ staying in step
  const pulling = useRef(false);
  const pullAgain = useRef(false);
  const pullRef = useRef(null);
  const pull = useCallback(async () => {
    const id = openedRef.current?.id;
    if (!id || openedRef.current.loading) return;
    if (pulling.current) {
      pullAgain.current = true;
      return;
    }
    pulling.current = true;
    const gen = openGen.current;
    try {
      const p = await api.openProject(id);
      // Left, reopened or still opening meanwhile: this result is stale.
      if (openedRef.current?.id !== id || openedRef.current.loading || openGen.current !== gen) return;
      // Live files a teammate saved since: merge their saved document in (no
      // Conflict); the text follows through liveTextRef. Files new here get
      // their documents too.
      let docs = {};
      const plainSaves = []; // live files a build without live typing saved since: caught up below
      const behind = p.files.filter((f) => typing.isLive(f.path) && base.current[f.path] && f.revision > base.current[f.path].revision && !inflight.current.has(f.path));
      const appeared = p.files.filter((f) => typing.isLivePath(f.path) && !(f.path in base.current));
      if (typing.supported && (behind.length || appeared.length)) {
        try {
          docs = await api.fileDocs(id);
        } catch (e) {
          if (isMissingFunction(e)) typing.disable();
        }
        if (openedRef.current?.id !== id || openedRef.current.loading || openGen.current !== gen) return;
        for (const f of behind) {
          const d = docs[f.path];
          // (A document newer than this listing: a teammate saved again meanwhile;
          // merging it is safe, and a save from here then catches up.)
          if (!d || d.revision < f.revision) {
            plainSaves.push(f); // saved by an older build: below
            continue;
          }
          typing.merge(f.path, d.doc);
          base.current[f.path] = { content: f.content, revision: f.revision };
          // Edits here (or a teammate's not saved yet) on top: save them.
          if (filesRef.current[f.path] !== f.content && !timers.current.has(f.path)) timers.current.set(f.path, setTimeout(() => save(f.path), LIVE_SAVE_DELAY));
        }
      }
      const merged = mergeProject(
        { files: filesRef.current, base: base.current, conflicts: conflictsRef.current },
        p.files,
        { busy: new Set(inflight.current) }
      );
      const before = filesRef.current;
      filesRef.current = merged.files;
      base.current = merged.base;
      // Edits that moved with a renamed file are saved under the new name.
      for (const e of merged.events) {
        if (e.type === 'renamed') {
          clearTimeout(timers.current.get(e.from));
          timers.current.delete(e.from);
          failed.current.delete(e.from);
          if (hasEdit(merged.files, merged.base, e.path) && !merged.conflicts[e.path]) {
            timers.current.set(e.path, setTimeout(() => save(e.path), SAVE_DELAY));
          }
        }
        if (e.type === 'removed') failed.current.delete(e.path);
      }
      // A conflicted file waits for a choice; a pending save would only be refused.
      for (const path of Object.keys(merged.conflicts)) {
        clearTimeout(timers.current.get(path));
        timers.current.delete(path);
        failed.current.delete(path);
      }
      setConflictsNow(merged.conflicts);
      // Live documents follow: renamed, removed, new; text saved by an older build.
      for (const e of merged.events) {
        if (e.type === 'renamed') typing.rename(e.from, e.path);
        if (e.type === 'removed') typing.drop(e.path);
        if (e.type === 'created') {
          const f = p.files.find((x) => x.path === e.path);
          if (f) typing.add(f, docs[f.path] && docs[f.path].revision >= f.revision ? docs[f.path] : null);
        }
      }
      // Only files whose newer revision came without a document (an older
      // build saved them) and that took the server's text (no edit here).
      // Never a file that just appeared or is in step: its document is the
      // newer copy (a teammate's live typing may not be saved yet).
      for (const f of plainSaves) {
        if (typing.isLive(f.path) && merged.files[f.path] === f.content && typing.text(f.path) !== f.content) typing.catchUp(f.path, f.content, f.revision);
      }
      setOpened((o) => {
        if (!o || o.id !== id || o.loading) return o;
        const tabs = retab(o, merged.files, merged.events);
        return {
          ...o,
          name: p.name,
          role: p.role,
          members: p.members,
          invitations: p.invitations,
          updated_at: p.updated_at,
          updated_by: p.updated_by,
          files: merged.files === before ? o.files : merged.files,
          ...tabs,
        };
      });
      const me = meRef.current?.username;
      const note = describeEvents(merged.events, me);
      if (note) notify(`${note}.`);
      for (const e of merged.events) {
        if (e.type === 'conflict') {
          notify(e.by ? `${e.by} saved a newer version of ${e.path}. Choose which to keep.` : `${e.path} was removed by a teammate, but you have unsaved edits in it.`);
        }
      }
      retryFailed();
    } catch (e) {
      if (e.code !== 'offline') lostAccess(e);
    } finally {
      pulling.current = false;
      settle();
      if (pullAgain.current) {
        pullAgain.current = false;
        pullRef.current?.();
      }
    }
  }, [lostAccess, notify, save, settle, retryFailed]);
  pullRef.current = pull;

  // Reload the open project: every 10 s while visible, on focus or becoming
  // visible (iPad resume), and when the network comes back.
  // (Through refs, so the timer only restarts when the project or visibility changes.)
  const projectReady = !!(opened && !opened.loading && opened.id === projectId);
  const settleRef = useRef(settle);
  settleRef.current = settle;
  const retryRef = useRef(retryFailed);
  retryRef.current = retryFailed;
  useEffect(() => {
    if (!me || !projectReady) return undefined;
    let timer = null;
    const pullNow = () => pullRef.current?.();
    const start = () => {
      clearInterval(timer);
      timer = visible() ? setInterval(() => visible() && pullNow(), PROJECT_POLL) : null;
    };
    const onFocus = () => pullNow();
    const onVisibility = () => {
      if (visible()) pullNow();
      start();
    };
    const onOnline = () => {
      settleRef.current();
      retryRef.current();
      pullNow();
    };
    const onOffline = () => settleRef.current();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    start();
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [me, projectReady]);

  // Shared projects: reload the list on focus and every 30 s while visible,
  // so invitations and changes appear without pressing Refresh.
  const onHome = !!me && route.screen !== 'project' && route.screen !== 'local';
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!onHome) return undefined;
    let timer = null;
    const reload = () => visible() && refreshRef.current({ background: true });
    const start = () => {
      clearInterval(timer);
      timer = visible() ? setInterval(reload, OVERVIEW_POLL) : null;
    };
    const onVisibility = () => {
      reload();
      start();
    };
    window.addEventListener('focus', reload);
    window.addEventListener('online', reload);
    document.addEventListener('visibilitychange', onVisibility);
    start();
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', reload);
      window.removeEventListener('online', reload);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [onHome]);

  // A conflict: take the newer server copy, or save this device's text over it.
  const resolveConflict = useCallback(
    async (path, choice) => {
      const c = conflictsRef.current[path];
      if (!c || c.kind === 'pending') return;
      const rest = { ...conflictsRef.current };
      delete rest[path];
      if (c.kind === 'newer') {
        base.current[path] = { content: c.content, revision: c.revision };
        setConflictsNow(rest);
        if (choice === 'theirs') {
          filesRef.current = { ...filesRef.current, [path]: c.content };
          failed.current.delete(path);
          setOpened((o) => (o ? { ...o, files: filesRef.current } : o));
          typing.catchUp(path, c.content, c.revision);
          settle();
        } else {
          await save(path); // over the newer revision
        }
        return;
      }
      // Removed by a teammate.
      setConflictsNow(rest);
      if (choice === 'theirs') {
        const files = { ...filesRef.current };
        delete files[path];
        filesRef.current = files;
        delete base.current[path];
        failed.current.delete(path);
        setOpened((o) => (o && !o.loading ? { ...o, files, ...retab(o, files, []) } : o));
        typing.drop(path);
        settle();
      } else {
        const id = openedRef.current?.id;
        const text = filesRef.current[path];
        try {
          const r = await api.createFile(id, path, text);
          base.current[path] = { content: text, revision: r.revision };
          typing.add({ path, content: text, revision: r.revision }, null, { here: true });
        } catch (e) {
          if (!lostAccess(e)) {
            notify(e.message);
            setConflictsNow({ ...conflictsRef.current, [path]: c });
          }
        }
        settle();
      }
    },
    [save, settle, lostAccess, notify]
  );

  const setFile = useCallback(
    (path, text, { typed = false } = {}) => {
      if (filesRef.current[path] === text) return;
      filesRef.current = { ...filesRef.current, [path]: text };
      setOpened((o) => (o ? { ...o, files: filesRef.current } : o));
      clearTimeout(timers.current.get(path));
      timers.current.delete(path);
      // In a conflict the edit is kept here until Use theirs / Keep mine.
      const isLive = typing.isLive(path);
      if (!conflictsRef.current[path]) timers.current.set(path, setTimeout(() => save(path), isLive ? LIVE_SAVE_DELAY : SAVE_DELAY));
      // A live file: the editor has put typing into the document already (just
      // after this runs); anything else (an accepted change) goes in as the difference.
      if (isLive && !typed) queueMicrotask(() => typing.setText(path, filesRef.current[path]));
      settle();
    },
    [save, settle, typing]
  );

  // Text of a live file changed by anything but typing here.
  liveTextRef.current = (path, text, origin) => {
    if (!(path in filesRef.current) || filesRef.current[path] === text) return;
    filesRef.current = { ...filesRef.current, [path]: text };
    setOpened((o) => (o && !o.loading ? { ...o, files: filesRef.current } : o));
    if (origin === 'undo' || origin === 'kept') {
      // Undo/redo here, or typing kept from before the file was live: ours to save.
      clearTimeout(timers.current.get(path));
      timers.current.set(path, setTimeout(() => save(path), LIVE_SAVE_DELAY));
    } else if (origin === 'remote' && !timers.current.has(path) && !backups.current.has(path)) {
      // A teammate's edit: they save it; if they haven't a little later, save it from here.
      backups.current.set(path, setTimeout(() => save(path), BACKUP_SAVE_DELAY));
    }
    settle();
  };

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
    base.current[path] = { content, revision };
    showFiles((o) => ({ ...o, files: filesRef.current, ...(open ? { open: o.open.includes(path) ? o.open : [...o.open, path], active: path } : {}) }));
  };

  const createFile = useCallback(
    async (path, text = '') => {
      const id = openedRef.current?.id;
      try {
        const r = await api.createFile(id, path, text);
        addLocal(path, text, r.revision);
        typing.add({ path, content: text, revision: r.revision }, null, { here: true });
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
          typing.add({ path, content: text, revision: r.revision }, null, { here: true });
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
        base.current[path] = { content: base.current[from]?.content ?? files[path], revision: r.revision };
        delete base.current[from];
        failed.current.delete(from);
        if (conflictsRef.current[from]) {
          const next = { ...conflictsRef.current };
          delete next[from];
          setConflictsNow(next);
        }
        showFiles((o) => ({ ...o, files, open: o.open.map((x) => (x === from ? path : x)), active: o.active === from ? path : o.active }));
        typing.rename(from, path);
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
      delete base.current[path];
      failed.current.delete(path);
      clearTimeout(backups.current.get(path));
      backups.current.delete(path);
      typing.drop(path);
      if (conflictsRef.current[path]) {
        const next = { ...conflictsRef.current };
        delete next[path];
        setConflictsNow(next);
      }
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
      breakpoints: breakpoints[opened.id] || {},
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
      toggleBreakpoint: (path, line) =>
        setBreakpoints((all) => {
          const mine = all[opened.id] || {};
          const current = mine[path] || [];
          const next = current.includes(line) ? current.filter((l) => l !== line) : [...current, line].sort((a, b) => a - b);
          return { ...all, [opened.id]: { ...mine, [path]: next } };
        }),
      resetFile: () => {},
      reset: () => {},
      reload: () => {},
      noteFile: () => {},
      addFiles: null,
    };
  }, [project, opened, breakpoints, openFile, closeTab, setFile, createFile, uploadFiles, renameFile, removeFile, flush]);

  // ------------------------------------------------------------ who's online
  // Realtime presence and cursors (usePresence). Teammates' saved text still
  // arrives through the reloads above.
  const live = usePresence({
    me,
    projectId: projectReady ? projectId : null,
    enabled: !!me,
    activePath: workspace?.activePath ?? null,
    onMessage: typing.receive,
    onJoined: typing.joined,
  });
  typing.sendRef.current = live.send;
  useEffect(() => typing.presenceChanged(live.state), [live.state, typing]);
  const presence = useMemo(() => {
    if (!project) return [];
    const memberIds = new Set(project.members.map((m) => m.id));
    return Object.values(live.peers)
      .filter((p) => memberIds.has(p.user_id) && p.path)
      .map((p) => {
        const person = people[p.user_id] || personForUsername(p.username || 'someone');
        return { person: p.user_id, name: person.name, hue: person.hue, path: p.path, cell: p.cell || null, step: p.cursor || null };
      });
  }, [project, live.peers, people]);

  // ------------------------------------------------------------ sign in
  // Both return the account ({ id, username, name }) or throw with a
  // message to show; completeSignIn then loads Shared projects.
  const checked = (value, password) => {
    const username = normalizeUsername(value);
    const problem = usernameProblem(username) || passwordProblem(password);
    if (problem) throw new Error(problem);
    return username;
  };
  const asAccount = (user) => ({ ...personForUsername(user.username), id: user.id });
  // { remember }: "Keep me signed in on this device" (on unless turned off).
  const signInWithPassword = useCallback(async (value, password, { remember = true } = {}) => {
    const username = checked(value, password);
    api.setRemember(remember);
    return asAccount(await api.signInWithPassword(username, password));
  }, []);
  const signUp = useCallback(async (value, password, { remember = true } = {}) => {
    const username = checked(value, password);
    api.setRemember(remember);
    return asAccount(await api.signUp(username, password));
  }, []);
  const completeSignIn = useCallback(
    async (user) => {
      setMe({ id: user.id, username: user.username });
      await refresh();
    },
    [refresh]
  );

  // At start: sign in with the account kept from last time, if any.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || !restoring) return;
    restoredRef.current = true;
    api
      .restoreSession()
      .then((user) => {
        if (!user) return null;
        setMe({ id: user.id, username: user.username });
        return refresh({ quiet: true });
      })
      .catch(() => {})
      .finally(() => setRestoring(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const searchPeople = useCallback(async (query) => {
    try {
      return (await api.searchAccounts(normalizeUsername(query))).map((x) => ({ username: x.username, name: x.username }));
    } catch {
      return [];
    }
  }, []);
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
    async (projectId, value, role) => {
      try {
        await api.invite(projectId, normalizeUsername(value), role);
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
    (projectId, username) => {
      const inv = (openedRef.current?.invitations || []).find((i) => i.username === username);
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
    conflicts,
    resolveConflict,
    reloadProject: pull,
    presence,
    presenceState: live.state,
    presenceReason: live.reason,
    reportCursor: live.report,
    liveText: liveEditor,
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
    signInWithPassword,
    signUp,
    completeSignIn,
    searchPeople,
    signOut,
  };
}
