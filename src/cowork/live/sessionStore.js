// Cowork live mode: where the sign-in is kept between launches ("Keep me
// signed in on this device"), as a storage for supabase-js (getItem, setItem,
// removeItem; promises are fine).
//
//   - Windows and Mac app: encrypted by the operating system (Electron
//     safeStorage, desktop/secureStore.js), through window.tandemDesktop.secure.
//   - iPad app: the iPad Keychain, through the app's local server
//     (/api/secure, SecureStore.swift).
//   - A browser (preview, development): the browser's localStorage.
//
// With "Keep me signed in" off the session lives in memory only, as before,
// and anything kept earlier is removed.

import { IS_IPAD, RUNTIME_CONFIG } from '../../runtime/config.js';

const desktop = () => (typeof window !== 'undefined' ? window.tandemDesktop?.secure : null);

async function ipad(method, name, value) {
  const res = await fetch(method === 'GET' ? `/api/secure?name=${encodeURIComponent(name)}` : '/api/secure', {
    method,
    headers: { 'content-type': 'application/json', 'x-tandem-token': RUNTIME_CONFIG.token },
    body: method === 'GET' ? undefined : JSON.stringify({ name, value }),
  });
  if (!res.ok) throw new Error(`The iPad app couldn't keep the sign-in (${res.status}).`);
  return res.json();
}

function browser() {
  try {
    const ls = window.localStorage;
    ls.getItem('tandem.probe');
    return ls;
  } catch {
    return null;
  }
}

// The device's own keeping place: { get, set } (set(name, null) removes), or null.
function persistent() {
  const d = desktop();
  if (d) return { where: 'desktop', get: (n) => d.get(n), set: (n, v) => d.set(n, v) };
  if (IS_IPAD) return { where: 'ipad', get: async (n) => (await ipad('GET', n)).value ?? null, set: (n, v) => ipad('PUT', n, v) };
  const ls = browser();
  if (ls) return { where: 'browser', get: (n) => ls.getItem(`tandem.cowork.${n}`), set: (n, v) => (v === null ? ls.removeItem(`tandem.cowork.${n}`) : ls.setItem(`tandem.cowork.${n}`, v)) };
  return null;
}

export function createSessionStore() {
  const memory = new Map();
  const place = persistent();
  let remember = true;
  const quietly = async (fn) => {
    try {
      return await fn();
    } catch {
      return null; // keeping it is a convenience: signing in still works without
    }
  };
  return {
    where: place?.where ?? 'memory',
    setRemember(on) {
      remember = !!on;
    },
    async getItem(name) {
      if (memory.has(name)) return memory.get(name);
      if (!place) return null;
      const value = await quietly(() => place.get(name));
      if (value !== null && value !== undefined) memory.set(name, value);
      return value ?? null;
    },
    async setItem(name, value) {
      memory.set(name, value);
      if (place) await quietly(() => place.set(name, remember ? value : null));
    },
    async removeItem(name) {
      memory.delete(name);
      if (place) await quietly(() => place.set(name, null));
    },
  };
}
