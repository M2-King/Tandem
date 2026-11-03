import { useRef } from 'react';
import { ImagePlus, PanelLeft, PanelBottom, PanelRight, MoreHorizontal, Check, Loader2, AlertTriangle, Minus, Plus, RotateCcw, Rows2, Columns2 } from 'lucide-react';
import IconButton from './IconButton.jsx';
import TandemMark from './TandemMark.jsx';
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
      {state === 'saving' ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
      {state === 'saving' ? 'Saving…' : 'Saved locally'}
    </span>
  );
}

const swatch = (className, style) =>
  function Swatch() {
    return <span className={`wallpaper-swatch ${className}`} style={style} aria-hidden="true" />;
  };
const DuskSwatch = swatch('wallpaper-swatch-dusk');
const PlainSwatch = swatch('wallpaper-swatch-plain');

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
  wallpaper,
  onWallpaper,
  onWallpaperFile,
}) {
  const fileInput = useRef(null);
  const custom = wallpaper.custom;
  return (
    <header className="toolbar">
      <div className="toolbar-left">
        <span className="app-mark" aria-hidden="true">
          <TandemMark size={18} />
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
            size={18}
            label={panels.files.open ? 'Hide files' : 'Show files'}
            pressed={panels.files.open}
            onClick={panels.files.toggle}
          />
          <IconButton
            icon={PanelBottom}
            size={18}
            label={panels.results.open ? 'Hide results' : 'Show results'}
            pressed={panels.results.open}
            onClick={panels.results.toggle}
          />
          <IconButton
            icon={PanelRight}
            size={18}
            label={panels.assistant.open ? 'Hide assistant' : 'Show assistant'}
            pressed={panels.assistant.open}
            onClick={panels.assistant.toggle}
            ref={panels.assistant.toggleRef}
          />
        </div>
        <Menu
          label="More options"
          renderTrigger={(props) => (
            <IconButton icon={MoreHorizontal} size={18} label="More options" tooltipSide="left" {...props} />
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
              <div className="menu-label">Wallpaper</div>
              <MenuItem
                close={close}
                role="menuitemradio"
                checked={wallpaper.kind === 'dusk' || (wallpaper.kind === 'custom' && !custom)}
                icon={DuskSwatch}
                label="Dusk"
                onSelect={() => onWallpaper('dusk')}
              />
              <MenuItem
                close={close}
                role="menuitemradio"
                checked={wallpaper.kind === 'plain'}
                icon={PlainSwatch}
                label="Plain"
                onSelect={() => onWallpaper('plain')}
              />
              {custom && (
                <MenuItem
                  close={close}
                  role="menuitemradio"
                  checked={wallpaper.kind === 'custom'}
                  icon={swatch('', { backgroundImage: `url("${custom.image}")` })}
                  label="Your image"
                  description={custom.name}
                  onSelect={() => onWallpaper('custom')}
                />
              )}
              <MenuItem
                close={close}
                icon={ImagePlus}
                label={custom ? 'Choose another image…' : 'Use your own image…'}
                description="Saved in this browser only"
                onSelect={() => fileInput.current?.click()}
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
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          hidden
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            onWallpaperFile(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>
    </header>
  );
}
