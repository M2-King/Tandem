// ipywidgets in a notebook, end to end: the built app served by the real
// runtime, a project .venv with ipykernel and ipywidgets.
//
//   npm run build && node e2e/notebook-widgets.cjs <runtime python> <screenshot dir>
//
// Checks: a cell's controls are drawn (text, dropdowns, slider, checkbox in
// a VBox, the description width kept); what the person chooses reaches
// Python (the next cell prints it); a button's on_click writes into an
// Output widget; interact() redraws its output when its slider moves.

const { chromium } = require('playwright');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const [PY, OUT = os.tmpdir()] = process.argv.slice(2);
const ROOT = path.resolve(__dirname, '..');
let failures = 0;
const check = (ok, msg) => {
  console.log((ok ? 'ok   ' : 'FAILED: ') + msg);
  if (!ok) failures++;
};

const code = (src, id) => ({ cell_type: 'code', id, metadata: {}, execution_count: null, outputs: [], source: [src] });
const SETTINGS = `#@title Your settings
import ipywidgets as w
from IPython.display import display

style = {"description_width": "140px"}
group_w = w.Text(value="Team Name", description="Group name", style=style)
model_w = w.Dropdown(options=["resnet18", "mobilenet_v3_small", "efficientnet_b0", "resnet50"],
                     value="resnet18", description="Model", style=style)
epochs_w = w.IntSlider(value=5, min=1, max=15, step=1, description="Epochs", style=style)
freeze_w = w.Checkbox(value=False, description="Freeze brain", style=style)
lr_w = w.Dropdown(options=[0.003, 0.001, 0.0003, 0.0001], value=0.0003,
                  description="Learning rate", style=style)
display(w.VBox([group_w, model_w, epochs_w, freeze_w, lr_w]))
print("Choose your settings, then run the next step.")`;

(async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-widgets-'));
  execFileSync(PY, ['-m', 'venv', path.join(project, '.venv')]);
  const venvPy = path.join(project, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  execFileSync(venvPy, ['-m', 'pip', 'install', '-q', 'ipykernel', 'ipywidgets'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(project, 'study.ipynb'), JSON.stringify({
    cells: [
      code(SETTINGS, 'c1'),
      code('print("CHOSEN", group_w.value, model_w.value, epochs_w.value, freeze_w.value, lr_w.value)', 'c2'),
      code('out = w.Output()\nb = w.Button(description="Train", button_style="primary")\ndef go(_):\n    with out:\n        print("training", model_w.value)\nb.on_click(go)\ndisplay(w.HBox([b]), out)', 'c3'),
      code('from ipywidgets import interact\n@interact(n=(1, 10))\ndef square(n=3):\n    print("square", n * n)', 'c4'),
    ],
    metadata: {}, nbformat: 4, nbformat_minor: 5,
  }));
  const runtime = spawn(PY, ['-m', 'tandem_runtime', 'serve', project, '--port', '0', '--ui', path.join(ROOT, 'dist'), '--print-url'], {
    cwd: path.join(ROOT, 'runtime'),
    env: { ...process.env, TANDEM_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-wcfg-')) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const url = await new Promise((resolve, reject) => {
    runtime.stdout.on('data', (d) => {
      const m = /(http:\/\/127\.0\.0\.1:\d+\/\S*)/.exec(String(d));
      if (m) resolve(m[1]);
    });
    setTimeout(() => reject(new Error('runtime did not start')), 60000);
  });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  globalThis.lastPage = page;
  page.on('pageerror', (e) => console.log('page error:', e.message));
  await page.goto(url);
  await page.locator('.file-row', { hasText: 'study.ipynb' }).click();
  await page.waitForSelector('.nb-cell');
  const cell = (i) => page.locator('.nb-cell').nth(i);
  const runCell = async (i) => {
    await cell(i).locator('.nb-run').click();
    await page.waitForFunction((n) => !document.querySelectorAll('.nb-cell')[n]?.querySelector('.nb-run[disabled]'), i, { timeout: 120000 });
  };

  // The settings cell: its controls, not "VBox(children=…)".
  await runCell(0);
  const root = cell(0).locator('.nbw-root');
  await root.waitFor({ timeout: 60000 });
  check((await cell(0).locator('.nb-outputs').innerText()).includes('VBox(children') === false, 'the controls are drawn, not the VBox(...) text');
  const labels = await root.locator('.nbw-label').allInnerTexts();
  check(['Group name', 'Model', 'Epochs', 'Learning rate'].every((l) => labels.includes(l)), `labels: ${labels.filter(Boolean).join(', ')}`);
  const width = await root.locator('.nbw-label', { hasText: 'Model' }).evaluate((e) => getComputedStyle(e).width);
  check(width === '140px', `description_width kept (${width})`);
  await page.screenshot({ path: path.join(OUT, 'widgets-settings.png') });

  // Choose: a name, a model, 8 epochs, freeze, a learning rate.
  const name = root.locator('input[type="text"]');
  await name.fill('Rocket');
  await name.press('Tab');
  await root.locator('select').first().selectOption({ label: 'efficientnet_b0' });
  const slider = root.locator('input[type="range"]');
  await slider.focus();
  for (let i = 0; i < 3; i++) await slider.press('ArrowRight');
  await root.locator('input[type="checkbox"]').check();
  await root.locator('select').nth(1).selectOption({ label: '0.001' });
  check((await root.locator('.nbw-readout').innerText()) === '8', 'the slider shows 8');
  await page.waitForTimeout(500);
  await runCell(1);
  const chosen = await cell(1).locator('.nb-outputs').innerText();
  check(/CHOSEN Rocket efficientnet_b0 8 True 0\.001/.test(chosen), `Python sees the choices (“${chosen.trim()}”)`);

  // A button whose on_click prints into an Output widget.
  await runCell(2);
  await cell(2).getByRole('button', { name: 'Train' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.nb-cell')[2]?.querySelector('.nbw-output')?.innerText.includes('training efficientnet_b0'), null, { timeout: 30000 });
  check(true, 'the button ran its on_click; the output went into the Output widget');

  // interact(): moving its slider redraws the output.
  await runCell(3);
  await page.waitForFunction(() => document.querySelectorAll('.nb-cell')[3]?.innerText.includes('square 9'), null, { timeout: 30000 });
  const s2 = cell(3).locator('input[type="range"]');
  await s2.focus();
  await s2.press('ArrowRight');
  await s2.press('ArrowRight');
  await page.waitForFunction(() => /square 25/.test(document.querySelectorAll('.nb-cell')[3]?.innerText || ''), null, { timeout: 30000 }).then(
    () => check(true, 'interact(): moving the slider to 5 shows square 25'),
    async () => check(false, `interact(): output after moving the slider (“${(await cell(3).innerText()).replace(/\s+/g, ' ').slice(0, 200)}”)`)
  );
  check(!/square 9/.test(await cell(3).innerText()), 'interact() replaced its old output');
  await page.screenshot({ path: path.join(OUT, 'widgets-all.png'), fullPage: true });

  await browser.close();
  runtime.kill();
  console.log(failures ? `${failures} FAILED` : 'All notebook widget checks passed.');
  process.exit(failures ? 1 : 0);
})().catch(async (e) => {
  console.error('FAILED:', e);
  await globalThis.lastPage?.screenshot({ path: path.join(OUT, 'widgets-failed.png') }).catch(() => {});
  process.exit(1);
});
