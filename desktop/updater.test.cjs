// node --test desktop/updater.test.cjs  (no Electron needed)
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { feedConfig, updateGate, describeError, setupUpdates } = require('./updater.js');

const FEED = 'https://github.com/M2-King/Tandem/releases/download/windows-staging';
const staging = { productName: 'Tandem', version: '0.3.1-staging.57', tandemUpdates: { channel: 'staging', url: FEED } };
const regular = { productName: 'Tandem', version: '0.3.0' };
const installDir = 'C:\\Users\\t\\AppData\\Local\\Programs\\tandem-desktop';
const exePath = path.join(installDir, 'Tandem.exe');
const resources = path.join(installDir, 'resources');
const nsisFiles = new Set([path.join(resources, 'app-update.yml'), path.join(installDir, 'Uninstall Tandem.exe')]);
const installed = (f) => nsisFiles.has(f);
const base = { pkg: staging, isPackaged: true, platform: 'win32', env: {}, execPath: exePath, resourcesPath: resources, exists: installed };

test('feed: https and the staging channel only', () => {
  assert.deepEqual(feedConfig(staging), { channel: 'staging', url: FEED });
  assert.equal(feedConfig(regular), null);
  assert.equal(feedConfig({ tandemUpdates: { channel: 'staging', url: 'http://github.com/x' } }), null);
  assert.equal(feedConfig({ tandemUpdates: { channel: 'staging', url: 'https://user:pw@example.com/x' } }), null);
  assert.equal(feedConfig({ tandemUpdates: { channel: 'latest', url: FEED } }), null);
  assert.equal(feedConfig({ tandemUpdates: { channel: 'staging', url: 'not a url' } }), null);
});

test('gate: on for an installed (NSIS) staging build', () => {
  const g = updateGate(base);
  assert.equal(g.enabled, true);
  assert.equal(g.config.url, FEED);
});

test('gate: off for the regular Tandem', () => {
  assert.equal(updateGate({ ...base, pkg: regular }).enabled, false);
});

test('gate: off when running from source (dev)', () => {
  const g = updateGate({ ...base, isPackaged: false });
  assert.equal(g.enabled, false);
  assert.match(g.reason, /source/);
});

test('gate: off for the portable exe', () => {
  for (const env of [{ PORTABLE_EXECUTABLE_FILE: 'D:\\Tandem-Staging-portable.exe' }, { PORTABLE_EXECUTABLE_DIR: 'D:\\' }]) {
    const g = updateGate({ ...base, env, exists: () => true });
    assert.equal(g.enabled, false);
    assert.match(g.reason, /portable/);
  }
});

test('gate: off without the installer’s uninstaller or app-update.yml', () => {
  assert.equal(updateGate({ ...base, exists: (f) => f.endsWith('app-update.yml') }).enabled, false);
  assert.equal(updateGate({ ...base, exists: (f) => f.endsWith('.exe') }).enabled, false);
  assert.equal(updateGate({ ...base, exists: () => false }).enabled, false);
});

test('gate: off on other platforms', () => {
  assert.equal(updateGate({ ...base, platform: 'darwin' }).enabled, false);
});

test('errors read plainly', () => {
  assert.match(describeError(Object.assign(new Error('getaddrinfo ENOTFOUND github.com'), { code: 'ENOTFOUND' })), /connection/);
  assert.match(describeError(new Error('net::ERR_INTERNET_DISCONNECTED')), /connection/);
  assert.match(describeError(new Error('Cannot find channel "staging.yml" update info: HttpError: 404')), /published/);
  assert.match(describeError(new Error('sha512 checksum mismatch')), /checksum/);
  assert.match(describeError(new Error('weird')), /later/);
});

// A stand-in for electron-updater's autoUpdater.
function fakeUpdater() {
  const u = new EventEmitter();
  u.calls = [];
  u.setFeedURL = (o) => u.calls.push(['feed', o]);
  u.checkForUpdates = async () => u.calls.push(['check']);
  u.quitAndInstall = (silent, run) => u.calls.push(['install', silent, run]);
  return u;
}

function harness(overrides = {}) {
  const handlers = {};
  const sent = [];
  const timers = { timeouts: [], intervals: [] };
  const u = fakeUpdater();
  let prepared = 0;
  const shown = [];
  const quitHandlers = [];
  const app = { isPackaged: true, getName: () => 'Tandem Staging', getVersion: () => '0.3.1-staging.57', on: (ev, fn) => ev === 'before-quit' && quitHandlers.push(fn) };
  const updates = setupUpdates({
    app,
    pkg: staging,
    handle: (channel, fn) => (handlers[channel] = fn),
    send: (channel, value) => sent.push([channel, value]),
    prepareInstall: async () => {
      prepared += 1;
    },
    showProgress: async (version, options) => {
      shown.push(options ? [version, prepared, options] : [version, prepared]);
      return true;
    },
    env: {},
    platform: 'win32',
    execPath: exePath,
    resourcesPath: resources,
    exists: installed,
    loadUpdater: () => u,
    timers: { setTimeout: (fn, ms) => timers.timeouts.push([fn, ms]), setInterval: (fn, ms) => timers.intervals.push([fn, ms]) },
    log: { warn() {}, info() {}, error() {} },
    ...overrides,
  });
  return { updates, handlers, sent, timers, u, prepared: () => prepared, shown, quit: () => quitHandlers.forEach((fn) => fn()) };
}

test('updater: fixed feed and settings; checks at 10 s and every 4 h', () => {
  const h = harness();
  h.updates.start();
  assert.deepEqual(h.u.calls[0], ['feed', { provider: 'generic', url: FEED, channel: 'staging', useMultipleRangeRequest: false }]);
  assert.equal(h.u.autoDownload, true);
  assert.equal(h.u.autoInstallOnAppQuit, true);
  assert.equal(h.u.allowDowngrade, false);
  assert.equal(h.timers.timeouts[0][1], 10 * 1000);
  assert.equal(h.timers.intervals[0][1], 4 * 60 * 60 * 1000);
});

test('updater: the page’s handlers take no arguments that matter', async () => {
  const h = harness();
  h.updates.start();
  assert.deepEqual(Object.keys(h.handlers).sort(), ['desktop:updates-check', 'desktop:updates-install', 'desktop:updates-preview', 'desktop:updates-state']);
  // Whatever the page passes is ignored: the feed stays as set.
  h.handlers['desktop:updates-check']('https://evil.example/feed');
  await new Promise((r) => setImmediate(r));
  assert.equal(h.u.calls.filter((c) => c[0] === 'feed').length, 1);
  assert.equal(h.u.calls.filter((c) => c[0] === 'check').length, 1);
});

test('updater: states from check to ready, then restart installs silently', async () => {
  const h = harness();
  h.updates.start();
  const state = () => h.handlers['desktop:updates-state']();
  assert.equal(state().status, 'idle');
  h.handlers['desktop:updates-check']();
  assert.equal(state().status, 'checking');
  h.u.emit('update-available', { version: '0.3.1-staging.58' });
  assert.equal(state().status, 'downloading');
  h.u.emit('download-progress', { percent: 41.7 });
  assert.equal(state().percent, 41);
  // Installing before the download finishes does nothing.
  assert.equal(await h.handlers['desktop:updates-install'](), false);
  h.u.emit('update-downloaded', { version: '0.3.1-staging.58' });
  assert.equal(state().status, 'ready');
  assert.equal(state().available, '0.3.1-staging.58');
  assert.ok(h.sent.some(([c, v]) => c === 'desktop:updates' && v.status === 'ready'));
  // A periodic check while ready doesn't start over.
  h.timers.intervals[0][0]();
  assert.equal(state().status, 'ready');
  assert.equal(await h.handlers['desktop:updates-install'](), true);
  assert.equal(h.prepared(), 1); // the runtime is stopped first
  // The "Updating Tandem" window shows (after the runtime stopped), then Tandem quits into the installer.
  assert.deepEqual(h.shown, [['0.3.1-staging.58', 1]]);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.u.calls.at(-1), ['install', true, true]);
});

test('updater: errors only change the status line', async () => {
  const h = harness();
  h.updates.start();
  h.handlers['desktop:updates-check']();
  h.u.emit('error', Object.assign(new Error('getaddrinfo ENOTFOUND github.com'), { code: 'ENOTFOUND' }));
  const s = h.handlers['desktop:updates-state']();
  assert.equal(s.status, 'error');
  assert.match(s.message, /connection/);
  // A failed check promise is caught, not thrown.
  const h2 = harness();
  h2.u.checkForUpdates = async () => {
    throw new Error('HttpError: 404 Cannot find channel "staging.yml"');
  };
  h2.updates.start();
  h2.handlers['desktop:updates-check']();
  await new Promise((r) => setImmediate(r));
  assert.match(h2.handlers['desktop:updates-state']().message, /published/);
});

test('updater: up to date', () => {
  const h = harness();
  h.updates.start();
  h.handlers['desktop:updates-check']();
  h.u.emit('update-not-available', { version: '0.3.1-staging.57' });
  assert.equal(h.handlers['desktop:updates-state']().status, 'up-to-date');
});

test('updater: portable and dev builds never load electron-updater', () => {
  const cases = [
    { label: 'portable', env: { PORTABLE_EXECUTABLE_FILE: 'D:\\Tandem-Staging-portable.exe' }, isPackaged: true },
    { label: 'dev', env: {}, isPackaged: false },
  ];
  for (const c of cases) {
    let loaded = false;
    const h = harness({
      env: c.env,
      app: { isPackaged: c.isPackaged, getName: () => 'Tandem Staging', getVersion: () => '0.3.1-staging.57' },
      loadUpdater: () => {
        loaded = true;
        return fakeUpdater();
      },
    });
    h.updates.start();
    assert.equal(loaded, false, c.label);
    const s = h.handlers['desktop:updates-state']();
    assert.equal(s.enabled, false, c.label);
    assert.equal(s.status, 'off', c.label);
    assert.equal(h.handlers['desktop:updates-check']().status, 'off', c.label);
    assert.equal(h.timers.timeouts.length, 0, c.label);
  }
});

test('updater: closing Tandem with an update waiting shows the progress window (no reopening), once', async () => {
  const h = harness();
  h.updates.start();
  h.quit(); // nothing waiting: nothing shown
  await new Promise((r) => setImmediate(r));
  assert.equal(h.shown.length, 0);
  h.u.emit('update-available', { version: '0.3.1-staging.59' });
  h.u.emit('update-downloaded', { version: '0.3.1-staging.59' });
  h.quit();
  h.quit();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.shown, [['0.3.1-staging.59', 0, { relaunch: false }]]);
});

test('updater: after "Restart to update" the quit that follows shows no second window', async () => {
  const h = harness();
  h.updates.start();
  h.u.emit('update-available', { version: '0.3.1-staging.59' });
  h.u.emit('update-downloaded', { version: '0.3.1-staging.59' });
  await h.handlers['desktop:updates-install']();
  h.quit();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.shown.length, 1);
});

test('updater: "Preview the update window" opens it with a made-up update (Windows only)', async () => {
  let previews = 0;
  const h = harness({ showPreview: async () => ++previews });
  h.updates.start();
  await h.handlers['desktop:updates-preview']();
  assert.equal(previews, 1);
  const mac = harness({ platform: 'darwin', showPreview: async () => ++previews });
  assert.equal(await mac.handlers['desktop:updates-preview'](), false);
  assert.equal(previews, 1);
});
