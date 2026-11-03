import { PanelLeft, PanelBottom, PanelRight, MoreHorizontal, Check, Loader2, AlertTriangle, Minus, Plus, RotateCcw, Rows2, Columns2 } from 'lucide-react';
import IconButton from './IconButton.jsx';
import Menu, { MenuItem } from './Menu.jsx';
import RunControl from './RunControl.jsx';

function SaveStatus({ state }) {
  if (state === 'failed') {
    return (
      <span className="save-status save-failed" data-tooltip="This browser blocked local storage. Changes will be lost on reload.">
        <AlertTriangle size={14} aria-hidden="true" /> Not saved
      </span>
    );
  }
  return (
    <span className="save-status" data-tooltip="Files and settings are saved in this browser only." tabIndex={0}>
      {state === 'saving' ? <Loader2 size={13} className="spin" aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
      {state === 'saving' ? 'Saving…' : 'Saved locally'}
    </span>
  );
}

function DemoBadge() {
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
        <p className="demo-popover-title">This is a frontend prototype</p>
        <p>
          AI responses and Python execution are simulated with prepared, deterministic sample data. No code is executed
          and nothing is sent to a server.
        </p>
        <p>Your files are saved in this browser. Use Reset demo in the ⋯ menu to start over.</p>
      </div>
    </Menu>
  );
}

export default function Toolbar({
  projectName,
  saveState,
  run,
  panels,
  fontSize,
  onFontSize,
  diffInline,
  onDiffInline,
  onReset,
}) {
  return (
    <header className="toolbar">
      <div className="toolbar-left">
        <span className="app-mark" aria-hidden="true">
          <svg viewBox="0 0 32 32" width="20" height="20">
            <rect width="32" height="32" rx="8" fill="#202124" />
            <path d="M9 11h14M16 11v12" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
            <circle cx="23" cy="22" r="3" fill="#2563EB" />
          </svg>
        </span>
        <span className="app-name">Tandem</span>
        <span className="toolbar-sep" aria-hidden="true">/</span>
        <span className="project-name">{projectName}</span>
        <DemoBadge />
        <SaveStatus state={saveState} />
      </div>

      <div className="toolbar-right">
        <RunControl {...run} />
        <div className="toolbar-group" role="group" aria-label="Panels">
          <IconButton
            icon={PanelLeft}
            label={panels.files.open ? 'Hide files' : 'Show files'}
            pressed={panels.files.open}
            onClick={panels.files.toggle}
          />
          <IconButton
            icon={PanelBottom}
            label={panels.results.open ? 'Hide results' : 'Show results'}
            pressed={panels.results.open}
            onClick={panels.results.toggle}
          />
          <IconButton
            icon={PanelRight}
            label={panels.assistant.open ? 'Hide assistant' : 'Show assistant'}
            pressed={panels.assistant.open}
            onClick={panels.assistant.toggle}
            ref={panels.assistant.toggleRef}
          />
        </div>
        <Menu
          label="More options"
          renderTrigger={(props) => (
            <IconButton icon={MoreHorizontal} label="More options" tooltipSide="left" {...props} />
          )}
        >
          {(close) => (
            <>
              <div className="menu-row" role="group" aria-label="Editor text size">
                <span className="menu-row-label">Editor text size</span>
                <div className="stepper">
                  <button
                    type="button"
                    role="menuitem"
                    className="icon-btn icon-btn-sm"
                    aria-label="Decrease text size"
                    onClick={() => onFontSize(-1)}
                  >
                    <Minus size={14} aria-hidden="true" />
                  </button>
                  <span className="stepper-value" aria-live="polite">
                    {fontSize}px
                  </span>
                  <button
                    type="button"
                    role="menuitem"
                    className="icon-btn icon-btn-sm"
                    aria-label="Increase text size"
                    onClick={() => onFontSize(1)}
                  >
                    <Plus size={14} aria-hidden="true" />
                  </button>
                </div>
              </div>
              <div className="menu-label">Change review layout</div>
              <MenuItem
                close={close}
                role="menuitemradio"
                checked={diffInline}
                icon={Rows2}
                label="Inline"
                onSelect={() => onDiffInline(true)}
              />
              <MenuItem
                close={close}
                role="menuitemradio"
                checked={!diffInline}
                icon={Columns2}
                label="Side by side"
                onSelect={() => onDiffInline(false)}
              />
              <div className="menu-sep" role="separator" />
              <MenuItem
                close={close}
                icon={RotateCcw}
                label="Reset demo…"
                description="Restore the sample project"
                onSelect={onReset}
              />
            </>
          )}
        </Menu>
      </div>
    </header>
  );
}
