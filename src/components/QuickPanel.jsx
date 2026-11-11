import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, ChevronRight, CaseSensitive, WholeWord, Regex, Replace, ReplaceAll } from 'lucide-react';
import { iconFor } from './FileSidebar.jsx';
import { buildPattern, searchProject } from '../lib/search.js';
import { keyLabel } from '../lib/keys.js';

// The quick panel at the top of the window, like Cursor and VS Code:
//   files    — Ctrl/⌘+P: open a file by name ("> " lists commands, ":12" goes to line 12)
//   commands — Ctrl/⌘+Shift+P: run any command by name
//   search   — Ctrl/⌘+Shift+F: find in every file; the chevron (or Ctrl/⌘+Shift+H)
//              shows Replace, with Replace (one match) and Replace all.

const fileName = (path) => path.split('/').pop();
const folderOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// Fuzzy match: the query's letters in order. Returns a score (higher is
// better) and the matched positions, or null.
export function fuzzy(query, text) {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return { score: 0, hits: [] };
  const t = text.toLowerCase();
  const hits = [];
  let score = 0;
  let from = 0;
  for (const ch of q) {
    const i = t.indexOf(ch, from);
    if (i < 0) return null;
    hits.push(i);
    score += i === from ? 3 : 1; // runs of letters count more
    if (i === 0 || /[/_\-. ]/.test(t[i - 1])) score += 2; // start of a word
    from = i + 1;
  }
  // Prefer matches in the file name and shorter paths.
  const nameStart = t.lastIndexOf('/') + 1;
  if (hits[0] >= nameStart) score += 5;
  return { score: score - t.length / 100, hits };
}

function Highlighted({ text, hits, offset = 0 }) {
  if (!hits?.length) return text;
  const set = new Set(hits.map((h) => h - offset));
  return [...text].map((ch, i) =>
    set.has(i) ? (
      <mark key={i} className="quick-hit">
        {ch}
      </mark>
    ) : (
      ch
    )
  );
}

function OptionToggle({ icon: Icon, label, pressed, onToggle }) {
  return (
    <button
      type="button"
      className="quick-toggle"
      aria-label={label}
      aria-pressed={pressed}
      data-tooltip={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onToggle}
    >
      <Icon size={16} aria-hidden="true" />
    </button>
  );
}

/* ------------------------------------------------------------------ search */

function SearchView({ initialReplace, initialQuery, getSources, version, onOpenMatch, onReplace, close }) {
  const [query, setQuery] = useState(initialQuery || '');
  const [replacement, setReplacement] = useState('');
  const [showReplace, setShowReplace] = useState(!!initialReplace);
  const [options, setOptions] = useState({ matchCase: false, wholeWord: false, regex: false });
  const [active, setActive] = useState(0);
  const [debounced, setDebounced] = useState(query);
  const queryRef = useRef(null);
  const replaceRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 120);
    return () => clearTimeout(t);
  }, [query]);

  // Replace with a query already in place (from the editor's selection): start in Replace.
  useEffect(() => {
    if (initialReplace && initialQuery) replaceRef.current?.focus();
    else {
      queryRef.current?.focus();
      queryRef.current?.select();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const built = useMemo(() => buildPattern(debounced, options), [debounced, options]);
  const results = useMemo(
    () => (built.pattern ? searchProject(getSources(), built.pattern) : null),
    // `version` changes when files change (typing, replacing).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [built, version]
  );
  const flat = useMemo(() => (results ? results.files.flatMap((f) => f.matches) : []), [results]);
  useEffect(() => setActive((a) => Math.min(a, Math.max(0, flat.length - 1))), [flat.length]);

  useEffect(() => {
    listRef.current?.querySelector('.quick-row.is-active')?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  const toggle = (key) => setOptions((o) => ({ ...o, [key]: !o[key] }));
  const pattern = built.pattern;
  const replaceOne = (match) => pattern && onReplace({ pattern, replacement, regex: options.regex, only: match });
  const replaceAll = () => pattern && flat.length && onReplace({ pattern, replacement, regex: options.regex, only: null });

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!flat.length) return;
      setActive((a) => (e.key === 'ArrowDown' ? (a + 1) % flat.length : (a - 1 + flat.length) % flat.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const inReplace = e.target === replaceRef.current;
      if (inReplace && (e.metaKey || e.ctrlKey)) replaceAll();
      else if (inReplace) flat[active] && replaceOne(flat[active]);
      else if (flat[active]) {
        onOpenMatch(flat[active]);
        close();
      }
    } else if (e.code === 'KeyH' && (e.metaKey || e.ctrlKey) && e.shiftKey) {
      e.preventDefault();
      setShowReplace(true);
      setTimeout(() => replaceRef.current?.focus(), 0);
    }
  };

  const summary = !query
    ? 'Type to search every file in the project.'
    : built.error
      ? null
      : !results
        ? 'Searching…'
        : results.total === 0
          ? 'No results.'
          : `${results.total}${results.truncated ? '+' : ''} result${results.total === 1 ? '' : 's'} in ${results.files.length} file${results.files.length === 1 ? '' : 's'}`;

  let index = -1;
  return (
    <>
      <div className="quick-search" onKeyDown={onKeyDown}>
        <button
          type="button"
          className={`quick-toggle quick-expand ${showReplace ? 'is-open' : ''}`}
          aria-label={showReplace ? 'Hide replace' : 'Show replace'}
          aria-expanded={showReplace}
          data-tooltip={`Replace (${keyLabel('Mod+Shift+H')})`}
          onClick={() => {
            setShowReplace((s) => !s);
            setTimeout(() => (showReplace ? queryRef : replaceRef).current?.focus(), 0);
          }}
        >
          <ChevronRight size={16} aria-hidden="true" />
        </button>
        <div className="quick-fields">
          <div className="quick-field">
            <Search size={16} aria-hidden="true" className="quick-field-icon" />
            <input
              ref={queryRef}
              className="quick-input"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              placeholder="Search in all files"
              aria-label="Search in all files"
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
            />
            <OptionToggle icon={CaseSensitive} label="Match case" pressed={options.matchCase} onToggle={() => toggle('matchCase')} />
            <OptionToggle icon={WholeWord} label="Whole word" pressed={options.wholeWord} onToggle={() => toggle('wholeWord')} />
            <OptionToggle icon={Regex} label="Regular expression" pressed={options.regex} onToggle={() => toggle('regex')} />
          </div>
          {showReplace && (
            <div className="quick-field">
              <Replace size={16} aria-hidden="true" className="quick-field-icon" />
              <input
                ref={replaceRef}
                className="quick-input"
                value={replacement}
                onChange={(e) => setReplacement(e.target.value)}
                placeholder={options.regex ? 'Replace ($1 for a group)' : 'Replace'}
                aria-label="Replace with"
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="off"
              />
              <button
                type="button"
                className="btn btn-secondary btn-sm quick-replace-all"
                onClick={replaceAll}
                disabled={!flat.length}
                data-tooltip={`Replace all (${keyLabel('Mod+Enter')} in Replace)`}
              >
                <ReplaceAll size={14} aria-hidden="true" /> Replace all
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="quick-status" role="status">
        {built.error ? <span className="quick-error">{built.error}</span> : summary}
        {showReplace && flat.length > 0 && <span className="quick-status-hint">Enter replaces the highlighted match</span>}
      </div>
      {results && results.files.length > 0 && (
        <div className="quick-list" ref={listRef} role="listbox" aria-label="Search results">
          {results.files.map((file) => {
            const Icon = iconFor(file.path);
            return (
              <div key={file.path} className="quick-group" role="group" aria-label={file.path}>
                <div className="quick-group-head">
                  <Icon size={14} aria-hidden="true" />
                  <span className="quick-group-name">{fileName(file.path)}</span>
                  <span className="quick-group-dir">{folderOf(file.path)}</span>
                  <span className="quick-count">{file.matches.length}</span>
                </div>
                {file.matches.map((m) => {
                  index += 1;
                  const i = index;
                  return (
                    <div
                      key={`${m.cell || 0}:${m.line}:${m.column}`}
                      className={`quick-row quick-match ${i === active ? 'is-active' : ''}`}
                      role="option"
                      aria-selected={i === active}
                      onPointerEnter={() => setActive(i)}
                      onClick={() => {
                        onOpenMatch(m);
                        close();
                      }}
                    >
                      <span className="quick-where mono">{m.cell ? `Cell ${m.cell} · ${m.line}` : m.line}</span>
                      <span className="quick-preview mono">
                        {m.before}
                        <mark className={showReplace ? 'quick-old' : 'quick-hit'}>{m.match}</mark>
                        {showReplace && <mark className="quick-new">{replacement}</mark>}
                        {m.after}
                      </span>
                      {showReplace && (
                        <button
                          type="button"
                          className="quick-row-btn"
                          aria-label={`Replace this match in ${m.path}`}
                          data-tooltip="Replace"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={(e) => {
                            e.stopPropagation();
                            replaceOne(m);
                          }}
                        >
                          <Replace size={14} aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------- files and commands */

function PickView({ initialText, paths, commands, activePath, onOpenFile, onGoToLine, close }) {
  const [text, setText] = useState(initialText || '');
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  useEffect(() => inputRef.current?.focus(), []);

  const mode = text.startsWith('>') ? 'commands' : text.startsWith(':') ? 'line' : 'files';
  const q = mode === 'files' ? text.trim() : text.slice(1).trim();

  const items = useMemo(() => {
    if (mode === 'line') return [];
    if (mode === 'commands') {
      return commands
        .filter((c) => !c.hidden)
        .map((c) => ({ c, m: fuzzy(q, c.label) }))
        .filter((x) => x.m)
        .sort((a, b) => (q ? b.m.score - a.m.score : 0))
        .map(({ c, m }) => ({ key: c.id, label: c.label, hits: m.hits, shortcut: c.shortcut, disabled: c.disabled, run: c.run }));
    }
    return paths
      .map((p) => ({ p, m: fuzzy(q, p) }))
      .filter((x) => x.m)
      .sort((a, b) => (q ? b.m.score - a.m.score : 0))
      .slice(0, 200)
      .map(({ p, m }) => ({ key: p, path: p, hits: m.hits }));
  }, [mode, q, commands, paths]);
  useEffect(() => setActive(0), [mode, q]);
  useEffect(() => {
    listRef.current?.querySelector('.quick-row.is-active')?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  const choose = (item) => {
    if (!item || item.disabled) return;
    close();
    if (item.path) onOpenFile(item.path);
    else item.run();
  };
  const line = mode === 'line' ? parseInt(q, 10) : NaN;

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!items.length) return;
      setActive((a) => (e.key === 'ArrowDown' ? (a + 1) % items.length : (a - 1 + items.length) % items.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (mode === 'line') {
        if (line > 0 && activePath) {
          close();
          onGoToLine(activePath, line);
        }
      } else choose(items[active]);
    }
  };

  return (
    <>
      <div className="quick-field quick-field-solo" onKeyDown={onKeyDown}>
        <Search size={16} aria-hidden="true" className="quick-field-icon" />
        <input
          ref={inputRef}
          className="quick-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Go to a file by name · type > for commands, : for a line"
          aria-label={mode === 'commands' ? 'Run a command' : 'Go to file'}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
        />
      </div>
      {mode === 'line' ? (
        <div className="quick-status" role="status">
          {!activePath
            ? 'Open a file first.'
            : line > 0
              ? `Press Enter to go to line ${line} of ${activePath}.`
              : `Type a line number in ${activePath}.`}
        </div>
      ) : items.length === 0 ? (
        <div className="quick-status" role="status">
          {mode === 'commands' ? 'No matching commands.' : 'No matching files.'}
        </div>
      ) : (
        <div className="quick-list" ref={listRef} role="listbox" aria-label={mode === 'commands' ? 'Commands' : 'Files'}>
          {items.map((item, i) => {
            const Icon = item.path ? iconFor(item.path) : null;
            const nameStart = item.path ? item.path.lastIndexOf('/') + 1 : 0;
            return (
              <div
                key={item.key}
                className={`quick-row ${i === active ? 'is-active' : ''} ${item.disabled ? 'is-disabled' : ''}`}
                role="option"
                aria-selected={i === active}
                aria-disabled={item.disabled || undefined}
                onPointerEnter={() => setActive(i)}
                onClick={() => choose(item)}
              >
                {item.path ? (
                  <>
                    <Icon size={15} aria-hidden="true" className="quick-row-icon" />
                    <span className="quick-row-label">
                      <Highlighted text={item.path.slice(nameStart)} hits={item.hits} offset={nameStart} />
                    </span>
                    <span className="quick-row-detail">{folderOf(item.path)}</span>
                  </>
                ) : (
                  <>
                    <span className="quick-row-label">
                      <Highlighted text={item.label} hits={item.hits} />
                    </span>
                    {item.disabled && <span className="quick-row-detail">{item.disabled}</span>}
                    {item.shortcut && <kbd className="sel-kbd quick-kbd">{keyLabel(item.shortcut)}</kbd>}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

export default function QuickPanel({ request, onClose, ...props }) {
  const ref = useRef(null);

  // Escape or a click outside closes the panel; focus goes back where it was.
  useEffect(() => {
    const previous = document.activeElement;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    const onDown = (e) => {
      if (!ref.current?.contains(e.target) && !e.target.closest?.('.tooltip')) onClose();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown, true);
      if (previous?.isConnected && !document.activeElement?.closest?.('.monaco-editor, .notebook, textarea, input')) previous.focus?.();
    };
  }, [onClose]);

  const search = request.mode === 'search' || request.mode === 'replace';
  return (
    <div
      ref={ref}
      className={`quick ${search ? 'quick-is-search' : ''}`}
      role="dialog"
      aria-label={search ? 'Search and replace' : request.mode === 'commands' ? 'Commands' : 'Go to file'}
    >
      {search ? (
        <SearchView
          key={request.key}
          initialReplace={request.mode === 'replace'}
          initialQuery={request.query}
          close={onClose}
          {...props}
        />
      ) : (
        <PickView key={request.key} initialText={request.mode === 'commands' ? '> ' : ''} close={onClose} {...props} />
      )}
    </div>
  );
}
