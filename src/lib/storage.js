// localStorage can be unavailable (private windows, blocked storage), so
// every read and write is wrapped. The app keeps working without it.

export function loadJSON(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

// Returns true when the value was saved.
export function saveJSON(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function removeKeys(keys) {
  try {
    keys.forEach((k) => window.localStorage.removeItem(k));
  } catch {
    /* storage unavailable: nothing to clear */
  }
}

export const STORAGE_KEYS = {
  prefs: 'tandem.prefs.v1',
  workspace: 'tandem.workspace.v1',
  chat: 'tandem.chat.v1',
  runs: 'tandem.runs.v1',
};
