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

## Agent-to-agent messaging (experimental v1)

The specialist dog registry is a display/intent hint; it is not, by itself, an agent runtime. The separate `lib/fetch-agent-messaging.mjs` module adds a server-side request/reply protocol for real specialist handoffs:

- Each message has a protocol version, message ID, parent message ID, task ID, trace ID, sender/recipient, capability, message type, status, and a bounded JSON payload.
- An explicit handoff allowlist controls which specialist can ask which other specialist for work. The coordinator remains the entry point.
- Each agent receives only the payload explicitly forwarded to its capability handler. Context and user memory are not automatically copied between agents.
- Timeouts, message-count/depth limits, duplicate-route detection, cycle detection, output validation, and a structured audit trace bound the workflow.
- Capabilities declare a side-effect class. Read-only calls may proceed when registered; other classes fail closed unless the server-provided `authorizeSideEffect` gate returns approval. Client-provided flags are not authoritative.
- Handler exceptions are converted into non-sensitive failure statuses; a failed or timed-out handoff is never reported as a success.

The first concrete collaboration path lives in `lib/fetch-agent-collaboration.mjs`: Patch receives the result of IoI local-service discovery and explicitly delegates a source-metadata assessment to Scout. Scout checks whether a public source reference exists and preserves the difference between a source claim and independent verification. It does not browse or contact the provider. The returned IoI shadow result includes the two-message trace and the assessments; the existing Fetch customer response remains authoritative.

This collaboration path is currently wired into the IoI **Preview/shadow** path for local-service discovery. It is not turned on as the production request executor, and other capabilities do not yet use this bus. Adding more agent capabilities requires registering trusted handler implementations and tests for each capability, not simply adding a name to the roster.

Test coverage is in `lib/fetch-agent-messaging.test.mjs`, `lib/fetch-agent-collaboration.test.mjs`, and the IoI service-discovery integration test. The tests cover successful handoffs, trace parentage, approval-gated side effects, timeouts, cycles, duplicate routes, bounded payloads and disclosure limits.

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

## Federated public local-service discovery

When the private Fetch directory is unavailable or returns no candidates, IoI can make one read-only query against the public OpenStreetMap Overpass endpoint. The current tag mapping is intentionally limited to electricians, plumbers, and carpenters. This public fallback requires shared latitude/longitude; with city-only context it asks the user to share a location pin instead of pretending a city centroid is the user's location.

- Search radius is capped at 25 km and defaults to 10 km.
- Results are limited to five named map objects, with element links, distance from the shared location, optional public phone/site fields, and © OpenStreetMap contributors attribution.
- A process-local cache has a five-minute TTL and bounded size; there are no automatic retries for HTTP 429 or other failed responses.
- OSM data is community-mapped and is not independently verified by Fetch. Listing presence does not confirm current operation, phone accuracy, service acceptance, or availability.
- The adapter never messages a provider, requests acceptance, or books an appointment. Production traffic does not use the IoI response path.

The public endpoint is suitable only for bounded Preview experiments. Before sustained/commercial traffic, review the OpenStreetMap/Overpass usage policy and select a service arrangement appropriate to the anticipated volume.

## Fetch specialist dog registry (v1)

Fetch may present specialist dog identities—Scout (research), Rover (shopping/errands), Patch (local services), Scribe (daily minutes/memory), and Trek (travel)—under the Fetch Coordinator. The registry lives in `lib/fetch-agent-dog-registry.mjs`.

- The initial specialist resolver is deterministic and advisory. It labels a likely role from the request but does not select a connector, call a provider, grant permission, or claim a task succeeded.
- `executeUniversalFetchRequest` attaches a safe `agent_dog` descriptor to the result for UI/trace attribution. Existing Fetch/ATC/IoI routing remains authoritative; we do not create parallel execution pipelines.
- Every profile carries explicit capabilities and a readiness label. Travel tracking is marked planned until the necessary location/mobility integration exists; local service discovery remains experimental; daily minutes are still browser-local in this prototype.
- This version uses six specialist profiles, not six separate autonomous model instances. Future model/provider delegation should be added only behind the existing IoI task contract, shared memory/context controls, risk checks, confirmations and execution receipts.

## Specialist coordination, shared memory and recovery (v1)

### Specialist coordination receipts
`lib/fetch-agent-coordination.mjs` attaches an audit-safe receipt with the suggested specialist, actual Fetch/ATC route, reported execution outcome, bounded source references, memory-access counts and safe recovery attempts. It does not copy the user's original request or memory values into the receipt. The specialist suggestion remains advisory; the actual route and provider result are authoritative.

### Permission-aware memory
`supabase/migrations/20261021_fetch_agent_memory_v1.sql` defines private-by-default memory and per-agent/per-purpose grant tables. Both tables enable RLS, define no public/authenticated-role policies, and grant table access only to the server `service_role`. The server-only store is in `lib/fetch-agent-memory-store.mjs`.

- Memory access is off unless `FETCH_AGENT_MEMORY_V1=true` and the server handler marks the customer identity as verified.
- Sharing memory requires explicit save confirmation plus separate sharing consent, an ordinary-sensitivity item, selected agent IDs and allowed purposes.
- Each use validates owner, agent, purpose, task scope, expiry and revocation. Missing config/schema, missing consent, or errors fail closed and do not stop the underlying Fetch task.
- The digital agent receives only items whose IDs appear in a verified allowlist receipt. The prompt instructs the model to treat them as data, not instructions.
- Website guest chat currently has no verified persistent customer identity, so this memory path is not enabled for guests. WhatsApp uses the server-resolved customer record. Cross-device/web memory needs a proper user sign-in/session identity before activation.
- The SQL migration is committed but is **not applied to the connected Supabase database**. Apply it to a non-production branch first, review RLS/security, and test before enabling the environment flag.

### Bounded provider recovery
`lib/fetch-ioi-recovery.mjs` allows at most one alternative provider attempt for a failed task whose selected capability explicitly declares `side_effect_class: read_only`. It excludes the failed provider, re-runs discovery only over already-injected adapters for the same capability, and includes a separate `fetch-agent-recovery-receipt-v1`. Shopping, messages, bookings, payments and other side effects are not automatically retried.

## Shared local-service discovery response

Local-service discovery is a read-only directory lookup; it does not contact providers or book appointments. The same deterministic response projection is available to the website and WhatsApp after an approved public listing is returned.

The rollout intentionally uses two independent Preview-only controls:

- `FETCH_IOI_SHADOW_MODE=true` enables read-only IoI evaluation.
- `FETCH_IOI_CUSTOMER_RESPONSE_MODE=true` allows a successful local-service directory result to become the customer-facing response.

Both must be enabled for this response path. Keep both disabled in Production until the partner directory is populated and approved, its public-listing and contact-sharing rules are reviewed, and an end-to-end test has been completed. If the source is unavailable, the response projection fails closed and the existing Fetch result remains authoritative. Contact, acceptance, and appointment states remain `not_contacted`, `not_requested`, and `not_booked`.

## Cross-channel response contract

The customer response projection is shared by both channels:

- The website API returns the shared `ioi.customer_response.text` as its `message`.
- WhatsApp's existing universal-execution success handler sends `execution.message`; the IoI projection fills that field with exactly the same text.
- Physical shopping/order requests do not match the read-only discovery classifier and remain on the existing physical-order path.
- If provider discovery is unavailable, needs clarification, fails validation, or is not successful, the projection returns no override and the established Fetch response remains authoritative.
- Contact details are included only when the partner directory adapter returned them under the partner's explicit contact-sharing consent. The response never represents directory listing as a confirmed booking or confirmed provider availability.

Minimum Preview validation sequence: test a weather/AQI read (existing adapters still work), test a local-service request with no staging source configured (must fail closed), then—with an approved staging directory and only after access policies are reviewed—test a listing with consented contact details through both the website and a test WhatsApp account. Compare the text and verify neither request creates a booking or contacts the listed provider.
 
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