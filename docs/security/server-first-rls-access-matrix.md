# Fetch server-first database access audit

Audit date: 2026-11-22
Scope: live Supabase project metadata, current `main` source in both Fetch repositories.
Status: audit artifact only; no production database changes have been applied.

## Architecture decision

Sensitive database operations are server-only. Browser clients must call authenticated Fetch APIs; they must not write operational tables directly. Server routes use the Supabase service credential from server-side environment variables. Never expose that credential through Vite-prefixed variables or client bundles.

## Findings verified against the live Supabase project

- 38 tables exist in the `public` schema.
- 37 have RLS enabled; `fetch_partner_applications` is the only public table observed with RLS disabled.
- Prototype policies exist on `customers`, `messages`, `shopper_jobs`, `shoppers`, `stores`, and `substitution_requests`.
- The role grants materially narrow the effective exposure compared with the policy definitions alone:
  - `anon` did not have SELECT/INSERT/UPDATE/DELETE table privileges on those six tables in the grant snapshot.
  - `authenticated` had SELECT on those tables, and UPDATE on `shoppers`.
  - Therefore the `prototype_update_shoppers` policy is the immediately effective broad-write concern. The other prototype policies are unsafe latent permissions if grants are broadened later, but were not independently sufficient to grant access in the observed snapshot.
- `fetch_partner_applications` had RLS disabled but no anon/authenticated SELECT/INSERT/UPDATE/DELETE privileges in the observed grant snapshot.
- The partner application submission route in `api/fetch/context.mjs` writes via server-side REST using the server credential. The WhatsApp webhook reads active partner applications server-side.
- Searches of the two primary React entry points did not find direct Supabase client usage. This is a limited source scan, not proof that no other client module uses it.

## Table/access matrix

| Table | Browser access intended | Server use observed | Current guardrail / action |
|---|---|---|---|
| customers | No direct writes; admin read only | WhatsApp/order engine | Remove prototype insert/update policies; preserve admin SELECT |
| messages | No direct writes; admin read only | WhatsApp/order engine | Remove prototype insert/update policies; preserve admin SELECT |
| shopper_jobs | No direct writes; admin read only | Shopper/order engine | Remove prototype insert/update policies; preserve admin SELECT |
| shoppers | No direct writes; admin read/update only | Shopper/order engine | Remove prototype insert/update policies; preserve admin policies |
| stores | No direct writes; admin read only | Order/partner engine | Remove prototype insert/update policies; preserve admin SELECT |
| substitution_requests | No direct writes; admin read only | Order/WhatsApp engine | Remove prototype insert/update policies; preserve admin SELECT |
| fetch_partner_applications | No direct database access | Partner portal server route inserts; webhook reads active records | Enable RLS with no browser policies; service-role backend remains the access path |

## Proposed first hardening migration

The companion draft SQL:
1. Enables RLS on `fetch_partner_applications` without creating anon/authenticated policies.
2. Removes all 12 prototype INSERT/UPDATE policies from the six operational tables.
3. Preserves the existing admin-only SELECT policies and the admin-only UPDATE policy on `shoppers`.

This migration is deliberately stored under `docs/security/`, not `supabase/migrations/`. The live project has 12 applied migration records, but the GitHub repository currently has no matching tracked `supabase/migrations/` history. Adding a migration directory with only a new migration before reconciling those 12 historical migrations risks migration-history divergence.

## No-cost preview/test strategy

- Use a GitHub branch and pull request for code review.
- Use the existing Vercel Preview deployment for frontend/API build validation only. Do not assume its Supabase environment is isolated.
- Do not run DDL against the production Supabase project.
- Before applying the migration, reconstruct a disposable local PostgreSQL/Supabase test database from a reviewed schema baseline, or obtain an existing non-production Supabase project with no additional recurring cost.
- Run the companion SQL assertions against that disposable database.
- Only after passing tests and confirming all server routes use server credentials should the migration be moved into the canonical migration history and scheduled for production approval.

## Important caveats

- Supabase service-role credentials bypass RLS; keep them exclusively on the server and never return them to the client.
- RLS does not replace API-level authentication, authorization, ownership checks, input validation, rate limiting, or audit logging.
- Re-run table grants and policy inspection immediately before applying any migration; grants may have changed since this audit.
