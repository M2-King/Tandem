// Tandem Cowork live mode: an owner shares their AI; a teammate without one
// uses the assistant with it.
//
//   node supabase/tests/shared-ai-e2e.cjs <A: app URL> <B: runtime URL> <screenshot dir>
//
// A (the owner) can use any live-mode build; B uses the desktop runtime
// (`tandem serve … --ui <live-mode build>`) with no AI of its own. Against the
// local stand-in (local-supabase.mjs, which runs the cowork-ai Edge Function
// and allows its http calls) with 004_cowork_shared_ai.sql applied. A fake
// OpenAI-compatible provider runs on this computer.
//
// Checks: A shares from Share › AI for everyone and sees only the key's last
// characters; B, who has an AI of their own, is asked from AI settings
// whether to use the shared AI in this project, and then does; B's question is answered
// by A's AI with A's key, about the shared project's files; a proposed change
// can be reviewed; B sees how many requests are left and the limit holds;
// after A stops sharing, B's assistant says no AI is connected.

const { chromium } = require('playwright');
const http = require('node:http');
const crypto = require('node:crypto');

const [APP_A, RUNTIME_B, out] = process.argv.slice(2);
const tag = crypto.randomBytes(3).toString('hex');
const A = `aishare_${tag}`, B = `aiuse_${tag}`;
const PASS = `pw-${crypto.randomBytes(9).toString('base64url')}`;
const KEY = `sk-shared-${crypto.randomBytes(10).toString('hex')}`;
let failures = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAILED: ') + msg); if (!ok) failures++; };
const shared = (u) => `${u.replace(/\/?$/, '/')}#/shared`;
const bodyHas = (p, text, timeout = 20000) => p.waitForFunction((t) => document.body.innerText.replace(/ /g, ' ').includes(t), text, { timeout });

// The fake provider (OpenAI-compatible chat completions).
const seen = [];
let nextReply = 'main.py prints a greeting.';
const provider = http.createServer((req, res) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => {
    const body = JSON.parse(data || '{}');
    seen.push({ path: req.url, auth: req.headers.authorization, body });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ model: body.model, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: nextReply } }] }));
  });
});

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
async function ask(p, text) {
  const before = await p.locator('.assistant-messages .msg-body, .assistant-messages .msg-error, .assistant-messages .proposal-head').count();
  await p.locator('.composer-input').fill(text);
  await p.keyboard.press('Enter');
  await p.waitForFunction(
    (n) => document.querySelectorAll('.assistant-messages .msg-body, .assistant-messages .msg-error, .assistant-messages .proposal-head').length > n,
    before,
    { timeout: 30000 }
  );
  await p.waitForTimeout(400);
}
const lastAnswer = (p) =>
  p.evaluate(() => {
    const all = [...document.querySelectorAll('.assistant-messages .msg-body, .assistant-messages .msg-error')];
    return (all.at(-1)?.innerText || '').replace(/\s+/g, ' ');
  });
// B's own AI, set through the runtime (as AI settings does).
const ownAI = (p, body) =>
  p.evaluate(async (b) => {
    const token = JSON.parse(document.getElementById('tandem-runtime').textContent).token;
    const r = await fetch('/api/ai/settings', { method: 'PUT', headers: { 'x-tandem-token': token, 'content-type': 'application/json' }, body: JSON.stringify(b) });
    return r.ok;
  }, body);
const badge = (p) => p.locator('.assistant-inner .panel-header .sim-tag').first().innerText().catch(() => '');
const openAssistant = async (p) => {
  if (!(await p.locator('.composer-input').count())) {
    await p.getByRole('button', { name: /Assistant/ }).first().click().catch(() => {});
  }
  await p.locator('.composer-input').waitFor({ timeout: 10000 });
};

let pa, pb;
(async () => {
  await new Promise((r) => provider.listen(0, '127.0.0.1', r));
  const FAKE = `http://127.0.0.1:${provider.address().port}/v1`;
  const browser = await chromium.launch();
  pa = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
  pb = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
  const errs = [];
  for (const p of [pa, pb]) p.on('pageerror', (e) => errs.push(e.message));

  await signUp(pa, APP_A, A);
  await signUp(pb, RUNTIME_B, B);
  check(await ownAI(pb, { provider: 'openai', base_url: FAKE, model: 'own-model', api_key: 'sk-own-key-refused', activate: true }), 'B has an AI of their own (OpenAI-compatible, own-model)');
  await pb.reload();
  await pb.waitForSelector('.shared-page .shared-list, .shared-page .shared-empty', { timeout: 20000 });
  check(true, `owner ${A}, teammate ${B} (desktop runtime)`);

  // A: a project with a file, B invited.
  await pa.getByRole('button', { name: 'New shared project' }).first().click();
  await pa.locator('.dialog-new-shared input').fill(`AI ${tag}`);
  await pa.keyboard.press('Enter');
  await pa.waitForFunction(() => /^#\/shared\/[0-9a-f-]{36}$/.test(location.hash) && !document.querySelector('.dialog-prepare'), null, { timeout: 60000 });
  await pa.getByRole('button', { name: 'New file' }).click();
  await pa.locator('.dialog-newfile .newfile-name input').fill('main.py');
  await pa.keyboard.press('Enter');
  await pa.waitForSelector('.monaco-editor .view-lines');
  await pa.locator('.monaco-editor .view-lines').first().click();
  await pa.keyboard.type('print("hello from the shared project")\n');
  await pa.waitForFunction(() => /Saved/.test(document.querySelector('.cowork-inline .sync-status')?.innerText || ''), null, { timeout: 20000 });
  await pa.locator('.cowork-inline').getByRole('button', { name: 'Share', exact: true }).click();
  await pa.locator('.share-find input').fill(B);
  await pa.locator('.share-find input').press('Enter');
  await pa.waitForFunction((u) => document.querySelector('.dialog-share')?.innerText.includes(`${u}@tandem.org`), B, { timeout: 10000 });

  // A shares their AI.
  const section = pa.locator('.ai-share');
  check((await section.innerText()).includes('Share your AI with this project'), 'Share shows “Share your AI with this project” to the owner');
  await section.getByRole('button', { name: 'Share your AI' }).click();
  await section.getByRole('radio', { name: 'OpenAI-compatible' }).click();
  await section.getByLabel('Model').fill('gpt-shared-test');
  await section.getByLabel('API address').fill(FAKE);
  await section.getByLabel('API key').fill(KEY);
  await section.getByLabel('Requests per person per day').fill('3');
  await section.getByLabel('For the whole project per day').fill('50');
  await section.getByLabel('Also allow (optional)').fill('Also help with statistics questions for our course.');
  await pa.screenshot({ path: `${out}/1-owner-shares.png` });
  await section.getByRole('button', { name: 'Share with this project' }).click();
  await pa.waitForSelector('.ai-share-card:not(.is-empty)', { timeout: 10000 });
  const card = (await pa.locator('.ai-share-card').innerText()).replace(/\s+/g, ' ');
  check(/You share an OpenAI-compatible model · gpt-shared-test/.test(card) && card.includes(`Key ends in ${KEY.slice(-4)}`) && card.includes('3 requests a day each and 50 for the project'), `the owner sees: “${card.slice(0, 160)}…”`);
  check(card.includes('Also allowed: Also help with statistics questions for our course.'), '…and the “Also allow” rule');
  check(!(await pa.content()).includes(KEY), 'the key isn’t anywhere on the owner’s page after saving');
  await pa.screenshot({ path: `${out}/2-owner-shared.png` });
  await pa.keyboard.press('Escape');
  await pa.waitForSelector('.dialog-share', { state: 'detached', timeout: 5000 });
  check(true, 'after saving, Escape still closes Share (focus stays in the dialog)');

  // B joins and opens main.py: the assistant uses the shared AI.
  await pb.waitForSelector('.invite-card', { timeout: 40000 });
  await pb.getByRole('button', { name: 'Join project' }).click();
  await pb.waitForSelector('.monaco-editor .view-lines', { timeout: 60000 });
  await pb.locator('.file-sidebar, .sidebar').getByText('main.py', { exact: true }).first().click();
  await openAssistant(pb);
  await pb.waitForFunction(() => /own-model/.test(document.querySelector('.assistant-inner .panel-header')?.innerText || ''), null, { timeout: 15000 });
  check(true, 'with an AI of their own, B’s assistant uses it at first');

  // AI settings asks which AI to use in this project.
  await pb.locator('.assistant-inner .panel-header').getByRole('button', { name: 'AI settings' }).click();
  const choice = pb.locator('.dialog-ai-choice');
  await choice.waitFor({ timeout: 5000 });
  const choiceText = (await choice.innerText()).replace(/\s+/g, ' ');
  check(choiceText.includes('Your leader has already shared an AI setup. Do you want to use it in this project?') && choiceText.includes(`${A} shares gpt-shared-test`), `AI settings asks: “${choiceText.slice(0, 110)}…”`);
  check(!(await pb.locator('.dialog-ai-settings, .dialog-ai').count()), '…before the AI settings themselves');
  await pb.waitForTimeout(500); // the dialog eases in
  await pb.screenshot({ path: `${out}/3a-member-choice.png` });
  await choice.getByRole('button', { name: /Use the shared AI/ }).click();
  await pb.waitForFunction(() => /gpt-shared-test/.test(document.querySelector('.assistant-inner .panel-header')?.innerText || ''), null, { timeout: 5000 });
  check(true, `after “Use the shared AI”, B’s assistant shows the shared model: “${await badge(pb)}”`);

  // An edit typed just now: saved before asking, so the shared AI sees it.
  await pb.locator('.monaco-editor .view-lines').first().click();
  await pb.keyboard.press('Control+End');
  await pb.keyboard.type('# note from B');
  await ask(pb, 'Explain main.py');
  const answer = await lastAnswer(pb);
  check(answer.includes('main.py prints a greeting.'), 'B’s question is answered by the shared AI');
  const req = seen.at(-1);
  check(req?.auth === `Bearer ${KEY}` && req?.path === '/v1/chat/completions', '…the provider got the owner’s key, added on the server');
  const sent = JSON.stringify(req?.body.messages || []);
  check(sent.includes('hello from the shared project') && sent.includes('Explain main.py'), '…about the shared project’s main.py, read on the server');
  check(sent.includes('# note from B'), '…including the edit typed just before asking (saved first)');
  const system = req?.body.messages[0];
  check(system?.role === 'system' && /inside Tandem/.test(system.content) && /for this project only/.test(system.content), '…with the server’s instructions and the topic rule');
  check(/statistics questions for our course/.test(system?.content || ''), '…and the owner’s “Also allow”');
  check(!(await pb.content()).includes(KEY), 'the key never reaches the teammate’s page');
  await pb.screenshot({ path: `${out}/3-member-answer.png` });

  // A proposed change can be reviewed as usual.
  nextReply = 'Added a name.\n\n<tandem-file path="main.py">\nname = "team"\nprint("hello from the shared project", name)\n</tandem-file>\n\n- Print a name\n';
  await ask(pb, 'Print a name too');
  check((await pb.locator('.assistant-messages .proposal-head').count()) > 0, 'a change proposed by the shared AI shows for review');

  // What's left today, in Share.
  await pb.locator('.cowork-inline').getByRole('button', { name: 'Share', exact: true }).click();
  await pb.waitForSelector('.ai-share-card', { timeout: 10000 });
  const memberCard = (await pb.locator('.ai-share-card').innerText()).replace(/\s+/g, ' ');
  check(memberCard.includes(`${A} shares an OpenAI-compatible model`) && memberCard.includes('used 2 of 3 requests today'), `B sees: “${memberCard.slice(0, 120)}…”`);
  check(!(await pb.locator('.ai-share').getByRole('button', { name: /Change|Stop sharing|Share your AI/ }).count()), '…and can’t change or stop it');
  await pb.screenshot({ path: `${out}/4-member-share.png` });
  await pb.keyboard.press('Escape');

  // The limit.
  nextReply = 'Third answer.';
  await ask(pb, 'One more question');
  check((await lastAnswer(pb)).includes('Third answer.'), 'third request of 3: answered');
  await ask(pb, 'And another');
  const limited = await lastAnswer(pb);
  check(/used today.s 3 requests on the shared AI/.test(limited), `fourth request: “${limited.slice(0, 110)}”`);
  await pb.screenshot({ path: `${out}/5-member-limit.png` });

  // The choice can be changed back: "Use my own AI" opens AI settings.
  await pb.locator('.assistant-inner .panel-header').getByRole('button', { name: 'AI settings' }).click();
  await pb.locator('.dialog-ai-choice .ai-choice.is-current').filter({ hasText: 'Use the shared AI' }).waitFor({ timeout: 5000 });
  check(true, 'AI settings shows the shared AI as the one in use');
  await pb.locator('.dialog-ai-choice').getByRole('button', { name: /Use my own AI/ }).click();
  await pb.getByRole('dialog', { name: /AI settings/ }).waitFor({ timeout: 5000 });
  check(/own-model/.test(await badge(pb)), '“Use my own AI” goes back to own-model and opens AI settings');
  await pb.keyboard.press('Escape');
  // B's own AI is removed again (the runtime is shared by the tests).
  await ownAI(pb, { provider: 'openai', activate: false });
  await pb.reload();
  await pb.waitForSelector('.monaco-editor .view-lines', { timeout: 30000 });
  await openAssistant(pb);

  // A stops sharing; B's assistant goes back to "No AI connected".
  await pa.locator('.cowork-inline').getByRole('button', { name: 'Share', exact: true }).click();
  await pa.waitForFunction((u) => /3 \/ 3/.test([...document.querySelectorAll('.ai-share-usage-table tbody tr')].find((r) => r.innerText.includes(u))?.innerText || ''), B, { timeout: 15000 });
  const usage = (await pa.locator('.ai-share-usage').innerText()).replace(/\s+/g, ' ');
  check(usage.includes('Used today: 3 of 50 for the project') && /Counts only/.test(usage), `the owner sees who used it: “${usage.slice(0, 150)}…”`);
  await pa.screenshot({ path: `${out}/6-owner-usage.png` });
  await pa.locator('.ai-share').getByRole('button', { name: 'Stop sharing' }).click();
  await pa.waitForSelector('.ai-share-card.is-empty', { timeout: 10000 });
  check(true, 'the owner stops sharing');
  await pb.evaluate(() => window.dispatchEvent(new Event('focus')));
  await pb.waitForFunction(() => /No AI connected/.test(document.querySelector('.assistant-inner .panel-header')?.innerText || ''), null, { timeout: 15000 });
  await ask(pb, 'Still there?');
  check(/Share your AI/.test(await lastAnswer(pb)), 'B’s assistant then says no AI is connected, and that an owner can share one');

  check(errs.length === 0, `no page errors ${errs.join('; ')}`);
  await browser.close();
  provider.close();
  console.log(failures ? `${failures} FAILED` : 'All shared-AI checks passed.');
  process.exit(failures ? 1 : 0);
})().catch(async (e) => {
  console.error('FAILED', e.message);
  await pa?.screenshot({ path: `${out}/failed-a.png` }).catch(() => {});
  await pb?.screenshot({ path: `${out}/failed-b.png` }).catch(() => {});
  process.exit(1);
});
