import { useEffect, useRef, useState } from 'react';
import { Eye, Lock, LogOut, UserMinus, X } from 'lucide-react';
import SharedAISection from './SharedAISection.jsx';
import Dialog from '../components/Dialog.jsx';
import { Avatar } from './CoworkBits.jsx';
import { addressOf, normalizeUsername, personForUsername } from './accounts.js';
import { timeAgo } from './SharedProjectsPage.jsx';

function PersonRow({ m, cowork, project, isOwner, owners, where }) {
  const { people, viewer, sync } = cowork;
  const person = people[m.id];
  const you = m.id === viewer.id;
  const here = where(m.id);
  const online = you || !!here;
  const lastOwner = m.role === 'owner' && owners.length === 1;
  return (
    <li className="share-row">
      <Avatar person={person} online={online && !you && sync !== 'reconnecting'} />
      <span className="share-person">
        <span className="share-name">
          {person.name}
          {you && <span className="share-you"> (you)</span>}
        </span>
        <span className="share-detail">
          {person.username ? addressOf(person.username) : ''}
          {here && sync !== 'reconnecting' ? ` · in ${here}` : ''}
        </span>
      </span>
      {isOwner && !you ? (
        <span className="share-controls">
          <select
            className="field-input share-role"
            value={m.role}
            aria-label={`Role for ${person.name}`}
            onChange={(e) => cowork.setRole(project.id, m.id, e.target.value)}
          >
            <option value="owner">Owner</option>
            <option value="member">Member</option>
          </select>
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            aria-label={`Remove ${person.name}`}
            data-tooltip="Remove from project"
            onClick={() => cowork.removeMember(project.id, m.id)}
          >
            <UserMinus size={14} aria-hidden="true" />
          </button>
        </span>
      ) : (
        <span className="share-role-text" data-tooltip={you && lastOwner ? 'A project keeps at least one owner' : undefined}>
          {m.role === 'owner' ? 'Owner' : 'Member'}
        </span>
      )}
    </li>
  );
}

// Who is in a shared project, and (for owners) inviting people and roles.
export default function ShareDialog({ cowork, project, presence, onClose, notify, sharedAI }) {
  const { viewer, roleIn } = cowork;
  const isOwner = roleIn(project) === 'owner';
  const [who, setWho] = useState('');
  const [role, setRole] = useState('member');
  const [error, setError] = useState(null);
  const [found, setFound] = useState([]); // matching accounts while typing
  const [pick, setPick] = useState(-1);
  const inputRef = useRef(null);

  // Find people as the owner types (a short pause, then search).
  useEffect(() => {
    const q = normalizeUsername(who);
    if (q.length < 2) {
      setFound([]);
      return undefined;
    }
    let live = true;
    const t = setTimeout(async () => {
      const list = await cowork.searchPeople(q);
      const inProject = new Set([...project.members.map((m) => cowork.people[m.id]?.username), ...project.invites.map((i) => i.username)]);
      if (live) {
        setFound(list.filter((x) => x.username !== q || !inProject.has(x.username)).slice(0, 6).map((x) => ({ ...x, taken: inProject.has(x.username) })));
        setPick(-1);
      }
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [who]);

  const where = (id) => presence.find((p) => p.person === id)?.path;
  const owners = project.members.filter((m) => m.role === 'owner');
  const members = project.members.filter((m) => m.role === 'member');

  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    const username = normalizeUsername(who);
    const problem = await cowork.invite(project.id, username, role);
    setBusy(false);
    if (problem) {
      setError(problem);
      return;
    }
    notify(`Invited ${addressOf(username)}. They’ll see it in Shared projects in Tandem.`);
    setWho('');
    setFound([]);
    setError(null);
  };
  const choose = (x) => {
    setWho(x.username);
    setFound([]);
    setError(null);
    inputRef.current?.focus();
  };
  const onKeys = (e) => {
    if (!found.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setPick((i) => (i + (e.key === 'ArrowDown' ? 1 : found.length - 1)) % found.length);
    } else if (e.key === 'Enter' && pick >= 0) {
      e.preventDefault();
      choose(found[pick]);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      setFound([]);
    }
  };

  return (
    <Dialog title={`Share ${project.name}`} onClose={onClose} className="dialog-share">
      <div className="share-head">
        <h2 className="dialog-title">Share {project.name}</h2>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <p className="dialog-text share-intro">
        Everyone here can open and edit every file. Python runs on each person’s own device, so variables and results aren’t shared.
      </p>

      {isOwner ? (
        <form className="share-invite" onSubmit={submit} noValidate>
          <label className="field share-email">
            <span className="field-label">Invite by username or Tandem address</span>
            <span className="share-find">
              <input
                ref={inputRef}
                className="field-input"
                value={who}
                onChange={(e) => {
                  setWho(e.target.value);
                  setError(null);
                }}
                onKeyDown={onKeys}
                placeholder={`priya or priya@tandem.org`}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                data-autofocus
                role="combobox"
                aria-expanded={found.length > 0}
                aria-controls="share-found"
                aria-activedescendant={pick >= 0 ? `share-found-${pick}` : undefined}
                aria-invalid={!!error}
                aria-describedby={error ? 'share-error' : 'share-hint'}
              />
              {found.length > 0 && (
                <ul className="share-found" id="share-found" role="listbox" aria-label="Tandem accounts">
                  {found.map((x, i) => (
                    <li
                      key={x.username}
                      id={`share-found-${i}`}
                      role="option"
                      aria-selected={i === pick}
                      aria-disabled={x.taken}
                      className={`share-found-row ${i === pick ? 'is-active' : ''} ${x.taken ? 'is-taken' : ''}`}
                      onPointerDown={(e) => {
                        e.preventDefault();
                        if (!x.taken) choose(x);
                      }}
                    >
                      <Avatar person={personForUsername(x.username, cowork.people)} size="sm" />
                      <span className="share-found-text">
                        <span>{x.name}</span>
                        <span className="mono">{addressOf(x.username)}</span>
                      </span>
                      {x.taken && <span className="share-found-note">Already here</span>}
                    </li>
                  ))}
                </ul>
              )}
            </span>
          </label>
          <label className="field share-invite-role">
            <span className="field-label">Role</span>
            <select className="field-input" value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="member">Member</option>
              <option value="owner">Owner</option>
            </select>
          </label>
          <button type="submit" className="btn btn-primary share-invite-btn" disabled={busy}>
            {busy ? 'Inviting…' : 'Invite'}
          </button>
          {error ? (
            <p className="field-error share-msg" id="share-error" role="alert">
              {error}
            </p>
          ) : (
            <p className="field-hint share-msg" id="share-hint">
              They need a Tandem account. The invitation waits in their Shared projects; nothing is emailed.
            </p>
          )}
        </form>
      ) : (
        <p className="share-member-note">
          <Lock size={14} aria-hidden="true" /> Only owners can invite people or change roles.
        </p>
      )}

      <div className="share-lists">
        <section aria-labelledby="share-owners">
          <h3 className="share-section-title" id="share-owners">
            Owners · {owners.length}
          </h3>
          <ul className="share-list">
            {owners.map((m) => (
              <PersonRow key={m.id} m={m} cowork={cowork} project={project} isOwner={isOwner} owners={owners} where={where} />
            ))}
          </ul>
        </section>
        <section aria-labelledby="share-members">
          <h3 className="share-section-title" id="share-members">
            Members · {members.length}
          </h3>
          {members.length ? (
            <ul className="share-list">
              {members.map((m) => (
                <PersonRow key={m.id} m={m} cowork={cowork} project={project} isOwner={isOwner} owners={owners} where={where} />
              ))}
            </ul>
          ) : (
            <p className="share-empty">No members yet.</p>
          )}
        </section>
        <section aria-labelledby="share-pending">
          <h3 className="share-section-title" id="share-pending">
            Pending invitations · {project.invites.length}
          </h3>
          {project.invites.length ? (
            <ul className="share-list">
              {project.invites.map((i) => {
                const person = personForUsername(i.username, cowork.people);
                return (
                  <li key={i.username} className="share-row is-pending">
                    <Avatar person={person} dim />
                    <span className="share-person">
                      <span className="share-name">
                        {person.name} <span className="share-you mono">{addressOf(i.username)}</span>
                      </span>
                      <span className="share-detail">
                        Invited {timeAgo(i.at)} as {i.role === 'owner' ? 'an owner' : 'a member'}
                      </span>
                    </span>
                    {isOwner && (
                      <span className="share-controls">
                        {cowork.viewAs && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => {
                            onClose();
                            cowork.viewAs(i.username);
                          }}
                          data-tooltip="Preview what this person sees: the invitation, then the project as a member"
                        >
                          <Eye size={14} aria-hidden="true" /> Preview as invitee
                        </button>
                        )}
                        <button
                          type="button"
                          className="icon-btn icon-btn-sm"
                          aria-label={`Cancel the invitation to ${addressOf(i.username)}`}
                          data-tooltip="Cancel invitation"
                          onClick={() => cowork.cancelInvite(project.id, i.username)}
                        >
                          <X size={14} aria-hidden="true" />
                        </button>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="share-empty">No pending invitations.</p>
          )}
        </section>
        {sharedAI?.available && <SharedAISection sharedAI={sharedAI} isOwner={isOwner} notify={notify} />}
      </div>

      <div className="dialog-actions share-actions">
        {!isOwner && (
          <button
            type="button"
            className="btn btn-ghost share-leave"
            onClick={async () => {
              const ok = await cowork.removeMember(project.id, viewer.id);
              if (ok === false) return;
              onClose();
              cowork.go('home');
              notify(`You left ${project.name}.`);
            }}
          >
            <LogOut size={14} aria-hidden="true" /> Leave project
          </button>
        )}
        <button type="button" className="btn btn-secondary" onClick={onClose} data-autofocus={!isOwner || undefined}>
          Done
        </button>
      </div>
    </Dialog>
  );
}
