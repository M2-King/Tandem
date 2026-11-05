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
import { uid } from '../lib/id.js';
import tandemRun from '../../runtime/tandem_runtime/support/tandem_run.py?raw';
import tandemMpl from '../../runtime/tandem_runtime/support/tandem_mpl.py?raw';

const INDEX_URL = '/pyodide/';
const STOP_GRACE_MS = 1500;

export function createIpadBackend(config) {
  const base = createLocalBackend(config, { socket: false });
  const { client } = base;
  let python = null; // { version, pyodide } once the first worker is ready

  // One warm worker is always loading, so a run starts without waiting for Python.
  function spawn() {
    const worker = new Worker(new URL('./ipad/python.worker.js', import.meta.url), { type: 'module' });
    const mailbox = createMailbox();
    const ready = new Promise((resolve, reject) => {
      worker.onmessage = (e) => {
        if (e.data.type === 'ready') {
          python = { version: e.data.python, pyodide: e.data.pyodide };
          resolve({ worker, mailbox });
        } else if (e.data.type === 'failed') reject(new Error(e.data.message));
      };
      worker.onerror = (e) => reject(new Error(e.message || 'Python couldn’t start.'));
    });
    worker.postMessage({ type: 'init', indexURL: INDEX_URL, token: config.token, mailbox, support: { 'tandem_run.py': tandemRun, 'tandem_mpl.py': tandemMpl } });
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

    listProjects: () => client.api('/api/projects'),
    // The person's wallpaper photo, kept by the app so it survives reinstalls of the page.
    loadWallpaper: () => client.api('/api/wallpaper'),
    saveWallpaper: (custom) => client.api('/api/wallpaper', { method: 'PUT', body: custom }),
    openProject: (name, create = false) => client.api('/api/projects', { method: 'POST', body: { name, create } }),

    aiActive: () => ai.active(),
    testAI: (provider) => ai.test(provider),
    assist: (body, signal) => ai.assist(body, signal),

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
