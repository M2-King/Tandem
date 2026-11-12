// Tandem Cowork live mode: "Keep me signed in on this device", and the
// projects page as the start page.
//
//   node supabase/tests/session-e2e.cjs <app url> <screenshot dir>
//
// The app is a live-mode build with VITE_COWORK_START=shared (as staging is
// built) served at <app url>, against the local stand-in or staging. In a
// browser the sign-in is kept in localStorage (the Windows, Mac and iPad apps
// keep it encrypted by the system: desktop/secureStore.js, SecureStore.swift).
//
// Checks: the app starts on sign-in; signed in with "Keep me signed in", a
// reload (a new launch) opens the projects page signed in, with the shared
// project and this device's project, without asking again; signing out
// forgets it; signed in without "Keep me signed in", a reload asks again and
// nothing was kept.

const { chromium } = require('playwright');
const crypto = require('node:crypto');

const [BASE, out] = process.argv.slice(2);
const ROOT = BASE.replace(/\/?$/, '/');
const tag = crypto.randomBytes(3).toString('hex');
const PASS = `pw-${crypto.randomBytes(12).toString('base64url')}`;
let failures = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAILED: ') + msg); if (!ok) failures++; };
const launch = async (p) => {
  await p.goto('about:blank');
  await p.goto(ROOT);
  await p.waitForSelector('#signin-username, .shared-page .shared-list, .shared-page .shared-empty', { timeout: 20000 });
};
const onSignIn = (p) => p.locator('#signin-username').isVisible();
const kept = (p) => p.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('tandem.cowork.')));

(async () => {
  const browser = await chromium.launch();
  const errs = [];

  // 1. Keep me signed in (the default).
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 820 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(e.message));
  await launch(p);
  check(await onSignIn(p), 'the app starts on sign-in (projects page, signed out)');
  check(await p.locator('.signin-remember input').isChecked(), '“Keep me signed in on this device” is on by default');
  await p.getByRole('tab', { name: 'Create account' }).click();
  await p.locator('#signin-username').fill(`keep_${tag}`);
  await p.locator('#signin-password').fill(PASS);
  await p.locator('#signin-confirm').fill(PASS);
  await p.keyboard.press('Enter');
  await p.waitForSelector('.shared-page .shared-list, .shared-page .shared-empty', { timeout: 20000 });
  await p.getByRole('button', { name: 'New shared project' }).first().click();
  await p.locator('.dialog-new-shared input').fill(`Kept ${tag}`);
  await p.keyboard.press('Enter');
  await p.waitForFunction(() => /^#\/shared\/[0-9a-f-]{36}$/.test(location.hash), null, { timeout: 15000 });
  check((await kept(p)).length > 0, 'the sign-in is kept on this device');

  // A new launch: the start page, signed in, with the project.
  await launch(p);
  await p.waitForSelector('.shared-page .shared-list', { timeout: 20000 }).catch(() => {});
  check(!(await onSignIn(p)), 'after a new launch: signed in without asking again');
  await p.waitForSelector('#device-heading', { timeout: 10000 }).catch(() => {});
  await p.waitForTimeout(1200); // the page eases in
  const page = (await p.locator('.shared-page').innerText().catch(() => '')) || '';
  check(page.includes(`Kept ${tag}`), 'the start page shows the shared project');
  check(/on this device/i.test(page), '…and this device’s project');
  await p.screenshot({ path: `${out}/start-page.png` });

  // Signing out forgets it.
  await p.getByRole('button', { name: 'Sign out' }).first().click();
  await p.waitForSelector('#signin-username', { timeout: 15000 });
  check((await kept(p)).length === 0, 'signing out forgets the kept sign-in');
  await launch(p);
  check(await onSignIn(p), 'after signing out, a new launch asks to sign in');

  // 2. Without "Keep me signed in".
  const ctx2 = await browser.newContext({ viewport: { width: 1300, height: 820 } });
  const q = await ctx2.newPage();
  q.on('pageerror', (e) => errs.push(e.message));
  await launch(q);
  await q.getByRole('tab', { name: 'Create account' }).click();
  await q.locator('#signin-username').fill(`once_${tag}`);
  await q.locator('#signin-password').fill(PASS);
  await q.locator('#signin-confirm').fill(PASS);
  await q.locator('.signin-remember input').uncheck();
  await q.keyboard.press('Enter');
  await q.waitForSelector('.shared-page .shared-list, .shared-page .shared-empty', { timeout: 20000 });
  check((await kept(q)).length === 0, 'without “Keep me signed in” nothing is kept');
  await launch(q);
  check(await onSignIn(q), '…and a new launch asks to sign in');

  check(errs.length === 0, `no page errors ${errs.join(' | ')}`);
  await browser.close();
  console.log(failures ? `${failures} FAILED` : 'All sign-in checks passed.');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('FAILED', e.message);
  process.exit(1);
});
