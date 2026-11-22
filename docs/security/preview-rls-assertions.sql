-- Run only against a disposable local/preview PostgreSQL database after
-- applying docs/security/preview-migration-draft.sql.
-- This file is read-only and fails loudly when expected controls are absent.

do $$
declare
  target text;
begin
  if not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'fetch_partner_applications'
      and c.relrowsecurity
  ) then
    raise exception 'RLS is not enabled on public.fetch_partner_applications';
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'fetch_partner_applications'
      and (roles::text like '%anon%' or roles::text like '%authenticated%')
  ) then
    raise exception 'Browser-facing policy exists on fetch_partner_applications';
  end if;

  foreach target in array array[
    'customers',
    'messages',
    'shopper_jobs',
    'shoppers',
    'stores',
    'substitution_requests'
  ]
  loop
    if exists (
      select 1 from pg_policies
      where schemaname = 'public'
        and tablename = target
        and policyname like 'prototype_%'
    ) then
      raise exception 'Prototype policy remains on public.%', target;
    end if;
  end loop;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'shoppers'
      and policyname = 'admin_update_shoppers'
      and cmd = 'UPDATE'
      and coalesce(qual, '') not in ('', 'true')
      and coalesce(with_check, '') not in ('', 'true')
  ) then
    raise exception 'Expected scoped admin UPDATE policy on shoppers is missing';
  end if;
end
$$;
