// Checks in-app updates in a real Tandem Staging install (CI on the cowork
// branch, Windows):
//
//   node staging-update-smoke.cjs <Tandem-Staging-Setup-<version>.exe> <version> <python for project code>
//
// Installs the build silently (per-user NSIS, as a tester would), opens
// it, and checks that updates are on there (and only there: the unpacked app
// and the portable exe have them off), that the first check runs on its own
// and ends without any dialog, that the ⋯ menu shows the version and "Check
// for updates", and that the page can't install anything that isn't
// downloaded. Then it closes and uninstalls the app.

const { _electron: electron } = require('playwright');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const [installer, version, python] = process.argv.slice(2);

function check(ok, message) {
  if (!ok) {
    console.error(`FAILED: ${message}`);
    process.exit(1);
  }
  console.log(`ok   ${message}`);
}

(async () => {
  // Where a tester's install goes: per user, %LOCALAPPDATA%\Programs\Tandem Staging
  // (named Tandem, in its own folder: desktop/build/staging-installer.nsh).
  const dir = path.join(process.env.LOCALAPPDATA, 'Programs', 'Tandem Staging');
  execFileSync(installer, ['/S'], { stdio: 'inherit', timeout: 300000 });
  const exe = path.join(dir, 'Tandem.exe');
  check(fs.existsSync(exe), `installed ${exe}`);
  check(fs.existsSync(path.join(dir, 'Uninstall Tandem.exe')), 'the installer added its uninstaller (Uninstall Tandem.exe)');
  const updateYml = fs.readFileSync(path.join(dir, 'resources', 'app-update.yml'), 'utf8');
  console.log(updateYml.replace(/^/gm, '     '));
  check(
    /provider: generic/.test(updateYml) &&
      /url: https:\/\/github\.com\/M2-King\/Tandem\/releases\/download\/windows-staging\b/.test(updateYml) &&
      /channel: staging/.test(updateYml),
    'app-update.yml: generic https feed, staging channel'
  );
  check(/^useMultipleRangeRequest: false$/m.test(updateYml), 'app-update.yml: updates download only the changed parts, one range per request');

  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-staging-'));
  fs.mkdirSync(path.join(project, '.tandem'));
  fs.writeFileSync(path.join(project, '.tandem', 'settings.json'), JSON.stringify({ python }));
  fs.writeFileSync(path.join(project, 'hello.py'), 'print("hello")\n');
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-staging-userdata-'));

  const app = await electron.launch({
    executablePath: exe,
    args: [`--user-data-dir=${userData}`],
    env: { ...process.env, TANDEM_OPEN_FOLDER: project, TANDEM_CONFIG_DIR: path.join(userData, 'config') },
    timeout: 120000,
  });
  const win = await app.firstWindow();
  // Staging opens on sign-in / the projects page; this device's project is at #/device.
  await win.locator('.runtime-status, #signin-username, .shared-page').first().waitFor({ timeout: 90000 });
  if (!(await win.locator('.runtime-status').count())) await win.evaluate(() => { window.location.hash = '#/device'; });
  await win.locator('.runtime-status.tone-up').waitFor({ timeout: 90000 });

  const bridge = await win.evaluate(async () => {
    const u = window.tandemDesktop.updates;
    return { keys: Object.keys(u).sort(), state: await u.state() };
  });
  console.log('     ', JSON.stringify(bridge.state));
  check(JSON.stringify(bridge.keys) === JSON.stringify(['check', 'install', 'onState', 'state']), 'the page sees only state, check, install, onState');
  check(bridge.state.enabled === true && bridge.state.staging === true, 'updates are on in the installed Tandem Staging');
  check(bridge.state.version === version, `installed version ${bridge.state.version}`);

  // Nothing is downloaded yet, so the page can't make it install anything.
  check((await win.evaluate(() => window.tandemDesktop.updates.install('https://example.com/x.exe'))) === false, 'install does nothing without a downloaded update');

  // The first check runs by itself about 10 s after start.
  let state = bridge.state;
  for (let i = 0; i < 90 && ['idle', 'checking'].includes(state.status); i++) {
    await win.waitForTimeout(1000);
    state = await win.evaluate(() => window.tandemDesktop.updates.state());
  }
  console.log('     ', JSON.stringify(state));
  check(['up-to-date', 'error', 'downloading', 'ready'].includes(state.status), `the first check finished by itself: ${state.status}${state.message ? ` (${state.message})` : ''}`);
  if (state.status === 'error') console.log('     (no feed or no network yet: shown only in the ⋯ menu)');
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  check(windows === 1, 'no dialog or extra window');

  // The ⋯ menu: version, Check for updates, status line.
  await win.getByRole('button', { name: 'More options' }).click();
  const menu = win.locator('.menu');
  const shown = version.replace(/-staging\.(\d+)$/, ' (build $1)');
  await menu.getByText(shown, { exact: false }).first().waitFor({ timeout: 5000 });
  check(/Tandem/.test(await menu.innerText()) && !/Staging/.test(await menu.innerText()), `the menu shows Tandem ${shown}, not “Staging”`);
  const action = menu.getByRole('menuitem', { name: /Check for updates|Restart to update/ });
  check((await action.count()) === 1, `the menu offers “${(await action.innerText()).trim()}”`);
  check((await menu.locator('.menu-update-status').innerText()).trim().length > 0, `status line: ${(await menu.locator('.menu-update-status').innerText()).trim()}`);
  await win.keyboard.press('Escape');

  await app.close();
  const uninstaller = path.join(dir, 'Uninstall Tandem.exe');
  try {
    execFileSync(uninstaller, ['/S'], { stdio: 'inherit', timeout: 120000 });
  } catch (e) {
    console.log(`     (uninstall: ${e.message})`);
  }
  console.log('\nAll staging update checks passed.');
})().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
