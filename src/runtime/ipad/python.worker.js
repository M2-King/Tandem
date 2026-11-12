// Python for Tandem on iPad: one Pyodide (CPython compiled to WebAssembly)
// per run, in its own worker, so every run starts clean and Stop can end it
// outright. The script runs inside the same wrapper as on the desktop
// (tandem_run.py): variables, metrics, matplotlib charts and the debugger
// behave the same.
//
// Blocking calls (input() and the debugger waiting for Next/Continue) wait on
// shared memory that the page fills in; see mailbox.js.

import { readSlot, SLOT_STDIN, SLOT_COMMAND } from './mailbox.js';

let pyodide = null;
let token = '';
let mailbox = null;
let support = {};

const post = (message) => self.postMessage(message);
const api = (path, init = {}) =>
  fetch(path, { ...init, headers: { 'x-tandem-token': token, ...(init.headers || {}) }, cache: 'no-store' });

// A program printing in a tight loop makes far more output than anyone can
// read: forward at most OUTPUT_RATE characters a second and say how much was
// skipped, so the page stays responsive and Stop is quick. (Python blocks
// this worker while it runs, so the clock is checked on each write.)
const OUTPUT_RATE = 400000;
const OUTPUT_WINDOW = 250;
function throttle(send) {
  let windowStart = Date.now();
  let budget = (OUTPUT_RATE * OUTPUT_WINDOW) / 1000;
  let skipped = 0;
  let tail = '';
  const write = (text) => {
    const now = Date.now();
    if (now - windowStart >= OUTPUT_WINDOW) {
      windowStart = now;
      budget = (OUTPUT_RATE * OUTPUT_WINDOW) / 1000;
    }
    if (text.length > budget) {
      const cut = Math.max(budget, 0);
      skipped += text.length - cut;
      tail = (tail + text.slice(cut)).slice(-4000); // the end is always shown
      text = text.slice(0, cut);
    }
    budget -= text.length;
    if (skipped && text && budget > 0) {
      text = `\n… ${skipped.toLocaleString()} characters of output skipped (the program prints faster than it can be shown) …\n${text}`;
      skipped = 0;
      tail = '';
    }
    if (text) send(text);
  };
  // The program ended while output was being skipped: show how it ended.
  write.end = () => {
    if (!skipped) return;
    const nl = tail.indexOf('\n');
    const last = nl >= 0 && nl < tail.length - 1 ? tail.slice(nl + 1) : tail;
    send(`\n… ${(skipped - last.length).toLocaleString()} characters of output skipped …\n${last}`);
    skipped = 0;
    tail = '';
  };
  return write;
}

// Text arrives from Python as bytes; a character can be split across writes.
function streamWriter(stream) {
  const decoder = new TextDecoder();
  const send = throttle((text) => post({ type: 'output', stream, text }));
  return {
    write(buffer) {
      const text = decoder.decode(buffer, { stream: true });
      if (text) send(text);
      return buffer.length;
    },
    end: () => send.end(),
  };
}

async function init(message) {
  token = message.token;
  mailbox = message.mailbox;
  support = message.support;
  const { loadPyodide } = await import(/* @vite-ignore */ `${message.indexURL}pyodide.mjs`);
  pyodide = await loadPyodide({ indexURL: message.indexURL, env: { HOME: '/home/pyodide' } });
  pyodide.setInterruptBuffer(new Int32Array(mailbox.interrupt));
  pyodide.FS.mkdirTree('/tandem');
  for (const [name, text] of Object.entries(support)) pyodide.FS.writeFile(`/tandem/${name}`, text);
  const python = pyodide.runPython('import sys, platform; platform.python_version()');
  const stdlib = JSON.parse(pyodide.runPython('import json; json.dumps(sorted(set(sys.stdlib_module_names) | set(sys.builtin_module_names)))'));
  post({ type: 'ready', python, pyodide: pyodide.version, stdlib });
}

// The project's files, copied into the worker's file system at /project.
async function mountProject() {
  const { files } = await (await api('/api/files')).json();
  const snapshot = new Map();
  pyodide.FS.mkdirTree('/project');
  await Promise.all(
    files.map(async ({ path }) => {
      const response = await api(`/api/raw?path=${encodeURIComponent(path)}`);
      if (!response.ok) return;
      const bytes = new Uint8Array(await response.arrayBuffer());
      const full = `/project/${path}`;
      pyodide.FS.mkdirTree(full.slice(0, full.lastIndexOf('/')));
      pyodide.FS.writeFile(full, bytes);
      snapshot.set(path, bytes);
    })
  );
  return snapshot;
}

// Files the program created or changed are saved back to the project.
async function saveChanges(snapshot) {
  const changed = [];
  const walk = (dir, rel) => {
    for (const name of pyodide.FS.readdir(dir)) {
      if (name === '.' || name === '..' || name === '__pycache__' || name.startsWith('.')) continue;
      const full = `${dir}/${name}`;
      const path = rel ? `${rel}/${name}` : name;
      const stat = pyodide.FS.stat(full);
      if (pyodide.FS.isDir(stat.mode)) walk(full, path);
      else {
        const bytes = pyodide.FS.readFile(full);
        const before = snapshot.get(path);
        if (!before || before.length !== bytes.length || before.some((b, i) => b !== bytes[i])) changed.push([path, bytes]);
      }
    }
  };
  walk('/project', '');
  for (const [path, bytes] of changed.slice(0, 200)) {
    if (bytes.length > 20 * 1024 * 1024) continue;
    await api(`/api/raw?path=${encodeURIComponent(path)}`, { method: 'PUT', body: bytes });
    snapshot.set(path, bytes);
  }
  return changed.map(([path]) => path);
}

// Tandem Cowork: a shared project runs from a working copy of its own,
// /shared/<project id>, kept on this iPad (IndexedDB, through Pyodide's
// IDBFS) so files a run creates stay here between runs. Before each run or
// kernel start the page sends the project's current text; changed files are
// written and files removed from the project deleted. Nothing is uploaded,
// and the device project (its files, its packages) isn't touched.
const SHARED_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const mountedShared = new Set();
const syncfs = (populate) =>
  new Promise((resolve) => pyodide.FS.syncfs(populate, (err) => resolve(!err)));

async function mountShared({ id, files }) {
  if (!SHARED_ID.test(id || '')) throw new Error('That isn’t a shared project.');
  const dir = `/shared/${id}`;
  const FS = pyodide.FS;
  if (!mountedShared.has(dir)) {
    FS.mkdirTree(dir);
    try {
      FS.mount(FS.filesystems.IDBFS, {}, dir);
      await syncfs(true); // what earlier runs left here
    } catch {
      // No IndexedDB: the working copy lasts for this run only.
    }
    mountedShared.add(dir);
  }
  const exists = (path) => FS.analyzePath(path).exists;
  let before = [];
  try {
    before = JSON.parse(new TextDecoder().decode(FS.readFile(`${dir}/.tandem/synced.json`))).files || [];
  } catch {
    before = [];
  }
  const encoder = new TextEncoder();
  for (const [path, text] of Object.entries(files || {})) {
    if (!path || path.startsWith('/') || path.split('/').some((part) => part === '..' || part === '') || path.startsWith('.tandem/')) continue;
    const full = `${dir}/${path}`;
    const bytes = encoder.encode(text);
    if (exists(full)) {
      const old = FS.readFile(full);
      if (old.length === bytes.length && old.every((b, i) => b === bytes[i])) continue;
    }
    FS.mkdirTree(full.slice(0, full.lastIndexOf('/')));
    FS.writeFile(full, bytes);
  }
  for (const path of before) {
    if (typeof path !== 'string' || path in (files || {})) continue;
    const full = `${dir}/${path}`;
    if (exists(full)) FS.unlink(full);
  }
  FS.mkdirTree(`${dir}/.tandem`);
  FS.writeFile(`${dir}/.tandem/synced.json`, JSON.stringify({ files: Object.keys(files || {}).sort() }));
  return dir;
}

// The project's own packages (Packages… → Install): pure-Python wheels from
// PyPI kept in the project (.tandem/packages), plus the Pyodide packages they
// need. Loaded before every run, offline.
const PACKAGES_FILE = '.tandem/packages.json';

async function loadProjectPackages() {
  const response = await api(`/api/raw?path=${encodeURIComponent(PACKAGES_FILE)}`);
  if (!response.ok) return;
  let list;
  try {
    list = JSON.parse(await response.text());
  } catch {
    return;
  }
  if (list.pyodide?.length) {
    await pyodide.loadPackage(list.pyodide, { messageCallback: () => {}, errorCallback: () => {} }).catch(() => {});
  }
  const site = pyodide.runPython('import sysconfig; sysconfig.get_paths()["purelib"]');
  for (const pkg of list.pypi || []) {
    try {
      const wheel = await api(`/api/raw?path=${encodeURIComponent(`.tandem/packages/${pkg.file}`)}`);
      if (!wheel.ok) throw new Error(`the saved file ${pkg.file} is missing`);
      pyodide.unpackArchive(await wheel.arrayBuffer(), 'wheel', { extractDir: site });
    } catch (e) {
      post({ type: 'output', stream: 'err', text: `Tandem couldn't load the package ${pkg.name}: ${e.message}\n` });
    }
  }
  pyodide.runPython('import importlib; importlib.invalidate_caches()');
}

// Packages… → Install: micropip resolves the packages on PyPI (pure-Python
// wheels) and Pyodide (compiled ones). The PyPI wheels are saved in the project.
async function install({ packages }) {
  pyodide.setStdout(streamWriter('out'));
  pyodide.setStderr(streamWriter('err'));
  const say = (text) => post({ type: 'output', stream: 'out', text: `${text}\n` });
  await pyodide.loadPackage('micropip', { messageCallback: say, errorCallback: say });
  pyodide.globals.set('_tandem_packages', pyodide.toPy(packages));
  // micropip.list(): what is installed in this (fresh) Python and where it came
  // from ("pyodide" for Pyodide's own packages). freeze() has each package's
  // wheel URL and dependencies, for every package Pyodide knows of.
  const result = JSON.parse(
    await pyodide.runPythonAsync(`
import json, micropip
from importlib.metadata import packages_distributions
await micropip.install(_tandem_packages, verbose=True)
installed = [{"name": p.name, "version": p.version, "source": str(p.source)} for p in micropip.list().values()]
lock = json.loads(micropip.freeze())["packages"]
imports = {}
for top, dists in packages_distributions().items():
    for d in dists:
        imports.setdefault(d.lower().replace("_", "-"), []).append(top)
json.dumps({"installed": installed, "lock": lock, "imports": imports})
`)
  );
  const norm = (n) => n.toLowerCase().replace(/[-_.]+/g, '-');
  const lockOf = new Map(Object.values(result.lock).map((e) => [norm(e.name), e]));
  const fromPypi = result.installed.filter((p) => p.source.toLowerCase() !== 'pyodide');
  const pypiNames = new Set(fromPypi.map((p) => norm(p.name)));
  const loadedFromPyodide = new Set(result.installed.filter((p) => !pypiNames.has(norm(p.name))).map((p) => norm(p.name)));
  const needs = new Set();
  for (const p of fromPypi) for (const d of lockOf.get(norm(p.name))?.depends || []) if (!pypiNames.has(norm(d))) needs.add(norm(d));
  // Asked for by name and provided by Pyodide (numpy, …): remembered too.
  for (const p of packages) needs.add(norm(p.split(/[<>=!~[\s;]/)[0]));
  const pyodideDeps = [...needs].filter((n) => loadedFromPyodide.has(n)).map((n) => lockOf.get(n)?.name || n);
  if (fromPypi.length > 40) throw new Error(`That would add ${fromPypi.length} packages; install fewer at a time.`);
  const saved = [];
  for (const p of fromPypi) {
    const url = lockOf.get(norm(p.name))?.file_name || '';
    if (!/^https:\/\//.test(url)) throw new Error(`micropip didn't say where ${p.name} came from.`);
    const file = decodeURIComponent(url.split('/').pop().split('#')[0].split('?')[0]);
    say(`Saving ${file} in the project…`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Couldn't download ${file} (${response.status}).`);
    const put = await api(`/api/raw?path=${encodeURIComponent(`.tandem/packages/${file}`)}`, { method: 'PUT', body: await response.arrayBuffer() });
    if (!put.ok) throw new Error(`Couldn't save ${file} in the project.`);
    saved.push({ name: p.name, version: p.version, file, imports: result.imports[norm(p.name)] || [] });
  }
  post({ type: 'installed', pypi: saved, pyodide: pyodideDeps });
}

async function run({ path, mode, breakpoints, shared }) {
  let snapshot = null;
  let root = '/project';
  if (shared) root = await mountShared(shared);
  else {
    snapshot = await mountProject();
    await loadProjectPackages();
  }
  // Packages the script imports (numpy, pandas, matplotlib, ...) load from the app.
  const source = new TextDecoder().decode(pyodide.FS.readFile(`${root}/${path}`));
  try {
    await pyodide.loadPackagesFromImports(source, { messageCallback: () => {}, errorCallback: () => {} });
  } catch {
    // A package Tandem doesn't ship: Python reports the ImportError itself.
  }

  const outWriter = streamWriter('out');
  const errWriter = streamWriter('err');
  pyodide.setStdout(outWriter);
  pyodide.setStderr(errWriter);
  pyodide.setStdin({
    stdin: () => {
      post({ type: 'stdin-wait' });
      const line = readSlot(mailbox, SLOT_STDIN);
      return line === null ? null : `${line}\n`;
    },
  });

  let pending = '';
  pyodide.registerJsModule('_tandem_channel', {
    emit(text) {
      pending += text;
      let i;
      while ((i = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, i);
        pending = pending.slice(i + 1);
        if (line) post({ type: 'event', event: JSON.parse(line) });
      }
    },
    read_command() {
      post({ type: 'command-wait' });
      const line = readSlot(mailbox, SLOT_COMMAND);
      return line === null ? '' : `${line}\n`;
    },
  });

  pyodide.globals.set('_tandem_args', pyodide.toPy({ path, mode, breakpoints, root }));
  post({ type: 'started', cwd: root });
  const code = pyodide.runPython(`
import os, sys
_root = _tandem_args["root"]
os.environ["MPLBACKEND"] = "module://tandem_mpl"
os.environ["TANDEM_PROJECT_ROOT"] = _root
if _tandem_args["mode"] != "run":
    import json
    os.environ["TANDEM_DEBUG"] = _tandem_args["mode"]
    os.environ["TANDEM_BREAKPOINTS"] = json.dumps([[_root + "/" + p, l] for p, l in _tandem_args["breakpoints"]])
sys.path.append("/tandem")  # after the script's own folder, which the wrapper puts first
os.chdir(_root)
sys.argv = ["tandem_run.py", _root + "/" + _tandem_args["path"]]
import tandem_run
try:
    tandem_run.main()
    _code = 0
except SystemExit as exc:
    _code = exc.code if isinstance(exc.code, int) else (0 if exc.code is None else 1)
_code
`);
  outWriter.end();
  errWriter.end();
  // A shared project's files stay in its working copy on this iPad.
  const saved = shared ? (await syncfs(false), []) : await saveChanges(snapshot);
  post({ type: 'exit', code, saved });
}

// ---------------------------------------------------------------- notebooks
// Kernel mode: this worker stays alive for one notebook and runs its cells in
// one namespace (tandem_kernel.py), so variables carry over between cells.
let kernel = null; // { snapshot, cell, run }

function kernelStream(name) {
  const decoder = new TextDecoder();
  const send = throttle((text) => {
    if (kernel?.cell) post({ type: 'kernel-output', cell: kernel.cell, output: { output_type: 'stream', name, text } });
  });
  return {
    write(buffer) {
      const text = decoder.decode(buffer, { stream: true });
      if (text) send(text);
      return buffer.length;
    },
  };
}

const INLINE_BACKEND = `# matplotlib backend for Tandem notebooks: figures appear below the cell.
from matplotlib.backends.backend_agg import FigureCanvasAgg as FigureCanvas
from matplotlib.backend_bases import FigureManagerBase as FigureManager


def show(*args, **kwargs):
    import tandem_kernel
    tandem_kernel.show_figures()
`;

async function kernelStart({ shared } = {}) {
  let snapshot = null;
  let root = '/project';
  if (shared) root = await mountShared(shared);
  else {
    snapshot = await mountProject();
    await loadProjectPackages();
  }
  pyodide.FS.writeFile('/tandem/_tandem_inline.py', INLINE_BACKEND);
  pyodide.registerJsModule('_tandem_kernel_host', {
    output(json) {
      if (kernel?.cell) post({ type: 'kernel-output', cell: kernel.cell, output: JSON.parse(json) });
    },
    count(n) {
      if (kernel?.cell) post({ type: 'kernel-count', cell: kernel.cell, count: n });
    },
    clear(wait) {
      if (kernel?.cell) post({ type: 'kernel-clear', cell: kernel.cell, wait });
    },
    read_input(prompt) {
      post({ type: 'kernel-input', cell: kernel?.cell, prompt });
      return readSlot(mailbox, SLOT_STDIN);
    },
  });
  pyodide.setStdout(kernelStream('stdout'));
  pyodide.setStderr(kernelStream('stderr'));
  pyodide.globals.set('_tandem_root', root);
  pyodide.runPython(`
import os, sys
os.environ["MPLBACKEND"] = "module://_tandem_inline"
os.environ["TANDEM_PROJECT_ROOT"] = _tandem_root
sys.path.append("/tandem")
os.chdir(_tandem_root)
sys.path.insert(0, _tandem_root)
import tandem_kernel
`);
  kernel = { snapshot, shared: !!shared, cell: null, run: pyodide.pyimport('tandem_kernel').run_cell };
  post({ type: 'kernel-ready' });
}

async function kernelExecute({ cell, code }) {
  kernel.cell = cell;
  try {
    // IPython imports are served by tandem_kernel (rich display in the
    // notebook); Pyodide's own IPython would only print plain text here.
    const forPackages = code.replace(/^[ \t]*(from[ \t]+IPython\b|import[ \t]+IPython\b).*$/gm, '');
    await pyodide.loadPackagesFromImports(forPackages, { messageCallback: () => {}, errorCallback: () => {} });
  } catch {
    // A package Pyodide doesn't have: the import error shows in the cell.
  }
  let status = 'error';
  try {
    status = kernel.run(code);
  } catch (e) {
    post({ type: 'kernel-output', cell, output: { output_type: 'error', ename: 'Error', evalue: String(e?.message || e), traceback: [String(e?.message || e)] } });
  }
  if (kernel.shared) await syncfs(false);
  else await saveChanges(kernel.snapshot).catch(() => {});
  kernel.cell = null;
  post({ type: 'kernel-done', cell, status });
}

// ---------------------------------------------------------------- completion
// Completion mode: this worker answers "what can follow here?" with Jedi.
let completer = null;

async function completeInit() {
  await mountProject();
  await loadProjectPackages();
  await pyodide.loadPackage(['jedi'], { messageCallback: () => {}, errorCallback: () => {} });
  pyodide.runPython('import sys\nsys.path.append("/tandem")\nsys.path.insert(0, "/project")\nimport tandem_complete');
  completer = pyodide.pyimport('tandem_complete');
  post({ type: 'complete-ready' });
}

async function completeRequest({ id, kind, request }) {
  try {
    // Packages the code imports (numpy, …) are loaded so Jedi can read them.
    await pyodide.loadPackagesFromImports(request.text, { messageCallback: () => {}, errorCallback: () => {} }).catch(() => {});
    const json =
      kind === 'detail'
        ? completer.detail(request.path, request.text, request.line, request.column, request.name)
        : completer.complete(request.path, request.text, request.line, request.column);
    post({ type: 'complete-result', id, result: JSON.parse(json) });
  } catch (e) {
    post({ type: 'complete-result', id, error: String(e?.message || e) });
  }
}

self.onmessage = async (e) => {
  const message = e.data;
  try {
    if (message.type === 'init') await init(message);
    else if (message.type === 'run') await run(message);
    else if (message.type === 'install') await install(message);
    else if (message.type === 'kernel-start') await kernelStart(message);
    else if (message.type === 'shared-sync') await mountShared(message.shared); // a shared notebook's files, before a cell
    else if (message.type === 'complete-init') await completeInit();
    else if (message.type === 'complete') await completeRequest(message);
    else if (message.type === 'kernel-execute') await kernelExecute(message);
  } catch (error) {
    post({ type: 'failed', message: String(error?.message || error) });
  }
};
