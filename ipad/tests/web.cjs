// End-to-end check of Tandem for iPad: the real UI, real Python (Pyodide),
// through the app's local API. Runs against the reference server
// (ipad/devserver.py) in Chromium, or against the iPad app in the simulator
// in WebKit.
//
//   node ipad/tests/web.cjs <base url> [chromium|webkit] [--full]
//
// --full: Pyodide's packages are available (numpy, matplotlib).

const playwright = require('playwright');
const http = require('node:http');

const [base, engine = 'chromium'] = process.argv.slice(2);
let currentPage = null; // for the failure report
const FULL = process.argv.includes('--full');
const KEY = 'sk-ant-test-0123456789abcdef';

function check(ok, message) {
  if (!ok) {
    console.error(`FAILED: ${message}`);
    process.exit(1);
  }
  console.log(`ok   ${message}`);
}

// A fake Anthropic API: checks the key the app added, returns a fix.
function fakeAnthropic() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const auth = [req.headers['x-api-key'], String(req.headers.authorization || '').replace(/^Bearer /, '')];
      seen.push({ path: req.url, auth, body });
      const json = (code, data) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (!auth.includes(KEY)) return json(401, { type: 'error', error: { type: 'authentication_error', message: 'bad key' } });
      if (req.method === 'GET') {
        return json(200, { data: [{ type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-01-01T00:00:00Z' }], has_more: false, first_id: 'claude-opus-5-5', last_id: 'claude-opus-5-5' });
      }
      const text = 'Loop until DONE.\n\n<tandem-file path="ask.py">\nwhile True:\n    raw = input("Number or DONE: ")\n    if raw == "DONE":\n        break\n    print(float(raw) * 2)\n</tandem-file>\n\n- Loop until DONE\n';
      json(200, { id: 'msg_1', type: 'message', role: 'assistant', model: JSON.parse(body).model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
    });
  });
  return new Promise((resolve) => server.listen(18092, '127.0.0.1', () => resolve({ server, seen })));
}

(async () => {
  const fake = await fakeAnthropic();
  const browser = await playwright[engine].launch();
  const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
  currentPage = page;
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const bodies = [];
  page.on('response', async (r) => {
    try {
      bodies.push(await r.text());
    } catch {}
  });
  await page.goto(base);
  const token = await page.evaluate(() => JSON.parse(document.getElementById('tandem-runtime').textContent).token);
  const api = (path, method = 'GET', body) =>
    page.evaluate(
      async ([path, method, body, token]) => {
        const r = await fetch(path, { method, headers: { 'x-tandem-token': token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
        return r.json();
      },
      [path, method, body, token]
    );

  check(await page.evaluate(() => crossOriginIsolated), 'page is cross-origin isolated (shared memory for input and the debugger)');
  // A fresh project for this test.
  const name = `Test ${Date.now() % 100000}`;
  await api('/api/projects', 'POST', { name, create: true });
  const put = (path, text) => api('/api/file', 'POST', { path, text });
  await put('ask.py', "n = float(input('Your number: '))\nprint(n * 2)\n");
  await put('stats.py', 'def average(xs):\n    total = sum(xs)\n    return total / len(xs)\n\nprices = [120, 95, 140]\nmean = average(prices)\nprint(f"Mean: {mean}")\n');
  await put('writes.py', "open('out.txt', 'w').write('from python')\nprint('wrote')\n");
  await put('loop.py', 'i = 0\nwhile True:\n    i += 1\n');
  if (FULL) await put('chart.py', 'import numpy as np\nimport pandas as pd\nimport matplotlib.pyplot as plt\ndata = pd.DataFrame({"x": np.arange(1, 6), "y": [2, 4, 6, 8, 10]})\nprint(data)\nplt.plot(data["x"], data["y"])\nplt.title("Runtime Test")\nplt.show()\n');
  await page.reload();
  await page.locator('.runtime-status.tone-up').waitFor({ timeout: 120000 });
  check((await page.locator('.runtime-status').innerText()).startsWith('Python 3.'), `runtime: ${await page.locator('.runtime-status').innerText()}`);

  const run = page.getByRole('button', { name: 'Run', exact: true });
  const output = () => page.locator('.output-lines').first().innerText();

  await page.getByRole('treeitem', { name: 'ask.py' }).click();
  await run.click();
  await page.locator('.line-partial', { hasText: 'Your number' }).waitFor({ timeout: 60000 });
  await page.locator('.run-input-field').fill('21');
  await page.keyboard.press('Enter');
  await run.waitFor({ timeout: 60000 });
  check((await output()).includes('Your number: 21') && (await output()).includes('42.0'), 'input(): typed 21, printed 42.0');

  await run.click();
  await page.getByRole('button', { name: 'End input' }).click();
  await page.getByRole('button', { name: 'Ask AI to fix' }).waitFor({ timeout: 60000 });
  check((await page.locator('.callout-error').innerText()).includes('EOFError in ask.py, line 1'), 'End input: real EOFError with its line');

  await page.getByRole('treeitem', { name: 'writes.py' }).click();
  await run.click();
  await run.waitFor({ timeout: 60000 });
  await page.waitForTimeout(500);
  const files = (await api('/api/files')).files.map((f) => f.path);
  check(files.includes('out.txt'), 'files the program writes are saved to the project');

  await page.getByRole('treeitem', { name: 'loop.py' }).click();
  await run.click();
  await page.waitForTimeout(2000);
  const t0 = Date.now();
  await page.getByRole('button', { name: 'Stop' }).first().click();
  await run.waitFor({ timeout: 15000 });
  check(Date.now() - t0 < 5000, `Stop ended an endless loop in ${Date.now() - t0} ms`);

  await page.getByRole('treeitem', { name: 'stats.py' }).click();
  await page.getByRole('button', { name: 'More ways to run' }).click();
  await page.getByRole('menuitem', { name: /Step through/ }).click();
  const bar = page.locator('.banner-session');
  const at = (n) => bar.getByText(new RegExp(`Next line: ${n}\\b|line ${n}\\b`)).waitFor({ timeout: 60000 });
  await at(1);
  await bar.getByRole('button', { name: 'Next' }).click();
  await at(5);
  await bar.getByRole('button', { name: 'Next' }).click();
  await at(6);
  await bar.getByRole('button', { name: 'Into' }).click();
  await at(2);
  await bar.getByRole('button', { name: 'Next' }).click();
  await at(3);
  await page.getByRole('tab', { name: /Variables/ }).click();
  check((await page.locator('.var-group').first().innerText()).includes('355'), 'Step through: into average(), local total = 355');
  await bar.getByRole('button', { name: 'Out' }).click();
  await at(7);
  await bar.getByRole('button', { name: 'Continue' }).click();
  await bar.getByText(/Finished/).waitFor({ timeout: 60000 });
  check(true, 'Step through: out and continue to the end');
  await bar.getByRole('button', { name: 'Close' }).click();

  if (FULL) {
    await page.getByRole('tab', { name: 'Output' }).click();
    await page.getByRole('treeitem', { name: 'chart.py' }).click();
    await run.click();
    await run.waitFor({ timeout: 180000 });
    check((await output()).includes('4  5  10'), 'numpy + pandas: DataFrame printed');
    await page.getByRole('tab', { name: /Charts/ }).click();
    await page.locator('.figure-image').first().waitFor({ timeout: 20000 });
    check(true, 'matplotlib: real chart shown');
  }

  // Wallpaper: the person's photo is kept by the app and drawn lined up with
  // the screen, following the window (the app reports where it is).
  await page.evaluate(async (token) => {
    const c = document.createElement('canvas');
    c.width = 200;
    c.height = 150;
    c.getContext('2d').fillRect(0, 0, 200, 150);
    const image = c.toDataURL('image/jpeg');
    await fetch('/api/wallpaper', { method: 'PUT', headers: { 'x-tandem-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ image, name: 'wall.jpg', luminance2: 0.1, width: 200, height: 150 }) });
  }, token);
  await page.reload();
  const place = (g) => page.evaluate((g) => { window.__tandemScreen = g; window.dispatchEvent(new Event('tandem-screen')); }, g);
  await place({ sw: 1180, sh: 820, x: 150, y: 120, w: 900, h: 600 });
  await page.waitForFunction(() => document.body.dataset.wallpaperFit === 'screen', null, { timeout: 20000 });
  const wallVars = () => page.evaluate(() => [document.body.style.getPropertyValue('--wallpaper-size'), document.body.style.getPropertyValue('--wallpaper-position')]);
  check(JSON.stringify(await wallVars()) === JSON.stringify(['1180px 885px', '-150px -152.5px']), 'wallpaper photo kept by the app, lined up with the screen');
  await place({ sw: 1180, sh: 820, x: 0, y: 0, w: 1180, h: 820 });
  check((await wallVars())[1] === '0px -32.5px' && (await page.evaluate(() => document.documentElement.dataset.windowed)) === 'false', 'wallpaper follows the window (full screen)');

  // AI: the app adds the key; the page never sees it.
  await api('/api/ai/settings', 'PUT', { provider: 'anthropic', base_url: 'http://127.0.0.1:18092', api_key: KEY, model: 'claude-opus-5-5', activate: true });
  await page.reload();
  await page.locator('.ai-model-tag').waitFor({ timeout: 60000 });
  await page.getByRole('treeitem', { name: 'ask.py' }).click();
  await run.click();
  await page.getByRole('button', { name: 'End input' }).click();
  await page.getByRole('button', { name: 'Ask AI to fix' }).click();
  await page.getByRole('button', { name: /^Accept/ }).first().waitFor({ timeout: 60000 });
  await page.getByRole('button', { name: /^Accept/ }).first().click();
  await page.waitForTimeout(1500);
  const fixed = await api('/api/file?path=ask.py');
  check(fixed.text.includes('Number or DONE'), 'Ask AI to fix → review → accept: file updated');
  check(fake.seen.some((s) => s.path.startsWith('/v1/messages') && s.auth.includes(KEY)), 'the app sent the key to the provider');
  check(!bodies.some((b) => b.includes(KEY)), 'the key never reached the page');
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  await browser.close();
  fake.server.close();
  console.log('\nAll iPad checks passed.');
})().catch(async (e) => {
  console.error('FAILED:', e.message.split('\n').slice(0, 3).join(' / '));
  if (currentPage) {
    await currentPage.getByRole('tab', { name: 'Output' }).click({ timeout: 3000 }).catch(() => {});
    console.error('--- results panel ---\n' + (await currentPage.locator('.results').innerText({ timeout: 3000 }).catch(() => '(none)')).slice(0, 3000));
  }
  process.exit(1);
});
