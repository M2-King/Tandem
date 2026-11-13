import { useCallback, useEffect, useRef, useState } from 'react';
import { loadJSON, saveJSON } from '../lib/storage.js';

const SAVE_DELAY = 400;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

// A name that is safe as a project file: no folders, no leading dot (hidden
// files aren't listed), no characters file systems refuse.
export function safeFileName(name) {
  const base = String(name || '').split(/[\\/]/).pop();
  const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, '_').replace(/^[.\s]+/, '').trim();
  return cleaned.slice(0, 120) || 'file';
}

// data.csv → data (2).csv, data (3).csv, … when the name is taken.
export function uniqueFileName(name, taken) {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// The project on disk, through the local runtime. Same shape as
// useWorkspace (files, openTabs, activePath, breakpoints, …) so the editor,
// tabs and file list work unchanged.
//
// Edits are written to disk shortly after typing. A write carries the hash
// of the version it replaces; if the file changed on disk in between, the
// write is refused and the person is told, instead of silently overwriting.
const WHY_UNREADABLE = {
  'too-large': 'it is too large to edit here',
  binary: 'it isn’t a text file',
  'not-utf8': 'it isn’t UTF-8 text',
};

// A file the desktop app was asked to open ("Open with Tandem"), once.
export function requestedFile() {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('open');
}

export function useDiskWorkspace(onSave, backend, { notify } = {}) {
  const [files, setFiles] = useState({});
  const [fileOrder, setFileOrder] = useState([]);
  const [unreadable, setUnreadable] = useState({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [project, setProject] = useState(null);
  const [ui, setUi] = useState({ openTabs: [], activePath: null, breakpoints: {} });
  const hashes = useRef({});
  const pending = useRef(new Map()); // path -> timer
  const latest = useRef({});
  latest.current = files;
  const orderRef = useRef([]);
  orderRef.current = fileOrder;
  const uiKey = project ? `tandem.local.ui.v1:${project.root}` : null;
  const requested = useRef(requestedFile());

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const status = await backend.status();
      const list = await backend.listFiles();
      const loaded = {};
      const skipped = {};
      await Promise.all(
        list.map(async ({ path }) => {
          const file = await backend.readFile(path);
          if (file.text == null) skipped[path] = file.reason;
          else {
            loaded[path] = file.text;
            hashes.current[path] = file.hash;
          }
        })
      );
      setProject(status.project);
      setFiles(loaded);
      setUnreadable(skipped);
      setFileOrder(list.map((f) => f.path));
      const saved = loadJSON(`tandem.local.ui.v1:${status.project.root}`, null);
      let openTabs = (saved?.openTabs || []).filter((p) => p in loaded);
      const firstPy = list.find((f) => f.path.endsWith('.py'))?.path || null;
      let activePath = openTabs.includes(saved?.activePath) ? saved.activePath : openTabs[0] || firstPy;
      if (!openTabs.length && firstPy) openTabs = [firstPy];
      // Opened from Explorer: that file is the one shown.
      const want = requested.current;
      requested.current = null;
      if (want) {
        window.history.replaceState(null, '', window.location.pathname + window.location.hash); // keeps #/device
        if (want in loaded) {
          if (!openTabs.includes(want)) openTabs = [...openTabs, want];
          activePath = want;
        } else {
          notify?.(`Tandem can't open ${want}: ${WHY_UNREADABLE[skipped[want]] || 'it isn’t in the project’s file list'}.`);
        }
      }
      setUi({ openTabs, activePath, breakpoints: saved?.breakpoints || {} });
    } catch (e) {
      setLoadError(e.message);
    } finally {
      setLoading(false);
    }
  }, [backend]);

  useEffect(() => {
    load();
  }, [load]);

  // Tabs, the active file and breakpoints are remembered per project.
  useEffect(() => {
    if (uiKey) saveJSON(uiKey, ui);
  }, [uiKey, ui]);

  const writeNow = useCallback(
    async (path) => {
      pending.current.delete(path);
      const text = latest.current[path];
      if (text == null) return;
      try {
        const result = await backend.writeFile(path, text, hashes.current[path]);
        hashes.current[path] = result.hash;
        if (!pending.current.size) onSave?.('saved');
      } catch (e) {
        onSave?.('failed');
        notify?.(`Couldn't save ${path}: ${e.message}`);
      }
    },
    [backend, onSave, notify]
  );

  const setFile = useCallback(
    (path, content) => {
      setFiles((f) => (f[path] === content ? f : { ...f, [path]: content }));
      latest.current = { ...latest.current, [path]: content };
      clearTimeout(pending.current.get(path));
      onSave?.('saving');
      pending.current.set(path, setTimeout(() => writeNow(path), SAVE_DELAY));
    },
    [writeNow, onSave]
  );

  // Write every pending edit now (before a run, so it runs what you see).
  const flush = useCallback(async () => {
    const paths = [...pending.current.keys()];
    paths.forEach((p) => clearTimeout(pending.current.get(p)));
    await Promise.all(paths.map((p) => writeNow(p)));
  }, [writeNow]);

  const createFile = useCallback(
    async (path, text = '') => {
      const result = await backend.createFile(path, text);
      hashes.current[path] = result.hash;
      setFiles((f) => ({ ...f, [path]: text }));
      setFileOrder((order) => [...order, path].sort());
      setUi((u) => ({ ...u, openTabs: u.openTabs.includes(path) ? u.openTabs : [...u.openTabs, path], activePath: path }));
    },
    [backend]
  );

  // Files brought in from elsewhere (Add files…, drag and drop): any kind,
  // copied into the project folder. A taken name gets " (2)"; nothing is
  // overwritten. The first readable one opens.
  const addFiles = useCallback(
    async (list) => {
      const taken = new Set(orderRef.current);
      const added = [];
      const failed = [];
      for (const file of list) {
        if (file.size > MAX_UPLOAD_BYTES) {
          failed.push(`${file.name} is larger than 25 MB`);
          continue;
        }
        const path = uniqueFileName(safeFileName(file.name), taken);
        try {
          await backend.uploadFile(path, await file.arrayBuffer());
          taken.add(path);
          added.push(path);
        } catch (e) {
          failed.push(`${file.name}: ${e.message}`);
        }
      }
      const loaded = {};
      const skipped = {};
      await Promise.all(
        added.map(async (path) => {
          const file = await backend.readFile(path).catch(() => ({ text: null, reason: 'unreadable' }));
          if (file.text == null) skipped[path] = file.reason;
          else {
            loaded[path] = file.text;
            hashes.current[path] = file.hash;
          }
        })
      );
      setFiles((f) => ({ ...f, ...loaded }));
      setUnreadable((u) => ({ ...u, ...skipped }));
      setFileOrder((order) => [...new Set([...order, ...added])].sort());
      const first = added.find((p) => p in loaded);
      if (first) {
        setUi((u) => ({ ...u, openTabs: u.openTabs.includes(first) ? u.openTabs : [...u.openTabs, first], activePath: first }));
      }
      return { added, failed };
    },
    [backend]
  );

  // A file created outside the editor (a database the SQL workspace saved): list it.
  const noteFile = useCallback((path) => setFileOrder((order) => (order.includes(path) ? order : [...order, path].sort())), []);

  const openFile = useCallback(
    (path) =>
      setUi((u) => ({
        ...u,
        openTabs: u.openTabs.includes(path) ? u.openTabs : [...u.openTabs, path],
        activePath: path,
      })),
    []
  );

  // Open a file the desktop app was handed while this project is open; it
  // may be newer than the file list.
  const openFromOutside = useCallback(
    async (path) => {
      if (!(path in latest.current)) {
        const file = await backend.readFile(path).catch((e) => ({ text: null, error: e.message }));
        if (file.text == null) {
          notify?.(`Tandem can't open ${path}: ${WHY_UNREADABLE[file.reason] || file.error?.replace(/\.$/, '') || 'it couldn’t be read'}.`);
          return false;
        }
        hashes.current[path] = file.hash;
        latest.current = { ...latest.current, [path]: file.text };
        setFiles((f) => ({ ...f, [path]: file.text }));
        setFileOrder((order) => (order.includes(path) ? order : [...order, path].sort()));
      }
      openFile(path);
      return true;
    },
    [backend, notify, openFile]
  );

  const closeTab = useCallback(
    (path) =>
      setUi((u) => {
        const index = u.openTabs.indexOf(path);
        const openTabs = u.openTabs.filter((p) => p !== path);
        const activePath = u.activePath === path ? openTabs[Math.min(index, openTabs.length - 1)] || null : u.activePath;
        return { ...u, openTabs, activePath };
      }),
    []
  );

  const toggleBreakpoint = useCallback(
    (path, line) =>
      setUi((u) => {
        const current = u.breakpoints[path] || [];
        const next = current.includes(line) ? current.filter((l) => l !== line) : [...current, line].sort((a, b) => a - b);
        return { ...u, breakpoints: { ...u.breakpoints, [path]: next } };
      }),
    []
  );

  // Flush on close so a pending edit isn't lost.
  useEffect(() => {
    const onHide = () => {
      flush();
    };
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, [flush]);

  return {
    files,
    openTabs: ui.openTabs,
    activePath: ui.activePath,
    breakpoints: ui.breakpoints,
    fileOrder,
    unreadable,
    loading,
    loadError,
    project,
    reload: load,
    openFile,
    openFromOutside,
    closeTab,
    setFile,
    toggleBreakpoint,
    createFile,
    addFiles,
    noteFile,
    flush,
    resetFile: () => {},
    reset: () => {},
  };
}
