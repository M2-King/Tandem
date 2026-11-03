import { CircleCheck, AlertCircle, CircleSlash } from 'lucide-react';

// Shared labels for run records.
export const STATUS = {
  success: { label: 'Completed', icon: CircleCheck, className: 'status-success' },
  error: { label: 'Error', icon: AlertCircle, className: 'status-error' },
  stopped: { label: 'Stopped', icon: CircleSlash, className: 'status-muted' },
};

export function RunStatus({ status }) {
  const s = STATUS[status] || STATUS.stopped;
  const Icon = s.icon;
  return (
    <span className={`run-state ${s.className}`}>
      <Icon size={14} aria-hidden="true" /> {s.label}
    </span>
  );
}

export const runTitle = (run) => `Run #${run.number} · ${run.path}`;
export const formatTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
export const formatDuration = (ms) => `${(ms / 1000).toFixed(1)} s`;
