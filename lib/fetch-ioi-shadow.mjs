/*
 * Fetch → IoI shadow evaluator.
 *
 * This module runs only explicitly supported read-only capabilities. It does
 * not replace the existing answer, persist shadow output, or execute side
 * effects. Caller must opt in (the universal executor gates it by env var).
 */

import { executeIOITask } from "./fetch-ioi-provider-runtime.mjs";
import {
  createOpenMeteoAirQualityAdapter,
  createOpenMeteoWeatherAdapter,
} from "./fetch-ioi-open-meteo-adapters.mjs";

function clean(value, max = 400) {
  return String(value ?? "").trim().slice(0, max);
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function copyLocationContext(input = {}) {
  const raw = asObject(input);
  const profile = asObject(raw.profile || raw.user_profile || raw.location_profile);
  const chosen = asObject(raw.location || raw.user_location || raw.coordinates);

  // Deliberately allowlist location hints; never copy auth/session material,
  // phone numbers, full profile blobs, or arbitrary connector metadata.
  const result = {};
  const latitude = chosen.latitude ?? chosen.lat ?? raw.latitude ?? raw.lat ?? profile.latitude ?? profile.lat;
  const longitude = chosen.longitude ?? chosen.lon ?? raw.longitude ?? raw.lon ?? profile.longitude ?? profile.lon;
  if (latitude !== undefined && longitude !== undefined) {
    result.latitude = latitude;
    result.longitude = longitude;
  }

  const city = clean(
    chosen.city || chosen.name || raw.city || raw.location_name ||
    profile.city || profile.location_name || "",
    160
  );
  const state = clean(chosen.admin1 || chosen.state || raw.state || profile.state || "", 120);
  const country = clean(chosen.country || raw.country || profile.country || "", 120);
  const timezone = clean(chosen.timezone || raw.timezone || profile.timezone || "", 100);
  if (city) result.city = city;
  if (state) result.state = state;
  if (country) result.country = country;
  if (timezone) result.timezone = timezone;

  const latitudePresent = result.latitude !== undefined && result.longitude !== undefined;
  if (latitudePresent && chosen.name) result.locationName = clean(chosen.name, 180);

  return result;
}

export function classifyIOIReadOnlyIntent(value = "") {
  const text = clean(value, 4000);
  if (!text) return null;

  if (/\b(aqi|air[\s-]?quality|air[\s-]?pollution|pm\s*2\.?5|pm\s*10|particulate(?:\s+matter)?)\b/i.test(text)) {
    return "air_quality_current";
  }

  if (/\b(weather|forecast|temperature|will\s+it\s+rain|rain(?:ing)?|humidity|wind\s+speed|sunrise|sunset)\b/i.test(text)) {
    return "weather_forecast";
  }

  if (
    /\bhow\s+does\s+it\s+look(?:s)?(?:\s+like)?\b/i.test(text) &&
    /\b(?:today|tomorrow|tonight|right\s+now|now|this\s+morning|this\s+afternoon|this\s+evening)\b/i.test(text) &&
    /\b(?:in|for|at|around|near)\s+[a-z][a-z .'-]{1,80}\b/i.test(text)
  ) {
    return "weather_forecast";
  }

  return null;
}

function baselineSummary(existingResult = {}) {
  const task = asObject(existingResult.task);
  const execution = asObject(existingResult.execution);
  const status = clean(existingResult.status || task.status || execution.status || "unknown", 80).toLowerCase();
  return {
    status,
    success: execution.success === true || status === "completed" || status === "success",
    domain: clean(task.domain || task.intent?.domain || "", 80) || null,
  };
}

function publicShadowResult(run, baseline, capabilityKey, elapsedMs) {
  const execution = asObject(run?.execution);
  const receipt = asObject(run?.receipt);
  const result = asObject(execution.result);
  const sources = Array.isArray(receipt.evidence) ? receipt.evidence.slice(0, 8) : [];

  return {
    mode: "shadow",
    capability_key: capabilityKey,
    provider_id: run?.provider?.id || null,
    status: run?.status || "unknown",
    success: execution.success === true,
    outcome_confirmed: receipt.outcome_confirmed === true,
    side_effect_completed: receipt.side_effect_completed === true,
    summary: clean(result.summary || execution.message || "", 1800) || null,
    observed_at: clean(result.observed_at || "", 80) || null,
    measurement_type: clean(result.measurement_type || "", 100) || null,
    evidence: sources.map((source) => ({
      uri: source.uri,
      title: source.title,
      publisher: source.publisher,
      evidence_type: source.evidence_type,
    })),
    comparison: {
      baseline_status: baseline.status,
      baseline_success: baseline.success,
      status_agrees: baseline.status === (run?.status || "unknown"),
    },
    duration_ms: Math.max(0, elapsedMs),
  };
}

export async function runIOIShadowEvaluation({
  request = {},
  existingResult = {},
  fetchImpl = globalThis.fetch,
  timeoutMs = 12000,
  now = () => new Date(),
} = {}) {
  const text = clean(request.text || request.user_request || "", 4000);
  const capabilityKey = classifyIOIReadOnlyIntent(text);

  if (!capabilityKey) {
    return {
      mode: "shadow",
      status: "not_applicable",
      reason: "no_supported_read_only_capability",
    };
  }

  const suppliedContext = copyLocationContext(
    request.suppliedContext || request.supplied_context || {}
  );
  const startedAt = now();
  const started = Date.now();
  const requestChannel = clean(request.channel || "unknown", 80);
  const taskId = clean(
    existingResult?.task?.task_id ||
    existingResult?.task?.id ||
    request.activeTaskId ||
    request.active_task_id ||
    "shadow:" + startedAt.getTime(),
    200
  );

  const task = {
    task_id: taskId,
    channel: requestChannel,
    user_request: text,
    goal: text,
    domain: capabilityKey === "air_quality_current" ? "environment" : "weather",
    intent: {
      domain: capabilityKey === "air_quality_current" ? "environment" : "weather",
      action: capabilityKey,
    },
    status: "requested",
  };

  const adapter = capabilityKey === "air_quality_current"
    ? createOpenMeteoAirQualityAdapter({ fetchImpl })
    : createOpenMeteoWeatherAdapter({ fetchImpl });

  let run;
  try {
    run = await executeIOITask({
      request: {
        text,
        channel: requestChannel,
        activeTaskId: taskId,
        suppliedContext,
      },
      task,
      requiredCapabilities: [capabilityKey],
      adapters: [adapter],
      context: suppliedContext,
      timeoutMs,
      startedAt: startedAt.toISOString(),
      idempotencyKey: "ioi-shadow:" + taskId,
    });
  } catch (error) {
    console.warn("FETCH IOI SHADOW EXECUTION ERROR:", error?.message || error);
    return {
      mode: "shadow",
      capability_key: capabilityKey,
      status: "shadow_execution_error",
      success: false,
      duration_ms: Math.max(0, Date.now() - started),
    };
  }

  const output = publicShadowResult(run, baselineSummary(existingResult), capabilityKey, Date.now() - started);
  console.info("FETCH IOI SHADOW RESULT:", JSON.stringify({
    capability_key: output.capability_key,
    provider_id: output.provider_id,
    status: output.status,
    success: output.success,
    outcome_confirmed: output.outcome_confirmed,
    duration_ms: output.duration_ms,
    evidence_count: output.evidence.length,
  }));
  return output;
}
