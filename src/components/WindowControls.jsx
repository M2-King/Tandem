import { Minus, Square, Copy, X } from 'lucide-react';
import { DESKTOP } from '../runtime/desktop.js';

// Minimize / maximize / close, drawn by the app when the window is frameless
// (Clear glass). With Frosted or Mica glass Windows draws its own buttons.
export default function WindowControls({ maximized }) {
  const act = (action) => () => DESKTOP.windowAction(action);
  return (
    <div className="window-controls" role="group" aria-label="Window">
      <button type="button" aria-label="Minimize" onClick={act('minimize')}>
        <Minus size={16} aria-hidden="true" />
      </button>
      <button type="button" aria-label={maximized ? 'Restore' : 'Maximize'} onClick={act('maximize')}>
        {maximized ? <Copy size={13} aria-hidden="true" /> : <Square size={13} aria-hidden="true" />}
      </button>
      <button type="button" className="window-close" aria-label="Close" onClick={act('close')}>
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
