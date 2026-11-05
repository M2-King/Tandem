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

// Text arrives from Python as bytes; a character can be split across writes.
function streamWriter(stream) {
  const decoder = new TextDecoder();
  return {
    write(buffer) {
      const text = decoder.decode(buffer, { stream: true });
      if (text) post({ type: 'output', stream, text });
      return buffer.length;
    },
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
  }
  return changed.map(([path]) => path);
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

async function run({ path, mode, breakpoints }) {
  const snapshot = await mountProject();
  await loadProjectPackages();
  // Packages the script imports (numpy, pandas, matplotlib, ...) load from the app.
  const source = new TextDecoder().decode(pyodide.FS.readFile(`/project/${path}`));
  try {
    await pyodide.loadPackagesFromImports(source, { messageCallback: () => {}, errorCallback: () => {} });
  } catch {
    // A package Tandem doesn't ship: Python reports the ImportError itself.
  }

  pyodide.setStdout(streamWriter('out'));
  pyodide.setStderr(streamWriter('err'));
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

  pyodide.globals.set('_tandem_args', pyodide.toPy({ path, mode, breakpoints }));
  post({ type: 'started' });
  const code = pyodide.runPython(`
import os, sys
os.environ["MPLBACKEND"] = "module://tandem_mpl"
os.environ["TANDEM_PROJECT_ROOT"] = "/project"
if _tandem_args["mode"] != "run":
    import json
    os.environ["TANDEM_DEBUG"] = _tandem_args["mode"]
    os.environ["TANDEM_BREAKPOINTS"] = json.dumps([["/project/" + p, l] for p, l in _tandem_args["breakpoints"]])
sys.path.append("/tandem")  # after the script's own folder, which the wrapper puts first
os.chdir("/project")
sys.argv = ["tandem_run.py", "/project/" + _tandem_args["path"]]
import tandem_run
try:
    tandem_run.main()
    _code = 0
except SystemExit as exc:
    _code = exc.code if isinstance(exc.code, int) else (0 if exc.code is None else 1)
_code
`);
  const saved = await saveChanges(snapshot);
  post({ type: 'exit', code, saved });
}

self.onmessage = async (e) => {
  const message = e.data;
  try {
    if (message.type === 'init') await init(message);
    else if (message.type === 'run') await run(message);
    else if (message.type === 'install') await install(message);
  } catch (error) {
    post({ type: 'failed', message: String(error?.message || error) });
  }
};
