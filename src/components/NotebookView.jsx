import { memo, useEffect, useRef, useState, useSyncExternalStore } from 'react';
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

// Monaco for one cell, as tall as its content.
function CellEditor({ path, language, value, fontSize, autoFocus, onChange, onKeys }) {
  const [height, setHeight] = useState(lineHeightFor(fontSize) + 16);
  const keys = useRef(onKeys);
  keys.current = onKeys;
  return (
    <div className="nb-editor" style={{ height }}>
      <Editor
        path={path}
        value={value}
        language={language}
        theme="tandem-dusk"
        onChange={(v) => onChange(v ?? '')}
        onMount={(editor, monaco) => {
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
          wordWrap: language === 'markdown' ? 'on' : 'off',
          stickyScroll: { enabled: false },
          fixedOverflowWidgets: true,
          scrollbar: { vertical: 'hidden', horizontalScrollbarSize: 6, useShadows: false, alwaysConsumeMouseWheel: false },
          contextmenu: true,
        }}
      />
    </div>
  );
}

const Cell = memo(function Cell({ cell, index, count, path, fontSize, state, selected, editing, input, session }) {
  const code = cell.cell_type === 'code';
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
      className={`nb-cell ${code ? 'is-code' : 'is-markdown'} ${selected ? 'is-selected' : ''} ${state ? 'is-running' : ''}`}
      onPointerDown={() => !selected && session.select(cell.id)}
      data-cell={index + 1}
      aria-label={`Cell ${index + 1} of ${count}, ${code ? 'code' : 'Markdown'}`}
      role="group"
    >
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

export default function NotebookView({ session, path, fontSize, onInstallPackage }) {
  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot);
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
          />
        ))}
        <AddBar session={session} after={snap.cells[snap.cells.length - 1]?.id} />
      </div>
    </div>
  );
}
