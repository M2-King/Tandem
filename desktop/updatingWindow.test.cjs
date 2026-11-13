// node --test desktop/updatingWindow.test.cjs
// The "Updating Tandem" window's launcher (updatingWindow.js). The window
// itself (updating.ps1) runs in the Windows workflow, in its test mode.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { folderSize, updatingArgs, showUpdatingWindow } = require('./updatingWindow.js');

const appDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-app-'));
  fs.mkdirSync(path.join(d, 'resources', 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(d, 'Tandem Staging.exe'), Buffer.alloc(1000));
  fs.writeFileSync(path.join(d, 'resources', 'runtime', 'python.dll'), Buffer.alloc(234));
  return d;
};
const quiet = { warn() {} };

test('folder size: every file, in every folder', () => {
  assert.equal(folderSize(appDir()), 1234);
  assert.equal(folderSize(path.join(os.tmpdir(), 'no-such-folder-tandem')), 0);
});

test('powershell arguments: hidden console, the script, the app and its size', () => {
  const args = updatingArgs({ scriptPath: 's.ps1', installDir: 'C:\\T', exeName: 'Tandem Staging.exe', appName: 'Tandem', version: '0.3.1 (build 60)', baseline: 1234.4, readyFile: 'r' });
  assert.deepEqual(args.slice(0, 7), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', 's.ps1']);
  const value = (name) => args[args.indexOf(name) + 1];
  assert.equal(value('-InstallDir'), 'C:\\T');
  assert.equal(value('-ExeName'), 'Tandem Staging.exe');
  assert.equal(value('-AppName'), 'Tandem');
  assert.equal(value('-Version'), '0.3.1 (build 60)');
  assert.equal(value('-Baseline'), '1234');
});

test('only on Windows', async () => {
  assert.equal(await showUpdatingWindow({ platform: 'darwin' }), false);
});

test('starts the window detached (console hidden by -WindowStyle, not windowsHide), from a copy outside the app, and waits until it shows', async () => {
  const dir = appDir();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-tmp-'));
  let spawned;
  const ok = await showUpdatingWindow({
    platform: 'win32',
    execPath: path.join(dir, 'Tandem Staging.exe'),
    appName: 'Tandem',
    version: '0.3.1 (build 60)',
    tmpdir: tmp,
    waitMs: 3000,
    spawn: (cmd, args, options) => {
      spawned = { cmd, args, options };
      setTimeout(() => fs.writeFileSync(args[args.indexOf('-ReadyFile') + 1], 'shown'), 200);
      return { on() {}, unref() {} };
    },
  });
  assert.equal(ok, true);
  assert.equal(spawned.cmd, 'powershell.exe');
  assert.ok(spawned.options.detached && spawned.options.windowsHide === false && spawned.options.stdio === 'ignore'); // not hidden: Windows would hide the window too
  const script = spawned.args[spawned.args.indexOf('-File') + 1];
  assert.equal(path.dirname(script), tmp); // not in the app's folder, which the installer replaces
  assert.ok(fs.readFileSync(script, 'utf8').includes('Updating $AppName'));
  assert.equal(spawned.args[spawned.args.indexOf('-Baseline') + 1], '1234');
});

test('never holds up or breaks the update', async () => {
  const dir = appDir();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-tmp-'));
  const execPath = path.join(dir, 'Tandem Staging.exe');
  const started = Date.now();
  assert.equal(await showUpdatingWindow({ platform: 'win32', execPath, tmpdir: tmp, waitMs: 300, spawn: () => ({ on() {}, unref() {} }) }), false);
  assert.ok(Date.now() - started < 2000);
  const failing = () => {
    throw new Error('no powershell');
  };
  assert.equal(await showUpdatingWindow({ platform: 'win32', execPath, tmpdir: tmp, waitMs: 300, spawn: failing, log: quiet }), false);
});

test('the window script is plain ASCII (Windows PowerShell 5.1 reads it as ANSI)', () => {
  const text = fs.readFileSync(path.join(__dirname, 'updating.ps1'), 'utf8');
  assert.ok(![...text].some((c) => c.charCodeAt(0) > 127));
});

test('closing with an update waiting: -NoRelaunch, and no waiting for the window', async () => {
  assert.ok(updatingArgs({ scriptPath: 's', installDir: 'd', exeName: 'T.exe', appName: 'Tandem', relaunch: false }).includes('-NoRelaunch'));
  assert.ok(!updatingArgs({ scriptPath: 's', installDir: 'd', exeName: 'T.exe', appName: 'Tandem' }).includes('-NoRelaunch'));
  const dir = appDir();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-tmp-'));
  let args;
  const started = Date.now();
  const ok = await showUpdatingWindow({ platform: 'win32', execPath: path.join(dir, 'Tandem.exe'), tmpdir: tmp, waitMs: 0, relaunch: false, spawn: (c, a) => ((args = a), { on() {}, unref() {} }) });
  assert.equal(ok, true);
  assert.ok(Date.now() - started < 1000);
  assert.ok(args.includes('-NoRelaunch'));
});
