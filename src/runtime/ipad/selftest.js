// CI only (TANDEM_SELFTEST=1 in the iPad simulator): run real Python through
// the same backend the UI uses, and report what happened to the app, which
// writes it where the CI job can read it. Nothing here runs for normal use.

const SCRIPT = `import numpy as np
import matplotlib.pyplot as plt
name = input("name? ")
print("hello", name, int(np.arange(4).sum()))
plt.plot([1, 2, 3])
plt.title("Selftest")
plt.show()
`;
const DEBUG = `def f(x):
    y = x + 1
    return y
z = f(1)
print(z)
`;

function runOnce(backend, path, mode, { input } = {}) {
  return new Promise((resolve) => {
    const pauses = [];
    let handle = null;
    const timer = setTimeout(() => {
      handle?.stop();
      resolve({ status: 'timeout', pauses });
    }, 180000);
    handle = backend.startRun({
      path,
      mode,
      onOutput: () => {},
      onPartial: (text) => {
        if (input && text.endsWith('? ')) {
          handle.input(input);
          input = null;
        }
      },
      onPaused: (p) => {
        pauses.push(`${p.function}:${p.line}`);
        handle.command(pauses.length < 4 ? 'step' : 'continue');
      },
      onFinish: (r) => {
        clearTimeout(timer);
        resolve({ status: r.status, exitCode: r.exitCode, output: r.output.map((l) => l.text).join('\n'), figures: r.figures.map((f) => f.title), variables: r.variables.map((v) => v.name), pauses });
      },
    });
  });
}

export async function runSelftest(backend, token) {
  const report = { isolated: window.crossOriginIsolated, userAgent: navigator.userAgent };
  try {
    report.status = await backend.status();
    await backend.writeFile('selftest.py', SCRIPT).catch(() => backend.createFile('selftest.py', SCRIPT));
    await backend.createFile('selftest_debug.py', DEBUG).catch(() => backend.writeFile('selftest_debug.py', DEBUG));
    report.run = await runOnce(backend, 'selftest.py', 'run', { input: 'tandem' });
    report.debug = await runOnce(backend, 'selftest_debug.py', 'step');
    // The app reports where its window is on the screen (wallpaper alignment).
    for (let i = 0; i < 20 && !window.__tandemScreen; i++) await new Promise((r) => setTimeout(r, 250));
    report.screen = window.__tandemScreen || null;
    report.ok =
      report.isolated &&
      report.run.status === 'success' &&
      report.run.output.includes('hello tandem 6') &&
      report.run.figures.includes('Selftest') &&
      report.debug.status === 'success' &&
      report.debug.pauses.includes('f:2') &&
      report.screen?.sw > 0 &&
      report.screen?.w > 0;
  } catch (e) {
    report.ok = false;
    report.error = String(e?.message || e);
  }
  await fetch('/api/selftest', { method: 'POST', headers: { 'x-tandem-token': token, 'content-type': 'application/json' }, body: JSON.stringify(report) });
  return report;
}
