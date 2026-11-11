// The kinds of file Tandem knows: what to call them, which extension a new
// one gets, how the editor highlights it, and what a new one starts with.
// Any other name works too ("Other"): it opens as plain text.

import { newNotebookText } from './notebook.js';

export const FILE_TYPES = [
  { id: 'python', label: 'Python', ext: 'py', language: 'python', template: () => '' },
  { id: 'notebook', label: 'Jupyter notebook', ext: 'ipynb', language: 'json', template: () => newNotebookText() },
  { id: 'sql', label: 'SQL', ext: 'sql', language: 'sql', template: () => '-- Write SQL here. Run all with ▶ Run, or select a part and press Ctrl/Cmd+Enter.\n\n' },
  { id: 'database', label: 'SQLite database', ext: 'db', language: null, binary: true, template: () => '' },
  { id: 'markdown', label: 'Markdown', ext: 'md', language: 'markdown', template: (name) => `# ${name}\n\n` },
  { id: 'text', label: 'Text', ext: 'txt', language: 'plaintext', template: () => '' },
  { id: 'csv', label: 'CSV data', ext: 'csv', language: 'plaintext', template: () => 'name,value\n' },
  { id: 'json', label: 'JSON', ext: 'json', language: 'json', template: () => '{\n  \n}\n' },
  { id: 'yaml', label: 'YAML', ext: 'yaml', language: 'yaml', template: () => '' },
  { id: 'html', label: 'HTML', ext: 'html', language: 'html', template: (name) => `<!doctype html>\n<html>\n  <head>\n    <meta charset="utf-8">\n    <title>${name}</title>\n  </head>\n  <body>\n    \n  </body>\n</html>\n` },
  { id: 'css', label: 'CSS', ext: 'css', language: 'css', template: () => '' },
  { id: 'javascript', label: 'JavaScript', ext: 'js', language: 'javascript', template: () => '' },
  { id: 'typescript', label: 'TypeScript', ext: 'ts', language: 'typescript', template: () => '' },
  { id: 'shell', label: 'Shell script', ext: 'sh', language: 'shell', template: () => '#!/bin/sh\n\n' },
  { id: 'r', label: 'R', ext: 'r', language: 'r', template: () => '' },
  { id: 'java', label: 'Java', ext: 'java', language: 'java', template: () => '' },
  { id: 'c', label: 'C', ext: 'c', language: 'c', template: () => '' },
  { id: 'cpp', label: 'C++', ext: 'cpp', language: 'cpp', template: () => '' },
  { id: 'xml', label: 'XML', ext: 'xml', language: 'xml', template: () => '<?xml version="1.0" encoding="UTF-8"?>\n' },
  { id: 'toml', label: 'TOML / INI config', ext: 'toml', language: 'ini', template: () => '' },
];

// Extra extensions that belong to a known type.
const ALIASES = {
  pyw: 'python', sqlite: 'database', sqlite3: 'database', markdown: 'markdown', yml: 'yaml', htm: 'html',
  mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', tsx: 'typescript', bash: 'shell', zsh: 'shell',
  h: 'c', hpp: 'cpp', cc: 'cpp', ini: 'toml', cfg: 'toml', conf: 'toml', tsv: 'csv', log: 'text',
};

const byId = Object.fromEntries(FILE_TYPES.map((t) => [t.id, t]));
const byExt = Object.fromEntries(FILE_TYPES.map((t) => [t.ext, t]));

export const extensionOf = (path) => {
  const name = String(path || '').split('/').pop();
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

export function typeOf(path) {
  const ext = extensionOf(path);
  return byExt[ext] || byId[ALIASES[ext]] || null;
}

export const fileTypeById = (id) => byId[id] || null;

// Monaco language for a path (plain text when unknown).
export const languageFor = (path) => typeOf(path)?.language || 'plaintext';

export const isDatabase = (path) => typeOf(path)?.id === 'database';
export const isSqlFile = (path) => typeOf(path)?.id === 'sql';
