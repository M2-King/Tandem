// Tandem Cowork live mode: Backups (back up, restore a file, restore the
// project, undo), with two accounts.
//
//   node supabase/tests/versions-e2e.cjs <app url> <screenshot dir>
//
// A live-mode build against the local stand-in or staging, with
// 005_cowork_versions.sql applied.
//
// Checks: A backs up from Backups with a name; after edits, B (a member) sees
// the backup, views main.py as it was (with what restoring changes) and
// restores that one file: B's and A's editors show it; B can't restore the
// whole project; A (owner) restores the whole project after confirming:
// a file added since goes for both; Undo brings it back.

const { chromium } = require('playwright');
const crypto = require('node:crypto');

const [BASE, out] = process.argv.slice(2);
const APP = `${BASE.replace(/\/?$/, '/')}#/shared`;
const tag = crypto.randomBytes(3).toString('hex');
const A = `bka_${tag}`, B = `bkb_${tag}`;
const PASS = `pw-${crypto.randomBytes(9).toString('base64url')}`;
let failures = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAILED: ') + msg); if (!ok) failures++; };

async function signUp(p, user) {
  await p.goto('about:blank');
  await p.goto(APP);
  await p.waitForSelector('#signin-username', { timeout: 20000 });
  await p.getByRole('tab', { name: 'Create account' }).click();
  await p.locator('#signin-username').fill(user);
  await p.locator('#signin-password').fill(PASS);
  await p.locator('#signin-confirm').fill(PASS);
  await p.keyboard.press('Enter');
  await p.waitForSelector('.shared-page .shared-list, .shared-page .shared-empty', { timeout: 20000 });
}
const saved = (p) => p.waitForFunction(() => /Saved/.test(document.querySelector('.cowork-inline .sync-status')?.innerText || ''), null, { timeout: 20000 });
async function newFile(p, name, text) {
  await p.getByRole('button', { name: 'New file' }).click();
  await p.locator('.dialog-newfile .newfile-name input').fill(name);
  await p.keyboard.press('Enter');
  await p.waitForSelector('.monaco-editor .view-lines');
  await p.locator('.monaco-editor .view-lines').first().click();
  await p.keyboard.press('Control+A');
  await p.keyboard.type(text);
  await saved(p);
}
const editorText = (p) => p.evaluate(() => (document.querySelector('.monaco-editor .view-lines')?.innerText || '').replace(/\u00a0/g, ' ').trim());
// Monaco draws spaces as non-breaking spaces: compared as plain spaces.
const editorHas = (p, text, timeout) =>
  p.waitForFunction((t) => (document.querySelector('.monaco-editor .view-lines')?.innerText || '').replace(/\u00a0/g, ' ').includes(t), text, { timeout });
const sidebar = (p) => p.locator('.file-sidebar, .sidebar');
const openBackups = async (p) => {
  await p.locator('.cowork-inline').getByRole('button', { name: 'Backups' }).click();
  await p.waitForSelector('.dialog-versions', { timeout: 5000 });
};
const toastHas = (p, text, timeout = 10000) => p.waitForFunction((t) => document.body.innerText.includes(t), text, { timeout });

let pa, pb;
(async () => {
  const browser = await chromium.launch();
  pa = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
  pb = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
  const errs = [];
  for (const p of [pa, pb]) p.on('pageerror', (e) => errs.push(e.message));

  await signUp(pa, A);
  await signUp(pb, B);
  await pa.getByRole('button', { name: 'New shared project' }).first().click();
  await pa.locator('.dialog-new-shared input').fill(`Backups ${tag}`);
  await pa.keyboard.press('Enter');
  await pa.waitForFunction(() => /^#\/shared\/[0-9a-f-]{36}$/.test(location.hash) && !document.querySelector('.dialog-prepare'), null, { timeout: 60000 });
  await newFile(pa, 'main.py', 'print("first version")');
  await pa.locator('.cowork-inline').getByRole('button', { name: 'Share', exact: true }).click();
  await pa.locator('.share-find input').fill(B);
  await pa.locator('.share-find input').press('Enter');
  await pa.waitForFunction((u) => document.querySelector('.dialog-share')?.innerText.includes(`${u}@tandem.org`), B, { timeout: 10000 });
  await pa.keyboard.press('Escape');

  // 1. A backs up, with a name.
  await openBackups(pa);
  check((await pa.locator('.dialog-versions').innerText()).includes('No backups yet'), 'Backups starts empty');
  await pa.locator('.versions-new input').fill('first draft');
  await pa.locator('.versions-new').getByRole('button', { name: 'Back up now' }).click();
  await pa.waitForSelector('.versions-row', { timeout: 10000 });
  const row = (await pa.locator('.versions-row').first().innerText()).replace(/\s+/g, ' ');
  check(row.includes('first draft') && row.includes(A) && row.includes('1 file'), `A backs up: “${row.slice(0, 80)}”`);
  await pa.screenshot({ path: `${out}/bk-1-backed-up.png` });
  await pa.keyboard.press('Escape');

  // A changes things: main.py, and a new file.
  await sidebar(pa).getByText('main.py', { exact: true }).first().click();
  await pa.locator('.monaco-editor .view-lines').first().click();
  await pa.keyboard.press('Control+A');
  await pa.keyboard.type('print("second version")');
  await saved(pa);
  await newFile(pa, 'notes.md', '# added later');

  // 2. B joins, finds the backup, views main.py as it was and restores that file.
  await pb.waitForSelector('.invite-card', { timeout: 40000 });
  await pb.getByRole('button', { name: 'Join project' }).click();
  await pb.waitForSelector('.file-sidebar, .sidebar', { timeout: 30000 });
  await sidebar(pb).getByText('main.py', { exact: true }).first().click();
  const t0 = Date.now();
  await editorHas(pb, 'second version', 30000).catch(async () => {
    throw new Error(`B's main.py shows “${await editorText(pb)}”`);
  });
  console.log(`     (B saw the second version after ${Date.now() - t0} ms)`);
  await openBackups(pb);
  await pb.waitForSelector('.versions-row', { timeout: 10000 });
  const restoreAll = pb.locator('.versions-row').first().getByRole('button', { name: 'Restore', exact: true });
  check(await restoreAll.isDisabled(), 'a member can’t restore the whole project (the button is off)');
  await pb.locator('.versions-row').first().getByRole('button', { name: /Files/ }).click();
  const filesText = (await pb.locator('.versions-files').innerText()).replace(/\s+/g, ' ');
  check(filesText.includes('main.py') && filesText.includes('Added since this backup: notes.md'), 'the backup’s files, and what was added since');
  await pb.locator('.versions-file').filter({ hasText: 'main.py' }).getByRole('button', { name: 'View' }).click();
  await pb.waitForSelector('.versions-text', { timeout: 10000 });
  const view = (await pb.locator('.versions-view').innerText()).replace(/\s+/g, ' ');
  check(view.includes('print("first version")') && /restoring: \+1 −1 lines/.test(view), `View shows main.py as it was, and what restoring changes (“${view.match(/restoring[^·]*/)?.[0] || '?'}”)`);
  await pb.screenshot({ path: `${out}/bk-2-view.png` });
  await pb.locator('.versions-view').getByRole('button', { name: 'Restore this file' }).click();
  await toastHas(pb, 'Restored main.py from “first draft”');
  await pb.keyboard.press('Escape');
  await editorHas(pb, 'first version', 15000).then(
    () => check(true, 'B restores main.py: B’s editor shows the first version'),
    async () => check(false, `B’s editor after restoring: “${await editorText(pb)}”`)
  );
  await sidebar(pa).getByText('main.py', { exact: true }).first().click();
  await editorHas(pa, 'first version', 15000).then(
    () => check(true, '…and A’s editor too (a teammate’s restore arrives like a save)'),
    async () => check(false, `A’s editor after B’s restore: “${await editorText(pa)}”`)
  );

  // 3. A restores the whole project, confirming; notes.md goes for both; Undo brings it back.
  await openBackups(pa);
  await pa.waitForSelector('.versions-row', { timeout: 10000 });
  const firstDraft = pa.locator('.versions-row').filter({ hasText: 'first draft' });
  await firstDraft.getByRole('button', { name: 'Restore', exact: true }).click();
  const confirmText = (await pa.locator('.versions-confirm').innerText()).replace(/\s+/g, ' ');
  check(/Restore “first draft”\?/.test(confirmText) && /backed up first/.test(confirmText), 'restoring the project asks first, and says it can be undone');
  await pa.screenshot({ path: `${out}/bk-3-confirm.png` });
  await pa.locator('.versions-confirm').getByRole('button', { name: 'Restore project' }).click();
  await toastHas(pa, 'Restored “first draft”');
  const gone = (p) => p.waitForFunction(() => ![...document.querySelectorAll('.file-sidebar, .sidebar')].some((s) => s.innerText.includes('notes.md')), null, { timeout: 15000 }).then(() => true, () => false);
  check((await gone(pa)) && (await gone(pb)), 'the whole project is restored: notes.md (added since) is gone for A and B');
  const rows = (await pa.locator('.versions-row').allInnerTexts()).join(' | ').replace(/\s+/g, ' ');
  check(/Before a restore/.test(rows), 'the backups list shows what was there before the restore');
  await pa.getByRole('button', { name: 'Undo' }).last().click();
  const back = (p) => p.waitForFunction(() => [...document.querySelectorAll('.file-sidebar, .sidebar')].some((s) => s.innerText.includes('notes.md')), null, { timeout: 15000 }).then(() => true, () => false);
  check((await back(pa)) && (await back(pb)), 'Undo brings notes.md back, for both');
  await pa.screenshot({ path: `${out}/bk-4-list.png` });

  check(errs.length === 0, `no page errors ${errs.join('; ')}`);
  await browser.close();
  console.log(failures ? `${failures} FAILED` : 'All backup checks passed.');
  process.exit(failures ? 1 : 0);
})().catch(async (e) => {
  console.error('FAILED', e.message);
  await pa?.screenshot({ path: `${out}/bk-failed-a.png` }).catch(() => {});
  await pb?.screenshot({ path: `${out}/bk-failed-b.png` }).catch(() => {});
  process.exit(1);
});
