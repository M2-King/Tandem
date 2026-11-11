// Find and replace across the project's text files, line by line (like
// VS Code's search). Notebooks are searched cell by cell, so results point at
// "cell 3, line 2" instead of a line of the .ipynb JSON.

import { isNotebook, parse, serialize } from './notebook.js';

export const MAX_RESULTS = 2000;
const PREVIEW_BEFORE = 40;
const PREVIEW_LENGTH = 160;

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The pattern for a query, or { error } for an invalid regular expression.
export function buildPattern(query, { matchCase = false, wholeWord = false, regex = false } = {}) {
  if (!query) return { pattern: null };
  let source = regex ? query : escapeRegExp(query);
  if (wholeWord) source = `(?<![\\w])(?:${source})(?![\\w])`;
  try {
    return { pattern: new RegExp(source, `g${matchCase ? '' : 'i'}`) };
  } catch (e) {
    return { error: `Invalid regular expression: ${String(e.message).replace(/^Invalid regular expression: /, '')}` };
  }
}

// Every match in one line: [{ column (0-based), length, text, groups }].
function lineMatches(line, pattern) {
  const out = [];
  pattern.lastIndex = 0;
  let m;
  while ((m = pattern.exec(line)) !== null) {
    if (m[0].length === 0) {
      pattern.lastIndex += 1; // an empty match (e.g. "^"): nothing to show or replace
      if (pattern.lastIndex > line.length) break;
      continue;
    }
    out.push({ column: m.index, length: m[0].length, match: m });
  }
  return out;
}

// What a replacement turns into for one match: $1, $<name>, $& and $$ in
// regex mode; the text as typed otherwise.
export function expandReplacement(replacement, match, regex) {
  if (!regex) return replacement;
  return replacement.replace(/\$(\$|&|`|'|\d{1,2}|<([^>]+)>)/g, (token, what, name) => {
    if (what === '$') return '$';
    if (what === '&') return match[0];
    if (what === '`') return match.input.slice(0, match.index);
    if (what === "'") return match.input.slice(match.index + match[0].length);
    if (name !== undefined) return match.groups?.[name] ?? '';
    const n = Number(what);
    if (n > 0 && n < match.length) return match[n] ?? '';
    // "$12" with only one group: "$1" then "2".
    if (what.length === 2 && Number(what[0]) > 0 && Number(what[0]) < match.length) return (match[Number(what[0])] ?? '') + what[1];
    return token;
  });
}

function preview(line, column, length) {
  const start = Math.max(0, column - PREVIEW_BEFORE);
  const text = line.slice(start, start + PREVIEW_LENGTH).replace(/\t/g, '    ');
  return {
    before: (start > 0 ? '…' : '') + text.slice(0, column - start).trimStart(),
    match: line.slice(column, column + length),
    after: line.slice(column + length, column + length + PREVIEW_LENGTH - (column - start)),
  };
}

// The searchable parts of a file: one unit for a text file, one per cell for a notebook.
// `cells` (from an open notebook) is used instead of the file text when given.
export function unitsOf(path, text, cells) {
  if (isNotebook(path)) {
    const list = cells || parse(text ?? '').notebook?.cells;
    if (list) return list.map((c, i) => ({ path, cell: i + 1, cellId: c.id, text: c.source || '' }));
  }
  return typeof text === 'string' ? [{ path, text }] : [];
}

// Search the project. `sources` is [{ path, text, cells? }] in display order.
// Returns { files: [{ path, matches: [...] }], total, truncated }.
export function searchProject(sources, pattern) {
  const files = [];
  let total = 0;
  let truncated = false;
  for (const source of sources) {
    if (truncated) break;
    const matches = [];
    for (const unit of unitsOf(source.path, source.text, source.cells)) {
      const lines = unit.text.split('\n');
      for (let i = 0; i < lines.length && !truncated; i++) {
        for (const m of lineMatches(lines[i], pattern)) {
          matches.push({
            path: unit.path,
            cell: unit.cell,
            cellId: unit.cellId,
            line: i + 1,
            column: m.column,
            length: m.length,
            ...preview(lines[i], m.column, m.length),
          });
          total += 1;
          if (total >= MAX_RESULTS) {
            truncated = true;
            break;
          }
        }
      }
    }
    if (matches.length) files.push({ path: source.path, matches });
  }
  return { files, total, truncated };
}

// Replace in a piece of text. `only` limits it to one match: { line, column }.
// Returns { text, count }.
export function replaceInText(text, pattern, replacement, { regex = false, only = null } = {}) {
  let count = 0;
  const lines = text.split('\n').map((line, i) => {
    if (only && only.line !== i + 1) return line;
    const found = lineMatches(line, pattern);
    if (!found.length) return line;
    let out = '';
    let last = 0;
    for (const m of found) {
      if (only && m.column !== only.column) continue;
      out += line.slice(last, m.column) + expandReplacement(replacement, m.match, regex);
      last = m.column + m.length;
      count += 1;
    }
    return out + line.slice(last);
  });
  return { text: lines.join('\n'), count };
}

// Replace in a notebook's cells (by position: closed notebooks get new cell
// ids each time they are read). `only` is { cell (1-based), line, column }.
// Returns { sources: Map(cell index → new source), count }.
export function replaceInCells(cells, pattern, replacement, { regex = false, only = null } = {}) {
  const sources = new Map();
  let count = 0;
  cells.forEach((cell, i) => {
    if (only && only.cell !== i + 1) return;
    const result = replaceInText(cell.source || '', pattern, replacement, { regex, only: only && { line: only.line, column: only.column } });
    if (result.count) {
      sources.set(i, result.text);
      count += result.count;
    }
  });
  return { sources, count };
}

// A notebook's cells as { source } (for replacing), from the file text.
export const notebookCells = (text) => parse(text ?? '').notebook?.cells || null;

// A notebook file with some cell sources changed (for notebooks that aren't open).
export function notebookWithSources(text, sources) {
  const parsed = parse(text);
  if (!parsed.notebook) return null;
  const nb = { ...parsed.notebook, cells: parsed.notebook.cells.map((c, i) => (sources.has(i) ? { ...c, source: sources.get(i) } : c)) };
  return serialize(nb);
}
