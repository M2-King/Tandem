// Temporary: which way of starting desktop/updating.ps1 from Node really runs it.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const src = path.join(__dirname, '..', '..', 'desktop', 'updating.ps1');
const tmp = os.tmpdir();
const script = path.join(tmp, 'tandem-updating.ps1');
fs.writeFileSync(script, fs.readFileSync(src, 'utf8'));
const psArgs = (log, ready) => ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script,
  '-InstallDir', 'C:\\Program Files\\Some Dir', '-AppName', 'Tandem', '-Version', 'a made-up update', '-Baseline', '1000',
  '-ReadyFile', ready, '-LogFile', log, '-TestSeconds', '3'];
const q = (a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

const variants = {
  detachedIgnore: (a) => spawn('powershell.exe', a, { detached: true, stdio: 'ignore', windowsHide: false }),
  detachedFile: (a, err) => { const fd = fs.openSync(err, 'w'); return spawn('powershell.exe', a, { detached: true, stdio: ['ignore', fd, fd], windowsHide: false }); },
  attached: (a) => spawn('powershell.exe', a, { stdio: 'ignore', windowsHide: false }),
  detachedHidden: (a) => spawn('powershell.exe', a, { detached: true, stdio: 'ignore', windowsHide: true }),
  cmdStart: (a) => spawn('cmd.exe', ['/d', '/s', '/c', `"start "" powershell.exe ${a.map(q).join(' ')}"`], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }),
  conhost: (a) => spawn('conhost.exe', ['powershell.exe', ...a], { detached: true, stdio: 'ignore', windowsHide: false }),
};

(async () => {
  for (const [name, start] of Object.entries(variants)) {
    const log = path.join(tmp, `exp-${name}.log`), ready = path.join(tmp, `exp-${name}.ready`), err = path.join(tmp, `exp-${name}.err`);
    for (const f of [log, ready, err]) try { fs.unlinkSync(f); } catch {}
    const t0 = Date.now();
    let exit = 'running';
    const child = start(psArgs(log, ready), err);
    child.on('exit', (c, s) => (exit = `exit ${c} ${s || ''} after ${Date.now() - t0} ms`));
    child.on('error', (e) => (exit = `error ${e.message}`));
    let readyAt = null;
    while (Date.now() - t0 < 15000) {
      if (!readyAt && fs.existsSync(ready)) readyAt = Date.now() - t0;
      await new Promise((r) => setTimeout(r, 100));
    }
    console.log(`=== ${name}: ready ${readyAt === null ? 'NEVER' : readyAt + ' ms'}; ${exit}`);
    for (const f of [log, err]) if (fs.existsSync(f)) console.log(fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => '   ' + l).join('\n'));
  }
})();
