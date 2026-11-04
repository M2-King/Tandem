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
const { execFileSync } = require('node:child_process');
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
  const rect = await app.evaluate(({ BrowserWindow }) => {
    const b = BrowserWindow.getAllWindows()[0].getContentBounds();
    // The empty editor area, right of the file list and above the results.
    return { x: b.x + Math.round(b.width * 0.35), y: b.y + Math.round(b.height * 0.45), width: 200, height: 120 };
  });
  setWallpaper(20, 60, 200);
  await win.waitForTimeout(1500);
  const blue = screenAverage(rect);
  setWallpaper(230, 120, 30);
  await win.waitForTimeout(1500);
  const orange = screenAverage(rect);
  const delta = Math.round(Math.hypot(blue[0] - orange[0], blue[1] - orange[1], blue[2] - orange[2]));
  console.log(`     ${label}: window colour over blue wallpaper ${blue}, over orange ${orange}, difference ${delta}`);
  return delta;
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
  const win = await app.firstWindow();
  await win.locator('.runtime-status.tone-up').waitFor({ timeout: 90000 });
  check(/^http:\/\/127\.0\.0\.1:\d+\/$/.test(win.url()), 'app window shows the bundled runtime (127.0.0.1 only)');

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
  if (IS_WIN) check(['acrylic', 'mica', 'clear'].includes(probe.material), `window glass: ${probe.material}`);

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
    check(glass.acrylic > 12, 'Frosted glass: the desktop shows through the window');
    console.log(`     Mica ${glass.mica > 12 ? 'follows the wallpaper' : 'did not change with the wallpaper on this machine'}`);
  }

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

  if (IS_WIN) {
    // Clear glass needs a transparent window, created at start.
    const settings = path.join(userData, 'settings.json');
    const saved = JSON.parse(fs.readFileSync(settings, 'utf8'));
    fs.writeFileSync(settings, JSON.stringify({ ...saved, material: 'clear' }));
    const app2 = await electron.launch({
      executablePath: exe,
      args: [`--user-data-dir=${userData}`],
      env: { ...process.env, TANDEM_OPEN_FOLDER: project, TANDEM_CONFIG_DIR: path.join(userData, 'config') },
      timeout: 120000,
    });
    const win2 = await app2.firstWindow();
    await win2.locator('.runtime-status.tone-up').waitFor({ timeout: 90000 });
    check((await win2.evaluate(() => document.documentElement.dataset.material)) === 'clear', 'Clear glass after restart');
    check((await win2.locator('.window-controls button').count()) === 3, 'Clear glass: the app draws the window buttons');
    const delta = await seeThrough(app2, win2, 'Clear');
    check(delta > 12, 'Clear glass: the desktop shows through the window');
    await app2.close();
  }
  console.log('\nAll desktop checks passed.');
})().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
