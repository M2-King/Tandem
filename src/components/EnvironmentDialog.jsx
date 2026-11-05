import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, Loader2, CheckCircle2, AlertCircle, AlertTriangle, Plus, Package, RefreshCw, Search } from 'lucide-react';
import Dialog from './Dialog.jsx';

// Environment manager: which Python runs the project, creating environments,
// and the project's packages. Nothing is installed or created without the
// person first seeing the exact command and confirming it.
//
// Laptop: real interpreters and virtual environments (runtime/envs.py).
// iPad: one built-in Python (Pyodide); packages come from Pyodide or, for
// pure-Python ones, from PyPI, and are kept with the project.

const quote = (arg) => (/[\s"'&|<>^()]/.test(arg) ? `"${String(arg).replace(/"/g, '\\"')}"` : arg);
export const commandText = (command) => command.map(quote).join(' ');

const envLabel = (current) => {
  if (!current) return 'No Python';
  const name = current.is_venv ? current.prefix.split(/[\\/]/).pop() : 'system';
  return `Python ${current.version} · ${name}`;
};

function JobLog({ job, onCancel }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [job.log]);
  const running = job.status === 'running';
  return (
    <div className="env-job">
      <div className="env-job-head">
        {running ? (
          <Loader2 size={14} className="spin" aria-hidden="true" />
        ) : job.status === 'success' ? (
          <CheckCircle2 size={14} className="tone-ok" aria-hidden="true" />
        ) : (
          <AlertCircle size={14} className="tone-error" aria-hidden="true" />
        )}
        <span role="status">
          {running ? job.title : job.status === 'success' ? job.doneText : job.status === 'cancelled' ? 'Cancelled.' : job.message || 'It didn’t work.'}
        </span>
        {running && onCancel && (
          <button type="button" className="btn btn-secondary btn-sm push-right" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      {job.log && (
        <pre ref={ref} className="env-log" aria-label="Log">
          {job.log}
        </pre>
      )}
    </div>
  );
}

function Approval({ preview, target, verb, onConfirm, onCancel }) {
  return (
    <div className="env-approval" role="group" aria-label="Confirm">
      <p className="env-approval-title">Tandem will run this command{target ? ` in ${target}` : ''}:</p>
      <pre className="runtime-command env-command">{preview.display || commandText(preview.command)}</pre>
      {preview.note && <p className="field-hint">{preview.note}</p>}
      <div className="dialog-actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" onClick={onConfirm} data-autofocus>
          {verb}
        </button>
      </div>
    </div>
  );
}

export default function EnvironmentDialog({ backend, initialTab = 'env', focusModule = null, runActive, onClose, onChanged }) {
  const [tab, setTab] = useState(initialTab);
  const [info, setInfo] = useState(null);
  const [pkgs, setPkgs] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(null); // { job, preview, title, doneText, verb }
  const [job, setJob] = useState(null); // { status, log, title, doneText, message }
  const jobHandle = useRef(null);
  const [selected, setSelected] = useState(() => new Set(focusModule ? [focusModule] : []));
  const [newPkg, setNewPkg] = useState('');
  const [filter, setFilter] = useState('');
  const [base, setBase] = useState('');
  const [name, setName] = useState('');
  const ipad = info?.platform === 'ipad';

  const loadEnvs = useCallback(
    async (refresh = false) => {
      try {
        const next = await backend.envs(refresh);
        setInfo(next);
        setBase((b) => b || next.interpreters?.[0]?.path || '');
      } catch (e) {
        setError(e.message);
      }
    },
    [backend]
  );

  const loadPackages = useCallback(async () => {
    setLoading(true);
    try {
      const next = await backend.packages();
      setPkgs(next);
      setError(null);
      if (focusModule) {
        const m = next.missing.find((x) => x.module === focusModule || x.package === focusModule);
        setSelected(new Set(m ? [m.package] : []));
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [backend, focusModule]);

  useEffect(() => {
    loadEnvs();
  }, [loadEnvs]);
  useEffect(() => {
    if (tab === 'packages' && !pkgs) loadPackages();
  }, [tab, pkgs, loadPackages]);

  const busy = job?.status === 'running';

  // Folder name for a new environment: .venv, or .venv-3.12 when .venv is taken.
  const [nameEdited, setNameEdited] = useState(false);
  useEffect(() => {
    if (nameEdited || !info?.interpreters) return;
    const taken = new Set((info.project || []).map((e) => e.name));
    const version = info.interpreters.find((i) => i.path === base)?.version || '';
    const minor = version.split('.').slice(0, 2).join('.');
    setName(!taken.has('.venv') ? '.venv' : !taken.has(`.venv-${minor}`) ? `.venv-${minor}` : `.venv-${minor}-2`);
  }, [info, base, nameEdited]);

  // Keep the running task's log in view.
  const jobRef = useRef(null);
  useEffect(() => {
    if (job?.status === 'running') jobRef.current?.scrollIntoView({ block: 'nearest' });
  }, [job?.status]);

  // Step 1: ask for the exact command. Step 2 (confirm): run it.
  const propose = async (spec) => {
    setError(null);
    try {
      const preview = await backend.previewJob(spec.job);
      setPending({ ...spec, preview });
    } catch (e) {
      setError(e.message);
    }
  };

  const confirm = () => {
    const { job: request, title, doneText, after } = pending;
    setPending(null);
    setJob({ status: 'running', log: '', title, doneText });
    jobHandle.current = backend.startJob(request, {
      onOutput: (text) => setJob((j) => ({ ...j, log: (j.log + text).slice(-100_000) })),
      onFinish: async (result) => {
        jobHandle.current = null;
        setJob((j) => ({ ...j, status: result.status, message: result.message }));
        if (result.status === 'success') await after?.(result);
      },
    });
  };

  const select = async (python) => {
    setError(null);
    try {
      setInfo(await backend.selectEnv(python));
      onChanged?.();
      setPkgs(null);
    } catch (e) {
      setError(e.message);
    }
  };

  const current = info?.current;
  const installedNames = useMemo(() => new Set((pkgs?.packages || []).map((p) => p.name.toLowerCase())), [pkgs]);
  const shown = useMemo(
    () => (pkgs?.packages || []).filter((p) => !filter || p.name.toLowerCase().includes(filter.toLowerCase())),
    [pkgs, filter]
  );

  const install = (packages, label) =>
    propose({
      job: { kind: 'install', packages },
      title: `Installing ${label}…`,
      doneText: `Installed ${label}.`,
      verb: 'Install',
      after: async () => {
        setSelected(new Set());
        setNewPkg('');
        await loadPackages();
        onChanged?.();
      },
    });

  const envTarget = current ? (current.is_venv ? current.prefix.split(/[\\/]/).pop() : current.path) : null;

  return (
    <Dialog title="Python environment" onClose={busy ? () => {} : onClose} className="dialog-ai dialog-env">
      <div className="ai-settings env-dialog">
        <div className="ai-settings-head">
          <h2 className="dialog-title">Python environment</h2>
          <button type="button" className="icon-btn" aria-label="Close" data-tooltip="Close" onClick={onClose} disabled={busy}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <div className="segmented ai-tabs" role="tablist" aria-label="Section">
          {[
            ['env', 'Environment'],
            ['packages', 'Packages'],
          ].map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'is-active' : ''} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>

        {!info && !error && (
          <p className="ai-status is-pending">
            <Loader2 size={14} className="spin" aria-hidden="true" /> Looking for Python…
          </p>
        )}

        {current && (
          <p className="env-current">
            <span className="env-current-label">Runs use</span> <strong>{ipad ? `Python ${current.version}` : envLabel(current)}</strong>
            <span className="env-current-path mono">{current.path}</span>
          </p>
        )}

        {tab === 'env' && info && ipad && (
          <div className="env-section">
            <p className="dialog-text">
              On iPad there is one Python, built into Tandem (Pyodide, CPython compiled to WebAssembly). iPadOS doesn’t let apps
              start other programs, so separate environments and other Python versions aren’t possible here.
            </p>
            <p className="dialog-text">
              Each project keeps its own package list: open <em>Packages</em> to add pure-Python packages from PyPI. They are
              saved with the project and work offline afterwards.
            </p>
          </div>
        )}

        {tab === 'env' && info && !ipad && (
          <>
            <div className="env-section" role="radiogroup" aria-label="Python for this project">
              <p className="env-section-title">Project environments</p>
              <button type="button" role="radio" aria-checked={!info.selected} className={`env-row ${!info.selected ? 'is-current' : ''}`} onClick={() => select(null)} disabled={busy || runActive}>
                <span className="env-row-name">Automatic</span>
                <span className="env-row-meta">The project’s .venv if there is one, otherwise the Python on PATH</span>
              </button>
              {info.project.map((e) => (
                <button key={e.path} type="button" role="radio" aria-checked={info.selected === e.path} className={`env-row ${info.selected === e.path ? 'is-current' : ''}`} onClick={() => select(e.path)} disabled={busy || runActive}>
                  <span className="env-row-name mono">{e.name}</span>
                  <span className="env-row-meta">Python {e.version || '?'}</span>
                </button>
              ))}
              {info.project.length === 0 && <p className="field-hint">This project has no environment yet.</p>}

              <p className="env-section-title">
                Python installations on this computer
                <button type="button" className="icon-btn icon-btn-sm" aria-label="Look again" data-tooltip="Look again" onClick={() => loadEnvs(true)} disabled={busy}>
                  <RefreshCw size={13} aria-hidden="true" />
                </button>
              </p>
              {info.interpreters.map((i) => (
                <button key={i.path} type="button" role="radio" aria-checked={info.selected === i.path} className={`env-row ${info.selected === i.path ? 'is-current' : ''}`} onClick={() => select(i.path)} disabled={busy || runActive}>
                  <span className="env-row-name">Python {i.version}</span>
                  <span className="env-row-meta mono">{i.path}</span>
                </button>
              ))}
              {info.interpreters.length === 0 && (
                <p className="field-hint">No Python installation found. Install Python 3 from python.org, then press Look again.</p>
              )}
              {runActive && <p className="field-hint">Stop the run to switch environments.</p>}
            </div>

            <div className="env-section">
              <p className="env-section-title">Create an environment</p>
              <p className="field-hint">
                A folder inside the project with its own packages. Installing there never changes the Python other programs use.
              </p>
              <div className="env-create">
                <label className="field">
                  <span className="field-label">Python</span>
                  <select className="field-input" value={base} onChange={(e) => setBase(e.target.value)} disabled={busy}>
                    {info.interpreters.map((i) => (
                      <option key={i.path} value={i.path}>
                        Python {i.version} — {i.path}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span className="field-label">Folder</span>
                  <input
                    className="field-input mono"
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value);
                      setNameEdited(true);
                    }}
                    spellCheck={false}
                    autoComplete="off"
                    disabled={busy}
                  />
                </label>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy || !base || !name.trim() || !!pending}
                  onClick={() =>
                    propose({
                      job: { kind: 'create-env', base, name: name.trim() },
                      title: `Creating ${name.trim()}…`,
                      doneText: `Created ${name.trim()}. Runs now use it.`,
                      verb: 'Create',
                      after: async () => {
                        setNameEdited(false);
                        await loadEnvs();
                        setPkgs(null);
                        onChanged?.();
                      },
                    })
                  }
                >
                  <Plus size={14} aria-hidden="true" /> Create…
                </button>
              </div>
            </div>
          </>
        )}

        {tab === 'packages' && (
          <>
            {loading && !pkgs && (
              <p className="ai-status is-pending">
                <Loader2 size={14} className="spin" aria-hidden="true" /> Asking {ipad ? 'Python' : 'pip'} for the package list…
              </p>
            )}
            {pkgs && !pkgs.can_install && (
              <div className="callout callout-warning">
                <AlertTriangle size={16} aria-hidden="true" />
                <div className="callout-body">
                  <p>{pkgs.reason}</p>
                  {!ipad && (
                    <div className="callout-actions">
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setTab('env')}>
                        Create an environment
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
            {pkgs?.error && <p className="field-error">{pkgs.error}</p>}

            {pkgs && pkgs.missing.length > 0 && (
              <div className="env-section">
                <p className="env-section-title">Imported by your code, but not installed</p>
                {pkgs.missing.map((m) => (
                  <label key={m.module} className="env-missing">
                    <input
                      type="checkbox"
                      checked={selected.has(m.package)}
                      disabled={!pkgs.can_install || busy || m.installable === false}
                      onChange={(e) =>
                        setSelected((s) => {
                          const next = new Set(s);
                          if (e.target.checked) next.add(m.package);
                          else next.delete(m.package);
                          return next;
                        })
                      }
                    />
                    <span className="mono">{m.module}</span>
                    {m.package !== m.module && <span className="env-row-meta">→ package {m.package}</span>}
                    <span className="env-row-meta push-right">
                      {m.note || m.where.map((w) => `${w.path}:${w.line}`).join(', ')}
                    </span>
                  </label>
                ))}
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={!pkgs.can_install || busy || selected.size === 0 || !!pending}
                  onClick={() => install([...selected], [...selected].join(', '))}
                >
                  <Package size={14} aria-hidden="true" /> Install selected…
                </button>
              </div>
            )}
            {pkgs && pkgs.missing.length === 0 && !pkgs.error && (
              <p className="field-hint env-all-good">
                <CheckCircle2 size={14} aria-hidden="true" /> Everything your code imports is installed.
              </p>
            )}

            {pkgs?.can_install && (
              <div className="env-section">
                <p className="env-section-title">Install a package</p>
                <form
                  className="env-install-row"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const list = newPkg.split(/[\s,]+/).filter(Boolean);
                    if (list.length) install(list, list.join(', '));
                  }}
                >
                  <input className="field-input mono" value={newPkg} onChange={(e) => setNewPkg(e.target.value)} placeholder={ipad ? 'e.g. tabulate' : 'e.g. numpy or pandas>=2'} spellCheck={false} autoComplete="off" disabled={busy} aria-label="Package name" />
                  <button type="submit" className="btn btn-secondary btn-sm" disabled={busy || !newPkg.trim() || !!pending}>
                    Install…
                  </button>
                </form>
                {pkgs.requirements && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={busy || !!pending}
                    onClick={() =>
                      propose({
                        job: { kind: 'install', requirements: true },
                        title: 'Installing from requirements.txt…',
                        doneText: 'Installed everything in requirements.txt.',
                        verb: 'Install',
                        after: async () => {
                          await loadPackages();
                          onChanged?.();
                        },
                      })
                    }
                  >
                    Install everything in requirements.txt…
                  </button>
                )}
                {ipad && <p className="field-hint">{pkgs.hint}</p>}
              </div>
            )}

            {pkgs && (
              <div className="env-section">
                <p className="env-section-title">
                  Installed ({pkgs.packages.length})
                  <button type="button" className="icon-btn icon-btn-sm" aria-label="Refresh" data-tooltip="Refresh" onClick={loadPackages} disabled={busy || loading}>
                    <RefreshCw size={13} aria-hidden="true" className={loading ? 'spin' : ''} />
                  </button>
                </p>
                {pkgs.packages.length > 8 && (
                  <label className="env-filter">
                    <Search size={13} aria-hidden="true" />
                    <input className="field-input" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter" aria-label="Filter packages" />
                  </label>
                )}
                <ul className="env-packages">
                  {shown.map((p) => (
                    <li key={p.name}>
                      <span className="mono">{p.name}</span>
                      <span className="env-row-meta mono">{p.version}</span>
                      {p.note && <span className="env-row-meta">{p.note}</span>}
                    </li>
                  ))}
                </ul>
                {installedNames.size === 0 && <p className="field-hint">No packages yet.</p>}
              </div>
            )}
          </>
        )}

        {pending && (
          <Approval
            preview={pending.preview}
            target={pending.job.kind === 'install' && !ipad ? envTarget : null}
            verb={pending.verb}
            onCancel={() => setPending(null)}
            onConfirm={confirm}
          />
        )}
        {job && (
          <div ref={jobRef}>
            <JobLog job={job} onCancel={jobHandle.current ? () => jobHandle.current.cancel() : null} />
          </div>
        )}
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
