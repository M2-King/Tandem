// The code editor (file or notebook cell) used last, so commands from the
// command palette can act on it: "Comment line", "Edit with AI", …

let last = null;

export function trackEditor(editor) {
  if (!last) last = editor;
  editor.onDidFocusEditorWidget(() => {
    last = editor;
  });
  editor.onDidDispose(() => {
    if (last === editor) last = null;
  });
}

// Run a Monaco action (or one of Tandem's) in that editor. False when there is none.
export function runEditorAction(id) {
  const editor = last;
  if (!editor || !editor.getModel()) return false;
  editor.focus();
  const action = editor.getAction(id);
  if (action) action.run();
  else editor.trigger('palette', id, null);
  return true;
}

// Back to the editor (after the Ctrl+K prompt closes).
export function focusLastEditor() {
  if (last?.getModel()) last.focus();
}
