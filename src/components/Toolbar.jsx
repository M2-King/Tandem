import { useRef } from 'react';
import {
  ImagePlus,
  PanelLeft,
  PanelBottom,
  PanelRight,
  MoreHorizontal,
  Check,
  Loader2,
  AlertTriangle,
  Minus,
  Plus,
  RotateCcw,
  Rows2,
  Columns2,
  Sparkles,
  FolderOpen,
  Upload,
} from 'lucide-react';
import IconButton from './IconButton.jsx';
import TandemMark from './TandemMark.jsx';
import { GLASS_PRESETS } from '../lib/glass.js';
import Menu, { MenuItem } from './Menu.jsx';
import RunControl from './RunControl.jsx';
import WindowControls from './WindowControls.jsx';
import { MATERIAL_LABELS } from '../state/useDesktop.js';

function SaveStatus({ state, onDisk }) {
  if (state === 'failed') {
    return (
      <span
        className="save-status save-failed"
        data-tooltip={
          onDisk
            ? 'A file couldn’t be written to disk. See the message for the reason.'
            : 'This browser blocked local storage. Changes will be lost on reload.'
        }
      >
        <AlertTriangle size={14} aria-hidden="true" /> Not saved
      </span>
    );
  }
  return (
    <span
      className="save-status"
      data-tooltip={onDisk ? 'Files are saved to your project folder.' : 'Files and settings are saved in this browser only.'}
      tabIndex={0}
    >
      {state === 'saving' ? (
        <Loader2 size={14} className="spin" aria-hidden="true" />
      ) : (
        <Check size={14} aria-hidden="true" />
      )}
      {state === 'saving' ? 'Saving…' : onDisk ? 'Saved to disk' : 'Saved locally'}
    </span>
  );
}

const swatch = (className, style) =>
  function Swatch() {
    return <span className={`wallpaper-swatch ${className}`} style={style} aria-hidden="true" />;
  };
const DuskSwatch = swatch('wallpaper-swatch-dusk');
const PlainSwatch = swatch('wallpaper-swatch-plain');

function GlassSlider({ label, from, to, value, onChange }) {
  return (
    <label className="glass-slider">
      <span className="glass-slider-label">{label}</span>
      <span className="glass-slider-end" aria-hidden="true">
        {from}
      </span>
      <input
        type="range"
        min="0"
        max="100"
        step="1"
        data-menu-item=""
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-valuetext={`${label} ${value} of 100`}
      />
      <span className="glass-slider-end" aria-hidden="true">
        {to}
      </span>
    </label>
  );
}

export default function Toolbar({
  projectName,
  modeBadge,
  savesToDisk,
  saveState,
  run,
  panels,
  fontSize,
  onFontSize,
  diffInline,
  onDiffInline,
  onReset,
  onAISettings,
  desktop,
  onOpenFolder,
  onAddFiles,
  glass,
  onGlass,
  frost,
  onFrost,
  wallpaper,
  onWallpaper,
  onWallpaperFile,
}) {
  const fileInput = useRef(null);
  const addInput = useRef(null);
  const custom = wallpaper.custom;
  return (
    <header className="toolbar">
      <div className="toolbar-left">
        <span className="app-mark" aria-hidden="true">
          <TandemMark size={18} />
        </span>
        <span className="app-name">Tandem</span>
        <span className="toolbar-sep" aria-hidden="true">
          /
        </span>
        <span className="project-name">{projectName}</span>
        {modeBadge}
        <SaveStatus state={saveState} onDisk={savesToDisk} />
      </div>

      <div className="toolbar-right">
        <RunControl {...run} />
        <div className="toolbar-tools">
          <div className="toolbar-group" role="group" aria-label="Panels">
            <IconButton
              icon={PanelLeft}
              size={18}
              className="toolbar-files-toggle"
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
                {onOpenFolder && (
                  <MenuItem close={close} icon={FolderOpen} label="Open folder…" description="Switch to another project" onSelect={onOpenFolder} />
                )}
                {onAddFiles && (
                  <MenuItem
                    close={close}
                    icon={Upload}
                    label="Add files…"
                    description="Copy files into this project"
                    onSelect={() => addInput.current?.click()}
                  />
                )}
                {onAISettings && (
                  <>
                    <MenuItem
                      close={close}
                      icon={Sparkles}
                      label="AI settings…"
                      description="Provider, model and API key"
                      onSelect={onAISettings}
                    />
                    <div className="menu-sep" role="separator" />
                  </>
                )}
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
                <div className="menu-glass" role="group" aria-labelledby="glass-label">
                  <div className="menu-row">
                    <span className="menu-row-label" id="glass-label">
                      Glass
                    </span>
                    <div className="segmented" role="group" aria-label="Glass preset">
                      {GLASS_PRESETS.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          role="menuitemradio"
                          aria-checked={glass === p.level}
                          className={glass === p.level ? 'is-active' : ''}
                          onClick={() => onGlass(p.level)}
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <GlassSlider label="Opacity" from="Clear" to="Solid" value={glass} onChange={onGlass} />
                  {!desktop?.active && <GlassSlider label="Frost" from="Light" to="Heavy" value={frost} onChange={onFrost} />}
                  <p className="menu-footnote">
                    {desktop?.active
                      ? 'The glass sits over your own desktop and adapts to your wallpaper’s brightness. Your wallpaper is never changed.'
                      : 'Glass adapts to your wallpaper’s brightness. The wallpaper itself is never changed.'}
                  </p>
                </div>
                {desktop?.active ? (
                  <>
                    <div className="menu-label">Window glass</div>
                    {(desktop.info?.materials || []).map((m) => (
                      <MenuItem
                        key={m}
                        close={close}
                        role="menuitemradio"
                        checked={desktop.info?.material === m}
                        label={MATERIAL_LABELS[m]?.label ?? m}
                        description={MATERIAL_LABELS[m]?.description}
                        onSelect={() => desktop.setMaterial(m)}
                      />
                    ))}
                  </>
                ) : (
                <>
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
                    icon={swatch('', {
                      backgroundImage: `url("${custom.image}")`,
                    })}
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
                </>
                )}
                {onReset && (
                  <>
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
              </>
            )}
          </Menu>
        </div>
        {desktop?.active && desktop.info?.material === 'clear' && <WindowControls maximized={desktop.maximized} />}
        {onAddFiles && (
          <input
            ref={addInput}
            type="file"
            multiple
            hidden
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => {
              onAddFiles(e.target.files);
              e.target.value = '';
            }}
          />
        )}
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
