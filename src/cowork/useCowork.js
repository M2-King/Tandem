import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PEOPLE, PRESENCE_SCRIPT, initialProjects, personForEmail, starterFiles } from './fixtures.js';
import { safeFileName, uniqueFileName } from '../state/useDiskWorkspace.js';

// Who can do what in a shared project. The UI reads this table, so the
// buttons people see always match their role.
export const PERMISSIONS = [
  { id: 'edit', label: 'Open and edit files and notebooks', owner: true, member: true },
  { id: 'run', label: 'Run Python on their own device', owner: true, member: true },
  { id: 'addFiles', label: 'Create and upload files', owner: true, member: true },
  { id: 'renameFiles', label: 'Rename files', owner: true, member: true },
  { id: 'removeFiles', label: 'Remove files', owner: true, member: false },
  { id: 'invite', label: 'Invite people and change roles', owner: true, member: false },
  { id: 'settings', label: 'Rename or archive the project', owner: true, member: false },
];
const MAX_UPLOAD = 1024 * 1024; // the preview keeps uploads in memory

// Cowork preview state: shared projects, membership, invitations, the
// connection, and where teammates are. All of it is sample data kept in
// memory; reloading the page starts the preview again.
//
// Routes live in the URL hash, so Back works and a view can be linked:
//   (none)           this device's project (Tandem as before)
//   #/shared         Shared projects
//   #/shared/<id>    a shared project's workspace

const SAVE_DELAY = 650;
const RECONNECT_AFTER = 6000;
const PRESENCE_EVERY = 3200;

// A review build can open on Shared projects (VITE_COWORK_START=shared); this
// device's project then has its own route, #/device.
const START_SHARED = import.meta.env.VITE_COWORK_START === 'shared';
const LOCAL_HASH = START_SHARED ? '#/device' : '';

function parseHash() {
  const hash = window.location.hash || '';
  if (hash === '#/device') return { screen: 'local' };
  const m = /^#\/shared(?:\/([\w-]+))?\/?$/.exec(hash);
  if (!m) return { screen: START_SHARED ? 'home' : 'local' };
  return m[1] ? { screen: 'project', id: m[1] } : { screen: 'home' };
}

// The Cowork route (in the URL hash), shared by the preview and live mode.
export function useCoworkRoute() {
  const [route, setRoute] = useState(parseHash);
  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const go = useCallback((screen, id) => {
    const hash = screen === 'local' ? LOCAL_HASH : screen === 'home' ? '#/shared' : `#/shared/${id}`;
    if ((window.location.hash || '') === hash) return;
    if (hash) window.location.hash = hash;
    else window.history.pushState(null, '', window.location.pathname + window.location.search);
    setRoute(parseHash());
  }, []);
  return { route, go };
}

const slug = (name) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'project';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function useCowork({ notify }) {
  const [projects, setProjects] = useState(initialProjects);
  const [people, setPeople] = useState(PEOPLE);
  const [viewerId, setViewerId] = useState('wei');
  // Shared projects need a Cowork account (separate from anything else).
  // The preview starts signed out; any email signs in with the sample code.
  const [signedIn, setSignedIn] = useState(false);
  // Who just joined which project (their avatar arrives in the people list).
  const [arrival, setArrival] = useState(null);
  const { route, go } = useCoworkRoute();
  const [sync, setSync] = useState('saved'); // saved | saving | reconnecting
  const [tick, setTick] = useState(0);
  const pendingEdits = useRef(0);
  const saveTimer = useRef(null);
  const reconnectTimer = useRef(null);
  const syncRef = useRef(sync);
  syncRef.current = sync;
  const projectsRef = useRef(projects);
  projectsRef.current = projects;

  const viewer = people[viewerId];
  const roleIn = useCallback((project, id = viewerId) => project.members.find((m) => m.id === id)?.role || null, [viewerId]);
  const mine = useMemo(() => projects.filter((p) => roleIn(p) && !p.archived), [projects, roleIn]);
  const archived = useMemo(() => projects.filter((p) => roleIn(p) && p.archived), [projects, roleIn]);
  const can = useCallback((project, action) => {
    const role = project && roleIn(project);
    const rule = PERMISSIONS.find((r) => r.id === action);
    return !!(role && rule?.[role]);
  }, [roleIn]);
  const invitations = useMemo(
    () =>
      projects
        .filter((p) => !roleIn(p))
        .flatMap((p) => p.invites.filter((i) => i.email === viewer.email).map((invite) => ({ project: p, invite, from: people[invite.by] }))),
    [projects, roleIn, viewer, people]
  );
  const project = route.screen === 'project' ? mine.find((p) => p.id === route.id) || null : null;
  const screen =
    route.screen === 'local' ? 'local' : !signedIn ? 'signin' : route.screen === 'project' && !project ? 'home' : route.screen;

  const updateProject = useCallback((id, fn) => setProjects((list) => list.map((p) => (p.id === id ? fn(p) : p))), []);

  // ------------------------------------------------------------ sync status
  const markEdited = useCallback(() => {
    if (syncRef.current === 'reconnecting') {
      pendingEdits.current += 1;
      return;
    }
    setSync('saving');
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => setSync('saved'), SAVE_DELAY);
  }, []);

  const reconnect = useCallback(() => {
    clearTimeout(reconnectTimer.current);
    const n = pendingEdits.current;
    pendingEdits.current = 0;
    setSync('saving');
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      setSync('saved');
      notify(n ? `Reconnected. ${n} edit${n === 1 ? '' : 's'} made offline ${n === 1 ? 'is' : 'are'} saved.` : 'Reconnected.');
    }, SAVE_DELAY);
  }, [notify]);

  // Preview: the connection drops and comes back by itself.
  const dropConnection = useCallback(() => {
    clearTimeout(saveTimer.current);
    setSync('reconnecting');
    clearTimeout(reconnectTimer.current);
    reconnectTimer.current = setTimeout(reconnect, RECONNECT_AFTER);
  }, [reconnect]);

  useEffect(() => () => {
    clearTimeout(saveTimer.current);
    clearTimeout(reconnectTimer.current);
  }, []);

  // ------------------------------------------------------------ teammates
  useEffect(() => {
    if (screen !== 'project' || sync === 'reconnecting') return undefined;
    const timer = setInterval(() => setTick((t) => t + 1), PRESENCE_EVERY);
    return () => clearInterval(timer);
  }, [screen, sync]);

  const presence = useMemo(() => {
    if (!project) return [];
    return (PRESENCE_SCRIPT[project.id] || [])
      .filter((s) => s.person !== viewerId && project.members.some((m) => m.id === s.person) && s.path in project.files)
      .map((s) => ({ ...s, ...people[s.person], step: s.steps[tick % s.steps.length] }));
  }, [project, viewerId, people, tick]);

  // ------------------------------------------------------------ the workspace
  const pid = project?.id;
  const ws = useMemo(() => {
    if (!project) return null;
    const files = project.files;
    const open = project.open.filter((p) => p in files);
    return {
      files,
      fileOrder: Object.keys(files).sort(),
      openTabs: open,
      activePath: open.includes(project.active) ? project.active : open[0] || null,
      breakpoints: {},
      loading: false,
      project: { name: project.name, root: `cowork:${project.id}` },
    };
  }, [project]);

  const openFile = useCallback(
    (path) => updateProject(pid, (p) => ({ ...p, open: p.open.includes(path) ? p.open : [...p.open, path], active: path })),
    [pid, updateProject]
  );
  const closeTab = useCallback(
    (path) =>
      updateProject(pid, (p) => {
        const index = p.open.indexOf(path);
        const open = p.open.filter((x) => x !== path);
        const active = p.active === path || !p.active ? open[Math.min(index, open.length - 1)] || null : p.active;
        return { ...p, open, active };
      }),
    [pid, updateProject]
  );
  const setFile = useCallback(
    (path, text) => {
      const current = projectsRef.current.find((p) => p.id === pid);
      if (!current || current.files[path] === text) return;
      updateProject(pid, (p) => ({ ...p, files: { ...p.files, [path]: text }, edited: { by: viewerId, at: Date.now() } }));
      markEdited();
    },
    [pid, updateProject, viewerId, markEdited]
  );
  const createFile = useCallback(
    async (path, text = '') => {
      updateProject(pid, (p) => ({ ...p, files: { ...p.files, [path]: text }, open: [...p.open, path], active: path }));
      markEdited();
    },
    [pid, updateProject, markEdited]
  );

  // Upload: text files from this device, added at the top of the project.
  // A taken name gets " (2)"; nothing is overwritten.
  const uploadFiles = useCallback(
    async (list) => {
      const chosen = Array.from(list || []);
      const current = projectsRef.current.find((p) => p.id === pid);
      if (!current || !chosen.length) return;
      const taken = new Set(Object.keys(current.files));
      const added = {};
      const skipped = [];
      for (const file of chosen) {
        if (file.size > MAX_UPLOAD) {
          skipped.push(`${file.name} is larger than 1 MB`);
          continue;
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (bytes.subarray(0, 8192).includes(0)) {
          skipped.push(`${file.name} isn’t a text file`);
          continue;
        }
        const path = uniqueFileName(safeFileName(file.name), taken);
        taken.add(path);
        added[path] = new TextDecoder().decode(bytes);
      }
      const paths = Object.keys(added);
      if (paths.length) {
        updateProject(pid, (p) => ({ ...p, files: { ...p.files, ...added }, open: [...p.open, paths[0]], active: paths[0], edited: { by: viewerId, at: Date.now() } }));
        markEdited();
        notify(paths.length === 1 ? `Uploaded ${paths[0]} (preview: kept in this page only).` : `Uploaded ${paths.length} files: ${paths.join(', ')}.`);
      }
      if (skipped.length) notify(`Not uploaded: ${skipped.join('; ')}. The preview takes text files up to 1 MB.`);
    },
    [pid, updateProject, viewerId, markEdited, notify]
  );

  // Returns an error message, or null when renamed.
  const renameFile = useCallback(
    (from, to) => {
      const current = projectsRef.current.find((p) => p.id === pid);
      const path = to.trim().replace(/^\.\//, '');
      if (!path) return 'Enter a file name.';
      if (path.startsWith('/') || path.includes('\\') || path.split('/').some((part) => part === '..' || part === '')) {
        return 'Use a name inside the project, like notes.md or data/raw.csv.';
      }
      if (path === from) return null;
      if (path in current.files) return `${path} already exists.`;
      updateProject(pid, (p) => {
        const files = {};
        for (const [k, v] of Object.entries(p.files)) files[k === from ? path : k] = v;
        return { ...p, files, open: p.open.map((x) => (x === from ? path : x)), active: p.active === from ? path : p.active, edited: { by: viewerId, at: Date.now() } };
      });
      markEdited();
      return null;
    },
    [pid, updateProject, viewerId, markEdited]
  );

  const removeFile = useCallback(
    (path) => {
      const before = projectsRef.current.find((p) => p.id === pid);
      if (!before || !(path in before.files) || !can(before, 'removeFiles')) return;
      updateProject(pid, (p) => {
        const files = { ...p.files };
        delete files[path];
        const open = p.open.filter((x) => x !== path);
        return { ...p, files, open, active: p.active === path ? open[0] || null : p.active };
      });
      markEdited();
      notify(`Removed ${path} for everyone in ${before.name}.`, {
        label: 'Undo',
        onClick: () => updateProject(pid, (p) => ({ ...p, files: { ...p.files, [path]: before.files[path] } })),
      });
    },
    [pid, updateProject, markEdited, notify, can]
  );

  // Returns an error message, or null when renamed.
  const renameProject = useCallback(
    (id, name) => {
      const n = name.trim();
      if (!can(projectsRef.current.find((p) => p.id === id), 'settings')) return 'Only owners can rename the project.';
      if (!n) return 'Enter a name for the project.';
      if (projectsRef.current.some((p) => p.id !== id && roleIn(p) && p.name.toLowerCase() === n.toLowerCase())) return `You already have a project called ${n}.`;
      updateProject(id, (p) => ({ ...p, name: n }));
      return null;
    },
    [updateProject, roleIn, can]
  );

  const restoreProject = useCallback(
    (id) => {
      updateProject(id, (p) => ({ ...p, archived: null }));
      const p = projectsRef.current.find((x) => x.id === id);
      if (p) notify(`Restored ${p.name}.`);
    },
    [updateProject, notify]
  );

  const archiveProject = useCallback(
    (id) => {
      const p = projectsRef.current.find((x) => x.id === id);
      if (!can(p, 'settings')) return;
      updateProject(id, (x) => ({ ...x, archived: { by: viewerId, at: Date.now() } }));
      go('home');
      if (p) notify(`Archived ${p.name}.`, { label: 'Undo', onClick: () => restoreProject(id) });
    },
    [updateProject, viewerId, go, notify, restoreProject, can]
  );

  const workspace = useMemo(
    () =>
      ws && {
        ...ws,
        openFile,
        closeTab,
        setFile,
        createFile,
        toggleBreakpoint: () => {},
        flush: async () => {},
        resetFile: () => {},
        reset: () => {},
        reload: () => {},
        noteFile: () => {},
        addFiles: null,
        uploadFiles,
        renameFile,
        removeFile,
      },
    [ws, openFile, closeTab, setFile, createFile, uploadFiles, renameFile, removeFile]
  );

  // ------------------------------------------------------------ projects and people
  const createProject = useCallback(
    (name) => {
      const base = slug(name);
      let id = base;
      for (let n = 2; projects.some((p) => p.id === id); n++) id = `${base}-${n}`;
      const files = starterFiles(name);
      setProjects((list) => [
        { id, name, members: [{ id: viewerId, role: 'owner' }], invites: [], files, open: ['main.py'], edited: { by: viewerId, at: Date.now() } },
        ...list,
      ]);
      go('project', id);
      return id;
    },
    [projects, viewerId, go]
  );

  // Joining in two steps, as live mode does: join() accepts (here there is
  // nothing to wait for), enter() then adds you and opens the project.
  const join = useCallback(async () => true, []);
  const enter = useCallback(
    (id) => {
      const p = projects.find((x) => x.id === id);
      const invite = p?.invites.find((i) => i.email === viewer.email);
      if (!invite) return;
      updateProject(id, (x) => ({
        ...x,
        members: [...x.members, { id: viewerId, role: invite.role }],
        invites: x.invites.filter((i) => i !== invite),
      }));
      notify(`Welcome to ${p.name}. Your edits are shared with ${p.members.length} ${p.members.length === 1 ? 'person' : 'people'}.`);
      setArrival({ project: id, person: viewerId, at: Date.now() });
      setTimeout(() => setArrival((a) => (a?.project === id ? null : a)), 4000);
      go('project', id);
    },
    [projects, viewer, viewerId, updateProject, notify, go]
  );

  const decline = useCallback(
    (id) => {
      const p = projects.find((x) => x.id === id);
      updateProject(id, (x) => ({ ...x, invites: x.invites.filter((i) => i.email !== viewer.email) }));
      if (p) notify(`Declined the invitation to ${p.name}.`);
    },
    [projects, viewer, updateProject, notify]
  );

  // Returns an error message, or null when the invitation was added.
  const invite = useCallback(
    (id, email, role) => {
      const address = email.trim().toLowerCase();
      if (!EMAIL.test(address)) return 'Enter an email address, like name@example.edu.';
      const p = projects.find((x) => x.id === id);
      const person = personForEmail(address);
      if (p.members.some((m) => people[m.id]?.email === address)) return `${person.name} is already in ${p.name}.`;
      if (p.invites.some((i) => i.email === address)) return `${address} is already invited.`;
      setPeople((all) => (all[person.id] ? all : { ...all, [person.id]: person }));
      updateProject(id, (x) => ({ ...x, invites: [...x.invites, { email: address, role, by: viewerId, at: Date.now() }] }));
      return null;
    },
    [projects, people, viewerId, updateProject]
  );

  const cancelInvite = useCallback(
    (id, email) => updateProject(id, (x) => ({ ...x, invites: x.invites.filter((i) => i.email !== email) })),
    [updateProject]
  );

  const setRole = useCallback(
    (id, personId, role) =>
      updateProject(id, (x) => {
        const owners = x.members.filter((m) => m.role === 'owner');
        if (role !== 'owner' && owners.length === 1 && owners[0].id === personId) return x; // keep one owner
        return { ...x, members: x.members.map((m) => (m.id === personId ? { ...m, role } : m)) };
      }),
    [updateProject]
  );

  const removeMember = useCallback(
    (id, personId) => updateProject(id, (x) => ({ ...x, members: x.members.filter((m) => m.id !== personId) })),
    [updateProject]
  );

  // Signing in as an email: one of the sample people, or a new person (who
  // sees any invitations sent to that address).
  const signIn = useCallback(
    (idOrEmail) => {
      const key = String(idOrEmail).trim().toLowerCase();
      const person = people[key] || personForEmail(key);
      setPeople((all) => (all[person.id] ? all : { ...all, [person.id]: person }));
      setViewerId(person.id);
      setSignedIn(true);
      return person;
    },
    [people]
  );

  const signOut = useCallback(() => {
    setSignedIn(false);
    go('home');
    notify('Signed out of Tandem Cowork.');
  }, [go, notify]);

  // Preview: see the app as someone else (an invited person, a member).
  const viewAs = useCallback(
    (idOrEmail) => {
      signIn(idOrEmail);
      go('home');
    },
    [signIn, go]
  );

  const resetPreview = useCallback(() => {
    setProjects(initialProjects());
    setPeople(PEOPLE);
    setViewerId('wei');
    setSignedIn(false);
    setSync('saved');
    pendingEdits.current = 0;
    clearTimeout(reconnectTimer.current);
    go('home');
  }, [go]);

  return {
    screen,
    project,
    projects: mine,
    archived,
    can,
    renameProject,
    archiveProject,
    restoreProject,
    invitations,
    people,
    viewer,
    roleIn,
    sync,
    presence,
    workspace,
    go,
    createProject,
    join,
    enter,
    decline,
    invite,
    cancelInvite,
    setRole,
    removeMember,
    viewAs,
    arrival,
    signedIn,
    signIn,
    signOut,
    dropConnection,
    reconnect,
    resetPreview,
  };
}
