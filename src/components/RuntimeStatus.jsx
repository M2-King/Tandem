import Menu from './Menu.jsx';

const envName = (python) => {
  if (!python?.ok) return null;
  if (!python.is_venv) return 'system';
  const parts = python.prefix.split(/[\\/]/);
  return parts[parts.length - 1];
};

// Local runtime status in the toolbar: is it connected, and which Python runs
// the code. The popover says plainly what the runtime is (and is not).
export function RuntimeStatus({ connection, status, error }) {
  const python = status?.python;
  const label =
    connection === 'connected'
      ? python?.ok
        ? `Python ${python.version}${envName(python) ? ` · ${envName(python)}` : ''}`
        : 'No Python found'
      : connection === 'connecting'
        ? 'Connecting…'
        : 'Runtime disconnected';
  const tone = connection !== 'connected' ? (connection === 'connecting' ? 'pending' : 'down') : python?.ok ? 'up' : 'warn';

  return (
    <Menu
      role="dialog"
      align="start"
      label="Runtime"
      renderTrigger={(props) => (
        <button type="button" className={`runtime-status tone-${tone}`} {...props}>
          <span className="runtime-dot" aria-hidden="true" />
          {label}
        </button>
      )}
    >
      <div className="demo-popover runtime-popover">
        <p className="demo-popover-title">
          {connection === 'connected' ? 'Local Python runtime' : 'The runtime isn’t reachable'}
        </p>
        {connection !== 'connected' ? (
          <p>
            Tandem can’t run code until it reconnects. Check that <code>tandem open</code> is still running in your
            terminal; this page reconnects on its own. If you restarted it, reload this page (each start uses a new
            session key). Nothing is simulated in the meantime.
          </p>
        ) : (
          <dl className="runtime-facts">
            <div>
              <dt>Python</dt>
              <dd>{python?.ok ? `${python.version} (${python.source})` : python?.error || 'Not found'}</dd>
            </div>
            {python?.ok && (
              <div>
                <dt>Interpreter</dt>
                <dd className="mono">{python.path}</dd>
              </div>
            )}
            <div>
              <dt>Project</dt>
              <dd className="mono">{status?.project?.root}</dd>
            </div>
          </dl>
        )}
        {error && <p className="runtime-error">{error}</p>}
        <p className="runtime-note">
          Code runs on this computer with your user’s permissions. This is a local runtime for your own projects, not
          a sandbox for untrusted code.
        </p>
      </div>
    </Menu>
  );
}

// Demo badge for the hosted preview, with the way to get real Python.
export function DemoBadge() {
  return (
    <Menu
      role="dialog"
      align="start"
      label="About this demo"
      renderTrigger={(props) => (
        <button type="button" className="demo-badge" {...props}>
          Demo
        </button>
      )}
    >
      <div className="demo-popover">
        <p className="demo-popover-title">This is the demo</p>
        <p>
          Python execution and the assistant are simulated with prepared sample data. No code is executed and nothing
          is sent to a server.
        </p>
        <p className="demo-popover-title">Run real Python</p>
        <p>Start the local runtime on your computer, in your project folder:</p>
        <pre className="runtime-command">tandem open .</pre>
        <p>It opens Tandem connected to real Python. Setup steps are in the README.</p>
      </div>
    </Menu>
  );
}
