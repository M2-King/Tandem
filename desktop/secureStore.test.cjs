// node --test desktop/secureStore.test.cjs  (no Electron needed)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSecureStore } = require('./secureStore.js');

// A stand-in for Electron's safeStorage: reversible, and never plain text.
const fakeSafeStorage = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from(`enc:${Buffer.from(s).toString('hex')}`),
  decryptString: (b) => {
    const t = b.toString();
    if (!t.startsWith('enc:')) throw new Error('not ours');
    return Buffer.from(t.slice(4), 'hex').toString();
  },
});
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-secure-'));

test('a value is kept encrypted and read back', () => {
  const dir = tmp();
  const store = createSecureStore({ safeStorage: fakeSafeStorage(), dir });
  assert.equal(store.set('sb-x-auth-token', '{"refresh_token":"r1"}'), true);
  assert.equal(store.get('sb-x-auth-token'), '{"refresh_token":"r1"}');
  const onDisk = fs.readFileSync(path.join(dir, 'secure-values.json'), 'utf8');
  assert.ok(!onDisk.includes('refresh_token'), 'not kept as plain text');
  // A new store (the next launch) reads the same value.
  assert.equal(createSecureStore({ safeStorage: fakeSafeStorage(), dir }).get('sb-x-auth-token'), '{"refresh_token":"r1"}');
});

test('null removes it, and the file goes with the last value', () => {
  const dir = tmp();
  const store = createSecureStore({ safeStorage: fakeSafeStorage(), dir });
  store.set('a', '1');
  store.set('a', null);
  assert.equal(store.get('a'), null);
  assert.equal(fs.existsSync(path.join(dir, 'secure-values.json')), false);
});

test('without encryption nothing is kept', () => {
  const dir = tmp();
  const store = createSecureStore({ safeStorage: fakeSafeStorage(false), dir });
  assert.equal(store.set('a', 'secret'), false);
  assert.equal(store.get('a'), null);
  assert.equal(fs.existsSync(path.join(dir, 'secure-values.json')), false);
});

test('a value that can no longer be decrypted reads as not saved', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'secure-values.json'), JSON.stringify({ a: Buffer.from('other').toString('base64') }));
  assert.equal(createSecureStore({ safeStorage: fakeSafeStorage(), dir }).get('a'), null);
});

test('names are checked and values limited', () => {
  const store = createSecureStore({ safeStorage: fakeSafeStorage(), dir: tmp() });
  for (const bad of ['', '../x', 'a b', 'x'.repeat(121), 5]) assert.throws(() => store.get(bad));
  assert.throws(() => store.set('a', 'x'.repeat(32 * 1024 + 1)));
  assert.throws(() => store.set('a', { not: 'text' }));
});
