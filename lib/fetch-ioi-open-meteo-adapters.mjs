/*
 * IoI built-in, read-only Open-Meteo adapters.
 *
 * These adapters are real provider implementations for the IoI contract.
 * They never perform side effects. The AQI adapter returns model-derived
 * US/EU indices and pollutant concentrations, not an official CPCB station
 * reading or an India National AQI value.
 */

const DOCS = "https://open-meteo.com/en/docs";
const AIR_QUALITY_DOCS = "https://open-meteo.com/en/docs/air-quality-api";

const INDIAN_STATES_AND_UTS = new Set([
  "andhra pradesh", "arunachal pradesh", "assam", "bihar", "chhattisgarh",
  "goa", "gujarat", "haryana", "himachal pradesh", "jharkhand", "karnataka",
  "kerala", "madhya pradesh", "maharashtra", "manipur", "meghalaya", "mizoram",
  "nagaland", "odisha", "punjab", "rajasthan", "sikkim", "tamil nadu",
  "telangana", "tripura", "uttar pradesh", "uttarakhand", "west bengal",
  "andaman and nicobar islands", "chandigarh", "dadra and nagar haveli and daman and diu",
  "delhi", "jammu and kashmir", "ladakh", "lakshadweep", "puducherry",
]);

const CITY_ALIASES = new Map([
  ["trivandrum", "Thiruvananthapuram"],
  ["trivandrum city", "Thiruvananthapuram"],
  ["bangalore", "Bengaluru"],
  ["bombay", "Mumbai"],
  ["calcutta", "Kolkata"],
  ["madras", "Chennai"],
]);

const WMO_DESCRIPTION = new Map([
  [0, "clear sky"], [1, "mainly clear"], [2, "partly cloudy"], [3, "overcast"],
  [45, "fog"], [48, "depositing rime fog"], [51, "light drizzle"],
  [53, "drizzle"], [55, "dense drizzle"], [56, "light freezing drizzle"],
  [57, "dense freezing drizzle"], [61, "light rain"], [63, "moderate rain"],
  [65, "heavy rain"], [66, "light freezing rain"], [67, "heavy freezing rain"],
  [71, "light snow"], [73, "moderate snow"], [75, "heavy snow"],
  [77, "snow grains"], [80, "slight rain showers"], [81, "moderate rain showers"],
  [82, "violent rain showers"], [85, "slight snow showers"], [86, "heavy snow showers"],
  [95, "thunderstorm"], [96, "thunderstorm with slight hail"], [99, "thunderstorm with heavy hail"],
]);

function clean(value, max = 300) {
  return String(value ?? "").trim().slice(0, max);
}

function finiteNumber(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeWords(value) {
  return clean(value, 180).toLowerCase().replace(/[.,!?;:]+$/g, "").replace(/\s+/g, " ").trim();
}

function isStateOnly(value) {
  return INDIAN_STATES_AND_UTS.has(normalizeWords(value));
}

function getTaskText(task = {}) {
  return clean(task.user_request || task.goal || task.objective || "", 4000);
}

function extractLocation(text) {
  const match = String(text || "").match(
    /\b(?:in|for|at|around|near)\s+(.+?)(?=\s+(?:today|tomorrow|tonight|now|right\s+now|this\s+morning|this\s+afternoon|this\s+evening|currently)\b|[?!,;.]|$)/i
  );
  return clean(match?.[1], 180).replace(/[?.!,;:]+$/g, "").trim();
}

function contextCoordinates(context = {}) {
  const raw = objectOrEmpty(context);
  const nested = objectOrEmpty(raw.location || raw.user_location || raw.coordinates);
  const latitude = Number(nested.latitude ?? nested.lat ?? raw.latitude ?? raw.lat);
  const longitude = Number(nested.longitude ?? nested.lon ?? raw.longitude ?? raw.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
      latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180 ||
      (latitude === 0 && longitude === 0)) {
    return null;
  }
  return {
    latitude,
    longitude,
    name: clean(nested.name || nested.city || raw.locationName || raw.city || "your saved location", 180),
    admin1: clean(nested.admin1 || nested.state || raw.state || "", 120),
    country: clean(nested.country || raw.country || "", 120),
    timezone: clean(nested.timezone || raw.timezone || "", 100),
  };
}

function contextLocationText(context = {}, task = {}) {
  const raw = objectOrEmpty(context);
  const nested = objectOrEmpty(raw.location || raw.user_location);
  const entities = objectOrEmpty(task.entities);
  // Weather/AQI need a place, not a home address. Prefer a city-level
  // label so an external geocoder does not receive an unnecessarily precise
  // street address.
  return clean(
    (typeof raw.location === "string" ? raw.location : "") ||
    nested.city || nested.name || nested.admin1 || nested.state ||
    raw.city || raw.location_name || entities.city || entities.location || "",
    180
  );
}

function resolveLocationName(task = {}, context = {}) {
  const text = getTaskText(task);
  const locationFromMessage = extractLocation(text);
  const supplied = contextLocationText(context, task);
  const location = locationFromMessage || supplied;
  if (!location) {
    return {
      ok: false,
      status: "needs_clarification",
      message: "Please specify a city, or allow Fetch to use a saved location, so I can retrieve a location-specific reading.",
    };
  }
  if (isStateOnly(location)) {
    return {
      ok: false,
      status: "needs_clarification",
      message: "That request names a whole state, not a monitoring location. Please specify a city in " + location + " for a location-specific estimate.",
    };
  }
  return { ok: true, name: CITY_ALIASES.get(normalizeWords(location)) || location };
}

async function fetchJson(fetchImpl, url, signal) {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response || response.ok !== true) {
    const error = new Error("Provider returned an unsuccessful HTTP response.");
    error.code = "provider_http_error";
    error.statusCode = response?.status || null;
    throw error;
  }
  return response.json();
}

async function resolvePlace({ task, context, fetchImpl, signal }) {
  const coordinates = contextCoordinates(context);
  if (coordinates) {
    return { ok: true, place: coordinates, locationSource: "trusted_request_context" };
  }

  const query = resolveLocationName(task, context);
  if (!query.ok) return query;

  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", query.name);
  url.searchParams.set("count", "10");
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");

  const data = await fetchJson(fetchImpl, url.toString(), signal);
  const candidates = Array.isArray(data?.results) ? data.results : [];
  if (!candidates.length) {
    return {
      ok: false,
      status: "needs_clarification",
      message: "I couldn't resolve \"" + query.name + "\" to a place. Please provide a city and, if needed, its state or country.",
    };
  }

  const normalizedQuery = normalizeWords(query.name);
  const place = candidates.slice().sort((a, b) => {
    const aExact = normalizeWords(a?.name) === normalizedQuery ? 1 : 0;
    const bExact = normalizeWords(b?.name) === normalizedQuery ? 1 : 0;
    const aIndia = String(a?.country_code || "").toUpperCase() === "IN" ? 1 : 0;
    const bIndia = String(b?.country_code || "").toUpperCase() === "IN" ? 1 : 0;
    return (bExact - aExact) || (bIndia - aIndia);
  })[0];

  if (!Number.isFinite(Number(place?.latitude)) || !Number.isFinite(Number(place?.longitude))) {
    return { ok: false, status: "source_unavailable", message: "The geocoding provider returned an invalid location." };
  }

  return {
    ok: true,
    locationSource: "open_meteo_geocoding",
    place: {
      latitude: Number(place.latitude),
      longitude: Number(place.longitude),
      name: clean(place.name || query.name, 180),
      admin1: clean(place.admin1 || "", 120),
      country: clean(place.country || "", 120),
      timezone: clean(place.timezone || "", 100),
    },
  };
}

function describePlace(place = {}) {
  return [place.name, place.admin1, place.country].filter(Boolean).join(", ");
}

function readOnlyResult(status, message, extra = {}) {
  return {
    success: status === "completed",
    status,
    message,
    side_effect: false,
    ...extra,
  };
}

function createAdapterManifest({
  capabilityKey,
  displayName,
  description,
  tags,
  inputSchema,
  outputSchema,
}) {
  return {
    manifest_version: "ioi-capability-v1",
    capability_key: capabilityKey,
    version: "1.0.0",
    provider_id: "open_meteo",
    provider_name: "Open-Meteo",
    display_name: displayName,
    description,
    resource_type: "public_read_only_api",
    status: "active",
    domains: ["weather", "environment"],
    tags,
    execution_modes: ["read_only"],
    input_schema: inputSchema,
    output_schema: outputSchema,
    policy: {
      requires_confirmation: false,
      supports_idempotency: true,
      side_effect_class: "none",
    },
    trust: {
      level: "public_modelled_data",
      verified: false,
      evidence_count: 0,
    },
    source_registry: "fetch-builtin-adapters",
  };
}

const commonInputSchema = {
  type: "object",
  properties: {
    user_request: { type: "string" },
    location: { type: ["string", "object", "null"] },
  },
};

const commonOutputSchema = {
  type: "object",
  required: ["summary", "observed_at", "source"],
  properties: {
    summary: { type: "string" },
    observed_at: { type: ["string", "null"] },
    source: { type: "string" },
  },
};

export function createOpenMeteoWeatherAdapter({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");

  return {
    manifest: createAdapterManifest({
      capabilityKey: "weather_forecast",
      displayName: "Open-Meteo Weather Forecast",
      description: "Read current conditions and a short city forecast from Open-Meteo.",
      tags: ["weather", "forecast", "temperature", "rain", "precipitation", "wind", "humidity"],
      inputSchema: commonInputSchema,
      outputSchema: commonOutputSchema,
    }),
    execute: async ({ task = {}, context = {}, signal } = {}) => {
      try {
        const resolved = await resolvePlace({ task, context, fetchImpl, signal });
        if (!resolved.ok) return readOnlyResult(resolved.status, resolved.message);
        const place = resolved.place;
        const query = new URLSearchParams({
          latitude: String(place.latitude),
          longitude: String(place.longitude),
          current: "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m",
          daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
          timezone: place.timezone || "auto",
          forecast_days: "2",
        });
        const forecast = await fetchJson(
          fetchImpl,
          "https://api.open-meteo.com/v1/forecast?" + query.toString(),
          signal
        );
        const daily = objectOrEmpty(forecast?.daily);
        const current = objectOrEmpty(forecast?.current);
        const userText = getTaskText(task);
        const tomorrow = /\b(tomorrow|next day)\b/i.test(userText);
        const index = tomorrow ? 1 : 0;
        const date = daily.time?.[index] || null;
        const high = daily.temperature_2m_max?.[index];
        const low = daily.temperature_2m_min?.[index];
        const rain = daily.precipitation_probability_max?.[index];
        const code = tomorrow
          ? daily.weather_code?.[index]
          : (current.weather_code ?? daily.weather_code?.[index]);
        const condition = WMO_DESCRIPTION.get(Number(code)) || "conditions unavailable";

        if (!date || !finiteNumber(high) || !finiteNumber(low)) {
          return readOnlyResult("source_unavailable", "Open-Meteo did not return a complete forecast for this location.");
        }

        const currentSummary = finiteNumber(current.temperature_2m)
          ? " Current temperature " + Math.round(Number(current.temperature_2m)) + "°C" +
            (finiteNumber(current.apparent_temperature)
              ? " (feels like " + Math.round(Number(current.apparent_temperature)) + "°C)"
              : "") + "."
          : "";
        const windSummary = finiteNumber(current.wind_speed_10m)
          ? " Wind " + Math.round(Number(current.wind_speed_10m)) + " km/h."
          : "";
        const precipitationSummary = finiteNumber(rain)
          ? " Maximum precipitation probability " + Math.round(Number(rain)) + "%."
          : "";
        const dayLabel = tomorrow ? "Tomorrow" : "Today";
        const placeLabel = describePlace(place);
        const summary = dayLabel + " in " + placeLabel + " (" + date + "): " + condition + "." +
          currentSummary + windSummary +
          " High " + Math.round(Number(high)) + "°C / low " + Math.round(Number(low)) + "°C." +
          precipitationSummary;

        return readOnlyResult("completed", summary, {
          execution_type: "weather_forecast",
          result: {
            summary,
            location: place,
            forecast_date: date,
            observed_at: current.time || null,
            timezone: forecast.timezone || place.timezone || null,
            current: {
              temperature_c: current.temperature_2m ?? null,
              apparent_temperature_c: current.apparent_temperature ?? null,
              humidity_percent: current.relative_humidity_2m ?? null,
              wind_speed_kmh: current.wind_speed_10m ?? null,
              weather_code: current.weather_code ?? null,
            },
            daily: {
              weather_code: daily.weather_code?.[index] ?? null,
              high_c: Number(high),
              low_c: Number(low),
              precipitation_probability_percent: finiteNumber(rain) ? Number(rain) : null,
            },
            location_source: resolved.locationSource,
          },
          sources: [{
            title: "Open-Meteo Forecast API",
            publisher: "Open-Meteo",
            url: DOCS,
            evidence_type: "provider_api_response",
          }],
        });
      } catch (error) {
        if (signal?.aborted || error?.name === "AbortError") throw error;
        return readOnlyResult(
          "source_unavailable",
          "The weather provider is temporarily unavailable.",
          { error: { code: error?.code || "provider_error", message: clean(error?.message || "Provider unavailable.", 240) } }
        );
      }
    },
  };
}

function aqiBandUS(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "unavailable";
  if (n <= 50) return "Good";
  if (n <= 100) return "Moderate";
  if (n <= 150) return "Unhealthy for sensitive groups";
  if (n <= 200) return "Unhealthy";
  if (n <= 300) return "Very unhealthy";
  return "Hazardous";
}

export function createOpenMeteoAirQualityAdapter({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");

  return {
    manifest: createAdapterManifest({
      capabilityKey: "air_quality_current",
      displayName: "Open-Meteo Modelled Air Quality",
      description: "Read modelled current air-quality indices and particulate levels for a specific location.",
      tags: ["air_quality", "aqi", "pollution", "pm2.5", "pm10", "environment"],
      inputSchema: commonInputSchema,
      outputSchema: commonOutputSchema,
    }),
    execute: async ({ task = {}, context = {}, signal } = {}) => {
      try {
        const resolved = await resolvePlace({ task, context, fetchImpl, signal });
        if (!resolved.ok) return readOnlyResult(resolved.status, resolved.message);
        const place = resolved.place;
        const query = new URLSearchParams({
          latitude: String(place.latitude),
          longitude: String(place.longitude),
          current: "us_aqi,european_aqi,pm2_5,pm10",
          timezone: place.timezone || "auto",
          domains: "auto",
        });
        const air = await fetchJson(
          fetchImpl,
          "https://air-quality-api.open-meteo.com/v1/air-quality?" + query.toString(),
          signal
        );
        const current = objectOrEmpty(air?.current);
        const observedAt = current.time || null;
        const usAqi = current.us_aqi;
        const euAqi = current.european_aqi;
        const pm25 = current.pm2_5;
        const pm10 = current.pm10;

        if (![usAqi, euAqi, pm25, pm10].some((value) => finiteNumber(value))) {
          return readOnlyResult("source_unavailable", "Open-Meteo did not return a current air-quality estimate for this location.");
        }

        const summaryParts = [
          "Modelled air quality for " + describePlace(place) +
            (observedAt ? " at " + observedAt : "") + ":",
          finiteNumber(usAqi) ? "US AQI " + Math.round(Number(usAqi)) + " (" + aqiBandUS(usAqi) + ")" : "",
          finiteNumber(euAqi) ? "European AQI " + Math.round(Number(euAqi)) : "",
          finiteNumber(pm25) ? "PM2.5 " + Number(pm25).toFixed(1) + " µg/m³" : "",
          finiteNumber(pm10) ? "PM10 " + Number(pm10).toFixed(1) + " µg/m³" : "",
          "This is model-derived guidance, not an official Indian CPCB monitoring-station reading or India's National AQI."
        ].filter(Boolean);
        const summary = summaryParts.join(". ") + ".";

        return readOnlyResult("completed", summary, {
          execution_type: "air_quality_current",
          result: {
            summary,
            location: place,
            observed_at: observedAt,
            timezone: air.timezone || place.timezone || null,
            indices: {
              us_aqi: finiteNumber(usAqi) ? Number(usAqi) : null,
              us_aqi_category: aqiBandUS(usAqi),
              european_aqi: finiteNumber(euAqi) ? Number(euAqi) : null,
            },
            pollutants: {
              pm2_5_ug_m3: finiteNumber(pm25) ? Number(pm25) : null,
              pm10_ug_m3: finiteNumber(pm10) ? Number(pm10) : null,
            },
            location_source: resolved.locationSource,
            measurement_type: "modelled_current_estimate_not_official_station",
          },
          sources: [{
            title: "Open-Meteo Air Quality API",
            publisher: "Open-Meteo / CAMS modelled forecast",
            url: AIR_QUALITY_DOCS,
            evidence_type: "modelled_provider_api_response",
          }],
        });
      } catch (error) {
        if (signal?.aborted || error?.name === "AbortError") throw error;
        return readOnlyResult(
          "source_unavailable",
          "The air-quality provider is temporarily unavailable.",
          { error: { code: error?.code || "provider_error", message: clean(error?.message || "Provider unavailable.", 240) } }
        );
      }
    },
  };
}