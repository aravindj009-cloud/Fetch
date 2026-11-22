-- FETCH SERVER-FIRST RLS HARDENING
-- DRAFT ONLY — DO NOT APPLY TO PRODUCTION.
-- First reconcile the 12 existing remote migrations with a tracked migration
-- history. This draft is intentionally under docs/security/, not supabase/migrations/.
--
-- Assumptions verified on 2026-11-22:
-- - Fetch browser entry points do not directly use Supabase client APIs in the
--   scanned React entry files.
-- - Partner application writes/reads are performed by server routes using the
--   server-side Supabase credential.
-- - The service_role credential is never shipped to browser code.

begin;

-- Public partner applications are submitted through api/fetch/context.mjs.
-- The server-side service role remains the only intended data access path.
alter table public.fetch_partner_applications enable row level security;

-- Remove prototype policies. Existing admin-only policies are intentionally
-- preserved. In particular, shoppers.admin_update_shoppers remains the only
-- authenticated UPDATE path for shoppers and is scoped to admin_users.
drop policy if exists prototype_insert_customers on public.customers;
drop policy if exists prototype_update_customers on public.customers;

drop policy if exists prototype_insert_messages on public.messages;
drop policy if exists prototype_update_messages on public.messages;

drop policy if exists prototype_insert_shopper_jobs on public.shopper_jobs;
drop policy if exists prototype_update_shopper_jobs on public.shopper_jobs;

drop policy if exists prototype_insert_shoppers on public.shoppers;
drop policy if exists prototype_update_shoppers on public.shoppers;

drop policy if exists prototype_insert_stores on public.stores;
drop policy if exists prototype_update_stores on public.stores;

drop policy if exists prototype_insert_substitution_requests on public.substitution_requests;
drop policy if exists prototype_update_substitution_requests on public.substitution_requests;

commit;
