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

export function useUpdates() {
  const [state, setState] = useState(null);
  const [laterFor, setLaterFor] = useState(null); // the version "Later" was chosen for

  useEffect(() => {
    if (!BRIDGE) return undefined;
    let live = true;
    BRIDGE.state()
      .then((s) => live && setState(s))
      .catch(() => {});
    const off = BRIDGE.onState((s) => setState(s));
    return () => {
      live = false;
      off();
    };
  }, []);

  const check = useCallback(() => {
    BRIDGE?.check()
      .then((s) => s && setState(s))
      .catch(() => {});
  }, []);
  const install = useCallback(async () => (BRIDGE ? BRIDGE.install() : false), []);

  const ready = state?.status === 'ready';
  return {
    supported: !!BRIDGE,
    state,
    check,
    install,
    banner: ready && laterFor !== state.available,
    later: () => setLaterFor(state?.available ?? null),
  };
}
