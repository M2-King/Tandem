import { memo, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import Editor from '@monaco-editor/react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import {
  Play,
  FastForward,
  Square,
  RotateCcw,
  Plus,
  ArrowUp,
  ArrowDown,
  Trash2,
  Eraser,
  Loader2,
  AlertTriangle,
  Package,
  Pencil,
} from 'lucide-react';
import '../lib/monacoSetup.js';
import { lineHeightFor } from './CodeEditor.jsx';
import { bestMime, joinText, stripAnsi } from '../lib/notebook.js';
import { setCompletionContext } from '../lib/pythonCompletion.js';
import { createRemoteCursors } from '../cowork/remoteCursors.js';
import { CursorReportContext, LiveTextContext, cursorOfSelection } from '../cowork/cursorReport.js';
import { bindModel } from '../cowork/live/monacoBinding.js';

// A Jupyter notebook: code and Markdown cells, run in a real kernel.
// Keyboard (like Jupyter): Shift+Enter runs and moves on, Ctrl/Cmd+Enter
// runs in place, Alt/Option+Enter runs and adds a cell below.

// HTML from outputs (pandas tables, …) and Markdown is sanitized: no scripts,
// no event handlers, no <style> that could restyle the app.
const clean = (html) => DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'iframe', 'form'], FORBID_ATTR: ['style'] });
const markdownHtml = (text) => clean(marked.parse(text || '', { gfm: true, breaks: false }));

const KERNEL_TEXT = {
  none: 'Kernel not started',
  starting: 'Starting kernel…',
  idle: 'Kernel idle',
  busy: 'Kernel busy',
  restarting: 'Restarting kernel…',
  dead: 'Kernel stopped',
  shutdown: 'Kernel stopped',
};

function Output({ output }) {
  if (output.output_type === 'stream') {
    return <pre className={`nb-stream ${output.name === 'stderr' ? 'is-stderr' : ''}`}>{stripAnsi(joinText(output.text))}</pre>;
  }
  if (output.output_type === 'error') {
    const trace = stripAnsi((output.traceback || []).join('\n'));
    return (
      <pre className="nb-error" role="alert">
        {trace || `${output.ename}: ${output.evalue}`}
      </pre>
    );
  }
  const data = output.data || {};
  const mime = bestMime(data);
  if (!mime) return null;
  const value = joinText(data[mime]);
  if (mime === 'text/html') return <div className="nb-html" dangerouslySetInnerHTML={{ __html: clean(value) }} />;
  if (mime === 'image/svg+xml') return <div className="nb-image" dangerouslySetInnerHTML={{ __html: clean(value) }} />;
  if (mime === 'image/png' || mime === 'image/jpeg') {
    return (
      <div className="nb-image">
        <img src={`data:${mime};base64,${String(value).replace(/\s/g, '')}`} alt="Output" />
      </div>
    );
  }
  if (mime === 'text/markdown') return <div className="nb-markdown md-rendered" dangerouslySetInnerHTML={{ __html: markdownHtml(value) }} />;
  return <pre className="nb-stream">{stripAnsi(value)}</pre>;
}

function InputPrompt({ input, onSubmit }) {
  const [value, setValue] = useState('');
  const ref = useRef(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <form
      className="nb-input"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(value);
        setValue('');
      }}
    >
      <span className="nb-input-prompt">{input.prompt || 'Input:'}</span>
      <input
        ref={ref}
        className="field-input mono"
        type={input.password ? 'password' : 'text'}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        aria-label={input.prompt || 'Input for the running cell'}
        autoComplete="off"
        spellCheck={false}
      />
      <button type="submit" className="btn btn-secondary btn-sm">
        Send
      </button>
    </form>
  );
}

// Monaco for one cell, as tall as its content. In a shared project the cell
// is typed live (letter by letter both ways, carets kept) through its own text
// in the notebook's live document (liveText.js, monacoBinding.js).
function CellEditor({ path, language, value, fontSize, autoFocus, onChange, onKeys, completionContext, peers, onCursor, live, cellId }) {
  const [height, setHeight] = useState(lineHeightFor(fontSize) + 16);
  const keys = useRef(onKeys);
  keys.current = onKeys;
  const cursorRef = useRef(onCursor);
  cursorRef.current = onCursor;
  const remote = useRef(null);
  const editorRef = useRef(null);
  const monacoRef = useRef(null);
  const binding = useRef(null);
  const liveRef = useRef(live);
  liveRef.current = live;
  const [mounted, setMounted] = useState(false);
  // While bound, the binding owns the editor's text: the cell's value from the
  // notebook (which can trail the typing by a moment) is never pushed into it,
  // or it would take back letters just typed.
  const [bound, setBound] = useState(false);
  const entry = live?.entry || null;
  // Bound to the cell's text once it is in the document (a new cell gets there a
  // moment after it is added), and again if it is replaced (moved by a teammate).
  useEffect(() => {
    if (!entry || !mounted) return undefined;
    let text = null;
    let current = null;
    const tryBind = () => {
      const t = entry.cellText?.(cellId) || null;
      if (t === text) return;
      current?.dispose();
      current = null;
      binding.current = null;
      text = t;
      const editor = editorRef.current;
      const model = editor?.getModel();
      if (t && model) {
        current = bindModel({ monaco: monacoRef.current, editor, model, entry: { doc: entry.doc, ytext: t } });
        binding.current = current;
      }
      setBound(!!current);
    };
    tryBind();
    entry.doc.on('afterTransaction', tryBind);
    return () => {
      entry.doc.off('afterTransaction', tryBind);
      current?.dispose();
      binding.current = null;
      setBound(false);
    };
  }, [entry, cellId, mounted]);
  // Teammates' cursors in this cell (Cowork).
  useEffect(() => {
    remote.current?.set(peers || []);
  }, [peers, value]);
  return (
    <div className="nb-editor" style={{ height }}>
      <Editor
        path={path}
        defaultValue={value}
        value={bound ? undefined : value}
        language={language}
        theme="tandem-dusk"
        onChange={(v) => {
          // A teammate's typing shown here isn't typing here.
          if (binding.current?.applying) return;
          onChange(v ?? '');
        }}
        onMount={(editor, monaco) => {
          editorRef.current = editor;
          monacoRef.current = monaco;
          // Completion knows the code of the cells above this one.
          if (completionContext) setCompletionContext(editor.getModel(), completionContext);
          remote.current = createRemoteCursors(editor, monaco); // with their names, as in files
          if (peers?.length) remote.current.set(peers);
          const fit = () => setHeight(Math.max(lineHeightFor(fontSize) + 16, editor.getContentHeight()));
          editor.onDidContentSizeChange(fit);
          fit();
          // Moving on: leave this cell at once, so typing never lands in it while the next one loads.
          editor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.Enter, () => {
            document.activeElement?.blur?.();
            keys.current('advance');
          });
          editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => keys.current('run'));
          editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.Enter, () => keys.current('insert'));
          editor.onDidFocusEditorText(() => keys.current('focus'));
          // Cowork live: teammates see where this cell's caret is.
          editor.onDidChangeCursorSelection((e) => cursorRef.current?.(cursorOfSelection(e.selection)));
          // Live typing: undo and redo take back only this person's changes.
          editor.onKeyDown((e) => {
            const l = liveRef.current;
            if (!binding.current || !l || !(e.ctrlKey || e.metaKey)) return;
            const z = e.keyCode === monaco.KeyCode.KeyZ;
            const y = e.keyCode === monaco.KeyCode.KeyY;
            if (!z && !y) return;
            e.preventDefault();
            e.stopPropagation();
            if (y || e.shiftKey) l.redo();
            else l.undo();
          });
          setMounted(true);
          // After the click that added the cell has finished, so focus stays here.
          if (autoFocus) {
            editor.focus();
            setTimeout(() => editor.focus(), 0);
          }
        }}
        loading={<div className="editor-loading">Loading…</div>}
        options={{
          fontSize,
          lineHeight: lineHeightFor(fontSize),
          fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          fontLigatures: false,
          lineNumbers: 'off',
          glyphMargin: false,
          folding: false,
          lineDecorationsWidth: 8,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          overviewRulerLanes: 0,
          hideCursorInOverviewRuler: true,
          overviewRulerBorder: false,
          renderLineHighlight: 'none',
          padding: { top: 8, bottom: 8 },
          automaticLayout: true,
          tabSize: 4,
          insertSpaces: true,
          // Long lines wrap, so nothing in a cell is hidden off to the side.
          wordWrap: 'on',
          wrappingIndent: 'indent',
          stickyScroll: { enabled: false },
          fixedOverflowWidgets: true,
          scrollbar: { vertical: 'hidden', horizontalScrollbarSize: 6, useShadows: false, alwaysConsumeMouseWheel: false },
          contextmenu: true,
          wordBasedSuggestions: language === 'python' ? 'off' : 'currentDocument',
          suggest: { showStatusBar: true, preview: false },
        }}
      />
    </div>
  );
}

const Cell = memo(function Cell({ cell, index, count, path, fontSize, state, selected, editing, input, session, peers, live }) {
  const code = cell.cell_type === 'code';
  const reportCursor = useContext(CursorReportContext);
  const label = state === 'running' ? '[*]' : state === 'queued' ? '[…]' : `[${cell.execution_count ?? ' '}]`;
  const onKeys = (key) => {
    if (key === 'focus') return session.select(cell.id);
    if (key === 'advance') return session.runAndAdvance(cell.id);
    if (key === 'run') return session.run(cell.id);
    if (key === 'insert') {
      session.run(cell.id);
      return session.insert('code', { after: cell.id });
    }
  };
  return (
    <div
      className={`nb-cell ${code ? 'is-code' : 'is-markdown'} ${selected ? 'is-selected' : ''} ${state ? 'is-running' : ''} ${peers?.length ? 'has-peer' : ''}`}
      style={peers?.length ? { '--peer-hue': peers[0].hue } : undefined}
      onPointerDown={() => !selected && session.select(cell.id)}
      data-cell={index + 1}
      aria-label={`Cell ${index + 1} of ${count}, ${code ? 'code' : 'Markdown'}${peers?.length ? `, ${peers.map((p) => p.name).join(' and ')} editing` : ''}`}
      role="group"
    >
      {peers?.length > 0 && (
        <span className="nb-peer" aria-hidden="true">
          {peers.map((p) => p.name.split(' ')[0]).join(', ')} {peers.length === 1 ? 'is' : 'are'} editing
        </span>
      )}
      <div className="nb-gutter">
        {code ? (
          <button type="button" className="nb-run" aria-label={`Run cell ${index + 1}`} data-tooltip="Run (Shift+Enter)" onClick={() => session.run(cell.id)} disabled={!!state}>
            {state === 'running' ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
          </button>
        ) : null}
        {code && <span className="nb-count mono">{label}</span>}
      </div>
      <div className="nb-main">
        {code || editing ? (
          <CellEditor
            path={`${path}#${cell.id}`}
            language={code ? 'python' : 'markdown'}
            value={cell.source}
            fontSize={fontSize}
            autoFocus={selected && (editing || !cell.source)}
            onChange={(v) => session.setSource(cell.id, v)}
            onKeys={onKeys}
            completionContext={code ? () => ({ path, prefix: session.codeBefore(cell.id) }) : null}
            peers={peers}
            onCursor={reportCursor ? (cursor) => reportCursor(path, cursor, cell.id) : null}
            live={live}
            cellId={cell.id}
          />
        ) : (
          <div
            className="nb-markdown md-rendered"
            onDoubleClick={() => session.setEditing(cell.id)}
            dangerouslySetInnerHTML={{ __html: markdownHtml(cell.source) || '<p class="nb-empty">Empty Markdown cell. Double-click to write.</p>' }}
          />
        )}
        {code && (cell.outputs?.length > 0 || input) && (
          <div className="nb-outputs" aria-live="polite">
            {cell.outputs.map((o, i) => (
              <Output key={i} output={o} />
            ))}
            {input && <InputPrompt input={input} onSubmit={(v) => session.sendInput(v)} />}
          </div>
        )}
      </div>
      {selected && (
        <div className="nb-cell-tools" role="toolbar" aria-label="Cell">
          {!code && !editing && (
            <button type="button" className="icon-btn icon-btn-sm" aria-label="Edit Markdown" data-tooltip="Edit" onClick={() => session.setEditing(cell.id)}>
              <Pencil size={13} aria-hidden="true" />
            </button>
          )}
          <select className="nb-type" value={cell.cell_type} aria-label="Cell type" onChange={(e) => session.setType(cell.id, e.target.value)} disabled={!!state}>
            <option value="code">Code</option>
            <option value="markdown">Markdown</option>
          </select>
          <button type="button" className="icon-btn icon-btn-sm" aria-label="Move up" data-tooltip="Move up" onClick={() => session.move(cell.id, -1)} disabled={index === 0}>
            <ArrowUp size={13} aria-hidden="true" />
          </button>
          <button type="button" className="icon-btn icon-btn-sm" aria-label="Move down" data-tooltip="Move down" onClick={() => session.move(cell.id, 1)} disabled={index === count - 1}>
            <ArrowDown size={13} aria-hidden="true" />
          </button>
          <button type="button" className="icon-btn icon-btn-sm" aria-label="Delete cell" data-tooltip="Delete" onClick={() => session.remove(cell.id)} disabled={!!state}>
            <Trash2 size={13} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
});

function AddBar({ session, after }) {
  return (
    <div className="nb-add">
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => session.insert('code', { after })}>
        <Plus size={13} aria-hidden="true" /> Code
      </button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => session.insert('markdown', { after })}>
        <Plus size={13} aria-hidden="true" /> Markdown
      </button>
    </div>
  );
}

const NO_PEERS = [];

export default function NotebookView({ session, path, fontSize, onInstallPackage, presence, kernelNote }) {
  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot);
  // Shared projects: the notebook's live document (null until it is ready).
  const liveText = useContext(LiveTextContext);
  const liveEntry = liveText?.entry(path) || null;
  const live = useMemo(
    () => (liveEntry ? { entry: liveEntry, undo: () => liveText.undo(path), redo: () => liveText.redo(path) } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [liveEntry, path]
  );
  const scroller = useRef(null);
  const busy = ['busy', 'starting', 'restarting'].includes(snap.kernelState) || Object.keys(snap.running).length > 0;

  // Keep the selected cell in view when the selection moves by keyboard
  // (Shift+Enter, a new cell). Not on clicks: scrolling under the pointer
  // would move the button being clicked.
  useEffect(() => {
    if (!snap.reveal) return;
    const el = scroller.current?.querySelector('.nb-cell.is-selected');
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [snap.reveal]);

  if (snap.error) {
    return (
      <div className="empty-state">
        <p className="empty-title">This notebook can’t be opened</p>
        <p className="empty-text">{snap.error}</p>
      </div>
    );
  }

  return (
    <div className="notebook">
      <div className="nb-toolbar" role="toolbar" aria-label="Notebook">
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => session.runAll()}>
          <FastForward size={14} aria-hidden="true" /> Run all
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => session.interrupt()} disabled={!busy || snap.kernelState === 'none'}>
          <Square size={13} aria-hidden="true" /> Interrupt
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => session.restart()} disabled={snap.kernelState === 'none' || snap.kernelState === 'restarting'}>
          <RotateCcw size={13} aria-hidden="true" /> Restart
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => session.restart({ runAll: true })} disabled={snap.kernelState === 'restarting'}>
          Restart &amp; run all
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => session.clearOutputs()}>
          <Eraser size={13} aria-hidden="true" /> Clear outputs
        </button>
        <span className={`nb-kernel is-${snap.kernelState}`} role="status" title={snap.python || undefined}>
          <span className="runtime-dot" aria-hidden="true" />
          {KERNEL_TEXT[snap.kernelState] || snap.kernelState}
          {kernelNote && <span className="nb-kernel-note"> · {kernelNote}</span>}
        </span>
      </div>

      {snap.kernelProblem && (
        <div className="callout callout-warning nb-problem">
          <AlertTriangle size={16} aria-hidden="true" />
          <div className="callout-body">
            <p>{snap.kernelProblem.message}</p>
            {snap.kernelProblem.code === 'missing-ipykernel' && onInstallPackage && (
              <div className="callout-actions">
                <button type="button" className="btn btn-primary btn-sm" onClick={() => onInstallPackage('ipykernel')}>
                  <Package size={14} aria-hidden="true" /> Install ipykernel…
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="nb-cells" ref={scroller}>
        {snap.cells.map((cell, i) => (
          <Cell
            key={cell.id}
            cell={cell}
            index={i}
            count={snap.cells.length}
            path={path}
            fontSize={fontSize}
            state={snap.running[cell.id]}
            selected={snap.selected === cell.id}
            editing={snap.editing === cell.id}
            input={snap.input?.cell === cell.id ? snap.input : null}
            session={session}
            peers={presence?.[cell.id] || NO_PEERS}
            live={live}
          />
        ))}
        <AddBar session={session} after={snap.cells[snap.cells.length - 1]?.id} />
      </div>
    </div>
  );
}
