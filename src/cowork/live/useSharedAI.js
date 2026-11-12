import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from './api.js';

// The AI an owner shares with the open shared project (live mode): what is
// shared (never the key), sharing and stopping, and what the assistant needs
// to use it. `projectId` is null outside a live shared project.
export function useSharedAI({ projectId }) {
  const [share, setShare] = useState(null); // { provider, model, shared_by, shared_by_me, daily_limit, used_today, key_hint?, base_url? }
  const [loaded, setLoaded] = useState(false);
  const current = useRef(projectId);
  current.current = projectId;
  const shareRef = useRef(share);
  shareRef.current = share;

  const load = useCallback(async () => {
    const id = current.current;
    if (!id) return;
    try {
      const s = await api.aiShare(id);
      if (current.current === id) {
        setShare(s || null);
        setLoaded(true);
      }
    } catch {
      // kept as it was; checked again on focus
    }
  }, []);

  useEffect(() => {
    setShare(null);
    setLoaded(false);
    if (!projectId) return undefined;
    load();
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    const t = setInterval(() => document.visibilityState === 'visible' && load(), 60000);
    return () => {
      window.removeEventListener('focus', onFocus);
      clearInterval(t);
    };
  }, [projectId, load]);

  const save = useCallback(async (options) => {
    const s = await api.setAiShare(current.current, options);
    setShare(s || null);
    return s;
  }, []);
  const stop = useCallback(async () => {
    await api.stopAiShare(current.current);
    setShare(null);
  }, []);

  // For the assistant: the shared AI's address and your sign-in, or null.
  const access = useCallback(async () => {
    if (!current.current || !shareRef.current) return null;
    return { ...(await api.sharedAIEndpoint()), project_id: current.current };
  }, []);
  // An answer says how many requests are used today.
  const noteUse = useCallback((used) => {
    if (used && typeof used.used_today === 'number') setShare((s) => (s ? { ...s, used_today: used.used_today, daily_limit: used.daily_limit ?? s.daily_limit } : s));
  }, []);

  return { available: !!projectId, loaded, share, save, stop, access, noteUse, reload: load };
}
