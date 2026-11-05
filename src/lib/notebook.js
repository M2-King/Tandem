// Jupyter notebooks (.ipynb, nbformat 4) as plain data.
//
// Tandem reads and writes the standard format directly, so a notebook saved
// here opens in JupyterLab, VS Code or Colab, and one made there opens here.
// Metadata and outputs Tandem doesn't use are kept as they are.

const KERNELSPEC = { name: 'python3', display_name: 'Python 3 (ipykernel)', language: 'python' };

export const isNotebook = (path) => typeof path === 'string' && path.toLowerCase().endsWith('.ipynb');

const cellId = () => {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
};

// nbformat stores multi-line text as a string or a list of lines.
export const joinText = (value) => (Array.isArray(value) ? value.join('') : value ?? '');

// Back to the list-of-lines form Jupyter writes (keeps diffs readable).
function splitLines(text) {
  if (!text) return [];
  const lines = text.split(/(?<=\n)/);
  return lines;
}

export function newCell(type = 'code', source = '') {
  const cell = { id: cellId(), cell_type: type, metadata: {}, source };
  if (type === 'code') {
    cell.execution_count = null;
    cell.outputs = [];
  }
  return cell;
}

export function newNotebook() {
  return {
    cells: [newCell('code', '')],
    metadata: { kernelspec: { ...KERNELSPEC }, language_info: { name: 'python' } },
    nbformat: 4,
    nbformat_minor: 5,
  };
}

export const newNotebookText = () => serialize(newNotebook());

// Parse a .ipynb file. Returns { notebook } or { error } (a plain sentence).
export function parse(text) {
  let nb;
  try {
    nb = JSON.parse(text);
  } catch {
    return { error: 'This file isn’t valid notebook JSON. Open it as text in another editor to repair it.' };
  }
  if (!nb || typeof nb !== 'object' || !Array.isArray(nb.cells)) {
    return { error: 'This file doesn’t look like a Jupyter notebook (no cells).' };
  }
  if (nb.nbformat !== 4) {
    return { error: `This notebook uses an old format (nbformat ${nb.nbformat}). Open and save it once in Jupyter to update it.` };
  }
  const seen = new Set();
  const cells = nb.cells.map((cell) => {
    const c = { ...cell, source: joinText(cell.source) };
    if (!c.id || seen.has(c.id)) c.id = cellId();
    seen.add(c.id);
    if (!c.metadata) c.metadata = {};
    if (c.cell_type === 'code') {
      c.outputs = Array.isArray(c.outputs) ? c.outputs : [];
      if (c.execution_count === undefined) c.execution_count = null;
    }
    return c;
  });
  return {
    notebook: {
      ...nb,
      cells,
      metadata: { kernelspec: { ...KERNELSPEC }, language_info: { name: 'python' }, ...(nb.metadata || {}) },
      nbformat_minor: Math.max(5, nb.nbformat_minor || 0), // cell ids need 4.5
    },
  };
}

// Normalize an output to nbformat's stored form.
function storedOutput(output) {
  const out = { ...output };
  if (out.output_type === 'stream') out.text = splitLines(joinText(out.text));
  if (out.data) {
    out.data = Object.fromEntries(
      Object.entries(out.data).map(([mime, value]) =>
        // Text formats are stored as lists of lines; JSON and binary (base64) stay as they are.
        mime.startsWith('text/') || mime === 'image/svg+xml' ? [mime, splitLines(joinText(value))] : [mime, value]
      )
    );
    out.metadata = out.metadata || {};
  }
  return out;
}

export function serialize(nb) {
  const cells = nb.cells.map((cell) => {
    const c = { ...cell, source: splitLines(cell.source) };
    if (c.cell_type === 'code') c.outputs = (c.outputs || []).map(storedOutput);
    else {
      delete c.outputs;
      delete c.execution_count;
    }
    return c;
  });
  return `${JSON.stringify({ ...nb, cells }, null, 1)}\n`;
}

// ---------------------------------------------------------------- outputs

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
export const stripAnsi = (text) => text.replace(ANSI, '');

// Add one output to a cell's list, merging consecutive stream text the way
// Jupyter does (and honouring \r for progress bars).
export function appendOutput(outputs, output) {
  const last = outputs[outputs.length - 1];
  if (output.output_type === 'stream' && last?.output_type === 'stream' && last.name === output.name) {
    const merged = { ...last, text: applyCarriageReturns(joinText(last.text) + joinText(output.text)) };
    return [...outputs.slice(0, -1), merged];
  }
  if (output.output_type === 'stream') return [...outputs, { ...output, text: applyCarriageReturns(joinText(output.text)) }];
  return [...outputs, output];
}

function applyCarriageReturns(text) {
  if (!text.includes('\r')) return text;
  return text
    .split('\n')
    .map((line) => {
      const parts = line.split('\r');
      return parts.length > 1 ? parts.filter((p, i) => p || i === parts.length - 1).pop() ?? '' : line;
    })
    .join('\n');
}

// The richest format Tandem can show for a display output.
export const MIME_ORDER = ['text/html', 'image/svg+xml', 'image/png', 'image/jpeg', 'text/markdown', 'text/plain'];
export function bestMime(data = {}) {
  return MIME_ORDER.find((m) => data[m] != null) || null;
}
