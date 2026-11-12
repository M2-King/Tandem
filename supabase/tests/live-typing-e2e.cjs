// Tandem Cowork live mode: live typing between two accounts.
//
//   node supabase/tests/live-typing-e2e.cjs <app url> <supabase url> <publishable key> <screenshot dir>
//
// The app is a live-mode build (vite preview) against the local stand-in
// (local-supabase.mjs, with 003_cowork_live_text.sql applied) or staging with
// 002 and 003 applied. Creates new accounts with a random password each run.
//
// Checks: B sees A's letters as A types (without saving); both typing on the
// same line at once end with the same text on both sides and no Conflict;
// after saving, reopening shows that text once (nothing doubled); typing
// while offline merges when back online; undo takes back only your own
// typing; a file neither has typed in live yet, opened by both at once, isn't
// doubled; a new file is live too; a 50 KB paste arrives.

const { chromium } = require('playwright');
const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');

const [BASE, SUPABASE_URL, SUPABASE_KEY, out] = process.argv.slice(2);
const APP = `${BASE.replace(/\/?$/, '/')}#/shared`;
const tag = crypto.randomBytes(3).toString('hex');
const A = `typa_${tag}`, B = `typb_${tag}`;
const PASS = `pw-${crypto.randomBytes(12).toString('base64url')}`;
const DOMAIN = process.env.ACCOUNT_DOMAIN || 'accounts.tandem.invalid';
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
async function signIn(p, user) {
  await p.goto('about:blank');
  await p.goto(APP);
  await p.waitForSelector('#signin-username', { timeout: 20000 });
  await p.locator('#signin-username').fill(user);
  await p.locator('#signin-password').fill(PASS);
  await p.keyboard.press('Enter');
  await p.waitForSelector('.shared-page .shared-list, .shared-page .shared-empty', { timeout: 20000 });
}
const openFile = (p, name) => p.locator('.file-sidebar, .sidebar').getByText(name, { exact: true }).first().click();
// The text in the page's code editor (visible lines, top to bottom).
const editorText = (p) =>
  p.evaluate(() =>
    [...document.querySelectorAll('.monaco-editor .view-lines .view-line')]
      .map((l) => ({ top: parseFloat(l.style.top) || 0, text: l.textContent.replace(/ /g, ' ') }))
      .sort((a, b) => a.top - b.top)
      .map((l) => l.text)
      .join('\n')
  );
const waitText = (p, test, ms = 8000) =>
  p.waitForFunction(
    ([src, flags]) => {
      const text = [...document.querySelectorAll('.monaco-editor .view-lines .view-line')]
        .map((l) => ({ top: parseFloat(l.style.top) || 0, text: l.textContent.replace(/ /g, ' ') }))
        .sort((a, b) => a.top - b.top)
        .map((l) => l.text)
        .join('\n');
      return new RegExp(src, flags).test(text);
    },
    [test.source, test.flags],
    { timeout: ms }
  );
const status = (p) => p.locator('.cowork-inline .sync-status').first().innerText().catch(() => '');
const waitSaved = (p) => p.waitForFunction(() => /Saved/.test(document.querySelector('.cowork-inline .sync-status')?.innerText || ''), null, { timeout: 20000 });
const waitLive = (p) => p.waitForFunction(() => /^Live$/.test(document.querySelector('.live-status')?.innerText || ''), null, { timeout: 20000 });
const goEnd = async (p, lineText) => {
  await p.locator('.monaco-editor .view-line', { hasText: lineText }).first().click();
  await p.keyboard.press('End');
};
const count = (text, part) => text.split(part).length - 1;

(async () => {
  const browser = await chromium.launch();
  const permissions = ['clipboard-read', 'clipboard-write'];
  const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions });
  const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions });
  const pa = await ctxA.newPage();
  const pb = await ctxB.newPage();
  const errs = [];
  for (const p of [pa, pb]) p.on('pageerror', (e) => errs.push(e.message));
  const logs = [];
  pa.on('console', (m) => logs.push(m.text().slice(0, 200)));

  await signUp(pa, A);
  await signUp(pb, B);
  await pa.getByRole('button', { name: 'New shared project' }).first().click();
  await pa.locator('.dialog-new-shared input').fill(`Typing ${tag}`);
  await pa.keyboard.press('Enter');
  await pa.waitForFunction(() => /^#\/shared\/[0-9a-f-]{36}$/.test(location.hash), null, { timeout: 15000 });
  const projectHash = await pa.evaluate(() => location.hash);
  const projectId = projectHash.split('/').pop();
  await pa.getByRole('button', { name: 'New file' }).click();
  await pa.locator('.dialog-newfile .newfile-name input').fill('a.py');
  await pa.keyboard.press('Enter');
  await pa.waitForSelector('.monaco-editor .view-lines');
  await pa.locator('.monaco-editor .view-lines').first().click();
  await pa.keyboard.type('first = 1\nsecond = 2\n');
  await waitSaved(pa);
  await pa.locator('.cowork-inline').getByRole('button', { name: 'Share' }).click();
  await pa.locator('.share-find input').fill(B);
  await pa.locator('.share-find input').press('Enter');
  await pa.waitForFunction((u) => document.querySelector('.dialog-share')?.innerText.includes(`${u}@tandem.org`), B, { timeout: 10000 });
  await pa.keyboard.press('Escape');
  await pb.waitForSelector('.invite-card', { timeout: 40000 });
  await pb.getByRole('button', { name: 'Join project' }).click();
  await pb.waitForSelector('.monaco-editor .view-lines', { timeout: 15000 });
  await openFile(pb, 'a.py');
  await waitLive(pa);
  await waitLive(pb);
  await waitText(pb, /second = 2/);

  // 1. Letters appear as A types (A hasn't saved yet).
  await goEnd(pa, 'second = 2');
  const t0 = Date.now();
  await pa.keyboard.type('  # hello', { delay: 40 });
  await waitText(pb, /second = 2  # h/, 3000).then(
    () => check(true, `B sees A’s first letters while A types (${Date.now() - t0} ms after A started)`),
    () => check(false, 'B sees A’s first letters while A types')
  );
  await waitText(pb, /second = 2  # hello$/m, 3000).then(
    () => check(true, 'B sees all of “  # hello”'),
    async () => check(false, `B sees all of “  # hello”: ${JSON.stringify(await editorText(pb))} / A: ${JSON.stringify(await editorText(pa))}`)
  );
  await pb.screenshot({ path: `${out}/1-live.png` });

  // 2. Both type on the same line at the same time.
  await goEnd(pa, 'first = 1');
  await goEnd(pb, 'first = 1');
  await Promise.all([pa.keyboard.type(' AAAAAAAAAA', { delay: 35 }), pb.keyboard.type(' BBBBBBBBBB', { delay: 35 })]);
  await pa.waitForTimeout(1500);
  const ta = await editorText(pa);
  const tb = await editorText(pb);
  check(ta === tb, 'both typing at once: the same text on both sides');
  check(/ AAAAAAAAAA/.test(ta) && / BBBBBBBBBB/.test(ta), `…with both runs whole: ${JSON.stringify(ta.split('\n')[0])}`);
  check((await pa.locator('.file-bar').count()) + (await pb.locator('.file-bar').count()) === 0, '…and no Conflict bar');
  await waitSaved(pa);
  await waitSaved(pb);
  check(true, `both Saved (A “${await status(pa)}”, B “${await status(pb)}”)`);

  // 3. Reopening after saving: the same text, once.
  await pb.waitForTimeout(1500);
  const before = await editorText(pa);
  await pb.reload();
  await signIn(pb, B).catch(() => {});
  await pb.evaluate((h) => (location.hash = h), projectHash);
  await pb.waitForSelector('.monaco-editor .view-lines', { timeout: 15000 });
  await openFile(pb, 'a.py');
  await waitLive(pb);
  await pb.waitForTimeout(1500);
  const reopened = await editorText(pb);
  check(reopened === before, 'B reopens the project: the same text as A');
  check(count(reopened, 'first = 1') === 1 && count(reopened, 'AAAAAAAAAA') === 1, '…nothing doubled');

  // 4. Typing while offline merges when back online.
  await ctxB.setOffline(true);
  await goEnd(pb, 'second = 2');
  await pb.keyboard.type('\nfrom_b_offline = 1', { delay: 20 });
  await goEnd(pa, 'first = 1');
  await pa.keyboard.type('  # a_online', { delay: 20 });
  await pa.waitForTimeout(1500);
  await ctxB.setOffline(false);
  await waitText(pa, /from_b_offline = 1/, 20000).then(
    () => check(true, 'B’s offline typing reaches A when B is back online'),
    () => check(false, 'B’s offline typing reaches A when B is back online')
  );
  await waitText(pb, /# a_online/, 20000).then(
    () => check(true, 'A’s typing reaches B after B was offline'),
    () => check(false, 'A’s typing reaches B after B was offline')
  );
  await pa.waitForTimeout(1500);
  const ma = await editorText(pa);
  check(ma === (await editorText(pb)), 'after offline: the same text on both sides');
  check(count(ma, 'from_b_offline') === 1 && count(ma, 'a_online') === 1, '…nothing doubled or lost');

  // 5. Undo takes back only your own typing.
  await goEnd(pb, 'from_b_offline = 1');
  await pb.keyboard.type('  # keep_b', { delay: 20 });
  await pa.waitForTimeout(800);
  await goEnd(pa, 'second = 2');
  await pa.keyboard.type('  # undo_a', { delay: 20 });
  await waitText(pb, /# undo_a/, 5000);
  await pa.keyboard.press('Control+Z');
  await waitText(pb, /^(?![\s\S]*undo_a)[\s\S]*keep_b/, 5000).then(
    () => check(true, 'A undoes: A’s “# undo_a” goes on both sides, B’s “# keep_b” stays'),
    async () => check(false, `A undoes: ${JSON.stringify(await editorText(pb))}`)
  );

  // 6. A file nobody typed in live yet, opened by both at the same moment: not doubled.
  const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
  await sb.auth.signInWithPassword({ email: `${A}@${DOMAIN}`, password: PASS });
  const created = await sb.rpc('cowork_create_file', { p_project: projectId, p_path: 'fresh.py', p_content: 'only_once = True\n' });
  check(!created.error, `fresh.py created outside the app ${created.error?.message || ''}`);
  await Promise.all([pa.reload(), pb.reload()]);
  await Promise.all([signIn(pa, A).catch(() => {}), signIn(pb, B).catch(() => {})]);
  await Promise.all([pa.evaluate((h) => (location.hash = h), projectHash), pb.evaluate((h) => (location.hash = h), projectHash)]);
  await Promise.all([pa.waitForSelector('.monaco-editor .view-lines', { timeout: 15000 }), pb.waitForSelector('.monaco-editor .view-lines', { timeout: 15000 })]);
  await Promise.all([openFile(pa, 'fresh.py'), openFile(pb, 'fresh.py')]);
  await Promise.all([waitLive(pa), waitLive(pb)]);
  await pa.waitForTimeout(2500);
  await goEnd(pa, 'only_once');
  await pa.keyboard.type('  # by_a', { delay: 20 });
  await goEnd(pb, 'only_once');
  await pb.keyboard.type('  # by_b', { delay: 20 });
  await pa.waitForTimeout(2000);
  const fa = await editorText(pa);
  check(fa === (await editorText(pb)), 'fresh.py: the same text on both sides');
  check(count(fa, 'only_once = True') === 1, `fresh.py: not doubled ${JSON.stringify(fa)}`);

  // 7. A new file is live too; 8. a 50 KB paste arrives.
  await pa.getByRole('button', { name: 'New file' }).click();
  await pa.locator('.dialog-newfile .newfile-name input').fill('new.py');
  await pa.keyboard.press('Enter');
  await pa.waitForSelector('.monaco-editor .view-lines');
  await pa.locator('.monaco-editor .view-lines').first().click();
  await pa.keyboard.type('made_by_a = 1', { delay: 20 });
  await pb.locator('.file-sidebar, .sidebar').getByText('new.py', { exact: true }).first().waitFor({ timeout: 20000 });
  await openFile(pb, 'new.py');
  await waitText(pb, /made_by_a = 1/, 8000);
  await pa.keyboard.type('\nstill_typing = 2', { delay: 30 });
  await waitText(pb, /still_typing = 2/, 3000).then(
    () => check(true, 'a new file is typed live too'),
    () => check(false, 'a new file is typed live too')
  );
  const big = `blob = "${'x'.repeat(50 * 1024)}"`;
  await pa.keyboard.press('Enter');
  // Pasted as a person would (one edit), through the clipboard.
  await pa.evaluate((t) => navigator.clipboard.writeText(t), big);
  await pa.keyboard.press('Control+V');
  const t1 = Date.now();
  // (Monaco shows a very long line shortened and scrolled; look for a long run of it.)
  await pb.waitForFunction(() => document.querySelector('.monaco-editor .view-lines')?.textContent.includes('x'.repeat(200)), null, { timeout: 15000 }).then(
    () => check(true, `a 50 KB paste arrives (${Date.now() - t1} ms)`),
    async () => (await pa.screenshot({ path: `${out}/paste-a.png` }), await pb.screenshot({ path: `${out}/paste-b.png` }), check(false, `a 50 KB paste arrives (A status “${await status(pa)}”, A live “${await pa.locator('.live-status').first().innerText().catch(() => '-')}”)`))
  );
  await waitSaved(pa).catch(async () => check(false, `A never Saved after the paste: “${await status(pa)}” ${logs.slice(-5).join(' | ')}`));

  check(errs.length === 0, `no page errors ${errs.join(' | ')}`);
  await pa.screenshot({ path: `${out}/2-end-a.png` });
  await browser.close();
  console.log(failures ? `${failures} FAILED` : 'All live typing checks passed.');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('FAILED', e.message);
  process.exit(1);
});
