import { useCallback, useEffect, useRef, useState } from 'react';
import { usePersistedState } from './usePersistedState.js';
import { STORAGE_KEYS } from '../lib/storage.js';
import { shortHash } from '../lib/text.js';
import { checkRunnable, startRun } from '../services/executionService.js';
import { TRACE, traceMatches, nextBreakpointIndex } from '../services/traceService.js';
import { DEBUG_FILE } from '../data/sampleProject.js';

const createStore = () => ({ runs: [], nextNumber: 1 });

// Runs, the active execution session, and result notices.
//
// session is one of:
//   null
//   { mode: 'run', path, output: [...] }              a run in progress
//   { mode: 'step' | 'debug', path, index, prevIndex,  a paused trace
//     finished, noBreakpointHit }
//
// Each finished run is stored as a record with its own copy of the code
// snapshot hash and results, so later edits never change older runs.
export function useExecution({ onSave }) {
  const [store, setStore] = usePersistedState(STORAGE_KEYS.runs, createStore, {
    onSave,
    restore: (saved) => (Array.isArray(saved?.runs) ? saved : null),
  });
  const [session, setSession] = useState(null);
  const [notice, setNotice] = useState(null);
  const [selectedRunId, setSelectedRunId] = useState(() => store.runs.at(-1)?.id ?? null);
  const handleRef = useRef(null);
  const storeRef = useRef(store);
  storeRef.current = store;

  useEffect(() => () => handleRef.current?.stop(), []);

  const run = useCallback(
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

  const startTrace = useCallback((mode, files, breakpoints) => {
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
  }, []);

  const next = useCallback(() => {
    setSession((s) => {
      if (!s || s.mode === 'run' || s.finished) return s;
      const index = s.index + 1;
      if (index >= TRACE.steps.length) return { ...s, finished: true, prevIndex: s.index };
      return { ...s, index, prevIndex: s.index };
    });
  }, []);

  const continueTrace = useCallback((breakpoints) => {
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
    reset,
  };
}
