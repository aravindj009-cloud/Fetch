-- Runs after test-fixture.sql and preview-migration-draft.sql on disposable PostgreSQL.
-- Verify that the migration removed prototype policies while preserving admin access.

do $$
declare
  t text;
begin
  foreach t in array array['customers','messages','shopper_jobs','shoppers','stores','substitution_requests']
  loop
    if exists (select 1 from pg_policies where schemaname='public' and tablename=t and policyname like 'prototype_%') then
      raise exception 'Prototype policy remains on %', t;
    end if;
  end loop;
  if not (select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname='fetch_partner_applications') then
    raise exception 'fetch_partner_applications RLS is not enabled';
  end if;
end $$;

-- A non-admin authenticated user cannot update a shopper row.
set role authenticated;
select set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',false);
update public.shoppers set available=false where id='22222222-2222-4222-8222-222222222222';
reset role;

do $$
begin
  if (select available from public.shoppers where id='22222222-2222-4222-8222-222222222222') is not true then
    raise exception 'Non-admin authenticated user changed a shopper row';
  end if;
end $$;

-- An admin can still update a shopper row through the scoped admin policy.
set role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
update public.shoppers set available=false where id='22222222-2222-4222-8222-222222222222';
reset role;

do $$
begin
  if (select available from public.shoppers where id='22222222-2222-4222-8222-222222222222') is not false then
    raise exception 'Admin update was not preserved';
  end if;
end $$;
