// In-app updates for Tandem Staging on Windows (electron-updater).
//
// On only when all of these hold:
//   - the build is Tandem Staging (packaging/staging-app.cjs writes
//     `tandemUpdates` into package.json; the regular Tandem has none),
//   - the app is packaged (not `electron .` from source),
//   - it was installed by the NSIS installer (not the portable .exe).
//
// The feed is fixed at build time: an https URL and the "staging" channel,
// read from the packaged package.json. The page can ask for the state, a
// check, and to restart into an update that is already downloaded; it can't
// change the feed or start any other download. electron-updater verifies the
// installer's sha512 against staging.yml before it will run it.
//
// TODO(code signing): the installer is unsigned, so there is no
// publisherName (see packaging/staging-app.cjs). Once it is signed, add
// publisherName so electron-updater also checks the signature.

const fs = require('node:fs');
const path = require('node:path');

const FIRST_CHECK_MS = 10 * 1000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

// The feed settings a staging build carries, or null.
function feedConfig(pkg) {
  const u = pkg && pkg.tandemUpdates;
  if (!u || u.channel !== 'staging' || typeof u.url !== 'string') return null;
  let url;
  try {
    url = new URL(u.url);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null; // HTTPS, no credentials
  return { channel: 'staging', url: u.url.replace(/\/+$/, '') };
}

// Whether this copy of the app may update itself, and if not, why.
function updateGate({ pkg, isPackaged, platform, env = {}, execPath, resourcesPath, exists = fs.existsSync }) {
  const config = feedConfig(pkg);
  if (!config) return { enabled: false, config: null, reason: 'Updates come with the installer only.' };
  if (!isPackaged) return { enabled: false, config, reason: 'Updates are off when Tandem runs from source.' };
  if (platform !== 'win32') return { enabled: false, config, reason: 'Updates are for the Windows installer only.' };
  if (env.PORTABLE_EXECUTABLE_FILE || env.PORTABLE_EXECUTABLE_DIR) {
    return { enabled: false, config, reason: 'The portable app doesn’t update itself. Use the installer to get updates.' };
  }
  const productName = pkg.productName || 'Tandem Staging';
  const installedByNsis =
    exists(path.join(resourcesPath, 'app-update.yml')) &&
    exists(path.join(path.dirname(execPath), `Uninstall ${productName}.exe`));
  if (!installedByNsis) {
    return { enabled: false, config, reason: 'This copy wasn’t installed by the installer, so it doesn’t update itself.' };
  }
  return { enabled: true, config, reason: null };
}

// Short, readable reasons; the full error goes to the log.
function describeError(err) {
  const text = `${(err && err.code) || ''} ${(err && err.message) || err || ''}`;
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_NETWORK|ERR_PROXY|net::/i.test(text)) {
    return 'Can’t reach the update feed. Check the connection.';
  }
  if (/\b404\b|Cannot find channel|staging\.yml/i.test(text)) return 'No staging update has been published yet.';
  if (/sha512|checksum/i.test(text)) return 'The download didn’t match its checksum, so it won’t be installed.';
  return 'Couldn’t check for updates. Tandem will try again later.';
}

// Wires the updater to the page. `handle` is main.js's IPC helper (it only
// answers Tandem's own page); `send` posts to the window; `prepareInstall`
// stops the Python runtime before the installer starts.
function setupUpdates({
  app,
  pkg,
  handle,
  send,
  prepareInstall,
  showProgress = async () => false, // the "Updating Tandem" window (updatingWindow.js)
  env = process.env,
  platform = process.platform,
  execPath = process.execPath,
  resourcesPath = process.resourcesPath,
  exists = fs.existsSync,
  loadUpdater = () => require('electron-updater').autoUpdater,
  timers = { setTimeout, setInterval },
  log = console,
}) {
  const gate = updateGate({
    pkg,
    isPackaged: app.isPackaged,
    platform,
    env,
    execPath,
    resourcesPath,
    exists,
  });

  let state = {
    enabled: gate.enabled,
    reason: gate.reason,
    staging: !!gate.config,
    name: pkg.tandemDisplayName || app.getName(),
    version: app.getVersion(),
    status: gate.enabled ? 'idle' : 'off', // off | idle | checking | up-to-date | downloading | ready | error
    available: null,
    percent: null,
    message: null,
    checkedAt: null,
  };
  const set = (patch) => {
    state = { ...state, ...patch };
    send('desktop:updates', state);
  };

  let updater = null;
  let installing = false;

  function check() {
    if (!updater || installing) return state;
    if (['checking', 'downloading', 'ready'].includes(state.status)) return state;
    set({ status: 'checking', message: null, percent: null });
    Promise.resolve()
      .then(() => updater.checkForUpdates())
      .catch((err) => onError(err));
    return state;
  }

  function onError(err) {
    log.warn?.('[updates]', err && err.stack ? err.stack : err);
    if (state.status === 'ready') return; // a download is waiting; keep offering it
    set({ status: 'error', message: describeError(err), percent: null, checkedAt: Date.now() });
  }

  async function install() {
    if (!updater || state.status !== 'ready' || installing) return false;
    installing = true;
    try {
      await prepareInstall(); // stops the Python runtime (the before-quit handling)
    } catch (err) {
      log.warn?.('[updates] before install', err);
    }
    // The installer runs silently: a small window shows its progress after
    // Tandem closes (and closes once the new version runs).
    try {
      await showProgress(state.available);
    } catch (err) {
      log.warn?.('[updates] progress window', err);
    }
    // Silent install, then open the new version.
    setImmediate(() => updater.quitAndInstall(true, true));
    return true;
  }

  handle('desktop:updates-state', () => state);
  handle('desktop:updates-check', () => check());
  handle('desktop:updates-install', () => install());

  function start() {
    if (!gate.enabled) return;
    try {
      updater = loadUpdater();
      updater.logger = log;
      // The feed is fixed here; nothing the page sends reaches these.
      // One range per request: GitHub's file servers refuse several in one (HTTP 501),
      // which made every update download the whole installer instead of the changed parts.
      updater.setFeedURL({ provider: 'generic', url: gate.config.url, channel: gate.config.channel, useMultipleRangeRequest: false });
      updater.autoDownload = true;
      updater.autoInstallOnAppQuit = true; // "Later": installs when Tandem quits
      updater.allowDowngrade = false; // set after the feed: setting a channel can turn it on
      updater.fullChangelog = false;
    } catch (err) {
      updater = null;
      log.warn?.('[updates] setup', err);
      set({ enabled: false, status: 'off', reason: 'Updates couldn’t start in this copy of Tandem.' });
      return;
    }
    updater.on('checking-for-update', () => set({ status: 'checking', message: null }));
    updater.on('update-not-available', () => set({ status: 'up-to-date', available: null, percent: null, checkedAt: Date.now() }));
    updater.on('update-available', (info) => set({ status: 'downloading', available: info?.version ?? null, percent: 0, checkedAt: Date.now() }));
    updater.on('download-progress', (p) => {
      if (state.status === 'downloading' || state.status === 'checking') {
        set({ status: 'downloading', percent: Math.max(0, Math.min(100, Math.floor(p?.percent ?? 0))) });
      }
    });
    updater.on('update-downloaded', (info) => set({ status: 'ready', available: info?.version ?? state.available, percent: 100, message: null }));
    updater.on('error', onError);

    timers.setTimeout(check, FIRST_CHECK_MS);
    timers.setInterval(check, CHECK_EVERY_MS);
  }

  return { start, check, install, state: () => state };
}

module.exports = { feedConfig, updateGate, describeError, setupUpdates, FIRST_CHECK_MS, CHECK_EVERY_MS };
