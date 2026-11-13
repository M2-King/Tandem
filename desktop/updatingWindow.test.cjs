// node --test desktop/updatingWindow.test.cjs
// The "Updating Tandem" window's launcher (updatingWindow.js). The window
// itself (updating.ps1) runs in the Windows workflow, in its test mode.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { folderSize, updatingParams, launchSpec, showUpdatingWindow } = require('./updatingWindow.js');

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

test('the window\'s settings: the script, the app and its size', () => {
  const p = updatingParams({ installDir: 'C:\\T', exeName: 'Tandem Staging.exe', appName: 'Tandem', version: '0.3.1 (build 60)', baseline: 1234.4, readyFile: 'r' });
  assert.equal(p.InstallDir, 'C:\\T');
  assert.equal(p.ExeName, 'Tandem Staging.exe');
  assert.equal(p.AppName, 'Tandem');
  assert.equal(p.Version, '0.3.1 (build 60)');
  assert.equal(p.Baseline, 1234);
  assert.equal(p.NoRelaunch, false);
});

test('started by a detached cmd "start" (a detached PowerShell exits at once), settings in the environment, not on cmd\'s line', () => {
  const { command, args, options } = launchSpec({ scriptPath: 'C:\\Temp 100%\\s.ps1', params: { InstallDir: 'C:\\A & B' }, env: { PATH: 'p' } });
  assert.equal(command, 'cmd.exe');
  assert.equal(args.at(-1), '"start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "& $env:TANDEM_UPDATING_SCRIPT""');
  assert.ok(options.detached && options.windowsVerbatimArguments && options.stdio === 'ignore');
  assert.equal(options.env.PATH, 'p');
  assert.equal(options.env.TANDEM_UPDATING_SCRIPT, 'C:\\Temp 100%\\s.ps1');
  assert.deepEqual(JSON.parse(options.env.TANDEM_UPDATING_ARGS), { InstallDir: 'C:\\A & B' });
  assert.ok(!args.join(' ').includes('Temp 100%'));
});

test('only on Windows', async () => {
  assert.equal(await showUpdatingWindow({ platform: 'darwin' }), false);
});

test('starts the window from a copy outside the app, and waits until it shows', async () => {
  const dir = appDir();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-tmp-'));
  let spawned;
  const settings = () => JSON.parse(spawned.options.env.TANDEM_UPDATING_ARGS);
  const ok = await showUpdatingWindow({
    platform: 'win32',
    execPath: path.join(dir, 'Tandem Staging.exe'),
    appName: 'Tandem',
    version: '0.3.1 (build 60)',
    tmpdir: tmp,
    waitMs: 3000,
    spawn: (cmd, args, options) => {
      spawned = { cmd, args, options };
      setTimeout(() => fs.writeFileSync(settings().ReadyFile, 'shown'), 200);
      return { on() {}, unref() {} };
    },
  });
  assert.equal(ok, true);
  assert.equal(spawned.cmd, 'cmd.exe');
  assert.ok(spawned.options.detached);
  const script = spawned.options.env.TANDEM_UPDATING_SCRIPT;
  assert.equal(path.dirname(script), tmp); // not in the app's folder, which the installer replaces
  assert.ok(fs.readFileSync(script, 'utf8').includes('Updating $AppName'));
  assert.ok(fs.readFileSync(script, 'utf8').includes('$env:TANDEM_UPDATING_ARGS'));
  assert.equal(settings().Baseline, 1234);
  assert.equal(settings().TestSeconds, 0);
  assert.match(fs.readFileSync(path.join(tmp, 'tandem-updating.log'), 'utf8'), /the window is on screen/);
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
  const dir = appDir();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-tmp-'));
  let env;
  const started = Date.now();
  const ok = await showUpdatingWindow({ platform: 'win32', execPath: path.join(dir, 'Tandem.exe'), tmpdir: tmp, waitMs: 0, relaunch: false, spawn: (c, a, o) => ((env = o.env), { on() {}, unref() {} }) });
  assert.equal(ok, true);
  assert.ok(Date.now() - started < 1000);
  assert.equal(JSON.parse(env.TANDEM_UPDATING_ARGS).NoRelaunch, true);
});
