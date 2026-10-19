# Internet of Intelligence (IoI) — Contract v1

**Status:** experimental, internal Fetch feature branch. These contracts are not yet a published industry standard.

## Purpose

IoI is the interoperability layer underneath Fetch. Fetch is the first application; IoI normalizes how an application describes a task, discovers existing capabilities, hands work to a provider, and reports the outcome with evidence.

This first implementation is deliberately incremental. It wraps the existing Fetch Universal Task Contract, capability registry, ATC route, risk gate, and execution result. The core contract is pure, while the separately injected built-in provider adapters make explicit read-only provider calls. IoI does not replace existing execution semantics or grant permissions.

## Contract files

| Contract | Purpose |
| --- | --- |
| `schemas/ioi-task-v1.schema.json` | Transport-neutral task envelope |
| `schemas/ioi-capability-v1.schema.json` | Safe, portable provider-capability manifest |
| `schemas/ioi-capability-discovery-v1.schema.json` | Candidate ranking and selection result |
| `schemas/ioi-execution-receipt-v1.schema.json` | Outcome, evidence, failure, and timing receipt |

Runtime helpers live in `lib/fetch-ioi-contract.mjs`. The public universal executor adds the object under `result.ioi`; all previous top-level response fields remain unchanged.

## Capability manifest

Every capability uses a stable `capability_key`, a version, provider identity, supported domains/tags, execution modes, input/output schema references, policy signals, trust signals, and health state.

Allowed normalized health states are:

- `active`: eligible for selection
- `degraded`: known but not currently selectable
- `disabled`: administratively disabled, offline, revoked, or inactive
- `planned`: understood but not implemented or not launched
- `unknown`: source did not report a recognized state

A registry row is not automatically executable. A provider still needs a concrete adapter and must pass the existing Fetch/ATC and risk/approval gates. Provider endpoints, tokens, arbitrary metadata, and credentials are intentionally excluded from the normalized public manifest.

## Task envelope

The task envelope captures the goal, origin channel, opaque conversation/workflow linkage, required capability alternatives, execution mode, region/deadline hints, authorization requirements, lifecycle state, and provenance. It carries the existing Fetch task ID and workflow ID when available. Raw channel identifiers (which can be phone numbers) are not copied into the envelope; a caller may supply a separately issued opaque conversation reference.

`authorization.enforcement` references the existing Fetch risk engine. This is descriptive metadata, not an authorization grant. IoI must never treat `approval_granted` as true unless the existing trusted execution context explicitly supplies it.

## Discovery result

`discoverIOICapabilities` ranks only the candidates it is given from the current Fetch capability/ATC sources. In v1:

1. Explicit required capability keys match strictly. A provider with overlapping keywords cannot silently substitute an unrelated capability.
2. Without an explicit capability list, active candidates can match by declared domain, tag, or an explicit wildcard.
3. Inactive and planned providers are never selected.
4. The result records why a candidate matched, the score, and whether no compatible candidate was found.

**Important limitation:** v1 does not yet perform federated discovery over independent third-party networks. The source candidates still come from Fetch's existing registries and ATC. Adding independently operated registries and provider adapters is the next phase.

## Execution receipt and evidence

A receipt separates a route/status from an actually confirmed outcome.

- A route match alone is not execution success.
- `outcome_confirmed` is true only when the result reports a completed/success status and the executor explicitly reports success.
- `side_effect_completed` is true only when the same evidence of success exists and the executor explicitly reports `side_effect: true`.
- Evidence URLs are HTTP(S) only; credentials and common tracking parameters are stripped.
- Repeated evidence URLs are deduplicated.
- Unknown/invalid publication timestamps become null instead of being invented.

An execution receipt records the provider only when the candidate is known from current capability/ATC results. It does not claim cryptographic proof, independent verification, or provider reputation scoring. Those are future protocol elements.

## Built-in read-only adapters

`lib/fetch-ioi-open-meteo-adapters.mjs` provides two concrete provider adapters through the same harness:

- `weather_forecast`: Open-Meteo current conditions and date-labelled daily weather forecast.
- `air_quality_current`: Open-Meteo/CAMS model-derived US AQI, European AQI and particulate estimates for a specific location.
- `local_service_discovery`: searches explicitly public, approved service listings in the staging service directory and ranks by geographic distance when coordinates are available.

All three capabilities are read-only. They do not place orders, book services, send messages or mutate external systems. A state-only AQI request such as “AQI in Maharashtra” returns `needs_clarification`, even when a saved city coordinate exists; it must not silently substitute one city for an entire state. Local service searches also ask for a city/area or shared location pin if no usable location is supplied; state names alone are not treated as nearby coordinates. Missing provider values remain missing rather than being coerced into zero.

**AQI scope:** the Open-Meteo adapter is not an official CPCB monitoring-station adapter, and its US/EU indices are not India's National AQI. The answer labels modelled results and includes the provider time/source. Fetch must not present this as a verified official Indian station reading.

## Local-service directory discovery

`lib/fetch-ioi-service-discovery.mjs` implements the first non-weather IoI capability for approved local service listings. It supports electrician, plumber, carpenter, appliance repair, AC repair, pest control and cleaning searches. It queries only records whose status is `approved` and `metadata.public_listing=true`, applies a default 25 km radius (configurable up to 50 km), ranks location-backed candidates by Haversine distance, and returns up to five listings.

The directory adapter is deliberately staging-only and fail-closed. It requires all of these server-side variables: `FETCH_IOI_SERVICE_DIRECTORY_ENV=staging`, `FETCH_IOI_SERVICE_DIRECTORY_SUPABASE_URL`, `FETCH_IOI_SERVICE_DIRECTORY_PROJECT_REF`, and `FETCH_IOI_SERVICE_DIRECTORY_KEY`. The project reference must match the Supabase URL host exactly. It does not fall back to `SUPABASE_SECRET_KEY`, `VITE_SUPABASE_URL`, or a general/Production Supabase project. Contact numbers are fetched only in a second restricted query for matched approved public listings whose metadata explicitly sets `share_contact_with_customers=true`. Public metadata is allowlisted before returning; private notes and arbitrary fields are not sent to the user.

This is discovery, not transaction execution. Every result distinguishes `contact_status=not_contacted`, `acceptance_status=not_requested`, and `appointment_status=not_booked`. A listing is not independently verified unless separately verified; provider-marked verification is labelled as such. The receipt contains a registry resource reference as provenance plus any available public profile URLs, but a registry reference is not proof the provider is currently available.

## Shadow mode

`lib/fetch-ioi-shadow.mjs` classifies supported read-only weather, AQI and local-service discovery requests, sanitizes location context to an allowlist, invokes the explicitly registered adapter through `executeIOITask`, and returns a compact shadow record. The existing Fetch response remains authoritative: shadow output never replaces the answer or performs a side effect.

The universal executor runs this only when `FETCH_IOI_SHADOW_MODE=true`. Set that variable on a dedicated Preview branch only while testing; it is not configured for Production. Shadow results include selected capability/provider, status, timing, evidence and a baseline-status comparison. They intentionally exclude raw phone identifiers, auth/session values and coordinates.

The Preview-only direct test uses `POST /api/fetch/universal` with `{ "shadow_only": true, "text": "Weather in Trivandrum tomorrow" }` or `{ "shadow_only": true, "text": "Find an electrician in Thiruvananthapuram", "supplied_context": { "city": "Thiruvananthapuram", "latitude": 8.5241, "longitude": 76.9366 } }`. It runs inside the existing Vercel function to respect the Hobby plan's 12-function cap, bypasses database-backed baseline execution, and is hidden unless `FETCH_IOI_SHADOW_MODE=true`; it returns 404 when the flag is off. Local service discovery also requires the four dedicated staging-only environment variables described above; without them, it returns `source_unavailable` and does not query a database. This is a capability smoke test, not a replacement for full end-to-end tests against a healthy staging baseline.

## Migration strategy

IoI is additive. Existing clients can continue reading the current Fetch response. Consumers that understand IoI can read `result.ioi.task_envelope`, `result.ioi.capability_discovery`, `result.ioi.execution_receipt`, and, when shadow mode is enabled, `result.ioi.shadow_evaluation`.

The current executor persists its normal result first. Shadow execution and trace generation are guarded so a malformed optional trace cannot turn a completed customer task into a failed customer response.

## Next steps

1. Configure a dedicated staging directory with reviewed service listings, consent fields, and access policies; do not copy Production credentials into Preview.
2. Compare shadow results with the existing Fetch baseline across weather/AQI and service discovery; fix baseline failures and status mismatches.
3. Add explicit contact/acceptance/appointment workflows only as separate approval-gated capabilities with idempotency and evidence requirements.
4. Add a registry interface that can query independently operated provider registries, validate their signed manifests, and return ranked candidates.
5. Enable IoI-controlled routing for one read-only capability behind a rollout flag only after shadow metrics and regression tests pass.

## Validation

`lib/fetch-ioi-contract.test.mjs`, `lib/fetch-ioi-open-meteo-adapters.test.mjs`, `lib/fetch-ioi-shadow-endpoint.test.mjs`, and `lib/fetch-ioi-service-discovery.test.mjs` cover capability normalization, secret exclusion, strict capability matching, authorization gates, timeout behavior, receipts and registry references, weather/AQI adapters, statewide-AQI clarification, service-category/location clarification, staging-only database access, public-listing filters, distance ranking, contact-sharing consent, and the Preview endpoint safety gate.

Run:

```bash
npm test
node --check lib/fetch-ioi-contract.mjs
node --check lib/fetch-ioi-provider-runtime.mjs
node --check lib/fetch-ioi-open-meteo-adapters.mjs
node --check lib/fetch-ioi-shadow.mjs
node --check lib/fetch-ioi-service-discovery.mjs
node --check lib/fetch-universal-execution.mjs
node --check api/fetch/universal.mjs
```