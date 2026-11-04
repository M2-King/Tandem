import { useCallback } from 'react';
import { usePersistedState } from './usePersistedState.js';
import { STORAGE_KEYS } from '../lib/storage.js';
import { DEFAULT_GLASS, normalizeGlass } from '../lib/glass.js';

export const LIMITS = {
  sidebar: { min: 160, max: 280, initial: 196 },
  assistant: { min: 320, max: 480, initial: 380 },
  results: { min: 120, initial: 330 },
  fontSize: { min: 11, max: 20, initial: 14 },
};

const createPrefs = () => ({
  sidebarWidth: LIMITS.sidebar.initial,
  assistantWidth: LIMITS.assistant.initial,
  resultsHeight: LIMITS.results.initial,
  sidebarOpen: true,
  assistantOpen: true,
  fontSize: LIMITS.fontSize.initial,
  diffInline: true,
  glass: DEFAULT_GLASS,
});

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

// Layout and editor preferences, remembered in this browser.
export function usePrefs() {
  const [prefs, setPrefs] = usePersistedState(STORAGE_KEYS.prefs, createPrefs, {
    restore: (saved) => ({ ...createPrefs(), ...saved, glass: normalizeGlass(saved?.glass) }),
  });

  const update = useCallback((patch) => setPrefs((p) => ({ ...p, ...patch })), [setPrefs]);

  const setSidebarWidth = useCallback(
    (w) => update({ sidebarWidth: clamp(Math.round(w), LIMITS.sidebar.min, LIMITS.sidebar.max) }),
    [update]
  );
  const setAssistantWidth = useCallback(
    (w) => update({ assistantWidth: clamp(Math.round(w), LIMITS.assistant.min, LIMITS.assistant.max) }),
    [update]
  );
  const setResultsHeight = useCallback(
    (h, max) => update({ resultsHeight: clamp(Math.round(h), LIMITS.results.min, Math.max(LIMITS.results.min, max)) }),
    [update]
  );
  const changeFontSize = useCallback(
    (delta) =>
      setPrefs((p) => ({ ...p, fontSize: clamp(p.fontSize + delta, LIMITS.fontSize.min, LIMITS.fontSize.max) })),
    [setPrefs]
  );
  const reset = useCallback(() => setPrefs(createPrefs()), [setPrefs]);

  return { prefs, update, setSidebarWidth, setAssistantWidth, setResultsHeight, changeFontSize, reset };
}
