// The assistant acting in Tandem, end to end: the built app served by the
// real runtime, a project with its own .venv, and a stand-in AI model
// (OpenAI-compatible, scripted) that asks Tandem to install a package and
// run a file, then reads the results.
//
//   npm run build && node e2e/assistant-actions.cjs <runtime python> <screenshot dir>
//
// Checks, in each of the three modes:
//   Ask each time: Install and Run wait for clicks; after both, the results
//     go back by themselves and the model's next answer arrives.
//   Auto for safe actions: Install waits; Run starts by itself after it.
//   Auto for everything: nothing to click; installed, run, answered.
// The Terminal (Ctrl+`): a shell in the project, the project's .venv active.
// And: the model is told the environment (the missing package, where it is
// imported) and Tandem's tools; the results it reads say what happened.

const { chromium } = require('playwright');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const [PY, OUT = os.tmpdir()] = process.argv.slice(2);
const ROOT = path.resolve(__dirname, '..');
let failures = 0;
const check = (ok, msg) => {
  console.log((ok ? 'ok   ' : 'FAILED: ') + msg);
  if (!ok) failures++;
};

// ---------------------------------------------------------------- the stand-in model
const seen = [];
function reply(messages) {
  const last = messages.at(-1)?.content || '';
  if (last.includes('Run nb.ipynb')) return 'Cell 3 divides by zero.';
  if (last.includes('Request: run my notebook')) return 'Running cells 1–3.\n<tandem-run path="nb.ipynb" cells="1-3"/>';
  if (last.includes('From Tandem (not the developer): Results of what you asked Tandem to do')) {
    return /Run main\.py: finished/.test(last) && /Install six: installed/.test(last)
      ? 'It works now: main.py printed the six version.'
      : 'It still fails; see the results.';
  }
  return 'main.py imports six, which isn’t installed in the project’s .venv.\n\n<tandem-install packages="six"/>\n<tandem-run path="main.py"/>';
}
const model = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const data = JSON.parse(body || '{}');
    seen.push(data);
    const text = reply(data.messages || []);
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }));
    }, 300);
  });
});

(async () => {
  await new Promise((r) => model.listen(0, '127.0.0.1', r));
  const modelUrl = `http://127.0.0.1:${model.address().port}/v1`;

  // A project with its own environment, where six isn't installed.
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-ai-actions-'));
  fs.writeFileSync(path.join(project, 'main.py'), 'import six\nprint("six", six.__version__)\n');
  execFileSync(PY, ['-m', 'venv', path.join(project, '.venv')]);
  const venvPy = path.join(project, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-ai-config-'));

  const runtime = spawn(PY, ['-m', 'tandem_runtime', 'serve', project, '--port', '0', '--ui', path.join(ROOT, 'dist'), '--print-url'], {
    cwd: path.join(ROOT, 'runtime'),
    env: { ...process.env, TANDEM_CONFIG_DIR: config },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const url = await new Promise((resolve, reject) => {
    let out = '';
    runtime.stdout.on('data', (d) => {
      out += d;
      const m = /(http:\/\/127\.0\.0\.1:\d+\/\S*)/.exec(out);
      if (m) resolve(m[1]);
    });
    runtime.on('exit', (code) => reject(new Error(`runtime exited (${code})`)));
    setTimeout(() => reject(new Error('runtime did not start')), 60000);
  });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  globalThis.lastPage = page;
  page.on('pageerror', (e) => console.log('page error:', e.message));
  await page.goto(url);
  await page.waitForSelector('.assistant-inner', { timeout: 30000 });
  // Connect the stand-in model (AI settings, through the runtime's API).
  const saved = await page.evaluate(async (base) => {
    const token = JSON.parse(document.getElementById('tandem-runtime').textContent).token;
    const r = await fetch('/api/ai/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-tandem-token': token },
      body: JSON.stringify({ provider: 'openai', base_url: base, api_key: 'sk-test-0123456789abcdef', model: 'stand-in', activate: true }),
    });
    return r.status;
  }, modelUrl);
  check(saved === 200, 'the stand-in model is connected');
  await page.reload();
  await page.waitForSelector('.assistant-inner', { timeout: 30000 });

  const composer = page.locator('.assistant-inner textarea');
  const ask = async (text) => {
    await composer.fill(text);
    await composer.press('Enter');
  };
  const card = (name) => page.locator('.ai-action', { hasText: name }).last();
  const state = (name) => card(name).locator('.ai-action-state').innerText();
  const setMode = async (label) => {
    await page.locator('.ai-mode').click();
    await page.getByRole('menuitemradio', { name: new RegExp(label) }).click();
  };
  const uninstallSix = () => execFileSync(venvPy, ['-m', 'pip', 'uninstall', '-y', '-q', 'six'], { stdio: 'ignore' });
  const finalAnswer = () =>
    page.waitForFunction(() => [...document.querySelectorAll('.msg-assistant .msg-body')].some((e) => e.innerText.includes('It works now')), null, { timeout: 90000 });
  const answers = () => page.locator('.msg-assistant .msg-body', { hasText: 'It works now' }).count();

  // ---- Ask each time
  check((await page.locator('.ai-mode').innerText()).includes('Ask first'), 'the assistant asks first by default');
  await ask('Install what my project needs and run it');
  console.log('     asked'); await card('Install six').locator('button', { hasText: 'Install' }).waitFor({ timeout: 30000 });
  const sent = JSON.stringify(seen.at(-1));
  check(sent.includes('six (package six) in main.py') && sent.includes('<tandem-install') && sent.includes('Environment: Python'),
    'the model was told the missing package (six, imported in main.py), the environment and Tandem’s tools');
  check((await state('Run main.py')) === 'After the step above.', 'Ask each time: Run waits behind Install');
  await page.screenshot({ path: path.join(OUT, 'ai-actions-ask.png') });
  await card('Install six').locator('button', { hasText: 'Install' }).click();
  await card('Run main.py').locator('button', { hasText: 'Run' }).waitFor({ timeout: 120000 });
  check((await state('Install six')) === 'Installed.', 'Ask each time: six installed after the click');
  await card('Run main.py').locator('button', { hasText: 'Run' }).click();
  await finalAnswer();
  check(/finished \(exit code 0\)/.test(await state('Run main.py')), `Ask each time: main.py ran (“${await state('Run main.py')}”)`);
  check((await page.locator('.msg-results').count()) === 1, 'the results went back to the model by themselves, and it answered');
  const results = seen.at(-1).messages.at(-1).content;
  check(/Install six: installed/.test(results) && /six 1\./.test(results), 'the results it read: installed, and main.py’s output');

  // ---- Auto for safe actions
  uninstallSix();
  await setMode('Auto for safe');
  await ask('Again please');
  await card('Install six').locator('button', { hasText: 'Install' }).last().waitFor({ timeout: 30000 });
  check((await page.locator('.ai-action.is-pending', { hasText: 'Run main.py' }).count()) >= 1, 'Auto for safe actions: Install still waits for a click');
  await card('Install six').locator('button', { hasText: 'Install' }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.msg-assistant .msg-body')].filter((e) => e.innerText.includes('It works now')).length >= 2, null, { timeout: 180000 });
  check((await answers()) === 2, 'Auto for safe actions: after Install, main.py ran by itself and the model answered');

  // ---- Auto for everything
  uninstallSix();
  await setMode('Auto for everything');
  await ask('Once more');
  await page.waitForFunction(() => [...document.querySelectorAll('.msg-assistant .msg-body')].filter((e) => e.innerText.includes('It works now')).length >= 3, null, { timeout: 180000 });
  check((await answers()) === 3, 'Auto for everything: installed, ran and answered with no clicks');
  check((await page.locator('.ai-mode').innerText()).includes('Auto: all'), 'the mode shows in the panel');
  await page.screenshot({ path: path.join(OUT, 'ai-actions-auto.png') });

  // ---- The Terminal (Ctrl+`): a shell in the project folder, its .venv active.
  await page.keyboard.press('Control+Backquote');
  await page.locator('.terminal-view .xterm').waitFor({ timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('.terminal-env')?.innerText === '.venv', null, { timeout: 30000 });
  await page.waitForTimeout(800); // the prompt
  await page.locator('.terminal-view .xterm').click();
  await page.keyboard.type('python -c "import sys, six; print(\'TERM-PREFIX=\' + sys.prefix)"');
  await page.keyboard.press('Enter');
  const termText = () => page.evaluate(() => document.querySelector('.terminal-view .xterm-rows')?.innerText || '');
  await page.waitForFunction(() => /TERM-PREFIX=\S/.test(document.querySelector('.terminal-view .xterm-rows')?.innerText || ''), null, { timeout: 30000 });
  const prefix = /^TERM-PREFIX=(\S+)/m.exec((await termText()).replace(/\u00a0/g, ' '))?.[1];
  check(prefix === path.join(project, '.venv'), `the terminal’s python is the project’s .venv (${prefix})`);
  await page.screenshot({ path: path.join(OUT, 'terminal.png') });
  // Hidden and shown again: the same shell, with what it printed.
  await page.getByRole('tab', { name: 'Output' }).click();
  await page.getByRole('tab', { name: 'Terminal' }).click();
  check((await termText()).includes('TERM-PREFIX='), 'switching tabs keeps the shell and what it printed');

  // ---- A notebook: some of its cells, run in its kernel; the error comes back.
  execFileSync(venvPy, ['-m', 'pip', 'install', '-q', 'ipykernel'], { stdio: 'ignore' });
  const nb = (src) => ({ cell_type: 'code', metadata: {}, execution_count: null, outputs: [], source: [src] });
  fs.writeFileSync(path.join(project, 'nb.ipynb'), JSON.stringify({
    cells: [nb('import six'), nb('print("six is", six.__version__)'), nb('1 / 0'), nb('print("never")')],
    metadata: {}, nbformat: 4, nbformat_minor: 5,
  }));
  await page.reload();
  await page.waitForSelector('.assistant-inner', { timeout: 30000 });
  await ask('run my notebook');
  await page.waitForFunction(() => [...document.querySelectorAll('.msg-assistant .msg-body')].some((e) => e.innerText.includes('Cell 3 divides by zero')), null, { timeout: 120000 });
  const nbState = await state('Run nb.ipynb');
  check(/error in cell 3: ZeroDivisionError/.test(nbState), `the notebook’s cells 1–3 ran in its kernel; the error was reported (“${nbState}”)`);
  const nbResults = seen.at(-1).messages.at(-1).content.split('From Tandem (not the developer):')[1] || '';
  check(/six is 1\./.test(nbResults) && /ZeroDivisionError/.test(nbResults) && !/never/.test(nbResults),
    'the model read the cells’ outputs and the error (cell 4 not run)');
  check((await page.locator('.nb-cell').count()) === 4, 'the notebook is open while it runs');
  await page.screenshot({ path: path.join(OUT, 'ai-actions-notebook.png') });

  await browser.close();
  runtime.kill();
  model.close();
  console.log(failures ? `${failures} FAILED` : 'All assistant action checks passed.');
  process.exit(failures ? 1 : 0);
})().catch(async (e) => {
  console.error('FAILED:', e);
  await globalThis.lastPage?.screenshot({ path: path.join(OUT, 'ai-actions-failed.png') }).catch(() => {});
  process.exit(1);
});
