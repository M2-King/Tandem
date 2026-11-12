// Cowork live mode: merging a fresh copy of a shared project into the one
// open on this device, file by file, by revision. Pure functions (no React,
// no network), so the rules can be tested on their own.
//
// This device keeps, per file:
//   files[path]  the text in the editor (what Run uses)
//   base[path]   { content, revision } of the server copy it was last in step with
// A file has an unsaved edit here when files[path] !== base[path].content.
//
// For each file in the server copy:
//   - same revision as base: nothing to do;
//   - newer, no edit here: take the server text and revision ("wei saved x.py");
//   - newer, edit here: keep the edit and mark a conflict (Use theirs / Keep
//     mine), unless the edit already equals the server text;
//   - only on the server: a file a teammate created, or one renamed from a
//     path that disappeared with the same text;
// and a file gone from the server was removed, or conflicts if it has an
// edit here.

export const hasEdit = (files, base, path) => path in files && (!(path in base) || files[path] !== base[path].content);

// conflicts[path] = { kind: 'newer', by, revision, content } |
//                   { kind: 'removed' } | { kind: 'pending' } (a save was refused; waiting for the server copy)
// `busy`: paths with a save on its way; they are merged on the next pass, so
// our own save landing is never mistaken for a teammate's.
export function mergeProject({ files, base, conflicts = {} }, serverFiles, { busy = new Set() } = {}) {
  const nextFiles = { ...files };
  const nextBase = { ...base };
  const nextConflicts = { ...conflicts };
  const events = []; // { type: 'saved' | 'created' | 'removed' | 'renamed' | 'conflict', path, from?, by? }
  serverFiles = serverFiles.filter((f) => !busy.has(f.path));
  const server = new Map(serverFiles.map((f) => [f.path, f]));

  // Files this device knew that the server no longer has.
  const gone = Object.keys(base).filter((p) => !server.has(p) && !busy.has(p));
  const goneMatched = new Set();

  for (const f of serverFiles) {
    const known = nextBase[f.path];
    if (known) {
      if (f.revision <= known.revision) {
        // In step (or older than a save of ours that already landed).
        if (nextConflicts[f.path]?.kind === 'pending' && f.revision === known.revision) delete nextConflicts[f.path];
        continue;
      }
      const edited = hasEdit(nextFiles, nextBase, f.path);
      if (!edited || nextFiles[f.path] === f.content) {
        nextFiles[f.path] = f.content;
        nextBase[f.path] = { content: f.content, revision: f.revision };
        delete nextConflicts[f.path];
        // (An edit here that equals the server text is our own save landing.)
        if (!edited) events.push({ type: 'saved', path: f.path, by: f.updated_by });
        continue;
      }
      const before = nextConflicts[f.path];
      if (before?.kind !== 'newer' || before.revision !== f.revision) events.push({ type: 'conflict', path: f.path, by: f.updated_by });
      nextConflicts[f.path] = { kind: 'newer', by: f.updated_by, revision: f.revision, content: f.content };
      continue;
    }
    // New to this device: renamed from a vanished path with the same text?
    const from = gone.find((p) => !goneMatched.has(p) && base[p].content === f.content && !(f.path in nextFiles));
    if (from) {
      goneMatched.add(from);
      // Any edit made here to the old path carries over to the new one.
      nextFiles[f.path] = from in nextFiles ? nextFiles[from] : f.content;
      nextBase[f.path] = { content: f.content, revision: f.revision };
      delete nextFiles[from];
      delete nextBase[from];
      if (nextConflicts[from]) {
        if (nextConflicts[from].kind === 'newer') nextConflicts[f.path] = nextConflicts[from];
        delete nextConflicts[from];
      }
      events.push({ type: 'renamed', path: f.path, from, by: f.updated_by });
      continue;
    }
    if (f.path in nextFiles && !(f.path in nextBase)) {
      // Created here a moment ago; the server copy is ours.
      if (nextFiles[f.path] === f.content) nextBase[f.path] = { content: f.content, revision: f.revision };
      continue;
    }
    nextFiles[f.path] = f.content;
    nextBase[f.path] = { content: f.content, revision: f.revision };
    events.push({ type: 'created', path: f.path, by: f.updated_by });
  }

  for (const p of gone) {
    if (goneMatched.has(p)) continue;
    if (hasEdit(nextFiles, nextBase, p)) {
      if (nextConflicts[p]?.kind !== 'removed') events.push({ type: 'conflict', path: p });
      nextConflicts[p] = { kind: 'removed' };
      continue;
    }
    delete nextFiles[p];
    delete nextBase[p];
    delete nextConflicts[p];
    events.push({ type: 'removed', path: p });
  }

  return { files: nextFiles, base: nextBase, conflicts: nextConflicts, events };
}

// One short line for what teammates changed, or null.
export function describeEvents(events, me) {
  const shown = events.filter((e) => e.type !== 'conflict' && (!e.by || e.by !== me));
  if (!shown.length) return null;
  const who = (e) => e.by || 'A teammate';
  if (shown.length === 1) {
    const e = shown[0];
    if (e.type === 'saved') return `${who(e)} saved ${e.path}`;
    if (e.type === 'created') return `${who(e)} created ${e.path}`;
    if (e.type === 'renamed') return `${who(e)} renamed ${e.from} to ${e.path}`;
    return `${e.path} was removed`;
  }
  const by = [...new Set(shown.map((e) => e.by).filter(Boolean))];
  return `${by.length === 1 ? by[0] : 'Teammates'} changed ${shown.length} files: ${shown.map((e) => e.path).join(', ')}`;
}

// The open tabs after a merge: renamed tabs follow, removed ones close.
export function retab({ open, active }, files, events) {
  const renamed = Object.fromEntries(events.filter((e) => e.type === 'renamed').map((e) => [e.from, e.path]));
  const next = open.map((p) => renamed[p] || p).filter((p) => p in files);
  const moved = renamed[active] || active;
  return { open: next, active: next.includes(moved) ? moved : next[Math.max(0, open.indexOf(active) - 1)] || next[0] || null };
}
