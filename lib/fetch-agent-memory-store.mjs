/*
 * Server-only persistence helpers for Fetch's permission-aware specialist memory.
 * Never import this module into browser code. Supabase service credentials stay
 * server-side; rows are owner-scoped and shared only after an explicit grant.
 */
import { buildFetchAgentMemoryContext } from "./fetch-agent-memory-policy.mjs";

const DEFAULT_URL = "https://skfxzagxlxputwpwxwbe.supabase.co";
const MEMORY_TABLE = "fetch_agent_memory_v1";
const GRANT_TABLE = "fetch_agent_memory_grants_v1";
const SAFE_KEY = /^[a-z0-9][a-z0-9_.:-]{0,119}$/i;
const SAFE_AGENT = /^[a-z0-9_-]{1,80}$/i;
const SAFE_OWNER = /^[a-zA-Z0-9:_-]{1,200}$/;
const ALLOWED_SENSITIVITY = new Set(["ordinary", "sensitive", "secret", "credential", "financial_secret", "health_sensitive"]);
const ALLOWED_SHARING = new Set(["private", "selected_agents", "task_only"]);

function clean(value, max = 240) {
  return String(value ?? "").trim().slice(0, max);
}
function asArray(value, max = 50) {
  return Array.isArray(value) ? value.slice(0, max) : [];
}
function serverConfig() {
  const env = typeof process !== "undefined" ? process.env || {} : {};
  const url = clean(env.SUPABASE_URL || env.VITE_SUPABASE_URL || DEFAULT_URL, 500).replace(/\/+$/, "");
  const key = clean(env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE || "", 5000);
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url) || !key) return null;
  return { url, key };
}
async function rest(config, table, query, { method = "GET", body, prefer } = {}, fetchImpl = globalThis.fetch) {
  const url = config.url + "/rest/v1/" + table + (query ? "?" + query : "");
  const headers = {
    apikey: config.key,
    Authorization: "Bearer " + config.key,
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (prefer) headers.Prefer = prefer;
  const response = await fetchImpl(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
  if (!response.ok) {
    const error = new Error("memory_store_http_" + response.status);
    error.status = response.status;
    throw error;
  }
  return data;
}
function failClosed(agentId, purpose, taskId, errorCode) {
  return {
    agent_id: agentId,
    purpose,
    task_id: taskId,
    items: [],
    available: false,
    error_code: errorCode,
    receipt: {
      policy: "explicit_consent_allowlist_v1",
      owner_bound: false,
      requesting_agent_id: agentId,
      purpose,
      task_scoped: Boolean(taskId),
      allowed_count: 0,
      denied_count: 0,
      denied_reasons: {},
      memory_ids: [],
      evaluated_at: new Date().toISOString(),
      storage_available: false,
      error_code: errorCode,
    },
  };
}
function buildQuery(params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) query.set(key, value);
  return query.toString();
}

/**
 * Read shared memory for one specialist. Owner identity must be resolved by
 * the server (not copied unvalidated from the browser's JSON request).
 */
export async function loadFetchAgentMemoryContext({
  ownerId,
  agentId,
  purpose = "task_execution",
  taskId = null,
  fetchImpl = globalThis.fetch,
  now = new Date().toISOString(),
} = {}) {
  const owner = clean(ownerId, 200);
  const agent = clean(agentId, 80);
  const accessPurpose = clean(purpose, 100);
  const task = clean(taskId, 200) || null;
  if (!owner || !SAFE_OWNER.test(owner) || !SAFE_AGENT.test(agent) || !accessPurpose) {
    return failClosed(agent, accessPurpose, task, "trusted_owner_or_scope_missing");
  }
  const config = serverConfig();
  if (!config || typeof fetchImpl !== "function") {
    return failClosed(agent, accessPurpose, task, "memory_store_not_configured");
  }
  try {
    const ownerFilter = "eq." + owner;
    const memoryQuery = buildQuery({
      select: "id,owner_id,memory_key,memory_value,sensitivity,sharing_policy,shared_agent_ids,allowed_purposes,consent_granted,consented_at,expires_at,created_at,source_ref",
      owner_id: ownerFilter,
      consent_granted: "eq.true",
      sharing_policy: "in.(selected_agents,task_only)",
      order: "created_at.desc",
      limit: "500",
    });
    const grantQuery = buildQuery({
      select: "id,owner_id,memory_id,agent_id,purpose,task_id,consent_granted,consented_at,expires_at,revoked_at",
      owner_id: ownerFilter,
      agent_id: "eq." + agent,
      consent_granted: "eq.true",
      order: "created_at.desc",
      limit: "1000",
    });
    const [rawItems, rawGrants] = await Promise.all([
      rest(config, MEMORY_TABLE, memoryQuery, {}, fetchImpl),
      rest(config, GRANT_TABLE, grantQuery, {}, fetchImpl),
    ]);
    const entries = asArray(rawItems, 500).map((item) => ({
      id: item.id,
      owner_id: item.owner_id,
      memory_key: item.memory_key,
      memory_value: item.memory_value,
      sensitivity: item.sensitivity,
      sharing: item.sharing_policy,
      shared_agent_ids: item.shared_agent_ids,
      purposes: item.allowed_purposes,
      consent_granted: item.consent_granted,
      consented_at: item.consented_at,
      expires_at: item.expires_at,
      created_at: item.created_at,
      source: item.source_ref,
    }));
    const grants = asArray(rawGrants, 1000).map((grant) => ({
      id: grant.id,
      owner_id: grant.owner_id,
      memory_ids: [grant.memory_id],
      agent_ids: [grant.agent_id],
      purposes: [grant.purpose],
      task_id: grant.task_id || "",
      consent_granted: grant.consent_granted,
      consented_at: grant.consented_at,
      expires_at: grant.expires_at,
      revoked_at: grant.revoked_at,
    }));
    const context = buildFetchAgentMemoryContext({
      ownerId: owner,
      agentId: agent,
      purpose: accessPurpose,
      taskId: task,
      entries,
      grants,
      now,
    });
    return { ...context, available: true, error_code: null };
  } catch (error) {
    // Do not log customer IDs, memory values, grants or credentials.
    console.warn("FETCH AGENT MEMORY STORE UNAVAILABLE:", clean(error?.message || "memory_store_error", 100));
    return failClosed(agent, accessPurpose, task, error?.status ? "memory_store_http_" + error.status : "memory_store_error");
  }
}

/**
 * Save a user-confirmed memory. Private is the default. Sharing is enabled only
 * when the caller separately confirms sharing and supplies explicit agents and
 * purposes. The caller must obtain user consent and provide a server-resolved
 * owner identity before invoking this function.
 */
export async function saveFetchAgentMemory({
  ownerId,
  memoryKey,
  memoryValue,
  sensitivity = "ordinary",
  sharingPolicy = "private",
  agentIds = [],
  purposes = [],
  expiresAt = null,
  sourceRef = null,
  userConfirmed = false,
  shareConsentConfirmed = false,
  taskId = null,
  fetchImpl = globalThis.fetch,
  now = new Date().toISOString(),
} = {}) {
  const owner = clean(ownerId, 200);
  const key = clean(memoryKey, 120);
  const sensitivityValue = clean(sensitivity, 60).toLowerCase();
  const sharing = clean(sharingPolicy, 40).toLowerCase();
  const agents = [...new Set(asArray(agentIds, 20).map((value) => clean(value, 80)).filter((value) => SAFE_AGENT.test(value)))];
  const allowedPurposes = [...new Set(asArray(purposes, 20).map((value) => clean(value, 100)).filter(Boolean))];
  const task = clean(taskId, 200);
  if (userConfirmed !== true) return { success: false, status: "consent_required", message: "Saving a memory requires explicit user confirmation." };
  if (!owner || !SAFE_OWNER.test(owner) || !SAFE_KEY.test(key)) return { success: false, status: "invalid_owner_or_key" };
  if (!ALLOWED_SENSITIVITY.has(sensitivityValue) || !ALLOWED_SHARING.has(sharing)) return { success: false, status: "invalid_memory_policy" };
  if (sharing !== "private" && (
    shareConsentConfirmed !== true || sensitivityValue !== "ordinary" ||
    !agents.length || !allowedPurposes.length ||
    (sharing === "task_only" && !task)
  )) {
    return { success: false, status: "sharing_consent_or_scope_required" };
  }
  const config = serverConfig();
  if (!config || typeof fetchImpl !== "function") return { success: false, status: "memory_store_not_configured" };
  const checked = {
    id: key,
    owner_id: owner,
    memory_key: key,
    memory_value: memoryValue,
    sensitivity: sensitivityValue,
    sharing: sharing,
    shared_agent_ids: sharing === "private" ? [] : agents,
    purposes: sharing === "private" ? [] : allowedPurposes,
    consent_granted: sharing !== "private",
    consented_at: sharing !== "private" ? now : null,
    created_at: now,
    source: sourceRef,
  };
  const normalized = (await import("./fetch-agent-memory-policy.mjs")).normalizeFetchAgentMemoryItem(checked);
  if (!normalized.valid) return { success: false, status: "invalid_or_sensitive_memory" };

  try {
    // Revoke grants first. If a subsequent write fails, the state is private /
    // non-shareable rather than retaining permissions the user meant to change.
    const lookupQuery = buildQuery({
      select: "id",
      owner_id: "eq." + owner,
      memory_key: "eq." + key,
      limit: "1",
    });
    const existingRows = await rest(config, MEMORY_TABLE, lookupQuery, {}, fetchImpl);
    const existingId = Array.isArray(existingRows) ? existingRows[0]?.id : null;
    if (existingId) {
      const deleteGrantsQuery = buildQuery({ owner_id: "eq." + owner, memory_id: "eq." + existingId });
      await rest(config, GRANT_TABLE, deleteGrantsQuery, { method: "DELETE" }, fetchImpl);
    }
    const payload = {
      owner_id: owner,
      memory_key: key,
      memory_value: normalized.item.value,
      sensitivity: sensitivityValue,
      sharing_policy: sharing,
      shared_agent_ids: sharing === "private" ? [] : agents,
      allowed_purposes: sharing === "private" ? [] : allowedPurposes,
      consent_granted: sharing !== "private",
      consented_at: sharing !== "private" ? now : null,
      expires_at: expiresAt || null,
      source_ref: clean(sourceRef, 500) || null,
      updated_at: now,
    };
    const upsertQuery = buildQuery({ on_conflict: "owner_id,memory_key", select: "id,owner_id,memory_key,created_at" });
    const rows = await rest(config, MEMORY_TABLE, upsertQuery, {
      method: "POST",
      body: payload,
      prefer: "resolution=merge-duplicates,return=representation",
    }, fetchImpl);
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row?.id) throw new Error("memory_store_missing_id");

    if (sharing !== "private") {
      try {
        const grants = agents.flatMap((agent) => allowedPurposes.map((purposeValue) => ({
          owner_id: owner,
          memory_id: row.id,
          agent_id: agent,
          purpose: purposeValue,
          task_id: sharing === "task_only" ? task : "",
          consent_granted: true,
          consented_at: now,
          expires_at: expiresAt || null,
          revoked_at: null,
        })));
        await rest(config, GRANT_TABLE, buildQuery({ on_conflict: "memory_id,agent_id,purpose,task_id" }), {
          method: "POST",
          body: grants,
          prefer: "resolution=merge-duplicates,return=minimal",
        }, fetchImpl);
      } catch {
        // Fail closed on partial write: revoke all newly-created grants and make
        // the memory private before returning an error.
        try {
          await rest(config, GRANT_TABLE, buildQuery({ owner_id: "eq." + owner, memory_id: "eq." + row.id }), { method: "DELETE" }, fetchImpl);
          await rest(config, MEMORY_TABLE, buildQuery({ id: "eq." + row.id }), {
            method: "PATCH",
            body: {
              sharing_policy: "private",
              shared_agent_ids: [],
              allowed_purposes: [],
              consent_granted: false,
              consented_at: null,
              updated_at: now,
            },
            prefer: "return=minimal",
          }, fetchImpl);
        } catch {}
        return { success: false, status: "sharing_write_failed_private", message: "The memory was not shared because permissions could not be saved." };
      }
    }
    return { success: true, status: "saved", memory_id: row.id, sharing_policy: sharing };
  } catch (error) {
    return { success: false, status: error?.status ? "memory_store_http_" + error.status : "memory_store_error" };
  }
}
