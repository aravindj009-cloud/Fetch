import test from "node:test";
import assert from "node:assert/strict";

import {
  createOpenMeteoWeatherAdapter,
  createOpenMeteoAirQualityAdapter,
} from "./fetch-ioi-open-meteo-adapters.mjs";
import {
  classifyIOIReadOnlyIntent,
  runIOIShadowEvaluation,
} from "./fetch-ioi-shadow.mjs";
import { executeIOITask } from "./fetch-ioi-provider-runtime.mjs";

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}

function buildMockFetch({ currentWeatherCode = 3 } = {}) {
  const calls = [];
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), method: options.method || "GET" });

    if (url.hostname === "geocoding-api.open-meteo.com") {
      const query = url.searchParams.get("name") || "";
      const aliases = {
        Mumbai: { name: "Mumbai", latitude: 19.076, longitude: 72.8777, admin1: "Maharashtra", country: "India", country_code: "IN", timezone: "Asia/Kolkata" },
        Bengaluru: { name: "Bengaluru", latitude: 12.9716, longitude: 77.5946, admin1: "Karnataka", country: "India", country_code: "IN", timezone: "Asia/Kolkata" },
        Thiruvananthapuram: { name: "Thiruvananthapuram", latitude: 8.5241, longitude: 76.9366, admin1: "Kerala", country: "India", country_code: "IN", timezone: "Asia/Kolkata" },
      };
      const place = aliases[query] || aliases.Thiruvananthapuram;
      return jsonResponse({ results: [place] });
    }

    if (url.hostname === "api.open-meteo.com") {
      return jsonResponse({
        timezone: "Asia/Kolkata",
        current: {
          time: "2026-10-20T11:00",
          temperature_2m: 29.4,
          apparent_temperature: 32.1,
          relative_humidity_2m: 70,
          weather_code: 1,
          wind_speed_10m: 7.8,
        },
        daily: {
          time: ["2026-10-20", "2026-10-21"],
          weather_code: [currentWeatherCode, 61],
          temperature_2m_max: [32.4, 31.2],
          temperature_2m_min: [24.2, 23.5],
          precipitation_probability_max: [20, 65],
        },
      });
    }

    if (url.hostname === "air-quality-api.open-meteo.com") {
      return jsonResponse({
        timezone: "Asia/Kolkata",
        current: {
          time: "2026-10-20T11:00",
          us_aqi: 82,
          european_aqi: 44,
          pm2_5: 24.7,
          pm10: 41.2,
        },
      });
    }

    return jsonResponse({ error: "unexpected_host" }, 404);
  };

  return { fetchImpl, calls };
}

test("read-only intent classifier distinguishes air quality and weather", () => {
  assert.equal(classifyIOIReadOnlyIntent("What is the AQI in Maharashtra now?"), "air_quality_current");
  assert.equal(classifyIOIReadOnlyIntent("How does the weather look in Trivandrum tomorrow?"), "weather_forecast");
  assert.equal(classifyIOIReadOnlyIntent("Find an electrician near me"), "local_service_discovery");
});

test("weather adapter resolves Trivandrum alias and returns a dated forecast with evidence", async () => {
  const { fetchImpl, calls } = buildMockFetch();
  const adapter = createOpenMeteoWeatherAdapter({ fetchImpl });
  const result = await executeIOITask({
    request: { text: "Hi Fetch, how does it look in Trivandrum tomorrow?", channel: "api" },
    task: {
      task_id: "weather-shadow-test",
      user_request: "Hi Fetch, how does it look in Trivandrum tomorrow?",
      goal: "Get tomorrow weather",
      domain: "weather",
    },
    requiredCapabilities: ["weather_forecast"],
    adapters: [adapter],
    timeoutMs: 1000,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.provider.id, "open_meteo");
  assert.equal(result.execution.success, true);
  assert.equal(result.execution.side_effect, false);
  assert.equal(result.execution.result.forecast_date, "2026-10-21");
  assert.equal(result.execution.result.location.name, "Thiruvananthapuram");
  assert.match(result.execution.message, /High 31°C \/ low 24°C/);
  assert.match(result.execution.message, /65%/);
  assert.equal(result.receipt.outcome_confirmed, true);
  assert.equal(result.receipt.side_effect_completed, false);
  assert.equal(result.receipt.evidence_count, 1);
  assert.equal(new URL(calls[0].url).searchParams.get("name"), "Thiruvananthapuram");
});

test("weather adapter rejects null forecast values instead of turning them into zero", async () => {
  let call = 0;
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    call += 1;
    if (url.hostname === "geocoding-api.open-meteo.com") {
      return jsonResponse({ results: [{
        name: "Mumbai", latitude: 19.076, longitude: 72.8777,
        admin1: "Maharashtra", country: "India", timezone: "Asia/Kolkata",
      }] });
    }
    return jsonResponse({
      current: { time: "2026-10-20T11:00", weather_code: 1 },
      daily: {
        time: ["2026-10-20", "2026-10-21"],
        weather_code: [1, 2],
        temperature_2m_max: [null, null],
        temperature_2m_min: [null, null],
        precipitation_probability_max: [null, null],
      },
    });
  };
  const adapter = createOpenMeteoWeatherAdapter({ fetchImpl });
  const result = await adapter.execute({
    task: { user_request: "Weather in Mumbai tomorrow", goal: "Weather in Mumbai tomorrow" },
    context: {},
  });
  assert.equal(call, 2);
  assert.equal(result.status, "source_unavailable");
  assert.equal(result.success, false);
});

test("AQI adapter refuses state-wide Maharashtra as if it were a point reading", async () => {
  const { fetchImpl, calls } = buildMockFetch();
  const adapter = createOpenMeteoAirQualityAdapter({ fetchImpl });
  const result = await executeIOITask({
    request: { text: "What is the AQI in Maharashtra now?", channel: "api" },
    task: {
      task_id: "aqi-state-test",
      user_request: "What is the AQI in Maharashtra now?",
      goal: "Get current AQI",
      domain: "environment",
    },
    requiredCapabilities: ["air_quality_current"],
    adapters: [adapter],
    context: {
      latitude: 19.076,
      longitude: 72.8777,
      city: "Mumbai",
      state: "Maharashtra",
    },
    timeoutMs: 1000,
  });

  assert.equal(result.status, "needs_clarification");
  assert.match(result.execution.message, /whole state/i);
  assert.equal(calls.length, 0);
  assert.equal(result.receipt.outcome_confirmed, false);
});

test("AQI adapter returns modelled point estimate and clearly disclaims CPCB status", async () => {
  const { fetchImpl, calls } = buildMockFetch();
  const adapter = createOpenMeteoAirQualityAdapter({ fetchImpl });
  const result = await executeIOITask({
    request: { text: "What is the AQI in Mumbai now?", channel: "api" },
    task: {
      task_id: "aqi-city-test",
      user_request: "What is the AQI in Mumbai now?",
      goal: "Get current air-quality estimate",
      domain: "environment",
    },
    requiredCapabilities: ["air_quality_current"],
    adapters: [adapter],
    timeoutMs: 1000,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.provider.id, "open_meteo");
  assert.equal(result.execution.result.location.name, "Mumbai");
  assert.equal(result.execution.result.measurement_type, "modelled_current_estimate_not_official_station");
  assert.equal(result.execution.result.indices.us_aqi, 82);
  assert.equal(result.execution.result.pollutants.pm2_5_ug_m3, 24.7);
  assert.match(result.execution.message, /not an official Indian CPCB monitoring-station reading/i);
  assert.doesNotMatch(result.execution.message, /\.\./);
  assert.match(result.execution.message, /National AQI\.$/i);
  assert.equal(result.execution.side_effect, false);
  assert.equal(result.receipt.outcome_confirmed, true);
  assert.equal(result.receipt.evidence_count, 1);
  assert.equal(calls.some((c) => new URL(c.url).hostname === "air-quality-api.open-meteo.com"), true);
});

test("shadow evaluator attaches a comparison but does not mutate the existing result", async () => {
  const { fetchImpl } = buildMockFetch();
  const baseline = {
    status: "completed",
    task: { task_id: "shadow-comp-1", status: "completed", domain: "weather" },
    execution: { success: true, status: "completed", message: "existing Fetch weather result" },
  };
  const before = JSON.stringify(baseline);

  const shadow = await runIOIShadowEvaluation({
    request: {
      text: "Weather in Mumbai tomorrow",
      channel: "api",
      suppliedContext: {},
    },
    existingResult: baseline,
    fetchImpl,
  });

  assert.equal(JSON.stringify(baseline), before);
  assert.equal(shadow.mode, "shadow");
  assert.equal(shadow.capability_key, "weather_forecast");
  assert.equal(shadow.provider_id, "open_meteo");
  assert.equal(shadow.status, "completed");
  assert.equal(shadow.comparison.baseline_status, "completed");
  assert.equal(shadow.comparison.status_agrees, true);
  assert.equal(shadow.side_effect_completed, false);
  assert.equal(shadow.evidence.length, 1);
});

test("shadow evaluator does not invoke providers for unsupported tasks", async () => {
  let calls = 0;
  const shadow = await runIOIShadowEvaluation({
    request: { text: "Book an electrician for tomorrow" },
    existingResult: { status: "awaiting_confirmation" },
    fetchImpl: async () => { calls += 1; throw new Error("should not be called"); },
  });
  assert.equal(shadow.status, "not_applicable");
  assert.equal(calls, 0);
});

test("AQI without a location returns clarification and makes no external request", async () => {
  let calls = 0;
  const adapter = createOpenMeteoAirQualityAdapter({
    fetchImpl: async () => { calls += 1; throw new Error("should not be called"); },
  });
  const result = await adapter.execute({
    task: { user_request: "What is the AQI now?", goal: "Get AQI" },
    context: {},
  });
  assert.equal(result.status, "needs_clarification");
  assert.equal(calls, 0);
});