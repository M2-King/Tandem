import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from './api.js';
import { personForUsername } from '../accounts.js';

// Cowork live mode: who is in the open project right now, which file each
// person has open, and their cursors (Supabase Realtime, one private channel
// per project; see api.projectChannel and 002_cowork_realtime.sql).
//
// Presence carries { user_id, username, path, cell, cursor, color } and is
// updated when the file or notebook cell changes (and at most every 2 s for
// the cursor, so someone joining sees where everyone is). Cursor moves go as
// broadcasts, at most 10 a second. The channel is left while the app is
// hidden and when the project closes, so a person who leaves disappears.
//
// Text itself still travels through saves (the 10-second sync); nothing
// typed is sent here.

const CURSOR_EVERY = 100; // ms: at most 10 cursor broadcasts a second
const TRACK_EVERY = 2000; // ms: presence refreshed with the cursor at most this often
const RETRY_AFTER = 30 * 1000; // ms: after a refused or failed join
const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

// Newest of each person's presence entries, without me.
export function peersFromState(state, myId, previous = {}) {
  const next = {};
  for (const [key, metas] of Object.entries(state || {})) {
    if (key === myId || !metas?.length) continue;
    const meta = metas[metas.length - 1];
    const before = previous[key];
    // A cursor broadcast newer than the presence entry wins.
    next[key] = before && before.at > (meta.at || 0) ? { ...meta, ...pickCursor(before), at: before.at } : { ...meta };
  }
  return next;
}
const pickCursor = (p) => ({ path: p.path, cell: p.cell ?? null, cursor: p.cursor ?? null });

export function usePresence({ me, projectId, enabled, activePath }) {
  const [peers, setPeers] = useState({}); // user id -> { user_id, username, path, cell, cursor, at }
  const [state, setState] = useState('off'); // off | joining | online | unavailable
  const channel = useRef(null);
  const mine = useRef({ path: null, cell: null, cursor: null });
  const cursorTimer = useRef(null);
  const lastCursor = useRef(0);
  const trackTimer = useRef(null);
  const lastTrack = useRef(0);
  const meRef = useRef(me);
  meRef.current = me;

  const meta = () => {
    const m = meRef.current;
    return { user_id: m.id, username: m.username, color: personForUsername(m.username).hue, ...mine.current, at: Date.now() };
  };
  const trackNow = () => {
    clearTimeout(trackTimer.current);
    trackTimer.current = null;
    lastTrack.current = Date.now();
    channel.current?.track(meta()).catch(() => {});
  };
  const sendCursorNow = () => {
    clearTimeout(cursorTimer.current);
    cursorTimer.current = null;
    lastCursor.current = Date.now();
    channel.current?.cursor(meta()).catch(() => {});
  };

  useEffect(() => {
    if (!enabled || !me?.id || !projectId) return undefined;
    let ch = null;
    let retry = null;
    const close = () => {
      ch?.close();
      ch = null;
      channel.current = null;
      setPeers({});
    };
    const open = () => {
      if (ch || !visible()) return;
      setState('joining');
      ch = api.projectChannel(projectId, me.id, {
        onPresence: (presence) => setPeers((prev) => peersFromState(presence, me.id, prev)),
        onCursor: (p) =>
          p?.user_id &&
          p.user_id !== me.id &&
          setPeers((prev) => (prev[p.user_id] ? { ...prev, [p.user_id]: { ...prev[p.user_id], ...pickCursor(p), at: p.at || Date.now() } } : prev)),
        onStatus: (status) => {
          if (status === 'SUBSCRIBED') {
            setState('online');
            trackNow();
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            // Refused (not a member, or Realtime isn't set up) or unreachable:
            // stop here instead of retrying every few seconds; try again later.
            setState('unavailable');
            close();
            clearTimeout(retry);
            retry = setTimeout(open, RETRY_AFTER);
          }
        },
      });
      channel.current = ch;
    };
    const onVisibility = () => (visible() ? open() : (close(), setState('off')));
    document.addEventListener('visibilitychange', onVisibility);
    open();
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      clearTimeout(retry);
      clearTimeout(cursorTimer.current);
      clearTimeout(trackTimer.current);
      close();
      setState('off');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, me?.id, projectId]);

  // The open file changed: say so at once (its cursor comes with the next move).
  useEffect(() => {
    if (mine.current.path === activePath) return;
    mine.current = { path: activePath || null, cell: null, cursor: null };
    if (channel.current) trackNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath]);

  // From the editors (CursorReportContext): a caret or selection moved.
  const report = useCallback((path, cursor, cell = null) => {
    const changedPlace = mine.current.path !== path || mine.current.cell !== cell;
    mine.current = { path, cell, cursor };
    if (!channel.current) return;
    if (changedPlace) return trackNow();
    const wait = CURSOR_EVERY - (Date.now() - lastCursor.current);
    if (wait <= 0) sendCursorNow();
    else if (!cursorTimer.current) cursorTimer.current = setTimeout(sendCursorNow, wait);
    // Presence keeps up too, slowly, for people who join later.
    if (!trackTimer.current) trackTimer.current = setTimeout(trackNow, Math.max(0, TRACK_EVERY - (Date.now() - lastTrack.current)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { peers, state, report };
}
