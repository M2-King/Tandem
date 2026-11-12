-- Tandem Cowork: live typing (letters appear as a teammate types).
--
-- Additive: run once in the SQL Editor on a project that already has the
-- Cowork tables (001_tandem_cowork.sql, or the upgrade applied to staging)
-- and 002_cowork_realtime.sql. It adds one table, two functions and one
-- trigger; it doesn't change any existing table, function or policy, and is
-- safe to run again.
--
-- Each shared text file is edited through a Yjs document (a CRDT). Edits
-- travel between the people in the project over the project's private
-- Realtime channel (002); this keeps the document itself with the file, so
-- someone opening the project later starts from the same document instead
-- of from plain text (two documents started separately from the same text
-- would merge into doubled text).
--
--   cowork_save_file_doc(project, path, content, revision, doc)
--       Saves the text exactly as cowork_save_file does (it calls it: the
--       same checks, revision, "edited by" and history), and in the same
--       transaction keeps the document that produced that text.
--   cowork_file_docs(project)
--       The saved documents of a project's files, for its members:
--       [{ path, revision, doc (base64) }]. A document whose revision is
--       older than its file's (saved by an older build) is brought up to
--       date by the app.
--
-- Relies only on what the deployed staging schema has (checked):
--   public.cowork_files (project_id uuid, path text, content text, revision integer)
--   public.cowork_members (project_id uuid, user_id uuid)
--   public.cowork_projects (id uuid)
--   public.cowork_save_file(uuid, text, text, integer) returning jsonb { path, revision, updated_at }

create table if not exists public.cowork_file_docs (
  project_id uuid not null references public.cowork_projects (id) on delete cascade,
  path text not null,
  revision integer not null,
  doc bytea not null,
  updated_at timestamptz not null default now(),
  primary key (project_id, path)
);

-- Only the functions below read or write it.
alter table public.cowork_file_docs enable row level security;
revoke all on table public.cowork_file_docs from public, anon, authenticated;

-- Saving: the text through cowork_save_file, then the document with the
-- revision that save gave. Either both are saved or neither.
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
  if octet_length(d) > 4 * 1024 * 1024 then
    raise exception 'This file''s live copy is too large to save (over 4 MB).' using errcode = 'PT400';
  end if;

  saved := public.cowork_save_file(p_project, p_path, p_content, p_revision);

  insert into public.cowork_file_docs (project_id, path, revision, doc, updated_at)
  values (p_project, saved ->> 'path', (saved ->> 'revision')::integer, d, now())
  on conflict (project_id, path) do update
    set revision = excluded.revision, doc = excluded.doc, updated_at = excluded.updated_at;
  return saved;
end;
$$;

revoke all on function public.cowork_save_file_doc(uuid, text, text, integer, text) from public, anon;
grant execute on function public.cowork_save_file_doc(uuid, text, text, integer, text) to authenticated;

-- Reading: members only, and only documents of files that still exist.
create or replace function public.cowork_file_docs(p_project uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null
     or not exists (select 1 from public.cowork_members m where m.project_id = p_project and m.user_id = auth.uid()) then
    raise exception 'This project isn''t available to you. It may have been removed, or you were removed from it.' using errcode = 'PT403';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('path', d.path, 'revision', d.revision, 'doc', replace(encode(d.doc, 'base64'), E'\n', '')))
      from public.cowork_file_docs d
      join public.cowork_files f on f.project_id = d.project_id and f.path = d.path
     where d.project_id = p_project
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.cowork_file_docs(uuid) from public, anon;
grant execute on function public.cowork_file_docs(uuid) to authenticated;

-- A document follows its file: renamed with it, removed with it. (In a
-- schema of its own, not exposed through the API.)
create schema if not exists cowork_live;
revoke all on schema cowork_live from public;

create or replace function cowork_live.file_docs_follow()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    delete from public.cowork_file_docs where project_id = old.project_id and path = old.path;
    return old;
  end if;
  if new.path is distinct from old.path then
    delete from public.cowork_file_docs where project_id = new.project_id and path = new.path;
    update public.cowork_file_docs set path = new.path where project_id = old.project_id and path = old.path;
  end if;
  return new;
end;
$$;

revoke all on function cowork_live.file_docs_follow() from public, anon, authenticated;

drop trigger if exists cowork_file_docs_follow on public.cowork_files;
create trigger cowork_file_docs_follow
  after update of path or delete on public.cowork_files
  for each row execute function cowork_live.file_docs_follow();
