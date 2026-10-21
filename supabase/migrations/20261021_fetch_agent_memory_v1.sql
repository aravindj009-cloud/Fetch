-- Fetch specialist memory v1. Private-by-default and server-only.
-- Do not apply to Production until the Preview path and customer identity resolution are verified.

create table if not exists public.fetch_agent_memory_v1 (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null,
  memory_key text not null,
  memory_value jsonb not null,
  sensitivity text not null default 'ordinary'
    check (sensitivity in ('ordinary','sensitive','secret','credential','financial_secret','health_sensitive')),
  sharing_policy text not null default 'private'
    check (sharing_policy in ('private','selected_agents','task_only')),
  shared_agent_ids text[] not null default '{}',
  allowed_purposes text[] not null default '{}',
  consent_granted boolean not null default false,
  consented_at timestamptz,
  expires_at timestamptz,
  source_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, memory_key),
  check (
    sharing_policy = 'private'
    or (
      consent_granted = true
      and consented_at is not null
      and sensitivity = 'ordinary'
      and cardinality(shared_agent_ids) > 0
      and cardinality(allowed_purposes) > 0
    )
  ),
  check (
    sharing_policy <> 'private'
    or (
      cardinality(shared_agent_ids) = 0
      and cardinality(allowed_purposes) = 0
    )
  )
);

create table if not exists public.fetch_agent_memory_grants_v1 (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null,
  memory_id uuid not null references public.fetch_agent_memory_v1(id) on delete cascade,
  agent_id text not null,
  purpose text not null,
  task_id text not null default '',
  consent_granted boolean not null default false,
  consented_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (memory_id, agent_id, purpose, task_id),
  check (consent_granted = false or consented_at is not null)
);

create index if not exists fetch_agent_memory_v1_owner_idx
  on public.fetch_agent_memory_v1 (owner_id, updated_at desc);
create index if not exists fetch_agent_memory_grants_v1_lookup_idx
  on public.fetch_agent_memory_grants_v1 (owner_id, agent_id, purpose)
  where consent_granted = true and revoked_at is null;

alter table public.fetch_agent_memory_v1 enable row level security;
alter table public.fetch_agent_memory_grants_v1 enable row level security;

revoke all on table public.fetch_agent_memory_v1 from public, anon, authenticated;
revoke all on table public.fetch_agent_memory_grants_v1 from public, anon, authenticated;
grant select, insert, update, delete on table public.fetch_agent_memory_v1 to service_role;
grant select, insert, update, delete on table public.fetch_agent_memory_grants_v1 to service_role;

comment on table public.fetch_agent_memory_v1 is
  'Private-by-default memory for Fetch specialist agents. Access only via trusted server code; explicit consent is required before sharing.';
comment on table public.fetch_agent_memory_grants_v1 is
  'Per-memory, per-agent, per-purpose consent grants. No public or authenticated-role policies are intentionally defined.';
