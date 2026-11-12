-- Tandem Cowork: who's online and live cursors (Supabase Realtime).
--
-- Additive: run once in the SQL Editor on a project that already has the
-- Cowork tables (001_tandem_cowork.sql, or the upgrade applied to staging).
-- It doesn't change any table or function from 001 and is safe to run again.
--
-- Each shared project has one PRIVATE Realtime channel, cowork:<project id>,
-- for presence (who is in the project, which file, where the cursor is) and
-- broadcast (cursor moves). Realtime Authorization checks the policies below
-- on realtime.messages when someone joins: only members of a project that
-- isn't archived may read (receive) or write (send presence and broadcasts)
-- on its channel. Nothing is stored: presence and broadcast aren't saved.
--
-- Relies only on what the deployed staging schema has (checked):
--   public.cowork_members (project_id uuid, user_id uuid)
--   public.cowork_projects (id uuid, archived_at timestamptz)
-- and on Supabase's realtime.messages and realtime.topic().
--
-- Then in the dashboard: Realtime → Settings → turn off "Allow public
-- access" (private channels only). See docs/cowork-backend.md.

-- A schema of its own, not exposed through the API, with one function.
create schema if not exists cowork_realtime;
revoke all on schema cowork_realtime from public;
grant usage on schema cowork_realtime to authenticated;

-- Is the signed-in user a member of the project this channel is for?
-- topic: 'cowork:<project id>'. Anything else (another app's channel, a
-- malformed id, an archived project, no session) is false.
create or replace function cowork_realtime.is_member(p_topic text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  pid uuid;
begin
  if p_topic is null
     or p_topic !~ '^cowork:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or auth.uid() is null then
    return false;
  end if;
  pid := substr(p_topic, 8)::uuid;
  return exists (
    select 1
      from public.cowork_members m
      join public.cowork_projects p on p.id = m.project_id
     where m.project_id = pid
       and m.user_id = auth.uid()
       and p.archived_at is null
  );
end;
$$;

revoke all on function cowork_realtime.is_member(text) from public, anon;
grant execute on function cowork_realtime.is_member(text) to authenticated;

-- Receiving presence and broadcasts on cowork:<id>: members only.
drop policy if exists "cowork members receive" on realtime.messages;
create policy "cowork members receive"
  on realtime.messages
  for select
  to authenticated
  using (
    realtime.messages.extension in ('broadcast', 'presence')
    and cowork_realtime.is_member((select realtime.topic()))
  );

-- Sending presence (track) and broadcasts (cursor moves): members only.
drop policy if exists "cowork members send" on realtime.messages;
create policy "cowork members send"
  on realtime.messages
  for insert
  to authenticated
  with check (
    realtime.messages.extension in ('broadcast', 'presence')
    and cowork_realtime.is_member((select realtime.topic()))
  );
