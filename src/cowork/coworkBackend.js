// Cowork preview: "this device" for runs and notebook kernels.
//
// It has the same shape as Tandem's real backends (startRun, startKernel), so
// the editor, Run/Stop, the results panel and notebooks work unchanged. It
// executes nothing: it plays back the prepared sample results for the
// sample files, and says so for anything else. The real Cowork will run
// Python on each member's own device (Pyodide in the browser).

import { sampleCellResult, sampleScriptResult } from './fixtures.js';

const PYTHON = 'Python 3.12 · this device (preview)';
const NO_SAMPLE =
  'Preview: there is no sample result for this code. In Cowork, Run uses Python on this device; the prototype only plays back results for the sample files.';

export function createCoworkBackend({ getProjectId, getFiles }) {
  return {
    kind: 'cowork-preview',

    startRun({ path, onOutput, onFinish }) {
      const code = getFiles()[path] ?? '';
      const sample = sampleScriptResult(path, code, getProjectId());
      const timers = [];
      const output = [];
      const startedAt = Date.now();
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        timers.forEach(clearTimeout);
        onFinish({ output, figures: [], metrics: null, python: PYTHON, durationMs: Date.now() - startedAt, ...result });
      };
      if (!sample) {
        timers.push(setTimeout(() => finish({ status: 'rejected', message: NO_SAMPLE, durationMs: 0 }), 150));
        return { stop: () => finish({ status: 'stopped', exitCode: null, variables: [] }) };
      }
      // Lines arrive over a moment, as a real run's would.
      sample.lines.forEach((line, i) =>
        timers.push(
          setTimeout(() => {
            output.push(line);
            onOutput(line);
          }, 350 + i * 300)
        )
      );
      timers.push(
        setTimeout(
          () => finish({ status: sample.status, exitCode: sample.status === 'success' ? 0 : 1, variables: sample.variables, error: sample.error || null }),
          450 + sample.lines.length * 300
        )
      );
      return {
        stop: () => {
          const line = { text: 'KeyboardInterrupt', kind: 'err' };
          output.push(line);
          onOutput(line);
          finish({ status: 'stopped', exitCode: null, variables: [] });
        },
      };
    },

    // A notebook kernel: cells run one at a time, in order; after an error
    // the cells queued behind it are skipped (as in Jupyter).
    startKernel(_path, h) {
      let count = 0;
      let queue = [];
      let current = null; // { cell, timer }
      let alive = true;
      const later = (fn, ms) => setTimeout(() => alive && fn(), ms);

      later(() => h.onStatus?.('idle', { python: PYTHON }), 400);

      const next = () => {
        if (current || !queue.length) {
          if (!current) h.onStatus?.('idle', {});
          return;
        }
        const { cell, code } = queue.shift();
        count += 1;
        const n = count;
        h.onStatus?.('busy', {});
        h.onCount?.(cell, n);
        current = {
          cell,
          timer: later(() => {
            current = null;
            const sample = sampleCellResult(cell, code);
            if (!sample) {
              h.onOutput?.(cell, { output_type: 'stream', name: 'stdout', text: `${NO_SAMPLE}\n` });
              h.onDone?.(cell, 'ok', n);
            } else {
              sample.outputs.forEach((o) => h.onOutput?.(cell, o));
              h.onDone?.(cell, sample.error ? 'error' : 'ok', n);
              if (sample.error) {
                queue.forEach((q) => h.onDone?.(q.cell, 'aborted', null));
                queue = [];
              }
            }
            next();
          }, 650),
        };
      };

      return {
        execute: (cell, code) => {
          queue.push({ cell, code });
          if (!current) next();
        },
        input: () => {},
        interrupt: () => {
          if (current) {
            clearTimeout(current.timer);
            h.onOutput?.(current.cell, { output_type: 'error', ename: 'KeyboardInterrupt', evalue: '', traceback: ['KeyboardInterrupt'] });
            h.onDone?.(current.cell, 'error', count);
            current = null;
          }
          queue.forEach((q) => h.onDone?.(q.cell, 'aborted', null));
          queue = [];
          h.onStatus?.('idle', {});
        },
        restart: () => {
          if (current) clearTimeout(current.timer);
          current = null;
          queue = [];
          h.onStatus?.('restarting', {});
          later(() => {
            count = 0;
            h.onStatus?.('idle', { restarted: true, python: PYTHON });
          }, 600);
        },
        shutdown: () => {
          alive = false;
          if (current) clearTimeout(current.timer);
          queue = [];
        },
      };
    },
  };
}
