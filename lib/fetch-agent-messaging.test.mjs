import test from "node:test";
import assert from "node:assert/strict";
import {
  createFetchAgentMessenger,
  FETCH_AGENT_HANDOFF_ALLOWLIST,
  FETCH_AGENT_MESSAGE_PROTOCOL,
} from "./fetch-agent-messaging.mjs";

function fixture(overrides = {}) {
  const calls = [];
  const handlers = {
    local_helper: {
      find_providers: {
        sideEffectClass: "read_only",
        async execute({ message }) {
          calls.push({ agent: "local_helper", payload: message.payload });
          return { providers: [{ id: "electrician-1", source: "fixture" }] };
        },
      },
      contact_provider: {
        sideEffectClass: "external_action",
        async execute() { calls.push({ agent: "local_helper", action: "contact_provider" }); return { contacted: true }; },
      },
    },
    scout: {
      verify_provider: {
        sideEffectClass: "read_only",
        async execute({ message }) {
          calls.push({ agent: "scout", payload: message.payload });
          return { evidence: [{ source: "fixture", confidence: "unverified" }] };
        },
      },
    },
    shopper: {
      compare_options: {
        sideEffectClass: "read_only",
        async execute({ message }) {
          calls.push({ agent: "shopper", payload: message.payload });
          return { comparison_complete: true };
        },
      },
    },
  };
  return {
    calls,
    bus: createFetchAgentMessenger({
      handlers,
      idFactory: (prefix) => prefix + "_" + String(calls.length + 1) + "_" + Math.random().toString(36).slice(2, 7),
      ...overrides,
    }),
  };
}

test("agent-to-agent message contract executes an allowlisted specialist capability", async () => {
  const { bus, calls } = fixture();
  const result = await bus.run({
    taskId: "task_electrician_1",
    traceId: "trace_electrician_1",
    toAgent: "local_helper",
    capability: "find_providers",
    payload: { service: "electrician", city: "Thiruvananthapuram" },
  });

  assert.equal(result.protocol, FETCH_AGENT_MESSAGE_PROTOCOL);
  assert.equal(result.status, "completed");
  assert.equal(result.ok, true);
  assert.equal(result.result.providers[0].id, "electrician-1");
  assert.equal(result.trace.message_count, 1);
  assert.equal(result.trace.events[0].from_agent, "fetch");
  assert.equal(result.trace.events[0].to_agent, "local_helper");
  assert.equal(calls.length, 1);
});

test("specialists can delegate to one another and return a parent-linked trace", async () => {
  const calls = [];
  const handlers = {
    local_helper: {
      find_providers: {
        sideEffectClass: "read_only",
        async execute({ delegate }) {
          const scoutResult = await delegate({
            toAgent: "scout",
            capability: "verify_provider",
            payload: { provider_id: "electrician-1", public_listing: true },
          });
          calls.push({ handoffStatus: scoutResult.status });
          return { provider_id: "electrician-1", evidence_status: scoutResult.result?.evidence?.[0]?.confidence };
        },
      },
    },
    scout: {
      verify_provider: {
        sideEffectClass: "read_only",
        async execute({ message }) {
          calls.push({ specialist: message.to_agent, payload: message.payload });
          return { evidence: [{ source: "directory", confidence: "unverified" }] };
        },
      },
    },
  };
  const bus = createFetchAgentMessenger({ handlers });
  const result = await bus.run({
    task_id: "task_handoff_1", to_agent: "local_helper", capability: "find_providers",
    payload: { service: "electrician" },
  });

  assert.equal(result.status, "completed");
  assert.equal(result.result.evidence_status, "unverified");
  assert.equal(result.trace.message_count, 2);
  assert.equal(result.trace.event_count, 2);
  const specialistHandoff = result.trace.events.find((event) => event.from_agent === "local_helper" && event.to_agent === "scout");
  assert.ok(specialistHandoff);
  assert.ok(specialistHandoff.parent_message_id);
  assert.equal(calls[0].specialist, "scout");
});

test("handoff allowlist is explicit and coordinator remains the entry point", async () => {
  const { bus } = fixture();
  const result = await bus.run({
    taskId: "task_disallowed_1", toAgent: "local_helper", capability: "find_providers",
    payload: {},
  });
  assert.ok(FETCH_AGENT_HANDOFF_ALLOWLIST.fetch.includes("local_helper"));
  assert.equal(FETCH_AGENT_HANDOFF_ALLOWLIST.scout.includes("fetch"), false);
  assert.equal(result.status, "completed");
});

test("unknown agent, self handoff and unregistered capabilities fail closed", async () => {
  const { bus } = fixture();
  await assert.rejects(() => bus.run({ taskId: "t", toAgent: "ghost", capability: "read", payload: {} }), /unknown_recipient/);
  const self = await bus.run({ taskId: "t2", toAgent: "local_helper", capability: "find_providers", payload: {} });
  assert.equal(self.status, "completed");
  const blocked = await createFetchAgentMessenger({ handlers: {} }).run({
    taskId: "t3", toAgent: "local_helper", capability: "find_providers", payload: {},
  });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.response.reason, "capability_unavailable");
});

test("write or external-action capabilities require server-side approval", async () => {
  const { bus, calls } = fixture();
  const denied = await bus.run({
    taskId: "task_contact_denied", toAgent: "local_helper", capability: "contact_provider",
    payload: { provider_id: "electrician-1" },
  });
  assert.equal(denied.status, "blocked");
  assert.equal(denied.response.reason, "approval_required");
  assert.equal(calls.length, 0);

  let authzCalls = 0;
  const approvedFixture = fixture({
    authorizeSideEffect: async ({ approval, sideEffectClass }) => {
      authzCalls += 1;
      return approval?.serverApprovalId === "approval-1" && sideEffectClass === "external_action";
    },
  });
  const approved = await approvedFixture.bus.run({
    taskId: "task_contact_approved", toAgent: "local_helper", capability: "contact_provider",
    approval: { serverApprovalId: "approval-1" },
    payload: { provider_id: "electrician-1" },
  });
  assert.equal(authzCalls, 1);
  assert.equal(approved.status, "completed");
});

test("handler errors and timeouts return bounded statuses, never false success", async () => {
  const failed = createFetchAgentMessenger({
    handlers: { scout: { verify: { sideEffectClass: "read_only", async execute() { throw new Error("do not leak"); } } } },
  });
  const failResult = await failed.run({ taskId: "task_fail", toAgent: "scout", capability: "verify", payload: {} });
  assert.equal(failResult.status, "failed");
  assert.equal(failResult.response.reason, "handler_failed");
  assert.equal(JSON.stringify(failResult).includes("do not leak"), false);

  const timedOut = createFetchAgentMessenger({
    timeoutMs: 100,
    handlers: { scout: { slow: { sideEffectClass: "read_only", async execute() { await new Promise((resolve) => setTimeout(resolve, 300)); return { wrong: "late success" }; } } } },
  });
  const timeoutResult = await timedOut.run({ taskId: "task_timeout", toAgent: "scout", capability: "slow", payload: {} });
  assert.equal(timeoutResult.status, "timed_out");
  assert.equal(timeoutResult.ok, false);
  assert.equal(timeoutResult.result, null);
});

test("handoff cycles, duplicate routes and message/depth bounds stop further execution", async () => {
  const cycleBus = createFetchAgentMessenger({
    handlers: {
      local_helper: { lookup: { sideEffectClass: "read_only", async execute({ delegate }) {
        const r = await delegate({ toAgent: "scout", capability: "verify", payload: {} });
        return { nestedStatus: r.status, nestedReason: r.reason };
      } } },
      scout: { verify: { sideEffectClass: "read_only", async execute({ delegate }) {
        const r = await delegate({ toAgent: "local_helper", capability: "lookup", payload: {} });
        return { nestedStatus: r.status, nestedReason: r.reason };
      } } },
    },
  });
  const cycle = await cycleBus.run({ taskId: "task_cycle", toAgent: "local_helper", capability: "lookup", payload: {} });
  assert.equal(cycle.status, "completed");
  assert.equal(cycle.result.nestedStatus, "completed");
  assert.equal(cycle.trace.events.some((event) => event.reason === "handoff_cycle_detected"), true);

  const duplicateBus = createFetchAgentMessenger({
    handlers: {
      local_helper: { lookup: { sideEffectClass: "read_only", async execute({ delegate }) {
        await delegate({ toAgent: "scout", capability: "verify", payload: {} });
        const second = await delegate({ toAgent: "scout", capability: "verify", payload: {} });
        return { secondStatus: second.status, secondReason: second.reason };
      } } },
      scout: { verify: { sideEffectClass: "read_only", async execute() { return { ok: true }; } } },
    },
  });
  const duplicate = await duplicateBus.run({ taskId: "task_duplicate", toAgent: "local_helper", capability: "lookup", payload: {} });
  assert.equal(duplicate.result.secondStatus, "blocked");
  assert.equal(duplicate.result.secondReason, "duplicate_handoff_detected");

  const boundedBus = createFetchAgentMessenger({
    maxMessages: 1,
    handlers: {
      local_helper: { lookup: { sideEffectClass: "read_only", async execute({ delegate }) {
        const nested = await delegate({ toAgent: "scout", capability: "verify", payload: {} });
        return { nestedStatus: nested.status, nestedReason: nested.reason };
      } } },
      scout: { verify: { sideEffectClass: "read_only", async execute() { return { ok: true }; } } },
    },
  });
  const bounded = await boundedBus.run({ taskId: "task_bound", toAgent: "local_helper", capability: "lookup", payload: {} });
  assert.equal(bounded.result.nestedStatus, "blocked");
  assert.equal(bounded.result.nestedReason, "max_message_count_exceeded");
  assert.equal(bounded.trace.message_count, 1);
});

test("JSON payload boundary rejects executable, oversized and unsafe object shapes", async () => {
  const { bus } = fixture();
  const functionPayload = await bus.run({
    taskId: "task_function", toAgent: "local_helper", capability: "find_providers", payload: { run: () => true },
  });
  assert.equal(functionPayload.status, "blocked");
  assert.equal(functionPayload.response.reason, "payload_must_be_json");

  const largePayload = await bus.run({
    taskId: "task_large", toAgent: "local_helper", capability: "find_providers",
    payload: { value: "x".repeat(13000) },
  });
  assert.equal(largePayload.status, "blocked");
  assert.equal(largePayload.response.reason, "payload_too_large");

  const unsafe = JSON.parse('{"__proto__":{"isAdmin":true}}');
  const unsafePayload = await bus.run({
    taskId: "task_unsafe", toAgent: "local_helper", capability: "find_providers", payload: unsafe,
  });
  assert.equal(unsafePayload.status, "blocked");
  assert.equal(unsafePayload.response.reason, "payload_forbidden_key");
});

test("invalid handler output cannot cross the agent boundary as a success", async () => {
  const bus = createFetchAgentMessenger({
    handlers: { scout: { invalid: { sideEffectClass: "read_only", async execute() { return { bad: undefined }; } } } },
  });
  const result = await bus.run({ taskId: "task_invalid_output", toAgent: "scout", capability: "invalid", payload: {} });
  assert.equal(result.status, "failed");
  assert.equal(result.response.reason, "invalid_handler_result");
});

test("parent timeout propagates cancellation to an in-flight child handoff", async () => {
  let childStarted = false;
  let childAborted = false;
  let childSettled = false;
  const bus = createFetchAgentMessenger({
    timeoutMs: 140,
    handlers: {
      local_helper: {
        lookup: {
          sideEffectClass: "read_only",
          async execute({ delegate }) {
            return delegate({ toAgent: "scout", capability: "long_read", payload: { query: "demo" } });
          },
        },
      },
      scout: {
        long_read: {
          sideEffectClass: "read_only",
          async execute({ signal }) {
            childStarted = true;
            await new Promise((resolve) => {
              const settle = () => {
                childAborted = signal.aborted;
                childSettled = true;
                resolve();
              };
              if (signal.aborted) settle();
              else signal.addEventListener("abort", settle, { once: true });
            });
            return { cancelled: childAborted };
          },
        },
      },
    },
  });

  const result = await bus.run({
    taskId: "task_parent_timeout",
    toAgent: "local_helper",
    capability: "lookup",
    payload: {},
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(result.status, "timed_out");
  assert.equal(childStarted, true);
  assert.equal(childAborted, true);
  assert.equal(childSettled, true);
});
