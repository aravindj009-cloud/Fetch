import test from "node:test";
import assert from "node:assert/strict";

import {
  IOI_PROTOCOL_VERSION,
  normalizeIOICapability,
  discoverIOICapabilities,
  buildIOITaskEnvelope,
  buildIOIExecutionReceipt,
  attachIOITrace,
} from "./fetch-ioi-contract.mjs";
import { executeIOITask } from "./fetch-ioi-provider-runtime.mjs";
import {
  createOpenMeteoAirQualityAdapter,
  createOpenMeteoWeatherAdapter,
} from "./fetch-ioi-open-meteo-adapters.mjs";
import {
  classifyIOIReadOnlyIntent,
  runIOIShadowEvaluation,
} from "./fetch-ioi-shadow.mjs";

test("normalizes a capability without exposing provider endpoints or arbitrary metadata", () => {
  const result = normalizeIOICapability({
    capability_key: "weather_forecast",
    provider_id: "open_meteo",
    provider_name: "Open-Meteo",
    display_name: "Weather forecast",
    status: "active",
    resource_type: "public_api",
    tags: ["weather", "forecast"],
    domains: ["weather"],
    endpoint: "https://internal.example/with-secret",
    metadata: { token: "never expose", region: "eu-west" },
    policy: { supports_idempotency: true },
    trust: { level: "official", verified: true },
  });

  assert.equal(result.valid, true);
  assert.equal(result.capability.capability_key, "weather_forecast");
  assert.equal(result.capability.provider.id, "open_meteo");
  assert.equal(result.capability.status, "active");
  assert.equal(result.capability.policy.supports_idempotency, true);
  assert.equal(result.capability.trust.verified, true);
  assert.equal(JSON.stringify(result).includes("never expose"), false);
  assert.equal(JSON.stringify(result).includes("internal.example"), false);
});

test("rejects capability records without stable identifiers", () => {
  assert.deepEqual(
    normalizeIOICapability({ display_name: "Unnamed tool" }),
    {
      valid: false,
      reason: "capability_key_missing",
      capability: null,
    },
  );
});

test("discovery ranks the exact active capability and rejects inactive providers", () => {
  const discovery = discoverIOICapabilities({
    requiredCapabilities: ["weather_forecast"],
    candidates: [
      {
        capability_key: "digital_agent",
        provider_id: "fetch",
        display_name: "Generic digital agent",
        status: "active",
        tags: ["general_assistant"],
      },
      {
        capability_key: "weather_forecast",
        provider_id: "open_meteo",
        display_name: "Open-Meteo forecast",
        status: "active",
        tags: ["weather", "forecast"],
        domains: ["weather"],
        region: "global",
      },
      {
        capability_key: "offline_recommendation",
        provider_id: "wrong-provider",
        display_name: "Unrelated provider with overlapping tags",
        status: "active",
        tags: ["weather", "forecast"],
        domains: ["weather"],
      },
      {
        capability_key: "weather_forecast",
        provider_id: "offline-weather",
        display_name: "Offline source",
        status: "offline",
        tags: ["weather"],
      },
    ],
    task: { domain: "weather" },
    region: "global",
  });

  assert.equal(discovery.status, "candidate_selected");
  assert.equal(discovery.selected_capability.capability_key, "weather_forecast");
  assert.equal(discovery.selected_capability.provider.id, "open_meteo");
  assert.equal(discovery.candidates_examined, 4);
  assert.equal(discovery.candidates.some((item) => item.capability.provider.id === "wrong-provider" && item.compatible), false);
  assert.equal(discovery.candidates.some((item) => item.capability.provider.id === "offline-weather" && item.compatible), false);
});

test("discovery explicitly reports when nothing compatible is available", () => {
  const discovery = discoverIOICapabilities({
    requiredCapabilities: ["flight_search"],
    candidates: [
      {
        capability_key: "weather_forecast",
        provider_id: "open_meteo",
        status: "active",
        tags: ["weather"],
      },
    ],
  });

  assert.equal(discovery.status, "no_compatible_candidate");
  assert.equal(discovery.selected_capability, null);
});

test("builds a portable task envelope with authorization and provenance", () => {
  const envelope = buildIOITaskEnvelope({
    createdAt: "2026-10-18T10:00:00.000Z",
    request: {
      text: "Book an electrician for tomorrow",
      channel: "whatsapp",
      conversationId: "conversation-1",
      suppliedContext: { approval_granted: false },
    },
    task: {
      task_id: "task-1",
      workflow_id: "workflow-1",
      contract_version: "fetch-task-v1",
      channel: "whatsapp",
      user_request: "Book an electrician for tomorrow",
      goal: "Arrange a qualified electrician visit",
      domain: "human_service",
      intent: { domain: "human_service", action: "book_service" },
      requires_confirmation: true,
      current_step: "discover_providers",
      metadata: { source: "fetch-v9", routing_override: "capability_discovery" },
      entities: { region: "Thiruvananthapuram" },
    },
    requiredCapabilities: ["electrician_discovery", "appointment_booking"],
  });

  assert.equal(envelope.protocol, "internet-of-intelligence");
  assert.equal(envelope.protocol_version, IOI_PROTOCOL_VERSION);
  assert.equal(envelope.origin.channel, "whatsapp");
  assert.equal(envelope.origin.workflow_id, "workflow-1");
  assert.deepEqual(envelope.requirements.capability_alternatives, [
    "electrician_discovery",
    "appointment_booking",
  ]);
  assert.equal(envelope.authorization.confirmation_required, true);
  assert.equal(envelope.authorization.approval_granted, false);
  assert.equal(envelope.requirements.region, "Thiruvananthapuram");
  assert.equal(envelope.provenance.created_by, "fetch-universal-execution");
});

test("execution receipt does not mistake a route match for a successful outcome", () => {
  const envelope = buildIOITaskEnvelope({
    request: { text: "Find an electrician" },
    task: { task_id: "task-2", status: "ready_for_atc" },
  });
  const receipt = buildIOIExecutionReceipt({
    envelope,
    result: {
      status: "resource_matched",
      atc: { status: "matched", resource_type: "human_service" },
      execution: { success: false, status: "awaiting_connector" },
    },
    completedAt: "2026-10-18T10:00:02.000Z",
  });

  assert.equal(receipt.outcome_confirmed, false);
  assert.equal(receipt.side_effect_completed, false);
  assert.equal(receipt.reported_status, "resource_matched");
});

test("execution receipt confirms a side effect only with explicit completed success", () => {
  const envelope = buildIOITaskEnvelope({
    request: { text: "Send the message" },
    task: { task_id: "task-3", requires_confirmation: false },
  });
  const receipt = buildIOIExecutionReceipt({
    envelope,
    result: {
      status: "completed",
      execution: {
        success: true,
        status: "completed",
        side_effect: true,
        execution_type: "messaging_api",
      },
    },
    startedAt: "2026-10-18T10:00:00.000Z",
    completedAt: "2026-10-18T10:00:01.500Z",
  });

  assert.equal(receipt.outcome_confirmed, true);
  assert.equal(receipt.side_effect_completed, true);
  assert.equal(receipt.timing.duration_ms, 1500);
});

test("evidence URIs are deduplicated and tracking parameters are removed", () => {
  const envelope = buildIOITaskEnvelope({
    request: { text: "Research semiconductor news" },
    task: { task_id: "task-4" },
  });
  const receipt = buildIOIExecutionReceipt({
    envelope,
    result: {
      status: "completed",
      sources: [
        {
          title: "Official announcement",
          url: "https://example.gov/release?utm_source=openai&id=42",
          publisher: "Example government",
        },
        {
          title: "Duplicate URL",
          url: "https://example.gov/release?id=42&utm_source=another",
        },
        { title: "Unsafe URI", url: "javascript:alert(1)" },
      ],
      execution: { success: true, status: "completed" },
    },
  });

  assert.equal(receipt.evidence_count, 1);
  assert.equal(receipt.evidence[0].uri, "https://example.gov/release?id=42");
  assert.equal(receipt.evidence[0].publisher, "Example government");
});

test("injected provider executes with a stable idempotency key and returns an IoI receipt", async () => {
  let invocations = 0;
  let seenKey = "";
  const response = await executeIOITask({
    request: {
      text: "Get tomorrow's forecast",
      channel: "whatsapp",
      conversationId: "private-conversation-id",
    },
    task: {
      task_id: "weather-task-17",
      workflow_id: "workflow-weather-17",
      channel: "whatsapp",
      user_request: "Get tomorrow's forecast",
      goal: "Get tomorrow's forecast",
      domain: "weather",
      entities: { region: "global" },
    },
    requiredCapabilities: ["weather_forecast"],
    adapters: [{
      manifest: {
        capability_key: "weather_forecast",
        provider_id: "open_meteo",
        provider_name: "Open-Meteo",
        display_name: "Open-Meteo Forecast",
        status: "active",
        domains: ["weather"],
        tags: ["weather", "forecast"],
        policy: { requires_confirmation: false, supports_idempotency: true },
      },
      execute: async ({ task, envelope, idempotency_key, signal }) => {
        invocations += 1;
        seenKey = idempotency_key;
        assert.equal(task.task_id, "weather-task-17");
        assert.equal(envelope.protocol_version, "ioi-task-v1");
        assert.equal(signal.aborted, false);
        return {
          success: true,
          status: "completed",
          result: { summary: "Light drizzle tomorrow" },
          sources: [{ title: "Open-Meteo", url: "https://open-meteo.com?utm_source=test" }],
          side_effect: false,
        };
      },
    }],
    startedAt: "2026-10-18T10:00:00.000Z",
  });

  assert.equal(invocations, 1);
  assert.equal(seenKey, "weather-task-17");
  assert.equal(response.status, "completed");
  assert.equal(response.provider.id, "open_meteo");
  assert.equal(response.receipt.outcome_confirmed, true);
  assert.equal(response.receipt.side_effect_completed, false);
  assert.equal(response.receipt.evidence_count, 1);
  assert.equal(response.receipt.evidence[0].uri, "https://open-meteo.com/");
  assert.equal(response.task_envelope.origin.conversation_id, null);
});

test("provider with a confirmation requirement is not invoked without approval", async () => {
  let invocations = 0;
  const response = await executeIOITask({
    request: { text: "Book the appointment", channel: "whatsapp" },
    task: {
      task_id: "booking-task-1",
      user_request: "Book the appointment",
      goal: "Book the appointment",
      domain: "appointment_booking",
      requires_confirmation: true,
    },
    requiredCapabilities: ["appointment_booking"],
    adapters: [{
      manifest: {
        capability_key: "appointment_booking",
        provider_id: "calendar_partner",
        display_name: "Appointment booking",
        status: "active",
        domains: ["appointment_booking"],
        tags: ["booking"],
        policy: { requires_confirmation: true, side_effect_class: "external_booking" },
      },
      execute: async () => {
        invocations += 1;
        return { success: true, status: "completed", side_effect: true };
      },
    }],
  });

  assert.equal(invocations, 0);
  assert.equal(response.status, "awaiting_confirmation");
  assert.equal(response.receipt.outcome_confirmed, false);
  assert.equal(response.receipt.side_effect_completed, false);
  assert.equal(response.receipt.confirmation_required, true);
});

test("inactive providers are never invoked", async () => {
  let invocations = 0;
  const response = await executeIOITask({
    request: { text: "Get a forecast" },
    task: { task_id: "forecast-2", user_request: "Get a forecast", goal: "Get a forecast" },
    requiredCapabilities: ["weather_forecast"],
    adapters: [{
      manifest: {
        capability_key: "weather_forecast",
        provider_id: "disabled_weather",
        display_name: "Disabled weather provider",
        status: "disabled",
        tags: ["weather"],
      },
      execute: async () => {
        invocations += 1;
        return { success: true, status: "completed" };
      },
    }],
  });

  assert.equal(invocations, 0);
  assert.equal(response.status, "capability_not_available");
  assert.equal(response.receipt.outcome_confirmed, false);
});

test("provider timeout yields an explicit failed receipt", async () => {
  const response = await executeIOITask({
    request: { text: "Get a delayed forecast" },
    task: { task_id: "timeout-task", user_request: "Get a delayed forecast", goal: "Get a delayed forecast" },
    requiredCapabilities: ["weather_forecast"],
    timeoutMs: 100,
    adapters: [{
      manifest: {
        capability_key: "weather_forecast",
        provider_id: "slow_weather",
        display_name: "Slow weather provider",
        status: "active",
        tags: ["weather"],
      },
      execute: ({ signal }) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ success: true, status: "completed" }), 500);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("aborted by provider timeout"));
        }, { once: true });
      }),
    }],
  });

  assert.equal(response.status, "timeout");
  assert.equal(response.execution.success, false);
  assert.equal(response.receipt.outcome_confirmed, false);
  assert.equal(response.receipt.side_effect_completed, false);
});

test("attachIOITrace is additive and preserves the existing Fetch result", () => {
  const original = {
    version: "universal-task-v7",
    status: "completed",
    workflow_id: "workflow-5",
    task: {
      task_id: "task-5",
      contract_version: "fetch-task-v1",
      channel: "api",
      user_request: "Get tomorrow's weather",
      domain: "weather",
      execution_network: "open_meteo",
      status: "completed",
      resource: { type: "weather_forecast", provider_id: "open_meteo", name: "Open-Meteo" },
    },
    atc: {
      status: "matched",
      capability: "weather_forecast",
      resource_type: "weather_forecast",
      provider_id: "open_meteo",
      resource: {
        id: "open-meteo-adapter",
        resource_type: "weather_forecast",
        display_name: "Open-Meteo",
        status: "available",
        capabilities: ["weather", "forecast"],
      },
    },
    execution: { success: true, status: "completed", execution: { success: true, status: "completed" } },
  };

  const traced = attachIOITrace({
    request: { text: "Get tomorrow's weather", channel: "api" },
    result: original,
    startedAt: "2026-10-18T10:00:00.000Z",
    completedAt: "2026-10-18T10:00:01.000Z",
  });

  assert.equal(traced.status, original.status);
  assert.equal(traced.workflow_id, original.workflow_id);
  assert.equal(traced.execution, original.execution);
  assert.equal(traced.ioi.protocol_version, IOI_PROTOCOL_VERSION);
  assert.equal(traced.ioi.task_envelope.task.task_id, "task-5");
  assert.equal(traced.ioi.execution_receipt.outcome_confirmed, true);
  assert.equal(traced.ioi.execution_receipt.provider_id, "open_meteo");
});

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

function openMeteoMockFetch({ place, forecast, airQuality }) {
  const calls = [];
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), signal: options.signal });
    if (url.hostname === "geocoding-api.open-meteo.com") {
      return jsonResponse({ results: place ? [place] : [] });
    }
    if (url.hostname === "api.open-meteo.com" && url.pathname === "/v1/forecast") {
      return jsonResponse(forecast);
    }
    if (url.hostname === "air-quality-api.open-meteo.com") {
      return jsonResponse(airQuality);
    }
    throw new Error("Unexpected test URL: " + url.toString());
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const mockTrivandrum = {
  name: "Thiruvananthapuram",
  admin1: "Kerala",
  country: "India",
  country_code: "IN",
  latitude: 8.5241,
  longitude: 76.9366,
  timezone: "Asia/Kolkata",
};

test("Open-Meteo weather adapter returns a dated forecast and uses tomorrow's condition code", async () => {
  const fetchImpl = openMeteoMockFetch({
    place: mockTrivandrum,
    forecast: {
      timezone: "Asia/Kolkata",
      current: {
        time: "2026-10-20T11:30",
        temperature_2m: 29,
        apparent_temperature: 32,
        relative_humidity_2m: 71,
        weather_code: 2,
        wind_speed_10m: 6,
      },
      daily: {
        time: ["2026-10-20", "2026-10-21"],
        weather_code: [3, 61],
        temperature_2m_max: [32, 31],
        temperature_2m_min: [25, 25],
        precipitation_probability_max: [20, 66],
      },
    },
  });
  const adapter = createOpenMeteoWeatherAdapter({ fetchImpl });
  const output = await adapter.execute({
    task: { user_request: "Hi Fetch, how does it look in Trivandrum tomorrow?" },
    context: {},
  });

  assert.equal(output.success, true);
  assert.equal(output.status, "completed");
  assert.equal(output.result.forecast_date, "2026-10-21");
  assert.equal(output.result.daily.weather_code, 61);
  assert.match(output.result.summary, /Tomorrow in Thiruvananthapuram, Kerala, India \(2026-10-21\): light rain/i);
  assert.match(output.result.summary, /66%/);
  assert.equal(output.side_effect, false);
  assert.equal(output.sources[0].publisher, "Open-Meteo");
});

test("Open-Meteo AQI adapter gives location-specific modelled indices with a timestamp", async () => {
  const fetchImpl = openMeteoMockFetch({
    place: {
      name: "Mumbai",
      admin1: "Maharashtra",
      country: "India",
      country_code: "IN",
      latitude: 19.076,
      longitude: 72.8777,
      timezone: "Asia/Kolkata",
    },
    airQuality: {
      timezone: "Asia/Kolkata",
      current: {
        time: "2026-10-20T11:00",
        us_aqi: 82,
        european_aqi: 35,
        pm2_5: 20.3,
        pm10: 44.5,
      },
    },
  });
  const adapter = createOpenMeteoAirQualityAdapter({ fetchImpl });
  const output = await adapter.execute({
    task: { user_request: "What is the AQI in Mumbai now?" },
    context: {},
  });

  assert.equal(output.status, "completed");
  assert.equal(output.result.indices.us_aqi, 82);
  assert.equal(output.result.pollutants.pm2_5_ug_m3, 20.3);
  assert.equal(output.result.observed_at, "2026-10-20T11:00");
  assert.equal(output.result.measurement_type, "modelled_current_estimate_not_official_station");
  assert.match(output.message, /not an official Indian CPCB monitoring-station reading/i);
  assert.equal(output.sources[0].evidence_type, "modelled_provider_api_response");
});

test("AQI adapter asks for a city rather than inventing a statewide Maharashtra reading", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error("The provider must not be called for a state-only query");
  };
  const adapter = createOpenMeteoAirQualityAdapter({ fetchImpl });
  const output = await adapter.execute({
    task: { user_request: "What is the AQI in Maharashtra now?" },
    context: {},
  });

  assert.equal(calls, 0);
  assert.equal(output.status, "needs_clarification");
  assert.equal(output.success, false);
  assert.match(output.message, /whole state/i);
  assert.equal(output.result, undefined);
});

test("AQI adapter does not turn null pollutant values into zeros", async () => {
  const fetchImpl = openMeteoMockFetch({
    place: {
      name: "Pune", admin1: "Maharashtra", country: "India",
      country_code: "IN", latitude: 18.5204, longitude: 73.8567,
      timezone: "Asia/Kolkata",
    },
    airQuality: {
      current: {
        time: "2026-10-20T11:00",
        us_aqi: null,
        european_aqi: null,
        pm2_5: null,
        pm10: null,
      },
    },
  });
  const adapter = createOpenMeteoAirQualityAdapter({ fetchImpl });
  const output = await adapter.execute({
    task: { user_request: "What is the air quality in Pune now?" },
    context: {},
  });

  assert.equal(output.status, "source_unavailable");
  assert.equal(output.success, false);
  assert.doesNotMatch(output.message, /US AQI 0|PM2\.5 0\.0|PM10 0\.0/i);
});

test("IoI shadow evaluation selects the weather adapter and hides profile secrets/coordinates", async () => {
  assert.equal(classifyIOIReadOnlyIntent("Research semiconductor developments"), null);
  assert.equal(classifyIOIReadOnlyIntent("What is the AQI in Maharashtra now?"), "air_quality_current");
  assert.equal(classifyIOIReadOnlyIntent("How does it look in Trivandrum tomorrow?"), "weather_forecast");

  const fetchImpl = openMeteoMockFetch({
    place: mockTrivandrum,
    forecast: {
      timezone: "Asia/Kolkata",
      current: { time: "2026-10-20T11:30", temperature_2m: 29, apparent_temperature: 31, weather_code: 2, wind_speed_10m: 6 },
      daily: {
        time: ["2026-10-20", "2026-10-21"],
        weather_code: [2, 61],
        temperature_2m_max: [32, 31],
        temperature_2m_min: [25, 25],
        precipitation_probability_max: [20, 66],
      },
    },
  });
  const result = await runIOIShadowEvaluation({
    request: {
      text: "How does it look in Trivandrum tomorrow?",
      channel: "whatsapp",
      suppliedContext: {
        latitude: 8.5241,
        longitude: 76.9366,
        authToken: "DO_NOT_LEAK",
        profile: { city: "Thiruvananthapuram", phone: "+919999999999" },
      },
    },
    existingResult: { status: "completed", task: { status: "completed", domain: "weather" } },
    fetchImpl,
    now: () => new Date("2026-10-20T06:00:00.000Z"),
  });

  assert.equal(result.mode, "shadow");
  assert.equal(result.capability_key, "weather_forecast");
  assert.equal(result.provider_id, "open_meteo");
  assert.equal(result.status, "completed");
  assert.equal(result.success, true);
  assert.equal(result.outcome_confirmed, true);
  assert.equal(result.side_effect_completed, false);
  assert.equal(result.comparison.status_agrees, true);
  assert.match(result.summary, /2026-10-21/);
  assert.equal(JSON.stringify(result).includes("DO_NOT_LEAK"), false);
  assert.equal(JSON.stringify(result).includes("+919999999999"), false);
  assert.equal(JSON.stringify(result).includes("8.5241"), false);
});

test("IoI shadow evaluator skips unsupported tasks without calling any provider", async () => {
  let calls = 0;
  const result = await runIOIShadowEvaluation({
    request: { text: "Book me a flight to Delhi", channel: "whatsapp" },
    existingResult: { status: "completed" },
    fetchImpl: async () => { calls += 1; throw new Error("must not be called"); },
  });
  assert.equal(result.status, "not_applicable");
  assert.equal(calls, 0);
});
