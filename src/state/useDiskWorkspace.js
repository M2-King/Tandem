import { useCallback, useEffect, useRef, useState } from 'react';
import { loadJSON, saveJSON } from '../lib/storage.js';

const SAVE_DELAY = 400;

// The project on disk, through the local runtime. Same shape as
// useWorkspace (files, openTabs, activePath, breakpoints, …) so the editor,
// tabs and file list work unchanged.
//
// Edits are written to disk shortly after typing. A write carries the hash
// of the version it replaces; if the file changed on disk in between, the
// write is refused and the person is told, instead of silently overwriting.
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
  const uiKey = project ? `tandem.local.ui.v1:${project.root}` : null;

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
      const openTabs = (saved?.openTabs || []).filter((p) => p in loaded);
      const firstPy = list.find((f) => f.path.endsWith('.py'))?.path || null;
      setUi({
        openTabs: openTabs.length ? openTabs : firstPy ? [firstPy] : [],
        activePath: openTabs.includes(saved?.activePath) ? saved.activePath : openTabs[0] || firstPy,
        breakpoints: saved?.breakpoints || {},
      });
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

  const openFile = useCallback(
    (path) =>
      setUi((u) => ({
        ...u,
        openTabs: u.openTabs.includes(path) ? u.openTabs : [...u.openTabs, path],
        activePath: path,
      })),
    []
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
    closeTab,
    setFile,
    toggleBreakpoint,
    createFile,
    flush,
    resetFile: () => {},
    reset: () => {},
  };
}
