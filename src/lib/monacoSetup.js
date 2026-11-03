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

monaco.editor.defineTheme('tandem-dusk', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: '', foreground: 'E3E7EF' },
    { token: 'comment', foreground: '7D8596', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'C49BFF' },
    { token: 'string', foreground: '8FD9A8' },
    { token: 'number', foreground: 'F5B66B' },
    { token: 'delimiter', foreground: 'AEB6C4' },
  ],
  colors: {
    'editor.background': '#00000000',
    'editor.foreground': '#E3E7EF',
    'editorLineNumber.foreground': '#5E6676',
    'editorLineNumber.activeForeground': '#C9D0DC',
    'editor.lineHighlightBackground': '#5B8CFF14',
    'editor.lineHighlightBorder': '#00000000',
    'editor.selectionBackground': '#5B8CFF55',
    'editor.inactiveSelectionBackground': '#5B8CFF2E',
    'editorCursor.foreground': '#8FB0FF',
    'editorIndentGuide.background1': '#FFFFFF12',
    'editorIndentGuide.activeBackground1': '#FFFFFF26',
    'editorGutter.background': '#00000000',
    'editorWidget.background': '#1A1E29',
    'editorWidget.border': '#FFFFFF1A',
    'editorHoverWidget.background': '#1A1E29',
    'editorHoverWidget.border': '#FFFFFF1A',
    'editorSuggestWidget.background': '#1A1E29',
    'editorSuggestWidget.border': '#FFFFFF1A',
    'editorSuggestWidget.selectedBackground': '#5B8CFF33',
    'diffEditor.insertedLineBackground': '#62CF951C',
    'diffEditor.insertedTextBackground': '#62CF9533',
    'diffEditor.removedLineBackground': '#FF80771C',
    'diffEditor.removedTextBackground': '#FF807733',
    'diffEditorGutter.insertedLineBackground': '#62CF9522',
    'diffEditorGutter.removedLineBackground': '#FF807722',
    'diffEditor.diagonalFill': '#FFFFFF10',
    'scrollbarSlider.background': '#FFFFFF1C',
    'scrollbarSlider.hoverBackground': '#FFFFFF30',
    'scrollbarSlider.activeBackground': '#FFFFFF40',
    'scrollbar.shadow': '#00000000',
    'minimap.background': '#00000000',
    'focusBorder': '#5B8CFF',
  },
});

loader.config({ monaco });

// JetBrains Mono loads asynchronously; re-measure once it arrives so the
// cursor and selection line up with the glyphs.
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => monaco.editor.remeasureFonts());
}

export { monaco };
