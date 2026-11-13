// Temporary: the app's launcher (preview, as ⋯ › Preview the update window does).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { showUpdatingWindow } = require('../../desktop/updatingWindow.js');
(async () => {
  const t0 = Date.now();
  const ok = await showUpdatingWindow({ execPath: 'C:\\Program Files\\Some & Dir 100%\\Tandem.exe', version: 'a made-up update', preview: true, waitMs: 8000 });
  console.log(`preview shown: ${ok} after ${Date.now() - t0} ms`);
  await new Promise((r) => setTimeout(r, 11000));
  console.log(fs.readFileSync(path.join(os.tmpdir(), 'tandem-updating.log'), 'utf8'));
  process.exit(ok ? 0 : 1);
})();
