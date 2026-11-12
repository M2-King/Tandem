import { useCallback, useRef, useState } from 'react';

// Tandem Cowork: getting this computer ready to run shared projects, shown
// as "Preparing Python" (PreparePythonDialog). Shared projects run on each
// person's own device with one Python for all of them; this makes sure that
// Python exists and has the usual packages, then does what was asked
// (create, join or open a project).
//
//   1. Checking Python on this computer      /api/shared/python
//   2. Creating Tandem's Python environment  job create-env (scope shared), from the best Python found
//   3. Installing numpy, pandas, ...         job install (scope shared)
//   4. The step asked for                    e.g. Creating "Data Study"
//
// Steps already done are passed quickly. Without Python on the computer, the
// dialog says how to install it and checks again. On the iPad Python is built
// in, so only the last step runs.

const PLATFORM = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent) ? 'mac' : 'windows';

const listOf = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

// A pip line, made short for "now doing".
export function activityOf(line) {
  const t = String(line || '').trim();
  let m = /^Collecting (\S+)/.exec(t);
  if (m) return `Getting ${m[1].replace(/[<>=!~].*$/, '')}`;
  m = /^Downloading (\S+)/.exec(t);
  if (m) return `Downloading ${m[1].split('/').pop().split('-')[0]}`;
  if (/^Installing collected packages/.test(t)) return 'Installing…';
  m = /^Successfully installed (.+)/.exec(t);
  if (m) return `Installed ${m[1].split(/\s+/).length} packages`;
  if (/^Using cached/.test(t)) return 'Using a copy already on this computer';
  return null;
}

export function useSharedPython({ backend, enabled }) {
  const [state, setState] = useState(null); // the dialog: { title, steps, log, activity, error, done, startedAt }
  const readyRef = useRef(false); // known ready this session: opening projects needn't check again
  const pending = useRef(null); // { resolve, final } of the ensure() in progress
  const job = useRef(null);

  const set = (fn) => setState((s) => (s ? fn(s) : s));
  const step = (id, patch) => set((s) => ({ ...s, steps: s.steps.map((x) => (x.id === id ? { ...x, ...patch } : x)) }));
  const addLog = (text) =>
    set((s) => {
      const lines = String(text).split(/\r?\n/).filter((l) => l.trim());
      if (!lines.length) return s;
      const activity = lines.map(activityOf).filter(Boolean).pop() || s.activity;
      const installs = s.installs + lines.filter((l) => /^(Collecting|Using cached|Downloading) /.test(l.trim())).length;
      return { ...s, log: [...s.log, ...lines].slice(-6), activity, installs };
    });

  const runJob = (request, onLine) =>
    new Promise((resolve) => {
      job.current = backend.startJob(request, {
        onOutput: onLine,
        onFinish: (result) => {
          job.current = null;
          resolve(result || { status: 'error' });
        },
      });
    });

  const fail = (id, error) => {
    step(id, { status: 'error' });
    set((s) => ({ ...s, error }));
  };

  // The whole chain; returns true once the asked-for step is done.
  const go = useCallback(
    async (final, refresh = false) => {
      set((s) => ({ ...s, error: null, steps: s.steps.map((x) => ({ ...x, status: x.status === 'done' ? 'done' : 'waiting' })) }));
      const start = Date.now();
      // 1. Check.
      let info = null;
      if (backend?.sharedPython) {
        step('check', { status: 'active' });
        try {
          info = await backend.sharedPython(refresh);
        } catch (e) {
          fail('check', { message: e.message || 'Couldn’t check Python on this computer.' });
          return false;
        }
        await new Promise((r) => setTimeout(r, Math.max(0, 600 - (Date.now() - start)))); // long enough to read
        const python = info.builtin ? 'Python is built into Tandem on this iPad' : info.python ? `Python ${info.version || ''}`.trim() : null;
        step('check', { status: 'done', detail: python || (info.base ? `Found Python ${info.base.version}` : null) });
        if (!info.ready && !info.python && !info.base) {
          fail('check', { kind: 'no-python', message: 'There’s no Python on this computer yet.' });
          return false;
        }
      } else {
        step('check', { status: 'done', detail: 'Nothing to prepare here' });
      }
      // 2. Tandem's own environment, unless the Python in use already has everything.
      const needsEnv = info && !info.ready && !info.own_env;
      if (needsEnv) {
        const base = info.base?.path || info.python;
        step('env', { status: 'active', detail: `From Python ${info.base?.version || info.version || ''}`.trim() });
        const r = await runJob({ kind: 'create-env', scope: 'shared', base, name: '.venv' }, addLog);
        if (r.status !== 'success') {
          fail('env', { message: r.message || 'The environment couldn’t be created.' });
          return false;
        }
        step('env', { status: 'done' });
      } else {
        step('env', { status: 'done', detail: info?.own_env ? 'Already there' : info?.builtin ? 'Built in' : 'Using the Python already chosen' });
      }
      // 3. Packages.
      const missing = needsEnv ? info.packages : info?.missing || [];
      if (info && missing.length) {
        step('install', { status: 'active', label: `Installing ${listOf(missing)}` });
        set((s) => ({ ...s, installs: 0, activity: 'Starting…' }));
        const r = await runJob({ kind: 'install', scope: 'shared', packages: missing }, addLog);
        if (r.status !== 'success') {
          fail('install', { message: r.message || 'The packages couldn’t be installed.' });
          return false;
        }
        step('install', { status: 'done', detail: 'Installed' });
      } else {
        step('install', { status: 'done', detail: 'Already installed' });
      }
      readyRef.current = true;
      // 4. What was asked for.
      if (final) {
        step('final', { status: 'active' });
        try {
          const ok = await final.run();
          if (ok === false) {
            fail('final', { message: final.failed || 'That didn’t work. Try again.' });
            return false;
          }
        } catch (e) {
          fail('final', { message: e.message || 'That didn’t work. Try again.' });
          return false;
        }
        step('final', { status: 'done' });
      }
      set((s) => ({ ...s, done: true, activity: null }));
      await new Promise((r) => setTimeout(r, 900)); // the finished checklist, briefly
      return true;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [backend]
  );

  const close = (result) => {
    const p = pending.current;
    pending.current = null;
    setState(null);
    p?.resolve(result);
  };

  // Get ready (if needed), then run `final` ({ label, run }). Resolves true
  // when done, false when cancelled. `quiet`: if already known ready, just run.
  const ensure = useCallback(
    async ({ title = 'Preparing Python', final = null, quiet = false } = {}) => {
      if (!enabled || !backend) {
        if (final) await final.run();
        return true;
      }
      if (quiet && !readyRef.current && backend.sharedPython) {
        // Check without showing anything; the dialog only if there's work to do.
        try {
          if ((await backend.sharedPython()).ready) readyRef.current = true;
        } catch {
          // the dialog checks again and says what's wrong
        }
      }
      if (quiet && readyRef.current) {
        if (final) await final.run();
        return true;
      }
      if (pending.current) return false; // one at a time
      const steps = [
        { id: 'check', label: 'Checking Python on this computer', status: 'waiting' },
        { id: 'env', label: 'Creating Tandem’s Python environment', status: 'waiting' },
        { id: 'install', label: 'Installing numpy, pandas, matplotlib and ipykernel', status: 'waiting' },
        ...(final ? [{ id: 'final', label: final.label, status: 'waiting' }] : []),
      ];
      const done = new Promise((resolve) => (pending.current = { resolve, final }));
      setState({ title, steps, log: [], activity: null, installs: 0, error: null, done: false, startedAt: Date.now(), platform: PLATFORM });
      go(final).then((ok) => ok && close(true));
      return done;
    },
    [enabled, backend, go]
  );

  const retry = useCallback(
    (refresh = true) => {
      const p = pending.current;
      if (!p) return;
      go(p.final, refresh).then((ok) => ok && close(true));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [go]
  );
  // Carry on without preparing (the asked-for step still runs).
  const skip = useCallback(async () => {
    const p = pending.current;
    if (!p) return;
    if (p.final) {
      try {
        await p.final.run();
      } catch {
        // the app shows what went wrong
      }
    }
    close(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const cancel = useCallback(() => {
    job.current?.cancel?.();
    close(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { state, ensure, retry, skip, cancel, isReady: () => readyRef.current };
}
