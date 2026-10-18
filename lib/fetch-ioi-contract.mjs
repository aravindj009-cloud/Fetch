/*
 * INTERNET OF INTELLIGENCE — TASK / CAPABILITY / RECEIPT CONTRACT V1
 *
 * This module is intentionally pure: it does not make network calls, execute
 * providers, or mutate the current Fetch/ATC flow. It normalizes the output
 * of the existing executor into a portable contract that future independent
 * providers can implement.
 *
 * Security boundary:
 * - provider endpoints, access tokens, raw metadata, and credentials are never
 *   copied into the public capability descriptor;
 * - a route match is not proof of execution success;
 * - a completed status is not treated as confirmed unless the executor
 *   explicitly reports success;
 * - a side effect is only reported complete when the executor explicitly
 *   reports success and side_effect=true.
 */

export const IOI_PROTOCOL_VERSION = "ioi-task-v1";
export const IOI_CAPABILITY_VERSION = "ioi-capability-v1";
export const IOI_RECEIPT_VERSION = "ioi-execution-receipt-v1";

const ACTIVE_STATES = new Set(["active", "available", "ready", "connected", "matched"]);
const INACTIVE_STATES = new Set(["disabled", "inactive", "revoked", "offline"]);
const PLANNED_STATES = new Set(["planned", "coming_soon", "not_implemented"]);

function text(value, max = 1000) {
  return String(value ?? "").trim().slice(0, max);
}

function stringArray(value, maxItems = 30) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return [...new Set(values.map((item) => text(item, 120)).filter(Boolean))].slice(0, maxItems);
}

function objectOrNull(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function iso(value, fallback = new Date().toISOString()) {
  const date = value ? new Date(value) : new Date(fallback);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function normalizeStatus(value) {
  const status = text(value, 80).toLowerCase();
  if (ACTIVE_STATES.has(status)) return "active";
  if (INACTIVE_STATES.has(status)) return "disabled";
  if (PLANNED_STATES.has(status)) return "planned";
  if (["degraded", "rate_limited", "temporarily_unavailable"].includes(status)) return "degraded";
  return "unknown";
}

function safeWebUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (!["http:", "https:"].includes(url.protocol)) return null;
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_[a-z0-9_]+|fbclid|gclid|trackingid)$/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return null;
  }
}

function sourceDescriptor(source = {}) {
  const url = safeWebUrl(source?.url || source?.link || source?.uri);
  if (!url) return null;
  const publishedValue = source?.published_at || source?.publishedAt || null;
  const publishedTime = publishedValue ? Date.parse(publishedValue) : NaN;
  return {
    uri: url,
    title: text(source?.title || source?.name || source?.label || new URL(url).hostname, 240),
    publisher: text(source?.publisher || source?.source || source?.domain, 160) || null,
    published_at: Number.isFinite(publishedTime) ? new Date(publishedTime).toISOString() : null,
    evidence_type: text(source?.evidence_type || source?.type || "public_web_source", 80),
  };
}

/**
 * Convert a Fetch capability/resource row into a portable IoI capability.
 * Deliberately uses an allowlist: arbitrary database metadata and endpoints
 * do not cross into the interoperable/public trace.
 */
export function normalizeIOICapability(candidate = {}, defaults = {}) {
  const raw = objectOrNull(candidate) || {};
  const provider = objectOrNull(raw.provider) || {};
  const capabilityKey = text(
    raw.capability_key || raw.capability_id || raw.capability ||
    raw.resource_type || raw.type || defaults.capability_key,
    140
  ).toLowerCase();
  const providerId = text(
    raw.provider_id || provider.id || defaults.provider_id ||
    (raw.resource_key ? "fetch-built-in" : ""),
    140
  );
  const status = normalizeStatus(raw.status || raw.connection_status || defaults.status);

  if (!capabilityKey || !providerId) {
    return {
      valid: false,
      reason: !capabilityKey ? "capability_key_missing" : "provider_id_missing",
      capability: null,
    };
  }

  const metadata = objectOrNull(raw.metadata) || {};
  const trust = objectOrNull(raw.trust) || {};
  const costBand = text(raw.cost_band || metadata.cost_band || defaults.cost_band, 40);
  const latencyValue = Number(raw.latency_ms ?? metadata.latency_ms ?? defaults.latency_ms);
  const latencyMs = Number.isFinite(latencyValue) && latencyValue >= 0 ? latencyValue : null;

  return {
    valid: true,
    capability: {
      manifest_version: IOI_CAPABILITY_VERSION,
      capability_key: capabilityKey,
      version: text(raw.version || raw.capability_version || defaults.version || "1.0.0", 40),
      provider: {
        id: providerId,
        name: text(raw.provider_name || provider.name || raw.owner_name || defaults.provider_name || "Unnamed provider", 160),
      },
      display_name: text(raw.display_name || raw.name || raw.label || capabilityKey, 180),
      resource_type: text(raw.resource_type || raw.type || defaults.resource_type, 100) || null,
      status,
      domains: stringArray(raw.domains || raw.supported_domains || defaults.domains),
      tags: stringArray(raw.tags || raw.capabilities || defaults.tags),
      execution_modes: stringArray(raw.execution_modes || raw.modes || defaults.execution_modes),
      input_schema: objectOrNull(raw.input_schema) || null,
      output_schema: objectOrNull(raw.output_schema) || null,
      policy: {
        requires_confirmation: Boolean(raw.requires_confirmation ?? raw.policy?.requires_confirmation ?? defaults.requires_confirmation ?? false),
        supports_idempotency: Boolean(raw.supports_idempotency ?? raw.policy?.supports_idempotency ?? defaults.supports_idempotency ?? false),
        side_effect_class: text(raw.side_effect_class || raw.policy?.side_effect_class || defaults.side_effect_class || "unspecified", 80),
      },
      trust: {
        level: text(trust.level || raw.trust_level || defaults.trust_level || "unknown", 40).toLowerCase(),
        verified: trust.verified === true || raw.verified === true,
        evidence_count: Math.max(0, Number(trust.evidence_count ?? raw.evidence_count ?? 0) || 0),
      },
      cost_band: costBand || null,
      latency_ms: latencyMs,
      region: text(raw.region || metadata.region || defaults.region, 80) || null,
      source_registry: text(raw.source_registry || defaults.source_registry || "unspecified", 80),
    },
  };
}

function requestedCapabilityKeys(requiredCapabilities = []) {
  const values = Array.isArray(requiredCapabilities) ? requiredCapabilities : [requiredCapabilities];
  return [...new Set(values.map((item) => {
    if (typeof item === "string") return text(item, 140).toLowerCase();
    return text(item?.capability_key || item?.capability || item?.key, 140).toLowerCase();
  }).filter(Boolean))];
}

function taskKeywords(request = {}, task = {}) {
  const source = [
    request?.text, task?.user_request, task?.goal, task?.objective,
    task?.domain, task?.intent?.domain, task?.intent?.action,
  ].map((value) => text(value, 500)).join(" ").toLowerCase();
  return new Set(source.replace(/[^a-z0-9._ -]/g, " ").split(/\s+/).filter((word) => word.length >= 3));
}

/**
 * Rank already-discovered candidates against explicit required capability
 * alternatives. This does not query the internet or call provider endpoints.
 * Candidate discovery remains the responsibility of Fetch's registry/ATC.
 */
export function discoverIOICapabilities({
  requiredCapabilities = [],
  candidates = [],
  request = {},
  task = {},
  region = null,
} = {}) {
  const required = requestedCapabilityKeys(requiredCapabilities);
  const words = taskKeywords(request, task);
  const normalized = (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => normalizeIOICapability(candidate, {
      provider_id: candidate?.provider_id || candidate?.provider?.id || "fetch-built-in",
      source_registry: candidate?.source_registry || "fetch-runtime",
    }))
    .filter((item) => item.valid)
    .map((item) => {
      const capability = item.capability;
      const exactMatch = required.length === 0 || required.includes(capability.capability_key);
      const hasWildcard = capability.tags.includes("*") || capability.tags.includes("any");
      const domainMatch = [task?.domain, task?.intent?.domain]
        .map((value) => text(value, 100).toLowerCase())
        .filter(Boolean)
        .some((domain) => capability.domains.some((candidateDomain) => candidateDomain.toLowerCase() === domain));
      const tagOverlap = capability.tags.filter((tag) => words.has(tag.toLowerCase())).length;
      const regionMatch = !region || !capability.region || capability.region.toLowerCase() === String(region).toLowerCase();
      const active = capability.status === "active";
      // When the task names required alternatives, capability-key matching
      // is strict: overlapping words alone must not route a task to an
      // unrelated provider. Semantic tags help only when no explicit
      // capability alternatives were specified.
      const compatible = active && (
        required.length > 0
          ? exactMatch
          : (hasWildcard || domainMatch || tagOverlap > 0)
      );
      const score =
        (active ? 20 : 0) +
        (required.includes(capability.capability_key) ? 100 : required.length === 0 ? 10 : 0) +
        (hasWildcard ? 5 : 0) +
        (domainMatch ? 20 : 0) +
        Math.min(tagOverlap, 10) * 3 +
        (capability.trust.verified ? 5 : 0) +
        (regionMatch ? 2 : -40);

      return {
        capability,
        compatible,
        score: compatible ? score : null,
        match_reasons: [
          ...(required.includes(capability.capability_key) ? ["exact_capability"] : []),
          ...(hasWildcard ? ["wildcard_support"] : []),
          ...(domainMatch ? ["domain_match"] : []),
          ...(tagOverlap ? ["tag_overlap"] : []),
          ...(regionMatch ? ["region_compatible"] : []),
        ],
      };
    });

  const ranked = normalized
    .filter((item) => item.compatible)
    .sort((a, b) => b.score - a.score || a.capability.capability_key.localeCompare(b.capability.capability_key));
  const selected = ranked[0] || null;

  return {
    discovery_contract: "ioi-capability-discovery-v1",
    status: selected ? "candidate_selected" : normalized.length ? "no_compatible_candidate" : "no_candidates",
    strategy: "fetch_registry_and_atc_candidates",
    required_capabilities: required,
    candidates_examined: normalized.length,
    candidates: normalized
      .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity))
      .slice(0, 20),
    selected_capability: selected?.capability || null,
    selected_score: selected?.score ?? null,
  };
}

/**
 * Build a transport-neutral task envelope from the current Fetch universal
 * task. Side-effect policy is descriptive and points back to the existing
 * Fetch risk/approval gate; this module does not grant permissions.
 */
export function buildIOITaskEnvelope({
  request = {},
  task = {},
  requiredCapabilities = [],
  createdAt = new Date().toISOString(),
} = {}) {
  const raw = objectOrNull(task) || {};
  const suppliedContext = objectOrNull(request?.suppliedContext) || {};
  const taskId = text(raw.task_id || raw.id || request?.activeTaskId, 200) || null;
  const workflowId = text(raw.workflow_id || raw.workflowId, 200) || null;
  const required = requestedCapabilityKeys(requiredCapabilities);
  const confirmationRequired = Boolean(raw.requires_confirmation || raw.risk?.approval_required || raw.metadata?.approval_required);

  return {
    protocol: "internet-of-intelligence",
    protocol_version: IOI_PROTOCOL_VERSION,
    trace_id: String(taskId || workflowId || "ioi-task") + ":" + iso(createdAt),
    created_at: iso(createdAt),
    origin: {
      application: "fetch",
      channel: text(raw.channel || request?.channel || "unknown", 80),
      conversation_id: text(raw.conversation_id || request?.conversationId || "", 200) || null,
      workflow_id: workflowId,
      upstream_contract: text(raw.contract_version || "fetch-task-v1", 80),
    },
    task: {
      task_id: taskId,
      parent_task_id: text(raw.parent_task_id || request?.activeTaskId, 200) || null,
      user_request: text(raw.user_request || request?.text, 8000),
      goal: text(raw.goal || raw.intent?.goal || request?.text, 2000),
      objective: text(raw.objective || raw.goal || request?.text, 2000),
      intent: {
        domain: text(raw.intent?.domain || raw.domain, 120) || null,
        action: text(raw.intent?.action, 120) || null,
      },
      priority: text(raw.priority || "normal", 40),
    },
    requirements: {
      capability_alternatives: required,
      execution_mode: text(raw.workflow?.execution_mode, 80) || null,
      region: text(raw.entities?.region || suppliedContext?.region, 100) || null,
      deadline: raw.entities?.deadline ? text(raw.entities.deadline, 100) : null,
    },
    authorization: {
      confirmation_required: confirmationRequired,
      approval_granted: suppliedContext.approval_granted === true,
      enforcement: "fetch-risk-engine",
      side_effect_policy: "existing-fetch-policy",
    },
    lifecycle: {
      reported_status: text(raw.status || "requested", 80).toLowerCase(),
      current_step: text(raw.current_step || raw.workflow?.step_key, 120) || null,
      attempt: Math.max(0, Number(raw.attempt || raw.retry_count || 0) || 0),
    },
    provenance: {
      created_by: "fetch-universal-execution",
      source: text(raw.metadata?.source || "fetch-runtime", 120),
      routing_source: text(raw.metadata?.routing_override || "fetch-v9-atc", 120),
    },
  };
}

function extractEvidence(result = {}) {
  const execution = objectOrNull(result?.execution) || {};
  const innerExecution = objectOrNull(execution.execution) || {};
  const research = objectOrNull(execution.research) || {};
  const candidates = [
    ...(Array.isArray(result?.sources) ? result.sources : []),
    ...(Array.isArray(execution?.sources) ? execution.sources : []),
    ...(Array.isArray(research?.sources) ? research.sources : []),
    ...(Array.isArray(innerExecution?.sources) ? innerExecution.sources : []),
  ];
  const seen = new Set();
  const evidence = [];
  for (const candidate of candidates) {
    const item = sourceDescriptor(candidate);
    if (!item || seen.has(item.uri)) continue;
    seen.add(item.uri);
    evidence.push(item);
    if (evidence.length >= 20) break;
  }
  return evidence;
}

/**
 * A receipt reports what the adapter explicitly returned; it never infers a
 * successful action from a route match, friendly message, or HTTP 200 alone.
 */
export function buildIOIExecutionReceipt({
  envelope,
  result = {},
  discovery = null,
  startedAt = null,
  completedAt = new Date().toISOString(),
} = {}) {
  const execution = objectOrNull(result?.execution) || {};
  const innerExecution = objectOrNull(execution.execution) || {};
  const effectiveExecution = Object.keys(innerExecution).length ? innerExecution : execution;
  const rawStatus = text(result?.status || effectiveExecution?.status || "unknown", 100).toLowerCase();
  const executionSuccess = effectiveExecution.success === true || execution.success === true;
  const statusSaysCompleted = ["completed", "success"].includes(rawStatus);
  const outcomeConfirmed = executionSuccess && statusSaysCompleted;
  const sideEffectReported = effectiveExecution.side_effect === true || execution.side_effect === true;
  const evidence = extractEvidence(result);
  const selected = discovery?.selected_capability || null;
  const error = text(effectiveExecution.error || (["failed", "execution_failed", "error", "cancelled", "timeout"].includes(rawStatus) ? effectiveExecution.message || result?.message : ""), 500) || null;

  return {
    receipt_version: IOI_RECEIPT_VERSION,
    trace_id: envelope?.trace_id || null,
    task_id: envelope?.task?.task_id || result?.task?.task_id || null,
    workflow_id: envelope?.origin?.workflow_id || result?.workflow_id || null,
    reported_status: rawStatus,
    execution_success_reported: executionSuccess,
    outcome_confirmed: outcomeConfirmed,
    side_effect_completed: outcomeConfirmed && sideEffectReported,
    confirmation_required: Boolean(envelope?.authorization?.confirmation_required || effectiveExecution?.confirmation_required || execution?.confirmation_required),
    capability_key: selected?.capability_key || null,
    provider_id: selected?.provider?.id || null,
    evidence,
    evidence_count: evidence.length,
    failure: ["execution_failed", "failed", "error", "cancelled", "timeout"].includes(rawStatus)
      ? { code: text(effectiveExecution.status || rawStatus, 100), message: error }
      : null,
    timing: {
      started_at: startedAt ? iso(startedAt) : null,
      completed_at: iso(completedAt),
      duration_ms: startedAt ? Math.max(0, Date.parse(iso(completedAt)) - Date.parse(iso(startedAt))) : null,
    },
  };
}

/**
 * Add a portable IoI view to the existing Fetch result. All original fields
 * remain unchanged so current clients continue to work during migration.
 */
export function attachIOITrace({
  request = {},
  result = {},
  startedAt = null,
  completedAt = new Date().toISOString(),
} = {}) {
  const safeResult = objectOrNull(result) || {};
  const task = objectOrNull(safeResult.task) || {};
  const atc = objectOrNull(safeResult.atc) || {};
  const capabilityDecision = objectOrNull(safeResult.capability) || {};
  const capabilityObject = objectOrNull(capabilityDecision.capability) || objectOrNull(task.capability) || null;

  const requiredCapabilities = requestedCapabilityKeys([
    capabilityObject?.capability_key,
    task.resource?.capability_key,
    atc.capability,
    task.execution_network,
    task.resource?.type,
  ]);

  const candidates = [];
  if (capabilityObject) {
    candidates.push({
      ...capabilityObject,
      provider_id: capabilityObject.provider_id || capabilityObject.provider?.id || "fetch-capability-registry",
      source_registry: "fetch-capability-registry",
    });
  }

  if (objectOrNull(atc.resource)) {
    candidates.push({
      ...atc.resource,
      capability_key: atc.capability || atc.resource.capability_key || atc.resource.resource_type,
      provider_id: atc.provider_id || atc.resource.provider_id || atc.resource.provider?.id || atc.resource.id || "fetch-atc",
      display_name: atc.display_name || atc.resource.display_name || atc.resource.name,
      status: atc.resource.status || atc.status,
      source_registry: "fetch-atc",
    });
  }

  if (!candidates.length) {
    const resourceType = text(atc.resource_type || task.resource?.type || task.execution_network, 120);
    if (resourceType) {
      const currentStatus = atc.status === "matched" || safeResult.status === "completed"
        ? "active"
        : safeResult.status === "execution_failed" || safeResult.status === "failed"
          ? "degraded"
          : "unknown";
      candidates.push({
        capability_key: atc.capability || task.resource?.capability_key || resourceType,
        provider_id: atc.provider_id || task.resource?.provider_id || "fetch-built-in",
        provider_name: atc.display_name || task.resource?.name || "Fetch built-in capability",
        display_name: atc.display_name || task.resource?.name || resourceType,
        resource_type: resourceType,
        status: currentStatus,
        tags: task.resource?.capabilities || [],
        domains: [task.domain, task.intent?.domain].filter(Boolean),
        source_registry: "fetch-runtime",
      });
    }
  }

  const discovery = discoverIOICapabilities({
    requiredCapabilities,
    candidates,
    request,
    task,
    region: task.entities?.region || request?.suppliedContext?.region || null,
  });

  const envelope = buildIOITaskEnvelope({
    request,
    task,
    requiredCapabilities,
    createdAt: startedAt || completedAt,
  });

  const receipt = buildIOIExecutionReceipt({
    envelope,
    result: safeResult,
    discovery,
    startedAt,
    completedAt,
  });

  return {
    ...safeResult,
    ioi: {
      protocol_version: IOI_PROTOCOL_VERSION,
      capability_discovery: discovery,
      task_envelope: envelope,
      execution_receipt: receipt,
    },
  };
}