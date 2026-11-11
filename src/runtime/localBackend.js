// The real backend: files on disk and Python runs on this computer, through
// the local Tandem runtime. Nothing here is simulated, and nothing falls back
// to the demo when the runtime fails: failures are reported as failures.

import { uid } from '../lib/id.js';
import { RuntimeClient } from './client.js';

// Turns streamed text into lines, per stream. A partial line is held until
// its newline arrives (or the run ends).
export function lineCollector(onLine, onPartial) {
  const partial = { out: '', err: '' };
  return {
    push(stream, text) {
      const kind = stream === 'err' ? 'err' : 'out';
      const parts = (partial[kind] + text.replace(/\r\n/g, '\n')).split('\n');
      partial[kind] = parts.pop();
      parts.forEach((line) => onLine({ text: line, kind }));
      // An unfinished line (like an input() prompt) is shown as it is.
      onPartial?.(partial.out, partial.err);
    },
    // What the person typed for input() continues the prompt's line, as in a terminal.
    echo(text) {
      onLine({ text: partial.out + text, kind: 'out', typed: text });
      partial.out = '';
      onPartial?.(partial.out, partial.err);
    },
    flush() {
      for (const kind of ['out', 'err']) {
        if (partial[kind]) onLine({ text: partial[kind], kind });
        partial[kind] = '';
      }
    },
  };
}

export function createLocalBackend(config, { socket = true } = {}) {
  const client = new RuntimeClient({ ...config, socket });

  return {
    kind: 'local',
    client,

    status: () => client.api('/api/status'),
    listFiles: () => client.api('/api/files').then((r) => r.files),
    readFile: (path) => client.api(`/api/file?path=${encodeURIComponent(path)}`),
    writeFile: (path, text, baseHash) => client.api('/api/file', { method: 'PUT', body: { path, text, base_hash: baseHash } }),
    createFile: (path, text = '') => client.api('/api/file', { method: 'POST', body: { path, text } }),
    // A project file as bytes (SQLite databases): null if it doesn't exist.
    async readRaw(path) {
      let response;
      try {
        response = await fetch(`/api/raw?path=${encodeURIComponent(path)}`, { headers: { 'x-tandem-token': config.token }, cache: 'no-store' });
      } catch {
        throw new Error('The Tandem runtime is not reachable. Is it still running?');
      }
      if (response.status === 404) return null;
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.detail || `Couldn't read ${path} (${response.status}).`);
      }
      return response.arrayBuffer();
    },
    // Create or replace a project file with these bytes.
    writeRaw: (path, bytes) => client.api(`/api/raw?path=${encodeURIComponent(path)}`, { method: 'PUT', body: bytes }),
    // A file brought in from elsewhere, as bytes. Never overwrites.
    uploadFile: (path, data) => client.api(`/api/upload?path=${encodeURIComponent(path)}`, { method: 'POST', body: data }),

    // Environments and packages. Reading is free; creating an environment or
    // installing packages is a job, started only after the person has seen
    // the exact command (previewJob) and confirmed it.
    envs: (refresh = false) => client.api(`/api/envs${refresh ? '?refresh=1' : ''}`),
    selectEnv: (python) => client.api('/api/envs/select', { method: 'PUT', body: { python } }),
    packages: () => client.api('/api/packages'),
    previewJob: (job) => client.api('/api/jobs/preview', { method: 'POST', body: job }),
    // job: { kind: 'create-env', base, name } | { kind: 'install', packages } | { kind: 'install', requirements: true }
    // onOutput(text), onFinish({ status, exitCode, message, ... }). Returns { cancel }.
    startJob(job, { onStart, onOutput, onFinish }) {
      const id = `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        off();
        offState();
        onFinish?.(result);
      };
      const off = client.on((event) => {
        if (event.id !== id) return;
        if (event.type === 'job.started') onStart?.(event);
        else if (event.type === 'job.output') onOutput?.(event.text);
        else if (event.type === 'job.finished') finish(event);
        else if (event.type === 'job.rejected') finish({ status: 'error', message: event.message });
      });
      const offState = client.onState((state) => {
        if (state === 'disconnected') finish({ status: 'error', message: 'The connection to the runtime was lost.' });
      });
      if (!client.send({ type: 'job.start', id, ...job })) finish({ status: 'error', message: 'The runtime isn’t connected.' });
      return { cancel: () => client.send({ type: 'job.cancel', id }) };
    },

    // A Jupyter kernel for a notebook (ipykernel in the project's environment).
    // h: onStatus(state, info), onCount(cell, n), onOutput(cell, output),
    //    onClear(cell, wait), onInput(cell, prompt, password), onDone(cell, status, n),
    //    onRejected(message, code), onError(message)
    startKernel(path, h) {
      const id = uid('kernel');
      const off = client.on((e) => {
        if (e.id !== id) return;
        if (e.type === 'kernel.status') h.onStatus?.(e.state, e);
        else if (e.type === 'kernel.count') h.onCount?.(e.cell, e.count);
        else if (e.type === 'kernel.output') h.onOutput?.(e.cell, e.output);
        else if (e.type === 'kernel.clear') h.onClear?.(e.cell, e.wait);
        else if (e.type === 'kernel.input') h.onInput?.(e.cell, e.prompt, e.password);
        else if (e.type === 'kernel.done') h.onDone?.(e.cell, e.status, e.count);
        else if (e.type === 'kernel.rejected') h.onRejected?.(e.message, e.code);
        else if (e.type === 'kernel.error') h.onError?.(e.message);
      });
      const offState = client.onState((state) => {
        if (state === 'disconnected') h.onStatus?.('dead', { lost: true });
      });
      if (!client.send({ type: 'kernel.start', id, path })) h.onRejected?.('The runtime isn’t connected.');
      const send = (type, fields = {}) => client.send({ type, id, ...fields });
      return {
        execute: (cell, code) => send('kernel.execute', { cell, code }),
        input: (text) => send('kernel.input', { text }),
        interrupt: () => send('kernel.interrupt'),
        restart: () => send('kernel.restart'),
        shutdown: () => {
          send('kernel.shutdown');
          off();
          offState();
        },
      };
    },

    // AI provider settings. Keys go to the runtime and never come back.
    aiSettings: () => client.api('/api/ai/settings'),
    saveAISettings: (body) => client.api('/api/ai/settings', { method: 'PUT', body }),
    testAI: (provider) => client.api('/api/ai/test', { method: 'POST', body: { provider } }),
    aiActive: () => client.api('/api/ai/active').then((r) => r.active),
    assist: (body, signal) => client.api('/api/ai/assist', { method: 'POST', body, signal }),

    // Starts a real run. mode: 'run' | 'step' | 'debug'. Callbacks:
    //   onStart({python, cwd}), onOutput(line), onPartial(text),
    //   onPaused(pause), onResumed(), onFinish(result)
    // result: { status: 'success'|'error'|'stopped', exitCode, output, variables,
    //           figures, metrics, error, durationMs, python, lostConnection? }
    startRun({ path, mode = 'run', breakpoints = [], onStart, onOutput, onPartial, onPaused, onResumed, onFinish }) {
      const id = uid('run');
      const output = [];
      const figures = [];
      let variables = [];
      let metrics = null;
      let python = null;
      let done = false;
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
        offEvents();
        offState();
        lines.flush();
        onFinish({ output, figures, variables, metrics, python, ...result });
      };

      const offEvents = client.on((event) => {
        if (event.id !== id) return;
        switch (event.type) {
          case 'run.started':
            python = event.python;
            onStart?.({ python: event.python, cwd: event.cwd });
            break;
          case 'run.output':
            lines.push(event.stream, event.text);
            break;
          case 'run.figure':
            figures.push({
              id: `${id}-fig-${event.index}`,
              kind: 'image',
              format: event.format,
              title: event.title || `Figure ${event.index}`,
              panels: [],
              data: event.data,
            });
            break;
          case 'run.figure-error':
            lines.push('err', `[Tandem couldn't render a figure: ${event.message}]\n`);
            break;
          case 'run.variables':
            variables = event.variables || [];
            break;
          case 'run.metrics':
            metrics = event.metrics || null;
            break;
          case 'run.paused':
            onPaused?.({
              path: event.path,
              line: event.line,
              function: event.function,
              reason: event.reason,
              stack: event.stack || [],
              locals: event.locals,
              globals: event.globals || [],
              count: event.count,
            });
            break;
          case 'run.resumed':
            onResumed?.();
            break;
          case 'run.rejected':
            finish({ status: 'rejected', message: event.message, durationMs: 0 });
            break;
          case 'run.exit':
            finish({
              status: event.status,
              exitCode: event.exit_code,
              durationMs: event.duration_ms,
              error: event.error
                ? { ...event.error, explanation: event.error.message ? `${event.error.type}: ${event.error.message}` : event.error.type }
                : null,
            });
            break;
          default:
        }
      });
      // If the runtime goes away mid-run, say so. The process is stopped by the
      // runtime when its window disconnects.
      const offState = client.onState((state) => {
        if (state === 'disconnected') {
          lines.push('err', '\n[Lost the connection to the Tandem runtime. The run was stopped.]\n');
          finish({ status: 'error', lostConnection: true, durationMs: Date.now() - startedAt, error: null });
        }
      });

      if (!client.send({ type: 'run.start', id, path, mode, breakpoints })) {
        offEvents();
        offState();
        throw new Error('The Tandem runtime is disconnected. Start it with `tandem open` and try again.');
      }
      return {
        id,
        stop() {
          client.send({ type: 'run.stop', id });
        },
        // A line typed for input(); shown in the output like a terminal echo.
        input(text) {
          if (done) return;
          lines.echo(text);
          client.send({ type: 'run.input', id, text });
        },
        endInput() {
          client.send({ type: 'run.input-end', id });
        },
        command(cmd) {
          client.send({ type: 'debug.command', id, cmd });
        },
        setBreakpoints(list) {
          client.send({ type: 'debug.command', id, cmd: 'breakpoints', breakpoints: list });
        },
      };
    },
  };
}
