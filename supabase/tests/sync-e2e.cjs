// Two accounts keep an open shared project in step (Cowork live mode).
//
//   node supabase/tests/sync-e2e.cjs <app url> <screenshot dir>
//
// The app is a live-mode build served at <app url> (vite preview), against
// the local stand-in (local-supabase.mjs) or the staging project. It creates
// two new accounts (synca_*, syncb_*) and one project. Needs Playwright with
// Chromium (npm install --no-save playwright).
//
// Checks: an invitation appears without Refresh; a teammate's save appears
// within 10 s without reopening; an unsaved edit meeting a newer save shows
// Conflict, and both Use theirs and Keep mine end in Saved with the same text
// on both sides; an edit made offline is saved when back online; created
// files and the project name arrive; no reloads while hidden. This is the
// save-based sync (notebooks, and servers without live typing), so the test
// turns live typing off in its browsers; live-typing-e2e.cjs covers that.
const { chromium } = require('playwright');
const [BASE, out] = process.argv.slice(2);
const APP = `${BASE.replace(/\/?$/, '/')}#/shared`;
const tag = Date.now().toString(36).slice(-5);
const A = `synca_${tag}`, B = `syncb_${tag}`;
// A new random password each run (the accounts are new each run too).
const PASS = `pw-${require('node:crypto').randomBytes(12).toString('base64url')}`;
let failures = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAILED: ') + msg); if (!ok) failures++; };
const nb = (t) => t.replace(/ /g, ' ');

async function signUp(p, user) {
  await p.goto('about:blank');
  await p.goto(APP);
  await p.waitForSelector('#signin-username');
  // Save-based sync (notebooks, servers without live typing): live typing off here.
  await p.evaluate(() => localStorage.setItem('tandem.coworkLiveTyping', 'off'));
  await p.reload();
  await p.waitForSelector('#signin-username');
  await p.getByRole('tab', { name: 'Create account' }).click();
  await p.locator('#signin-username').fill(user);
  await p.locator('#signin-password').fill(PASS);
  await p.locator('#signin-confirm').fill(PASS);
  await p.keyboard.press('Enter');
  await p.waitForSelector('.shared-page .shared-list, .shared-page .shared-empty', { timeout: 20000 });
}
const editorText = async (p) => nb(await p.locator('.monaco-editor .view-lines').first().innerText());
async function typeAtEnd(p, text) {
  await p.locator('.monaco-editor .view-lines').first().click();
  await p.keyboard.press('Control+End');
  await p.keyboard.type(text);
}
const status = (p) => p.locator('.cowork-inline .sync-status').innerText();
const waitStatus = (p, re, timeout = 20000) =>
  p.waitForFunction((src) => new RegExp(src).test(document.querySelector('.cowork-inline .sync-status')?.innerText || ''), re.source, { timeout });
const waitEditor = (p, text, timeout) =>
  p.waitForFunction((t) => [...document.querySelectorAll('.monaco-editor .view-lines')].some((el) => el.innerText.replace(/ /g, ' ').includes(t)), text, { timeout });
const toasts = async (p) => (await p.locator('.toast').allInnerTexts()).join(' | ');

(async () => {
  const browser = await chromium.launch();
  const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const ctxB = await browser.newContext({ viewport: { width: 1180, height: 820 } }); // iPad-sized
  const [pa, pb] = [await ctxA.newPage(), await ctxB.newPage()];
  const errs = [];
  for (const p of [pa, pb]) p.on('pageerror', (e) => errs.push(e.message));

  await signUp(pa, A);
  await signUp(pb, B);
  check(true, `two accounts: ${A}, ${B}`);

  // A: a project with Test.py
  await pa.getByRole('button', { name: 'New shared project' }).first().click();
  await pa.locator('.dialog-new-shared input').fill(`Sync ${tag}`);
  await pa.keyboard.press('Enter');
  await pa.waitForFunction(() => /^#\/shared\/[0-9a-f-]{36}$/.test(location.hash), null, { timeout: 15000 });
  await pa.getByRole('button', { name: 'New file' }).click();
  await pa.locator('.dialog-newfile .newfile-name input').fill('Test');
  await pa.keyboard.press('Enter');
  await pa.waitForSelector('.monaco-editor .view-lines');
  await typeAtEnd(pa, 'print("v1")');
  await waitStatus(pa, /Saved/);

  // A invites B; B sees it without pressing Refresh (Shared projects reloads every 30 s).
  await pa.locator('.cowork-inline').getByRole('button', { name: 'Share' }).click();
  await pa.locator('.share-find input').fill(B);
  await pa.locator('.share-find input').press('Enter');
  await pa.waitForFunction((u) => document.querySelector('.dialog-share')?.innerText.includes(`${u}@tandem.org`), B, { timeout: 10000 });
  await pa.keyboard.press('Escape');
  let t0 = Date.now();
  await pb.waitForSelector('.invite-card', { timeout: 40000 });
  check(true, `B: the invitation appeared on Shared projects without Refresh (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  await pb.getByRole('button', { name: 'Join project' }).click();
  await pb.waitForSelector('.monaco-editor .view-lines', { timeout: 15000 });
  await waitEditor(pb, 'print("v1")', 10000);
  // B's arrival shows in A's people without reopening.
  await pa.waitForFunction((u) => document.querySelector('.cowork-inline .avatar-stack')?.getAttribute('aria-label')?.includes(u) || document.querySelector('.cowork-inline .avatar-stack')?.getAttribute('data-tooltip')?.includes(u), B, { timeout: 15000 }).then(
    () => check(true, 'A: B appears among the project’s people without reopening'),
    () => check(false, 'A: B appears among the project’s people without reopening')
  );

  // 1. A has the project open; B saves; A shows B's text within 10 s.
  await typeAtEnd(pb, '\nprint("from B")');
  await waitStatus(pb, /Saved/);
  t0 = Date.now();
  await waitEditor(pa, 'print("from B")', 12000);
  const took = (Date.now() - t0) / 1000;
  check(took <= 10.5, `A: shows B's saved text in ${took.toFixed(1)} s without reopening`);
  check(new RegExp(`${B} saved Test.py`).test(await toasts(pa)), `A: note "${B} saved Test.py"`);
  check(/Saved/.test(await status(pa)), 'A: status Saved');
  await pa.screenshot({ path: `${out}/1-teammate-save-arrived.png` });

  // 2a. A has an unsaved edit when B saves: Conflict, then Use theirs.
  await typeAtEnd(pb, '\nprint("B again")');
  await waitStatus(pb, /Saved/);
  await typeAtEnd(pa, '\nprint("A local 1")');
  await waitStatus(pa, /Conflict/, 15000);
  await pa.waitForSelector('.file-bar', { timeout: 10000 });
  await pa.waitForFunction(() => /saved a newer version/.test(document.querySelector('.file-bar')?.innerText || ''), null, { timeout: 10000 }).catch(() => {});
  const bar1 = await pa.locator('.file-bar').innerText();
  check(new RegExp(`${B} saved a newer version`).test(bar1), `A: Conflict, bar "${bar1.split('\n')[0]}"`);
  check((await editorText(pa)).includes('A local 1'), 'A: the local edit is kept while in conflict');
  await pa.screenshot({ path: `${out}/2-conflict.png` });
  await pa.locator('.file-bar').getByRole('button', { name: 'Use theirs' }).click();
  await waitStatus(pa, /Saved/);
  await waitEditor(pa, 'B again', 5000); // Monaco repaints on the next frame
  const aTheirs = await editorText(pa);
  check(aTheirs.includes('B again') && !aTheirs.includes('A local 1'), 'A: Use theirs → Saved, B’s text');
  await pb.waitForTimeout(11000); // a full reload cycle on B
  const bTheirs = await editorText(pb);
  check(bTheirs.includes('B again') && !bTheirs.includes('A local 1') && /Saved/.test(await status(pb)), 'B: unchanged, Saved');

  // 2b. Same again, then Keep mine.
  await typeAtEnd(pb, '\nprint("B third")');
  await waitStatus(pb, /Saved/);
  await typeAtEnd(pa, '\nprint("A keeps this")');
  await waitStatus(pa, /Conflict/, 15000);
  await pa.locator('.file-bar').getByRole('button', { name: 'Keep mine' }).waitFor({ timeout: 10000 });
  await pa.locator('.file-bar').getByRole('button', { name: 'Keep mine' }).click();
  await waitStatus(pa, /Saved/);
  const aMine = await editorText(pa);
  check(aMine.includes('A keeps this') && !aMine.includes('B third'), 'A: Keep mine → Saved, A’s text');
  t0 = Date.now();
  await waitEditor(pb, 'A keeps this', 12000);
  const bMine = await editorText(pb);
  check(!bMine.includes('B third') && /Saved/.test(await status(pb)), `B: shows A’s kept text in ${((Date.now() - t0) / 1000).toFixed(1)} s, Saved`);
  check((await pa.locator('.file-bar').count()) === 0, 'A: the conflict bar is gone');

  // 3. A goes offline, edits, comes back: A saves.
  await ctxA.setOffline(true);
  await typeAtEnd(pa, '\nprint("written offline")');
  await waitStatus(pa, /Offline/, 15000);
  check(true, `A offline: status "${(await status(pa)).trim()}"`);
  await pa.screenshot({ path: `${out}/3-offline.png` });
  await pa.waitForTimeout(3000);
  await ctxA.setOffline(false);
  await waitStatus(pa, /Saved/, 15000);
  check(true, 'A back online: Saved');
  await waitEditor(pb, 'written offline', 12000);
  check(true, 'B: shows the edit A made offline');

  // Files a teammate created, renamed, removed; the project name.
  await pb.getByRole('button', { name: 'New file' }).click();
  await pb.locator('.dialog-newfile .newfile-name input').fill('notes');
  const md = pb.locator('.dialog-newfile').getByRole('radio', { name: /Markdown|Text/ });
  if (await md.count()) await md.first().click();
  await pb.keyboard.press('Enter');
  await pb.waitForTimeout(500);
  const created = (await pb.locator('.file-row, .tree-file, [data-path]').allInnerTexts()).join(' ');
  const newName = /notes\.\w+/.exec(created)?.[0] || 'notes.py';
  await pa.waitForFunction((n) => document.body.innerText.includes(n), newName, { timeout: 12000 });
  check(true, `A: ${newName} created by B appears`);
  await pa.getByText(`Sync ${tag}`).first().waitFor();
  // A renames the project; B sees the new name.
  await pa.getByRole('button', { name: 'Project settings' }).first().click();
  const nameInput = pa.locator('.dialog input').first();
  await nameInput.fill(`Synced ${tag}`);
  await pa.keyboard.press('Enter');
  await pa.waitForTimeout(500);
  await pa.keyboard.press('Escape');
  await pb.waitForFunction((n) => document.querySelector('.toolbar')?.innerText.includes(n), `Synced ${tag}`, { timeout: 12000 }).then(
    () => check(true, 'B: the new project name appears'),
    () => check(false, 'B: the new project name appears')
  );

  // Hidden: no reloads.
  let calls = 0;
  pa.on('request', (r) => r.url().includes('/rpc/cowork_project') && calls++);
  await pa.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await pa.waitForTimeout(21000);
  check(calls === 0, `A hidden: no reloads for 21 s (${calls})`);
  await pa.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await pa.waitForTimeout(1500);
  check(calls >= 1, `A visible again: reloads at once (${calls})`);

  check(errs.length === 0, `no page errors ${errs.join('; ')}`);
  await browser.close();
  console.log(failures ? `${failures} FAILED` : 'All sync checks passed.');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('FAILED', e.message);
  process.exit(1);
});
