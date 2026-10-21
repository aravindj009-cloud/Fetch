/*
 * Bounded provider recovery for IoI.
 *
 * This wrapper retries only when the selected capability declares itself
 * read-only. It excludes each failed provider and re-runs capability discovery
 * against the remaining explicitly injected adapters. It never invents a
 * provider, retries a side effect, or bypasses approval checks.
 */
import { executeIOITask } from "./fetch-ioi-provider-runtime.mjs";

const RETRYABLE_STATUSES = new Set([
  "source_unavailable",
  "rate_limited",
  "timeout",
  "execution_failed",
]);
const MAX_FALLBACKS = 1;

function clean(value, max = 180) {
  return String(value ?? "").trim().slice(0, max);
}
function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function adapterProviderId(adapter) {
  const manifest = asObject(adapter?.manifest || adapter?.capability);
  const provider = asObject(manifest.provider);
  return clean(manifest.provider_id || manifest.providerId || provider.id || adapter?.provider_id || adapter?.providerId, 140);
}
function selectedFrom(result) {
  return asObject(asObject(result?.capability_discovery).selected_capability);
}
function providerIdFrom(result) {
  const selected = selectedFrom(result);
  const provider = asObject(selected.provider);
  return clean(provider.id || result?.provider?.id, 140) || null;
}
function statusFrom(result) {
  return clean(result?.status || result?.execution?.status, 80).toLowerCase() || "unknown";
}
function isConfirmedSuccess(result) {
  return result?.execution?.success === true && statusFrom(result) === "completed";
}
function isReadOnly(selected) {
  const policy = asObject(selected?.policy);
  const sideEffectClass = clean(policy.side_effect_class, 80).toLowerCase();
  return sideEffectClass === "read_only" || sideEffectClass === "none";
}
function errorCodeFrom(result) {
  const execution = asObject(result?.execution);
  const error = asObject(execution.error);
  return clean(error.code || execution.status || result?.status, 100) || "unknown";
}

/**
 * Execute an IoI task and attempt at most one alternative provider if the first
 * provider fails on an explicitly read-only capability.
 *
 * Keep the same task id/idempotency key across attempts. This function returns
 * the normal v1 execution receipt unchanged plus a separate recovery receipt
 * so the strict v1 receipt schema is not silently widened.
 */
export async function executeIOITaskWithRecovery(options = {}) {
  const allAdapters = Array.isArray(options.adapters) ? options.adapters : [];
  const maxFallbacks = Math.max(0, Math.min(MAX_FALLBACKS, Number(options.maxFallbacks ?? MAX_FALLBACKS) || 0));
  let availableAdapters = [...allAdapters];
  const attempts = [];
  let result = null;
  let fallbackCount = 0;

  for (;;) {
    result = await executeIOITask({ ...options, adapters: availableAdapters, maxFallbacks: undefined });
    const selected = selectedFrom(result);
    const providerId = providerIdFrom(result);
    const status = statusFrom(result);
    const success = isConfirmedSuccess(result);

    attempts.push({
      attempt: attempts.length + 1,
      provider_id: providerId,
      capability_key: clean(selected.capability_key || result?.provider?.capability_key, 140) || null,
      status,
      success,
      failure_code: success ? null : errorCodeFrom(result),
    });

    if (success || fallbackCount >= maxFallbacks || !RETRYABLE_STATUSES.has(status)) break;
    if (!selected.capability_key || !isReadOnly(selected)) break;

    const failedProvider = providerId;
    const remaining = availableAdapters.filter((adapter) => {
      const id = adapterProviderId(adapter);
      return !failedProvider || id !== failedProvider;
    });
    if (remaining.length === availableAdapters.length || remaining.length === 0) break;

    // Retry only if another explicitly injected adapter advertises this exact capability.
    const hasAlternative = remaining.some((adapter) => {
      const manifest = asObject(adapter?.manifest || adapter?.capability);
      const advertised = clean(manifest.capability_key || manifest.capability || manifest.key, 140).toLowerCase();
      return advertised === clean(selected.capability_key, 140).toLowerCase();
    });
    if (!hasAlternative) break;

    fallbackCount += 1;
    availableAdapters = remaining;
  }

  const finalStatus = statusFrom(result);
  const finalSuccess = isConfirmedSuccess(result);
  const recoveryReceipt = {
    receipt_version: "fetch-agent-recovery-receipt-v1",
    trace_id: result?.receipt?.trace_id || result?.task_envelope?.trace_id || null,
    task_id: result?.receipt?.task_id || result?.task_envelope?.task?.task_id || null,
    capability_key: clean(selectedFrom(result).capability_key, 140) || null,
    reported_status: finalStatus,
    execution_success_reported: finalSuccess,
    fallback_count: Math.max(0, attempts.length - 1),
    recovered: attempts.length > 1 && finalSuccess,
    attempts: attempts.slice(0, MAX_FALLBACKS + 1),
    final_provider_id: providerIdFrom(result),
  };
  return {
    ...result,
    recovery_receipt: recoveryReceipt,
  };
}
