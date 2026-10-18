# Internet of Intelligence (IoI) — Contract v1

**Status:** experimental, internal Fetch feature branch. These contracts are not yet a published industry standard.

## Purpose

IoI is the interoperability layer underneath Fetch. Fetch is the first application; IoI normalizes how an application describes a task, discovers existing capabilities, hands work to a provider, and reports the outcome with evidence.

This first implementation is deliberately incremental. It wraps the existing Fetch Universal Task Contract, capability registry, ATC route, risk gate, and execution result. It does not replace those systems, make new provider network calls, or grant permissions.

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

The task envelope captures the goal, origin channel, conversation/workflow linkage, required capability alternatives, execution mode, region/deadline hints, authorization requirements, lifecycle state, and provenance. It carries the existing Fetch task ID and workflow ID when available.

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

## Migration strategy

IoI is additive. Existing clients can continue reading the current Fetch response. Consumers that understand IoI can read `result.ioi.task_envelope`, `result.ioi.capability_discovery`, and `result.ioi.execution_receipt`.

The current executor persists its normal result first. Trace generation is pure and guarded so a malformed optional trace cannot turn a completed customer task into a failed customer response.

## Next steps

1. Add an adapter interface that turns the selected capability into a typed provider invocation, with timeouts and cancellation.
2. Add idempotency keys, bounded retries, provider health/circuit-breaker state, and explicit accepted/running/completed/failed transitions.
3. Add a registry interface that can query independently operated provider registries, validate their signed manifests, and return ranked candidates.
4. Add evidence/verifier contracts for claim-to-source links and independently checked execution outcomes.
5. Run Fetch tasks through IoI in shadow mode and compare the selected provider and receipt with the existing ATC decisions before enabling it to control routing.

## Validation

`lib/fetch-ioi-contract.test.mjs` covers capability normalization, secret exclusion, strict capability matching, no-candidate results, task envelope authorization/provenance, outcome confirmation, side-effect receipts, evidence URL cleanup/deduplication, and additive response compatibility.

Run:

```bash
npm test
node --check lib/fetch-ioi-contract.mjs
node --check lib/fetch-universal-execution.mjs
```
