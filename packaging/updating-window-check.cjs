// CI (Windows): the "Updating Tandem" window, started exactly as Tandem starts
// it (desktop/updatingWindow.js: a detached cmd.exe `start`s PowerShell, the
// settings in the environment), through a made-up update. Fails unless the
// window is really on screen, and keeps a capture of the screen where it was.
// (Started any other way, this check once passed while Tandem's own window
// never ran: a detached PowerShell exits at once.)
//
//   node packaging/updating-window-check.cjs <png>

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { updatingParams, startWindow } = require('../desktop/updatingWindow.js');

const png = path.resolve(process.argv[2] || 'updating-window.png');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-updating-check-'));
const scriptPath = path.join(tmp, 'tandem-updating.ps1');
fs.copyFileSync(path.join(__dirname, '..', 'desktop', 'updating.ps1'), scriptPath);
const readyFile = path.join(tmp, 'ready');
const logFile = path.join(tmp, 'updating.log');
const params = updatingParams({ installDir: '', exeName: 'Tandem.exe', appName: 'Tandem', version: '0.3.1 (build 1)', baseline: 0, readyFile, logFile, testSeconds: 6, screenshotPath: png });
const started = Date.now();
let startError = null;
startWindow({ scriptPath, params, onError: (err) => (startError = err) });

const readLog = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '');
(async () => {
  let readyAt = null;
  while (Date.now() - started < 120000 && !/closed:/.test(readLog())) {
    if (readyAt === null && fs.existsSync(readyFile)) readyAt = Date.now() - started;
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 1000)); // the screenshot and the last lines
  const log = readLog();
  console.log((log || '(no log)').replace(/^/gm, '     '));
  let failures = 0;
  const check = (ok, msg) => {
    console.log((ok ? 'ok   ' : 'FAILED: ') + msg);
    if (!ok) failures++;
  };
  check(!startError, `started (${startError ? startError.message : 'cmd start powershell'})`);
  check(/start: app=Tandem/.test(log), 'the script ran (it reads its settings from the environment)');
  check(readyAt !== null && readyAt < 10000, `it said it was on screen within 10 s, as Tandem waits (${readyAt} ms)`);
  check(/shown: visible=True/.test(log), 'the window says it is shown');
  check(/on screen: True/.test(log), 'its colours are really on the screen where it is');
  check(/closed:/.test(log) && !/error:/.test(log), `the window ended by itself, without errors (${Date.now() - started} ms)`);
  check(fs.existsSync(png) && fs.statSync(png).size > 2000, `a capture of the screen where it was (${fs.existsSync(png) ? fs.statSync(png).size : 0} bytes)`);
  process.exit(failures ? 1 : 0);
})();
