import { useEffect, useRef } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import { monaco } from '../lib/monacoSetup.js';
import { lineHeightFor } from './CodeEditor.jsx';

// How many mounted reviews use each model path.
const modelUsers = new Map();

// Index of the change the cursor is in (or last passed), -1 before the first.
function currentChange(changes, line) {
  let index = -1;
  changes.forEach((c, i) => {
    if ((c.modifiedStartLineNumber || 1) <= line) index = i;
  });
  return index;
}

// Read-only diff of a proposed change. Monaco marks added/removed lines
// with +/- indicators as well as colour. Reports its changes through
// onChanges so the review bar can step through them.
export default function DiffReview({ proposal, inline, fontSize, onChanges }) {
  const report = useRef(onChanges);
  report.current = onChanges;
  const originalPath = `review/${proposal.id}/original/${proposal.path}`;
  const modifiedPath = `review/${proposal.id}/proposed/${proposal.path}`;

  const editorRef = useRef(null);

  // Models must outlive the diff editor that shows them. They are disposed
  // only once no mounted review is using them: disposing a model a widget
  // still holds throws (and React's development double-mount would do
  // exactly that when a review is reopened).
  useEffect(() => {
    const paths = [originalPath, modifiedPath];
    paths.forEach((p) => modelUsers.set(p, (modelUsers.get(p) || 0) + 1));
    return () => {
      try {
        editorRef.current?.setModel(null);
      } catch {
        // already disposed
      }
      editorRef.current = null;
      paths.forEach((p) => modelUsers.set(p, modelUsers.get(p) - 1));
      setTimeout(() => {
        for (const p of paths) {
          if (modelUsers.get(p) > 0) continue;
          modelUsers.delete(p);
          monaco.editor.getModel(monaco.Uri.parse(p))?.dispose();
        }
      }, 0);
    };
  }, [originalPath, modifiedPath]);

  const handleMount = (diffEditor) => {
    editorRef.current = diffEditor;
    const modified = diffEditor.getModifiedEditor();
    let started = false;
    const update = () => {
      if (editorRef.current !== diffEditor) return;
      const changes = diffEditor.getLineChanges() || [];
      if (!started && changes.length) {
        // Open on the first change rather than the top of the file.
        started = true;
        const line = changes[0].modifiedStartLineNumber || 1;
        modified.setPosition({ lineNumber: line, column: 1 });
        modified.revealLineInCenterIfOutsideViewport(line);
      }
      report.current?.({
        count: changes.length,
        index: currentChange(changes, modified.getPosition()?.lineNumber ?? 1),
        next: () => diffEditor.goToDiff('next'),
        prev: () => diffEditor.goToDiff('previous'),
        focus: () => modified.focus(),
      });
    };
    diffEditor.onDidUpdateDiff(update);
    modified.onDidChangeCursorPosition(update);
  };

  useEffect(() => () => report.current?.(null), []);

  return (
    <DiffEditor
      onMount={handleMount}
      original={proposal.baseContent}
      modified={proposal.newContent}
      language={proposal.path.endsWith('.py') ? 'python' : 'plaintext'}
      originalModelPath={originalPath}
      modifiedModelPath={modifiedPath}
      keepCurrentOriginalModel
      keepCurrentModifiedModel
      theme="tandem-dusk"
      loading={<div className="editor-loading">Loading diff…</div>}
      options={{
        readOnly: true,
        originalEditable: false,
        renderSideBySide: !inline,
        useInlineViewWhenSpaceIsLimited: true,
        renderIndicators: true,
        renderOverviewRuler: false,
        fontSize,
        lineHeight: lineHeightFor(fontSize),
        fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        lineNumbersMinChars: 3,
        padding: { top: 12, bottom: 12 },
        stickyScroll: { enabled: false },
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
        diffWordWrap: 'off',
      }}
    />
  );
}
