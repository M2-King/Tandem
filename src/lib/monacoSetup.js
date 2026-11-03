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

// Calm syntax colours on the near-black workspace: desaturated hues, one
// accent blue for the cursor and selection.
monaco.editor.defineTheme('tandem-dusk', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: '', foreground: 'DFE2E8' },
    { token: 'comment', foreground: '6F7682', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'B9A2E6' },
    { token: 'string', foreground: 'A3CDA6' },
    { token: 'string.escape', foreground: 'D9B98A' },
    { token: 'number', foreground: 'DDB07E' },
    { token: 'delimiter', foreground: 'A4ABB6' },
    { token: 'type', foreground: '8FB0E6' },
  ],
  colors: {
    'editor.background': '#00000000',
    'editor.foreground': '#DFE2E8',
    'editorLineNumber.foreground': '#5C626D',
    'editorLineNumber.activeForeground': '#C3C8D1',
    'editor.lineHighlightBackground': '#FFFFFF07',
    'editor.lineHighlightBorder': '#00000000',
    'editor.selectionBackground': '#7895DB4D',
    'editor.inactiveSelectionBackground': '#7895DB26',
    'editor.selectionHighlightBackground': '#7895DB1F',
    'editor.wordHighlightBackground': '#FFFFFF0F',
    'editorCursor.foreground': '#A9BCEB',
    'editorBracketHighlight.foreground1': '#C9B98F',
    'editorBracketHighlight.foreground2': '#B7A6DA',
    'editorBracketHighlight.foreground3': '#93AEDB',
    'editorBracketMatch.background': '#FFFFFF10',
    'editorBracketMatch.border': '#FFFFFF30',
    'editorIndentGuide.background1': '#FFFFFF0F',
    'editorIndentGuide.activeBackground1': '#FFFFFF24',
    'editorGutter.background': '#00000000',
    'editorWidget.background': '#242831',
    'editorWidget.border': '#FFFFFF1A',
    'editorHoverWidget.background': '#242831',
    'editorHoverWidget.border': '#FFFFFF1A',
    'editorSuggestWidget.background': '#242831',
    'editorSuggestWidget.border': '#FFFFFF1A',
    'editorSuggestWidget.selectedBackground': '#7895DB33',
    'diffEditor.insertedLineBackground': '#6FBF8E17',
    'diffEditor.insertedTextBackground': '#6FBF8E2E',
    'diffEditor.removedLineBackground': '#E5776F17',
    'diffEditor.removedTextBackground': '#E5776F2E',
    'diffEditorGutter.insertedLineBackground': '#6FBF8E1F',
    'diffEditorGutter.removedLineBackground': '#E5776F1F',
    'diffEditor.diagonalFill': '#FFFFFF0D',
    'scrollbarSlider.background': '#FFFFFF17',
    'scrollbarSlider.hoverBackground': '#FFFFFF26',
    'scrollbarSlider.activeBackground': '#FFFFFF33',
    'scrollbar.shadow': '#00000000',
    'minimap.background': '#00000000',
    'focusBorder': '#7895DB',
  },
});

loader.config({ monaco });

// JetBrains Mono loads asynchronously; re-measure once it arrives so the
// cursor and selection line up with the glyphs.
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => monaco.editor.remeasureFonts());
}

export { monaco };
