import { Play, ChevronDown, Square, Footprints, Bug, Loader2 } from 'lucide-react';
import Menu, { MenuItem } from './Menu.jsx';
import { DEBUG_FILE } from '../data/sampleProject.js';

// Primary Run button with the execution-mode menu next to it. While a
// session is active it turns into a Stop button with a status label.
export default function RunControl({ session, runTarget, onRun, onStep, onDebug, onStop }) {
  if (session) {
    const label =
      session.mode === 'run'
        ? `Running ${session.path}`
        : session.mode === 'step'
          ? `Stepping through ${session.path}`
          : `Debugging ${session.path}`;
    return (
      <div className="run-control">
        <span className="run-status" role="status">
          {session.mode === 'run' && <Loader2 size={16} className="spin" aria-hidden="true" />}
          {session.mode === 'step' && <Footprints size={16} aria-hidden="true" />}
          {session.mode === 'debug' && <Bug size={16} aria-hidden="true" />}
          <span className="run-status-text">{label}</span>
        </span>
        <button type="button" className="btn btn-secondary btn-stop" onClick={onStop}>
          <Square size={12} fill="currentColor" aria-hidden="true" />
          Stop
        </button>
      </div>
    );
  }

  return (
    <div className="run-control">
      <div className="split-button">
        <button
          type="button"
          className="btn btn-primary split-main"
          onClick={onRun}
          data-tooltip={`Run ${runTarget}`}
        >
          <Play size={14} fill="currentColor" aria-hidden="true" />
          Run
        </button>
        <Menu
          label="Execution mode"
          renderTrigger={(props) => (
            <button
              type="button"
              className="btn btn-primary split-toggle"
              aria-label="More ways to run"
              data-tooltip="More ways to run"
              {...props}
            >
              <ChevronDown size={14} aria-hidden="true" />
            </button>
          )}
        >
          {(close) => (
            <>
              <MenuItem close={close} icon={Play} label="Run" description={`Run ${runTarget}`} onSelect={onRun} />
              <MenuItem
                close={close}
                icon={Footprints}
                label="Step through"
                description={`Run ${DEBUG_FILE} one line at a time`}
                onSelect={onStep}
              />
              <MenuItem
                close={close}
                icon={Bug}
                label="Debug"
                description={`Pause ${DEBUG_FILE} at breakpoints`}
                onSelect={onDebug}
              />
              <div className="menu-footnote">Execution is simulated in this demo.</div>
            </>
          )}
        </Menu>
      </div>
    </div>
  );
}
