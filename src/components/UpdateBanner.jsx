import { shownVersion } from '../state/useUpdates.js';
import { AlertCircle, Check, Download, Loader2, RefreshCw, X } from 'lucide-react';

// In-app updates (Tandem Staging): a small card that doesn't block anything.
//   checking      after "Check for updates": Checking…
//   up-to-date    You're up to date (goes after a few seconds)
//   downloading   the new version coming in, with its progress
//   ready         Restart to update / Later (installs when Tandem quits)
//   error         what went wrong
export default function UpdateBanner({ kind, state, onRestart, onLater, onDismiss }) {
  const name = state?.name || 'Tandem';
  const version = state?.available ? shownVersion(state.available) : '';
  const percent = Math.max(0, Math.min(100, state?.percent ?? 0));
  return (
    <div className={`update-banner is-${kind}`} role="status" aria-live="polite">
      {kind === 'checking' && (
        <>
          <Loader2 size={16} aria-hidden="true" className="update-banner-icon spin" />
          <span className="update-banner-text">Checking for updates…</span>
        </>
      )}
      {kind === 'up-to-date' && (
        <>
          <span className="update-banner-check" aria-hidden="true">
            <Check size={12} strokeWidth={3} />
          </span>
          <span className="update-banner-text">
            You’re up to date <span className="mono">{shownVersion(state?.version)}</span>
          </span>
        </>
      )}
      {kind === 'downloading' && (
        <div className="update-banner-progress">
          <span className="update-banner-row">
            <Download size={16} aria-hidden="true" className="update-banner-icon update-banner-bob" />
            <span className="update-banner-text">
              Downloading {name} <span className="mono">{version}</span>
            </span>
            <span className="update-banner-percent mono">{percent}%</span>
          </span>
          <span className="update-banner-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label="Download">
            <span style={{ width: `${Math.max(percent, 3)}%` }} />
          </span>
        </div>
      )}
      {kind === 'ready' && (
        <>
          <Download size={16} aria-hidden="true" className="update-banner-icon" />
          <span className="update-banner-text">
            {name} <span className="mono">{version}</span> is ready
          </span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onLater}>
            Later
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={onRestart}>
            Restart to update
          </button>
        </>
      )}
      {kind === 'error' && (
        <>
          <AlertCircle size={16} aria-hidden="true" className="update-banner-icon is-error" />
          <span className="update-banner-text">{state?.message || 'Couldn’t check for updates.'}</span>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onDismiss}>
            <X size={14} aria-hidden="true" />
          </button>
        </>
      )}
    </div>
  );
}

// "Restart to update": the whole window says what's happening, then Tandem
// closes, installs and opens again by itself.
export function UpdatingOverlay({ name, version }) {
  return (
    <div className="updating-overlay" role="alertdialog" aria-live="assertive" aria-label={`Updating ${name}`}>
      <div className="updating-card">
        <span className="updating-ring" aria-hidden="true">
          <RefreshCw size={26} />
        </span>
        <h2 className="updating-title">Updating {name}</h2>
        <p className="updating-text">
          Installing <span className="mono">{version}</span>. {name} closes and a small window shows the progress; {name} opens again by itself in about half a minute.
        </p>
        <span className="updating-bar" aria-hidden="true">
          <span />
        </span>
      </div>
    </div>
  );
}
