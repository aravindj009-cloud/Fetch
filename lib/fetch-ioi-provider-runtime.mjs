/*
 * INTERNET OF INTELLIGENCE — PROVIDER EXECUTION HARNESS V1
 *
 * Provider code is injected by trusted application wiring. This module never
 * fetches arbitrary provider endpoints from a manifest and never treats an
 * endpoint URL as executable code.
 *
 * It is a shadow-mode harness for the current Fetch/ATC architecture:
 * callers must explicitly supply registered adapters and capability
 * alternatives. Production routing is not switched to this module yet.
 */

import {
  normalizeIOICapability,
  discoverIOICapabilities,
  buildIOITaskEnvelope,
  buildIOIExecutionReceipt,
} from "./fetch-ioi-contract.mjs";

function clean(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function boundedTimeout(value, fallback = 15000) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(120000, Math.max(100, Math.floor(n)));
}

function normalizeAdapter(adapter = {}) {
  const manifest = asObject(adapter.manifest || adapter.capability);
  const normalized = normalizeIOICapability(manifest, {
    provider_id: adapter.provider_id || adapter.providerId,
    provider_name: adapter.provider_name || adapter.providerName,
    source_registry: "ioi-injected-adapter",
  });

  if (!normalized.valid) {
    return {
      valid: false,
      reason: normalized.reason,
      adapter: null,
      capability: null,
    };
  }

  return {
    valid: true,
    adapter,
    capability: normalized.capability,
  };
}

function resultStatus(result = {}) {
  const status = clean(result.status, 80).toLowerCase();
  if (["completed", "success"].includes(status) && result.success !== false) return "completed";
  if (["awaiting_confirmation", "awaiting_approval", "payment_pending"].includes(status)) return "awaiting_confirmation";
  if (["timeout", "provider_timeout"].includes(status)) return "timeout";
  if (["cancelled", "canceled"].includes(status)) return "cancelled";
  if (["failed", "execution_failed", "error"].includes(status) || result.success === false) return "execution_failed";
  return result.success === true ? "completed" : "execution_failed";
}

function publicFailure(code, message) {
  return {
    success: false,
    status: code,
    error: {
      code,
      message: clean(message || code, 500),
    },
    side_effect: false,
  };
}

/**
 * Execute a selected, injected adapter against an IoI task envelope.
 *
 * Safety guarantees:
 * - it never executes an adapter that is not explicitly supplied;
 * - only an active, matching capability can be selected;
 * - confirmation-required capabilities pause unless approval is explicit;
 * - side effects aren't inferred from a friendly message or route match;
 * - provider deadlines are enforced via AbortSignal and Promise.race;
 * - adapter credentials/endpoints are not copied into the task or receipt.
 */
export async function executeIOITask({
  request = {},
  task = {},
  requiredCapabilities = [],
  adapters = [],
  context = {},
  approvalGranted = false,
  timeoutMs = 15000,
  idempotencyKey = null,
  startedAt = new Date().toISOString(),
} = {}) {
  const rawAdapters = Array.isArray(adapters) ? adapters : [];
  const validAdapters = rawAdapters.map(normalizeAdapter).filter((item) => item.valid);
  const candidateRows = validAdapters.map(({ adapter, capability }) => ({
    ...capability,
    provider_id: capability.provider.id,
    provider_name: capability.provider.name,
    source_registry: "ioi-injected-adapter",
    // Internal-only pointer used after discovery. It is never serialized.
    __adapter: adapter,
  }));

  const discovery = discoverIOICapabilities({
    requiredCapabilities,
    candidates: candidateRows,
    request,
    task,
    region: task?.entities?.region || request?.suppliedContext?.region || null,
  });

  const envelope = buildIOITaskEnvelope({
    request,
    task,
    requiredCapabilities,
    createdAt: startedAt,
  });

  const selected = discovery.selected_capability;
  const selectedCandidate = candidateRows.find((candidate) =>
    candidate.capability_key === selected?.capability_key &&
    candidate.provider_id === selected?.provider?.id
  );
  const adapter = selectedCandidate?.__adapter || null;

  if (!selected || !adapter || typeof adapter.execute !== "function") {
    const failureResult = {
      status: "capability_not_available",
      execution: {
        success: false,
        status: "capability_not_available",
        message: "No active provider adapter matches the required capability.",
        side_effect: false,
      },
    };
    const receipt = buildIOIExecutionReceipt({
      envelope,
      result: failureResult,
      discovery,
      startedAt,
      completedAt: new Date().toISOString(),
    });
    return {
      protocol: "internet-of-intelligence",
      protocol_version: "ioi-task-v1",
      status: "capability_not_available",
      task_envelope: envelope,
      capability_discovery: discovery,
      execution: failureResult.execution,
      receipt,
    };
  }

  const confirmationRequired = Boolean(selected.policy?.requires_confirmation);
  const approved = approvalGranted === true || envelope.authorization.approval_granted === true;

  if (confirmationRequired && !approved) {
    const waiting = {
      status: "awaiting_confirmation",
      execution: {
        success: false,
        status: "awaiting_confirmation",
        message: "This capability requires explicit approval before it can execute.",
        confirmation_required: true,
        side_effect: false,
      },
    };
    return {
      protocol: "internet-of-intelligence",
      protocol_version: "ioi-task-v1",
      status: "awaiting_confirmation",
      task_envelope: {
        ...envelope,
        authorization: {
          ...envelope.authorization,
          confirmation_required: true,
          approval_granted: false,
        },
      },
      capability_discovery: discovery,
      execution: waiting.execution,
      receipt: buildIOIExecutionReceipt({
        envelope: {
          ...envelope,
          authorization: { ...envelope.authorization, confirmation_required: true },
        },
        result: waiting,
        discovery,
        startedAt,
        completedAt: new Date().toISOString(),
      }),
    };
  }

  const timeout = boundedTimeout(timeoutMs);
  const stableKey = clean(
    idempotencyKey ||
    request?.idempotencyKey ||
    envelope.task.task_id ||
    envelope.origin.workflow_id ||
    envelope.trace_id,
    300
  );
  const controller = new AbortController();
  let timer = null;
  const completedStartedAt = Date.now();
  let providerResult;

  try {
    providerResult = await Promise.race([
      Promise.resolve().then(() => adapter.execute({
        task: envelope.task,
        envelope,
        context,
        signal: controller.signal,
        timeout_ms: timeout,
        idempotency_key: stableKey,
      })),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          const error = new Error("Provider execution exceeded " + timeout + " ms.");
          error.code = "provider_timeout";
          reject(error);
        }, timeout);
      }),
    ]);
  } catch (error) {
    const timedOut = error?.code === "provider_timeout" || controller.signal.aborted;
    providerResult = publicFailure(
      timedOut ? "timeout" : "execution_failed",
      error?.message || "Provider execution failed."
    );
  } finally {
    if (timer) clearTimeout(timer);
  }

  const normalizedStatus = resultStatus(providerResult || {});
  const success = providerResult?.success === true && normalizedStatus === "completed";
  const normalizedExecution = {
    success,
    status: normalizedStatus,
    message: clean(providerResult?.message || providerResult?.result?.message || "", 2000) || null,
    execution_type: clean(providerResult?.execution_type || selected.capability_key, 120),
    side_effect: success && providerResult?.side_effect === true,
    confirmation_required: confirmationRequired,
    provider_id: selected.provider.id,
    capability_key: selected.capability_key,
    result: providerResult?.result ?? null,
    sources: Array.isArray(providerResult?.sources) ? providerResult.sources : [],
    error: providerResult?.error?.message || providerResult?.error || null,
  };

  const receiptResult = {
    status: normalizedStatus,
    task: { task_id: envelope.task.task_id },
    workflow_id: envelope.origin.workflow_id,
    sources: normalizedExecution.sources,
    execution: normalizedExecution,
  };

  const receipt = buildIOIExecutionReceipt({
    envelope,
    result: receiptResult,
    discovery,
    startedAt,
    completedAt: new Date().toISOString(),
  });

  return {
    protocol: "internet-of-intelligence",
    protocol_version: "ioi-task-v1",
    status: normalizedStatus,
    task_envelope: envelope,
    capability_discovery: discovery,
    provider: {
      id: selected.provider.id,
      name: selected.provider.name,
      capability_key: selected.capability_key,
    },
    execution: normalizedExecution,
    receipt,
    diagnostics: {
      provider_duration_ms: Math.max(0, Date.now() - completedStartedAt),
      timeout_ms: timeout,
      idempotency_key_present: Boolean(stableKey),
    },
  };
}