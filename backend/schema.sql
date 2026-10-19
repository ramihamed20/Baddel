-- Baddel: shared requests database for the public, no-login website.
-- Execute in a NEW, dedicated Supabase project (do not run in Lockin or PlusCard).
-- Anonymous and authenticated PostgREST clients have NO table access.
-- The only public entrypoint is the baddel-api Edge Function.

create table if not exists public.baddel_requests (
  id uuid primary key default gen_random_uuid(),
  academic_year smallint not null default 2 check (academic_year in (1,2,3)),
  current_section text not null check (current_section in ('A','B')),
  current_group text not null,
  target_section text not null check (target_section in ('A','B')),
  target_group text not null,
  telegram text not null check (telegram ~ '^[A-Za-z0-9_]{5,32}$'),
  owner_hash text not null check (owner_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days'),
  constraint baddel_different_groups check (
    current_section <> target_section or current_group <> target_group
  ),
  constraint baddel_current_group_by_year check (
    (academic_year = 1 and current_group in ('A','B','C','D'))
    or (academic_year = 2 and current_group in ('A1','A2','B1','B2','C1','C2','D1','D2'))
    or (academic_year = 3 and current_group in ('A1','A2','B1','B2','C1','C2','D1','D2','E1','E2'))
  ),
  constraint baddel_target_group_by_year check (
    (academic_year = 1 and target_group in ('A','B','C','D'))
    or (academic_year = 2 and target_group in ('A1','A2','B1','B2','C1','C2','D1','D2'))
    or (academic_year = 3 and target_group in ('A1','A2','B1','B2','C1','C2','D1','D2','E1','E2'))
  ),
  constraint baddel_sections_by_year check (
    academic_year in (1,2) or (current_section = 'A' and target_section = 'A')
  )
);

create index if not exists baddel_requests_active_date
  on public.baddel_requests(expires_at, created_at desc);
create index if not exists baddel_requests_reverse
  on public.baddel_requests(academic_year, current_section, current_group, target_section, target_group, expires_at);
create unique index if not exists baddel_requests_unique_per_user_pair
  on public.baddel_requests(
    lower(telegram), academic_year, current_section, current_group, target_section, target_group
  );

create index if not exists baddel_requests_year_active
  on public.baddel_requests (academic_year, created_at desc) where expires_at is not null;

create table if not exists public.baddel_rate_events (
  id bigserial primary key,
  ip_hash text not null check (ip_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now()
);
create index if not exists baddel_rate_events_lookup
  on public.baddel_rate_events(ip_hash, created_at desc);

alter table public.baddel_requests enable row level security;
alter table public.baddel_rate_events enable row level security;

revoke all on public.baddel_requests from public, anon, authenticated;
revoke all on public.baddel_rate_events from public, anon, authenticated;
revoke all on sequence public.baddel_rate_events_id_seq from public, anon, authenticated;

-- The Edge Function uses a server-side secret, never included in browser assets.
grant select, insert, delete on public.baddel_requests to service_role;
grant select, insert, delete on public.baddel_rate_events to service_role;
grant usage, select on sequence public.baddel_rate_events_id_seq to service_role;

comment on table public.baddel_requests is
  'Student exchange requests. Public API is served exclusively through baddel-api Edge Function.';
