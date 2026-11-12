-- Tandem Cowork: an owner shares their AI with a project.
--
-- Additive: run once in the SQL Editor after 001-003. It adds two tables and
-- five functions; nothing existing changes. Safe to run again.
--
-- An owner gives the project an AI provider, model and API key. Members whose
-- own device has no AI connected use it through the cowork-ai Edge Function
-- (supabase/functions/cowork-ai), which adds the key on the server: the key
-- never reaches anyone's device, not even the owner's again, and members
-- can't read it. Each member has a daily number of requests (set by the
-- owner); the person who shared it has no limit.
--
--   cowork_set_ai_share(project, provider, model, base_url, api_key, daily_limit)
--       Owners: share or change. An empty api_key keeps the key already saved.
--   cowork_stop_ai_share(project)          Owners: stop sharing (the key is deleted).
--   cowork_ai_share(project)               Members: what is shared, without the key:
--       { provider, model, shared_by, shared_by_me, daily_limit, used_today,
--         key_hint (owners only: last 4 characters), base_url (owners only) } or null.
--   cowork_ai_use(project, user)           The Edge Function only (service role):
--       checks the person may use it now, counts the request and returns the
--       key. Refuses with PT403 (not in the project), PT404 (nothing shared),
--       PT409 (archived), PT429 (today's requests used up).
--   cowork_ai_refund(project, user)        The Edge Function only: a request the
--       provider failed doesn't count.

begin;

create table if not exists public.cowork_ai_shares (
  project_id uuid primary key references public.cowork_projects (id) on delete cascade,
  provider text not null check (provider in ('anthropic', 'openai')),
  model text not null check (char_length(model) between 1 and 120),
  base_url text not null check (char_length(base_url) between 8 and 300),
  api_key text not null check (char_length(api_key) between 8 and 512),
  daily_limit integer not null default 30 check (daily_limit between 1 and 1000),
  shared_by uuid not null references auth.users (id) on delete cascade,
  updated_at timestamptz not null default now()
);

create table if not exists public.cowork_ai_usage (
  project_id uuid not null references public.cowork_projects (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  requests integer not null default 0,
  primary key (project_id, user_id, day)
);

-- Nobody reads these through the API; only the functions below.
alter table public.cowork_ai_shares enable row level security;
alter table public.cowork_ai_usage enable row level security;
revoke all on table public.cowork_ai_shares, public.cowork_ai_usage from public, anon, authenticated;

create or replace function tandem_private.ai_today()
returns date
language sql stable
set search_path = ''
as $$
  select (now() at time zone 'utc')::date;
$$;

-- An API address: https, or http on this computer (tests with a local server).
create or replace function tandem_private.valid_ai_url(p_url text)
returns boolean
language sql immutable
set search_path = ''
as $$
  select p_url ~ '^https://[^\s/?#]+(/[^\s?#]*)?$'
      or p_url ~ '^http://(127\.0\.0\.1|localhost)(:[0-9]{1,5})?(/[^\s?#]*)?$';
$$;

create or replace function public.cowork_set_ai_share(
  p_project uuid, p_provider text, p_model text, p_base_url text, p_api_key text, p_daily_limit integer
)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  existing public.cowork_ai_shares;
  k text := nullif(btrim(coalesce(p_api_key, '')), '');
  m text := btrim(coalesce(p_model, ''));
  u text := rtrim(btrim(coalesce(p_base_url, '')), '/');
begin
  perform tandem_private.require_role(p_project, 'owner');
  perform tandem_private.require_open(p_project);
  if p_provider is null or p_provider not in ('anthropic', 'openai') then
    raise exception 'Choose Anthropic or an OpenAI-compatible provider.' using errcode = 'PT400';
  end if;
  if char_length(m) not between 1 and 120 then
    raise exception 'Enter the model to share.' using errcode = 'PT400';
  end if;
  if u = '' then
    u := case p_provider when 'anthropic' then 'https://api.anthropic.com' else 'https://api.openai.com/v1' end;
  end if;
  if char_length(u) > 300 or not tandem_private.valid_ai_url(u) then
    raise exception 'The API address must start with https://.' using errcode = 'PT400';
  end if;
  if p_daily_limit is null or p_daily_limit not between 1 and 1000 then
    raise exception 'Requests per person per day: 1 to 1000.' using errcode = 'PT400';
  end if;
  select * into existing from public.cowork_ai_shares where project_id = p_project;
  if k is null then
    -- Keep the saved key, but only for the same provider and address.
    if existing.project_id is null or existing.provider <> p_provider or existing.base_url <> u then
      raise exception 'Enter the API key to share.' using errcode = 'PT400';
    end if;
    k := existing.api_key;
  elsif char_length(k) not between 8 and 512 or k ~ '\s' then
    raise exception 'That doesn''t look like an API key.' using errcode = 'PT400';
  end if;
  insert into public.cowork_ai_shares (project_id, provider, model, base_url, api_key, daily_limit, shared_by, updated_at)
  values (p_project, p_provider, m, u, k, p_daily_limit, auth.uid(), now())
  on conflict (project_id) do update
    set provider = excluded.provider, model = excluded.model, base_url = excluded.base_url,
        api_key = excluded.api_key, daily_limit = excluded.daily_limit,
        shared_by = excluded.shared_by, updated_at = now();
  return public.cowork_ai_share(p_project);
end;
$$;

create or replace function public.cowork_stop_ai_share(p_project uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
begin
  perform tandem_private.require_role(p_project, 'owner');
  delete from public.cowork_ai_shares where project_id = p_project;
  return null;
end;
$$;

create or replace function public.cowork_ai_share(p_project uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  r text;
  s public.cowork_ai_shares;
  used integer;
begin
  r := tandem_private.require_role(p_project, 'member');
  select * into s from public.cowork_ai_shares where project_id = p_project;
  if s.project_id is null then
    return null;
  end if;
  select coalesce(sum(requests), 0)::integer into used from public.cowork_ai_usage
   where project_id = p_project and user_id = auth.uid() and day = tandem_private.ai_today();
  return jsonb_build_object(
    'provider', s.provider,
    'model', s.model,
    'shared_by', tandem_private.username_of(s.shared_by),
    'shared_by_me', s.shared_by = auth.uid(),
    'daily_limit', s.daily_limit,
    'used_today', used,
    'updated_at', s.updated_at,
    -- Owners see enough to recognise the key, never the key itself.
    'key_hint', case when r = 'owner' then right(s.api_key, 4) end,
    'base_url', case when r = 'owner' then s.base_url end
  );
end;
$$;

create or replace function public.cowork_ai_use(p_project uuid, p_user uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  s public.cowork_ai_shares;
  n integer;
begin
  if not exists (select 1 from public.cowork_members where project_id = p_project and user_id = p_user) then
    raise exception 'This project isn''t available to you.' using errcode = 'PT403';
  end if;
  if exists (select 1 from public.cowork_projects where id = p_project and archived_at is not null) then
    raise exception 'This project is archived.' using errcode = 'PT409';
  end if;
  select * into s from public.cowork_ai_shares where project_id = p_project;
  -- Shared by someone who is still an owner here.
  if s.project_id is null or not exists (
    select 1 from public.cowork_members where project_id = p_project and user_id = s.shared_by and role = 'owner'
  ) then
    raise exception 'No AI is shared with this project.' using errcode = 'PT404';
  end if;
  if p_user = s.shared_by then
    n := 0;
  else
    insert into public.cowork_ai_usage as u (project_id, user_id, day, requests)
    values (p_project, p_user, tandem_private.ai_today(), 1)
    on conflict (project_id, user_id, day) do update
      set requests = u.requests + 1
      where u.requests < s.daily_limit
    returning requests into n;
    if n is null then
      raise exception 'You''ve used today''s % requests on the shared AI. They reset at midnight UTC, or connect your own AI in AI settings.', s.daily_limit
        using errcode = 'PT429';
    end if;
  end if;
  return jsonb_build_object(
    'provider', s.provider, 'model', s.model, 'base_url', s.base_url, 'api_key', s.api_key,
    'shared_by', tandem_private.username_of(s.shared_by), 'used_today', n, 'daily_limit', s.daily_limit,
    'unlimited', p_user = s.shared_by
  );
end;
$$;

create or replace function public.cowork_ai_refund(p_project uuid, p_user uuid)
returns jsonb
language sql security definer
set search_path = ''
as $$
  update public.cowork_ai_usage set requests = greatest(requests - 1, 0)
   where project_id = p_project and user_id = p_user and day = tandem_private.ai_today();
  select null::jsonb;
$$;

revoke all on function tandem_private.ai_today(), tandem_private.valid_ai_url(text) from public, anon;
grant execute on function tandem_private.ai_today(), tandem_private.valid_ai_url(text) to authenticated, service_role;

revoke all on function
  public.cowork_set_ai_share(uuid, text, text, text, text, integer), public.cowork_stop_ai_share(uuid),
  public.cowork_ai_share(uuid), public.cowork_ai_use(uuid, uuid), public.cowork_ai_refund(uuid, uuid)
from public, anon, authenticated;
grant execute on function
  public.cowork_set_ai_share(uuid, text, text, text, text, integer), public.cowork_stop_ai_share(uuid),
  public.cowork_ai_share(uuid)
to authenticated;
-- The key comes out only here, for the Edge Function (service role).
grant execute on function public.cowork_ai_use(uuid, uuid), public.cowork_ai_refund(uuid, uuid) to service_role;
grant usage on schema tandem_private to service_role;

commit;
