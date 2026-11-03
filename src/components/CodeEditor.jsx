import { useEffect, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import { monaco as monacoApi } from '../lib/monacoSetup.js';

const languageFor = (path) => (path.endsWith('.py') ? 'python' : 'plaintext');

// Replace a model's text as one undoable edit (Ctrl+Z still works after
// accepting an AI change or undoing it).
function replaceModelText(model, text) {
  if (model.getValue() === text) return;
  model.pushStackElement();
  model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
  model.pushStackElement();
}
export const lineHeightFor = (fontSize) => Math.round((fontSize * 22) / 14);

// Monaco editor with Tandem's extras: breakpoints in the glyph margin, the
// current execution line, a fading highlight for applied changes, and
// selection reporting for the "Ask AI" actions.
//
// Monaco keeps one model per file path, so undo history and scroll
// position survive tab switches. React state (`files`) is the source of
// truth; models for inactive files are synced when files change elsewhere
// (accepting a change, undo, reset).
export default function CodeEditor({
  path,
  files,
  onChange,
  readOnly,
  readOnlyMessage,
  fontSize,
  breakpoints,
  execLine,
  flash,
  glyphEnabled,
  onGlyphClick,
  onSelection,
  onAskAI,
  revealRequest,
}) {
  const editorRef = useRef(null);
  const decorations = useRef(null);
  const flashDecorations = useRef(null);
  const hoverDecorations = useRef(null);
  const [mounted, setMounted] = useState(false);

  // Callbacks change every render; keep the latest in refs for Monaco listeners.
  const latest = useRef({});
  latest.current = { path, files, onChange, onGlyphClick, onSelection, onAskAI, glyphEnabled, breakpoints };

  const handleMount = (editor, monaco) => {
    editorRef.current = editor;

    // Report edits for the file the *model* belongs to. (Relying on the
    // current `path` prop is unsafe: during a tab switch the library can
    // emit a change for the new model before our props update.)
    editor.onDidChangeModelContent(() => {
      const model = editor.getModel();
      if (!model) return;
      const uri = model.uri.toString();
      const filePath = Object.keys(latest.current.files).find((p) => monaco.Uri.parse(p).toString() === uri);
      if (filePath) latest.current.onChange(filePath, model.getValue());
    });

    // A model kept from earlier can be out of date (e.g. a change was
    // accepted while the diff view was showing).
    const initialModel = editor.getModel();
    if (initialModel) replaceModelText(initialModel, latest.current.files[latest.current.path] ?? '');
    decorations.current = editor.createDecorationsCollection();
    flashDecorations.current = editor.createDecorationsCollection();
    hoverDecorations.current = editor.createDecorationsCollection();

    const reportSelection = () => {
      const selection = editor.getSelection();
      const model = editor.getModel();
      if (!selection || !model || selection.isEmpty()) return latest.current.onSelection(null);
      const text = model.getValueInRange(selection);
      if (!text.trim()) return latest.current.onSelection(null);
      // A selection ending at column 1 doesn't really include that line.
      const endLine =
        selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber
          ? selection.endLineNumber - 1
          : selection.endLineNumber;
      const anchor = editor.getScrolledVisiblePosition({
        lineNumber: selection.endLineNumber,
        column: selection.endColumn,
      });
      const height = editor.getLayoutInfo().height;
      latest.current.onSelection({
        path: latest.current.path,
        startLine: selection.startLineNumber,
        endLine,
        text,
        top: anchor ? anchor.top + anchor.height + 6 : 0,
        left: anchor ? anchor.left : 0,
        visible: !!anchor && anchor.top >= 0 && anchor.top < height - 20,
      });
    };

    editor.onDidChangeCursorSelection(reportSelection);
    editor.onDidScrollChange(reportSelection);
    editor.onDidChangeModel(() => latest.current.onSelection(null));
    editor.onDidBlurEditorWidget(() => {
      // Let clicks on the floating selection actions land first.
      setTimeout(() => {
        if (!document.activeElement?.closest('.selection-actions')) latest.current.onSelection(null);
      }, 0);
    });

    const { MouseTargetType } = monaco.editor;
    editor.onMouseDown((e) => {
      if (!latest.current.glyphEnabled) return;
      if (e.target.type === MouseTargetType.GUTTER_GLYPH_MARGIN && e.target.position) {
        latest.current.onGlyphClick(e.target.position.lineNumber);
      }
    });
    // Faint dot that shows where a breakpoint can go.
    editor.onMouseMove((e) => {
      const line = e.target.position?.lineNumber;
      const overGutter = e.target.type === MouseTargetType.GUTTER_GLYPH_MARGIN;
      if (!latest.current.glyphEnabled || !overGutter || (latest.current.breakpoints || []).includes(line)) {
        hoverDecorations.current.clear();
        return;
      }
      hoverDecorations.current.set([
        { range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: 'bp-hover-glyph' } },
      ]);
    });
    editor.onMouseLeave(() => hoverDecorations.current.clear());

    editor.addAction({
      id: 'tandem.askAI',
      label: 'Ask AI about selection',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL],
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 0,
      run: () => latest.current.onAskAI(),
    });

    setMounted(true);
  };

  // Keep models of files that aren't on screen in sync with React state.
  useEffect(() => {
    if (!mounted) return;
    for (const [filePath, content] of Object.entries(files)) {
      if (filePath === path) continue;
      const model = monacoApi.editor.getModel(monacoApi.Uri.parse(filePath));
      if (model) replaceModelText(model, content);
    }
  }, [files, path, mounted]);

  // Breakpoints and the current execution line.
  useEffect(() => {
    if (!mounted) return;
    const Range = monacoApi.Range;
    const lines = new Set([...(breakpoints || []), ...(execLine ? [execLine] : [])]);
    const list = [...lines].map((line) => {
      const isBp = (breakpoints || []).includes(line);
      const isExec = line === execLine;
      return {
        range: new Range(line, 1, line, 1),
        options: {
          isWholeLine: isExec,
          className: isExec ? 'exec-line' : undefined,
          glyphMarginClassName: [isBp && 'bp-glyph', isExec && 'exec-glyph'].filter(Boolean).join(' '),
          glyphMarginHoverMessage: isBp ? { value: 'Breakpoint (click to remove)' } : undefined,
        },
      };
    });
    decorations.current.set(list);
    if (execLine) editorRef.current.revealLineInCenterIfOutsideViewport(execLine);
  }, [breakpoints, execLine, mounted, path]);

  // Fading highlight after a change is applied (or when jumping to a line).
  useEffect(() => {
    if (!mounted || !flash || flash.path !== path) return undefined;
    const Range = monacoApi.Range;
    flashDecorations.current.set(
      flash.lines.map((line) => ({
        range: new Range(line, 1, line, 1),
        options: { isWholeLine: true, className: 'applied-line' },
      }))
    );
    if (flash.lines.length) editorRef.current.revealLineInCenterIfOutsideViewport(flash.lines[0]);
    const timer = setTimeout(() => flashDecorations.current.clear(), 900);
    return () => clearTimeout(timer);
  }, [flash, mounted, path]);

  // Move the cursor to a line (e.g. "Go to line 7" from an error).
  useEffect(() => {
    if (!mounted || !revealRequest || revealRequest.path !== path) return;
    const editor = editorRef.current;
    editor.revealLineInCenter(revealRequest.line);
    editor.setPosition({ lineNumber: revealRequest.line, column: 1 });
    editor.focus();
  }, [revealRequest, mounted, path]);

  return (
    <Editor
      path={path}
      value={files[path]}
      language={languageFor(path)}
      theme="tandem-dusk"
      onMount={handleMount}
      keepCurrentModel
      loading={<div className="editor-loading">Loading editor…</div>}
      options={{
        readOnly,
        readOnlyMessage: readOnlyMessage ? { value: readOnlyMessage } : undefined,
        fontSize,
        lineHeight: lineHeightFor(fontSize),
        fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontLigatures: false,
        glyphMargin: glyphEnabled,
        lineNumbersMinChars: 3,
        lineDecorationsWidth: 10,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        overviewRulerLanes: 0,
        hideCursorInOverviewRuler: true,
        overviewRulerBorder: false,
        renderLineHighlight: 'line',
        padding: { top: 12, bottom: 12 },
        automaticLayout: true,
        tabSize: 4,
        insertSpaces: true,
        stickyScroll: { enabled: false },
        fixedOverflowWidgets: true,
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
        bracketPairColorization: { enabled: false },
        guides: { indentation: true },
      }}
    />
  );
}
