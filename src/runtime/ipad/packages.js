// Packages for Tandem on iPad: what the project's code imports, what Pyodide
// provides, and the pure-Python packages from PyPI the project keeps in
// .tandem/packages (listed in .tandem/packages.json).

export const PACKAGES_FILE = '.tandem/packages.json';

// Import name → the package that provides it, where they differ.
export const IMPORT_TO_PACKAGE = {
  sklearn: 'scikit-learn',
  skimage: 'scikit-image',
  cv2: 'opencv-python',
  PIL: 'pillow',
  yaml: 'pyyaml',
  bs4: 'beautifulsoup4',
  dateutil: 'python-dateutil',
  dotenv: 'python-dotenv',
  Crypto: 'pycryptodome',
  attr: 'attrs',
  jwt: 'PyJWT',
  docx: 'python-docx',
  pptx: 'python-pptx',
  fitz: 'PyMuPDF',
  mpl_toolkits: 'matplotlib',
};

// A package name, optional extras and an optional version: nothing else
// (no pip/micropip options, no URLs).
export const PACKAGE_SPEC =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?(?:\[[A-Za-z0-9._-]+(?:,[A-Za-z0-9._-]+)*\])?(?:\s*(?:==|>=|<=|~=|!=|>|<)\s*[A-Za-z0-9.*+!_-]{1,40}(?:\s*,\s*(?:==|>=|<=|~=|!=|>|<)\s*[A-Za-z0-9.*+!_-]{1,40})*)?$/;

export const normName = (name) => name.toLowerCase().replace(/[-_.]+/g, '-');

// Top-level imports in Python source, with line numbers. Relative imports
// (from . import x) are the project's own.
export function scanImports(text) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    const plain = /^\s*import\s+(.+)$/.exec(line);
    if (plain) {
      for (const part of plain[1].split('#')[0].split(',')) {
        const name = part.trim().split(/\s+/)[0];
        if (/^[A-Za-z_][\w.]*$/.test(name)) out.push({ module: name.split('.')[0], line: i + 1 });
      }
      return;
    }
    const from = /^\s*from\s+([A-Za-z_][\w.]*)\s+import\b/.exec(line);
    if (from) out.push({ module: from[1].split('.')[0], line: i + 1 });
  });
  return out;
}

// { pypi: [{ name, version, file, imports }], pyodide: [names] }
export function mergePackages(current, added) {
  const pypi = new Map((current?.pypi || []).map((p) => [normName(p.name), p]));
  for (const p of added.pypi) pypi.set(normName(p.name), p);
  const pyodide = [...new Set([...(current?.pyodide || []), ...added.pyodide])].sort();
  return { pypi: [...pypi.values()].sort((a, b) => a.name.localeCompare(b.name)), pyodide };
}
