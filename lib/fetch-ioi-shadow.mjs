/*
 * Fetch → IoI shadow evaluator.
 *
 * This module runs only explicitly supported read-only capabilities. It does
 * not replace the existing answer, persist shadow output, or execute side
 * effects. Caller must opt in (the universal executor gates it by env var).
 */

import { executeIOITaskWithRecovery } from "./fetch-ioi-recovery.mjs";
import {
  createOpenMeteoAirQualityAdapter,
  createOpenMeteoWeatherAdapter,
} from "./fetch-ioi-open-meteo-adapters.mjs";
import { createFetchServiceDiscoveryAdapter } from "./fetch-ioi-service-discovery.mjs";
import { createOpenStreetMapServiceDiscoveryAdapter } from "./fetch-ioi-openstreetmap-adapter.mjs";
import { resolveFetchAgentDog } from "./fetch-agent-dog-registry.mjs";
import { createFetchServiceDiscoveryCollaboration } from "./fetch-agent-collaboration.mjs";

function clean(value, max = 400) {
  return String(value ?? "").trim().slice(0, max);
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function copyLocationContext(input = {}) {
  const raw = asObject(input);
  const profile = asObject(raw.profile || raw.user_profile || raw.location_profile);
  const chosen = asObject(raw.location || raw.user_location || raw.coordinates || raw.customer_location || raw.web_location);

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
  const radiusKm = Number(chosen.radius_km ?? raw.radius_km ?? raw.radiusKm);
  if (city) result.city = city;
  if (state) result.state = state;
  if (country) result.country = country;
  if (timezone) result.timezone = timezone;
  if (Number.isFinite(radiusKm)) result.radius_km = Math.max(1, Math.min(50, radiusKm));

  const latitudePresent = result.latitude !== undefined && result.longitude !== undefined;
  if (latitudePresent && chosen.name) result.locationName = clean(chosen.name, 180);

  return result;
}

export function classifyIOIReadOnlyIntent(value = "") {
  const text = clean(value, 4000);
  if (!text) return null;

  // Only identify provider discovery. Do not route booking, payment, calls,
  // messages, or other consequential actions through this read-only adapter.
  if (
    /\b(electrician|plumber|carpenter|appliance repair|washing machine repair|fridge repair|ac repair|air conditioner repair|pest control|cleaning service|house cleaning)\b/i.test(text) &&
    /\b(find|search|need|looking for|near|nearby|help me find|recommend|show me|get me)\b/i.test(text) &&
    !/\b(book|schedule|reserve|pay|purchase|order|call|contact|message|send)\b/i.test(text.replace(/\bdo not contact or book anyone\b/gi, ""))
  ) {
    return "local_service_discovery";
  }

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

function publicShadowResult(run, baseline, capabilityKey, elapsedMs, requestText = "") {
  const execution = asObject(run?.execution);
  const receipt = asObject(run?.receipt);
  const result = asObject(execution.result);
  const sources = Array.isArray(receipt.evidence) ? receipt.evidence.slice(0, 8) : [];
  const specialist = resolveFetchAgentDog(requestText);
  const ioiBridged = (
    (specialist.id === "local_helper" && capabilityKey === "local_service_discovery") ||
    (specialist.id === "scout" && ["weather_forecast", "air_quality_current"].includes(capabilityKey))
  );

  return {
    mode: "shadow",
    capability_key: capabilityKey,
    provider_id: run?.provider?.id || null,
    status: run?.status || "unknown",
    success: execution.success === true,
    outcome_confirmed: receipt.outcome_confirmed === true,
    side_effect_completed: receipt.side_effect_completed === true,
    recovery_receipt: asObject(run?.recovery_receipt),
    specialist_delegation: {
      specialist_id: specialist.id,
      specialist_name: specialist.name,
      capability_key: capabilityKey,
      mode: ioiBridged ? "ioi_provider_execution" : "existing_fetch_execution",
      status: ioiBridged
        ? (execution.success === true ? "executed_by_ioi_provider" : "attempted_via_ioi_provider")
        : "not_delegated_to_ioi_yet",
      provider_id: run?.provider?.id || null,
      authoritative_route: "fetch_atc_ioi",
    },
    summary: clean(result.summary || execution.message || "", 1800) || null,
    observed_at: clean(result.observed_at || "", 80) || null,
    measurement_type: clean(result.measurement_type || "", 100) || null,
    evidence: sources.map((source) => ({
      uri: source.uri,
      title: source.title,
      publisher: source.publisher,
      evidence_type: source.evidence_type,
    })),
    receipt: {
      reported_status: clean(receipt.reported_status || run?.status || "unknown", 100),
      outcome_confirmed: receipt.outcome_confirmed === true,
      side_effect_completed: receipt.side_effect_completed === true,
      evidence_count: Number(receipt.evidence_count || sources.length || 0),
      resource_refs: Array.isArray(receipt.resource_refs) ? receipt.resource_refs : [],
    },
    ...(capabilityKey === "local_service_discovery" ? {
      service_discovery: {
        outcome: clean(result.outcome || "", 80) || null,
        requested_service: clean(result.requested_service || "", 120) || null,
        source_registry: clean(result.source_registry || "fetch_partner_applications", 100),
        source_name: clean(result.source_name || "Fetch Service Directory", 120),
        trust_level: clean(result.trust_level || "application_registry", 100),
        attribution: clean(result.attribution || "", 180) || null,
        independently_verified: result.independently_verified === true,
        location: asObject(result.location),
        radius_km: result.radius_km === null || result.radius_km === undefined || result.radius_km === ""
          ? null
          : (Number.isFinite(Number(result.radius_km)) ? Number(result.radius_km) : null),
        provider_count: Number.isFinite(Number(result.provider_count)) ? Number(result.provider_count) : 0,
        providers: (Array.isArray(result.providers) ? result.providers : []).slice(0, 5).map((provider) => ({
          id: clean(provider.id || "", 120) || null,
          business_name: clean(provider.business_name || "", 180) || null,
          service_type: clean(provider.service_type || "", 100) || null,
          subcategory: clean(provider.subcategory || "", 120) || null,
          service_area: clean(provider.service_area || "", 220) || null,
          address: clean(provider.address || "", 220) || null,
          distance_km: provider.distance_km === null || provider.distance_km === undefined || provider.distance_km === "" ? null : (Number.isFinite(Number(provider.distance_km)) ? Number(provider.distance_km) : null),
          verification_status: clean(provider.verification_status || "", 80) || null,
          profile_url: clean(provider.profile_url || "", 1000) || null,
          listing_uri: clean(provider.listing_uri || "", 1000) || null,
          source_name: clean(provider.source_name || result.source_name || "", 120) || null,
          trust_level: clean(provider.trust_level || result.trust_level || "", 100) || null,
          independently_verified: provider.independently_verified === true,
          website: clean(provider.website || "", 500) || null,
          contact_phone: clean(provider.contact_phone || "", 80) || null,
          match_reasons: Array.isArray(provider.match_reasons) ? provider.match_reasons.slice(0, 8) : [],
          operating_hours: asObject(provider.operating_hours),
          contact_status: clean(provider.contact_status || "not_contacted", 80),
          acceptance_status: clean(provider.acceptance_status || "not_requested", 80),
          appointment_status: clean(provider.appointment_status || "not_booked", 80),
        })),
        resource_refs: Array.isArray(result.resource_refs) ? result.resource_refs.slice(0, 5) : [],
        contact_status: clean(result.contact_status || "not_contacted", 80),
        acceptance_status: clean(result.acceptance_status || "not_requested", 80),
        appointment_status: clean(result.appointment_status || "not_booked", 80),
        execution_scope: clean(result.execution_scope || "discovery_only", 80),
      },
    } : {}),
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
  serviceDiscoveryAdapter = null,
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

  const taskDomain = capabilityKey === "air_quality_current"
    ? "environment"
    : capabilityKey === "local_service_discovery"
      ? "home_service"
      : "weather";
  const task = {
    task_id: taskId,
    channel: requestChannel,
    user_request: text,
    goal: text,
    domain: taskDomain,
    intent: {
      domain: taskDomain,
      action: capabilityKey,
    },
    status: "requested",
  };

  const adapter = capabilityKey === "air_quality_current"
    ? createOpenMeteoAirQualityAdapter({ fetchImpl })
    : capabilityKey === "local_service_discovery"
      ? (serviceDiscoveryAdapter || createFetchServiceDiscoveryAdapter())
      : createOpenMeteoWeatherAdapter({ fetchImpl });

  let run;
  try {
    run = await executeIOITaskWithRecovery({
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

  // Federate the approved Fetch directory with community-mapped public data
  // only when the internal source is unavailable or has no candidates.
  if (capabilityKey === "local_service_discovery") {
    const primaryRun = run;
    const primaryOutcome = asObject(primaryRun?.execution?.result).outcome;
    const shouldTryPublicMap =
      primaryRun?.status === "source_unavailable" ||
      (primaryRun?.status === "completed" && primaryOutcome === "no_candidates");
    if (shouldTryPublicMap) {
      try {
        const publicRun = await executeIOITaskWithRecovery({
          request: { text, channel: requestChannel, activeTaskId: taskId, suppliedContext },
          task,
          requiredCapabilities: [capabilityKey],
          adapters: [createOpenStreetMapServiceDiscoveryAdapter({ fetchImpl })],
          context: suppliedContext,
          timeoutMs,
          startedAt: startedAt.toISOString(),
          idempotencyKey: "ioi-public-map:" + taskId,
        });
        if (
          publicRun?.status === "completed" ||
          publicRun?.status === "needs_clarification" ||
          primaryRun?.status === "source_unavailable"
        ) run = publicRun;
      } catch (error) {
        console.warn("FETCH IOI PUBLIC MAP FALLBACK ERROR:", error?.message || error);
      }
    }
  }
  const output = publicShadowResult(run, baselineSummary(existingResult), capabilityKey, Date.now() - started, text);

  // Preview-only local-service workflow: Patch requests Scout's assessment of
  // source metadata through the bounded message protocol. This is advisory
  // evidence classification only; it never contacts a provider or changes the
  // authoritative Fetch response.
  if (capabilityKey === "local_service_discovery") {
    try {
      const collaboration = await createFetchServiceDiscoveryCollaboration({
        timeoutMs: Math.min(5000, Math.max(500, timeoutMs)),
        maxMessages: 3,
      }).run({
        taskId,
        traceId: run?.receipt?.trace_id || "ioi-agent-collaboration:" + taskId,
        discovery: asObject(run?.execution?.result),
      });

      output.agent_collaboration = {
        protocol: collaboration.protocol,
        status: collaboration.status,
        ok: collaboration.ok,
        trace_id: collaboration.trace_id,
        specialist_handoff: collaboration.result?.specialist_handoff || null,
        result: collaboration.result || null,
        trace: collaboration.trace || null,
      };

      const assessments = new Map(
        (Array.isArray(collaboration.result?.providers) ? collaboration.result.providers : [])
          .map((provider) => [provider.id, provider.source_assessment])
      );
      if (output.service_discovery) {
        output.service_discovery.providers = output.service_discovery.providers.map((provider) => ({
          ...provider,
          agent_assessment: assessments.get(provider.id) || null,
        }));
      }
    } catch (error) {
      output.agent_collaboration = {
        protocol: "fetch-agent-message-v1",
        status: "collaboration_unavailable",
        ok: false,
        reason: "specialist_handoff_failed",
      };
      console.warn("FETCH IOI AGENT COLLABORATION ERROR:", error?.message || error);
    }
  }

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
