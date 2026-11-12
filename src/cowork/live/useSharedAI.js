import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from './api.js';

// The AI an owner shares with the open shared project (live mode): what is
// shared (never the key), sharing and stopping, and what the assistant needs
// to use it. `projectId` is null outside a live shared project.
//
// Which AI this device uses in the project: `choice` 'shared' or 'own',
// kept on this device per project (asked from AI settings, AIChoiceDialog);
// null until chosen: then the shared AI is used only without an AI of your own.
const CHOICE_KEY = (id) => `tandem.cowork.ai-choice.${id}`;
const readChoice = (id) => {
  try {
    const v = id && localStorage.getItem(CHOICE_KEY(id));
    return v === 'shared' || v === 'own' ? v : null;
  } catch {
    return null;
  }
};

export function useSharedAI({ projectId }) {
  const [choice, setChoiceState] = useState(() => readChoice(projectId));
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
    setChoiceState(readChoice(projectId));
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

  const choose = useCallback((value) => {
    const id = current.current;
    if (!id) return;
    try {
      localStorage.setItem(CHOICE_KEY(id), value);
    } catch {
      // kept for this session only
    }
    setChoiceState(value);
  }, []);
  // Whether the assistant uses the shared AI, given whether this device has its own.
  const usesShared = (hasOwnAI) => !!share && (choice === 'shared' || !hasOwnAI);

  return { available: !!projectId, loaded, share, save, stop, access, noteUse, reload: load, choice, choose, usesShared };
}
