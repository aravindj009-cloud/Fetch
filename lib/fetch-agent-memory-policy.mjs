/*
 * Fetch agent memory access contract v1.
 *
 * Fail-closed by default. A memory item is never shared with a specialist
 * just because it exists: the owner, per-item sharing policy, explicit
 * grant, purpose, expiry and sensitivity must all permit access.
 *
 * This module is pure. Server-side callers must load items/grants from a
 * trusted source after resolving the customer identity. Never trust
 * memory entries or consent grants supplied directly by a browser request.
 */

const MAX_ITEMS = 12;
const MAX_VALUE_CHARS = 1800;
const MAX_TOTAL_CHARS = 9000;
const BLOCKED_KEY = /password|passcode|secret|credential|token|api.?key|payment|card.?number|cvv|private.?key/i;
const BLOCKED_SENSITIVITY = new Set(["sensitive", "secret", "credential", "financial_secret", "health_sensitive"]);

function clean(value, max = 240) {
  return String(value ?? "").trim().slice(0, max);
}
function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function dateMs(value) {
  const ms = Date.parse(value || "");
  return Number.isFinite(ms) ? ms : null;
}
function isActiveUntil(value, nowMs) {
  if (value == null || value === "") return true;
  const ms = dateMs(value);
  return ms !== null && ms > nowMs;
}
function boundedJsonValue(value, depth = 0) {
  if (depth > 4) return null;
  if (typeof value === "string") return value.slice(0, MAX_VALUE_CHARS);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => boundedJsonValue(item, depth + 1));
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, item] of Object.entries(value).slice(0, 30)) {
      if (BLOCKED_KEY.test(key)) continue;
      result[clean(key, 80)] = boundedJsonValue(item, depth + 1);
    }
    return result;
  }
  return null;
}
function hasScope(list, expected) {
  return Array.isArray(list) && list.map((value) => clean(value, 120)).includes(expected);
}

export function normalizeFetchAgentMemoryItem(raw = {}) {
  const item = asObject(raw);
  const key = clean(item.memory_key || item.key, 120);
  const id = clean(item.id || item.memory_id || key, 160);
  const value = boundedJsonValue(item.memory_value ?? item.value);
  let serialized;
  try { serialized = JSON.stringify(value); } catch { serialized = ""; }
  if (!id || !key || BLOCKED_KEY.test(key) || value === null || !serialized || serialized.length > MAX_VALUE_CHARS) {
    return { valid: false, reason: "invalid_or_sensitive_item" };
  }
  return {
    valid: true,
    item: {
      id,
      owner_id: clean(item.owner_id || item.customer_id, 200),
      key,
      value,
      sensitivity: clean(item.sensitivity || item.memory_sensitivity || "ordinary", 60).toLowerCase(),
      sharing: clean(item.sharing || item.share_policy || "private", 40).toLowerCase(),
      shared_agent_ids: Array.isArray(item.shared_agent_ids || item.allowed_agents)
        ? (item.shared_agent_ids || item.allowed_agents).map((value) => clean(value, 80)).filter(Boolean).slice(0, 20)
        : [],
      purposes: Array.isArray(item.purposes || item.allowed_purposes)
        ? (item.purposes || item.allowed_purposes).map((value) => clean(value, 100)).filter(Boolean).slice(0, 20)
        : [],
      consent_granted: item.consent_granted === true || item.consented === true,
      consented_at: clean(item.consented_at || item.consent_granted_at, 40) || null,
      expires_at: clean(item.expires_at || item.retention_expires_at, 40) || null,
      created_at: clean(item.created_at || item.recorded_at, 40) || null,
      source: clean(item.source || item.source_ref, 240) || null,
    },
  };
}

function assessMemoryAccess({ item, grant, ownerId, agentId, purpose, taskId, nowMs }) {
  if (!ownerId || item.owner_id !== ownerId || grant.owner_id !== ownerId) return "owner_mismatch";
  if (!item.consent_granted || !item.consented_at || !grant.consent_granted || !grant.consented_at) return "consent_missing";
  if (BLOCKED_SENSITIVITY.has(item.sensitivity) || item.sensitivity !== "ordinary") return "sensitivity_blocked";
  if (item.sharing !== "selected_agents" && item.sharing !== "task_only") return "sharing_not_allowed";
  if (!item.shared_agent_ids.includes(agentId) || !hasScope(grant.agent_ids, agentId)) return "agent_not_granted";
  if (!item.purposes.includes(purpose) || !hasScope(grant.purposes, purpose)) return "purpose_not_granted";
  if (!isActiveUntil(item.expires_at, nowMs) || !isActiveUntil(grant.expires_at, nowMs)) return "grant_expired";
  if (item.sharing === "task_only" && (!taskId || clean(grant.task_id, 200) !== taskId)) return "task_scope_mismatch";
  if (grant.revoked_at && dateMs(grant.revoked_at) !== null) return "grant_revoked";
  return null;
}

/**
 * Filter memory for one specialist task. Only trusted server-loaded grants
 * should be passed. Missing consent defaults to no shared memory.
 */
export function buildFetchAgentMemoryContext({
  ownerId = null,
  agentId = "fetch",
  purpose = "task_execution",
  taskId = null,
  entries = [],
  grants = [],
  now = new Date().toISOString(),
} = {}) {
  const owner = clean(ownerId, 200);
  const agent = clean(agentId, 80);
  const task = clean(taskId, 200) || null;
  const accessPurpose = clean(purpose, 100);
  const nowMs = dateMs(now) ?? Date.now();
  const grantList = Array.isArray(grants) ? grants.slice(0, 300).map(asObject) : [];
  const grantByMemory = new Map();
  for (const grant of grantList) {
    const grantOwner = clean(grant.owner_id, 200);
    const agentIds = Array.isArray(grant.agent_ids) ? grant.agent_ids.map((value) => clean(value, 80)) : [];
    const memoryIds = Array.isArray(grant.memory_ids) ? grant.memory_ids.map((value) => clean(value, 160)) : [];
    if (grantOwner !== owner || !agentIds.includes(agent)) continue;
    for (const id of memoryIds) {
      if (!grantByMemory.has(id)) grantByMemory.set(id, []);
      grantByMemory.get(id).push(grant);
    }
  }

  const allowed = [];
  const denied = {};
  let totalChars = 0;
  const candidates = Array.isArray(entries) ? entries.slice(0, 500) : [];
  for (const raw of candidates) {
    const normalized = normalizeFetchAgentMemoryItem(raw);
    if (!normalized.valid) {
      denied[normalized.reason] = (denied[normalized.reason] || 0) + 1;
      continue;
    }
    const item = normalized.item;
    const itemGrants = grantByMemory.get(item.id) || [];
    let reason = "consent_missing";
    let validGrant = null;
    for (const grantRaw of itemGrants) {
      const grant = {
        ...asObject(grantRaw),
        agent_ids: Array.isArray(grantRaw.agent_ids) ? grantRaw.agent_ids : [],
        purposes: Array.isArray(grantRaw.purposes) ? grantRaw.purposes : [],
      };
      reason = assessMemoryAccess({
        item, grant, ownerId: owner, agentId: agent, purpose: accessPurpose, taskId: task, nowMs,
      }) || "";
      if (!reason) { validGrant = grant; break; }
    }
    if (!validGrant) {
      denied[reason || "consent_missing"] = (denied[reason || "consent_missing"] || 0) + 1;
      continue;
    }
    const serializedValue = JSON.stringify(item.value);
    const itemChars = serializedValue.length + item.key.length;
    if (allowed.length >= MAX_ITEMS || totalChars + itemChars > MAX_TOTAL_CHARS) {
      denied["context_limit"] = (denied["context_limit"] || 0) + 1;
      continue;
    }
    allowed.push({
      id: item.id,
      key: item.key,
      value: item.value,
      source: item.source,
      recorded_at: item.created_at,
    });
    totalChars += itemChars;
  }

  return {
    agent_id: agent,
    purpose: accessPurpose,
    task_id: task,
    items: allowed,
    receipt: {
      policy: "explicit_consent_allowlist_v1",
      owner_bound: Boolean(owner),
      requesting_agent_id: agent,
      purpose: accessPurpose,
      task_scoped: Boolean(task),
      allowed_count: allowed.length,
      denied_count: Object.values(denied).reduce((sum, n) => sum + n, 0),
      denied_reasons: denied,
      memory_ids: allowed.map((item) => item.id),
      evaluated_at: new Date(nowMs).toISOString(),
    },
  };
}
