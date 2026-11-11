import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChartColumn,
  Coffee,
  Cpu,
  CornerDownLeft,
  Database,
  FileBraces,
  FileCode2,
  FileDatabase,
  FileQuestion,
  FileSpreadsheet,
  FileText,
  Folder,
  Globe,
  NotebookText,
  Palette,
  Search,
  Settings2,
  SquareTerminal,
  X,
} from 'lucide-react';
import Dialog from './Dialog.jsx';
import { FILE_TYPES, extensionOf, fileTypeById, typeOf } from '../lib/fileTypes.js';

// A new file: choose what kind it is, then name it. The extension is added
// for you (a name that already has one keeps it), and the file starts with
// a small template for its kind. "Other" takes any name as it is.
const OTHER = 'other';

// How each kind is shown here: group, icon, colour (hue) and what it is for.
// `runs` marks the kinds Tandem runs; the rest are edited with highlighting.
const INFO = {
  python: { group: 'data', Icon: FileCode2, hue: 212, runs: true, about: 'A Python script. Run it with ▶ Run, step through it or debug it.' },
  notebook: { group: 'data', Icon: NotebookText, hue: 24, runs: true, about: 'Code, notes and charts in cells you run one at a time.', starts: 'One empty code cell' },
  sql: { group: 'data', Icon: Database, hue: 188, runs: true, about: 'Queries to run against a SQLite database in the SQL workspace.' },
  database: { group: 'data', Icon: FileDatabase, hue: 168, runs: true, about: 'An empty SQLite database to create tables in.', starts: 'An empty database' },
  csv: { group: 'data', Icon: FileSpreadsheet, hue: 140, about: 'Table data, one row per line. pandas reads it with read_csv.' },
  json: { group: 'data', Icon: FileBraces, hue: 46, about: 'Structured data or settings.' },
  markdown: { group: 'notes', Icon: FileText, hue: 262, about: 'Notes and documentation with headings, lists and links.' },
  text: { group: 'notes', Icon: FileText, hue: 220, about: 'Plain text.' },
  yaml: { group: 'notes', Icon: Settings2, hue: 328, about: 'Settings and configuration.' },
  toml: { group: 'notes', Icon: Settings2, hue: 296, about: 'Settings, like pyproject.toml or an .ini file.' },
  xml: { group: 'notes', Icon: FileBraces, hue: 14, about: 'Structured data in tags.' },
  html: { group: 'web', Icon: Globe, hue: 16, about: 'A web page.' },
  css: { group: 'web', Icon: Palette, hue: 276, about: 'Styles for a web page.' },
  javascript: { group: 'web', Icon: FileCode2, hue: 52, about: 'JavaScript code.' },
  typescript: { group: 'web', Icon: FileCode2, hue: 204, about: 'TypeScript code.' },
  shell: { group: 'langs', Icon: SquareTerminal, hue: 120, about: 'Commands for a terminal.' },
  r: { group: 'langs', Icon: ChartColumn, hue: 216, about: 'An R script for statistics.' },
  java: { group: 'langs', Icon: Coffee, hue: 22, about: 'Java code.' },
  c: { group: 'langs', Icon: Cpu, hue: 232, about: 'C code.' },
  cpp: { group: 'langs', Icon: Cpu, hue: 250, about: 'C++ code.' },
};
const OTHER_INFO = { Icon: FileQuestion, hue: 220, about: 'Any name you like, with its own extension. Opens as text.' };
const GROUPS = [
  ['data', 'Python & data'],
  ['notes', 'Notes & settings'],
  ['web', 'Web'],
  ['langs', 'Other languages'],
];

const infoOf = (id) => (id === OTHER ? OTHER_INFO : INFO[id] || OTHER_INFO);
const tint = (hue) => ({ '--kind-hue': hue });

function problemWith(path, existing) {
  const p = path.trim();
  if (!p) return 'Enter a file name.';
  if (p.startsWith('/') || p.includes('..') || p.includes('\\')) return 'Use a path inside the project, like src/util.py.';
  if (p.endsWith('/')) return 'Add a file name after the folder.';
  if (existing.includes(p)) return `${p} already exists.`;
  return null;
}

// What a new file of this kind starts with, for the preview.
function startsWith(type, base) {
  const info = INFO[type?.id];
  if (info?.starts) return { note: info.starts };
  const text = type ? type.template(base || 'untitled') : '';
  if (!text.trim()) return { note: 'An empty file' };
  const lines = text.replace(/\n+$/, '').split('\n');
  return { code: lines.slice(0, 6).join('\n') + (lines.length > 6 ? '\n…' : '') };
}

const folderOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

export default function NewFileDialog({ existing, onCreate, onClose, initialType = 'python' }) {
  const [typeId, setTypeId] = useState(initialType);
  const [query, setQuery] = useState('');
  const [name, setName] = useState('');
  const [folder, setFolder] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const listRef = useRef(null);
  const nameRef = useRef(null);
  const type = fileTypeById(typeId);
  const info = infoOf(typeId);

  // Folders the project already has, for the folder picker.
  const folders = useMemo(() => {
    const set = new Set();
    for (const p of existing) {
      const parts = p.split('/').slice(0, -1);
      parts.forEach((_, i) => set.add(parts.slice(0, i + 1).join('/')));
    }
    return [...set].sort();
  }, [existing]);

  // Kinds matching the search, in their groups; "Other" always last.
  const groups = useMemo(() => {
    const raw = query.trim().toLowerCase();
    const q = raw.replace(/^\./, '');
    // ".ts" matches extensions; other words match a kind's name, extension,
    // what it is for, or its group's name.
    const match = (t, group) =>
      !q ||
      (raw.startsWith('.')
        ? t.ext.startsWith(q)
        : [t.label, t.ext, t.id, INFO[t.id]?.about || '', group].some((text) => text.toLowerCase().includes(q)));
    return GROUPS.map(([id, label]) => ({ id, label, types: FILE_TYPES.filter((t) => INFO[t.id]?.group === id && match(t, label)) })).filter(
      (g) => g.types.length
    );
  }, [query]);
  const visible = useMemo(() => [...groups.flatMap((g) => g.types.map((t) => t.id)), OTHER], [groups]);

  // Picking a kind replaces an extension already typed for another kind
  // (todo.md, then HTML → todo + .html).
  const pickKind = (id) => {
    setTypeId(id);
    if (id !== OTHER) setName((n) => (typeOf(n) && typeOf(n).id !== id ? n.replace(/\.[^./]+$/, '') : n));
  };

  // Each search selects its best match (Other when nothing matches).
  useEffect(() => {
    if (query.trim()) pickKind(visible[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  // Keep the selected kind in view.
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [typeId]);

  const choose = (id) => {
    pickKind(id);
    setError(null);
  };

  // Up/Down move through the kinds from the search box or the list.
  const onListKeys = (e) => {
    const i = visible.indexOf(typeId);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = visible[Math.min(visible.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      choose(next);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      nameRef.current?.focus();
    }
  };

  // The full path: folder, name, plus the kind's extension unless the name has one.
  const fileName = useMemo(() => {
    const n = name.trim();
    if (!n || !type || extensionOf(n)) return n;
    return `${n}.${type.ext}`;
  }, [name, type]);
  const path = fileName ? (folder ? `${folder}/${fileName}` : fileName) : '';
  const base = (fileName.split('/').pop() || '').replace(/\.[^.]+$/, '');
  const preview = startsWith(typeOf(path) || type, base);
  const placeholder = type ? (type.id === 'notebook' ? 'analysis' : type.id === 'sql' ? 'queries' : type.id === 'database' ? 'practice' : 'untitled') : 'any-name.ext';

  const submit = async (e) => {
    e.preventDefault();
    const problem = problemWith(path, existing);
    if (problem) {
      setError(problem);
      nameRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      const kind = typeOf(path);
      await onCreate(path, kind ? { text: kind.template(base), binary: !!kind.binary, type: kind.id } : { text: '', type: null });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  const KindIcon = info.Icon;

  return (
    <Dialog title="New file" onClose={onClose} className="dialog-newfile">
      <form className="newfile" onSubmit={submit}>
        <header className="newfile-header">
          <h2 className="dialog-title">New file</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <div className="newfile-body">
          <section className="newfile-picker" aria-label="Kind of file">
            <label className="newfile-search">
              <Search size={14} aria-hidden="true" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onListKeys}
                placeholder="Search kinds (python, .csv, web…)"
                aria-label="Search kinds of file"
                spellCheck={false}
                autoComplete="off"
              />
            </label>
            <div className="newfile-list" role="listbox" aria-label="Kind of file" ref={listRef} tabIndex={-1} onKeyDown={onListKeys}>
              {groups.map((g) => (
                <div key={g.id} role="group" aria-label={g.label}>
                  <div className="newfile-group">{g.label}</div>
                  {g.types.map((t) => {
                    const { Icon, hue } = INFO[t.id];
                    return (
                      <div
                        key={t.id}
                        role="option"
                        aria-selected={typeId === t.id}
                        className={`newfile-kind ${typeId === t.id ? 'is-active' : ''}`}
                        onClick={() => choose(t.id)}
                        onDoubleClick={() => nameRef.current?.focus()}
                      >
                        <span className="kind-icon" style={tint(hue)}>
                          <Icon size={14} aria-hidden="true" />
                        </span>
                        <span className="newfile-kind-label">{t.label}</span>
                        <span className="newfile-ext mono">.{t.ext}</span>
                      </div>
                    );
                  })}
                </div>
              ))}
              {!groups.length && <p className="newfile-empty">No kind matches “{query}”. Choose Other to use any name.</p>}
              <div className="newfile-group">Anything else</div>
              <div
                role="option"
                aria-selected={typeId === OTHER}
                className={`newfile-kind ${typeId === OTHER ? 'is-active' : ''}`}
                onClick={() => choose(OTHER)}
                onDoubleClick={() => nameRef.current?.focus()}
              >
                <span className="kind-icon" style={tint(OTHER_INFO.hue)}>
                  <FileQuestion size={14} aria-hidden="true" />
                </span>
                <span className="newfile-kind-label">Other</span>
                <span className="newfile-ext mono">any</span>
              </div>
            </div>
          </section>

          <section className="newfile-details" aria-live="polite">
            <div className="newfile-summary">
              <span className="kind-icon kind-icon-lg" style={tint(info.hue)}>
                <KindIcon size={22} aria-hidden="true" />
              </span>
              <div className="newfile-summary-text">
                <div className="newfile-summary-title">
                  {type ? type.label : 'Other'}
                  {type && <span className="newfile-ext-pill mono">.{type.ext}</span>}
                </div>
                <p className="newfile-about">{info.about}</p>
              </div>
            </div>
            {type && !info.runs && <p className="newfile-note">Tandem highlights this kind as you edit; it runs Python and SQL.</p>}

            <label className="field">
              <span className="field-label">Name</span>
              <span className="newfile-name">
                <input
                  ref={nameRef}
                  className="field-input mono"
                  value={name}
                  onChange={(e) => {
                    const value = e.target.value;
                    setName(value);
                    setError(null);
                    // A typed extension picks its kind (analysis.sql → SQL).
                    const kind = typeOf(value);
                    if (kind && kind.id !== typeId) setTypeId(kind.id);
                  }}
                  onKeyDown={(e) => (e.key === 'ArrowUp' || e.key === 'ArrowDown') && onListKeys(e)}
                  placeholder={placeholder}
                  spellCheck={false}
                  autoComplete="off"
                  data-autofocus
                  aria-invalid={!!error}
                  aria-describedby={error ? 'new-file-error' : 'new-file-path'}
                />
                {type && !extensionOf(name) && <span className="newfile-suffix mono">.{type.ext}</span>}
              </span>
            </label>

            <label className="field">
              <span className="field-label">Folder</span>
              <span className="newfile-folder">
                <Folder size={14} aria-hidden="true" />
                <select className="field-input" value={folder} onChange={(e) => setFolder(e.target.value)}>
                  <option value="">Project folder</option>
                  {folders.map((f) => (
                    <option key={f} value={f}>
                      {f}/
                    </option>
                  ))}
                </select>
              </span>
            </label>

            {error ? (
              <p className="field-error" id="new-file-error" role="alert">
                {error}
              </p>
            ) : (
              <p className="newfile-path" id="new-file-path">
                {path ? (
                  <>
                    Creates <span className="mono">{path}</span>
                    {folderOf(path) && !folders.includes(folderOf(path)) ? ' (with its new folder)' : ''}
                  </>
                ) : (
                  'Type a name. Add a folder in it (like src/util) to create the folder too.'
                )}
              </p>
            )}

            <div className="newfile-preview">
              <span className="field-label">Starts with</span>
              {preview.code ? <pre className="mono">{preview.code}</pre> : <p>{preview.note}</p>}
            </div>
          </section>
        </div>

        <footer className="newfile-footer">
          <span className="newfile-keys" aria-hidden="true">
            <kbd>↑</kbd>
            <kbd>↓</kbd> choose · <kbd>Enter</kbd> create
          </span>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            <CornerDownLeft size={14} aria-hidden="true" />
            Create
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
