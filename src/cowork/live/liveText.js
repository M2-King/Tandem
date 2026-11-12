// Cowork live mode: live typing. Each shared text file is edited through a
// Yjs document (a CRDT), so edits made at the same time on different devices
// merge without losing or doubling text, in any order they arrive.
//
// This module holds the documents of the open project and knows nothing
// about React or the network:
//   - load(path, file, saved)  starts a file's document from its saved copy
//     (003_cowork_live_text.sql), brought up to date if an older build saved
//     the text since;
//   - seed(path, content, revision)  starts it from plain text when no copy
//     was saved yet. Seeding is deterministic (a client id from the text and
//     revision), so two devices seeding the same file end up with the same
//     document instead of doubled text;
//   - setText(path, text)  an edit made here outside the editor (an accepted
//     AI change, Use theirs): applied as the difference;
//   - applyRemote(path, update)  a teammate's edit, or the server's copy;
//   - snapshot(path)  the text and the document to save together;
//   - stateVector / diffFor  catching up with others after joining.
// Undo (Y.UndoManager) only undoes edits made here.
//
// Callbacks:
//   onText(path, text, origin)  the text changed by anything but typing here
//     (a teammate, undo/redo, seeding, catching up): show it, save if undo;
//   onUpdate(path, update)  an update made here (typing, undo, setText):
//     send it to the others.

import * as Y from 'yjs';
import { isNotebook, joinText, serialize as serializeNotebook } from '../../lib/notebook.js';

export const LOCAL = 'local'; // typed or set here
export const REMOTE = 'remote'; // from a teammate or the server
export const SEED = 'seed'; // started from plain text
export const CATCH_UP = 'catch-up'; // brought up to date with text saved by an older build

// Every text file is typed live; notebooks too, cell by cell (below).
// Database files aren't text.
export const isLiveTextPath = (path) => !/\.(db|sqlite|sqlite3)$/i.test(path || '');

// ------------------------------------------------------------ helpers

export function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromBase64(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

// FNV-1a over a string or bytes: a stable 32-bit id.
function hash32(...parts) {
  let h = 0x811c9dc5;
  for (const part of parts) {
    if (typeof part === 'string') {
      for (let i = 0; i < part.length; i++) {
        h ^= part.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
      }
    } else {
      for (let i = 0; i < part.length; i++) {
        h ^= part[i];
        h = Math.imul(h, 0x01000193);
      }
    }
    h ^= 0x7c; // separator
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// The smallest single replacement turning `from` into `to`.
export function textDiff(from, to) {
  if (from === to) return null;
  let start = 0;
  const max = Math.min(from.length, to.length);
  while (start < max && from.charCodeAt(start) === to.charCodeAt(start)) start++;
  let end = 0;
  while (end < max - start && from.charCodeAt(from.length - 1 - end) === to.charCodeAt(to.length - 1 - end)) end++;
  return { index: start, remove: from.length - start - end, insert: to.slice(start, to.length - end) };
}

function applyDiff(ytext, to) {
  const d = textDiff(ytext.toString(), to);
  if (!d) return;
  if (d.remove) ytext.delete(d.index, d.remove);
  if (d.insert) ytext.insert(d.index, d.insert);
}

// Run `fn` in a transaction under a client id derived from `key`, so every
// device doing the same thing to the same document makes the same update.
function deterministic(doc, key, origin, fn) {
  const own = doc.clientID;
  doc.clientID = hash32(key) || 1;
  try {
    doc.transact(fn, origin);
  } finally {
    doc.clientID = own;
  }
}

// An update that carries nothing (no new items, no deletions).
const isEmptyUpdate = (update) => update.length <= 2;

// ------------------------------------------------------------ notebooks
//
// A notebook (.ipynb) isn't edited as one text: its document holds the cells
// (a Y.Array of Y.Maps: id, shape, source) and the rest of the notebook
// (meta). Each cell's source is a Y.Text of its own, typed live in the cell's
// editor exactly like a file (monacoBinding.js), so two people in different
// cells, or in the same cell, merge letter by letter; a cell added, removed or
// moved on one device is added, removed or moved everywhere, and typing in a
// cell someone removed meanwhile goes with it (never stray text in the file).
// `shape` is the rest of the cell as JSON (type, metadata, outputs, in their
// original key order), last writer wins. The file's text is built from these
// in the standard format (lib/notebook.js serialize).

// A notebook's text as cells, or null if it isn't one. Ids are made
// deterministic where missing or repeated (devices seeding agree).
function notebookParts(text) {
  let nb;
  try {
    nb = JSON.parse(text);
  } catch {
    return null;
  }
  if (!nb || typeof nb !== 'object' || !Array.isArray(nb.cells)) return null;
  const seen = new Set();
  const cells = nb.cells.map((c, i) => {
    const cell = c && typeof c === 'object' ? c : {};
    const source = joinText(cell.source);
    let id = typeof cell.id === 'string' && cell.id ? cell.id : '';
    if (!id || seen.has(id)) id = `cell-${i}-${hash32(source, String(i)).toString(16)}`;
    seen.add(id);
    return { id, shape: JSON.stringify({ ...cell, id, source: null }), source };
  });
  return { meta: JSON.stringify({ ...nb, cells: null }), cells };
}

const newYCell = (c) => {
  const m = new Y.Map();
  m.set('id', c.id);
  m.set('shape', c.shape);
  m.set('source', new Y.Text(c.source));
  return m;
};

function notebookText(entry) {
  const meta = entry.meta.get('nb');
  if (!meta) return '';
  const nb = JSON.parse(meta);
  const seen = new Set();
  nb.cells = [];
  for (const m of entry.cells.toArray()) {
    const id = m.get('id');
    if (seen.has(id)) continue; // moved by two people at once: shown once
    seen.add(id);
    nb.cells.push({ ...JSON.parse(m.get('shape')), source: m.get('source').toString() });
  }
  return serializeNotebook(nb);
}

// Bring the document to `text` with the fewest changes: cells matched by id.
function setNotebook(entry, text) {
  const nb = notebookParts(text);
  if (!nb) return; // not valid notebook JSON: keep what we have
  if (entry.meta.get('nb') !== nb.meta) entry.meta.set('nb', nb.meta);
  const yc = entry.cells;
  const wanted = new Set(nb.cells.map((c) => c.id));
  for (let i = yc.length - 1; i >= 0; i--) if (!wanted.has(yc.get(i).get('id'))) yc.delete(i, 1);
  nb.cells.forEach((c, i) => {
    const here = i < yc.length ? yc.get(i) : null;
    if (here && here.get('id') === c.id) {
      if (here.get('shape') !== c.shape) here.set('shape', c.shape);
      applyDiff(here.get('source'), c.source);
      return;
    }
    // Elsewhere in the list: moved (taken out and put back here).
    for (let k = i + 1; k < yc.length; k++) {
      if (yc.get(k).get('id') === c.id) {
        yc.delete(k, 1);
        break;
      }
    }
    yc.insert(i, [newYCell(c)]);
  });
  if (yc.length > nb.cells.length) yc.delete(nb.cells.length, yc.length - nb.cells.length);
}

// ------------------------------------------------------------ the documents

// A file's text, whatever its kind; and setting it with the fewest changes.
const contentOf = (entry) => (entry.notebook ? notebookText(entry) : entry.ytext.toString());
const isEmpty = (entry) => (entry.notebook ? entry.cells.length === 0 && !entry.meta.get('nb') : entry.ytext.length === 0);
const setContent = (entry, text) => (entry.notebook ? setNotebook(entry, text) : applyDiff(entry.ytext, text));

export function createLiveText({ onText = () => {}, onUpdate = () => {} } = {}) {
  const entries = new Map(); // path -> { doc, ytext, undo, ready }

  const make = (path) => {
    const doc = new Y.Doc();
    const notebook = isNotebook(path);
    const entry = { path, doc, notebook, ytext: null, cells: null, meta: null, undo: null, ready: false };
    entry.content = () => contentOf(entry);
    if (notebook) {
      entry.cells = doc.getArray('cells');
      entry.meta = doc.getMap('meta');
      // The cell's own Y.Text, for its editor (null until the cell is in the document).
      entry.cellText = (id) => {
        for (const m of entry.cells.toArray()) if (m.get('id') === id) return m.get('source');
        return null;
      };
      entry.undo = new Y.UndoManager([entry.cells, entry.meta], { trackedOrigins: new Set([LOCAL]), captureTimeout: 400 });
      doc.on('afterTransaction', (tr) => {
        if (tr.origin !== LOCAL && entry.ready && tr.changed.size) onText(entry.path, contentOf(entry), tr.origin === entry.undo ? 'undo' : tr.origin);
      });
    } else {
      entry.ytext = doc.getText('text');
      entry.undo = new Y.UndoManager(entry.ytext, { trackedOrigins: new Set([LOCAL]), captureTimeout: 400 });
      entry.ytext.observe((event, tr) => {
        if (tr.origin !== LOCAL && entry.ready) onText(entry.path, entry.ytext.toString(), tr.origin === entry.undo ? 'undo' : tr.origin);
      });
    }
    doc.on('update', (update, origin) => {
      if (origin !== REMOTE && origin !== SEED && entry.ready) onUpdate(entry.path, update);
    });
    entries.set(path, entry);
    return entry;
  };
  const entryFor = (path) => entries.get(path) || make(path);

  // Ready: the editor binds to it and its edits are live.
  const markReady = (entry) => {
    if (entry.ready) return;
    entry.ready = true;
    entry.undo.clear();
    onText(entry.path, contentOf(entry), SEED);
  };

  return {
    has: (path) => entries.has(path),
    isReady: (path) => !!entries.get(path)?.ready,
    entry: (path) => {
      const e = entries.get(path);
      return e?.ready ? e : null;
    },
    text: (path) => (entries.has(path) ? contentOf(entries.get(path)) : undefined),
    paths: () => [...entries.keys()],
    readyPaths: () => [...entries.values()].filter((e) => e.ready).map((e) => e.path),

    // From a saved copy: { revision, doc (base64) } for a file whose current
    // server copy is { content, revision }.
    load(path, file, saved) {
      const entry = entryFor(path);
      Y.applyUpdate(entry.doc, fromBase64(saved.doc), REMOTE);
      // Saved since by an older build (the copy is behind the file): catch up
      // the same way on every device. (A copy newer than `file` is a save
      // that landed after the file was read: it is the newer one.)
      // (A notebook's copy may hold no cells: saved while it was plain text.)
      const behind = saved.revision < file.revision || (entry.notebook && isEmpty(entry) && file.content);
      if (behind && contentOf(entry) !== file.content) {
        const sv = Y.encodeStateVector(entry.doc);
        deterministic(entry.doc, ['catch-up', file.revision, file.content, toBase64(sv)].join('\u0000'), CATCH_UP, () => setContent(entry, file.content));
      }
      markReady(entry);
      return entry;
    },

    // From plain text, when there is no saved copy and nobody sent one.
    seed(path, content, revision) {
      const entry = entryFor(path);
      if (entry.ready) return entry;
      if (isEmpty(entry) && content) {
        deterministic(entry.doc, ['seed', revision, content].join('\u0000'), SEED, () => setContent(entry, content));
      }
      // Still empty after seeding while others' edits wait: they were based
      // on another start. Show what we have; it settles with the next save.
      markReady(entry);
      return entry;
    },

    // A live file's text was saved by an older build (no document with it):
    // take that text the same way on every device that has the same document.
    catchUp(path, content, revision) {
      const entry = entries.get(path);
      if (!entry?.ready || contentOf(entry) === content) return;
      const sv = Y.encodeStateVector(entry.doc);
      deterministic(entry.doc, ['catch-up', revision, content, toBase64(sv)].join('\u0000'), CATCH_UP, () => setContent(entry, content));
    },

    // An edit made here outside the editor.
    setText(path, text) {
      const entry = entries.get(path);
      if (!entry?.ready) return;
      if (entry.notebook ? contentOf(entry) === text : entry.ytext.length === text.length && entry.ytext.toString() === text) return;
      entry.doc.transact(() => setContent(entry, text), LOCAL);
    },

    applyRemote(path, update) {
      const entry = entryFor(path);
      Y.applyUpdate(entry.doc, typeof update === 'string' ? fromBase64(update) : update, REMOTE);
    },

    snapshot(path) {
      const entry = entries.get(path);
      if (!entry?.ready) return null;
      return { content: contentOf(entry), doc: toBase64(Y.encodeStateAsUpdate(entry.doc)) };
    },
    stateVector(path) {
      const entry = entries.get(path);
      return entry ? toBase64(Y.encodeStateVector(entry.doc)) : null;
    },
    // What a device with state vector `sv` is missing, or null.
    diffFor(path, sv) {
      const entry = entries.get(path);
      if (!entry?.ready) return null;
      const update = Y.encodeStateAsUpdate(entry.doc, sv ? fromBase64(sv) : undefined);
      return isEmptyUpdate(update) ? null : toBase64(update);
    },

    undo: (path) => entries.get(path)?.ready && entries.get(path).undo.undo(),
    redo: (path) => entries.get(path)?.ready && entries.get(path).undo.redo(),

    rename(from, to) {
      const entry = entries.get(from);
      if (!entry || from === to) return;
      entries.delete(from);
      if (isNotebook(from) !== isNotebook(to)) {
        // Now another kind of file (text <-> notebook): it starts again from its text.
        entry.doc.destroy();
        return;
      }
      entries.get(to)?.doc.destroy();
      entry.path = to;
      entries.set(to, entry);
    },
    drop(path) {
      entries.get(path)?.doc.destroy();
      entries.delete(path);
    },
    destroy() {
      for (const e of entries.values()) e.doc.destroy();
      entries.clear();
    },
  };
}
