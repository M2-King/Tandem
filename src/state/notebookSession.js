import { appendOutput, newCell, parse, serialize } from '../lib/notebook.js';

// One open notebook: its cells, its kernel and what is running. It lives
// outside the notebook view, so a running cell keeps streaming into the
// notebook while another tab is shown, and the kernel (with its variables)
// survives tab switches. Closing the notebook's tab ends it.
//
// Every change is saved through `save(text)` (the project's normal, debounced
// file saving) in the standard .ipynb format.
//
// Shared projects (live typing): attachLive() keeps the notebook in step with
// its live document (cowork/live/liveText.js). Changes made here go into it at
// once (outputs at most every 300 ms); typing in a cell goes in through the
// cell's editor; teammates' changes come back through external().

const SAVE_DELAY = 350;
const OUTPUT_SYNC_DELAY = 300;
const EXTERNAL_DELAY = 60; // coalesce a burst of teammates' keystrokes

export class NotebookSession {
  constructor({ path, text, backend, save }) {
    this.path = path;
    this.backend = backend;
    this.save = save;
    this.listeners = new Set();
    const parsed = parse(text);
    this.error = parsed.error || null;
    this.nb = parsed.notebook || null;
    this.kernel = null;
    this.kernelState = 'none'; // none | starting | idle | busy | restarting | dead | shutdown
    this.kernelProblem = null; // { message, code }
    this.python = null;
    this.running = {}; // cell id -> 'queued' | 'running'
    this.input = null; // { cell, prompt, password }
    this.pendingClear = new Set();
    this.selected = this.nb?.cells[0]?.id || null;
    this.editing = null; // markdown cell being edited
    this.reveal = 0; // bumped when the selection moves by keyboard (scroll it into view)
    this.snapshot = this.makeSnapshot();
  }

  // ---------------------------------------------------------------- store
  subscribe = (fn) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = () => this.snapshot;

  makeSnapshot() {
    return {
      error: this.error,
      cells: this.nb?.cells || [],
      kernelState: this.kernelState,
      kernelProblem: this.kernelProblem,
      python: this.python,
      running: this.running,
      input: this.input,
      selected: this.selected,
      editing: this.editing,
      reveal: this.reveal,
    };
  }

  // changed: true (cells, types, runs), 'source' (typing: its editor sends it
  // live), 'output' (a running cell's output: sent live at most every 300 ms).
  emit({ changed = false } = {}) {
    this.snapshot = this.makeSnapshot();
    this.listeners.forEach((fn) => fn());
    if (changed && this.nb) {
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => this.flush(), SAVE_DELAY);
      if (this.live && changed !== 'source') {
        if (changed === 'output') {
          this.outputTimer ??= setTimeout(() => this.syncLive(), OUTPUT_SYNC_DELAY);
        } else this.syncLive();
      }
    }
  }

  // ---------------------------------------------------------------- live
  syncLive() {
    clearTimeout(this.outputTimer);
    this.outputTimer = null;
    if (this.live && this.nb) this.live.sync(serialize(this.withLiveSources()));
  }

  // { entry, sync(text) }: the live document of this notebook, and how to set
  // it. Returns a function that detaches.
  attachLive({ entry, sync }) {
    this.detachLive?.();
    this.live = { entry, sync };
    const onTransaction = (tr) => {
      if (tr.origin === 'local' || !tr.changed.size) return;
      clearTimeout(this.externalTimer);
      this.externalTimer = setTimeout(() => this.live && this.external(this.live.entry.content()), EXTERNAL_DELAY);
    };
    entry.doc.on('afterTransaction', onTransaction);
    // What is here and not yet in the document goes in now; then take the merged result.
    this.syncLive();
    this.external(entry.content());
    const detach = () => {
      entry.doc.off('afterTransaction', onTransaction);
      if (this.detachLive !== detach) return; // attached again since: that one stays
      clearTimeout(this.externalTimer);
      clearTimeout(this.outputTimer);
      this.outputTimer = null;
      this.live = null;
      this.detachLive = null;
    };
    this.detachLive = detach;
    return detach;
  }

  // The notebook as it is now in the live document (teammates' changes merged
  // with ours). Cells running here keep their outputs; nothing is saved for it.
  external(text) {
    if (!text) return;
    const parsed = parse(text);
    if (parsed.error) return;
    const incoming = parsed.notebook;
    const mine = new Map((this.nb?.cells || []).map((c) => [c.id, c]));
    const cells = incoming.cells.map((c) => {
      const here = mine.get(c.id);
      return here && this.running[c.id] ? { ...c, outputs: here.outputs, execution_count: here.execution_count } : c;
    });
    this.nb = { ...incoming, cells };
    this.error = null;
    if (!cells.some((c) => c.id === this.selected)) this.selected = cells[0]?.id || null;
    if (this.editing && !cells.some((c) => c.id === this.editing)) this.editing = null;
    this.snapshot = this.makeSnapshot();
    this.listeners.forEach((fn) => fn());
  }

  flush() {
    clearTimeout(this.saveTimer);
    if (this.nb) this.save(serialize(this.withLiveSources()));
  }

  // While live, each cell's text is the one in the live document: typed there
  // directly (by its editor, or a teammate's), it is always the newest. The
  // notebook here can trail it by a moment, and saving that would take back
  // letters just typed.
  withLiveSources() {
    const entry = this.live?.entry;
    if (!entry?.cellText) return this.nb;
    return {
      ...this.nb,
      cells: this.nb.cells.map((c) => {
        const text = entry.cellText(c.id);
        return text ? { ...c, source: text.toString() } : c;
      }),
    };
  }

  updateCell(id, fn) {
    this.nb = { ...this.nb, cells: this.nb.cells.map((c) => (c.id === id ? fn(c) : c)) };
  }

  // The code of the code cells above this one (for completion).
  codeBefore(id) {
    const cells = this.nb?.cells || [];
    const index = cells.findIndex((c) => c.id === id);
    const before = cells.slice(0, Math.max(0, index)).filter((c) => c.cell_type === 'code');
    return before.length ? `${before.map((c) => c.source.replace(/^\s*[%!].*$/gm, '')).join('\n')}\n` : '';
  }

  // ---------------------------------------------------------------- editing
  select(id) {
    this.selected = id;
    this.emit();
  }

  setEditing(id) {
    this.editing = id;
    this.emit();
  }

  setSource(id, source) {
    const cell = this.nb.cells.find((c) => c.id === id);
    if (!cell || cell.source === source) return;
    this.updateCell(id, (c) => ({ ...c, source }));
    this.emit({ changed: 'source' });
  }

  insert(type, { after = this.selected, before = null } = {}) {
    const cell = newCell(type);
    const cells = [...this.nb.cells];
    const anchor = before ?? after;
    let index = anchor ? cells.findIndex((c) => c.id === anchor) : cells.length - 1;
    if (index < 0) index = cells.length - 1;
    cells.splice(before ? index : index + 1, 0, cell);
    this.nb = { ...this.nb, cells };
    this.selected = cell.id;
    this.reveal += 1;
    if (type === 'markdown') this.editing = cell.id;
    this.emit({ changed: true });
    return cell.id;
  }

  remove(id) {
    if (this.running[id]) return;
    const index = this.nb.cells.findIndex((c) => c.id === id);
    const cells = this.nb.cells.filter((c) => c.id !== id);
    this.nb = { ...this.nb, cells: cells.length ? cells : [newCell('code')] };
    this.selected = this.nb.cells[Math.min(index, this.nb.cells.length - 1)]?.id || null;
    this.emit({ changed: true });
  }

  move(id, delta) {
    const cells = [...this.nb.cells];
    const i = cells.findIndex((c) => c.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= cells.length) return;
    [cells[i], cells[j]] = [cells[j], cells[i]];
    this.nb = { ...this.nb, cells };
    this.emit({ changed: true });
  }

  setType(id, type) {
    this.updateCell(id, (c) => {
      const next = { id: c.id, cell_type: type, metadata: c.metadata || {}, source: c.source };
      if (type === 'code') Object.assign(next, { execution_count: null, outputs: [] });
      return next;
    });
    this.emit({ changed: true });
  }

  clearOutputs() {
    this.nb = {
      ...this.nb,
      cells: this.nb.cells.map((c) => (c.cell_type === 'code' && !this.running[c.id] ? { ...c, outputs: [], execution_count: null } : c)),
    };
    this.emit({ changed: true });
  }

  // ---------------------------------------------------------------- kernel
  ensureKernel() {
    if (this.kernel && !['dead', 'shutdown'].includes(this.kernelState)) return this.kernel;
    this.kernelProblem = null;
    this.kernelState = 'starting';
    this.kernel = this.backend.startKernel(this.path, {
      onStatus: (state, info) => {
        if (info?.python) this.python = info.python;
        if (state === 'dead' || state === 'shutdown') {
          this.abortAll();
          this.kernelState = state;
          if (state === 'dead') this.kernelProblem = { message: info?.lost ? 'The connection to the runtime was lost.' : 'The kernel stopped (it may have run out of memory). Run a cell to start a new one.' };
          this.kernel = null;
        } else if (state === 'starting' || state === 'restarting') {
          this.kernelState = state;
        } else if (info?.restarted) {
          this.kernelState = 'idle';
        } else if (this.kernelState !== 'restarting') {
          // busy/idle: busy while any cell of this notebook runs.
          this.kernelState = state === 'busy' || Object.keys(this.running).length ? 'busy' : 'idle';
        }
        this.emit();
      },
      onCount: (cell, count) => {
        this.running = { ...this.running, [cell]: 'running' };
        this.updateCell(cell, (c) => ({ ...c, execution_count: count }));
        this.emit({ changed: true });
      },
      onOutput: (cell, output) => {
        this.updateCell(cell, (c) => {
          const base = this.pendingClear.has(cell) ? [] : c.outputs || [];
          this.pendingClear.delete(cell);
          return { ...c, outputs: appendOutput(base, output) };
        });
        this.emit({ changed: 'output' });
      },
      onClear: (cell, wait) => {
        if (wait) this.pendingClear.add(cell);
        else this.updateCell(cell, (c) => ({ ...c, outputs: [] }));
        this.emit({ changed: 'output' });
      },
      onInput: (cell, prompt, password) => {
        this.input = { cell, prompt, password };
        this.emit();
      },
      onDone: (cell, status, count) => {
        const rest = { ...this.running };
        delete rest[cell];
        this.running = rest;
        if (this.input?.cell === cell) this.input = null;
        this.pendingClear.delete(cell);
        if (!Object.keys(rest).length && this.kernelState === 'busy') this.kernelState = 'idle';
        if (count != null) this.updateCell(cell, (c) => ({ ...c, execution_count: count }));
        this.emit({ changed: true });
      },
      onRejected: (message, code) => {
        this.abortAll();
        this.kernel = null;
        this.kernelState = 'none';
        this.kernelProblem = { message, code };
        this.emit();
      },
      onError: (message) => {
        this.kernelProblem = { message };
        this.emit();
      },
    });
    this.emit();
    return this.kernel;
  }

  abortAll() {
    this.running = {};
    this.input = null;
    this.pendingClear.clear();
  }

  run(id) {
    const cell = this.nb.cells.find((c) => c.id === id);
    if (!cell) return;
    if (cell.cell_type !== 'code') {
      if (this.editing === id) this.editing = null;
      this.emit();
      return;
    }
    if (this.running[id]) return;
    const kernel = this.ensureKernel();
    this.updateCell(id, (c) => ({ ...c, outputs: [], execution_count: null }));
    this.running = { ...this.running, [id]: 'queued' };
    this.emit({ changed: true });
    kernel.execute(id, cell.source);
  }

  // Run this cell, then select the next one (adding one at the end, like Jupyter).
  runAndAdvance(id) {
    this.run(id);
    const cells = this.nb.cells;
    const i = cells.findIndex((c) => c.id === id);
    if (i === cells.length - 1) this.insert('code', { after: id });
    else {
      this.reveal += 1;
      this.select(cells[i + 1].id);
    }
  }

  runAll() {
    for (const cell of this.nb.cells) this.run(cell.id);
  }

  sendInput(text) {
    if (!this.input || !this.kernel) return;
    const { cell, prompt, password } = this.input;
    // As Jupyter shows it: the prompt and what was typed.
    this.updateCell(cell, (c) => ({
      ...c,
      outputs: appendOutput(c.outputs || [], { output_type: 'stream', name: 'stdout', text: `${prompt || ''}${password ? '••••' : text}\n` }),
    }));
    this.input = null;
    this.emit({ changed: true });
    this.kernel.input(text);
  }

  interrupt() {
    this.kernel?.interrupt();
  }

  restart({ runAll = false } = {}) {
    if (!this.kernel) {
      if (runAll) this.runAll();
      return;
    }
    this.abortAll();
    this.kernelState = 'restarting';
    this.emit();
    this.kernel.restart();
    if (runAll) {
      const wait = this.subscribe(() => {
        if (this.kernelState === 'idle') {
          wait();
          this.runAll();
        }
      });
    }
  }

  close() {
    this.detachLive?.();
    this.flush();
    this.kernel?.shutdown();
    this.kernel = null;
    this.listeners.clear();
  }
}

// Sessions by path, for the open notebook tabs.
const sessions = new Map();

export function notebookSession(path, { text, backend, save }) {
  let session = sessions.get(path);
  if (!session) {
    session = new NotebookSession({ path, text, backend, save });
    sessions.set(path, session);
  }
  return session;
}

export function closeNotebookSession(path) {
  sessions.get(path)?.close();
  sessions.delete(path);
}

export const hasNotebookSession = (path) => sessions.has(path);
