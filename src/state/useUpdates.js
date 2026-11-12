import { useCallback, useEffect, useState } from 'react';
import { DESKTOP } from '../runtime/desktop.js';

// In-app updates (Tandem Staging on Windows). The desktop app does the work;
// the page only reads the state, asks for a check, and asks to restart into
// an update that is already downloaded. Elsewhere this is inert.
const BRIDGE = DESKTOP?.updates || null;

function timeOf(ms) {
  try {
    return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

// One line for the ⋯ menu.
export function updateStatusText(s) {
  if (!s) return '';
  switch (s.status) {
    case 'off':
      return s.reason || 'Updates are off.';
    case 'checking':
      return 'Checking for updates…';
    case 'up-to-date':
      return s.checkedAt ? `Up to date (checked at ${timeOf(s.checkedAt)}).` : 'Up to date.';
    case 'downloading':
      return `Downloading ${s.available || 'the update'}… ${s.percent ?? 0}%`;
    case 'ready':
      return `${s.available || 'An update'} is ready. Restart to update.`;
    case 'error':
      return s.message || 'Couldn’t check for updates.';
    default:
      return 'Checks for updates in the background.';
  }
}

// After an update, the first start says so ("Updated to …"), once.
const SEEN_KEY = 'tandem.updates.version';
function versionChange(version) {
  try {
    const before = localStorage.getItem(SEEN_KEY);
    localStorage.setItem(SEEN_KEY, version);
    return before && before !== version ? before : null;
  } catch {
    return null;
  }
}

export function useUpdates({ notify } = {}) {
  const [state, setState] = useState(null);
  const [laterFor, setLaterFor] = useState(null); // the version "Later" was chosen for
  const [asked, setAsked] = useState(false); // a check the person asked for: show how it goes
  const [installing, setInstalling] = useState(null); // the version being installed: the overlay

  useEffect(() => {
    if (!BRIDGE) return undefined;
    let live = true;
    BRIDGE.state()
      .then((s) => {
        if (!live) return;
        setState(s);
        if (s?.version && versionChange(s.version)) notify?.(`${s.name || 'Tandem'} was updated to ${s.version}.`);
      })
      .catch(() => {});
    const off = BRIDGE.onState((s) => setState(s));
    return () => {
      live = false;
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A check the person asked for: say "Up to date" a few seconds, then go.
  const status = state?.status;
  useEffect(() => {
    if (!asked || status !== 'up-to-date') return undefined;
    const t = setTimeout(() => setAsked(false), 4000);
    return () => clearTimeout(t);
  }, [asked, status]);

  const check = useCallback(() => {
    setAsked(true);
    BRIDGE?.check()
      .then((s) => s && setState(s))
      .catch(() => {});
  }, []);
  // Show "Updating…" first, then quit into the installer.
  const install = useCallback(async () => {
    if (!BRIDGE) return false;
    setInstalling(state?.available || 'the update');
    await new Promise((r) => setTimeout(r, 1400));
    const ok = await BRIDGE.install().catch(() => false);
    if (!ok) setInstalling(null);
    return ok;
  }, [state?.available]);

  // What the banner shows: progress while downloading; "ready" until Later;
  // and, after a check the person asked for, checking / up to date / error.
  let banner = null;
  if (status === 'downloading') banner = 'downloading';
  else if (status === 'ready' && laterFor !== state.available) banner = 'ready';
  else if (asked && ['checking', 'up-to-date', 'error'].includes(status)) banner = status;
  return {
    supported: !!BRIDGE,
    state,
    check,
    install,
    installing,
    banner,
    later: () => setLaterFor(state?.available ?? null),
    dismiss: () => setAsked(false),
  };
}
