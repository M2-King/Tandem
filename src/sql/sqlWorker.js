// SQLite for the SQL workspace (sql.js: the real SQLite engine compiled to
// WebAssembly). It runs in its own worker, so a slow or endless query never
// freezes Tandem, and Stop can end it by ending the worker.
//
// Messages (each answered with { id, ok, result | error }):
//   open { bytes? }   open a database (no bytes: a new, empty one)
//   run { sql }       run every statement in order, stopping at the first error
//   schema            tables and views, their columns and row counts
//   export            the database file as bytes

import initSqlJs from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm-browser.wasm?url';

const MAX_ROWS = 1000; // shown per statement; the full count is still reported
const ready = initSqlJs({ locateFile: () => wasmUrl });
let db = null;

const quoteId = (name) => `"${String(name).replace(/"/g, '""')}"`;

function cell(value) {
  if (value instanceof Uint8Array) return { blob: value.length };
  return value;
}

function lineAt(sql, offset) {
  return sql.slice(0, offset).split('\n').length;
}

// The first statement in a piece of SQL, for error messages.
const firstStatement = (sql) => sql.trim().split(/;\s*(\n|$)/)[0].slice(0, 300);

function run(sql) {
  const results = [];
  let changed = false;
  const iterator = db.iterateStatements(sql);
  for (;;) {
    const remaining = iterator.getRemainingSQL();
    const offset = sql.length - remaining.length + (remaining.length - remaining.trimStart().length);
    let next;
    try {
      next = iterator.next();
    } catch (e) {
      results.push({ error: String(e.message || e), sql: firstStatement(remaining), line: lineAt(sql, offset) });
      break;
    }
    if (next.done) break;
    const stmt = next.value;
    const text = stmt.getSQL();
    const started = performance.now();
    const columns = stmt.getColumnNames();
    const rows = [];
    let total = 0;
    try {
      while (stmt.step()) {
        total += 1;
        if (rows.length < MAX_ROWS) rows.push(stmt.get().map(cell));
      }
    } catch (e) {
      results.push({ error: String(e.message || e), sql: text, line: lineAt(sql, offset) });
      break;
    }
    const writes = columns.length === 0;
    if (writes) changed = true;
    results.push({
      sql: text,
      line: lineAt(sql, offset),
      columns,
      rows,
      total,
      truncated: total > rows.length,
      modified: writes ? db.getRowsModified() : 0,
      ms: Math.round((performance.now() - started) * 10) / 10,
    });
  }
  return { results, changed };
}

function schema() {
  const list = db.exec("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY type DESC, name");
  return (list[0]?.values || []).map(([name, type]) => {
    const columns = (db.exec(`PRAGMA table_info(${quoteId(name)})`)[0]?.values || []).map(([, col, colType, notnull, , pk]) => ({
      name: col,
      type: colType,
      notnull: !!notnull,
      pk: !!pk,
    }));
    let count = null;
    try {
      count = db.exec(`SELECT count(*) FROM ${quoteId(name)}`)[0].values[0][0];
    } catch {
      // A view that fails (e.g. refers to a dropped table): no count.
    }
    return { name, type, columns, count };
  });
}

self.onmessage = async (e) => {
  const { id, type } = e.data;
  try {
    const SQL = await ready;
    let result = null;
    let transfer = [];
    if (type === 'open') {
      db?.close();
      db = new SQL.Database(e.data.bytes ? new Uint8Array(e.data.bytes) : undefined);
      db.exec('PRAGMA foreign_keys = ON;');
      result = schema();
    } else if (!db) {
      throw new Error('No database is open.');
    } else if (type === 'run') {
      result = run(String(e.data.sql || ''));
    } else if (type === 'schema') {
      result = schema();
    } else if (type === 'export') {
      result = db.export();
      // export() reopens the database: keep foreign keys on.
      db.exec('PRAGMA foreign_keys = ON;');
      transfer = [result.buffer];
    }
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};
