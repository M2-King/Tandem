import { useCallback, useEffect, useRef, useState } from 'react';
import { usePersistedState } from './usePersistedState.js';
import { STORAGE_KEYS } from '../lib/storage.js';
import { shortHash } from '../lib/text.js';
import { checkRunnable, startRun } from '../services/executionService.js';
import { TRACE, traceMatches, nextBreakpointIndex } from '../services/traceService.js';
import { DEBUG_FILE } from '../data/sampleProject.js';
import { IS_LOCAL } from '../runtime/config.js';

const createStore = () => ({ runs: [], nextNumber: 1 });

// Demo runs are saved in the browser. Real runs (with their figures) stay in
// memory for now: they can be far larger than browser storage allows.
const useRunStore = IS_LOCAL
  ? () => useState(createStore)
  : ({ onSave }) =>
      usePersistedState(STORAGE_KEYS.runs, createStore, {
        onSave,
        restore: (saved) => (Array.isArray(saved?.runs) ? saved : null),
      });

// Runs, the active execution session, and result notices.
//
// session is one of:
//   null
//   { mode: 'run', path, output: [...] }              a run in progress
//   { mode: 'step' | 'debug', path, index, prevIndex,  a paused trace (demo)
//     finished, noBreakpointHit }
//   Real mode adds to any session: partial (an unfinished output line, such as
//   an input() prompt), real: true, and for Step through / Debug: paused (where
//   the debugger stopped: line, stack, variables), prevPaused, running, finished.
//
// Each finished run is stored as a record with its own copy of the code
// snapshot hash and results, so later edits never change older runs.
export function useExecution({ onSave, backend }) {
  const [store, setStore] = useRunStore({ onSave });
  const [session, setSession] = useState(null);
  const [notice, setNotice] = useState(null);
  const [selectedRunId, setSelectedRunId] = useState(() => store.runs.at(-1)?.id ?? null);
  const handleRef = useRef(null);
  const storeRef = useRef(store);
  storeRef.current = store;

  useEffect(() => () => handleRef.current?.stop(), []);

  // Real run through the local runtime. Edits are saved first, so the run
  // executes exactly what is on screen.
  const runLocal = useCallback(
    async (path, files, flush, { mode = 'run', breakpoints = [] } = {}) => {
      setNotice(null);
      const snapshot = files[path] ?? '';
      let pauses = 0;
      setSession({ mode, path, output: [], partial: '', real: true, running: true, paused: null, prevPaused: null, finished: false });
      try {
        await flush?.();
        handleRef.current = backend.startRun({
          path,
          mode,
          breakpoints,
          onOutput: (line) => setSession((s) => (s && s.real ? { ...s, output: [...s.output, line] } : s)),
          onPartial: (partial) => setSession((s) => (s && s.real ? { ...s, partial } : s)),
          onPaused: (pause) => {
            pauses += 1;
            setSession((s) => (s && s.real ? { ...s, running: false, prevPaused: s.paused, paused: pause } : s));
          },
          onResumed: () => setSession((s) => (s && s.real ? { ...s, running: true } : s)),
          onFinish: (result) => {
            handleRef.current = null;
            // Step through and Debug keep their panel open on "Finished" until closed.
            setSession((s) =>
              mode !== 'run' && s && s.real && result.status !== 'rejected'
                ? { ...s, running: false, finished: true, partial: '', noBreakpointHit: mode === 'debug' && pauses === 0, status: result.status }
                : null
            );
            if (result.status === 'rejected') {
              setNotice({ kind: 'runtime', path, title: 'The run didn’t start', detail: result.message });
              return;
            }
            const number = storeRef.current.nextNumber;
            const record = {
              id: `run-${number}`,
              number,
              path,
              snapshotHash: shortHash(snapshot),
              versionLabel: null,
              createdAt: Date.now(),
              durationMs: result.durationMs,
              status: result.status,
              exitCode: result.exitCode ?? null,
              python: result.python,
              lostConnection: !!result.lostConnection,
              output: result.output,
              variables: result.variables,
              figures: result.figures,
              metrics: result.metrics,
              error: result.error || null,
              real: true,
            };
            setStore((s) => ({ runs: [...s.runs, record], nextNumber: s.nextNumber + 1 }));
            setSelectedRunId(record.id);
          },
        });
      } catch (e) {
        handleRef.current = null;
        setSession(null);
        setNotice({ kind: 'runtime', path, title: 'The run didn’t start', detail: e.message });
        return false;
      }
      return true;
    },
    [backend, setStore]
  );

  const runDemo = useCallback(
    (path, files) => {
      setNotice(null);
      const check = checkRunnable(path, files);
      if (!check.ok) {
        setNotice({ kind: 'unsupported', path, title: check.title, detail: check.detail, resetPath: check.resetPath || path });
        return false;
      }
      const snapshot = files[path];
      setSession({ mode: 'run', path, output: [] });
      handleRef.current = startRun({
        path,
        files,
        onOutput: (line) => setSession((s) => (s && s.mode === 'run' ? { ...s, output: [...s.output, line] } : s)),
        onFinish: (result) => {
          handleRef.current = null;
          const number = storeRef.current.nextNumber;
          const record = {
            id: `run-${number}`,
            number,
            path,
            snapshotHash: shortHash(snapshot),
            versionLabel: result.version.label,
            createdAt: Date.now(),
            durationMs: result.durationMs,
            status: result.status,
            output: result.output,
            variables: result.variables,
            figures: result.figures,
            metrics: result.metrics,
            error: result.error || null,
          };
          setStore((s) => ({ runs: [...s.runs, record], nextNumber: s.nextNumber + 1 }));
          setSelectedRunId(record.id);
          setSession(null);
        },
      });
      return true;
    },
    [setStore]
  );

  const run = IS_LOCAL ? runLocal : runDemo;

  const startTrace = useCallback((mode, files, breakpoints, { path, flush, breakpointList } = {}) => {
    if (IS_LOCAL) {
      // Real Step through / Debug: the script runs under Python's debugger.
      runLocal(path, files, flush, { mode, breakpoints: breakpointList || [] });
      return true;
    }
    handleRef.current?.stop();
    setNotice(null);
    if (!traceMatches(files[DEBUG_FILE] ?? '')) {
      setSession(null);
      setNotice({
        kind: 'trace',
        path: DEBUG_FILE,
        title: `${mode === 'debug' ? 'Debug' : 'Step through'} needs the original ${DEBUG_FILE}`,
        detail:
          'The demo uses a prepared trace that only matches the sample code, so it can’t show values for your edited version. Your edits are saved. Reset the file to try it.',
        resetPath: DEBUG_FILE,
      });
      return false;
    }
    if (mode === 'step') {
      setSession({ mode, path: DEBUG_FILE, index: 0, prevIndex: null, finished: false });
    } else {
      const index = nextBreakpointIndex(-1, breakpoints);
      setSession({ mode, path: DEBUG_FILE, index: Math.max(index, 0), prevIndex: null, finished: index === -1, noBreakpointHit: index === -1 });
    }
    return true;
  }, [runLocal]);

  const next = useCallback(() => {
    if (IS_LOCAL) return handleRef.current?.command?.('next');
    setSession((s) => {
      if (!s || s.mode === 'run' || s.finished) return s;
      const index = s.index + 1;
      if (index >= TRACE.steps.length) return { ...s, finished: true, prevIndex: s.index };
      return { ...s, index, prevIndex: s.index };
    });
  }, []);

  const continueTrace = useCallback((breakpoints) => {
    if (IS_LOCAL) return handleRef.current?.command?.('continue');
    setSession((s) => {
      if (!s || s.mode === 'run' || s.finished) return s;
      const index = nextBreakpointIndex(s.index, breakpoints);
      if (index === -1) return { ...s, finished: true, prevIndex: s.index };
      return { ...s, index, prevIndex: s.index };
    });
  }, []);

  const stop = useCallback(() => {
    if (handleRef.current) handleRef.current.stop(); // onFinish records a "stopped" run
    else setSession(null);
  }, []);

  // Real runs only: debugger steps, typed input, breakpoint changes mid-run.
  const stepIn = useCallback(() => handleRef.current?.command?.('step'), []);
  const stepOut = useCallback(() => handleRef.current?.command?.('out'), []);
  const sendInput = useCallback((text) => handleRef.current?.input?.(text), []);
  const endInput = useCallback(() => handleRef.current?.endInput?.(), []);
  const updateBreakpoints = useCallback((list) => handleRef.current?.setBreakpoints?.(list), []);

  const reset = useCallback(() => {
    handleRef.current?.stop();
    handleRef.current = null;
    setSession(null);
    setNotice(null);
    setStore(createStore());
    setSelectedRunId(null);
  }, [setStore]);

  return {
    runs: store.runs,
    session,
    notice,
    setNotice,
    selectedRunId,
    setSelectedRunId,
    run,
    stop,
    startTrace,
    next,
    continueTrace,
    stepIn,
    stepOut,
    sendInput,
    endInput,
    updateBreakpoints,
    reset,
  };
}
