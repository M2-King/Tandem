// The page's side of the SQLite worker: one open database at a time.
// Stop ends the worker outright (a runaway query can't be interrupted
// otherwise) and reopens the database as it was last saved.

export function createSqlEngine() {
  let worker = null;
  let nextId = 1;
  const pending = new Map();
  let lastBytes = null; // the database as last opened or saved, for Stop

  const start = () => {
    worker = new Worker(new URL('./sqlWorker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const { id, ok, result, error } = e.data;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (ok) p.resolve(result);
      else p.reject(new Error(error));
    };
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error(e.message || 'SQLite stopped.'));
      pending.clear();
    };
  };

  const call = (type, fields = {}, transfer = []) => {
    if (!worker) start();
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, type, ...fields }, transfer);
    });
  };

  return {
    // bytes: an ArrayBuffer / Uint8Array of a .db file, or null for a new database.
    async open(bytes) {
      lastBytes = bytes ? new Uint8Array(bytes).slice() : null;
      return call('open', { bytes: lastBytes ? lastBytes.slice().buffer : null });
    },
    run: (sql) => call('run', { sql }),
    schema: () => call('schema'),
    async export() {
      const bytes = await call('export');
      lastBytes = new Uint8Array(bytes).slice();
      return bytes;
    },
    // End a running query: a fresh worker with the database as last saved.
    async stop() {
      worker?.terminate();
      worker = null;
      for (const p of pending.values()) p.reject(new Error('Stopped.'));
      pending.clear();
      return call('open', { bytes: lastBytes ? lastBytes.slice().buffer : null });
    },
    close() {
      worker?.terminate();
      worker = null;
      pending.clear();
    },
  };
}
