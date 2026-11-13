// Tandem desktop app (Electron main process).
//
// Starts the bundled Python runtime for a project folder, then shows the Tandem
// UI it serves in a native window. The window has no wallpaper of its own: what
// is behind it is the person's real desktop, seen through the system's glass
// (Windows acrylic or Mica, macOS vibrancy) or, with "Clear", unchanged.
//
// Security: the page runs sandboxed with context isolation and no Node access.
// It may only load the local runtime's own address; other links open in the
// browser. The preload exposes a few window actions and, in Tandem Staging,
// the update state (updater.js), nothing else.

const { app, BrowserWindow, dialog, ipcMain, nativeImage, nativeTheme, safeStorage, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setupUpdates } = require('./updater.js');

// The staging build is named "Tandem" but keeps its settings, kept sign-in and
// shared projects' working copies in the folder it always had ("Tandem
// Staging"), apart from a regular Tandem's. Not when a folder is given
// (--user-data-dir, the tests).
const DATA_FOLDER = require('./package.json').tandemDataFolder;
if (DATA_FOLDER && !app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', path.join(app.getPath('appData'), DATA_FOLDER));
}
const { showUpdatingWindow } = require('./updatingWindow.js');
const { createSecureStore } = require('./secureStore.js');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const TOOLBAR_HEIGHT = 52; // matches --toolbar-height in the UI
// Acrylic and Mica need Windows 11 22H2 (build 22621) or later; older Windows gets Clear.
const WIN_BUILD = IS_WIN ? Number(os.release().split('.')[2] || 0) : 0;
const SYSTEM_GLASS = (IS_WIN && WIN_BUILD >= 22621) || IS_MAC;
const MATERIALS = !SYSTEM_GLASS ? ['clear'] : IS_WIN ? ['clear', 'acrylic', 'mica'] : ['clear', 'vibrancy'];
const DEFAULT_MATERIAL = !SYSTEM_GLASS ? 'clear' : IS_WIN ? 'acrylic' : 'vibrancy';

let win = null;
let runtime = null; // { proc, url, origin, folder }
let quitting = false;

// ---------------------------------------------------------------- settings

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) || {};
  } catch {
    return {};
  }
}

function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  return next;
}

const currentMaterial = () => {
  const m = loadSettings().material;
  return MATERIALS.includes(m) ? m : DEFAULT_MATERIAL;
};

// ---------------------------------------------------------------- runtime

function runtimeCommand() {
  if (process.env.TANDEM_RUNTIME) return process.env.TANDEM_RUNTIME;
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'runtime', IS_WIN ? 'tandem-runtime.exe' : 'tandem-runtime');
  }
  const venv = path.join(__dirname, '..', 'runtime', '.venv');
  return IS_WIN ? path.join(venv, 'Scripts', 'tandem.exe') : path.join(venv, 'bin', 'tandem');
}

function startRuntime(folder) {
  return new Promise((resolve, reject) => {
    const args = ['serve', folder, '--port', '0', '--print-url', '--watch-pid', String(process.pid)];
    // Tandem Cowork: working copies of shared projects live in the app's own data, not in project folders.
    args.push('--shared-root', path.join(app.getPath('userData'), 'Shared'));
    if (!app.isPackaged && process.env.TANDEM_UI) args.push('--ui', process.env.TANDEM_UI);
    // windowsHide keeps a console for the runtime (Stop needs one) without showing it.
    const proc = spawn(runtimeCommand(), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => fail(new Error('The Python runtime did not start within 60 seconds.')), 60000);
    function fail(e) {
      clearTimeout(timer);
      proc.kill();
      reject(new Error(`${e.message}${err.trim() ? `\n\n${err.trim().slice(-1500)}` : ''}`));
    }
    proc.on('error', fail);
    proc.stderr.on('data', (d) => {
      err = (err + d).slice(-8000);
    });
    proc.stdout.on('data', (d) => {
      out += d;
      const line = out.split(/\r?\n/)[0];
      if (out.includes('\n') && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(line.trim())) {
        clearTimeout(timer);
        const url = line.trim();
        resolve({ proc, url, origin: new URL(url).origin, folder });
      }
    });
    proc.on('exit', (code) => {
      if (!runtime || runtime.proc !== proc) {
        if (code !== null && code !== 0) fail(new Error(`The Python runtime stopped (exit code ${code}).`));
        return;
      }
      runtime = null;
      if (!quitting && win && !win.isDestroyed()) win.webContents.send('desktop:runtime-exit', code);
    });
  });
}

// Resolves once the runtime has exited (or after `waitMs`).
function stopRuntime(waitMs = 0) {
  const proc = runtime?.proc;
  runtime = null;
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  const exited = new Promise((resolve) => {
    proc.once('exit', resolve);
    if (waitMs) setTimeout(resolve, waitMs);
  });
  proc.kill();
  return waitMs ? exited : Promise.resolve();
}

// ---------------------------------------------------------------- wallpaper brightness
// The UI adapts the glass density to the wallpaper's brightness (it never
// changes the wallpaper). On Windows the current wallpaper is always available
// as TranscodedWallpaper, whatever its source (picture, slideshow, Spotlight).

function wallpaperFile() {
  if (!IS_WIN) return null;
  const transcoded = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Themes', 'TranscodedWallpaper');
  return fs.existsSync(transcoded) ? transcoded : null;
}

function wallpaperLuminance() {
  const file = wallpaperFile();
  if (!file) return null;
  try {
    const image = nativeImage.createFromBuffer(fs.readFileSync(file));
    if (image.isEmpty()) return null;
    const small = image.resize({ width: 32, height: 32, quality: 'good' });
    const bgra = small.toBitmap();
    const values = [];
    for (let i = 0; i + 3 < bgra.length; i += 4) {
      values.push((0.0722 * bgra[i] + 0.7152 * bgra[i + 1] + 0.2126 * bgra[i + 2]) / 255);
    }
    if (!values.length) return null;
    values.sort((a, b) => a - b);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const high = values[Math.floor(values.length * 0.8)];
    return Math.round(((mean + high) / 2) * 100) / 100;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- window

function windowOptions(material) {
  const options = {
    width: 1440,
    height: 900,
    minWidth: 880,
    minHeight: 560,
    show: false,
    title: 'Tandem',
    icon: path.join(__dirname, 'build', IS_WIN ? 'icon.ico' : 'icon.png'),
    backgroundColor: '#00000000',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  };
  if (material === 'clear') {
    // A transparent, frameless window: the desktop shows through unchanged.
    // Window buttons are drawn by the UI.
    Object.assign(options, { transparent: true, frame: false, hasShadow: true });
  } else if (IS_WIN) {
    Object.assign(options, {
      backgroundMaterial: material, // 'acrylic' or 'mica' (Windows 11)
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#00000000', symbolColor: '#e6e9ef', height: TOOLBAR_HEIGHT },
    });
  } else if (IS_MAC) {
    Object.assign(options, {
      vibrancy: 'under-window',
      visualEffectState: 'active',
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 18 },
    });
  }
  return options;
}

function lockDown(contents) {
  const allowed = (url) => runtime && url.startsWith(runtime.origin + '/');
  contents.on('will-navigate', (event, url) => {
    if (!allowed(url)) event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !allowed(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
}

function createWindow(place) {
  const material = currentMaterial();
  const w = new BrowserWindow({ ...windowOptions(material), ...(place?.bounds || {}) });
  win = w;
  lockDown(w.webContents);
  w.once('ready-to-show', () => {
    if (place?.maximized) w.maximize();
    w.show();
    place?.onShown?.();
  });
  w.on('closed', () => {
    if (win === w) win = null;
  });
  w.on('maximize', () => w.webContents.send('desktop:maximized', true));
  w.on('unmaximize', () => w.webContents.send('desktop:maximized', false));
  w.on('focus', () => w.webContents.send('desktop:wallpaper', wallpaperLuminance()));
  w.loadURL(runtime.url);
  return w;
}

// Clear glass needs a transparent window, which Windows only allows when a
// window is created: put a new window exactly where the old one is, then
// close the old one. The page reloads in a moment; files are already on disk.
function replaceWindow() {
  const old = win;
  const place = {
    bounds: old.isMaximized() ? old.getNormalBounds() : old.getBounds(),
    maximized: old.isMaximized(),
    onShown: () => {
      if (!old.isDestroyed()) old.destroy();
    },
  };
  createWindow(place);
}

async function chooseFolder(parent) {
  const last = loadSettings().lastFolder;
  const result = await dialog.showOpenDialog(parent ?? undefined, {
    title: 'Open a project folder',
    defaultPath: last && fs.existsSync(last) ? last : os.homedir(),
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
}

async function openFolder(folder) {
  stopRuntime();
  try {
    runtime = await startRuntime(folder);
  } catch (e) {
    await dialog.showMessageBox(win ?? undefined, {
      type: 'error',
      title: 'Tandem',
      message: 'Tandem couldn’t start its Python runtime.',
      detail: e.message,
    });
    return false;
  }
  saveSettings({ lastFolder: folder });
  if (win && !win.isDestroyed()) win.loadURL(runtime.url);
  else createWindow();
  return true;
}

// ---------------------------------------------------------------- IPC (from the page)

function fromOurPage(event) {
  return runtime && win && event.sender === win.webContents && event.senderFrame?.url.startsWith(runtime.origin + '/');
}

// The Cowork sign-in, kept between launches (encrypted by the operating system).
let secureStore = null;
const secure = () => (secureStore ??= createSecureStore({ safeStorage, dir: app.getPath('userData') }));

function handle(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!fromOurPage(event)) throw new Error('Not allowed');
    return fn(...args);
  });
}

handle('desktop:secure-get', (name) => secure().get(name));
handle('desktop:secure-set', (name, value) => secure().set(name, value));

handle('desktop:info', () => ({
  platform: process.platform,
  material: currentMaterial(),
  materials: MATERIALS,
  maximized: win?.isMaximized() ?? false,
  folder: runtime?.folder ?? null,
  name: require('./package.json').tandemDisplayName || app.getName(),
  version: app.getVersion(),
  wallpaperLuminance: wallpaperLuminance(),
}));

handle('desktop:set-material', (material) => {
  if (!MATERIALS.includes(material)) throw new Error('Unknown material');
  const before = currentMaterial();
  saveSettings({ material });
  if (material === before) return { applied: true, restart: false };
  // Acrylic and Mica switch in place; to or from Clear the window is replaced.
  if (IS_WIN && before !== 'clear' && material !== 'clear') {
    win.setBackgroundMaterial(material);
    return { applied: true, replaced: false };
  }
  setTimeout(replaceWindow, 50); // after this reply reaches the page
  return { applied: true, replaced: true };
});

handle('desktop:restart', () => {
  app.relaunch();
  quitting = true;
  app.quit();
});

handle('desktop:open-folder', async () => {
  const folder = await chooseFolder(win);
  if (!folder) return false;
  return openFolder(folder);
});

handle('desktop:restart-runtime', () => (runtime?.folder || loadSettings().lastFolder ? openFolder(runtime?.folder || loadSettings().lastFolder) : false));

// Tandem Staging updates itself; in other builds these only report "off".
const updates = setupUpdates({
  app,
  pkg: require('./package.json'),
  handle,
  send: (channel, value) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, value);
  },
  // Before the installer starts: stop the Python runtime, as quitting does.
  prepareInstall: () => {
    quitting = true;
    return stopRuntime(5000);
  },
  // Then a small "Updating Tandem" window that stays while the installer runs.
  // (When Tandem is closing with an update waiting: it doesn't reopen, and there is no time to wait.)
  showProgress: (version, { relaunch = true } = {}) =>
    showUpdatingWindow({
      appName: require('./package.json').tandemDisplayName || app.getName(),
      version: String(version || '').replace(/-staging\.(\d+)$/, ' (build $1)'),
      relaunch,
      waitMs: relaunch ? 8000 : 0,
    }),
});

handle('desktop:window', (action) => {
  if (!win) return;
  if (action === 'minimize') win.minimize();
  else if (action === 'maximize') (win.isMaximized() ? win.unmaximize() : win.maximize());
  else if (action === 'close') win.close();
});

// ---------------------------------------------------------------- app lifecycle

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    nativeTheme.themeSource = 'dark';
    updates.start(); // first check after 10 s, in the background
    let folder = process.env.TANDEM_OPEN_FOLDER || loadSettings().lastFolder;
    if (!folder || !fs.existsSync(folder)) folder = await chooseFolder(null);
    if (!folder || !(await openFolder(folder))) {
      app.quit();
    }
  });

  app.on('window-all-closed', () => {
    quitting = true;
    stopRuntime();
    app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
    stopRuntime();
  });
}
