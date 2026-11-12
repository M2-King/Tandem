-- For local tests only: the parts of Supabase's auth schema and roles that
-- the Cowork migration relies on. A real Supabase project already has these.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
create schema auth;
create table auth.users (id uuid primary key, email text unique, raw_user_meta_data jsonb default '{}'::jsonb, created_at timestamptz default now());
-- As in Supabase: the caller's claims come from the request's JWT.
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

-- Supabase Realtime's authorization table, as far as the Cowork policies
-- (002_cowork_realtime.sql) use it: Realtime checks a channel join by running
-- the policies on realtime.messages with realtime.topic() set to the channel.
create schema if not exists realtime;
create table if not exists realtime.messages (
  id uuid primary key default gen_random_uuid(),
  topic text not null,
  extension text not null,
  payload jsonb,
  event text,
  private boolean default false,
  inserted_at timestamp default now(),
  updated_at timestamp default now()
);
alter table realtime.messages enable row level security;
create or replace function realtime.topic() returns text language sql stable as $$
  select nullif(current_setting('realtime.topic', true), '')::text
$$;
grant usage on schema realtime to anon, authenticated;
grant select, insert, update on realtime.messages to anon, authenticated;
grant execute on function realtime.topic() to anon, authenticated;
