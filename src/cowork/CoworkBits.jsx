import { Check, ChevronLeft, Laptop, Loader2, LogOut, RefreshCw, RotateCcw, Settings, Share2, UserRound, WifiOff } from 'lucide-react';
import Menu, { MenuItem } from '../components/Menu.jsx';
import { initialsOf } from './fixtures.js';

// Small pieces of the Cowork preview UI used in the toolbar, the narrow
// project strip and the Shared projects page.

export function Avatar({ person, size = 'md', online, dim, arriving }) {
  return (
    <span
      className={`avatar avatar-${size} ${online ? 'is-online' : ''} ${dim ? 'is-dim' : ''} ${arriving ? 'is-arriving' : ''}`}
      style={{ '--peer-hue': person.hue }}
      aria-hidden="true"
    >
      {initialsOf(person.name)}
    </span>
  );
}

// "Wei Lin (you), Priya Nair (in clean_data.py), …": for screen readers and tooltips.
export function describePeople(entries) {
  return entries
    .map(({ person, you, where, online }) => `${person.name}${you ? ' (you)' : ''}${where ? `, in ${where}` : online ? ', online' : ''}`)
    .join('; ');
}

// Overlapping avatars; the button opens the Share dialog.
export function AvatarStack({ entries, max = 3, onClick, offline, arrivingId }) {
  const shown = entries.slice(0, max);
  const more = entries.length - shown.length;
  const label = `People in this project: ${describePeople(entries)}`;
  const content = (
    <>
      {shown.map(({ person, online, you }) => (
        <Avatar key={person.id} person={person} size="sm" online={online && !offline && !you} dim={offline && !you} arriving={person.id === arrivingId} />
      ))}
      {more > 0 && <span className="avatar avatar-sm avatar-more">+{more}</span>}
    </>
  );
  if (!onClick) {
    return (
      <span className="avatar-stack" role="img" aria-label={label}>
        {content}
      </span>
    );
  }
  return (
    <button type="button" className="avatar-stack is-button" onClick={onClick} aria-label={`${label}. Open sharing.`} data-tooltip={describePeople(entries)}>
      {content}
    </button>
  );
}

const SYNC = {
  saved: { Icon: Check, text: 'Saved', tip: 'Your edits are saved to the shared project.' },
  saving: { Icon: Loader2, text: 'Saving…', tip: 'Saving your edits to the shared project.', spin: true },
  reconnecting: {
    Icon: RefreshCw,
    text: 'Reconnecting…',
    tip: 'Connection lost. Keep working: your edits stay on this device and are saved when the connection is back. Run still works.',
    spin: true,
  },
};

export function SyncStatus({ sync }) {
  const s = SYNC[sync] || SYNC.saved;
  return (
    <span className={`save-status sync-status is-${sync}`} role="status" aria-live="polite" data-tooltip={s.tip} tabIndex={0}>
      <s.Icon size={14} className={s.spin ? 'spin' : undefined} aria-hidden="true" />
      <span className="sync-text">{s.text}</span>
    </span>
  );
}

export function DeviceChip() {
  return (
    <span
      className="device-chip"
      tabIndex={0}
      data-tooltip="Run uses Python on your device. Teammates share the files, not your variables or results."
    >
      <Laptop size={14} aria-hidden="true" />
      <span className="device-chip-text">Runs on this device</span>
    </span>
  );
}

export function ShareButton({ onClick, compact }) {
  return (
    <button type="button" className={`btn btn-secondary btn-sm share-btn ${compact ? 'is-compact' : ''}`} onClick={onClick}>
      <Share2 size={14} aria-hidden="true" />
      <span className="share-btn-text">Share</span>
    </button>
  );
}

export function SettingsButton({ onClick }) {
  return (
    <button type="button" className="icon-btn settings-btn" aria-label="Project settings" data-tooltip="Project settings" onClick={onClick}>
      <Settings size={16} strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
}

// The "Preview" badge: what is sample data, and controls to see other states.
export function PreviewMenu({ cowork, inProject, className = '' }) {
  const { viewer, sync } = cowork;
  const asOwner = viewer.id === 'wei';
  return (
    <Menu
      align="start"
      label="Cowork preview"
      renderTrigger={(props) => (
        <button type="button" className={`demo-badge preview-badge ${className}`} {...props}>
          Preview
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="preview-menu-note">
            <p className="demo-popover-title">Cowork preview</p>
            <p>
              Teammates, invitations, sync and run results are sample data for review. Nothing is shared, sent or executed.
              {cowork.signedIn ? (
                <>
                  You are signed in as <strong>{viewer.name}</strong>.
                </>
              ) : (
                <>Sign in with any email; the page shows the code.</>
              )}
            </p>
          </div>
          <div className="menu-sep" role="separator" />
          {inProject && (
            <MenuItem
              close={close}
              icon={WifiOff}
              label="Simulate a dropped connection"
              description="Shows Reconnecting…; it comes back in a few seconds"
              disabled={sync === 'reconnecting'}
              onSelect={cowork.dropConnection}
            />
          )}
          <MenuItem
            close={close}
            icon={UserRound}
            label={asOwner ? 'View as Sara Kim (invited)' : 'View as Wei Lin (owner)'}
            description={asOwner ? 'A new member with an invitation to Data Study' : 'Back to the project owner'}
            onSelect={() => cowork.viewAs(asOwner ? 'sara' : 'wei')}
          />
          {cowork.signedIn && <MenuItem close={close} icon={LogOut} label="Sign out" description={viewer.email} onSelect={cowork.signOut} />}
          <MenuItem close={close} icon={RotateCcw} label="Reset preview" description="Sample projects and people; signed out" onSelect={cowork.resetPreview} />
        </>
      )}
    </Menu>
  );
}

// Toolbar title in Cowork: Shared projects / Project, and the preview badge.
export function CoworkTitle({ cowork, children }) {
  const { project } = cowork;
  return (
    <>
      <span className="toolbar-sep" aria-hidden="true">
        /
      </span>
      {project ? (
        <>
          <button type="button" className="crumb-back" aria-label="Back to Shared projects" data-tooltip="Shared projects" onClick={() => cowork.go('home')}>
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
          <button type="button" className="crumb-link" onClick={() => cowork.go('home')}>
            Shared projects
          </button>
          <span className="toolbar-sep crumb-sep" aria-hidden="true">
            /
          </span>
          <span className="cowork-project-name">{project.name}</span>
        </>
      ) : (
        <span className="cowork-project-name">Shared projects</span>
      )}
      <PreviewMenu cowork={cowork} inProject={!!project} className={`toolbar-preview ${project ? 'in-project' : ''}`} />
      {children}
    </>
  );
}
