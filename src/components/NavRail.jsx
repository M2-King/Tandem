import { Files, ChartColumn, History } from 'lucide-react';

// Slim navigation rail on the left edge of the shell. Files toggles the
// explorer; Charts and Runs open the results area on that view (or close it
// when it is already showing).
function RailButton({ icon: Icon, label, pressed, onClick, badge }) {
  return (
    <button
      type="button"
      className="rail-btn"
      aria-label={label}
      aria-pressed={pressed}
      data-tooltip={label}
      data-tooltip-side="right"
      onClick={onClick}
    >
      <Icon size={19} strokeWidth={1.75} aria-hidden="true" />
      {badge && <span className="rail-dot" aria-hidden="true" />}
    </button>
  );
}

export default function NavRail({ filesOpen, onToggleFiles, resultsOpen, resultsTab, onResultsView, newCharts }) {
  const showing = (tab) => resultsOpen && resultsTab === tab;
  return (
    <nav className="rail" aria-label="Views">
      <div className="rail-capsule capsule">
        <RailButton
          icon={Files}
          label={filesOpen ? 'Hide files' : 'Show files'}
          pressed={filesOpen}
          onClick={onToggleFiles}
        />
        <span className="rail-sep" aria-hidden="true" />
        <RailButton
          icon={ChartColumn}
          label={showing('Charts') ? 'Hide charts' : 'Show charts'}
          pressed={showing('Charts')}
          onClick={() => onResultsView('Charts')}
          badge={newCharts && !showing('Charts')}
        />
        <RailButton
          icon={History}
          label={showing('Runs') ? 'Hide runs' : 'Show runs'}
          pressed={showing('Runs')}
          onClick={() => onResultsView('Runs')}
        />
      </div>
    </nav>
  );
}
