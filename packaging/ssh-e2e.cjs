// End-to-end check of projects on an SSH server in the Tandem desktop app.
//
//   node packaging/ssh-e2e.cjs <app: Tandem executable, or the desktop/ folder to run with Electron> <screenshot dir>
//
// Environment:
//   SSH_HOST, SSH_PORT, SSH_USER         a test server (Linux or macOS) with sshd
//   SSH_PASSWORD                         that user's password
//   SSH_KEY                              a private key file the server accepts (no passphrase)
//   SSH_FOLDER                           a project folder there (main.py imports helper.py; a .venv with ipykernel)
//   SSH_FINGERPRINT                      the server's host key, SHA256:… (what the first connection must show)
//   DEVICE_PROJECT                       a project folder on this computer
//   TANDEM_RUNTIME, TANDEM_UI, TANDEM_REMOTE_DIR   for the unpackaged app (desktop/ with Electron)
//
// Checks: first connection shows the host key and connects only once it's
// trusted; Tandem installs and starts on the server; the window shows the
// server; Run, Step through, a notebook cell and the Terminal run there;
// the assistant and Shared projects aren't offered; Disconnect returns to
// this computer's project and Tandem stops on the server; a second
// connection with the SSH key needs no confirmation; a changed host key is
// refused.

const { _electron: electron } = require('playwright');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const [appPath, out] = process.argv.slice(2);
const E = process.env;
const IS_LINUX = process.platform === 'linux';
let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? 'ok  ' : 'FAILED:'} ${msg}`);
  if (!ok) failures++;
};

// Tandem processes running on the server for this user.
function serverRuntimes() {
  const args = ['-o', 'BatchMode=yes', '-o', 'LogLevel=ERROR', '-o', 'StrictHostKeyChecking=no', '-o', `UserKnownHostsFile=${os.devNull}`, '-i', E.SSH_KEY, '-p', E.SSH_PORT, `${E.SSH_USER}@${E.SSH_HOST}`, 'ps -u "$(id -u)" -o args= | grep -c "[t]andem serve" || true'];
  try {
    return Number(execFileSync('ssh', args, { encoding: 'utf8' }).trim()) || 0;
  } catch {
    return -1;
  }
}

async function launch(userData) {
  const isDir = fs.statSync(appPath).isDirectory();
  return electron.launch({
    executablePath: isDir ? require(path.join(appPath, 'node_modules', 'electron')) : appPath,
    args: [...(isDir ? [appPath] : []), `--user-data-dir=${userData}`, ...(IS_LINUX ? ['--no-sandbox'] : [])],
    env: { ...process.env, TANDEM_OPEN_FOLDER: E.DEVICE_PROJECT },
    timeout: 120000,
  });
}

async function openConnectWindow(app, win) {
  await win.getByRole('button', { name: 'More options' }).click();
  const [connect] = await Promise.all([app.waitForEvent('window'), win.getByRole('menuitem', { name: /Connect to SSH server/ }).click()]);
  await connect.waitForLoadState('domcontentloaded');
  await connect.locator('#host').waitFor();
  return connect;
}

async function fillTarget(connect) {
  await connect.locator('#host').fill(E.SSH_HOST);
  await connect.locator('#port').fill(String(E.SSH_PORT));
  await connect.locator('#username').fill(E.SSH_USER);
  await connect.locator('#folder').fill(E.SSH_FOLDER);
}

// This computer's project: the runtime is connected (whether or not it found a Python here).
const DEVICE_READY = '.runtime-status.tone-up, .runtime-status.tone-warn';
const editorText = (p) => p.evaluate(() => document.querySelector('.output-lines')?.innerText || '');

(async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-ssh-e2e-'));
  const app = await launch(userData);
  let win = await app.firstWindow();
  await win.locator(DEVICE_READY).first().waitFor({ timeout: 90000 });
  check(true, 'the app opened this computer’s project');

  // ---- first connection: password, host key confirmed
  let connect = await openConnectWindow(app, win);
  await fillTarget(connect);
  await connect.locator('#password').fill(E.SSH_PASSWORD);
  await connect.locator('#connect').click();
  await connect.locator('#hostkey').waitFor({ state: 'visible', timeout: 30000 });
  const shown = (await connect.locator('#hk-fp').innerText()).trim();
  check(shown === E.SSH_FINGERPRINT, `first connection shows the server’s key: ${shown}`);
  await connect.screenshot({ path: path.join(out, 'ssh-1-host-key.png') });
  await connect.locator('#hk-yes').click();
  const t0 = Date.now();
  await win.locator('.remote-chip').waitFor({ timeout: 300000 });
  check(true, `connected; Tandem installed and started on the server (${Math.round((Date.now() - t0) / 1000)} s)`);
  await win.locator('.runtime-status.tone-up').waitFor({ timeout: 60000 });
  const chip = (await win.locator('.remote-chip').innerText()).trim();
  check(chip === `${E.SSH_USER}@${E.SSH_HOST}${E.SSH_PORT !== '22' ? `:${E.SSH_PORT}` : ''}`, `the window shows the server: ${chip}`);
  check(serverRuntimes() === 1, 'one Tandem runtime runs on the server');
  const pagePassword = await win.evaluate((pw) => document.documentElement.outerHTML.includes(pw), E.SSH_PASSWORD);
  check(!pagePassword, 'the password never reached the Tandem page');

  // Run: a script that imports another file of the server's project.
  await win.locator('.file-sidebar, .sidebar').getByText('main.py', { exact: true }).first().click();
  await win.locator('.run-control .split-main').click();
  await win.waitForFunction(() => /from the server/.test(document.querySelector('.output-lines')?.innerText || ''), null, { timeout: 90000 });
  check(true, `Run on the server: ${(await editorText(win)).trim().split('\n').pop()}`);
  await win.screenshot({ path: path.join(out, 'ssh-2-run.png') });

  // Step through.
  await win.locator('.run-control .split-toggle').click();
  await win.getByRole('menuitem', { name: /Step through/ }).click();
  await win.waitForFunction(() => /Next line: 1\b/.test(document.querySelector('.banner-session')?.innerText || ''), null, { timeout: 60000 });
  check(true, 'Step through pauses on line 1 on the server');
  await win.locator('.banner-session').getByRole('button', { name: /Stop|Close/ }).click();

  // A notebook cell.
  await win.getByRole('button', { name: 'New file' }).click();
  await win.locator('.dialog-newfile .newfile-name input').fill('remote_nb.ipynb');
  await win.keyboard.press('Enter');
  await win.locator('.nb-cell').first().locator('.view-lines').click();
  await win.keyboard.type('import socket, getpass; print(getpass.getuser())');
  await win.keyboard.press('Shift+Enter');
  await win.locator('.nb-outputs').first().waitFor({ timeout: 120000 });
  const cell = (await win.locator('.nb-outputs').first().innerText()).trim();
  check(cell === E.SSH_USER, `a notebook cell runs as ${cell} on the server`);

  // The Terminal.
  await win.getByRole('tab', { name: 'Terminal' }).click();
  await win.locator('.terminal-host .xterm').waitFor({ timeout: 30000 });
  await win.waitForTimeout(1500);
  await win.locator('.terminal-host').click();
  await win.keyboard.type('echo WHO=$(whoami) WHERE=$(pwd)\n');
  await win.waitForFunction((u) => new RegExp(`WHO=${u}`).test(document.querySelector('.terminal-host')?.innerText || ''), E.SSH_USER, { timeout: 20000 });
  check(true, `the Terminal is a shell on the server: ${(await win.locator('.terminal-host').innerText()).match(/WHO=\S+ WHERE=\S+/g)?.pop()}`);
  await win.screenshot({ path: path.join(out, 'ssh-3-terminal.png') });

  // Stays on this computer.
  check((await win.getByRole('button', { name: 'Shared projects' }).count()) === 0, 'Shared projects isn’t offered on a server');
  const ai = await win.evaluate(async () => (await fetch('/api/ai/settings')).status);
  check(ai === 403, 'the AI settings (and keys) can’t be reached on a server');

  // Disconnect: back to this computer's project; Tandem stops on the server.
  await win.getByRole('button', { name: 'More options' }).click();
  await win.getByRole('menuitem', { name: /Disconnect from/ }).click();
  await win.waitForFunction((sel) => !document.querySelector('.remote-chip') && document.querySelector(sel), DEVICE_READY, { timeout: 60000 });
  const back = await win
    .waitForFunction(() => [...document.querySelectorAll('.file-sidebar, .sidebar')].some((el) => el.innerText.includes('local.py')), null, { timeout: 30000 })
    .then(() => true, () => false);
  check(back, 'Disconnect: back to this computer’s project');
  let left = 1;
  for (let i = 0; i < 20 && left; i++) {
    await new Promise((r) => setTimeout(r, 500));
    left = serverRuntimes();
  }
  check(left === 0, 'Tandem stopped on the server');

  // ---- second connection: the SSH key; the server is known, so no question
  connect = await openConnectWindow(app, win);
  await fillTarget(connect);
  await connect.locator('#use-key').click();
  await connect.locator('#key-path').fill(E.SSH_KEY);
  await connect.locator('#connect').click();
  await win.locator('.remote-chip').waitFor({ timeout: 120000 });
  check(true, 'connected again with the SSH key, without confirming the key again');
  await win.getByRole('button', { name: 'More options' }).click();
  await win.getByRole('menuitem', { name: /Disconnect from/ }).click();
  await win.waitForFunction(() => !document.querySelector('.remote-chip'), null, { timeout: 60000 });

  // ---- a changed host key is refused
  const known = path.join(userData, 'ssh-known-hosts.json');
  const hosts = JSON.parse(fs.readFileSync(known, 'utf8'));
  for (const k of Object.keys(hosts)) hosts[k].fingerprint = 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  fs.writeFileSync(known, JSON.stringify(hosts));
  connect = await openConnectWindow(app, win);
  await fillTarget(connect);
  await connect.locator('#use-key').click();
  await connect.locator('#key-path').fill(E.SSH_KEY);
  await connect.locator('#connect').click();
  await connect.waitForFunction(() => /identity changed/.test(document.querySelector('#status')?.innerText || ''), null, { timeout: 30000 });
  check(true, `a changed host key is refused: “${(await connect.locator('#status').innerText()).slice(0, 80)}…”`);
  check((await win.locator('.remote-chip').count()) === 0, '…and the window stays on this computer');
  await connect.screenshot({ path: path.join(out, 'ssh-4-changed-key.png') });
  await connect.close();

  await app.close();
  console.log(failures ? `\n${failures} SSH check(s) FAILED` : '\nAll SSH checks passed.');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
