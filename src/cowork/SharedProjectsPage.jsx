import { Archive, ArchiveRestore, ChevronRight, FolderOpen, HardDrive, Loader2, LogOut, Mail, Plus, Users } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Avatar, AvatarStack } from './CoworkBits.jsx';
import { SuccessCheck, pause } from './motion.jsx';

const ROLE = { owner: 'Owner', member: 'Member' };

export function timeAgo(at) {
  const minutes = Math.max(1, Math.round((Date.now() - at) / 60000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

const firstName = (person) => person.name.split(' ')[0];

// An invitation. Join: "Joining…", then a short "You're in", then the
// project opens. Decline: the card folds away.
function InviteCard({ cowork, project, invite, from, people }) {
  const [state, setState] = useState('open'); // open | joining | joined | leaving
  const alive = useRef(true);
  useEffect(() => () => (alive.current = false), []);
  const join = async () => {
    setState('joining');
    await pause(500);
    if (!alive.current) return;
    setState('joined');
    await pause(1000);
    if (alive.current) cowork.join(project.id);
  };
  const decline = async () => {
    setState('leaving');
    await pause(320, { motionOnly: true });
    if (alive.current) cowork.decline(project.id);
  };
  return (
    <div className={`invite-wrap ${state === 'leaving' ? 'is-leaving' : ''}`}>
      <article className={`invite-card is-${state}`} aria-label={`Invitation to ${project.name}`} aria-busy={state === 'joining'}>
        {state === 'joined' ? (
          <div className="invite-joined" role="status">
            <SuccessCheck size={36} />
            <div className="invite-body">
              <p className="invite-text">
                You’re in. Opening <strong>{project.name}</strong>…
              </p>
              <p className="invite-meta">You join as {invite.role === 'owner' ? 'an owner' : 'a member'}.</p>
            </div>
          </div>
        ) : (
          <>
            <span className="invite-icon" aria-hidden="true">
              <Mail size={18} />
            </span>
            <div className="invite-body">
              <p className="invite-text">
                <strong>{from.name}</strong> invited you to <strong>{project.name}</strong>
              </p>
              <p className="invite-meta">
                As {invite.role === 'owner' ? 'an owner' : 'a member'} · {project.members.length} people · {timeAgo(invite.at)}
              </p>
              <AvatarStack entries={people} max={4} />
            </div>
            <div className="invite-actions">
              <button type="button" className="btn btn-secondary btn-sm" onClick={decline} disabled={state !== 'open'}>
                Decline
              </button>
              <button type="button" className="btn btn-primary btn-sm invite-join" onClick={join} disabled={state !== 'open'}>
                {state === 'joining' && <Loader2 size={14} className="spin" aria-hidden="true" />}
                {state === 'joining' ? 'Joining…' : 'Join project'}
              </button>
            </div>
          </>
        )}
      </article>
    </div>
  );
}

// Shared projects: invitations, the projects you're in (with your role), and
// a way back to this device's project.
export default function SharedProjectsPage({ cowork, localName, onOpenLocal, onNew }) {
  const { projects, archived, invitations, people, viewer, roleIn } = cowork;
  const entriesOf = (p) => p.members.map((m) => ({ person: people[m.id], you: m.id === viewer.id }));

  return (
    <div className="shared-page">
      <div className="shared-inner">
        <header className="shared-head">
          <div>
            <h1 className="shared-title">Shared projects</h1>
            <p className="shared-sub">Work on the same files and notebooks with your team. Python runs on each person’s own device.</p>
          </div>
          <button type="button" className="btn btn-primary" onClick={onNew}>
            <Plus size={16} aria-hidden="true" /> New shared project
          </button>
        </header>

        {invitations.length > 0 && (
          <section className="shared-section" aria-labelledby="invites-heading">
            <h2 className="shared-section-title" id="invites-heading">
              Invitations
            </h2>
            {invitations.map(({ project, invite, from }) => (
              <InviteCard key={project.id} cowork={cowork} project={project} invite={invite} from={from} people={entriesOf(project)} />
            ))}
          </section>
        )}

        <section className="shared-section" aria-labelledby="projects-heading">
          <h2 className="shared-section-title" id="projects-heading">
            Your shared projects
          </h2>
          {projects.length ? (
            <ul className="shared-list">
              {projects.map((p) => {
                const role = roleIn(p);
                const editor = people[p.edited.by];
                return (
                  <li key={p.id}>
                    <button type="button" className="shared-row" onClick={() => cowork.go('project', p.id)}>
                      <span className="shared-row-icon" aria-hidden="true">
                        <FolderOpen size={18} />
                      </span>
                      <span className="shared-row-main">
                        <span className="shared-row-name">{p.name}</span>
                        <span className="shared-row-meta">
                          {p.members.length} {p.members.length === 1 ? 'person' : 'people'} · edited {timeAgo(p.edited.at)}
                          {editor ? ` by ${editor.id === viewer.id ? 'you' : firstName(editor)}` : ''}
                        </span>
                      </span>
                      <span className={`role-pill is-${role}`}>{ROLE[role]}</span>
                      <span className="shared-row-people">
                        <AvatarStack entries={entriesOf(p)} max={3} />
                      </span>
                      <ChevronRight size={16} aria-hidden="true" className="shared-row-chevron" />
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="shared-empty">
              <span className="shared-empty-icon" aria-hidden="true">
                <Users size={22} />
              </span>
              <p className="shared-empty-title">No shared projects yet</p>
              <p className="shared-empty-text">
                Start one and invite your team, or join a project when someone invites you. You’ll see it here.
              </p>
              <button type="button" className="btn btn-secondary" onClick={onNew}>
                <Plus size={16} aria-hidden="true" /> New shared project
              </button>
            </div>
          )}
        </section>

        {archived.length > 0 && (
          <section className="shared-section" aria-labelledby="archived-heading">
            <h2 className="shared-section-title" id="archived-heading">
              Archived
            </h2>
            <ul className="shared-list">
              {archived.map((p) => {
                const by = people[p.archived.by];
                const owner = cowork.can(p, 'settings');
                return (
                  <li key={p.id} className="shared-row is-archived">
                    <span className="shared-row-icon is-device" aria-hidden="true">
                      <Archive size={18} />
                    </span>
                    <span className="shared-row-main">
                      <span className="shared-row-name">{p.name}</span>
                      <span className="shared-row-meta">
                        Archived {timeAgo(p.archived.at)}
                        {by ? ` by ${by.id === viewer.id ? 'you' : firstName(by)}` : ''}
                        {owner ? '' : ' · only owners can restore it'}
                      </span>
                    </span>
                    <span className={`role-pill is-${roleIn(p)}`}>{ROLE[roleIn(p)]}</span>
                    {owner && (
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => cowork.restoreProject(p.id)}>
                        <ArchiveRestore size={14} aria-hidden="true" /> Restore
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <section className="shared-section" aria-labelledby="device-heading">
          <h2 className="shared-section-title" id="device-heading">
            On this device
          </h2>
          <ul className="shared-list">
            <li>
              <button type="button" className="shared-row" onClick={onOpenLocal}>
                <span className="shared-row-icon is-device" aria-hidden="true">
                  <HardDrive size={18} />
                </span>
                <span className="shared-row-main">
                  <span className="shared-row-name">{localName}</span>
                  <span className="shared-row-meta">Only on this device · not shared</span>
                </span>
                <ChevronRight size={16} aria-hidden="true" className="shared-row-chevron" />
              </button>
            </li>
          </ul>
        </section>

        <div className="shared-foot">
          <Avatar person={viewer} size="sm" />
          <span className="shared-foot-text">
            Signed in as {viewer.name} · {viewer.email}
          </span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={cowork.signOut}>
            <LogOut size={14} aria-hidden="true" /> Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
