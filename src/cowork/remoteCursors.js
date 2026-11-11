// Teammates' cursors and selections in a Monaco editor (Cowork preview).
//
// A cursor is { id, name, hue, step }, where step is { select: text } (a
// selection of that text) or { caretAfter: text } (the caret just after it).
// Positions are found in the current text each time, so they stay on the
// right code while you edit around them.

const styled = new Set();

// Monaco decorations take class names, not styles: one small rule per colour.
function hueClass(hue) {
  const name = `peer-h${Math.round(hue)}`;
  if (!styled.has(name)) {
    styled.add(name);
    const style = document.createElement('style');
    style.textContent =
      `.remote-sel.${name}{background:hsla(${hue},70%,62%,.22)}` +
      `.remote-caret.${name}::before{border-left-color:hsl(${hue},75%,68%)}`;
    document.head.appendChild(style);
  }
  return name;
}

function resolve(model, step) {
  const text = model.getValue();
  const needle = step.select ?? step.caretAfter;
  if (!needle) return null;
  const at = text.indexOf(needle);
  if (at < 0) return null;
  const start = model.getPositionAt(at);
  const end = model.getPositionAt(at + needle.length);
  return { start, end, selection: step.select != null };
}

// labels: false leaves out the name above the caret (notebook cells name the
// person on the cell instead).
export function createRemoteCursors(editor, monaco, { labels = true } = {}) {
  const decorations = editor.createDecorationsCollection();
  let widgets = [];

  const clearWidgets = () => {
    widgets.forEach((w) => editor.removeContentWidget(w));
    widgets = [];
  };

  return {
    set(cursors = []) {
      const model = editor.getModel();
      clearWidgets();
      if (!model) return decorations.clear();
      const list = [];
      for (const c of cursors) {
        const spot = resolve(model, c.step);
        if (!spot) continue;
        const cls = hueClass(c.hue);
        if (spot.selection) {
          list.push({
            range: new monaco.Range(spot.start.lineNumber, spot.start.column, spot.end.lineNumber, spot.end.column),
            options: { className: `remote-sel ${cls}`, stickiness: 1, hoverMessage: { value: `${c.name} selected this` } },
          });
        }
        list.push({
          range: new monaco.Range(spot.end.lineNumber, spot.end.column, spot.end.lineNumber, spot.end.column),
          options: { beforeContentClassName: `remote-caret ${cls}`, stickiness: 1 },
        });
        if (!labels) continue;
        // The name above the caret.
        const node = document.createElement('div');
        node.className = 'remote-label';
        node.style.setProperty('--peer-hue', c.hue);
        node.textContent = c.name.split(' ')[0];
        const widget = {
          getId: () => `remote-cursor-${c.id}`,
          getDomNode: () => node,
          getPosition: () => ({
            position: spot.end,
            preference: [monaco.editor.ContentWidgetPositionPreference.ABOVE, monaco.editor.ContentWidgetPositionPreference.BELOW],
          }),
        };
        editor.addContentWidget(widget);
        widgets.push(widget);
      }
      decorations.set(list);
      return undefined;
    },
    dispose() {
      clearWidgets();
      decorations.clear();
    },
  };
}
