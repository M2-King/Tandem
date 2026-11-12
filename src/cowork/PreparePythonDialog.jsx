import { useEffect, useState } from 'react';
import { AlertCircle, Check, ChevronDown, Copy, Loader2, Sparkles } from 'lucide-react';
import Dialog from '../components/Dialog.jsx';

// "Preparing Python" (useSharedPython): a checklist that fills in as this
// computer gets ready for shared projects, then the asked-for step (creating,
// joining or opening a project). Each step shows what it is doing; installing
// shows the package being fetched and a moving bar. Errors say what to do.

const INSTALL = {
  windows: {
    text: 'Install Python 3.12 from python.org (tick “Add python.exe to PATH”), or run this in a terminal:',
    command: 'winget install Python.Python.3.12',
  },
  mac: {
    text: 'Install Python 3.12 from python.org, or with Homebrew:',
    command: 'brew install python@3.12',
  },
};

function StepIcon({ status }) {
  if (status === 'done')
    return (
      <span className="prep-icon is-done" aria-hidden="true">
        <Check size={13} strokeWidth={3} />
      </span>
    );
  if (status === 'active')
    return (
      <span className="prep-icon is-active" aria-hidden="true">
        <Loader2 size={15} className="spin" />
      </span>
    );
  if (status === 'error')
    return (
      <span className="prep-icon is-error" aria-hidden="true">
        <AlertCircle size={15} />
      </span>
    );
  return <span className="prep-icon is-waiting" aria-hidden="true" />;
}

function Elapsed({ since, stopped }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (stopped) return undefined;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [stopped]);
  const s = Math.max(0, Math.round((Date.now() - since) / 1000));
  return <span className="prep-elapsed">{s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`}</span>;
}

export default function PreparePythonDialog({ prep, onRetry, onSkip, onCancel }) {
  const [details, setDetails] = useState(false);
  const [copied, setCopied] = useState(false);
  if (!prep) return null;
  const { steps, error, done, activity, installs, log } = prep;
  const finished = steps.filter((s) => s.status === 'done').length;
  const active = steps.find((s) => s.status === 'active');
  const percent = done ? 100 : Math.round(((finished + (active ? 0.5 : 0)) / steps.length) * 100);
  const howTo = INSTALL[prep.platform] || INSTALL.windows;
  const copy = () => {
    navigator.clipboard?.writeText(howTo.command).then(
      () => setCopied(true),
      () => {}
    );
  };

  return (
    <Dialog title={prep.title} onClose={error ? onCancel : () => {}} className={`dialog-confirm dialog-prepare ${done ? 'is-done' : ''}`}>
      <div className="prep-head">
        <span className={`prep-badge ${done ? 'is-done' : error ? 'is-error' : ''}`} aria-hidden="true">
          {done ? <Check size={20} strokeWidth={3} /> : error ? <AlertCircle size={20} /> : <Sparkles size={20} />}
        </span>
        <div>
          <h2 className="dialog-title">{done ? 'All set' : prep.title}</h2>
          <p className="dialog-text prep-sub">
            {done
              ? 'This computer is ready for shared projects.'
              : 'Shared projects run on each person’s own computer. Getting Python ready here, once.'}
          </p>
        </div>
      </div>

      <div className="prep-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label="Progress">
        <span className="prep-progress-fill" style={{ width: `${percent}%` }} />
      </div>

      <ol className="prep-steps" aria-live="polite">
        {steps.map((s) => (
          <li key={s.id} className={`prep-step is-${s.status}`}>
            <StepIcon status={s.status} />
            <span className="prep-step-main">
              <span className="prep-step-label">{s.label}</span>
              {s.detail && <span className="prep-step-detail">{s.detail}</span>}
              {s.status === 'active' && s.id === 'install' && (
                <span className="prep-activity">
                  <span className="prep-bar" aria-hidden="true">
                    <span />
                  </span>
                  <span className="prep-activity-text">
                    {activity || 'Starting…'}
                    {installs > 0 ? ` · ${installs} fetched` : ''}
                  </span>
                </span>
              )}
              {s.status === 'active' && s.id === 'env' && (
                <span className="prep-activity">
                  <span className="prep-bar" aria-hidden="true">
                    <span />
                  </span>
                </span>
              )}
            </span>
          </li>
        ))}
      </ol>

      {error && (
        <div className="prep-error" role="alert">
          <p className="prep-error-text">{error.message}</p>
          {error.kind === 'no-python' && (
            <div className="prep-howto">
              <p>{howTo.text}</p>
              <div className="prep-command">
                <code>{howTo.command}</code>
                <button type="button" className="btn btn-ghost btn-sm" onClick={copy}>
                  <Copy size={13} aria-hidden="true" /> {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <p className="prep-note">Then come back and choose Check again.</p>
            </div>
          )}
        </div>
      )}

      {log.length > 0 && (
        <div className="prep-details">
          <button type="button" className="prep-details-toggle" onClick={() => setDetails((d) => !d)} aria-expanded={details}>
            <ChevronDown size={14} aria-hidden="true" className={details ? 'is-open' : ''} /> Details
          </button>
          {details && (
            <pre className="prep-log mono">
              {log.join('\n')}
            </pre>
          )}
        </div>
      )}

      <div className="dialog-actions prep-actions">
        <Elapsed since={prep.startedAt} stopped={done || !!error} />
        {error ? (
          <>
            <button type="button" className="btn btn-ghost" onClick={onCancel}>
              Cancel
            </button>
            <button type="button" className="btn btn-secondary" onClick={onSkip}>
              Skip for now
            </button>
            <button type="button" className="btn btn-primary" onClick={() => onRetry(true)} data-autofocus>
              {error.kind === 'no-python' ? 'Check again' : 'Try again'}
            </button>
          </>
        ) : (
          !done && (
            <button type="button" className="btn btn-ghost" onClick={onCancel}>
              Cancel
            </button>
          )
        )}
      </div>
    </Dialog>
  );
}
