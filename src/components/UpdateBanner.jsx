import { Download } from 'lucide-react';

// "Tandem Staging <version> is ready": a small card that doesn't block
// anything. Later keeps working; the update installs when Tandem quits.
export default function UpdateBanner({ name, version, onRestart, onLater }) {
  return (
    <div className="update-banner" role="status" aria-live="polite">
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
    </div>
  );
}
