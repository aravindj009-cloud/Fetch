import test from "node:test";
import assert from "node:assert/strict";
import { executeIOITaskWithRecovery } from "./fetch-ioi-recovery.mjs";

function adapter(providerId, execute, overrides = {}) {
  return {
    manifest: {
      capability_key: "public_lookup",
      provider_id: providerId,
      provider_name: providerId,
      display_name: "Public lookup",
      status: "active",
      resource_type: "public_api",
      domains: ["research"],
      tags: ["lookup"],
      policy: { side_effect_class: "read_only", supports_idempotency: true, ...(overrides.policy || {}) },
    },
    execute,
  };
}
const options = (adapters, extra = {}) => ({
  request: { text: "Look up a public fact" },
  task: { goal: "Look up a public fact", domain: "research" },
  requiredCapabilities: ["public_lookup"],
  adapters,
  timeoutMs: 1500,
  idempotencyKey: "stable-task-key",
  ...extra,
});

test("recovers from a failed read-only provider using one alternative and preserves the attempt receipt", async () => {
  let firstCalls = 0, secondCalls = 0;
  const result = await executeIOITaskWithRecovery(options([
    adapter("provider-a", async () => { firstCalls += 1; return { success: false, status: "source_unavailable", message: "down" }; }),
    adapter("provider-b", async ({ idempotency_key }) => {
      secondCalls += 1;
      assert.equal(idempotency_key, "stable-task-key");
      return { success: true, status: "completed", message: "Found it", result: { value: 42 }, sources: [{ title: "Source", url: "https://example.com" }] };
    }),
  ]));
  assert.equal(firstCalls, 1);
  assert.equal(secondCalls, 1);
  assert.equal(result.status, "completed");
  assert.equal(result.execution.success, true);
  assert.equal(result.recovery_receipt.recovered, true);
  assert.equal(result.recovery_receipt.fallback_count, 1);
  assert.equal(result.recovery_receipt.attempts[0].provider_id, "provider-a");
  assert.equal(result.recovery_receipt.final_provider_id, "provider-b");
});

test("does not retry side-effecting or unspecified capabilities", async () => {
  let first = 0, second = 0;
  const result = await executeIOITaskWithRecovery(options([
    adapter("unsafe-a", async () => { first += 1; return { success: false, status: "execution_failed" }; }, { policy: { side_effect_class: "external_write" } }),
    adapter("unsafe-b", async () => { second += 1; return { success: true, status: "completed" }; }, { policy: { side_effect_class: "external_write" } }),
  ]));
  assert.equal(first, 1);
  assert.equal(second, 0);
  assert.equal(result.recovery_receipt.fallback_count, 0);
  assert.equal(result.recovery_receipt.recovered, false);
});

test("does not retry when there is no alternative provider for the exact capability", async () => {
  let calls = 0;
  const result = await executeIOITaskWithRecovery(options([
    adapter("only-provider", async () => { calls += 1; return { success: false, status: "timeout" }; }),
  ]));
  assert.equal(calls, 1);
  assert.equal(result.status, "timeout");
  assert.equal(result.recovery_receipt.fallback_count, 0);
});

test("does not retry clarification or approval-required outcomes", async () => {
  let calls = 0;
  const requiresApproval = adapter("approval-provider", async () => {
    calls += 1;
    return { success: false, status: "awaiting_confirmation", confirmation_required: true };
  }, { policy: { requires_confirmation: true } });
  const alternative = adapter("approval-provider-b", async () => { calls += 1; return { success: true, status: "completed" }; }, { policy: { requires_confirmation: true } });
  const result = await executeIOITaskWithRecovery(options([requiresApproval, alternative]));
  assert.equal(calls, 0);
  assert.equal(result.status, "awaiting_confirmation");
  assert.equal(result.recovery_receipt.fallback_count, 0);
});
