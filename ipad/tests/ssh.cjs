// The iPad app connected to an SSH server (CI: the simulator, launched with
// TANDEM_SSH_TEST; see .github/workflows/ipad.yml). Drives the app's page
// from WebKit on the Mac, as ipad/tests/web.cjs does.
//
//   node ipad/tests/ssh.cjs http://127.0.0.1:47831/ <ssh user>
const { webkit } = require('playwright');

const [url, user] = process.argv.slice(2);
let failures = 0;
let unfinished = () => 'none';
const check = (ok, msg) => {
  console.log(`${ok ? 'ok  ' : 'FAILED:'} ${msg}`);
  if (!ok) failures++;
};

(async () => {
  const browser = await webkit.launch();
  const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Requests still waiting, shown if a check fails (what the page waits for).
  const pending = new Map();
  page.on('request', (r) => pending.set(r, Date.now()));
  page.on('requestfinished', (r) => pending.delete(r));
  page.on('requestfailed', (r) => pending.delete(r));
  unfinished = () =>
    [...pending].map(([r, t]) => `${r.method()} ${r.url()} (${Math.round((Date.now() - t) / 1000)} s)`).join('\n  ') || 'none';
  // The app connects at launch; the page then shows the server.
  for (let i = 0; i < 60; i++) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    if (await page.locator('.remote-chip').count()) break;
    await page.waitForTimeout(5000);
  }
  await page.locator('.remote-chip').waitFor({ timeout: 10000 });
  check(true, `the page shows the server: ${(await page.locator('.remote-chip').innerText()).trim()}`);
  check((await page.evaluate(() => document.documentElement.dataset.shell)) === 'ipad', 'in the iPad layout');
  await page.locator('.runtime-status.tone-up').waitFor({ timeout: 120000 });
  check(true, `the server's Python: ${(await page.locator('.runtime-status').innerText()).trim()}`);

  // The file list can be folded away (portrait, small windows); open it first.
  await page.locator('[role=treeitem]:visible, button[aria-label="Show files"]:visible').first().waitFor({ timeout: 30000 });
  if (!(await page.locator('[role=treeitem]:visible').count())) await page.locator('button[aria-label="Show files"]:visible').first().click();
  await page.getByRole('treeitem', { name: 'main.py' }).click();
  if (await page.locator('.scrim:visible').count()) await page.keyboard.press('Escape');
  await page.locator('.run-control .split-main').click();
  await page.waitForFunction(() => /from the server/.test(document.querySelector('.output-lines')?.innerText || ''), null, { timeout: 120000 });
  check(true, `Run on the server: ${(await page.locator('.output-lines').innerText()).trim().split('\n').pop()}`);

  await page.getByRole('tab', { name: 'Terminal' }).click();
  await page.locator('.terminal-host .xterm').waitFor({ timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.locator('.terminal-host').click();
  await page.keyboard.type('echo WHO=$(whoami)\n');
  const who = await page
    .waitForFunction((u) => new RegExp(`WHO=${u}\\b`).test(document.querySelector('.terminal-host')?.innerText || ''), user, { timeout: 30000 })
    .then(() => true, () => false);
  check(who, `the Terminal is a shell on the server as ${user}`);

  const ai = await page.evaluate(async () => (await fetch('/api/ai/settings')).status);
  check(ai === 403, 'AI settings stay on the iPad');
  check(errors.length === 0, `no page errors ${errors.join('; ')}`);
  await browser.close();
  console.log(failures ? `\n${failures} iPad SSH check(s) FAILED` : '\nAll iPad SSH checks passed.');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('FAILED:', e.message);
  console.error(`requests still waiting:\n  ${unfinished()}`);
  process.exit(1);
});
