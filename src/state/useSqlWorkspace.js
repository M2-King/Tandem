import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createSqlEngine } from '../sql/sqlEngine.js';
import { PRACTICE_DB, PRACTICE_EXERCISES, PRACTICE_SCHEMA, PRACTICE_SQL } from '../sql/practice.js';
import { isDatabase } from '../lib/fileTypes.js';
import { loadJSON, saveJSON } from '../lib/storage.js';

// The SQL workspace: one SQLite database (a .db file in the project) open at
// a time, SQL from the editor run against it, and the results. Every change
// a statement makes is saved to the .db file straight away, so Python code
// (sqlite3) and other tools see the same data.
export function useSqlWorkspace({ backend, ws, notify, active }) {
  const engine = useMemo(() => createSqlEngine(), []);
  useEffect(() => () => engine.close(), [engine]);
  const projectKey = ws.project ? `tandem.sql.db:${ws.project.root}` : null;
  const databases = useMemo(() => (ws.fileOrder || []).filter(isDatabase), [ws.fileOrder]);
  const [dbPath, setDbPath] = useState(null);
  const [opened, setOpened] = useState(null); // the path the engine has open
  const [tables, setTables] = useState([]);
  const [status, setStatus] = useState('idle'); // idle | opening | running
  const [result, setResult] = useState(null); // { sql, results, changed, stopped, error, at, ms }
  const [history, setHistory] = useState([]);
  const busy = useRef(false);

  // The database chosen last time in this project, else the first one there is.
  useEffect(() => {
    if (!projectKey) return;
    const saved = loadJSON(projectKey, null);
    setDbPath((current) => current || (saved && databases.includes(saved) ? saved : databases[0] || null));
  }, [projectKey, databases]);

  const open = useCallback(
    async (path) => {
      setStatus('opening');
      try {
        const bytes = path ? await backend.readRaw(path) : null;
        setTables(await engine.open(bytes));
        setOpened(path);
        setDbPath(path);
        if (projectKey) saveJSON(projectKey, path);
      } catch (e) {
        notify(`Couldn't open ${path}: ${e.message}`);
        setOpened(null);
      } finally {
        setStatus('idle');
      }
    },
    [backend, engine, notify, projectKey]
  );

  // Open the chosen database when the SQL workspace is shown.
  useEffect(() => {
    if (active && dbPath && dbPath !== opened && status === 'idle') open(dbPath);
  }, [active, dbPath, opened, status, open]);

  const save = useCallback(async () => {
    const bytes = await engine.export();
    await backend.writeRaw(opened, bytes);
  }, [engine, backend, opened]);

  const run = useCallback(
    async (sql, { label } = {}) => {
      if (busy.current) return;
      if (!opened) {
        notify('Choose a database first (or create the practice database).');
        return;
      }
      if (!sql.trim()) return;
      busy.current = true;
      setStatus('running');
      const started = performance.now();
      try {
        const out = await engine.run(sql);
        if (out.changed) await save();
        setTables(await engine.schema());
        const entry = { sql, label, ...out, at: Date.now(), ms: Math.round(performance.now() - started), database: opened };
        setResult(entry);
        setHistory((h) => [{ sql, label, at: entry.at, ok: !out.results.some((r) => r.error), statements: out.results.length }, ...h].slice(0, 30));
      } catch (e) {
        const stopped = e.message === 'Stopped.';
        setResult({ sql, label, results: [], stopped, error: stopped ? null : e.message, at: Date.now(), database: opened });
      } finally {
        busy.current = false;
        setStatus('idle');
      }
    },
    [engine, notify, opened, save]
  );

  const stop = useCallback(async () => {
    try {
      setTables(await engine.stop());
    } finally {
      busy.current = false;
      setStatus('idle');
    }
  }, [engine]);

  // A new, empty database file.
  const create = useCallback(
    async (path) => {
      await engine.open(null);
      const bytes = await engine.export();
      await backend.writeRaw(path, bytes);
      ws.noteFile(path);
      await open(path);
      notify(`Created ${path}`);
    },
    [engine, backend, ws, open, notify]
  );

  // The practice school database and its exercises file.
  const createPractice = useCallback(async () => {
    if (!databases.includes(PRACTICE_DB)) {
      await engine.open(null);
      await engine.run(PRACTICE_SCHEMA);
      await backend.writeRaw(PRACTICE_DB, await engine.export());
      ws.noteFile(PRACTICE_DB);
    }
    if (ws.files[PRACTICE_SQL] === undefined) await ws.createFile(PRACTICE_SQL, PRACTICE_EXERCISES);
    else ws.openFile(PRACTICE_SQL);
    await open(PRACTICE_DB);
    notify('Practice database ready: open practice.sql and run a query.');
  }, [databases, engine, backend, ws, open, notify]);

  const preview = useCallback((table) => run(`SELECT * FROM "${table.replace(/"/g, '""')}" LIMIT 100;`, { label: `Preview of ${table}` }), [run]);

  return { databases, dbPath: opened, choosing: dbPath, tables, status, result, history, open, run, stop, create, createPractice, preview, reload: () => opened && open(opened) };
}
