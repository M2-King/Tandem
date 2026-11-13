-- Tandem Cowork: backups and restore (Versions), larger files, lighter reloads.
--
-- Additive: run once in the SQL Editor after 001-004. Safe to run again.
--
-- Versions
--   A version is the project's files as saved at one moment: a list of
--   { path, hash, size } in cowork_versions, the texts in cowork_version_blobs.
--   Each different text is kept once per project, so a backup costs only the
--   files that changed since an earlier one. Members back up any time (with a
--   name or not); the app also backs up by itself every 30 minutes while the
--   project changes (the newest 30 automatic ones are kept; named ones stay
--   until deleted). Restoring backs up the current files first, so a restore
--   can be undone.
--
--   cowork_create_version(project, name, note)  Members: back up now (a name and a
--       description, both optional).
--   cowork_auto_version(project)                Members: an automatic backup,
--       only if something changed and the last backup is 25+ minutes old.
--   cowork_versions(project)                    Members: the backups, newest first,
--       { versions: [{ id, name, note, auto, reason, created_by, created_at,
--         file_count, total_size, files: [{ path, size, hash }] }], storage }.
--   cowork_version_file(project, version, path) Members: one file's text in a backup.
--   cowork_restore_version(project, version, path)
--       path given: that file (members); null: the whole project (owners):
--       files back as they were, files added since removed. Restored files are
--       saved as new revisions, so everyone's app takes them as teammates'
--       saves. { restored: [...], removed: [...], backup: <version id> }.
--   cowork_name_version(project, version, name, note)  Members: name or describe
--       a backup (a named one is kept).
--   cowork_delete_version(project, version)     Owners, or whoever made it.
--
-- Larger files: shared text files up to 10 MB (was 1 MB); a file's live copy
-- up to 40 MB (was 4 MB).
--
-- Lighter reloads: an open project checks every 10 seconds what changed.
--   cowork_project_state(project)          as cowork_project, files without their text
--   cowork_file_contents(project, paths)   the text of the files that changed

begin;

-- ------------------------------------------------------------------ larger files

-- The table's own 1 MB rule (named by Postgres, so found by what it checks).
do $$
declare
  c record;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'public.cowork_files'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%octet_length(content)%'
  loop
    execute format('alter table public.cowork_files drop constraint %I', c.conname);
  end loop;
end;
$$;
alter table public.cowork_files add constraint cowork_files_content_size check (octet_length(content) <= 10485760);

create or replace function tandem_private.check_size(p_content text)
returns void
language plpgsql immutable
set search_path = ''
as $$
begin
  if octet_length(coalesce(p_content, '')) > 10485760 then
    raise exception 'Files in shared projects can be up to 10 MB.' using errcode = 'PT400';
  end if;
end;
$$;

create or replace function public.cowork_save_file_doc(p_project uuid, p_path text, p_content text, p_revision integer, p_doc text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved jsonb;
  d bytea;
begin
  begin
    d := decode(coalesce(p_doc, ''), 'base64');
  exception when others then
    raise exception 'The live copy of this file couldn''t be read. Try again.' using errcode = 'PT400';
  end;
  if octet_length(d) = 0 then
    raise exception 'The live copy of this file is empty. Try again.' using errcode = 'PT400';
  end if;
  if octet_length(d) > 40 * 1024 * 1024 then
    raise exception 'This file''s live copy is too large to save (over 40 MB).' using errcode = 'PT400';
  end if;

  saved := public.cowork_save_file(p_project, p_path, p_content, p_revision);

  insert into public.cowork_file_docs (project_id, path, revision, doc, updated_at)
  values (p_project, saved ->> 'path', (saved ->> 'revision')::integer, d, now())
  on conflict (project_id, path) do update
    set revision = excluded.revision, doc = excluded.doc, updated_at = excluded.updated_at;
  return saved;
end;
$$;

-- ------------------------------------------------------------------ lighter reloads

create or replace function public.cowork_project_state(p_project uuid)
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
    'files', coalesce((select jsonb_agg(jsonb_build_object('path', f.path, 'revision', f.revision, 'size', octet_length(f.content),
                                     'updated_at', f.updated_at, 'updated_by', tandem_private.username_of(f.updated_by)) order by f.path)
                from public.cowork_files f where f.project_id = p.id), '[]'::jsonb)
  );
end;
$$;

create or replace function public.cowork_file_contents(p_project uuid, p_paths text[])
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform tandem_private.require_role(p_project, 'member');
  return coalesce((select jsonb_agg(jsonb_build_object('path', f.path, 'content', f.content, 'revision', f.revision,
                                     'updated_at', f.updated_at, 'updated_by', tandem_private.username_of(f.updated_by)) order by f.path)
                     from public.cowork_files f where f.project_id = p_project and f.path = any (coalesce(p_paths, '{}'))), '[]'::jsonb);
end;
$$;

-- ------------------------------------------------------------------ versions

create table if not exists public.cowork_version_blobs (
  project_id uuid not null references public.cowork_projects (id) on delete cascade,
  hash text not null,
  content text not null,
  size integer not null,
  primary key (project_id, hash)
);

create table if not exists public.cowork_versions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.cowork_projects (id) on delete cascade,
  name text check (name is null or char_length(name) between 1 and 80),
  auto boolean not null default false,
  reason text, -- 'auto' | 'before-restore' | null (backed up by someone)
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default clock_timestamp(),
  files jsonb not null,      -- [{ path, hash, size }]
  manifest text not null,    -- the files' paths and texts in one hash: identical backups are skipped
  file_count integer not null,
  total_size bigint not null
);
create index if not exists cowork_versions_project on public.cowork_versions (project_id, created_at desc);
alter table public.cowork_versions add column if not exists note text check (note is null or char_length(note) <= 500);

-- (An earlier version of this file had no descriptions.)
drop function if exists tandem_private.versions_take(uuid, text, boolean, text);
drop function if exists public.cowork_create_version(uuid, text);
drop function if exists public.cowork_name_version(uuid, uuid, text);

-- Only the functions below read or write them.
alter table public.cowork_version_blobs enable row level security;
alter table public.cowork_versions enable row level security;
revoke all on table public.cowork_version_blobs, public.cowork_versions from public, anon, authenticated;

-- Backups of one project may hold this many bytes of text (each text once).
create or replace function tandem_private.versions_budget()
returns bigint language sql immutable set search_path = '' as $$ select 200::bigint * 1024 * 1024 $$;

-- Texts no backup refers to any more.
create or replace function tandem_private.versions_tidy(p_project uuid)
returns void
language sql security definer
set search_path = ''
as $$
  delete from public.cowork_version_blobs b
   where b.project_id = p_project
     and not exists (
       select 1 from public.cowork_versions v, jsonb_array_elements(v.files) e
        where v.project_id = p_project and e ->> 'hash' = b.hash
     );
$$;

-- Back up the project's files as saved now. Automatic backups (p_auto) are
-- skipped when nothing changed since the last backup; only the newest 30 are kept.
create or replace function tandem_private.versions_take(p_project uuid, p_name text, p_note text, p_auto boolean, p_reason text)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  files jsonb;
  m text;
  latest public.cowork_versions;
  v public.cowork_versions;
  used bigint;
begin
  select coalesce(jsonb_agg(jsonb_build_object('path', f.path, 'hash', md5(f.content), 'size', octet_length(f.content)) order by f.path), '[]'::jsonb),
         md5(coalesce(string_agg(f.path || ':' || md5(f.content), E'\n' order by f.path), ''))
    into files, m
    from public.cowork_files f where f.project_id = p_project;
  select * into latest from public.cowork_versions where project_id = p_project order by created_at desc limit 1;
  if p_auto and latest.id is not null and latest.manifest = m then
    return null; -- the newest backup already has exactly these files
  end if;
  if not p_auto and (select count(*) from public.cowork_versions where project_id = p_project and not auto) >= 200 then
    raise exception 'This project has 200 named backups. Delete some old ones first.' using errcode = 'PT409';
  end if;

  insert into public.cowork_version_blobs (project_id, hash, content, size)
  select distinct on (md5(f.content)) p_project, md5(f.content), f.content, octet_length(f.content)
    from public.cowork_files f where f.project_id = p_project
  on conflict (project_id, hash) do nothing;

  insert into public.cowork_versions (project_id, name, note, auto, reason, created_by, files, manifest, file_count, total_size)
  values (p_project, nullif(btrim(coalesce(p_name, '')), ''), nullif(btrim(coalesce(p_note, '')), ''), p_auto, p_reason, auth.uid(), files, m,
          jsonb_array_length(files), coalesce((select sum((e ->> 'size')::bigint) from jsonb_array_elements(files) e), 0))
  returning * into v;

  -- Automatic backups: the newest 30.
  delete from public.cowork_versions
   where project_id = p_project and auto
     and id not in (select id from public.cowork_versions where project_id = p_project and auto order by created_at desc limit 30);
  perform tandem_private.versions_tidy(p_project);

  select coalesce(sum(size), 0) into used from public.cowork_version_blobs where project_id = p_project;
  if used > tandem_private.versions_budget() then
    raise exception 'Backups of this project would use more than 200 MB. Delete some old backups first.' using errcode = 'PT409';
  end if;
  return jsonb_build_object('id', v.id, 'name', v.name, 'note', v.note, 'auto', v.auto, 'reason', v.reason, 'created_at', v.created_at,
                            'file_count', v.file_count, 'total_size', v.total_size);
end;
$$;

create or replace function public.cowork_create_version(p_project uuid, p_name text, p_note text default null)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
begin
  perform tandem_private.require_role(p_project, 'member');
  perform tandem_private.require_open(p_project);
  if char_length(btrim(coalesce(p_name, ''))) > 80 then
    raise exception 'Keep the name under 80 characters.' using errcode = 'PT400';
  end if;
  if char_length(btrim(coalesce(p_note, ''))) > 500 then
    raise exception 'Keep the description under 500 characters.' using errcode = 'PT400';
  end if;
  return tandem_private.versions_take(p_project, p_name, p_note, false, null);
end;
$$;

create or replace function public.cowork_auto_version(p_project uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
begin
  perform tandem_private.require_role(p_project, 'member');
  perform tandem_private.require_open(p_project);
  -- One automatic backup per 25 minutes, whoever's app asks.
  perform pg_advisory_xact_lock(hashtext('cowork-auto-version:' || p_project::text));
  if exists (select 1 from public.cowork_versions where project_id = p_project and created_at > now() - interval '25 minutes') then
    return null;
  end if;
  return tandem_private.versions_take(p_project, null, null, true, 'auto');
end;
$$;

create or replace function public.cowork_versions(p_project uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform tandem_private.require_role(p_project, 'member');
  return jsonb_build_object(
    'versions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', v.id, 'name', v.name, 'note', v.note, 'auto', v.auto, 'reason', v.reason,
               'created_by', tandem_private.username_of(v.created_by), 'created_at', v.created_at,
               'file_count', v.file_count, 'total_size', v.total_size, 'files', v.files) order by v.created_at desc)
        from public.cowork_versions v where v.project_id = p_project), '[]'::jsonb),
    'storage', (select coalesce(sum(size), 0) from public.cowork_version_blobs where project_id = p_project),
    'budget', tandem_private.versions_budget()
  );
end;
$$;

create or replace function public.cowork_version_file(p_project uuid, p_version uuid, p_path text)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  h text;
  body text;
begin
  perform tandem_private.require_role(p_project, 'member');
  select e ->> 'hash' into h
    from public.cowork_versions v, jsonb_array_elements(v.files) e
   where v.id = p_version and v.project_id = p_project and e ->> 'path' = p_path;
  if h is null then
    raise exception '% isn''t in that backup.', p_path using errcode = 'PT404';
  end if;
  select content into body from public.cowork_version_blobs where project_id = p_project and hash = h;
  return jsonb_build_object('path', p_path, 'content', body, 'size', octet_length(body));
end;
$$;

create or replace function public.cowork_restore_version(p_project uuid, p_version uuid, p_path text default null)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v public.cowork_versions;
  before jsonb;
  e jsonb;
  body text;
  restored text[] := '{}';
  removed text[] := '{}';
  f public.cowork_files;
begin
  perform tandem_private.require_role(p_project, case when p_path is null then 'owner' else 'member' end);
  perform tandem_private.require_open(p_project);
  select * into v from public.cowork_versions where id = p_version and project_id = p_project;
  if v.id is null then
    raise exception 'That backup was deleted.' using errcode = 'PT404';
  end if;
  if p_path is not null and not exists (select 1 from jsonb_array_elements(v.files) x where x ->> 'path' = p_path) then
    raise exception '% isn''t in that backup.', p_path using errcode = 'PT404';
  end if;
  -- What is here now, kept first (so this restore can be undone).
  before := tandem_private.versions_take(p_project, null, null, true, 'before-restore');

  for e in select x from jsonb_array_elements(v.files) x where p_path is null or x ->> 'path' = p_path loop
    select content into body from public.cowork_version_blobs where project_id = p_project and hash = e ->> 'hash';
    select * into f from public.cowork_files where project_id = p_project and path = e ->> 'path';
    if f.path is null then
      insert into public.cowork_files (project_id, path, content, revision, updated_at, updated_by)
      values (p_project, e ->> 'path', body, 1, now(), auth.uid());
      restored := restored || (e ->> 'path');
    elsif f.content is distinct from body then
      update public.cowork_files set content = body, revision = revision + 1, updated_at = now(), updated_by = auth.uid()
       where project_id = p_project and path = f.path;
      -- Its live copy described the text before: everyone's app starts again from the restored text.
      delete from public.cowork_file_docs where project_id = p_project and path = f.path;
      restored := restored || f.path;
    end if;
    f := null;
  end loop;

  if p_path is null then
    select coalesce(array_agg(path order by path), '{}') into removed
      from public.cowork_files
     where project_id = p_project
       and path not in (select x ->> 'path' from jsonb_array_elements(v.files) x);
    delete from public.cowork_files where project_id = p_project and path = any (removed);
  end if;

  if cardinality(restored) > 0 or cardinality(removed) > 0 then
    perform tandem_private.touch(p_project);
  end if;
  return jsonb_build_object('restored', to_jsonb(restored), 'removed', to_jsonb(removed), 'backup', before ->> 'id');
end;
$$;

create or replace function public.cowork_name_version(p_project uuid, p_version uuid, p_name text, p_note text default null)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  n text := nullif(btrim(coalesce(p_name, '')), '');
  d text := nullif(btrim(coalesce(p_note, '')), '');
begin
  perform tandem_private.require_role(p_project, 'member');
  if n is null or char_length(n) > 80 then
    raise exception 'Give the backup a name of up to 80 characters.' using errcode = 'PT400';
  end if;
  if char_length(coalesce(d, '')) > 500 then
    raise exception 'Keep the description under 500 characters.' using errcode = 'PT400';
  end if;
  -- A named backup is kept (it no longer counts among the automatic ones).
  update public.cowork_versions set name = n, note = d, auto = false where id = p_version and project_id = p_project;
  if not found then
    raise exception 'That backup was deleted.' using errcode = 'PT404';
  end if;
  return jsonb_build_object('id', p_version, 'name', n, 'note', d);
end;
$$;

create or replace function public.cowork_delete_version(p_project uuid, p_version uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  r text := tandem_private.require_role(p_project, 'member');
  v public.cowork_versions;
begin
  select * into v from public.cowork_versions where id = p_version and project_id = p_project;
  if v.id is null then
    return null;
  end if;
  if r <> 'owner' and v.created_by is distinct from auth.uid() then
    raise exception 'Only owners, or whoever made it, can delete a backup.' using errcode = 'PT403';
  end if;
  delete from public.cowork_versions where id = p_version;
  perform tandem_private.versions_tidy(p_project);
  return null;
end;
$$;

-- ------------------------------------------------------------------ grants

revoke all on function tandem_private.versions_budget(), tandem_private.versions_tidy(uuid),
  tandem_private.versions_take(uuid, text, text, boolean, text) from public, anon;
grant execute on function tandem_private.versions_budget(), tandem_private.versions_tidy(uuid),
  tandem_private.versions_take(uuid, text, text, boolean, text) to authenticated;

revoke all on function
  public.cowork_project_state(uuid), public.cowork_file_contents(uuid, text[]),
  public.cowork_create_version(uuid, text, text), public.cowork_auto_version(uuid), public.cowork_versions(uuid),
  public.cowork_version_file(uuid, uuid, text), public.cowork_restore_version(uuid, uuid, text),
  public.cowork_name_version(uuid, uuid, text, text), public.cowork_delete_version(uuid, uuid)
from public, anon;
grant execute on function
  public.cowork_project_state(uuid), public.cowork_file_contents(uuid, text[]),
  public.cowork_create_version(uuid, text, text), public.cowork_auto_version(uuid), public.cowork_versions(uuid),
  public.cowork_version_file(uuid, uuid, text), public.cowork_restore_version(uuid, uuid, text),
  public.cowork_name_version(uuid, uuid, text, text), public.cowork_delete_version(uuid, uuid)
to authenticated;

commit;
