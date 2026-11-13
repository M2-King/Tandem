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

// The window's settings (testable without Windows); the script reads them as
// JSON from TANDEM_UPDATING_ARGS.
function updatingParams({ installDir, exeName, appName, version, baseline, readyFile, logFile = '', relaunch = true, testSeconds = 0, screenshotPath = '' }) {
  return {
    InstallDir: installDir || '',
    ExeName: exeName || 'Tandem.exe',
    AppName: appName || 'Tandem',
    Version: version || '',
    Baseline: Math.max(0, Math.round(baseline || 0)),
    ReadyFile: readyFile || '',
    LogFile: logFile || '',
    NoRelaunch: !relaunch,
    TestSeconds: testSeconds || 0,
    ScreenshotPath: screenshotPath || '',
  };
}

// How the window is started. Not powershell.exe detached: Node starts a
// detached program without a console, and Windows PowerShell then exits at
// once without running the script (that is why the window never showed).
// Not attached either: Tandem's children end with it. So a detached cmd.exe
// runs `start`, which gives PowerShell a console of its own, outside Tandem;
// -WindowStyle Hidden puts that console away. The script's path and settings
// go in environment variables, so cmd never reads them.
function launchSpec({ scriptPath, params, env = process.env }) {
  return {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', '"start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "& $env:TANDEM_UPDATING_SCRIPT""'],
    options: {
      detached: true,
      stdio: 'ignore',
      windowsHide: true, // cmd's own (it has no window); PowerShell's comes from start
      windowsVerbatimArguments: true,
      env: { ...env, TANDEM_UPDATING_SCRIPT: scriptPath, TANDEM_UPDATING_ARGS: JSON.stringify(params) },
    },
  };
}

// Starts the window (never throws).
function startWindow({ scriptPath, params, spawn = require('child_process').spawn, env = process.env, onError = () => {} }) {
  const { command, args, options } = launchSpec({ scriptPath, params, env });
  const child = spawn(command, args, options);
  child.on?.('error', onError);
  child.unref?.();
  return child;
}

// Starts the window; resolves true once it shows (or false after `waitMs`,
// or if it couldn't start). Never throws: an update must not fail over this.
// relaunch: false when Tandem is closing with an update waiting (the
// installer won't open it again); waitMs 0 then, as quitting can't wait.
async function showUpdatingWindow({
  execPath = process.execPath,
  appName = 'Tandem',
  version = '',
  waitMs = 10000,
  relaunch = true,
  preview = false, // a made-up update for a few seconds (⋯ › Preview the update window)
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
    // What happened, kept for the next time something goes wrong (%TEMP%\tandem-updating.log).
    const logFile = path.join(tmpdir, 'tandem-updating.log');
    const note = (text) => {
      try {
        fs.appendFileSync(logFile, `${new Date().toISOString()} [tandem] ${text}\n`);
      } catch {
        // not important
      }
    };
    try {
      if (fs.statSync(logFile).size > 200000) fs.unlinkSync(logFile);
    } catch {
      // none yet
    }
    note(preview ? 'preview: starting the progress window' : `update to ${version || '?'}: starting the progress window`);
    fs.writeFileSync(scriptPath, fs.readFileSync(path.join(__dirname, 'updating.ps1'), 'utf8'));
    try {
      fs.unlinkSync(readyFile);
    } catch {
      // not there
    }
    const params = updatingParams({
      installDir,
      exeName: path.basename(execPath),
      appName,
      version,
      baseline: folderSize(installDir),
      readyFile,
      logFile,
      relaunch,
      testSeconds: preview ? 8 : 0,
    });
    startWindow({
      scriptPath,
      params,
      spawn,
      onError: (err) => {
        note(`could not start the window: ${err?.message || err}`);
        log.warn?.('[updates] progress window', err);
      },
    });
    if (!waitMs) {
      note('started (not waiting: Tandem is closing)');
      return true;
    }
    const until = Date.now() + waitMs;
    while (Date.now() < until) {
      if (fs.existsSync(readyFile)) {
        note(preview ? 'the window is on screen' : 'the window is on screen; quitting into the installer');
        return true;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    note(`the window did not show within ${waitMs} ms; installing anyway`);
    return false;
  } catch (err) {
    log.warn?.('[updates] progress window', err);
    return false;
  }
}

module.exports = { folderSize, updatingParams, launchSpec, startWindow, showUpdatingWindow };
