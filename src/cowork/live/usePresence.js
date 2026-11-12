import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from './api.js';
import { personForUsername } from '../accounts.js';

// Cowork live mode: who is in the open project right now, which file each
// person has open, and their cursors (Supabase Realtime, one private channel
// per project; see api.projectChannel and 002_cowork_realtime.sql).
//
// Presence carries who you are and where you are: { user_id, username,
// color, path, cell }. Supabase limits presence updates per client (it
// closes the channel at about five in ten seconds), so presence is sent only
// when the file or notebook cell changes, at most once every 5 s. Cursor
// moves go as broadcasts instead (at most 8 a second), and are sent again
// whenever someone new joins, so they see where everyone is.
//
// The channel stays joined while the app is hidden for up to 2 minutes
// (switching apps, Stage Manager, a covered window); after that, or when the
// project closes, it is left and the person disappears for the others. Any
// close or error the app didn't ask for is retried: after 1, 2, 5 and then
// every 15 s, or every 30 s when the join is refused (not a member, Realtime
// not set up). The state (off, joining, online, reconnecting, unavailable)
// and its reason are shown next to the sync status.
//
// Text itself still travels through saves (the 10-second sync); nothing
// typed is sent here.

const CURSOR_EVERY = 125; // ms: at most 8 cursor broadcasts a second
const TRACK_EVERY = 5000; // ms: at most one presence update per 5 s
const HIDDEN_GRACE = 2 * 60 * 1000; // ms: stay joined this long while hidden
const RETRY_STEPS = [1000, 2000, 5000, 15000]; // ms: after an unexpected close or error
const REFUSED_RETRY = 30 * 1000; // ms: after a refused join
const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
const log = (...args) => console.info('[cowork live]', new Date().toISOString().slice(11, 23), ...args);
// More detail (every cursor sent and received) with localStorage 'tandem.coworkDebug' = '1'.
const debugOn = () => {
  try {
    return localStorage.getItem('tandem.coworkDebug') === '1';
  } catch {
    return false;
  }
};

const samePlace = (a, b) => !!a && !!b && (a.path ?? null) === (b.path ?? null) && (a.cell ?? null) === (b.cell ?? null);

// Newest of each person's presence entries, without me. Presence says where
// someone is; their cursor comes from broadcasts, kept while they stay in the
// same file and cell. (Older builds put the cursor in presence: used when
// there is nothing newer.)
export function peersFromState(state, myId, previous = {}) {
  const next = {};
  for (const [key, metas] of Object.entries(state || {})) {
    if (key === myId || !metas?.length) continue;
    const meta = metas[metas.length - 1];
    const before = previous[key];
    const keep = samePlace(before, meta) && (before.at || 0) > (meta.at || 0);
    next[key] = {
      ...meta,
      cursor: keep ? before.cursor ?? null : meta.cursor ?? (samePlace(before, meta) ? before.cursor ?? null : null),
      at: keep ? before.at : meta.at || 0,
    };
  }
  return next;
}
const pickCursor = (p) => ({ path: p.path ?? null, cell: p.cell ?? null, cursor: p.cursor ?? null });

// How long to wait before rejoining, after `failures` unexpected closes in a row.
export function retryDelay(failures, refused = false) {
  if (refused) return REFUSED_RETRY;
  return RETRY_STEPS[Math.min(Math.max(failures, 1), RETRY_STEPS.length) - 1];
}
const isRefusal = (error) => /unauthori[sz]ed|permission|forbidden/i.test(error?.message || String(error || ''));

export function usePresence({ me, projectId, enabled, activePath }) {
  const [peers, setPeers] = useState({}); // user id -> { user_id, username, path, cell, cursor, at }
  const [state, setState] = useState('off'); // off | joining | online | reconnecting | unavailable
  const [reason, setReason] = useState(null);
  const channel = useRef(null);
  const online = useRef(false);
  const mine = useRef({ path: null, cell: null, cursor: null });
  const cursorTimer = useRef(null);
  const lastCursor = useRef(0);
  const trackTimer = useRef(null);
  const lastTrack = useRef(0);
  const tracked = useRef(null); // the place last sent as presence
  const known = useRef(new Set()); // people seen in presence, to greet newcomers with my cursor
  const early = useRef({}); // cursors that arrived before that person's presence: user id -> payload
  const meRef = useRef(me);
  meRef.current = me;

  const presenceMeta = () => {
    const m = meRef.current;
    return { user_id: m.id, username: m.username, color: personForUsername(m.username).hue, path: mine.current.path, cell: mine.current.cell, at: Date.now() };
  };
  const cursorPayload = () => ({ user_id: meRef.current.id, ...mine.current, at: Date.now() });

  // Presence: only when the place changed since the last one sent, and not
  // more often than TRACK_EVERY.
  const track = () => {
    if (!channel.current || !online.current) return;
    if (samePlace(tracked.current, mine.current)) return;
    const wait = TRACK_EVERY - (Date.now() - lastTrack.current);
    if (wait > 0) {
      if (!trackTimer.current) trackTimer.current = setTimeout(() => ((trackTimer.current = null), track()), wait);
      return;
    }
    lastTrack.current = Date.now();
    tracked.current = { ...mine.current };
    // The cursor follows the presence update, so nobody is left with presence and no cursor.
    channel.current
      .track(presenceMeta())
      .then(() => mine.current.cursor && sendCursor())
      .catch(() => {});
  };
  const sendCursor = () => {
    if (!channel.current || !online.current) return;
    const wait = CURSOR_EVERY - (Date.now() - lastCursor.current);
    if (wait > 0) {
      if (!cursorTimer.current) cursorTimer.current = setTimeout(() => ((cursorTimer.current = null), sendCursor()), wait);
      return;
    }
    lastCursor.current = Date.now();
    const payload = cursorPayload();
    if (debugOn()) log('cursor out', payload.path, payload.cell, JSON.stringify(payload.cursor));
    channel.current.cursor(payload).catch(() => {});
  };

  useEffect(() => {
    if (!enabled || !me?.id || !projectId) return undefined;
    let ch = null;
    let retry = null;
    let hideTimer = null;
    let failures = 0;
    let stopped = false;
    const reset = () => {
      online.current = false;
      tracked.current = null;
      known.current = new Set();
      early.current = {};
      clearTimeout(trackTimer.current);
      trackTimer.current = null;
      clearTimeout(cursorTimer.current);
      cursorTimer.current = null;
    };
    const leave = () => {
      ch?.close();
      ch = null;
      channel.current = null;
      reset();
      setPeers({});
    };
    const open = () => {
      clearTimeout(retry);
      retry = null;
      if (stopped || ch || !visible()) return;
      setState(failures ? 'reconnecting' : 'joining');
      log('joining', projectId.slice(0, 8), failures ? `(attempt ${failures + 1})` : '');
      const mineCh = api.projectChannel(projectId, me.id, {
        onPresence: (presence) => {
          if (ch !== mineCh) return;
          const others = Object.keys(presence || {}).filter((k) => k !== me.id);
          const newcomer = others.some((k) => !known.current.has(k));
          known.current = new Set(others);
          // Cursors that came before their presence: use them now if still in the same place.
          const waiting = early.current;
          early.current = Object.fromEntries(Object.entries(waiting).filter(([id]) => !(id in (presence || {}))));
          setPeers((prev) => {
            const next = peersFromState(presence, me.id, prev);
            for (const [id, p] of Object.entries(waiting)) {
              if (next[id] && samePlace(next[id], p) && !next[id].cursor) next[id] = { ...next[id], cursor: p.cursor ?? null, at: p.at || next[id].at };
            }
            return next;
          });
          if (newcomer && mine.current.path) sendCursor(); // so they see where I am
        },
        onCursor: (p) => {
          if (ch !== mineCh || !p?.user_id || p.user_id === me.id) return;
          if (debugOn()) log('cursor in', p.user_id.slice(0, 8), p.path, p.cell, JSON.stringify(p.cursor));
          setPeers((prev) => {
            if (prev[p.user_id]) return { ...prev, [p.user_id]: { ...prev[p.user_id], ...pickCursor(p), at: p.at || Date.now() } };
            early.current = { ...early.current, [p.user_id]: p }; // their presence is on its way
            return prev;
          });
        },
        onStatus: (status, error) => {
          if (ch !== mineCh) return;
          if (status === 'SUBSCRIBED') {
            failures = 0;
            online.current = true;
            setState('online');
            setReason(null);
            log('online');
            track();
            if (mine.current.path) sendCursor();
            return;
          }
          if (status !== 'CHANNEL_ERROR' && status !== 'TIMED_OUT' && status !== 'CLOSED') return;
          // Closed or failed without us asking: leave cleanly and rejoin later.
          const refused = isRefusal(error);
          const why = error?.message || (status === 'CLOSED' ? 'The live connection was closed.' : status === 'TIMED_OUT' ? 'The live connection timed out.' : 'The live connection failed.');
          failures += 1;
          const wait = retryDelay(failures, refused);
          log(status.toLowerCase(), why, `— rejoining in ${wait / 1000} s`);
          leave();
          setState(refused ? 'unavailable' : 'reconnecting');
          setReason(why);
          retry = setTimeout(open, wait);
        },
      });
      ch = mineCh;
      channel.current = mineCh;
    };
    const onVisibility = () => {
      if (visible()) {
        clearTimeout(hideTimer);
        hideTimer = null;
        if (!ch) {
          failures = 0;
          open();
        }
      } else if (!hideTimer) {
        hideTimer = setTimeout(() => {
          hideTimer = null;
          log('hidden for 2 min: leaving');
          clearTimeout(retry);
          leave();
          setState('off');
        }, HIDDEN_GRACE);
      }
    };
    const onOnline = () => {
      if (!ch) {
        failures = 0;
        open();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    open();
    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
      clearTimeout(retry);
      clearTimeout(hideTimer);
      if (ch) log('leaving', projectId.slice(0, 8));
      leave();
      setState('off');
      setReason(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, me?.id, projectId]);

  // The open file changed: say so (its cursor comes with the next move).
  useEffect(() => {
    if (mine.current.path === activePath) return;
    mine.current = { path: activePath || null, cell: null, cursor: null };
    sendCursor(); // others see the new file at once
    track();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath]);

  // From the editors (CursorReportContext): a caret or selection moved.
  const report = useCallback((path, cursor, cell = null) => {
    const moved = mine.current.path !== path || mine.current.cell !== cell;
    mine.current = { path, cell, cursor };
    sendCursor();
    if (moved) track();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { peers, state, reason, report };
}
