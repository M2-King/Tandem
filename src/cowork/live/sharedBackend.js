// Tandem Cowork live mode: running a shared project on this device.
//
// Same shape as the device backends (startRun with Run, Step through and
// Debug; startKernel for notebooks), so the editor, Run/Stop, the debugger,
// the results panel and notebooks work unchanged. Each run uses this
// device's own Python: the desktop runtime (a working copy of the project
// under the app's data, Shared/<project id>) or Pyodide on iPad (a working
// copy in the browser's storage). No code runs on the server.
//
// Before each run, kernel start or notebook cell, the project's current
// text is written to the working copy: what the editor shows, merged saves
// from teammates and edits not saved yet included. Files a run creates stay
// on this device. Each person's runs and output are their own.
//
// Shared code was written by other people and runs with this person's
// permissions, so the first run in each project on a device asks first
// (confirmTrust); the answer is remembered per project, on this device.

export const NOTE_WORKING_COPY =
  'Runs use this device’s Python, in a copy of the project on this device. Files a run creates (charts, CSVs) stay on this device and aren’t shared.';

export function createSharedBackend({ device, getProject, getFiles, confirmTrust }) {
  const noted = new Set(); // projects whose Output already explained the working copy

  // Ready to run here: allowed, and the working copy is up to date.
  async function prepare({ ask = true } = {}) {
    const project = getProject();
    if (!project) throw new Error('Open a shared project first.');
    if (!device?.shared) throw new Error('Shared projects run with the Tandem app’s Python (Windows or iPad). This page has none.');
    if (!(await device.shared.trusted(project.id))) {
      const yes = ask && (await confirmTrust(project));
      if (!yes) throw new Error(`Not run. Code in ${project.name} runs on this device only after you confirm that you trust its members.`);
      await device.shared.setTrusted(project.id, true);
    }
    const shared = await device.shared.prepare(project.id, { ...getFiles() });
    return { project, shared };
  }

  return {
    kind: 'cowork-live',

    // Same callbacks as the device's startRun. The handle works at once;
    // calls made while the working copy is written are passed on after.
    startRun(opts) {
      let real = null;
      let stopped = false;
      const queued = [];
      const later = (name, ...args) => (real ? real[name]?.(...args) : queued.push([name, args]));
      const finishEarly = (result) =>
        opts.onFinish({ output: [], figures: [], variables: [], metrics: null, python: null, durationMs: 0, ...result });

      prepare().then(
        ({ project, shared }) => {
          if (stopped) return finishEarly({ status: 'stopped', exitCode: null, error: null });
          let note = null;
          if (!noted.has(project.id)) {
            noted.add(project.id);
            note = { text: NOTE_WORKING_COPY, kind: 'note' };
            opts.onOutput(note);
          }
          // The note stays at the top of this run's output.
          const onFinish = (result) => opts.onFinish(note && result.output ? { ...result, output: [note, ...result.output] } : result);
          try {
            real = device.startRun({ ...opts, shared, onFinish });
          } catch (e) {
            return finishEarly({ status: 'rejected', message: e.message });
          }
          for (const [name, args] of queued.splice(0)) real[name]?.(...args);
        },
        (e) => finishEarly({ status: 'rejected', message: e.message })
      );

      return {
        stop(force = false) {
          if (real) return real.stop(force);
          stopped = true;
        },
        input: (text) => later('input', text),
        endInput: () => later('endInput'),
        command: (cmd) => later('command', cmd),
        setBreakpoints: (list) => later('setBreakpoints', list),
      };
    },

    // A notebook's kernel, started in the working copy. Cells run in order;
    // before each, the working copy gets the project's current files (a
    // teammate may have changed a module the notebook imports).
    startKernel(key, h) {
      // Notebook sessions are keyed cowork:<project id>/<path>; the kernel needs the path.
      const path = key.replace(/^cowork:[^/]+\//, '');
      let real = null;
      let closed = false;
      let chain = Promise.resolve();
      const step = (fn) => {
        chain = chain.then(fn).catch(() => {});
        return chain;
      };
      h.onStatus?.('starting', {});
      step(async () => {
        let ready;
        try {
          ready = await prepare();
        } catch (e) {
          if (!closed) h.onRejected?.(e.message);
          closed = true;
          return;
        }
        if (closed) return;
        real = device.startKernel(path, h, { shared: ready.shared });
      });
      const resync = async () => {
        if (!real || closed) return;
        const { shared } = await prepare({ ask: false });
        real.syncShared?.(shared); // iPad: hand the files to the kernel's worker
      };
      return {
        execute: (cell, code) =>
          step(async () => {
            if (closed || !real) return h.onDone?.(cell, 'aborted', null);
            await resync().catch(() => {});
            real.execute(cell, code);
          }),
        input: (text) => real?.input(text),
        interrupt: () => real?.interrupt(),
        restart: () =>
          step(async () => {
            await resync().catch(() => {});
            real?.restart();
          }),
        shutdown: () => {
          closed = true;
          real?.shutdown();
        },
      };
    },
  };
}
