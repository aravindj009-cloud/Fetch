import test from "node:test";
import assert from "node:assert/strict";
import { createFetchAgentCoordinationReceipt } from "./fetch-agent-coordination.mjs";

test("receipt separates suggested specialist from actual execution and contains no user text", () => {
  const requestText = "Find an electrician near me. My home address is 123 private street.";
  const result = {
    status: "completed",
    task: { status: "completed", resource: { type: "local_service_directory", id: "directory-1" } },
    atc: { status: "matched", resource_type: "local_service_directory", resource_id: "directory-1" },
    execution: { success: true, status: "completed", side_effect: false, sources: [{ url: "https://example.com/listing", title: "Example listing" }] },
    ioi: { trace_id: "trace-1", shadow_evaluation: { provider_id: "osm", capability_key: "local_service_discovery", receipt: { trace_id: "trace-1", provider_id: "osm", capability_key: "local_service_discovery", outcome_confirmed: true } } },
  };
  const receipt = createFetchAgentCoordinationReceipt({ requestText, result, startedAt: "2026-10-21T00:00:00Z" });
  assert.equal(receipt.requested_specialist.id, "local_helper");
  assert.equal(receipt.execution_authority, "fetch_atc_ioi");
  assert.equal(receipt.route.provider_id, "osm");
  assert.equal(receipt.outcome.success_reported, true);
  assert.equal(JSON.stringify(receipt).includes("private street"), false);
});

test("unavailable or unconfirmed task is never recorded as a successful completion", () => {
  const receipt = createFetchAgentCoordinationReceipt({
    requestText: "Track my journey to Bangalore",
    result: { status: "source_unavailable", execution: { success: false, status: "source_unavailable", side_effect: false } },
  });
  assert.equal(receipt.requested_specialist.id, "journey");
  assert.equal(receipt.outcome.success_reported, false);
  assert.equal(receipt.outcome.outcome_confirmed, false);
});

test("coordination receipt bounds evidence, memory references and fallback attempts", () => {
  const result = {
    status: "completed",
    execution: { success: true, status: "completed" },
    sources: Array.from({ length: 12 }, (_, i) => ({ url: "https://example.com/" + i, title: "S" + i })),
  };
  const recoveryReceipt = {
    receipt_version: "fetch-agent-recovery-receipt-v1",
    fallback_count: 2,
    recovered: true,
    attempts: Array.from({ length: 5 }, (_, i) => ({ attempt: i + 1, provider_id: "p" + i, status: "failed" })),
  };
  const memoryReceipt = { available: true, receipt: { owner_bound: true, allowed_count: 50, denied_count: 2, memory_ids: Array.from({ length: 20 }, (_, i) => "m" + i) } };
  const receipt = createFetchAgentCoordinationReceipt({ requestText: "Research this topic", result, memoryReceipt, recoveryReceipt });
  assert.equal(receipt.evidence.length, 8);
  assert.equal(receipt.memory_access.memory_ids.length, 12);
  assert.equal(receipt.recovery.attempts.length, 2);
  assert.equal(receipt.recovery.fallback_count, 2);
});
