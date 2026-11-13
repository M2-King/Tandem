// End-to-end check of the packaged Tandem desktop app.
//
//   node desktop-smoke.cjs <path to Tandem.exe (or the unpacked app binary)> <python for project code> [screenshot.png]
//
// Opens a temporary project in the real app, checks the window has no wallpaper
// of its own (the desktop shows through), that the page has no Node access and
// can't navigate away, runs the acceptance script, and checks the bundled Python
// runtime stops when the app closes. On Windows it also saves a screenshot of
// the whole screen, so the system glass can be seen over the desktop.

const { _electron: electron } = require('playwright');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const [exe, python, screenshot] = process.argv.slice(2);
const IS_WIN = process.platform === 'win32';

function check(ok, message) {
  if (!ok) {
    console.error(`FAILED: ${message}`);
    process.exit(1);
  }
  console.log(`ok   ${message}`);
}

function runtimeProcesses() {
  try {
    if (IS_WIN) {
      return execFileSync('tasklist', ['/FI', 'IMAGENAME eq tandem-runtime.exe', '/NH'], { encoding: 'utf8' })
        .split('\n')
        .filter((l) => l.toLowerCase().includes('tandem-runtime.exe')).length;
    }
    return execFileSync('sh', ['-c', 'ps -eo args | grep "tandem-runtime serve" | grep -v grep || true'], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean).length;
  } catch {
    return 0;
  }
}

function screenCapture(file) {
  // The whole screen, scaled to 1280 px wide, as JPEG.
  const ps = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$full = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($full)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$w = 1280; $h = [int]($b.Height * $w / $b.Width)
$small = New-Object System.Drawing.Bitmap $w, $h
$g2 = [System.Drawing.Graphics]::FromImage($small)
$g2.InterpolationMode = 'HighQualityBicubic'
$g2.DrawImage($full, 0, 0, $w, $h)
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$p = New-Object System.Drawing.Imaging.EncoderParameters 1
$p.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 70L
$small.Save('${file.replace(/'/g, "''")}', $codec, $p)
"$($b.Width)x$($b.Height)"`;
  return execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim();
}

// Average colour of a screen rectangle (Windows), as [r, g, b].
function screenAverage(rect) {
  const ps = `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap ${rect.width}, ${rect.height}
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(${rect.x}, ${rect.y}, 0, 0, $bmp.Size)
$r = 0; $gr = 0; $b = 0; $n = 0
for ($x = 0; $x -lt $bmp.Width; $x += 8) { for ($y = 0; $y -lt $bmp.Height; $y += 8) {
  $c = $bmp.GetPixel($x, $y); $r += $c.R; $gr += $c.G; $b += $c.B; $n++ } }
"$([int]($r / $n)) $([int]($gr / $n)) $([int]($b / $n))"`;
  return execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim().split(' ').map(Number);
}

function setWallpaper(r, g, b) {
  const ps = `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap 1920, 1080
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$gfx.Clear([System.Drawing.Color]::FromArgb(255, ${r}, ${g}, ${b}))
$file = Join-Path $env:TEMP "tandem-wall-${r}-${g}-${b}.bmp"
$bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Bmp)
Add-Type -Namespace Win32 -Name Desk2 -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool SystemParametersInfo(int a, int b, string c, int d);'
[Win32.Desk2]::SystemParametersInfo(20, 0, $file, 3) | Out-Null`;
  execFileSync('powershell', ['-NoProfile', '-Command', ps]);
}

// Does the desktop show through the window? Compare the window's colour over a
// blue and an orange wallpaper: an opaque window looks the same over both.
async function seeThrough(app, win, label) {
  const rects = await app.evaluate(({ BrowserWindow }) => {
    const b = BrowserWindow.getAllWindows()[0].getBounds();
    return {
      // Control: bare desktop just left of the window. If this doesn't change,
      // the wallpaper didn't change on this machine and the test says nothing.
      desktop: { x: Math.max(0, b.x - 50), y: b.y + 100, width: 40, height: 200 },
      // The empty editor area, right of the file list and above the results.
      editor: { x: b.x + Math.round(b.width * 0.35), y: b.y + Math.round(b.height * 0.45), width: 200, height: 120 },
    };
  });
  const measure = () => ({ desktop: screenAverage(rects.desktop), editor: screenAverage(rects.editor) });
  const diff = (a, b) => Math.round(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
  setWallpaper(20, 60, 200);
  await win.waitForTimeout(2000);
  const blue = measure();
  setWallpaper(230, 120, 30);
  await win.waitForTimeout(2000);
  const orange = measure();
  const result = { desktop: diff(blue.desktop, orange.desktop), window: diff(blue.editor, orange.editor) };
  console.log(`     ${label}: desktop ${blue.desktop} -> ${orange.desktop} (change ${result.desktop}); ` +
    `inside the window ${blue.editor} -> ${orange.editor} (change ${result.window})`);
  return result;
}

// Staging builds open on sign-in / the projects page (VITE_COWORK_START=shared);
// this device's project is then at #/device. Waits for its runtime to be up.
async function deviceProject(w, timeout) {
  await w.locator('.runtime-status, #signin-username, .shared-page').first().waitFor({ timeout });
  if (!(await w.locator('.runtime-status').count())) {
    console.log('     starts on the projects page; opening this device’s project');
    await w.evaluate(() => { window.location.hash = '#/device'; });
  }
  await w.locator('.runtime-status.tone-up').waitFor({ timeout });
}

(async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-desktop-'));
  fs.mkdirSync(path.join(project, '.tandem'));
  fs.writeFileSync(path.join(project, '.tandem', 'settings.json'), JSON.stringify({ python }));
  fs.writeFileSync(
    path.join(project, 'check.py'),
    'import numpy as np\nimport pandas as pd\nimport matplotlib.pyplot as plt\n' +
      'data = pd.DataFrame({\n    "x": np.arange(1, 6),\n    "y": [2, 4, 6, 8, 10]\n})\n' +
      'print(data)\nplt.plot(data["x"], data["y"])\nplt.title("Runtime Test")\nplt.show()\n'
  );
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-userdata-'));

  const app = await electron.launch({
    executablePath: exe,
    args: [`--user-data-dir=${userData}`, ...(IS_WIN ? [] : ['--no-sandbox'])],
    env: { ...process.env, TANDEM_OPEN_FOLDER: project, TANDEM_CONFIG_DIR: path.join(userData, 'config') },
    timeout: 120000,
  });
  let win = await app.firstWindow();
  await deviceProject(win, 90000);
  check(/^http:\/\/127\.0\.0\.1:\d+\/(#\/device)?$/.test(win.url()), 'app window shows the bundled runtime (127.0.0.1 only)');

  const probe = await win.evaluate(() => ({
    shell: document.documentElement.dataset.shell,
    material: document.documentElement.dataset.material,
    wallpaper: getComputedStyle(document.body, '::before').display,
    background: getComputedStyle(document.documentElement).backgroundColor,
    node: typeof require + '/' + typeof process,
  }));
  console.log('     ', JSON.stringify(probe));
  check(probe.shell === 'desktop', 'desktop mode is on');
  check(probe.wallpaper === 'none' && probe.background === 'rgba(0, 0, 0, 0)', 'the app draws no wallpaper: the desktop shows behind it');
  check(probe.node === 'undefined/undefined', 'the page has no Node access');
  // Updates: the bridge offers only state/check/install/onState, and they are
  // off here (this unpacked app wasn't installed by the installer).
  const updates = await win.evaluate(async () => {
    const u = window.tandemDesktop.updates;
    return { keys: Object.keys(u).sort(), state: await u.state() };
  });
  console.log('     updates:', JSON.stringify(updates.state));
  check(JSON.stringify(updates.keys) === JSON.stringify(['check', 'install', 'onState', 'preview', 'state']), 'update bridge: state, check, install, onState, preview only');
  check(updates.state.enabled === false && updates.state.status === 'off', 'updates are off in the unpacked app');
  if (IS_WIN) check(['acrylic', 'mica', 'clear'].includes(probe.material), `window glass: ${probe.material}`);

  // Tandem's own layers must be see-through, whatever the system then does.
  await win.waitForTimeout(800);
  const page = await app.evaluate(async ({ app: electronApp, BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    const img = await w.webContents.capturePage();
    const { width, height } = img.getSize();
    const bmp = img.toBitmap();
    const alpha = (fx, fy) => bmp[(Math.round(height * fy) * width + Math.round(width * fx)) * 4 + 3];
    return {
      alpha: { toolbar: alpha(0.5, 0.02), editor: alpha(0.4, 0.5), panel: alpha(0.08, 0.8) },
      gpu: electronApp.getGPUFeatureStatus(),
    };
  });
  console.log(`     page opacity (0-255): ${JSON.stringify(page.alpha)}; gpu compositing: ${page.gpu.gpu_compositing}`);
  check(page.alpha.toolbar < 200 && page.alpha.panel < 230 && page.alpha.editor < 240,
    'Tandem\'s glass layers are see-through');

  if (IS_WIN && screenshot) {
    // Leave a margin of desktop around the window, so the screenshot shows the
    // wallpaper both around and through the glass.
    const size = await app.evaluate(({ BrowserWindow, screen }) => {
      const area = screen.getPrimaryDisplay().workArea;
      const w = BrowserWindow.getAllWindows()[0];
      w.setBounds({ x: area.x + 60, y: area.y + 40, width: area.width - 120, height: area.height - 80 });
      w.focus();
      return `${area.width}x${area.height}`;
    });
    await win.waitForTimeout(1500);
    console.log(`     work area ${size}; screenshot ${screenCapture(path.resolve(screenshot))}`);
  }

  // On a small screen Tandem folds the file list away; open it first.
  const file = win.getByRole('treeitem', { name: 'check.py' });
  if (!(await file.isVisible())) await win.getByRole('button', { name: 'Show files' }).first().click();
  await file.click();
  await win.getByRole('button', { name: 'Run', exact: true }).click();
  await win.getByText('   x   y').first().waitFor({ timeout: 90000 });
  await win.getByRole('tab', { name: /Charts/ }).click();
  await win.locator('.figure-image').first().waitFor({ timeout: 15000 });
  check(true, 'acceptance script ran in the app: DataFrame printed, chart shown');

  if (IS_WIN && probe.material !== 'clear') {
    await win.getByRole('tab', { name: /Output/ }).click().catch(() => {});
    const glass = {};
    for (const material of ['acrylic', 'mica']) {
      await win.evaluate((m) => window.tandemDesktop.setMaterial(m), material);
      await win.waitForTimeout(800);
      glass[material] = await seeThrough(app, win, material === 'acrylic' ? 'Frosted (acrylic)' : 'Mica');
    }
    await win.evaluate(() => window.tandemDesktop.setMaterial('acrylic'));
    console.log(`SEE-THROUGH acrylic=${JSON.stringify(glass.acrylic)} mica=${JSON.stringify(glass.mica)}`);
  }

  if (IS_WIN && probe.material !== 'clear') {
    // Switching to Clear and back happens live: a new window replaces the old
    // one in the same place, with no restart.
    let current = win;
    for (const material of ['clear', 'acrylic']) {
      const next = app.waitForEvent('window', { timeout: 30000 });
      await current.evaluate((m) => window.tandemDesktop.setMaterial(m), material);
      current = await next;
      await deviceProject(current, 60000);
      const shown = await current.evaluate(() => document.documentElement.dataset.material);
      const buttons = await current.locator('.window-controls button').count();
      const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
      check(shown === material && windows === 1 && (material === 'clear') === (buttons === 3),
        `switched to ${material} without restarting (one window${material === 'clear' ? ', app window buttons' : ''})`);
      if (material === 'clear') {
        const delta = await seeThrough(app, current, 'Clear');
        console.log(`SEE-THROUGH clear=${JSON.stringify(delta)}`);
      }
    }
    win = current;
  }

  // The Terminal (Ctrl+`): a real shell (ConPTY on Windows, a pty elsewhere)
  // from the bundled runtime, in the project folder, the project's Python first.
  await win.keyboard.press('Control+Backquote');
  await win.locator('.terminal-view .xterm').waitFor({ timeout: 60000 });
  await win.waitForFunction(() => /tandem-desktop-/.test(document.querySelector('.terminal-note')?.innerText || ''), null, { timeout: 60000 });
  await win.waitForTimeout(1500); // the shell's prompt
  await win.locator('.terminal-view .xterm').click();
  await win.keyboard.type('python -c "import sys; print(\'TERM\' + \'-OK \' + sys.executable)"');
  await win.keyboard.press('Enter');
  const termOk = await win
    .waitForFunction(() => /TERM-OK \S/.test((document.querySelector('.terminal-view .xterm-rows')?.innerText || '').replace(/\u00a0/g, ' ')), null, { timeout: 60000 })
    .then(() => true, () => false);
  const termText = (await win.evaluate(() => document.querySelector('.terminal-view .xterm-rows')?.innerText || '')).replace(/\u00a0/g, ' ');
  const termPython = /TERM-OK (\S.*)/.exec(termText)?.[1]?.trim();
  if (!termOk) console.log(termText.slice(-1500));
  check(termOk && !!termPython && path.dirname(termPython).toLowerCase() === path.dirname(python).toLowerCase(),
    `Terminal: a shell in the project, the project's Python first on PATH (${termPython})`);
  await win.getByRole('tab', { name: 'Output' }).click();

  // "Open with Tandem" while Tandem is open: Windows starts a second Tandem
  // with the file, which hands it to the open one and exits.
  const activeTab = (w) => w.locator('.tab.is-active').innerText().then((t) => t.trim());
  fs.mkdirSync(path.join(project, 'sql'));
  fs.writeFileSync(path.join(project, 'sql', 'later.sql'), 'SELECT 1;\n');
  const second = spawn(exe, [`--user-data-dir=${userData}`, ...(IS_WIN ? [] : ['--no-sandbox']), path.join(project, 'sql', 'later.sql')],
    { stdio: 'ignore' });
  const secondExit = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('still running'), 30000);
    second.on('exit', (code) => (clearTimeout(timer), resolve(code)));
  });
  console.log(`     second start exited: ${secondExit}`);
  await win.waitForFunction(() => document.querySelector('.tab.is-active')?.innerText.trim() === 'later.sql', null, { timeout: 30000 });
  const sqlMode = await win.getByRole('radio', { name: 'SQL', checked: true }).count();
  check(secondExit === 0 && sqlMode === 1, 'Open with: a file sent to the open app shows in its tab (SQL workspace), the second start exits');

  const href = await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    await w.webContents.executeJavaScript("location.href = 'https://example.com/'; 1");
    await new Promise((r) => setTimeout(r, 1000));
    return w.webContents.getURL();
  });
  check(/^http:\/\/127\.0\.0\.1:/.test(href), 'navigation away from Tandem is blocked');

  check(runtimeProcesses() > 0, 'bundled Python runtime is running');
  await app.close();
  let left = 1;
  for (let i = 0; i < 20 && left; i++) {
    await new Promise((r) => setTimeout(r, 500));
    left = runtimeProcesses();
  }
  check(left === 0, 'closing the app stops the runtime');

  // "Open with Tandem" when Tandem isn't running: a file outside the last
  // project opens with its own folder as the project.
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-downloads-'));
  const notebook = path.join(elsewhere, 'student_notebook.ipynb');
  fs.writeFileSync(notebook, JSON.stringify({
    cells: [{ cell_type: 'code', id: 'c1', metadata: {}, source: ['x = 41\n', 'print(x + 1)'], outputs: [], execution_count: null }],
    metadata: {}, nbformat: 4, nbformat_minor: 5,
  }));
  const cold = await electron.launch({
    executablePath: exe,
    args: [`--user-data-dir=${userData}`, ...(IS_WIN ? [] : ['--no-sandbox']), notebook],
    env: { ...process.env, TANDEM_OPEN_FOLDER: project, TANDEM_CONFIG_DIR: path.join(userData, 'config') },
    timeout: 120000,
  });
  const coldWin = await cold.firstWindow();
  await coldWin.locator('.runtime-status.tone-up').waitFor({ timeout: 90000 });
  await coldWin.waitForFunction(() => document.querySelector('.tab.is-active')?.innerText.trim() === 'student_notebook.ipynb', null, { timeout: 30000 });
  await coldWin.locator('.nb-cell').first().waitFor({ timeout: 15000 });
  const folder = await cold.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getURL());
  const shownProject = await coldWin.locator('.toolbar').innerText();
  check(shownProject.includes(path.basename(elsewhere)) && !folder.includes('?open='),
    'Open with: starting Tandem with a notebook opens it, with its folder as the project');
  await cold.close();

  console.log('\nAll desktop checks passed.');
})().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
