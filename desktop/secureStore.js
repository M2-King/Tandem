// Small secrets the page asks the app to keep between launches: today, the
// Cowork sign-in ("Keep me signed in"). Encrypted with Electron's safeStorage
// (Windows: DPAPI for this Windows account; macOS: a key in the Keychain) in
// a file in the app's user data folder. Nothing is kept when the operating
// system can't encrypt it: the page then simply asks to sign in again.
//
// Names are checked and values limited; only Tandem's own page can reach it
// (main.js checks the sender of every IPC call).

const fs = require('fs');
const path = require('path');

const NAME = /^[A-Za-z0-9._:-]{1,120}$/;
const MAX_VALUE = 32 * 1024;

function createSecureStore({ safeStorage, dir }) {
  const file = path.join(dir, 'secure-values.json');
  const read = () => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    } catch {
      return {};
    }
  };
  const write = (all) => {
    if (!Object.keys(all).length) {
      fs.rmSync(file, { force: true });
      return;
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(all), { mode: 0o600 });
  };
  const check = (name) => {
    if (typeof name !== 'string' || !NAME.test(name)) throw new Error('That name can’t be stored.');
  };
  return {
    available: () => safeStorage.isEncryptionAvailable(),
    get(name) {
      check(name);
      const stored = read()[name];
      if (!stored || !safeStorage.isEncryptionAvailable()) return null;
      try {
        return safeStorage.decryptString(Buffer.from(stored, 'base64'));
      } catch {
        return null; // encrypted for another account or machine: as if not saved
      }
    },
    // Saves `value`, or removes the name when it is null. Returns whether it was kept.
    set(name, value) {
      check(name);
      const all = read();
      delete all[name];
      if (value === null || value === undefined) {
        write(all);
        return true;
      }
      if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_VALUE) throw new Error('That value is too large to store.');
      if (!safeStorage.isEncryptionAvailable()) {
        write(all);
        return false;
      }
      all[name] = safeStorage.encryptString(value).toString('base64');
      write(all);
      return true;
    },
  };
}

module.exports = { createSecureStore };
