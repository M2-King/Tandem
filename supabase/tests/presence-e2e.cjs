// Tandem Cowork live mode: who's online and live cursors (Supabase Realtime).
//
//   node supabase/tests/presence-e2e.cjs <app url> <supabase url> <publishable key> <screenshot dir>
//
// The app is a live-mode build (vite preview) against the local stand-in
// (local-supabase.mjs, which includes Realtime) or staging with
// 002_cowork_realtime.sql applied and Realtime set to private channels only.
// Creates new accounts with a random password each run. Needs Playwright
// with Chromium and @supabase/supabase-js (a dependency of the app).
//
// Checks: B sees A online in the right file, and A's cursor in the same file
// within 1 s; when A switches files B's view follows; A's cursor stays while
// A's app is hidden for a few seconds, while A types for 30 s, and comes back
// after A's network drops and after A reopens the project five times; when A
// closes the project, A disappears; a member's client can join the project's
// channel and a non-member's join is refused.

const { chromium } = require('playwright');
const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');

const [BASE, SUPABASE_URL, SUPABASE_KEY, out] = process.argv.slice(2);
const APP = `${BASE.replace(/\/?$/, '/')}#/shared`;
const tag = crypto.randomBytes(3).toString('hex');
const A = `cura_${tag}`, B = `curb_${tag}`, C = `curc_${tag}`;
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
async function newFile(p, name, text) {
  await p.getByRole('button', { name: 'New file' }).click();
  await p.locator('.dialog-newfile .newfile-name input').fill(name);
  await p.keyboard.press('Enter');
  await p.waitForSelector('.monaco-editor .view-lines');
  await p.locator('.monaco-editor .view-lines').first().click();
  await p.keyboard.press('Control+A');
  await p.keyboard.type(text);
}
const openFile = (p, name) => p.locator('.file-sidebar, .sidebar').getByText(name, { exact: true }).first().click();
const waitStatus = (p, re) =>
  p.waitForFunction((src) => new RegExp(src).test(document.querySelector('.cowork-inline .sync-status')?.innerText || ''), re.source, { timeout: 20000 });
// The text of the line where `who`'s caret is drawn in this page's editor, or null.
const caretLine = (p, who) =>
  p.evaluate((name) => {
    const label = [...document.querySelectorAll('.remote-label')].find((l) => l.textContent === name);
    if (!label) return null;
    const caret = [...document.querySelectorAll('.monaco-editor .view-line')].find((l) => l.querySelector('.remote-caret'));
    return caret ? caret.textContent.replace(/ /g, ' ') : '';
  }, who);
const peopleLabel = (p) => p.locator('.cowork-inline .avatar-stack').getAttribute('aria-label');

(async () => {
  const browser = await chromium.launch();
  const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const pa = await ctxA.newPage();
  const pb = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const errs = [];
  for (const p of [pa, pb]) p.on('pageerror', (e) => errs.push(process.env.DEBUG_WS ? `${e.message}\n${e.stack}` : e.message));
  if (process.env.DEBUG_WS) {
    const T0 = Date.now();
    const ts = () => ((Date.now() - T0) / 1000).toFixed(1).padStart(6);
    for (const [who, p] of [['A', pa], ['B', pb]]) {
      p.on('websocket', (ws) => {
        const show = (dir) => (f) => {
          const t = typeof f.payload === 'string' ? f.payload : '';
          if (/"(broadcast|presence|presence_diff|system|phx_close|phx_error)"/.test(t) && !/presence_state/.test(t)) console.log(ts(), who, dir, t.replace(/"access_token":"[^"]+"/, '').slice(0, 220));
        };
        ws.on('framesent', show('>>'));
        ws.on('framereceived', show('<<'));
      });
    }
  }

  await signUp(pa, A);
  await signUp(pb, B);
  if (process.env.DEBUG_WS) {
    for (const [who, p] of [['A', pa], ['B', pb]]) {
      await p.evaluate(() => localStorage.setItem('tandem.coworkDebug', '1'));
      p.on('console', (m) => /cowork live/.test(m.text()) && console.log('  ', who, m.text()));
    }
  }
  await pa.getByRole('button', { name: 'New shared project' }).first().click();
  await pa.locator('.dialog-new-shared input').fill(`Cursors ${tag}`);
  await pa.keyboard.press('Enter');
  await pa.waitForFunction(() => /^#\/shared\/[0-9a-f-]{36}$/.test(location.hash), null, { timeout: 15000 });
  const projectId = (await pa.evaluate(() => location.hash)).split('/').pop();
  await newFile(pa, 'b.py', 'print("other file")');
  await waitStatus(pa, /Saved/);
  await newFile(pa, 'a.py', 'first = 1\nsecond = 2\nthird = 3');
  await waitStatus(pa, /Saved/);
  await pa.locator('.cowork-inline').getByRole('button', { name: 'Share' }).click();
  await pa.locator('.share-find input').fill(B);
  await pa.locator('.share-find input').press('Enter');
  await pa.waitForFunction((u) => document.querySelector('.dialog-share')?.innerText.includes(`${u}@tandem.org`), B, { timeout: 10000 });
  await pa.keyboard.press('Escape');
  await pb.waitForSelector('.invite-card', { timeout: 40000 });
  await pb.getByRole('button', { name: 'Join project' }).click();
  await pb.waitForSelector('.monaco-editor .view-lines', { timeout: 15000 });
  await openFile(pb, 'a.py');
  // A's new member list arrives with the next reload; presence needs B to be a member there.
  await pa.waitForFunction((u) => document.querySelector('.cowork-inline .avatar-stack')?.getAttribute('aria-label')?.includes(u), B, { timeout: 15000 });

  // Who's online, and where.
  await pb.waitForFunction((u) => new RegExp(`${u}, in a\\.py`).test(document.querySelector('.cowork-inline .avatar-stack')?.getAttribute('aria-label') || ''), A, { timeout: 10000 });
  check(true, `B: ${(await peopleLabel(pb)).replace('People in this project: ', '')}`);
  check((await pb.locator('.cowork-inline .avatar.is-online').count()) >= 1, 'B: A’s avatar has the online dot');

  // A moves the cursor; B sees it within 1 s.
  await pa.locator('.monaco-editor .view-line', { hasText: 'second = 2' }).click();
  await pa.keyboard.press('End');
  let t0 = Date.now();
  await pb.waitForFunction((name) => {
    const label = [...document.querySelectorAll('.remote-label')].find((l) => l.textContent === name);
    const line = [...document.querySelectorAll('.monaco-editor .view-line')].find((l) => l.querySelector('.remote-caret'));
    return label && line && line.textContent.replace(/\u00a0/g, ' ').includes('second = 2');
  }, A, { timeout: 5000 });
  let took = Date.now() - t0;
  check(took <= 1000, `B sees A’s cursor on “second = 2” in ${took} ms`);
  await pb.screenshot({ path: `${out}/1-cursor.png` });

  // Moving again, a few times quickly (≤ 10 a second are sent): B follows to the last spot.
  for (const key of ['ArrowDown', 'ArrowUp', 'ArrowDown']) await pa.keyboard.press(key);
  t0 = Date.now();
  await pb.waitForFunction(() => [...document.querySelectorAll('.monaco-editor .view-line')].find((l) => l.querySelector('.remote-caret'))?.textContent.replace(/\u00a0/g, ' ').includes('third = 3'), null, { timeout: 5000 });
  took = Date.now() - t0;
  check(took <= 1000, `…and follows it to “third = 3” in ${took} ms`);

  // A selects a word: B sees the selection.
  await pa.keyboard.press('Home');
  await pa.keyboard.press('Shift+End');
  await pb.waitForSelector('.monaco-editor .remote-sel', { timeout: 3000 }).then(
    () => check(true, 'B sees A’s selection'),
    () => check(false, 'B sees A’s selection')
  );

  // A switches files: B's view updates.
  await openFile(pa, 'b.py');
  t0 = Date.now();
  await pb.waitForFunction((u) => new RegExp(`${u}, in b\\.py`).test(document.querySelector('.cowork-inline .avatar-stack')?.getAttribute('aria-label') || ''), A, { timeout: 5000 });
  check(Date.now() - t0 <= 1500, `A opens b.py: B shows “in b.py” (${Date.now() - t0} ms)`);
  check((await caretLine(pb, A)) === null, 'A’s cursor is no longer drawn in B’s a.py');
  await openFile(pb, 'b.py');
  await pa.locator('.monaco-editor .view-lines').first().click();
  await pa.keyboard.press('End');
  await pb.waitForFunction((name) => [...document.querySelectorAll('.remote-label')].some((l) => l.textContent === name), A, { timeout: 3000 }).then(
    () => check(true, 'B on b.py: A’s cursor is there'),
    () => check(false, 'B on b.py: A’s cursor is there')
  );

  // Notebooks: A works in a cell; B sees which cell (the file arrives with the next reload).
  await pa.getByRole('button', { name: 'New file' }).click();
  await pa.locator('.dialog-newfile .newfile-name input').fill('nb.ipynb');
  await pa.keyboard.press('Enter');
  await pa.locator('.nb-cell').first().locator('.view-lines').click();
  await pa.keyboard.type('x = 1');
  await waitStatus(pa, /Saved/);
  await pb.locator('.file-sidebar, .sidebar').getByText('nb.ipynb', { exact: true }).first().waitFor({ timeout: 15000 });
  await openFile(pb, 'nb.ipynb');
  await pa.keyboard.press('End');
  await pb.waitForFunction((u) => [...document.querySelectorAll('.nb-cell.has-peer')].some((c) => (c.getAttribute('aria-label') || '').includes(`${u} editing`)), A, { timeout: 5000 }).then(
    () => check(true, 'notebook: B sees which cell A is in'),
    () => check(false, 'notebook: B sees which cell A is in')
  );
  await openFile(pa, 'b.py');
  await openFile(pb, 'b.py');

  // A's app is hidden briefly (switching apps): A stays, for up to 2 minutes.
  const setHidden = (p, hidden) =>
    p.evaluate((h) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
      document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);
  const hasCursor = (p, name) => p.evaluate((n) => [...document.querySelectorAll('.remote-label')].some((l) => l.textContent === n), name);
  // Every second for `secs` seconds: is A's cursor drawn for B? ('#' yes, '.' no)
  const watch = async (secs, during) => {
    let row = '';
    for (let i = 0; i < secs; i++) {
      if (during) await during(i);
      row += (await hasCursor(pb, A)) ? '#' : '.';
      await pa.waitForTimeout(1000);
    }
    return row;
  };
  await pa.locator('.monaco-editor .view-line', { hasText: 'other file' }).first().click();
  await pa.keyboard.press('Home');
  await pb.waitForFunction((name) => [...document.querySelectorAll('.remote-label')].some((l) => l.textContent === name), A, { timeout: 8000 }).catch(async (e) => {
    console.log('   B people:', await peopleLabel(pb), '| A live:', await pa.locator('.live-status').first().innerText().catch(() => '-'));
    await pb.screenshot({ path: `${out}/debug-b.png` });
    await pa.screenshot({ path: `${out}/debug-a.png` });
    throw e;
  });
  await setHidden(pa, true);
  let row = await watch(8);
  check(!row.includes('.'), `A’s app hidden for 8 s: A’s cursor stays for B ${row}`);
  await setHidden(pa, false);

  // Typing for a while (presence updates are rate-limited by Supabase; cursors go as broadcasts).
  row = await watch(30, async () => pa.keyboard.type('ab'));
  check(!row.includes('.'), `A types for 30 s: A’s cursor stays for B ${row}`);
  check(/Live/.test(await pa.locator('.live-status').first().innerText()), 'A’s Live indicator says Live');

  // A's network drops for 6 s: A rejoins and B sees A's cursor again.
  await ctxA.setOffline(true);
  await pa.waitForTimeout(6000);
  await ctxA.setOffline(false);
  await pa.waitForFunction(() => /^Live$/.test(document.querySelector('.live-status')?.innerText || ''), null, { timeout: 30000 }).then(
    () => check(true, 'A back online after a network drop: Live'),
    () => check(false, 'A back online after a network drop: Live')
  );
  await pa.keyboard.press('Home');
  await pb.waitForFunction((name) => [...document.querySelectorAll('.remote-label')].some((l) => l.textContent === name), A, { timeout: 15000 }).then(
    () => check(true, 'after the network drop B sees A’s cursor again'),
    () => check(false, 'after the network drop B sees A’s cursor again')
  );

  // A leaves and reopens the project five times: still live, B sees A's cursor.
  const projectHash = await pa.evaluate(() => location.hash);
  for (let i = 0; i < 5; i++) {
    await pa.evaluate(() => (location.hash = '#/shared'));
    await pa.waitForSelector('.shared-page', { timeout: 10000 });
    await pa.evaluate((h) => (location.hash = h), projectHash);
    await pa.waitForSelector('.monaco-editor .view-lines', { timeout: 15000 }).catch(async (e) => {
      await pa.screenshot({ path: `${out}/debug-reopen-a.png` });
      console.log('   reopen', i, 'page errors:', errs.join(' | '));
      throw e;
    });
  }
  await pa.waitForFunction(() => /^Live$/.test(document.querySelector('.live-status')?.innerText || ''), null, { timeout: 15000 }).catch(() => {});
  await openFile(pa, 'b.py');
  await pa.locator('.monaco-editor .view-line', { hasText: 'other file' }).first().click();
  await pa.keyboard.press('End');
  await pb.waitForFunction((name) => [...document.querySelectorAll('.remote-label')].some((l) => l.textContent === name), A, { timeout: 10000 }).then(
    () => check(true, 'after reopening the project 5 times B sees A’s cursor'),
    () => check(false, 'after reopening the project 5 times B sees A’s cursor')
  );

  // A closes the project.
  await pa.evaluate(() => (location.hash = '#/shared'));
  await pa.waitForSelector('.shared-page', { timeout: 10000 });
  t0 = Date.now();
  await pb.waitForFunction((name) => ![...document.querySelectorAll('.remote-label')].some((l) => l.textContent === name), A, { timeout: 5000 });
  await pb.waitForFunction((u) => !new RegExp(`${u}, (in|online)`).test(document.querySelector('.cowork-inline .avatar-stack')?.getAttribute('aria-label') || ''), A, { timeout: 5000 });
  check(true, `A closes the project: A’s cursor and online dot disappear for B (${Date.now() - t0} ms)`);
  await pb.screenshot({ path: `${out}/2-after-close.png` });

  // Realtime Authorization: members join the private channel, others can't.
  const join = async (username, password, topic) => {
    const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
    const { error } = await sb.auth.signInWithPassword({ email: `${username}@${DOMAIN}`, password });
    if (error) throw error;
    await sb.realtime.setAuth();
    const result = await new Promise((resolve) => {
      const ch = sb.channel(topic, { config: { private: true } });
      const timer = setTimeout(() => resolve({ status: 'TIMED_OUT' }), 10000);
      ch.subscribe((status, err) => {
        if (status === 'SUBSCRIBED' || status === 'CHANNEL_ERROR') {
          clearTimeout(timer);
          resolve({ status, message: err?.message });
        }
      });
    });
    await sb.removeAllChannels();
    await sb.auth.signOut();
    return result;
  };
  const sbC = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
  const { error: cErr } = await sbC.auth.signUp({ email: `${C}@${DOMAIN}`, password: PASS, options: { data: { username: C } } });
  if (cErr) throw cErr;
  const member = await join(B, PASS, `cowork:${projectId}`);
  check(member.status === 'SUBSCRIBED', `B (member) joins cowork:${projectId.slice(0, 8)}…: ${member.status}`);
  const outsider = await join(C, PASS, `cowork:${projectId}`);
  check(outsider.status === 'CHANNEL_ERROR', `C (not a member) is refused: ${outsider.status}${outsider.message ? ` (${outsider.message})` : ''}`);

  check(errs.length === 0, `no page errors ${errs.join('; ')}`);
  await browser.close();
  console.log(failures ? `${failures} FAILED` : 'All presence checks passed.');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('FAILED', e.message);
  process.exit(1);
});
