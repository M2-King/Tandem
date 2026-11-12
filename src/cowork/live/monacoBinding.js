// Cowork live typing: one Monaco model kept in step with one file's Yjs
// text (liveText.js), both ways.
//
//   - Typing here: Monaco's exact changes go into the Yjs text (origin LOCAL).
//   - Anything else changing the Yjs text (a teammate, undo/redo, catching
//     up): applied to the model as exact edits, outside Monaco's own undo
//     history, with every caret and selection kept on the same text
//     (Yjs relative positions), even when the edit lands right before it.
//
// `applying` is true while the binding writes to the model, so the editor
// doesn't report those writes as typing.

import * as Y from 'yjs';
import { LOCAL, textDiff } from './liveText.js';

export function bindModel({ monaco, editor, model, entry }) {
  const { doc, ytext } = entry;
  const binding = { applying: false };
  let saved = null; // carets as relative positions, taken before a change from elsewhere

  // Start from the document's text (the model may hold an older copy).
  if (model.getValue() !== ytext.toString()) {
    binding.applying = true;
    try {
      model.setValue(ytext.toString());
    } finally {
      binding.applying = false;
    }
  }

  const ownsModel = () => editor.getModel() === model;

  const beforeTransaction = (tr) => {
    if (tr.origin === LOCAL || !ownsModel()) return;
    const selections = editor.getSelections() || [];
    // A caret sticks to the text on its left (my own typing), so a teammate
    // typing at the same spot goes after it instead of carrying it along. A
    // selection's ends stick inwards, so text added at its edges stays outside.
    saved = selections.map((s) => {
      const start = model.getOffsetAt(s.getStartPosition());
      const end = model.getOffsetAt(s.getEndPosition());
      return {
        start: Y.createRelativePositionFromTypeIndex(ytext, start, start === end ? -1 : 0),
        end: Y.createRelativePositionFromTypeIndex(ytext, end, -1),
        reversed: s.getDirection() === monaco.SelectionDirection.RTL,
      };
    });
  };

  const observer = (event, tr) => {
    if (tr.origin === LOCAL) return;
    binding.applying = true;
    try {
      let index = 0;
      for (const op of event.delta) {
        if (op.retain !== undefined) {
          index += op.retain;
        } else if (op.insert !== undefined) {
          const at = model.getPositionAt(index);
          model.applyEdits([{ range: new monaco.Range(at.lineNumber, at.column, at.lineNumber, at.column), text: op.insert }]);
          index += op.insert.length;
        } else if (op.delete !== undefined) {
          const from = model.getPositionAt(index);
          const to = model.getPositionAt(index + op.delete);
          model.applyEdits([{ range: new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column), text: '' }]);
        }
      }
      // A safety net: if the model drifted, take the document's text.
      if (model.getValue() !== ytext.toString()) model.setValue(ytext.toString());
      if (saved && ownsModel()) {
        const toPos = (rel) => {
          const abs = Y.createAbsolutePositionFromRelativePosition(rel, doc);
          return model.getPositionAt(abs ? abs.index : 0);
        };
        const selections = saved.map(({ start, end, reversed }) => {
          const a = toPos(start);
          const b = toPos(end);
          return reversed
            ? new monaco.Selection(b.lineNumber, b.column, a.lineNumber, a.column)
            : new monaco.Selection(a.lineNumber, a.column, b.lineNumber, b.column);
        });
        if (selections.length) editor.setSelections(selections);
      }
    } finally {
      saved = null;
      binding.applying = false;
    }
  };

  const typed = model.onDidChangeContent((e) => {
    if (binding.applying) return;
    // The document has this text already (an edit made outside the editor
    // went into it first): nothing to add. (Lengths first: typing changes it.)
    if (ytext.length === model.getValueLength() && ytext.toString() === model.getValue()) return;
    // Monaco's changes are each relative to the text before this event:
    // apply them from the end backwards.
    const changes = [...e.changes].sort((a, b) => b.rangeOffset - a.rangeOffset);
    doc.transact(() => {
      for (const c of changes) {
        if (c.rangeLength) ytext.delete(c.rangeOffset, c.rangeLength);
        if (c.text) ytext.insert(c.rangeOffset, c.text);
      }
    }, LOCAL);
    // Safety net: Monaco and the document must agree after typing (only the
    // difference, so a teammate's text around it is never replaced).
    const d = ytext.length !== model.getValueLength() ? textDiff(ytext.toString(), model.getValue()) : null;
    if (d) {
      doc.transact(() => {
        if (d.remove) ytext.delete(d.index, d.remove);
        if (d.insert) ytext.insert(d.index, d.insert);
      }, LOCAL);
    }
  });

  doc.on('beforeTransaction', beforeTransaction);
  ytext.observe(observer);

  binding.dispose = () => {
    typed.dispose();
    doc.off('beforeTransaction', beforeTransaction);
    ytext.unobserve(observer);
  };
  return binding;
}
