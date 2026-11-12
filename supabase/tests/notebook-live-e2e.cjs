// Tandem Cowork live mode: notebooks typed live, cell by cell.
//
//   node supabase/tests/notebook-live-e2e.cjs <app url> <screenshot dir>
//
// A live-mode build (vite preview) against the local stand-in or staging.
//
// Checks: B sees A's letters in a notebook cell while A types (before any
// save), with A's name at A's caret; both typing in different cells, or in
// the same cell, at once end the same on both sides with nothing lost; a cell A adds appears for B, a cell B removes
// goes for A; after a reload (from the saved file) the notebook holds each
// cell once (nothing doubled, nothing lost).

const { chromium } = require('playwright');
const crypto = require('node:crypto');

const [BASE, out] = process.argv.slice(2);
const APP = `${BASE.replace(/\/?$/, '/')}#/shared`;
const tag = crypto.randomBytes(3).toString('hex');
const A = `nba_${tag}`, B = `nbb_${tag}`;
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
// The text of each cell as its editor shows it.
const cells = (p) =>
  p.evaluate(() =>
    [...document.querySelectorAll('.nb-cell')].map((c) => (c.querySelector('.view-lines')?.innerText || '').replace(/ /g, ' ').replace(/\n+$/, ''))
  );
const cellEditor = (p, i) => p.locator('.nb-cell').nth(i).locator('.monaco-editor .view-lines');
const waitCells = (p, fn, arg, timeout = 15000) =>
  p.waitForFunction(
    ([src, a]) => {
      const texts = [...document.querySelectorAll('.nb-cell')].map((c) => (c.querySelector('.view-lines')?.innerText || '').replace(/ /g, ' ').replace(/\n+$/, ''));
      return new Function('texts', 'a', `return (${src})(texts, a)`)(texts, a);
    },
    [fn.toString(), arg],
    { timeout }
  );

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
  await pa.locator('.dialog-new-shared input').fill(`Notebook ${tag}`);
  await pa.keyboard.press('Enter');
  await pa.waitForFunction(() => /^#\/shared\/[0-9a-f-]{36}$/.test(location.hash) && !document.querySelector('.dialog-prepare'), null, { timeout: 60000 });
  await pa.getByRole('button', { name: 'New file' }).click();
  await pa.locator('.dialog-newfile .newfile-name input').fill('study.ipynb');
  await pa.keyboard.press('Enter');
  await pa.waitForSelector('.nb-cell .monaco-editor', { timeout: 20000 });
  await pa.waitForFunction(() => /Saved/.test(document.querySelector('.cowork-inline .sync-status')?.innerText || ''), null, { timeout: 20000 });
  await pa.locator('.cowork-inline').getByRole('button', { name: 'Share', exact: true }).click();
  await pa.locator('.share-find input').fill(B);
  await pa.locator('.share-find input').press('Enter');
  await pa.waitForFunction((u) => document.querySelector('.dialog-share')?.innerText.includes(`${u}@tandem.org`), B, { timeout: 10000 });
  await pa.keyboard.press('Escape');

  await pb.waitForSelector('.invite-card', { timeout: 40000 });
  await pb.getByRole('button', { name: 'Join project' }).click();
  await pb.waitForSelector('.monaco-editor, .file-sidebar, .sidebar', { timeout: 30000 });
  await pb.locator('.file-sidebar, .sidebar').getByText('study.ipynb', { exact: true }).first().click();
  await pb.waitForSelector('.nb-cell .monaco-editor', { timeout: 20000 });
  check(true, `${A} and ${B} both have study.ipynb open`);
  await pa.waitForTimeout(1500); // both live

  // 1. A types in the first cell, slowly: B sees the letters while A is still typing.
  await cellEditor(pa, 0).click();
  const word = 'total = sum(range(10))';
  const typing = pa.keyboard.type(word, { delay: 120 });
  const seenEarly = await waitCells(pb, (texts) => texts[0] && texts[0].length >= 4 && 'total = sum(range(10))'.startsWith(texts[0]), null, 8000).then(
    () => true,
    () => false
  );
  const partial = (await cells(pb))[0];
  await typing;
  check(seenEarly && partial.length < word.length, `B sees A’s letters in the cell while A types (B had “${partial}” before A finished)`);
  await waitCells(pb, (texts, w) => texts[0] === w, word);
  check(true, 'B’s cell ends with exactly what A typed');
  await pb.locator('.nb-cell').first().locator('.remote-label').first().waitFor({ timeout: 5000 }).catch(() => {});
  const label = await pb.locator('.nb-cell').first().locator('.remote-label').first().innerText().catch(() => '');
  check(label.includes(A), `A’s name shows at A’s caret in B’s cell (“${label}”)`);
  await pb.screenshot({ path: `${out}/nb-1-live.png` });

  // 2. A adds a cell; B sees it.
  await pa.locator('.nb-add').getByRole('button', { name: 'Code' }).last().click();
  await waitCells(pb, (texts) => texts.length === 2, null);
  check(true, 'a cell A adds appears for B');

  // 3. Both type at once, in different cells.
  await pa.waitForTimeout(800);
  await cellEditor(pa, 0).click();
  await pa.keyboard.press('Control+End');
  await cellEditor(pb, 1).click();
  await Promise.all([pa.keyboard.type('\nprint(total)', { delay: 60 }), pb.keyboard.type('mean = total / 10', { delay: 60 })]);
  const expected = [`${word}\nprint(total)`, 'mean = total / 10'];
  const same = async (p) => waitCells(p, (texts, e) => texts.length === 2 && texts[0] === e[0] && texts[1] === e[1], expected).then(() => true, () => false);
  const okA = await same(pa);
  const okB = await same(pb);
  check(okA && okB, `typing in two cells at once: both sides end the same${okA && okB ? '' : ` (A ${JSON.stringify(await cells(pa))}, B ${JSON.stringify(await cells(pb))})`}`);

  // 3b. Both type at once in the same cell: A at its end, B at its start.
  await cellEditor(pa, 0).click();
  await pa.keyboard.press('Control+End');
  await cellEditor(pb, 0).click();
  await pb.keyboard.press('Control+Home');
  await Promise.all([pa.keyboard.type('  # A', { delay: 60 }), pb.keyboard.type('# B\n', { delay: 60 })]);
  expected[0] = `# B\n${word}\nprint(total)  # A`;
  const sameCell = async (p) => waitCells(p, (texts, e) => texts[0] === e, expected[0]).then(() => true, () => false);
  const okA2 = await sameCell(pa);
  const okB2 = await sameCell(pb);
  check(okA2 && okB2, `typing in the same cell at once: both keep both${okA2 && okB2 ? '' : ` (A ${JSON.stringify((await cells(pa))[0])}, B ${JSON.stringify((await cells(pb))[0])})`}`);

  // 4. B removes the second cell; A sees it go.
  await pb.locator('.nb-cell').nth(1).click();
  await pb.locator('.nb-cell').nth(1).getByRole('button', { name: 'Delete cell' }).click();
  await waitCells(pa, (texts) => texts.length === 1, null);
  check(true, 'a cell B removes goes for A');
  await pa.screenshot({ path: `${out}/nb-2-after.png` });

  // 5. After saving and reloading: each cell once, nothing lost.
  for (const p of [pa, pb]) await p.waitForFunction(() => /Saved/.test(document.querySelector('.cowork-inline .sync-status')?.innerText || ''), null, { timeout: 20000 });
  await pb.waitForTimeout(1500);
  await pb.reload();
  await pb.waitForSelector('.file-sidebar, .sidebar', { timeout: 30000 });
  await pb.locator('.file-sidebar, .sidebar').getByText('study.ipynb', { exact: true }).first().click();
  await pb.waitForSelector('.nb-cell .monaco-editor', { timeout: 20000 });
  await waitCells(pb, (texts, e) => texts.length === 1 && texts[0] === e, expected[0]).then(
    () => check(true, 'after a reload: the notebook has its one cell, once, with all the typing'),
    async () => check(false, `after a reload: ${JSON.stringify(await cells(pb))}`)
  );

  check(errs.length === 0, `no page errors ${errs.join('; ')}`);
  await browser.close();
  console.log(failures ? `${failures} FAILED` : 'All notebook live checks passed.');
  process.exit(failures ? 1 : 0);
})().catch(async (e) => {
  console.error('FAILED', e.message);
  await pa?.screenshot({ path: `${out}/nb-failed-a.png` }).catch(() => {});
  await pb?.screenshot({ path: `${out}/nb-failed-b.png` }).catch(() => {});
  process.exit(1);
});
