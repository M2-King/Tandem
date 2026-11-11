// Tandem on iPad: the same interface as the desktop's local backend, with
// Python running in the page (Pyodide, in a worker) instead of a separate
// runtime process. Files and AI settings go to the iPad app's own local
// server (127.0.0.1 only), which keeps project files in the Files app and
// API keys in the iPad Keychain.

import { createLocalBackend, lineCollector } from './localBackend.js';
import { createMailbox, writeSlot, SLOT_STDIN, SLOT_COMMAND } from './ipad/mailbox.js';
import { parseTraceback } from './ipad/traceback.js';
import { createIpadAI } from './ipad/ai.js';
import { runSelftest } from './ipad/selftest.js';
import { IMPORT_TO_PACKAGE, PACKAGE_SPEC, PACKAGES_FILE, mergePackages, normName, scanImports } from './ipad/packages.js';
import { uid } from '../lib/id.js';
import tandemRun from '../../runtime/tandem_runtime/support/tandem_run.py?raw';
import tandemMpl from '../../runtime/tandem_runtime/support/tandem_mpl.py?raw';
import tandemKernel from './ipad/tandem_kernel.py?raw';

const INDEX_URL = '/pyodide/';
const STOP_GRACE_MS = 1500;

export function createIpadBackend(config) {
  const base = createLocalBackend(config, { socket: false });
  const { client } = base;
  let python = null; // { version, pyodide, stdlib } once the first worker is ready

  // One warm worker is always loading, so a run starts without waiting for Python.
  function spawn() {
    const worker = new Worker(new URL('./ipad/python.worker.js', import.meta.url), { type: 'module' });
    const mailbox = createMailbox();
    const ready = new Promise((resolve, reject) => {
      worker.onmessage = (e) => {
        if (e.data.type === 'ready') {
          python = { version: e.data.python, pyodide: e.data.pyodide, stdlib: new Set(e.data.stdlib || []) };
          resolve({ worker, mailbox });
        } else if (e.data.type === 'failed') reject(new Error(e.data.message));
      };
      worker.onerror = (e) => reject(new Error(e.message || 'Python couldn’t start.'));
    });
    worker.postMessage({ type: 'init', indexURL: INDEX_URL, token: config.token, mailbox, support: { 'tandem_run.py': tandemRun, 'tandem_mpl.py': tandemMpl, 'tandem_kernel.py': tandemKernel } });
    return ready;
  }
  let warm = spawn();
  warm.then(
    () => client.setState('connected'),
    () => client.setState('disconnected')
  );
  const take = () => {
    const next = warm;
    warm = spawn();
    return next;
  };

  const ai = createIpadAI({ api: (path, init) => fetch(path, { ...init, headers: { 'x-tandem-token': config.token } }), token: config.token, settings: base.aiSettings });

  // Pyodide's package list (what it can provide, and which imports each has).
  let lockPromise = null;
  const pyodideLock = () => {
    lockPromise ??= fetch(`${INDEX_URL}pyodide-lock.json`)
      .then((r) => r.json())
      .catch(() => ({ packages: {} }));
    return lockPromise;
  };
  const readPackages = async () => {
    const r = await fetch(`/api/raw?path=${encodeURIComponent(PACKAGES_FILE)}`, { headers: { 'x-tandem-token': config.token }, cache: 'no-store' });
    if (!r.ok) return null;
    try {
      return JSON.parse(await r.text());
    } catch {
      return null;
    }
  };
  const requestedPackages = async (job) => {
    let list = job.packages || [];
    if (job.requirements) {
      const file = await base.readFile('requirements.txt');
      list = (file.text || '')
        .split('\n')
        .map((l) => l.split('#')[0].trim())
        .filter(Boolean);
    }
    list = list.map((p) => p.trim()).filter(Boolean);
    if (!list.length) throw new Error('Choose at least one package.');
    const bad = list.find((p) => !PACKAGE_SPEC.test(p));
    if (bad) throw new Error(`“${bad}” isn't a package name Tandem can install (for example: tabulate or rich>=13).`);
    return list;
  };
  const explainInstall = (text) => {
    if (/Can't find a pure Python 3 wheel|No pure Python wheel|Can't find a pure/i.test(text)) {
      return 'That package needs compiled code that Pyodide doesn’t provide, so it can’t run on iPad.';
    }
    if (/Can't fetch metadata|not found|No matching distribution|404/i.test(text)) return 'PyPI has no package with that name (or no version that works here).';
    if (/Failed to fetch|NetworkError|Load failed|network connection/i.test(text)) return 'Tandem couldn’t reach PyPI. Installing needs the internet once.';
    return 'The install failed. The log above shows why.';
  };

  const backend = {
    ...base,
    kind: 'ipad',

    async status() {
      const status = await base.status();
      let info = python;
      if (!info) {
        try {
          await warm;
          info = python;
        } catch (e) {
          return { ...status, python: { ok: false, error: `Python couldn’t start: ${e.message}`, source: 'Pyodide' } };
        }
      }
      return {
        ...status,
        python: { ok: true, version: info.version, path: `Pyodide ${info.pyodide}`, is_venv: false, source: 'built into Tandem (Pyodide)', prefix: 'ipad' },
      };
    },

    // ---- Notebooks: a kernel is one long-lived Python worker per notebook ----
    // Same handlers as the desktop's startKernel. Cells run one at a time, in
    // order; after an error the cells queued behind it are skipped (as in Jupyter).
    startKernel(path, h) {
      let slot = null;
      let ready = false;
      let closed = false;
      let current = null; // cell running now
      let waitingForInput = false;
      let generation = 0;
      const queue = [];

      const abortAll = () => {
        if (current) h.onDone?.(current, 'aborted', null);
        for (const job of queue.splice(0)) h.onDone?.(job.cell, 'aborted', null);
        current = null;
        waitingForInput = false;
      };
      const pump = () => {
        if (!ready || current || !queue.length) return;
        const job = queue.shift();
        current = job.cell;
        h.onStatus?.('busy', { cell: job.cell });
        slot.worker.postMessage({ type: 'kernel-execute', cell: job.cell, code: job.code });
      };
      const boot = async (restarted = false) => {
        const mine = ++generation;
        ready = false;
        h.onStatus?.(restarted ? 'restarting' : 'starting', {});
        try {
          slot = await take();
        } catch (e) {
          if (mine === generation) h.onRejected?.(`Python couldn’t start: ${e.message}`);
          return;
        }
        if (closed || mine !== generation) return slot.worker.terminate();
        slot.worker.onerror = () => {
          if (mine !== generation) return;
          abortAll();
          h.onStatus?.('dead', {});
        };
        slot.worker.onmessage = (e) => {
          if (mine !== generation) return;
          const m = e.data;
          if (m.type === 'kernel-ready') {
            ready = true;
            h.onStatus?.('idle', { python: `Python ${python?.version ?? ''} (Pyodide ${python?.pyodide ?? ''})`, restarted });
            pump();
          } else if (m.type === 'kernel-count') h.onCount?.(m.cell, m.count);
          else if (m.type === 'kernel-output') h.onOutput?.(m.cell, m.output);
          else if (m.type === 'kernel-clear') h.onClear?.(m.cell, m.wait);
          else if (m.type === 'kernel-input') {
            waitingForInput = true;
            h.onInput?.(m.cell, m.prompt, false);
          } else if (m.type === 'kernel-done') {
            current = null;
            waitingForInput = false;
            h.onDone?.(m.cell, m.status, null);
            if (m.status === 'error') for (const job of queue.splice(0)) h.onDone?.(job.cell, 'aborted', null);
            h.onStatus?.(queue.length ? 'busy' : 'idle', {});
            pump();
          } else if (m.type === 'failed') {
            abortAll();
            if (!ready) h.onRejected?.(`The notebook’s Python couldn’t start: ${m.message}`);
            else h.onStatus?.('dead', {});
          }
        };
        slot.worker.postMessage({ type: 'kernel-start' });
      };
      boot();

      return {
        execute: (cell, code) => {
          queue.push({ cell, code });
          pump();
        },
        input: (text) => {
          if (!waitingForInput) return;
          waitingForInput = false;
          writeSlot(slot.mailbox, SLOT_STDIN, text);
        },
        interrupt: () => {
          if (!slot || !current) return;
          for (const job of queue.splice(0)) h.onDone?.(job.cell, 'aborted', null);
          if (waitingForInput) {
            waitingForInput = false;
            writeSlot(slot.mailbox, SLOT_STDIN, '\u0000interrupt');
          } else Atomics.store(new Int32Array(slot.mailbox.interrupt), 0, 2);
        },
        restart: () => {
          abortAll();
          slot?.worker.terminate();
          slot = null;
          boot(true);
        },
        shutdown: () => {
          closed = true;
          generation++;
          abortAll();
          slot?.worker.terminate();
        },
      };
    },

    // ---- Environment and packages (iPad: one built-in Python) ----
    async envs() {
      const status = await backend.status();
      const p = status.python;
      return {
        platform: 'ipad',
        current: p.ok ? { version: p.version, path: `Built into Tandem (Pyodide ${python?.pyodide ?? ''})`, is_venv: false, prefix: 'ipad', source: p.source } : null,
        selected: null,
        project: [],
        interpreters: [],
      };
    },
    selectEnv: async () => {
      throw new Error('On iPad there is one built-in Python.');
    },

    async packages() {
      await warm.catch(() => {});
      const [lock, saved, list] = await Promise.all([pyodideLock(), readPackages(), base.listFiles()]);
      // Import name → Pyodide package, for everything Pyodide provides.
      const provided = new Map();
      for (const [name, pkg] of Object.entries(lock.packages || {})) for (const imp of pkg.imports || []) provided.set(imp, pkg.name || name);
      const own = new Map();
      for (const p of saved?.pypi || []) for (const imp of p.imports?.length ? p.imports : [p.name.replace(/-/g, '_')]) own.set(imp, p);
      const local = new Set();
      for (const { path } of list) {
        const parts = path.split('/');
        if (parts.length > 1) local.add(parts[0]);
        if (path.endsWith('.py')) local.add(parts[parts.length - 1].slice(0, -3));
      }
      const wanted = new Map();
      await Promise.all(
        list
          .filter((f) => f.path.endsWith('.py'))
          .slice(0, 300)
          .map(async ({ path }) => {
            const file = await base.readFile(path).catch(() => null);
            if (!file?.text) return;
            for (const { module, line } of scanImports(file.text)) {
              if (!wanted.has(module)) wanted.set(module, []);
              wanted.get(module).push({ path, line });
            }
          })
      );
      const stdlib = python?.stdlib || new Set();
      const used = [];
      const missing = [];
      for (const [module, where] of [...wanted].sort()) {
        if (stdlib.has(module) || local.has(module) || own.has(module) || module === 'js' || module === 'pyodide') continue;
        if (provided.has(module)) {
          used.push(provided.get(module));
          continue;
        }
        missing.push({ module, package: IMPORT_TO_PACKAGE[module] || module, where: where.slice(0, 5) });
      }
      const packages = [
        ...(saved?.pypi || []).map((p) => ({ name: p.name, version: p.version, note: 'from PyPI, kept in this project' })),
        ...[...new Set(used)].sort().map((name) => ({ name, version: lock.packages?.[normName(name)]?.version || lock.packages?.[name]?.version || '', note: 'included with Pyodide' })),
      ];
      const hasRequirements = list.some((f) => f.path === 'requirements.txt');
      return {
        python: { path: 'Pyodide', source: 'built in' },
        can_install: true,
        reason: null,
        requirements: hasRequirements,
        packages,
        missing,
        hint: 'Pure-Python packages from PyPI work on iPad; packages with compiled code only when Pyodide provides them (numpy, pandas, scikit-learn, …, which load by themselves). Installing needs the internet once: the files are then kept in this project and work offline.',
      };
    },

    async previewJob(job) {
      if (job.kind !== 'install') throw new Error('On iPad there is one built-in Python: there are no environments to create.');
      const packages = await requestedPackages(job);
      return {
        kind: 'install',
        command: ['micropip.install', ...packages],
        display: `micropip.install([${packages.map((p) => JSON.stringify(p)).join(', ')}])`,
        note: 'Downloads from PyPI (pypi.org) or Pyodide, and keeps the files in this project (.tandem/packages) so they work offline.',
      };
    },

    startJob(job, { onStart, onOutput, onFinish: reportFinish }) {
      let cancelled = false;
      let reported = false;
      const onFinish = (result) => {
        if (reported) return;
        reported = true;
        reportFinish?.(result);
      };
      let worker = null;
      (async () => {
        try {
          const packages = await requestedPackages(job);
          const slot = await spawn();
          worker = slot.worker;
          if (cancelled) return worker.terminate();
          onStart?.({ command: ['micropip.install', ...packages] });
          const result = await new Promise((resolve, reject) => {
            worker.onmessage = (e) => {
              const m = e.data;
              if (m.type === 'output') onOutput?.(m.text);
              else if (m.type === 'installed') resolve(m);
              else if (m.type === 'failed') reject(new Error(m.message));
            };
            worker.postMessage({ type: 'install', packages });
          });
          const next = mergePackages(await readPackages(), result);
          await client.api(`/api/raw?path=${encodeURIComponent(PACKAGES_FILE)}`, {
            method: 'PUT',
            body: new TextEncoder().encode(JSON.stringify(next, null, 2)),
          });
          onOutput?.(`Kept with the project: ${result.pypi.map((p) => `${p.name} ${p.version}`).join(', ') || 'nothing new from PyPI'}${result.pyodide.length ? `; from Pyodide: ${result.pyodide.join(', ')}` : ''}.\n`);
          onFinish?.({ status: 'success' });
        } catch (e) {
          if (cancelled) return onFinish?.({ status: 'cancelled' });
          const text = String(e.message || e);
          onOutput?.(`${text}\n`);
          onFinish?.({ status: 'error', message: explainInstall(text) });
        } finally {
          worker?.terminate();
        }
      })();
      return {
        cancel: () => {
          cancelled = true;
          worker?.terminate();
          onFinish?.({ status: 'cancelled' });
        },
      };
    },

    listProjects: () => client.api('/api/projects'),
    // The person's wallpaper photo, kept by the app so it survives reinstalls of the page.
    loadWallpaper: () => client.api('/api/wallpaper'),
    saveWallpaper: (custom) => client.api('/api/wallpaper', { method: 'PUT', body: custom }),
    openProject: (name, create = false) => client.api('/api/projects', { method: 'POST', body: { name, create } }),

    aiActive: () => ai.active(),
    testAI: (provider) => ai.test(provider),
    assist: (body, signal) => ai.assist(body, signal),
    complete: (body, signal) => ai.complete(body, signal),

    // Same callbacks and handle as the desktop's startRun.
    startRun({ path, mode = 'run', breakpoints = [], onStart, onOutput, onPartial, onPaused, onResumed, onFinish }) {
      const id = uid('run');
      const output = [];
      const figures = [];
      let variables = [];
      let metrics = null;
      let stderr = '';
      let done = false;
      let stopping = false;
      let slot = null;
      let waitingForInput = false;
      let waitingForCommand = false;
      const queue = []; // lines typed before Python asked for them
      const commands = []; // debugger commands, one per pause read
      const startedAt = Date.now();
      const lines = lineCollector(
        (line) => {
          output.push(line);
          onOutput(line);
        },
        (out) => onPartial?.(out)
      );

      const finish = (result) => {
        if (done) return;
        done = true;
        lines.flush();
        slot?.worker.terminate(); // every run gets a fresh Python
        onFinish({ output, figures, variables, metrics, python: python ? `Python ${python.version} (Pyodide)` : null, ...result });
      };

      const deliverCommand = () => {
        if (waitingForCommand && commands.length) {
          waitingForCommand = false;
          writeSlot(slot.mailbox, SLOT_COMMAND, JSON.stringify(commands.shift()));
        }
      };
      const deliverInput = () => {
        if (waitingForInput && queue.length) {
          waitingForInput = false;
          writeSlot(slot.mailbox, SLOT_STDIN, queue.shift());
        }
      };

      take().then(
        (ready) => {
          slot = ready;
          if (stopping) return finish({ status: 'stopped', exitCode: null, durationMs: 0, error: null });
          slot.worker.onmessage = (e) => {
            const m = e.data;
            switch (m.type) {
              case 'started':
                onStart?.({ python: python?.version, cwd: '/project' });
                break;
              case 'output':
                if (m.stream === 'err') stderr = (stderr + m.text).slice(-64 * 1024);
                lines.push(m.stream, m.text);
                break;
              case 'stdin-wait':
                waitingForInput = true;
                deliverInput();
                break;
              case 'command-wait':
                waitingForCommand = true;
                deliverCommand();
                break;
              case 'event': {
                const ev = m.event;
                if (ev.type === 'figure') {
                  figures.push({ id: `${id}-fig-${ev.index}`, kind: 'image', format: ev.format, title: ev.title || `Figure ${ev.index}`, panels: [], data: ev.data });
                } else if (ev.type === 'figure-error') lines.push('err', `[Tandem couldn't render a figure: ${ev.message}]\n`);
                else if (ev.type === 'variables') variables = ev.variables || [];
                else if (ev.type === 'metrics') metrics = ev.metrics || null;
                else if (ev.type === 'paused') onPaused?.({ path: ev.path, line: ev.line, function: ev.function, reason: ev.reason, stack: ev.stack || [], locals: ev.locals, globals: ev.globals || [], count: ev.count });
                else if (ev.type === 'resumed') onResumed?.();
                break;
              }
              case 'exit': {
                const code = m.code;
                const status = stopping ? 'stopped' : code === 0 ? 'success' : 'error';
                const error = status === 'error' ? parseTraceback(stderr) : null;
                finish({
                  status,
                  exitCode: code,
                  durationMs: Date.now() - startedAt,
                  error: error ? { ...error, explanation: error.message ? `${error.type}: ${error.message}` : error.type } : null,
                });
                break;
              }
              case 'failed':
                lines.push('err', `[Python stopped unexpectedly: ${m.message}]\n`);
                finish({ status: stopping ? 'stopped' : 'error', exitCode: null, durationMs: Date.now() - startedAt, error: null });
                break;
              default:
            }
          };
          slot.worker.postMessage({ type: 'run', path, mode, breakpoints: breakpoints.map((b) => [b.path, b.line]) });
        },
        (e) => finish({ status: 'rejected', message: `Python couldn’t start: ${e.message}`, durationMs: 0 })
      );

      return {
        id,
        // Ctrl+C first (KeyboardInterrupt, with its traceback); end the worker if Python doesn't stop.
        stop() {
          if (done) return;
          stopping = true;
          if (!slot) return;
          Atomics.store(new Int32Array(slot.mailbox.interrupt), 0, 2);
          commands.length = 0;
          commands.push({ cmd: 'stop' });
          deliverCommand();
          if (waitingForInput) writeSlot(slot.mailbox, SLOT_STDIN, null);
          setTimeout(() => finish({ status: 'stopped', exitCode: null, durationMs: Date.now() - startedAt, error: null }), STOP_GRACE_MS);
        },
        input(text) {
          if (done) return;
          lines.echo(text);
          queue.push(text);
          if (slot) deliverInput();
        },
        endInput() {
          if (done) return;
          queue.length = 0;
          queue.push(null); // end of input, delivered when Python next reads
          if (slot) deliverInput();
        },
        command(cmd) {
          if (done || !slot) return;
          commands.push({ cmd });
          deliverCommand();
        },
        setBreakpoints(list) {
          // Applied when the program next pauses (the debugger reads it before the next step).
          if (done || !slot) return;
          commands.unshift({ cmd: 'breakpoints', list: list.map((b) => [`/project/${b.path}`, b.line]) });
          deliverCommand();
        },
      };
    },
  };

  if (config.selftest) warm.then(() => runSelftest(backend, config.token));
  return backend;
}
