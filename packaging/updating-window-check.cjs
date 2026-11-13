// CI (Windows): the "Updating Tandem" window, started exactly as Tandem starts
// it (desktop/updatingWindow.js: powershell.exe, hidden console, detached
// arguments), through a made-up update. Fails unless the window is really on
// screen (Windows applies "hidden" to a program's first window, which once
// left it invisible), and keeps a capture of the screen where it was.
//
//   node packaging/updating-window-check.cjs <png>

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { updatingArgs } = require('../desktop/updatingWindow.js');

const png = path.resolve(process.argv[2] || 'updating-window.png');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-updating-check-'));
const scriptPath = path.join(tmp, 'tandem-updating.ps1');
fs.copyFileSync(path.join(__dirname, '..', 'desktop', 'updating.ps1'), scriptPath);
const readyFile = path.join(tmp, 'ready');
const logFile = path.join(tmp, 'updating.log');
const args = [
  ...updatingArgs({ scriptPath, installDir: '', exeName: 'Tandem.exe', appName: 'Tandem', version: '0.3.1 (build 1)', baseline: 0, readyFile, logFile }),
  '-TestSeconds',
  '6',
  '-ScreenshotPath',
  png,
];
const started = Date.now();
const child = spawn('powershell.exe', args, { stdio: 'inherit', windowsHide: false });
const timer = setTimeout(() => {
  console.log('FAILED: the window did not end by itself');
  child.kill();
}, 120000);
child.on('exit', (code) => {
  clearTimeout(timer);
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '(no log)';
  console.log(log.replace(/^/gm, '     '));
  let failures = 0;
  const check = (ok, msg) => {
    console.log((ok ? 'ok   ' : 'FAILED: ') + msg);
    if (!ok) failures++;
  };
  check(code === 0, `the window ended by itself (exit code ${code}, ${Date.now() - started} ms)`);
  check(fs.existsSync(readyFile), 'it said it was on screen (Tandem quits only then)');
  check(/shown: visible=True/.test(log), 'the window says it is shown');
  check(/on screen: True/.test(log), 'its colours are really on the screen where it is');
  check(fs.existsSync(png) && fs.statSync(png).size > 2000, `a capture of the screen where it was (${fs.existsSync(png) ? fs.statSync(png).size : 0} bytes)`);
  process.exit(failures ? 1 : 0);
});
