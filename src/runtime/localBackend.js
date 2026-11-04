// The real backend: files on disk and Python runs on this computer, through
// the local Tandem runtime. Nothing here is simulated, and nothing falls back
// to the demo when the runtime fails: failures are reported as failures.

import { uid } from '../lib/id.js';
import { RuntimeClient } from './client.js';

// Turns streamed text into lines, per stream. A partial line is held until
// its newline arrives (or the run ends).
function lineCollector(onLine) {
  const partial = { out: '', err: '' };
  return {
    push(stream, text) {
      const kind = stream === 'err' ? 'err' : 'out';
      const parts = (partial[kind] + text.replace(/\r\n/g, '\n')).split('\n');
      partial[kind] = parts.pop();
      parts.forEach((line) => onLine({ text: line, kind }));
    },
    flush() {
      for (const kind of ['out', 'err']) {
        if (partial[kind]) onLine({ text: partial[kind], kind });
        partial[kind] = '';
      }
    },
  };
}

export function createLocalBackend(config) {
  const client = new RuntimeClient(config);

  return {
    kind: 'local',
    client,

    status: () => client.api('/api/status'),
    listFiles: () => client.api('/api/files').then((r) => r.files),
    readFile: (path) => client.api(`/api/file?path=${encodeURIComponent(path)}`),
    writeFile: (path, text, baseHash) => client.api('/api/file', { method: 'PUT', body: { path, text, base_hash: baseHash } }),
    createFile: (path, text = '') => client.api('/api/file', { method: 'POST', body: { path, text } }),

    // AI provider settings. Keys go to the runtime and never come back.
    aiSettings: () => client.api('/api/ai/settings'),
    saveAISettings: (body) => client.api('/api/ai/settings', { method: 'PUT', body }),
    testAI: (provider) => client.api('/api/ai/test', { method: 'POST', body: { provider } }),

    // Starts a real run. Callbacks:
    //   onStart({python, cwd}), onOutput(line), onFinish(result)
    // result: { status: 'success'|'error'|'stopped', exitCode, output, variables,
    //           figures, metrics, error, durationMs, python, lostConnection? }
    startRun({ path, onStart, onOutput, onFinish }) {
      const id = uid('run');
      const output = [];
      const figures = [];
      let variables = [];
      let metrics = null;
      let python = null;
      let done = false;
      const startedAt = Date.now();
      const lines = lineCollector((line) => {
        output.push(line);
        onOutput(line);
      });

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

      if (!client.send({ type: 'run.start', id, path })) {
        offEvents();
        offState();
        throw new Error('The Tandem runtime is disconnected. Start it with `tandem open` and try again.');
      }
      return {
        id,
        stop() {
          client.send({ type: 'run.stop', id });
        },
      };
    },
  };
}
