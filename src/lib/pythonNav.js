// F12 (go to definition) and F2 (rename) for Python, without a language
// server: definitions are found by reading the code (def, class, imports and
// assignments) in the file, the notebook's other cells, and the project's
// other .py files. Rename changes the name everywhere in the file (or
// notebook) outside strings and comments.

import { monaco } from './monacoSetup.js';

const KEYWORDS = new Set(
  'False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case print'.split(' ')
);
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

let config = { getFiles: () => ({}), openAt: () => {}, openCell: () => {} };
let registered = false;

// Where a model's code lives: { path, cell } (a notebook cell's model is "nb.ipynb#<cell id>").
const where = (uri) => ({ path: decodeURIComponent(uri.path.replace(/^\//, '')), cell: uri.fragment || null });

// The models of one file: the file itself, or every cell of a notebook.
const siblings = (model) => {
  const { path } = where(model.uri);
  return monaco.editor.getModels().filter((m) => m.getLanguageId() === 'python' && where(m.uri).path === path);
};

// Definitions of `name` in some text, best first: def/class, then imports, then assignments.
function findDefinitions(text, name, { topLevelOnly = false } = {}) {
  const n = esc(name);
  const kinds = [
    new RegExp(`^(\\s*)(?:async\\s+)?(?:def|class)\\s+(${n})\\b`),
    new RegExp(`^(\\s*)(?:from\\s+\\S+\\s+)?import\\s+(?:.*[\\s,(])?(?:\\S+\\s+as\\s+)?(${n})\\b`),
    new RegExp(`^(\\s*)(?:for\\s+|with\\s+.*\\s+as\\s+)?(${n})\\s*(?::[^=]+)?(?:=(?!=)|\\s+in\\b)`),
  ];
  const found = [];
  const lines = text.split('\n');
  kinds.forEach((re, rank) => {
    lines.forEach((line, i) => {
      const m = re.exec(line);
      if (!m || (topLevelOnly && m[1].length > 0)) return;
      found.push({ rank, line: i + 1, column: m[0].lastIndexOf(name) + 1 });
    });
  });
  return found.sort((a, b) => a.rank - b.rank || a.line - b.line);
}

const location = (uri, d, name) => ({ uri, range: new monaco.Range(d.line, d.column, d.line, d.column + name.length) });

function provideDefinition(model, position) {
  const word = model.getWordAtPosition(position);
  if (!word || KEYWORDS.has(word.word)) return null;
  const name = word.word;
  // 1. This file (or notebook): the closest definition above the cursor, else the first one.
  const here = [];
  for (const m of siblings(model)) {
    for (const d of findDefinitions(m.getValue(), name)) {
      if (m === model && d.line === position.lineNumber && d.column === word.startColumn) continue; // the definition itself
      here.push({ model: m, d });
    }
  }
  const best = here.length ? Math.min(...here.map((h) => h.d.rank)) : null;
  const local = () => {
    const top = here.filter((h) => h.d.rank === best);
    const above = top.filter((h) => h.model === model && h.d.line < position.lineNumber).at(-1);
    const pick = above || top.find((h) => h.model === model) || top[0];
    return [location(pick.model.uri, pick.d, name)];
  };
  if (best !== null && best !== 1) return local();
  // 2. Other Python files in the project (top-level def, class and assignments),
  //    also when the name was only imported here.
  const { path } = where(model.uri);
  const out = [];
  for (const [file, text] of Object.entries(config.getFiles())) {
    if (file === path || !file.endsWith('.py') || typeof text !== 'string') continue;
    const d = findDefinitions(text, name, { topLevelOnly: true }).find((x) => x.rank !== 1);
    if (d) out.push(location(monaco.Uri.parse(file), d, name));
  }
  return out.length || best === null ? out : local();
}

// Each place `name` appears as code (not in a string or comment) in a model.
function occurrences(model, name) {
  const tokens = monaco.editor.tokenize(model.getValue(), 'python');
  const re = new RegExp(`(?<![\\w])${esc(name)}(?![\\w])`, 'g');
  const ranges = [];
  for (let i = 1; i <= model.getLineCount(); i++) {
    const line = model.getLineContent(i);
    const lineTokens = tokens[i - 1] || [];
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line)) !== null) {
      const at = m.index;
      const token = [...lineTokens].reverse().find((t) => t.offset <= at);
      if (token && /string|comment/.test(token.type)) continue;
      // obj.name is another object's attribute, not this name.
      if (at > 0 && line[at - 1] === '.') continue;
      ranges.push(new monaco.Range(i, at + 1, i, at + 1 + name.length));
    }
  }
  return ranges;
}

const renameProvider = {
  resolveRenameLocation(model, position) {
    const word = model.getWordAtPosition(position);
    const token = word && monaco.editor.tokenize(model.getLineContent(position.lineNumber), 'python')[0]?.filter((t) => t.offset <= word.startColumn - 1).at(-1);
    if (!word || KEYWORDS.has(word.word) || !IDENT.test(word.word) || (token && /string|comment/.test(token.type))) {
      return { range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column), text: '', rejectReason: 'Put the cursor on a name (a variable, function or class) to rename it.' };
    }
    return { range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn), text: word.word };
  },
  provideRenameEdits(model, position, newName) {
    const word = model.getWordAtPosition(position);
    if (!word) return { edits: [] };
    if (!IDENT.test(newName) || KEYWORDS.has(newName)) {
      return { edits: [], rejectReason: `“${newName}” isn’t a valid Python name.` };
    }
    const edits = [];
    for (const m of siblings(model)) {
      for (const range of occurrences(m, word.word)) {
        edits.push({ resource: m.uri, versionId: m.getVersionId(), textEdit: { range, text: newName } });
      }
    }
    return { edits };
  },
};

// Jumping to a definition in another file (or notebook cell) opens it in Tandem.
const opener = {
  openCodeEditor(source, resource, selectionOrPosition) {
    const { path, cell } = where(resource);
    const line = selectionOrPosition?.startLineNumber ?? selectionOrPosition?.lineNumber ?? 1;
    if (cell) config.openCell(path, cell, line);
    else if (typeof config.getFiles()[path] === 'string') config.openAt(path, line);
    else return false;
    return true;
  },
};

export function configurePythonNav(next) {
  config = { ...config, ...next };
  if (registered) return;
  registered = true;
  monaco.languages.registerDefinitionProvider('python', { provideDefinition });
  monaco.languages.registerRenameProvider('python', renameProvider);
  monaco.editor.registerEditorOpener(opener);
}

// For tests.
export { findDefinitions };
