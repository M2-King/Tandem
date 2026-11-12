// "Updating Tandem" after Tandem closes for an update (Windows). The installer
// runs silently, so without this nothing shows for half a minute. Just before
// quitting, Tandem starts a small window of its own (desktop/updating.ps1,
// Windows PowerShell + WinForms) that shows the progress and closes once the
// new version runs. Tandem waits (briefly) until it shows, so the hand-over
// has no gap.
//
// The script is copied out of the app (the installer replaces the app's
// folder while the window runs) to the temp folder.

const fs = require('fs');
const os = require('os');
const path = require('path');

// The app folder's size in bytes (the window measures the new one against it).
function folderSize(dir) {
  let sum = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else {
        try {
          sum += fs.statSync(p).size;
        } catch {
          // gone meanwhile
        }
      }
    }
  }
  return sum;
}

// Arguments for powershell.exe (testable without Windows).
function updatingArgs({ scriptPath, installDir, exeName, appName, version, baseline, readyFile }) {
  return [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-WindowStyle',
    'Hidden',
    '-File',
    scriptPath,
    '-InstallDir',
    installDir,
    '-ExeName',
    exeName,
    '-AppName',
    appName,
    '-Version',
    version || '',
    '-Baseline',
    String(Math.max(0, Math.round(baseline || 0))),
    '-ReadyFile',
    readyFile,
  ];
}

// Starts the window; resolves true once it shows (or false after `waitMs`,
// or if it couldn't start). Never throws: an update must not fail over this.
async function showUpdatingWindow({
  execPath = process.execPath,
  appName = 'Tandem',
  version = '',
  waitMs = 5000,
  spawn = require('child_process').spawn,
  tmpdir = os.tmpdir(),
  platform = process.platform,
  log = console,
} = {}) {
  if (platform !== 'win32') return false;
  try {
    const installDir = path.dirname(execPath);
    const scriptPath = path.join(tmpdir, 'tandem-updating.ps1');
    const readyFile = path.join(tmpdir, `tandem-updating-${process.pid}.ready`);
    fs.writeFileSync(scriptPath, fs.readFileSync(path.join(__dirname, 'updating.ps1'), 'utf8'));
    try {
      fs.unlinkSync(readyFile);
    } catch {
      // not there
    }
    const args = updatingArgs({
      scriptPath,
      installDir,
      exeName: path.basename(execPath),
      appName,
      version,
      baseline: folderSize(installDir),
      readyFile,
    });
    const child = spawn('powershell.exe', args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on?.('error', (err) => log.warn?.('[updates] progress window', err));
    child.unref?.();
    const until = Date.now() + waitMs;
    while (Date.now() < until) {
      if (fs.existsSync(readyFile)) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  } catch (err) {
    log.warn?.('[updates] progress window', err);
    return false;
  }
}

module.exports = { folderSize, updatingArgs, showUpdatingWindow };
