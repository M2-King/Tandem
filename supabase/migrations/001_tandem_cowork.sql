-- Tandem Cowork: accounts with a username, private shared projects,
-- members, invitations by username, and shared text files.
--
-- Apply to a dedicated Tandem Supabase project (Auth on, email provider on,
-- "Confirm email" off: see docs/cowork-backend.md). Keep tandem_private out
-- of the API's exposed schemas: it holds the access checks.
--
-- Accounts: people sign up and sign in with a username and password, with no
-- email confirmation. The app shows each account's Tandem address as
-- username@tandem.org; people find and invite each other by it inside the
-- app. Auth needs an email, so the app signs up <username>@<internal domain>
-- (one that can never receive mail, see docs/cowork-backend.md) with
-- {"username": ...} in the user metadata. The trigger below claims the
-- username in cowork_profiles (unique, lowercase) and refuses an account
-- whose metadata and address disagree.
--
-- Reads go through row-level security (members see their projects, people
-- and files; invitees see their own invitations). Every change goes through
-- the cowork_* functions, which check the caller's role; the tables take no
-- direct inserts, updates or deletes from the API.
--
-- Errors use PostgREST's PTxxx codes, so the API answers with that HTTP
-- status: PT400 invalid input, PT403 not allowed, PT404 not found,
-- PT409 conflict (taken name, stale revision, archived project).

begin;

create schema if not exists tandem_private;
revoke all on schema tandem_private from public;
grant usage on schema tandem_private to authenticated;

-- ------------------------------------------------------------------ checks

-- The signed-in user's id; refuses anonymous callers.
create or replace function tandem_private.require_user()
returns uuid
language plpgsql stable
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'Sign in to use shared projects.' using errcode = 'PT403';
  end if;
  return uid;
end;
$$;

-- A username: 3 to 24 lowercase letters, digits or _, starting with a letter.
create or replace function tandem_private.valid_username(p_username text)
returns boolean
language sql immutable
set search_path = ''
as $$
  select p_username is not null and p_username ~ '^[a-z][a-z0-9_]{2,23}$';
$$;

-- A project path: up to 255 characters, folders with "/", no empty, "." or
-- ".." parts, no backslashes or control characters, nothing hidden.
create or replace function tandem_private.valid_path(p_path text)
returns boolean
language sql immutable
set search_path = ''
as $$
  select p_path is not null
    and char_length(p_path) between 1 and 255
    and p_path !~ '[\\[:cntrl:]]'
    and p_path !~ '(^|/)\.'
    and p_path !~ '(^/|/$|//)';
$$;

-- ------------------------------------------------------------------ tables

create table if not exists public.cowork_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  username text not null unique check (tandem_private.valid_username(username)),
  created_at timestamptz not null default now()
);

create table if not exists public.cowork_projects (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 100),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  archived_by uuid references auth.users (id) on delete set null
);

create table if not exists public.cowork_members (
  project_id uuid not null references public.cowork_projects (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (project_id, user_id)
);
create index if not exists cowork_members_user on public.cowork_members (user_id);

create table if not exists public.cowork_invitations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.cowork_projects (id) on delete cascade,
  invitee_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'member')),
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (project_id, invitee_id)
);
create index if not exists cowork_invitations_invitee on public.cowork_invitations (invitee_id);

create table if not exists public.cowork_files (
  project_id uuid not null references public.cowork_projects (id) on delete cascade,
  path text not null check (tandem_private.valid_path(path)),
  content text not null default '' check (octet_length(content) <= 1048576),
  revision integer not null default 1 check (revision > 0),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (project_id, path)
);

-- ------------------------------------------------------------------ accounts

-- A new Auth user with a username in its metadata gets that username. The
-- address must be <username>@..., so one username is one account.
create or replace function tandem_private.claim_username()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  u text := lower(btrim(coalesce(new.raw_user_meta_data ->> 'username', '')));
begin
  if u = '' then
    return new; -- not a Tandem username account
  end if;
  if not tandem_private.valid_username(u) or split_part(lower(coalesce(new.email, '')), '@', 1) <> u then
    raise exception 'Choose a username of 3 to 24 letters, numbers or _, starting with a letter.' using errcode = 'PT400';
  end if;
  insert into public.cowork_profiles (user_id, username) values (new.id, u);
  return new;
end;
$$;

drop trigger if exists tandem_cowork_claim_username on auth.users;
create trigger tandem_cowork_claim_username
  after insert on auth.users
  for each row execute function tandem_private.claim_username();

-- Usernames for display (null for an account that has none).
create or replace function tandem_private.username_of(p_user uuid)
returns text
language sql stable security definer
set search_path = ''
as $$
  select username from public.cowork_profiles where user_id = p_user;
$$;

-- ------------------------------------------------------------------ access

-- The caller's role in a project: 'owner', 'member' or null.
create or replace function tandem_private.my_role(p_project uuid)
returns text
language sql stable security definer
set search_path = ''
as $$
  select m.role from public.cowork_members m
  where m.project_id = p_project and m.user_id = auth.uid();
$$;

alter table public.cowork_profiles enable row level security;
alter table public.cowork_projects enable row level security;
alter table public.cowork_members enable row level security;
alter table public.cowork_invitations enable row level security;
alter table public.cowork_files enable row level security;

revoke all on public.cowork_profiles, public.cowork_projects, public.cowork_members, public.cowork_invitations, public.cowork_files from anon, authenticated;
grant select on public.cowork_profiles, public.cowork_projects, public.cowork_members, public.cowork_invitations, public.cowork_files to authenticated;

-- Your own profile, and the people you share a project with.
drop policy if exists "people read their own and their teammates' profiles" on public.cowork_profiles;
create policy "people read their own and their teammates' profiles" on public.cowork_profiles
  for select to authenticated using (
    user_id = auth.uid()
    or exists (
      select 1 from public.cowork_members theirs
      where theirs.user_id = cowork_profiles.user_id and tandem_private.my_role(theirs.project_id) is not null
    )
  );

drop policy if exists "members read their projects" on public.cowork_projects;
create policy "members read their projects" on public.cowork_projects
  for select to authenticated using (tandem_private.my_role(id) is not null);

drop policy if exists "members read who is in their projects" on public.cowork_members;
create policy "members read who is in their projects" on public.cowork_members
  for select to authenticated using (tandem_private.my_role(project_id) is not null);

drop policy if exists "members and invitees read invitations" on public.cowork_invitations;
create policy "members and invitees read invitations" on public.cowork_invitations
  for select to authenticated using (tandem_private.my_role(project_id) is not null or invitee_id = auth.uid());

-- Files of an archived project can't be opened until an owner restores it.
drop policy if exists "members read files of open projects" on public.cowork_files;
create policy "members read files of open projects" on public.cowork_files
  for select to authenticated using (
    tandem_private.my_role(project_id) is not null
    and exists (select 1 from public.cowork_projects p where p.id = project_id and p.archived_at is null)
  );

-- The caller must have at least this role ('member' or 'owner'). Not being
-- in the project at all reads the same as the project not existing.
create or replace function tandem_private.require_role(p_project uuid, p_need text)
returns text
language plpgsql stable security definer
set search_path = ''
as $$
declare
  r text;
begin
  perform tandem_private.require_user();
  r := tandem_private.my_role(p_project);
  if r is null then
    raise exception 'This project isn''t available to you. It may have been removed, or you were removed from it.' using errcode = 'PT403';
  end if;
  if p_need = 'owner' and r <> 'owner' then
    raise exception 'Only owners can do this.' using errcode = 'PT403';
  end if;
  return r;
end;
$$;

-- Files can only change while the project isn't archived.
create or replace function tandem_private.require_open(p_project uuid)
returns void
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.cowork_projects where id = p_project and archived_at is not null) then
    raise exception 'This project is archived. An owner can restore it from Shared projects.' using errcode = 'PT409';
  end if;
end;
$$;

create or replace function tandem_private.touch(p_project uuid)
returns void
language sql security definer
set search_path = ''
as $$
  update public.cowork_projects set updated_at = now(), updated_by = auth.uid() where id = p_project;
$$;

create or replace function tandem_private.check_path(p_path text)
returns void
language plpgsql immutable
set search_path = ''
as $$
begin
  if not tandem_private.valid_path(p_path) then
    raise exception 'Use a file name inside the project, like notes.md or data/raw.csv (no "..", no leading dot or slash).' using errcode = 'PT400';
  end if;
end;
$$;

create or replace function tandem_private.check_size(p_content text)
returns void
language plpgsql immutable
set search_path = ''
as $$
begin
  if octet_length(coalesce(p_content, '')) > 1048576 then
    raise exception 'Files in shared projects can be up to 1 MB.' using errcode = 'PT400';
  end if;
end;
$$;

-- The people in a project, as the app shows them.
create or replace function tandem_private.members_json(p_project uuid)
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('user_id', m.user_id, 'username', pr.username, 'role', m.role) order by m.joined_at), '[]'::jsonb)
  from public.cowork_members m left join public.cowork_profiles pr on pr.user_id = m.user_id
  where m.project_id = p_project;
$$;

-- ------------------------------------------------------------------ reading

-- Shared projects for the signed-in user: who they are, their projects
-- (active and archived) and the invitations waiting for them.
create or replace function public.cowork_overview()
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  uid uuid := tandem_private.require_user();
begin
  return jsonb_build_object(
    'me', jsonb_build_object('id', uid, 'username', tandem_private.username_of(uid)),
    'projects', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'name', p.name, 'role', m.role,
        'updated_at', p.updated_at, 'updated_by', tandem_private.username_of(p.updated_by),
        'archived_at', p.archived_at, 'archived_by', tandem_private.username_of(p.archived_by),
        'members', tandem_private.members_json(p.id)
      ) order by p.updated_at desc)
      from public.cowork_projects p join public.cowork_members m on m.project_id = p.id and m.user_id = uid), '[]'::jsonb),
    'invitations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id, 'project_id', p.id, 'project_name', p.name, 'role', i.role,
        'invited_by', tandem_private.username_of(i.invited_by), 'created_at', i.created_at,
        'members', tandem_private.members_json(p.id)
      ) order by i.created_at desc)
      from public.cowork_invitations i join public.cowork_projects p on p.id = i.project_id
      where i.invitee_id = uid and p.archived_at is null
        and not exists (select 1 from public.cowork_members x where x.project_id = p.id and x.user_id = uid)), '[]'::jsonb)
  );
end;
$$;

-- One project, opened: who is in it, pending invitations and its files.
create or replace function public.cowork_project(p_project uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  r text := tandem_private.require_role(p_project, 'member');
  p public.cowork_projects;
begin
  select * into p from public.cowork_projects where id = p_project;
  if p.archived_at is not null then
    raise exception 'This project is archived. An owner can restore it from Shared projects.' using errcode = 'PT409';
  end if;
  return jsonb_build_object(
    'id', p.id, 'name', p.name, 'role', r, 'updated_at', p.updated_at, 'updated_by', tandem_private.username_of(p.updated_by),
    'members', tandem_private.members_json(p.id),
    'invitations', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'username', tandem_private.username_of(i.invitee_id), 'role', i.role,
                                     'invited_by', tandem_private.username_of(i.invited_by), 'created_at', i.created_at) order by i.created_at)
                from public.cowork_invitations i where i.project_id = p.id), '[]'::jsonb),
    'files', coalesce((select jsonb_agg(jsonb_build_object('path', f.path, 'content', f.content, 'revision', f.revision,
                                     'updated_at', f.updated_at, 'updated_by', tandem_private.username_of(f.updated_by)) order by f.path)
                from public.cowork_files f where f.project_id = p.id), '[]'::jsonb)
  );
end;
$$;

-- ------------------------------------------------------------------ projects

-- A new project starts empty; the creator is its owner.
create or replace function public.cowork_create_project(p_name text)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  uid uuid := tandem_private.require_user();
  n text := btrim(coalesce(p_name, ''));
  pid uuid;
begin
  if char_length(n) not between 1 and 100 then
    raise exception 'Give the project a name of up to 100 characters.' using errcode = 'PT400';
  end if;
  if (select count(*) from public.cowork_members where user_id = uid and role = 'owner') >= 50 then
    raise exception 'You own 50 projects. Archive or remove one first.' using errcode = 'PT409';
  end if;
  insert into public.cowork_projects (name, created_by, updated_by) values (n, uid, uid) returning id into pid;
  insert into public.cowork_members (project_id, user_id, role) values (pid, uid, 'owner');
  return jsonb_build_object('id', pid, 'name', n);
end;
$$;

create or replace function public.cowork_rename_project(p_project uuid, p_name text)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  n text := btrim(coalesce(p_name, ''));
begin
  perform tandem_private.require_role(p_project, 'owner');
  if char_length(n) not between 1 and 100 then
    raise exception 'Give the project a name of up to 100 characters.' using errcode = 'PT400';
  end if;
  update public.cowork_projects set name = n, updated_at = now(), updated_by = auth.uid() where id = p_project;
  return jsonb_build_object('id', p_project, 'name', n);
end;
$$;

create or replace function public.cowork_set_archived(p_project uuid, p_archived boolean)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
begin
  perform tandem_private.require_role(p_project, 'owner');
  update public.cowork_projects
     set archived_at = case when p_archived then now() end,
         archived_by = case when p_archived then auth.uid() end
   where id = p_project;
  return jsonb_build_object('id', p_project, 'archived', p_archived);
end;
$$;

-- ------------------------------------------------------------------ people

-- Finding people to invite: up to 8 accounts whose username starts with the
-- text (2+ characters). People find each other by username (shown in the
-- app as username@tandem.org) and invitations stay in the app.
create or replace function public.cowork_search_accounts(p_query text)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  uid uuid := tandem_private.require_user();
  q text := regexp_replace(lower(btrim(coalesce(p_query, ''))), '^@|@tandem\.org$', '', 'g');
begin
  if char_length(q) < 2 or q !~ '^[a-z0-9_]+$' then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('username', username) order by username)
    from (select username from public.cowork_profiles where left(username, char_length(q)) = q and user_id <> uid order by username limit 8) found
  ), '[]'::jsonb);
end;
$$;

-- Owners invite an existing Tandem account by its username.
create or replace function public.cowork_invite(p_project uuid, p_username text, p_role text)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  u text := lower(btrim(coalesce(p_username, '')));
  invitee uuid;
  inv public.cowork_invitations;
begin
  perform tandem_private.require_role(p_project, 'owner');
  perform tandem_private.require_open(p_project);
  u := regexp_replace(u, '^@|@tandem\.org$', '', 'g');
  if not tandem_private.valid_username(u) then
    raise exception 'Enter a username, like priya or tom_2.' using errcode = 'PT400';
  end if;
  if p_role not in ('owner', 'member') then
    raise exception 'Choose Owner or Member.' using errcode = 'PT400';
  end if;
  select user_id into invitee from public.cowork_profiles where username = u;
  if invitee is null then
    raise exception 'There''s no Tandem account called %. Ask them to create one first.', u using errcode = 'PT404';
  end if;
  if exists (select 1 from public.cowork_members where project_id = p_project and user_id = invitee) then
    raise exception '% is already in this project.', u using errcode = 'PT409';
  end if;
  if exists (select 1 from public.cowork_invitations where project_id = p_project and invitee_id = invitee) then
    raise exception '% is already invited.', u using errcode = 'PT409';
  end if;
  if (select count(*) from public.cowork_invitations where project_id = p_project) >= 50 then
    raise exception 'This project has 50 pending invitations. Cancel some first.' using errcode = 'PT409';
  end if;
  insert into public.cowork_invitations (project_id, invitee_id, role, invited_by)
  values (p_project, invitee, p_role, auth.uid()) returning * into inv;
  return jsonb_build_object('id', inv.id, 'username', u, 'role', inv.role, 'created_at', inv.created_at);
end;
$$;

create or replace function public.cowork_cancel_invitation(p_invitation uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  pid uuid;
begin
  select project_id into pid from public.cowork_invitations where id = p_invitation;
  if pid is null then
    raise exception 'That invitation no longer exists.' using errcode = 'PT404';
  end if;
  perform tandem_private.require_role(pid, 'owner');
  delete from public.cowork_invitations where id = p_invitation;
  return jsonb_build_object('id', p_invitation);
end;
$$;

-- Only the invited account can join or decline.
create or replace function public.cowork_accept_invitation(p_invitation uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  uid uuid := tandem_private.require_user();
  inv public.cowork_invitations;
begin
  select * into inv from public.cowork_invitations where id = p_invitation and invitee_id = uid;
  if inv.id is null then
    raise exception 'That invitation is no longer open.' using errcode = 'PT404';
  end if;
  perform tandem_private.require_open(inv.project_id);
  insert into public.cowork_members (project_id, user_id, role)
  values (inv.project_id, uid, inv.role)
  on conflict (project_id, user_id) do nothing;
  delete from public.cowork_invitations where id = inv.id;
  return jsonb_build_object('project_id', inv.project_id, 'role', inv.role);
end;
$$;

create or replace function public.cowork_decline_invitation(p_invitation uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  uid uuid := tandem_private.require_user();
begin
  delete from public.cowork_invitations where id = p_invitation and invitee_id = uid;
  if not found then
    raise exception 'That invitation is no longer open.' using errcode = 'PT404';
  end if;
  return jsonb_build_object('id', p_invitation);
end;
$$;

-- A project always keeps at least one owner.
create or replace function tandem_private.keep_an_owner(p_project uuid, p_leaving uuid)
returns void
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.cowork_members where project_id = p_project and role = 'owner' and user_id <> p_leaving) then
    raise exception 'A project needs an owner. Make someone else an owner first.' using errcode = 'PT409';
  end if;
end;
$$;

create or replace function public.cowork_set_role(p_project uuid, p_user uuid, p_role text)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
begin
  perform tandem_private.require_role(p_project, 'owner');
  if p_role not in ('owner', 'member') then
    raise exception 'Choose Owner or Member.' using errcode = 'PT400';
  end if;
  if not exists (select 1 from public.cowork_members where project_id = p_project and user_id = p_user) then
    raise exception 'That person isn''t in this project.' using errcode = 'PT404';
  end if;
  if p_role = 'member' then
    perform tandem_private.keep_an_owner(p_project, p_user);
  end if;
  update public.cowork_members set role = p_role where project_id = p_project and user_id = p_user;
  return jsonb_build_object('user_id', p_user, 'role', p_role);
end;
$$;

-- Owners remove people; anyone can leave (remove themselves).
create or replace function public.cowork_remove_member(p_project uuid, p_user uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  uid uuid := tandem_private.require_user();
begin
  perform tandem_private.require_role(p_project, case when p_user = uid then 'member' else 'owner' end);
  if not exists (select 1 from public.cowork_members where project_id = p_project and user_id = p_user) then
    raise exception 'That person isn''t in this project.' using errcode = 'PT404';
  end if;
  perform tandem_private.keep_an_owner(p_project, p_user);
  delete from public.cowork_members where project_id = p_project and user_id = p_user;
  return jsonb_build_object('user_id', p_user);
end;
$$;

-- ------------------------------------------------------------------ files

create or replace function public.cowork_create_file(p_project uuid, p_path text, p_content text)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  f public.cowork_files;
begin
  perform tandem_private.require_role(p_project, 'member');
  perform tandem_private.require_open(p_project);
  perform tandem_private.check_path(p_path);
  perform tandem_private.check_size(p_content);
  if (select count(*) from public.cowork_files where project_id = p_project) >= 500 then
    raise exception 'A shared project can hold 500 files.' using errcode = 'PT409';
  end if;
  insert into public.cowork_files (project_id, path, content, updated_by)
  values (p_project, p_path, coalesce(p_content, ''), auth.uid())
  on conflict (project_id, path) do nothing
  returning * into f;
  if f.path is null then
    raise exception '% already exists.', p_path using errcode = 'PT409';
  end if;
  perform tandem_private.touch(p_project);
  return jsonb_build_object('path', f.path, 'revision', f.revision, 'updated_at', f.updated_at);
end;
$$;

-- Saves only over the revision the editor started from; otherwise someone
-- else saved first and nothing is overwritten.
create or replace function public.cowork_save_file(p_project uuid, p_path text, p_content text, p_revision integer)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  f public.cowork_files;
  current_rev integer;
begin
  perform tandem_private.require_role(p_project, 'member');
  perform tandem_private.require_open(p_project);
  perform tandem_private.check_size(p_content);
  update public.cowork_files
     set content = coalesce(p_content, ''), revision = revision + 1, updated_at = now(), updated_by = auth.uid()
   where project_id = p_project and path = p_path and revision = p_revision
  returning * into f;
  if f.path is null then
    select revision into current_rev from public.cowork_files where project_id = p_project and path = p_path;
    if current_rev is null then
      raise exception '% was renamed or removed by someone else.', p_path using errcode = 'PT404';
    end if;
    raise exception 'Someone else saved % first (revision %). Your edit wasn''t saved.', p_path, current_rev using errcode = 'PT409';
  end if;
  perform tandem_private.touch(p_project);
  return jsonb_build_object('path', f.path, 'revision', f.revision, 'updated_at', f.updated_at);
end;
$$;

create or replace function public.cowork_rename_file(p_project uuid, p_from text, p_to text)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  f public.cowork_files;
begin
  perform tandem_private.require_role(p_project, 'member');
  perform tandem_private.require_open(p_project);
  perform tandem_private.check_path(p_to);
  if exists (select 1 from public.cowork_files where project_id = p_project and path = p_to) then
    raise exception '% already exists.', p_to using errcode = 'PT409';
  end if;
  update public.cowork_files
     set path = p_to, revision = revision + 1, updated_at = now(), updated_by = auth.uid()
   where project_id = p_project and path = p_from
  returning * into f;
  if f.path is null then
    raise exception '% was renamed or removed by someone else.', p_from using errcode = 'PT404';
  end if;
  perform tandem_private.touch(p_project);
  return jsonb_build_object('path', f.path, 'revision', f.revision, 'updated_at', f.updated_at);
end;
$$;

create or replace function public.cowork_remove_file(p_project uuid, p_path text)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
begin
  perform tandem_private.require_role(p_project, 'owner');
  perform tandem_private.require_open(p_project);
  delete from public.cowork_files where project_id = p_project and path = p_path;
  if not found then
    raise exception '% was renamed or removed by someone else.', p_path using errcode = 'PT404';
  end if;
  perform tandem_private.touch(p_project);
  return jsonb_build_object('path', p_path);
end;
$$;

-- ------------------------------------------------------------------ grants

revoke all on all functions in schema tandem_private from public, anon;
grant execute on all functions in schema tandem_private to authenticated;

revoke all on function
  public.cowork_overview(), public.cowork_project(uuid), public.cowork_create_project(text),
  public.cowork_rename_project(uuid, text), public.cowork_set_archived(uuid, boolean),
  public.cowork_invite(uuid, text, text), public.cowork_cancel_invitation(uuid), public.cowork_search_accounts(text),
  public.cowork_accept_invitation(uuid), public.cowork_decline_invitation(uuid),
  public.cowork_set_role(uuid, uuid, text), public.cowork_remove_member(uuid, uuid),
  public.cowork_create_file(uuid, text, text), public.cowork_save_file(uuid, text, text, integer),
  public.cowork_rename_file(uuid, text, text), public.cowork_remove_file(uuid, text)
from public, anon;

grant execute on function
  public.cowork_overview(), public.cowork_project(uuid), public.cowork_create_project(text),
  public.cowork_rename_project(uuid, text), public.cowork_set_archived(uuid, boolean),
  public.cowork_invite(uuid, text, text), public.cowork_cancel_invitation(uuid), public.cowork_search_accounts(text),
  public.cowork_accept_invitation(uuid), public.cowork_decline_invitation(uuid),
  public.cowork_set_role(uuid, uuid, text), public.cowork_remove_member(uuid, uuid),
  public.cowork_create_file(uuid, text, text), public.cowork_save_file(uuid, text, text, integer),
  public.cowork_rename_file(uuid, text, text), public.cowork_remove_file(uuid, text)
to authenticated;

commit;
