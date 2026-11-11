// Python code completion in the editor, like PyCharm: type "clean." and the
// methods of a str appear, each with its signature, and its documentation
// (the "notes") when you move to it. Suggestions come from Jedi, which reads
// your code and the project's Python (laptop runtime) or the Python built into
// Tandem (iPad); nothing runs.
//
// Each editor model registers where its code belongs (setCompletionContext):
// a .py file is itself; a notebook cell is completed with the code of the
// cells above it, so names defined there are known.
import { monaco } from './monacoSetup.js';

const contexts = new Map(); // model URI -> () => { path, prefix }

export function setCompletionContext(model, getContext) {
  if (!model) return () => {};
  const key = model.uri.toString();
  contexts.set(key, getContext);
  return () => {
    if (contexts.get(key) === getContext) contexts.delete(key);
  };
}

const K = monaco.languages.CompletionItemKind;
const KINDS = {
  function: K.Method,
  class: K.Class,
  module: K.Module,
  instance: K.Variable,
  statement: K.Variable,
  param: K.Variable,
  property: K.Property,
  keyword: K.Keyword,
  path: K.File,
};
const TYPE_LABEL = { function: 'function', class: 'class', module: 'module', instance: 'variable', statement: 'variable', param: 'parameter', property: 'property', keyword: 'keyword', path: 'path' };

// "strip(chars: str | None = None, /) -> str" → "(chars: str | None = None, /) -> str"
const paramsOf = (signature, name) => (signature && signature.startsWith(name) ? signature.slice(name.length) : signature || '');

// A docstring shown as written: its line breaks kept, nothing read as Markdown.
const plainText = (doc) =>
  doc
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.replace(/([\\`*_[\]<>#|])/g, '\\$1').replace(/^( +)/, (m) => '\u00a0'.repeat(m.length)))
    .join('  \n');

let registered = false;

export function registerPythonCompletion(backend) {
  if (registered || !backend?.complete) return;
  registered = true;

  monaco.languages.registerCompletionItemProvider('python', {
    triggerCharacters: ['.'],

    async provideCompletionItems(model, position, _context, token) {
      const ctx = contexts.get(model.uri.toString())?.();
      if (!ctx) return { suggestions: [] };
      const prefix = ctx.prefix || '';
      const prefixLines = prefix ? prefix.split('\n').length - 1 : 0;
      const request = {
        path: ctx.path,
        text: prefix + model.getValue(),
        line: position.lineNumber + prefixLines,
        column: position.column - 1,
      };
      let result;
      try {
        result = await backend.complete(request);
      } catch {
        return { suggestions: [] };
      }
      if (token.isCancellationRequested) return { suggestions: [] };
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      return {
        suggestions: (result.items || []).map((item, i) => ({
          label: {
            label: item.name,
            detail: item.signature ? paramsOf(item.signature, item.name) : undefined,
            description: TYPE_LABEL[item.type] || item.type,
          },
          kind: KINDS[item.type] ?? K.Text,
          insertText: item.name,
          range,
          sortText: String(i).padStart(4, '0'), // Jedi's order: most relevant first
          tandem: { request, name: item.name },
        })),
      };
    },

    // The notes: signature and documentation of the suggestion in focus.
    async resolveCompletionItem(item) {
      if (!item.tandem || !backend.completionDetail) return item;
      try {
        const d = await backend.completionDetail({ ...item.tandem.request, name: item.tandem.name });
        if (d?.signature) item.detail = d.signature;
        // The signature is the detail line at the top; the notes follow.
        if (d?.doc) item.documentation = { value: plainText(d.doc) };
      } catch {
        // No notes for this one: the suggestion still works.
      }
      return item;
    },
  });
}
