import { useEffect } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import { monaco } from '../lib/monacoSetup.js';
import { lineHeightFor } from './CodeEditor.jsx';

// Read-only diff of a proposed change. Monaco marks added/removed lines
// with +/- indicators as well as colour.
export default function DiffReview({ proposal, inline, fontSize }) {
  const originalPath = `review/${proposal.id}/original/${proposal.path}`;
  const modifiedPath = `review/${proposal.id}/proposed/${proposal.path}`;

  // The diff editor must be disposed before its models, so the models are
  // kept on unmount and cleaned up right after.
  useEffect(
    () => () => {
      setTimeout(() => {
        for (const path of [originalPath, modifiedPath]) monaco.editor.getModel(monaco.Uri.parse(path))?.dispose();
      }, 0);
    },
    [originalPath, modifiedPath]
  );

  return (
    <DiffEditor
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
