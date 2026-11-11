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

// A failed check ends the test and shows the results panel (see the catch below).
function check(ok, message) {
  if (!ok) throw new Error(message);
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
  await put('pkgs.py', "import numpy\nimport stats\nfrom tabulate import tabulate\nprint(tabulate([['KL', 120]], headers=['city', 'price']))\n");
  const nbCells = [
    'x = 10',
    'print(x * 2.0)',
    "name = input('Name? ')\nprint('hi', name)",
    "from IPython.display import HTML\nHTML('<b>bold</b> text')",
    'i = 0\nwhile True:\n    i += 1',
    "import numpy as np\nimport pandas as pd\nimport matplotlib.pyplot as plt\ndf = pd.DataFrame({'x': np.arange(3), 'y': [2, 4, 6]})\nplt.plot(df.x, df.y)\nplt.show()\ndf",
  ];
  await put('nb.ipynb', JSON.stringify({
    cells: nbCells.map((source, i) => ({ id: `cell${i}`, cell_type: 'code', metadata: {}, source, execution_count: null, outputs: [] })),
    metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' } },
    nbformat: 4,
    nbformat_minor: 5,
  }));
  await put('complete.py', "clean = ' Python '.strip()\n");
  await put('q.sql', "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);\nINSERT INTO notes (body) VALUES ('hi'), ('there');\nSELECT count(*) AS n FROM notes;\n");
  await put('readdb.py', "import sqlite3\nc = sqlite3.connect('practice.db')\nprint('students', c.execute('select count(*) from students').fetchone()[0], 'notes', c.execute('select count(*) from notes').fetchone()[0])\n");
  await put('readcsv.py', "import csv\nrows = list(csv.reader(open('data.csv')))\nprint('rows', len(rows), rows[1])\n");
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
  // The last lines can land just after the Run button comes back.
  let text = '';
  for (let i = 0; i < 40; i++) {
    text = await output();
    if (text.includes('Your number: 21') && text.includes('42.0')) break;
    await page.waitForTimeout(250);
  }
  check(text.includes('Your number: 21') && text.includes('42.0'), `input(): typed 21, printed 42.0 (output: ${JSON.stringify(text)})`);

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
  // Generous: CI simulators can be slow; Stop always ends the run within 1.5 s of reaching the app.
  check(Date.now() - t0 < 10000, `Stop ended an endless loop in ${Date.now() - t0} ms`);

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

  // Add files…: files from elsewhere (any kind) are copied into the project.
  const picker = page.locator('.sidebar-inner input[type=file]');
  const csv = 'city,price\nKL,120\nPenang,95\n';
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  await picker.setInputFiles([
    { name: 'data.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) },
    { name: 'logo.png', mimeType: 'image/png', buffer: png },
  ]);
  await page.getByRole('treeitem', { name: 'logo.png' }).waitFor({ timeout: 20000 });
  check((await api('/api/file?path=data.csv')).text === csv, 'Add files…: a CSV is copied into the project, byte for byte');
  check((await api('/api/files')).files.some((f) => f.path === 'logo.png'), 'Add files…: an image is added too');
  await picker.setInputFiles([{ name: 'data.csv', mimeType: 'text/csv', buffer: Buffer.from('other') }]);
  await page.getByRole('treeitem', { name: 'data (2).csv' }).waitFor({ timeout: 20000 });
  check((await api('/api/file?path=data.csv')).text === csv, 'Add files…: a taken name becomes data (2).csv, nothing is overwritten');
  await page.getByRole('treeitem', { name: 'readcsv.py' }).click();
  await run.click();
  await run.waitFor({ timeout: 60000 });
  let csvOut = '';
  for (let i = 0; i < 40 && !csvOut.includes('rows 3'); i++) {
    csvOut = await output();
    await page.waitForTimeout(250);
  }
  check(csvOut.includes("rows 3 ['KL', '120']"), `Python reads the added CSV (output: ${JSON.stringify(csvOut)})`);

  // Notebooks: one Python per notebook, so state carries over between cells.
  await page.getByRole('treeitem', { name: 'nb.ipynb' }).click();
  await page.locator('.notebook .nb-cell').first().waitFor({ timeout: 20000 });
  const cellOut = (n) => page.locator('.nb-cell').nth(n).locator('.nb-outputs');
  const runCell = (n) => page.getByRole('button', { name: `Run cell ${n + 1}`, exact: true }).click();
  await runCell(0);
  await runCell(1);
  await cellOut(1).getByText('20.0').waitFor({ timeout: 120000 });
  check(true, 'notebook: x = 10, then print(x * 2.0) → 20.0');
  await page.getByRole('button', { name: 'Restart', exact: true }).click();
  await page.locator('.nb-kernel.is-idle').waitFor({ timeout: 120000 });
  await runCell(1);
  await cellOut(1).getByText(/NameError/).waitFor({ timeout: 60000 });
  check(true, 'notebook: after Restart, x is gone (NameError)');
  await runCell(0);
  await runCell(1);
  await cellOut(1).getByText('20.0').waitFor({ timeout: 60000 });
  check(true, 'notebook: run cell 1 again → 20.0');
  await runCell(2);
  await page.locator('.nb-input input').waitFor({ timeout: 60000 });
  await page.locator('.nb-input input').fill('Ada');
  await page.keyboard.press('Enter');
  await cellOut(2).getByText('hi Ada').waitFor({ timeout: 60000 });
  check((await cellOut(2).innerText()).includes('Name? Ada'), 'notebook: input() asks in the notebook');
  await runCell(3);
  await cellOut(3).locator('.nb-html b').waitFor({ timeout: 60000 });
  check(true, 'notebook: rich HTML output (IPython.display)');
  await runCell(4);
  await page.locator('.nb-cell').nth(4).locator('.nb-count', { hasText: '[*]' }).waitFor({ timeout: 30000 }).catch(async () => {
    throw new Error(`loop cell didn't start: kernel "${await page.locator('.nb-kernel').innerText()}", counts ${JSON.stringify(await page.locator('.nb-count').allInnerTexts())}`);
  });
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: 'Interrupt' }).click();
  await cellOut(4).getByText(/KeyboardInterrupt/).waitFor({ timeout: 20000 });
  check(true, 'notebook: Interrupt stops an endless loop');
  if (FULL) {
    await runCell(5);
    await cellOut(5).locator('table').waitFor({ timeout: 180000 }).catch(async () => {
      throw new Error(`no table; cell output: ${(await cellOut(5).innerText().catch(() => '(none)')).slice(0, 1500)}`);
    });
    await cellOut(5).locator('img').waitFor({ timeout: 30000 });
    check(true, 'notebook: pandas table and matplotlib chart below the cell');
  }
  await page.waitForTimeout(1500);
  const savedNb = JSON.parse((await api('/api/file?path=nb.ipynb')).text);
  check(savedNb.nbformat === 4 && savedNb.cells[1].outputs.some((o) => String(o.text).includes('20.0')), 'notebook: saved as .ipynb with its outputs');
  await page.getByRole('treeitem', { name: 'stats.py' }).click();

  // Packages: what the code imports, what Pyodide provides, and pure-Python
  // packages from PyPI kept with the project.
  await page.locator('.runtime-status').click();
  await page.getByRole('button', { name: 'Packages…' }).click();
  await page.getByText('Imported by your code, but not installed').waitFor({ timeout: 60000 });
  const missingText = await page.locator('.env-missing').allInnerTexts();
  check(missingText.length === 1 && missingText[0].includes('tabulate'), `Packages: tabulate is missing; numpy (Pyodide) and stats (the project's own) aren't (${JSON.stringify(missingText)})`);
  check((await page.locator('.env-packages').innerText()).includes('numpy'), 'Packages: numpy is listed as included with Pyodide');
  if (FULL) {
    await page.locator('.env-missing input').first().check();
    await page.getByRole('button', { name: 'Install selected…' }).click();
    check((await page.locator('.env-command').innerText()) === 'micropip.install(["tabulate"])', 'Packages: the exact install is shown before it runs');
    await page.getByRole('button', { name: 'Install', exact: true }).click();
    await page.locator('.env-job-head').getByText(/Installed tabulate\.|didn’t|couldn’t|failed|PyPI|compiled/).waitFor({ timeout: 240000 });
    const jobText = await page.locator('.env-job-head').innerText();
    check(jobText.includes('Installed tabulate.'), `Packages: tabulate installed from PyPI (${jobText} / ${(await page.locator('.env-log').innerText().catch(() => '')).slice(-600)})`);
    const kept = JSON.parse((await api('/api/file?path=.tandem/packages.json')).text);
    check(kept.pypi.length === 1 && kept.pypi[0].name === 'tabulate' && kept.pypi[0].file.endsWith('.whl'), `Packages: only the tabulate wheel is kept with the project (${JSON.stringify(kept).slice(0, 300)})`);
    check(kept.pyodide.length === 0, `Packages: no Pyodide packages recorded for a pure-Python install (${JSON.stringify(kept.pyodide).slice(0, 200)})`);
    await page.locator('.dialog-env [aria-label=Close]').click();
    await page.getByRole('treeitem', { name: 'pkgs.py' }).click();
    await run.click();
    await run.waitFor({ timeout: 60000 });
    let pkgOut = '';
    for (let i = 0; i < 40 && !pkgOut.includes('KL'); i++) {
      pkgOut = await output();
      await page.waitForTimeout(250);
    }
    check(pkgOut.includes('city') && pkgOut.includes('KL') && !pkgOut.includes("couldn't load"), `Python uses the installed package in a fresh run (output: ${JSON.stringify(pkgOut)})`);
  } else {
    await page.locator('.dialog-env [aria-label=Close]').click();
  }

  // Code completion (Jedi inside Python on iPad): what can follow "clean.", with notes.
  if (FULL) {
    // Its own file: typing here doesn't change files other checks use.
    await page.getByRole('treeitem', { name: 'complete.py' }).click();
    await page.locator('.monaco-editor .view-lines').first().click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('clean.');
    await page.locator('.suggest-widget.visible .monaco-list-row').first().waitFor({ timeout: 120000 });
    const rows = (await page.locator('.suggest-widget.visible .monaco-list-row').allInnerTexts()).join(' | ');
    // The list is alphabetical and only the visible rows exist on the page.
    check(/capitalize|casefold|center|count/.test(rows), `completion: str methods after "clean." (${rows.slice(0, 160)})`);
    await page.keyboard.press('Escape');
  }

  // SQL workspace: real SQLite in the page; the database is a file in the project.
  await page.getByRole('radio', { name: 'SQL' }).click();
  await page.getByRole('button', { name: 'Create the practice database' }).click();
  await page.locator('.db-table-name', { hasText: 'students' }).waitFor({ timeout: 60000 });
  await page.locator('.db-table-name', { hasText: 'students' }).click();
  await page.locator('.sql-grid tbody tr').first().waitFor({ timeout: 20000 });
  check((await page.locator('.sql-grid tbody tr').count()) === 12, 'SQL: practice database created; students table shows its 12 rows');
  await page.getByRole('treeitem', { name: 'q.sql' }).click();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page.locator('.db-table-name', { hasText: 'notes' }).waitFor({ timeout: 20000 });
  const metas = await page.locator('.sql-meta').allInnerTexts();
  check(metas.length === 3 && metas[1].startsWith('2 rows changed') && metas[2].startsWith('1 row'), `SQL: CREATE, INSERT and SELECT ran (${metas.join(' ; ')})`);
  await page.getByRole('radio', { name: 'Python' }).click();
  await page.getByRole('treeitem', { name: 'readdb.py' }).click();
  await run.click();
  await run.waitFor({ timeout: 60000 });
  let dbOut = '';
  for (let i = 0; i < 40 && !dbOut.includes('students'); i++) {
    dbOut = await output();
    await page.waitForTimeout(250);
  }
  check(dbOut.includes('students 12 notes 2'), `SQL: Python's sqlite3 reads the saved database (output: ${JSON.stringify(dbOut)})`);

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
