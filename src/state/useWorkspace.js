import { useCallback } from 'react';
import { usePersistedState } from './usePersistedState.js';
import { STORAGE_KEYS } from '../lib/storage.js';
import { SAMPLE_FILES, DEFAULT_BREAKPOINTS, FILE_ORDER } from '../data/sampleProject.js';

const createWorkspace = () => ({
  files: { ...SAMPLE_FILES },
  openTabs: ['main.py'],
  activePath: 'main.py',
  breakpoints: structuredClone(DEFAULT_BREAKPOINTS),
});

function restore(saved) {
  if (!saved?.files || typeof saved.files !== 'object') return null;
  const files = { ...SAMPLE_FILES, ...saved.files };
  const openTabs = (saved.openTabs || []).filter((p) => p in files);
  return {
    files,
    openTabs,
    activePath: openTabs.includes(saved.activePath) ? saved.activePath : openTabs[0] || null,
    breakpoints: saved.breakpoints || {},
  };
}

// Project files, open tabs, and breakpoints. Saved locally on every change.
export function useWorkspace(onSave) {
  const [ws, setWs] = usePersistedState(STORAGE_KEYS.workspace, createWorkspace, { restore, onSave });

  const openFile = useCallback(
    (path) =>
      setWs((w) => ({
        ...w,
        openTabs: w.openTabs.includes(path) ? w.openTabs : [...w.openTabs, path],
        activePath: path,
      })),
    [setWs]
  );

  const closeTab = useCallback(
    (path) =>
      setWs((w) => {
        const index = w.openTabs.indexOf(path);
        const openTabs = w.openTabs.filter((p) => p !== path);
        const activePath =
          w.activePath === path ? openTabs[Math.min(index, openTabs.length - 1)] || null : w.activePath;
        return { ...w, openTabs, activePath };
      }),
    [setWs]
  );

  const setFile = useCallback(
    (path, content) => setWs((w) => (w.files[path] === content ? w : { ...w, files: { ...w.files, [path]: content } })),
    [setWs]
  );

  const toggleBreakpoint = useCallback(
    (path, line) =>
      setWs((w) => {
        const current = w.breakpoints[path] || [];
        const next = current.includes(line) ? current.filter((l) => l !== line) : [...current, line].sort((a, b) => a - b);
        return { ...w, breakpoints: { ...w.breakpoints, [path]: next } };
      }),
    [setWs]
  );

  const resetFile = useCallback((path) => setFile(path, SAMPLE_FILES[path]), [setFile]);
  const reset = useCallback(() => setWs(createWorkspace()), [setWs]);

  return {
    ...ws,
    fileOrder: FILE_ORDER,
    openFile,
    closeTab,
    setFile,
    toggleBreakpoint,
    resetFile,
    reset,
  };
}
