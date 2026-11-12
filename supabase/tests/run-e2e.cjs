// Tandem Cowork live mode: running a shared project on this device.
//
//   node supabase/tests/run-e2e.cjs <A: runtime URL> <B: app URL> <runtime --shared-root> <device project folder> <screenshot dir>
//   node supabase/tests/run-e2e.cjs <A: iPad devserver URL> <B: app URL> - - <screenshot dir>
//
// A uses the desktop runtime (`tandem serve <device project> --shared-root …`
// serving a live-mode UI build), or the iPad build (ipad/devserver.py with
// --ui <live-mode build>, Pyodide in the page: the disk and process checks
// are skipped); B only edits, in any live-mode build. Both
// against the local stand-in (local-supabase.mjs) or staging. Needs
// Playwright with Chromium.
//
// Checks: B saves a change and A's Run uses B's text (from the working copy,
// never the device project's file of the same name); the one-time
// confirmation appears once per project; files a run makes stay in the
// working copy; a notebook cell runs; leaving the project ends its kernel.

const { chromium } = require('playwright');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const [RUNTIME, APP_B, SHARED_ROOT, DEVICE_PROJECT, out] = process.argv.slice(2);
const IPAD = SHARED_ROOT === '-';
const tag = crypto.randomBytes(3).toString('hex');
const A = `runa_${tag}`, B = `runb_${tag}`;
const PASS = `pw-${crypto.randomBytes(9).toString('base64url')}`;
let failures = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAILED: ') + msg); if (!ok) failures++; };
const shared = (u) => `${u.replace(/\/?$/, '/')}#/shared`;
const waitStatus = (p, re, timeout = 20000) =>
  p.waitForFunction((src) => new RegExp(src).test(document.querySelector('.cowork-inline .sync-status')?.innerText || ''), re.source, { timeout });
const bodyHas = (p, text, timeout) => p.waitForFunction((t) => document.body.innerText.replace(/ /g, ' ').includes(t), text, { timeout });
const kernels = (dir) => {
  try {
    return execFileSync('sh', ['-c', 'ps -eo args | grep ipykernel_launcher | grep -v grep || true'], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean).length;
  } catch {
    return 0;
  }
};

async function signUp(p, url, user) {
  await p.goto('about:blank');
  await p.goto(shared(url));
  await p.waitForSelector('#signin-username', { timeout: 20000 });
  await p.getByRole('tab', { name: 'Create account' }).click();
  await p.locator('#signin-username').fill(user);
  await p.locator('#signin-password').fill(PASS);
  await p.locator('#signin-confirm').fill(PASS);
  await p.keyboard.press('Enter');
  await p.waitForSelector('.shared-page .shared-list, .shared-page .shared-empty', { timeout: 20000 });
}
async function newFile(p, name, text) {
  await p.getByRole('button', { name: 'New file' }).click();
  await p.locator('.dialog-newfile .newfile-name input').fill(name);
  await p.keyboard.press('Enter');
  await p.waitForSelector('.monaco-editor .view-lines');
  if (text) {
    await p.locator('.monaco-editor .view-lines').first().click();
    await p.keyboard.press('Control+A');
    await p.keyboard.type(text);
  }
}
async function openFile(p, name) {
  await p.locator('.file-sidebar, .sidebar').getByText(name, { exact: true }).first().click();
  await p.waitForTimeout(300);
}
const run = (p) => p.locator('.run-control .split-main').click();

let pa;
(async () => {
  const browser = await chromium.launch();
  pa = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const pb = await (await browser.newContext({ viewport: { width: 1180, height: 820 } })).newPage();
  const errs = [];
  for (const p of [pa, pb]) p.on('pageerror', (e) => errs.push(e.message));

  await signUp(pa, RUNTIME, A);
  await signUp(pb, APP_B, B);
  check(true, `accounts ${A} (desktop runtime) and ${B}`);

  await pa.getByRole('button', { name: 'New shared project' }).first().click();
  await pa.locator('.dialog-new-shared input').fill(`Run ${tag}`);
  await pa.keyboard.press('Enter');
  await pa.waitForFunction(() => /^#\/shared\/[0-9a-f-]{36}$/.test(location.hash), null, { timeout: 15000 });
  const projectId = (await pa.evaluate(() => location.hash)).split('/').pop();
  await newFile(pa, 'helper.py', 'MSG = "v1"');
  await waitStatus(pa, /Saved/);
  await newFile(pa, 'main.py', 'import helper\nprint("main says", helper.MSG)\nopen("made_by_run.csv", "w").write("a,b\\n1,2\\n")\n');
  await waitStatus(pa, /Saved/);

  await pa.locator('.cowork-inline').getByRole('button', { name: 'Share' }).click();
  await pa.locator('.share-find input').fill(B);
  await pa.locator('.share-find input').press('Enter');
  await pa.waitForFunction((u) => document.querySelector('.dialog-share')?.innerText.includes(`${u}@tandem.org`), B, { timeout: 10000 });
  await pa.keyboard.press('Escape');
  await pb.waitForSelector('.invite-card', { timeout: 40000 });
  await pb.getByRole('button', { name: 'Join project' }).click();
  await pb.waitForSelector('.monaco-editor .view-lines', { timeout: 15000 });

  // B changes helper.py and saves; A runs main.py.
  await openFile(pb, 'helper.py');
  await pb.locator('.monaco-editor .view-lines').first().click();
  await pb.keyboard.press('Control+A');
  await pb.keyboard.type('MSG = "from B"');
  await waitStatus(pb, /Saved/);
  await bodyHas(pa, `${B} saved helper.py`, 15000);
  await openFile(pa, 'main.py');
  await run(pa);

  // The one-time confirmation.
  const dialog = pa.locator('.dialog-confirm');
  await dialog.waitFor({ timeout: 10000 });
  const dialogText = (await dialog.innerText()).replace(/\s+/g, ' ');
  check(dialogText.includes(`Code in Run ${tag} runs on this device with your permissions. Run it only if you trust its members.`), 'first run asks: "Code in <project> runs on this device with your permissions. Run it only if you trust its members."');
  await pa.screenshot({ path: `${out}/1-confirm.png` });
  await dialog.getByRole('button', { name: 'Run on this device' }).click();
  await bodyHas(pa, 'main says from B', 60000);
  check(true, 'A: Run used B’s saved helper.py (main says from B)');
  check(!(await pa.locator('.output-lines').innerText()).includes('DEVICE PROJECT'), 'the device project’s helper.py (same name) was not used');
  check((await pa.locator('.output-lines .line-note').count()) === 1 && /stay on this device/.test(await pa.locator('.output-lines .line-note').innerText()), 'Output says once that files a run creates stay on this device');
  await pa.screenshot({ path: `${out}/2-run-output.png` });

  if (!IPAD) {
    const copy = path.join(SHARED_ROOT, projectId);
    check(fs.readFileSync(path.join(copy, 'helper.py'), 'utf8') === 'MSG = "from B"', `working copy at Shared/${projectId.slice(0, 8)}… has B’s text`);
    check(fs.existsSync(path.join(copy, 'made_by_run.csv')), 'a file the run made stays in the working copy');
    check(!fs.existsSync(path.join(DEVICE_PROJECT, 'made_by_run.csv')), '…and not in the device project');
  }
  await pa.waitForTimeout(1500);
  check(!(await pa.locator('.file-sidebar, .sidebar').first().innerText()).includes('made_by_run.csv'), '…and isn’t uploaded to the shared project');

  // Second run: no question. A's unsaved edit is used too.
  await pa.locator('.monaco-editor .view-lines').first().click();
  await pa.keyboard.press('Control+End');
  await pa.keyboard.type('import os; print("second run", os.path.exists("made_by_run.csv"))');
  await run(pa);
  const secondRun = await pa
    .waitForFunction(() => /second run (True|False)/.exec(document.querySelector('.output-lines')?.innerText || '')?.[1], null, { timeout: 60000 })
    .then((h) => h.jsonValue());
  check(secondRun === 'True', 'the next run (a fresh Python) still finds the file the first run made, and uses the unsaved edit');
  check((await pa.locator('.dialog-confirm').count()) === 0, 'second run in the same project: no confirmation');

  // Step through in the shared project: pauses on line 1, Next moves on.
  await pa.locator('.run-control .split-toggle').click();
  await pa.getByRole('menuitem', { name: /Step through/ }).click();
  const bar = pa.locator('.banner-session[aria-label="Step through"]');
  await bar.waitFor({ timeout: 60000 });
  await pa.waitForFunction(() => /Next line: 1\b/.test(document.querySelector('.banner-session')?.innerText || ''), null, { timeout: 60000 });
  check(true, 'Step through pauses on line 1 of main.py');
  await bar.locator('button.btn-primary').first().click();
  await pa.waitForFunction(() => /Next line: 2\b/.test(document.querySelector('.banner-session')?.innerText || ''), null, { timeout: 30000 });
  check(true, 'Next moves to line 2 (the debugger runs in the working copy)');
  await bar.getByRole('button', { name: /Stop|Close/ }).click();
  await pa.waitForTimeout(1500);
  if (await bar.count()) await bar.getByRole('button', { name: /Close/ }).click().catch(() => {});

  // A notebook cell in the shared project.
  await newFile(pa, 'nb.ipynb');
  await pa.locator('.nb-cell').first().locator('.view-lines').click();
  await pa.keyboard.type('import helper; print(helper.MSG * 2)');
  await pa.keyboard.press('Shift+Enter');
  await pa.locator('.nb-outputs').first().waitFor({ timeout: 120000 });
  const cellOut = await pa.locator('.nb-outputs').first().innerText();
  check(cellOut.includes('from Bfrom B'), `notebook cell ran in the working copy: ${cellOut.trim()}`);
  await pa.screenshot({ path: `${out}/3-notebook.png` });
  const before = IPAD ? 1 : kernels();
  if (!IPAD) check(before >= 1, `a kernel is running (${before})`);

  // Leaving the project ends its kernel.
  await pa.locator('.toolbar').getByRole('button', { name: /Shared projects/ }).first().click().catch(async () => {
    await pa.evaluate(() => (location.hash = '#/shared'));
  });
  await pa.waitForSelector('.shared-page', { timeout: 10000 });
  if (!IPAD) {
    let after = before;
    for (let i = 0; i < 20 && after >= before; i++) {
      await pa.waitForTimeout(500);
      after = kernels();
    }
    check(after < before, `leaving the project shut down its kernel (${before} → ${after})`);
  }

  // Reopen (a new session): still no question for this project.
  await pa.goto('about:blank');
  await pa.goto(shared(RUNTIME));
  // (Kept signed in on this device: no sign-in page then.)
  await pa.waitForSelector('#signin-username, .shared-page .shared-list', { timeout: 20000 });
  if (await pa.locator('#signin-username').count()) {
    await pa.locator('#signin-username').fill(A);
    await pa.locator('#signin-password').fill(PASS);
    await pa.keyboard.press('Enter');
  }
  await pa.waitForSelector('.shared-page .shared-list', { timeout: 20000 });
  await pa.getByRole('button', { name: new RegExp(`^Run ${tag}`) }).click();
  await pa.waitForSelector('.monaco-editor .view-lines', { timeout: 15000 });
  await openFile(pa, 'main.py');
  await run(pa);
  await bodyHas(pa, 'main says from B', 60000);
  check((await pa.locator('.dialog-confirm').count()) === 0, 'after reopening: the answer is remembered for this project on this device');

  // Another project asks again.
  await pa.evaluate(() => (location.hash = '#/shared'));
  await pa.waitForSelector('.shared-page');
  await pa.getByRole('button', { name: 'New shared project' }).first().click();
  await pa.locator('.dialog-new-shared input').fill(`Other ${tag}`);
  await pa.keyboard.press('Enter');
  await pa.waitForFunction((id) => /^#\/shared\/[0-9a-f-]{36}$/.test(location.hash) && !location.hash.endsWith(id), projectId, { timeout: 15000 });
  await newFile(pa, 'x.py', 'print("other project")');
  await waitStatus(pa, /Saved/);
  await run(pa);
  await pa.locator('.dialog-confirm').waitFor({ timeout: 10000 });
  check(true, 'a different project asks again');
  await pa.locator('.dialog-confirm').getByRole('button', { name: 'Don’t run' }).click();
  await bodyHas(pa, 'The run didn’t start', 10000);
  check(true, 'Don’t run: nothing runs');

  check(errs.length === 0, `no page errors ${errs.join('; ')}`);
  await browser.close();
  console.log(failures ? `${failures} FAILED` : 'All shared-run checks passed.');
  process.exit(failures ? 1 : 0);
})().catch(async (e) => {
  console.error('FAILED', e.message);
  await pa?.screenshot({ path: `${out}/failed.png` }).catch(() => {});
  process.exit(1);
});
