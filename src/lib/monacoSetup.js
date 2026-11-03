// Bundle Monaco locally (instead of loading it from a CDN) so the prototype
// works offline. Python highlighting doesn't need a language worker, so only
// the base editor worker is registered.
import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';

self.MonacoEnvironment = {
  getWorker() {
    return new EditorWorker();
  },
};

monaco.editor.defineTheme('tandem-light', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '6B7280', fontStyle: 'italic' },
    { token: 'keyword', foreground: '7C3AED' },
    { token: 'string', foreground: '15803D' },
    { token: 'number', foreground: 'B45309' },
  ],
  colors: {
    'editor.background': '#FFFFFF',
    'editor.foreground': '#202124',
    'editorLineNumber.foreground': '#A3A8B1',
    'editorLineNumber.activeForeground': '#202124',
    'editor.lineHighlightBackground': '#F8F9FB',
    'editor.lineHighlightBorder': '#00000000',
    'editor.selectionBackground': '#CFE0FF',
    'editor.inactiveSelectionBackground': '#E3ECFB',
    'editorCursor.foreground': '#2563EB',
    'editorIndentGuide.background1': '#ECEEF2',
    'editorGutter.background': '#FFFFFF',
    'diffEditor.insertedLineBackground': '#EAF6EE',
    'diffEditor.insertedTextBackground': '#D3EEDC',
    'diffEditor.removedLineBackground': '#FBEAEA',
    'diffEditor.removedTextBackground': '#F6D3D3',
    'scrollbarSlider.background': '#20212418',
    'scrollbarSlider.hoverBackground': '#20212430',
    'focusBorder': '#2563EB',
  },
});

loader.config({ monaco });

// JetBrains Mono loads asynchronously; re-measure once it arrives so the
// cursor and selection line up with the glyphs.
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => monaco.editor.remeasureFonts());
}

export { monaco };
