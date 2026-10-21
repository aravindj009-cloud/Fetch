import test from "node:test";
import assert from "node:assert/strict";
import { loadFetchAgentMemoryContext, saveFetchAgentMemory } from "./fetch-agent-memory-store.mjs";

const ownerId = "customer-123";

test("fails closed when Supabase server credentials are absent", async () => {
  const result = await loadFetchAgentMemoryContext({ ownerId, agentId: "scout" });
  assert.equal(result.available, false);
  assert.equal(result.items.length, 0);
  assert.equal(result.receipt.allowed_count, 0);
});

test("fails closed when saving without explicit confirmation", async () => {
  const result = await saveFetchAgentMemory({
    ownerId, memoryKey: "preferred_city", memoryValue: "Thiruvananthapuram",
    userConfirmed: false, fetchImpl: async () => { throw new Error("must not call fetch"); },
  });
  assert.equal(result.success, false);
  assert.equal(result.status, "consent_required");
});

test("refuses specialist sharing without separate sharing consent", async () => {
  const result = await saveFetchAgentMemory({
    ownerId, memoryKey: "preferred_city", memoryValue: "Thiruvananthapuram",
    userConfirmed: true, sharingPolicy: "selected_agents", agentIds: ["scout"],
    purposes: ["research"], shareConsentConfirmed: false,
    fetchImpl: async () => { throw new Error("must not call fetch"); },
  });
  assert.equal(result.success, false);
  assert.equal(result.status, "sharing_consent_or_scope_required");
});

test("private memory never issues grant writes and uses upsert safely", async () => {
  const old = process.env.SUPABASE_SECRET_KEY;
  const oldUrl = process.env.SUPABASE_URL;
  process.env.SUPABASE_SECRET_KEY = "test-service-role-secret";
  process.env.SUPABASE_URL = "https://example.supabase.co";
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options.method || "GET", headers: options.headers });
    if ((options.method || "GET") === "GET") return new Response("[]", { status: 200 });
    return new Response(JSON.stringify([{ id: "memory-uuid", owner_id: ownerId, memory_key: "preferred_city" }]), { status: 200 });
  };
  try {
    const result = await saveFetchAgentMemory({
      ownerId, memoryKey: "preferred_city", memoryValue: "Thiruvananthapuram",
      userConfirmed: true, fetchImpl,
    });
    assert.equal(result.success, true);
    assert.equal(result.sharing_policy, "private");
    assert.equal(calls.length, 2);
    assert.match(calls[1].url, /fetch_agent_memory_v1/);
    assert.equal(calls[0].headers.Authorization, "Bearer test-service-role-secret");
  } finally {
    if (old == null) delete process.env.SUPABASE_SECRET_KEY; else process.env.SUPABASE_SECRET_KEY = old;
    if (oldUrl == null) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = oldUrl;
  }
});

test("loads only memory allowed by the owner, agent, purpose, expiry and consent policy", async () => {
  const old = process.env.SUPABASE_SECRET_KEY;
  const oldUrl = process.env.SUPABASE_URL;
  process.env.SUPABASE_SECRET_KEY = "test-service-role-secret";
  process.env.SUPABASE_URL = "https://example.supabase.co";
  const fetchImpl = async (url) => {
    if (url.includes("fetch_agent_memory_v1?")) {
      return new Response(JSON.stringify([{
        id: "m1", owner_id: ownerId, memory_key: "preferred_city",
        memory_value: "Thiruvananthapuram", sensitivity: "ordinary",
        sharing_policy: "selected_agents", shared_agent_ids: ["scout"],
        allowed_purposes: ["research"], consent_granted: true,
        consented_at: "2026-10-20T00:00:00.000Z",
      }]), { status: 200 });
    }
    return new Response(JSON.stringify([{
      id: "g1", owner_id: ownerId, memory_id: "m1", agent_id: "scout",
      purpose: "research", task_id: "", consent_granted: true,
      consented_at: "2026-10-20T00:00:00.000Z",
    }]), { status: 200 });
  };
  try {
    const result = await loadFetchAgentMemoryContext({
      ownerId, agentId: "scout", purpose: "research", fetchImpl,
      now: "2026-10-21T00:00:00.000Z",
    });
    assert.equal(result.available, true);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].value, "Thiruvananthapuram");
    assert.equal(result.receipt.allowed_count, 1);
  } finally {
    if (old == null) delete process.env.SUPABASE_SECRET_KEY; else process.env.SUPABASE_SECRET_KEY = old;
    if (oldUrl == null) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = oldUrl;
  }
});
