import { useEffect, useRef, useState } from 'react';
import { loadJSON, saveJSON } from '../lib/storage.js';

// useState that is saved to localStorage (debounced).
//   restore(saved) can clean up a loaded value (return null to ignore it).
//   onSave(status) is told 'saving' | 'saved' | 'failed'.
export function usePersistedState(key, createInitial, { restore, onSave } = {}) {
  const [value, setValue] = useState(() => {
    const saved = loadJSON(key, null);
    const restored = saved && restore ? restore(saved) : saved;
    return restored ?? createInitial();
  });

  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const firstRender = useRef(true);
  const valueRef = useRef(value);
  valueRef.current = value;

  // Save right away when the page is closed or reloaded, so a pending
  // debounced save isn't lost.
  useEffect(() => {
    const flush = () => saveJSON(key, valueRef.current);
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, [key]);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return undefined;
    }
    onSaveRef.current?.('saving');
    const timer = setTimeout(() => {
      onSaveRef.current?.(saveJSON(key, value) ? 'saved' : 'failed');
    }, 350);
    return () => clearTimeout(timer);
  }, [key, value]);

  return [value, setValue];
}
