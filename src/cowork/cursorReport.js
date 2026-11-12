import { createContext } from 'react';

// Cowork live mode: where this person's cursor is, for teammates.
// The editors call report(path, cursor, cell) when the caret or selection
// moves; cursor is { line, column, anchorLine, anchorColumn } (1-based, as
// Monaco counts), cell the notebook cell's id. Null when nobody listens.
export const CursorReportContext = createContext(null);

// A Monaco selection as the cursor teammates see.
export const cursorOfSelection = (s) =>
  s && {
    line: s.positionLineNumber,
    column: s.positionColumn,
    anchorLine: s.selectionStartLineNumber,
    anchorColumn: s.selectionStartColumn,
  };

// Cowork live mode: live typing. { version, entry(path), undo(path), redo(path) }
// where entry(path) is the Yjs document of a live file (liveText.js), or null
// when the file isn't typed live. Null outside live shared projects.
export const LiveTextContext = createContext(null);
