import test from "node:test";
import assert from "node:assert/strict";
import { buildFetchAgentMemoryContext, normalizeFetchAgentMemoryItem } from "./fetch-agent-memory-policy.mjs";

const NOW = "2026-10-21T05:00:00.000Z";
const ownerId = "customer-123";
const entry = (overrides = {}) => ({
  id: "m1",
  owner_id: ownerId,
  key: "preferred_city",
  value: "Thiruvananthapuram",
  sensitivity: "ordinary",
  sharing: "selected_agents",
  shared_agent_ids: ["scout"],
  purposes: ["task_execution"],
  consent_granted: true,
  consented_at: "2026-10-20T05:00:00.000Z",
  created_at: "2026-10-20T05:00:00.000Z",
  ...overrides,
});
const grant = (overrides = {}) => ({
  owner_id: ownerId,
  agent_ids: ["scout"],
  memory_ids: ["m1"],
  purposes: ["task_execution"],
  consent_granted: true,
  consented_at: "2026-10-20T05:00:00.000Z",
  expires_at: "2026-11-20T05:00:00.000Z",
  ...overrides,
});

test("shares ordinary memory only when owner, item policy, purpose and explicit grant match", () => {
  const result = buildFetchAgentMemoryContext({
    ownerId, agentId: "scout", purpose: "task_execution",
    entries: [entry()], grants: [grant()], now: NOW,
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].value, "Thiruvananthapuram");
  assert.equal(result.receipt.allowed_count, 1);
  assert.equal(result.receipt.policy, "explicit_consent_allowlist_v1");
});

test("denies sharing by default and denies missing, revoked, expired or wrong-purpose consent", () => {
  const cases = [
    [entry({ sharing: "private" }), grant()],
    [entry({ consent_granted: false }), grant()],
    [entry(), grant({ revoked_at: "2026-10-20T06:00:00.000Z" })],
    [entry({ expires_at: "2026-10-20T06:00:00.000Z" }), grant()],
    [entry(), grant({ purposes: ["research"] })],
    [entry({ owner_id: "someone-else" }), grant()],
  ];
  for (const [memory, permission] of cases) {
    const result = buildFetchAgentMemoryContext({
      ownerId, agentId: "scout", purpose: "task_execution",
      entries: [memory], grants: [permission], now: NOW,
    });
    assert.equal(result.items.length, 0);
    assert.equal(result.receipt.denied_count, 1);
  }
});

test("task-only memory requires a matching task id", () => {
  const result = buildFetchAgentMemoryContext({
    ownerId, agentId: "scout", purpose: "task_execution", taskId: "task-a",
    entries: [entry({ sharing: "task_only" })],
    grants: [grant({ task_id: "task-b" })],
    now: NOW,
  });
  assert.equal(result.items.length, 0);
  assert.equal(result.receipt.denied_reasons.task_scope_mismatch, 1);
});

test("sensitive values and credential-like keys are rejected before delegation", () => {
  assert.equal(normalizeFetchAgentMemoryItem(entry({ key: "api_key", value: "secret" })).valid, false);
  assert.equal(normalizeFetchAgentMemoryItem(entry({ sensitivity: "health_sensitive" })).item.sensitivity, "health_sensitive");
  const result = buildFetchAgentMemoryContext({
    ownerId, agentId: "scout", purpose: "task_execution",
    entries: [entry({ sensitivity: "health_sensitive" })],
    grants: [grant()], now: NOW,
  });
  assert.equal(result.items.length, 0);
});

test("bounds shared memory count and total text size", () => {
  const entries = Array.from({ length: 20 }, (_, i) =>
    entry({ id: "m" + i, key: "fact_" + i, shared_agent_ids: ["scout"], value: "x".repeat(1000) })
  );
  const grants = entries.map((item) => grant({ memory_ids: [item.id] }));
  const result = buildFetchAgentMemoryContext({ ownerId, agentId: "scout", entries, grants, now: NOW });
  assert.ok(result.items.length <= 12);
  assert.ok(result.items.reduce((sum, item) => sum + JSON.stringify(item.value).length + item.key.length, 0) <= 9000);
});
