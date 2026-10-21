/*
 * Shared orchestration metadata for Fetch's specialist dog team.
 * The registry suggestion is advisory; the actual Fetch/ATC/IoI route and
 * execution status remain authoritative.
 */
import { resolveFetchAgentDog } from "./fetch-agent-dog-registry.mjs";

function clean(value, max = 240) {
  return String(value ?? "").trim().slice(0, max);
}
function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function iso(value, fallback = new Date().toISOString()) {
  const date = new Date(value || "");
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}
function safeEvidence(list) {
  const output = [];
  for (const item of Array.isArray(list) ? list : []) {
    const row = asObject(item);
    const uri = clean(row.uri || row.url || row.source_url || row.source_uri, 1000);
    if (!/^https?:\/\//i.test(uri)) continue;
    output.push({
      uri,
      title: clean(row.title || row.name || "Source", 240),
      evidence_type: clean(row.evidence_type || row.type || row.source_type || "source_reference", 80),
    });
    if (output.length >= 8) break;
  }
  return output;
}

/**
 * Create an audit-safe delegation receipt without copying user text or memory
 * values. The receipt distinguishes the suggested specialist from the provider
 * Fetch actually selected and reports success only when execution says so.
 */
export function createFetchAgentCoordinationReceipt({
  requestText = "",
  result = {},
  memoryReceipt = null,
  recoveryReceipt = null,
  traceId = null,
  startedAt = null,
  completedAt = new Date().toISOString(),
} = {}) {
  const agent = resolveFetchAgentDog(requestText);
  const fetchResult = asObject(result);
  const task = asObject(fetchResult.task);
  const atc = asObject(fetchResult.atc);
  const execution = asObject(fetchResult.execution);
  const ioi = asObject(fetchResult.ioi);
  const shadow = asObject(ioi.shadow_evaluation);
  const receipt = asObject(shadow.receipt);
  const resultSources = [
    ...(Array.isArray(fetchResult.evidence) ? fetchResult.evidence : []),
    ...(Array.isArray(fetchResult.sources) ? fetchResult.sources : []),
    ...(Array.isArray(execution.sources) ? execution.sources : []),
    ...(Array.isArray(receipt.evidence) ? receipt.evidence : []),
  ];
  const finalStatus = clean(execution.status || fetchResult.status || "unknown", 80).toLowerCase();
  const success = execution.success === true && finalStatus === "completed";
  const recovery = asObject(recoveryReceipt || shadow.recovery_receipt);
  const memory = asObject(memoryReceipt);

  return {
    receipt_version: "fetch-agent-coordination-receipt-v1",
    trace_id: clean(traceId || receipt.trace_id || ioi.trace_id || "", 180) || null,
    requested_specialist: {
      id: agent.id,
      name: agent.name,
      title: agent.title,
      selection_mode: "advisory_intent_match",
      readiness: agent.status,
    },
    execution_authority: "fetch_atc_ioi",
    route: {
      status: clean(atc.status || task.status || fetchResult.status || "unknown", 80),
      resource_type: clean(atc.resource_type || task.resource?.type || "", 120) || null,
      resource_id: clean(atc.resource_id || task.resource?.id || "", 180) || null,
      provider_id: clean(receipt.provider_id || execution.provider_id || shadow.provider_id || "", 160) || null,
      capability_key: clean(receipt.capability_key || execution.capability_key || shadow.capability_key || "", 140) || null,
    },
    outcome: {
      status: finalStatus,
      success_reported: success,
      side_effect_reported: execution.side_effect === true,
      outcome_confirmed: success && (receipt.outcome_confirmed === true || execution.success === true),
      confirmation_required: execution.confirmation_required === true || task.requires_confirmation === true,
    },
    evidence: safeEvidence(resultSources),
    memory_access: {
      policy: clean(memory.policy || memory.receipt?.policy || "explicit_consent_allowlist_v1", 100),
      owner_bound: memory.receipt?.owner_bound === true,
      allowed_count: Math.max(0, Number(memory.receipt?.allowed_count) || 0),
      denied_count: Math.max(0, Number(memory.receipt?.denied_count) || 0),
      memory_ids: Array.isArray(memory.receipt?.memory_ids) ? memory.receipt.memory_ids.map((id) => clean(id, 160)).slice(0, 12) : [],
      storage_available: memory.available === true,
    },
    recovery: {
      receipt_version: clean(recovery.receipt_version || "", 100) || null,
      fallback_count: Math.max(0, Number(recovery.fallback_count) || 0),
      recovered: recovery.recovered === true,
      attempts: (Array.isArray(recovery.attempts) ? recovery.attempts : []).slice(0, 2).map((attempt) => ({
        attempt: Math.max(1, Number(attempt.attempt) || 1),
        provider_id: clean(attempt.provider_id || "", 140) || null,
        capability_key: clean(attempt.capability_key || "", 140) || null,
        status: clean(attempt.status || "unknown", 80),
        success: attempt.success === true,
        failure_code: clean(attempt.failure_code || "", 100) || null,
      })),
    },
    timing: {
      started_at: startedAt ? iso(startedAt) : null,
      completed_at: iso(completedAt),
      duration_ms: startedAt ? Math.max(0, Date.parse(iso(completedAt)) - Date.parse(iso(startedAt))) : null,
    },
  };
}
