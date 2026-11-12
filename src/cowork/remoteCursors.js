// Teammates' cursors and selections in a Monaco editor (Cowork).
//
// A cursor is { id, name, hue, step }. In live mode step is a position:
// { line, column, anchorLine?, anchorColumn? } (the caret, and where the
// selection started); if the text changed since, it is moved to the nearest
// valid spot. The preview uses { select: text } (a selection of that text) or
// { caretAfter: text } (the caret just after it), found in the current text.

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

const before = (a, b) => a.lineNumber < b.lineNumber || (a.lineNumber === b.lineNumber && a.column < b.column);

function resolve(model, step) {
  if (!step) return null;
  if (step.line != null) {
    const caret = model.validatePosition({ lineNumber: step.line, column: step.column || 1 });
    const anchor = step.anchorLine != null ? model.validatePosition({ lineNumber: step.anchorLine, column: step.anchorColumn || 1 }) : caret;
    const [start, end] = before(anchor, caret) ? [anchor, caret] : [caret, anchor];
    return { start, end, caret, selection: before(start, end) };
  }
  const text = model.getValue();
  const needle = step.select ?? step.caretAfter;
  if (!needle) return null;
  const at = text.indexOf(needle);
  if (at < 0) return null;
  const start = model.getPositionAt(at);
  const end = model.getPositionAt(at + needle.length);
  return { start, end, caret: end, selection: step.select != null };
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
          range: new monaco.Range(spot.caret.lineNumber, spot.caret.column, spot.caret.lineNumber, spot.caret.column),
          options: { beforeContentClassName: `remote-caret ${cls}`, stickiness: 1 },
        });
        if (!labels) continue;
        // The name above the caret.
        const node = document.createElement('div');
        node.className = 'remote-label';
        node.dataset.peer = c.id;
        node.style.setProperty('--peer-hue', c.hue);
        node.textContent = c.name.split(' ')[0];
        const widget = {
          getId: () => `remote-cursor-${c.id}`,
          getDomNode: () => node,
          getPosition: () => ({
            position: spot.caret,
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
