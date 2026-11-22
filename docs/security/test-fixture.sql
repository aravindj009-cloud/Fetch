-- Minimal fixture matching the relevant live RLS/grant snapshot.
-- Used only by the disposable GitHub Actions PostgreSQL service.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

create table public.admin_users (user_id uuid primary key);
create table public.customers (id uuid primary key, name text);
create table public.messages (id uuid primary key, customer_id uuid, message text);
create table public.shopper_jobs (id uuid primary key, status text);
create table public.shoppers (id uuid primary key, name text, available boolean);
create table public.stores (id uuid primary key, name text);
create table public.substitution_requests (id uuid primary key, status text);
create table public.fetch_partner_applications (id uuid primary key, business_name text);

alter table public.customers enable row level security;
alter table public.messages enable row level security;
alter table public.shopper_jobs enable row level security;
alter table public.shoppers enable row level security;
alter table public.stores enable row level security;
alter table public.substitution_requests enable row level security;
-- This table intentionally starts with RLS disabled to reproduce the live finding.

create policy admin_read_customers on public.customers for select to authenticated
  using (exists (select 1 from public.admin_users a where a.user_id = auth.uid()));
create policy prototype_insert_customers on public.customers for insert to anon, authenticated with check (true);
create policy prototype_update_customers on public.customers for update to anon, authenticated using (true) with check (true);

create policy admin_read_messages on public.messages for select to authenticated
  using (exists (select 1 from public.admin_users a where a.user_id = auth.uid()));
create policy prototype_insert_messages on public.messages for insert to anon, authenticated with check (true);
create policy prototype_update_messages on public.messages for update to anon, authenticated using (true) with check (true);

create policy admin_read_shopper_jobs on public.shopper_jobs for select to authenticated
  using (exists (select 1 from public.admin_users a where a.user_id = auth.uid()));
create policy prototype_insert_shopper_jobs on public.shopper_jobs for insert to anon, authenticated with check (true);
create policy prototype_update_shopper_jobs on public.shopper_jobs for update to anon, authenticated using (true) with check (true);

create policy admin_read_shoppers on public.shoppers for select to authenticated
  using (exists (select 1 from public.admin_users a where a.user_id = auth.uid()));
create policy admin_update_shoppers on public.shoppers for update to authenticated
  using (exists (select 1 from public.admin_users a where a.user_id = auth.uid()))
  with check (exists (select 1 from public.admin_users a where a.user_id = auth.uid()));
create policy prototype_insert_shoppers on public.shoppers for insert to anon, authenticated with check (true);
create policy prototype_update_shoppers on public.shoppers for update to anon, authenticated using (true) with check (true);

create policy admin_read_stores on public.stores for select to authenticated
  using (exists (select 1 from public.admin_users a where a.user_id = auth.uid()));
create policy prototype_insert_stores on public.stores for insert to anon, authenticated with check (true);
create policy prototype_update_stores on public.stores for update to anon, authenticated using (true) with check (true);

create policy admin_read_substitution_requests on public.substitution_requests for select to authenticated
  using (exists (select 1 from public.admin_users a where a.user_id = auth.uid()));
create policy prototype_insert_substitution_requests on public.substitution_requests for insert to anon, authenticated with check (true);
create policy prototype_update_substitution_requests on public.substitution_requests for update to anon, authenticated using (true) with check (true);

grant select on public.admin_users to authenticated;
grant select on public.customers, public.messages, public.shopper_jobs, public.shoppers, public.stores, public.substitution_requests to authenticated;
grant update on public.shoppers to authenticated;

insert into public.admin_users(user_id) values ('11111111-1111-4111-8111-111111111111');
insert into public.shoppers(id,name,available) values ('22222222-2222-4222-8222-222222222222','Test Shopper',true);
