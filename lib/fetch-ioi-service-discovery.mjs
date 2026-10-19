/*
 * Fetch IoI — local service-provider discovery v1.
 *
 * Read-only only: finds approved, explicitly public-listed service partners.
 * This adapter never calls a provider, sends a message, creates a booking, or
 * claims acceptance. It deliberately requires a dedicated staging Supabase
 * configuration; it must not fall back to Fetch's Production database.
 */

const CAPABILITY_KEY = "local_service_discovery";
const TABLE_NAME = "fetch_partner_applications";
const DEFAULT_RADIUS_KM = 25;
const MAX_RADIUS_KM = 50;
const MAX_RESULTS = 5;
const CITY_ALIASES = new Map([
  ["trivandrum", "thiruvananthapuram"],
  ["thiruvananthapuram city", "thiruvananthapuram"],
  ["cochin", "kochi"],
  ["ernakulam city", "ernakulam"],
  ["bangalore", "bengaluru"],
  ["bombay", "mumbai"],
  ["madras", "chennai"],
  ["calcutta", "kolkata"],
]);
const BROAD_REGIONS = new Set([
  "andhra pradesh", "arunachal pradesh", "assam", "bihar", "chhattisgarh",
  "goa", "gujarat", "haryana", "himachal pradesh", "jharkhand", "karnataka",
  "kerala", "madhya pradesh", "maharashtra", "manipur", "meghalaya", "mizoram",
  "nagaland", "odisha", "punjab", "rajasthan", "sikkim", "tamil nadu",
  "telangana", "tripura", "uttar pradesh", "uttarakhand", "west bengal",
  "andaman and nicobar islands", "chandigarh",
  "dadra and nagar haveli and daman and diu", "delhi",
  "jammu and kashmir", "ladakh", "lakshadweep", "puducherry",
]);

const SERVICE_ALIASES = Object.freeze({
  electrician: /\b(electrician|electricians|electrical|electric work|wiring|power trip|fuse repair)\b/i,
  plumber: /\b(plumber|plumbers|plumbing|pipe leak|leaking pipe)\b/i,
  carpenter: /\b(carpenter|carpenters|carpentry|woodwork)\b/i,
  appliance_repair: /\b(appliance repair|washing machine repair|fridge repair|refrigerator repair|microwave repair)\b/i,
  ac_repair: /\b(ac repair|air conditioner repair|air conditioning repair|aircon repair)\b/i,
  pest_control: /\b(pest control|exterminator|termite treatment)\b/i,
  cleaning: /\b(cleaner|cleaners|cleaning service|house cleaning|deep cleaning)\b/i,
});

function clean(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function enabledFlag(value) {
  return value === true || String(value ?? "").trim().toLowerCase() === "true";
}

function toNumber(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value))
    ? Number(value)
    : null;
}

function validCoordinates(latitude, longitude) {
  const lat = toNumber(latitude);
  const lon = toNumber(longitude);
  if (lat === null || lon === null) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  if (lat === 0 && lon === 0) return null;
  return { latitude: lat, longitude: lon };
}

function haversineKm(a, b) {
  const rad = (value) => (value * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const part =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(part), Math.sqrt(Math.max(0, 1 - part)));
}

function categoryFromText(value) {
  const input = clean(value, 4000);
  for (const [category, pattern] of Object.entries(SERVICE_ALIASES)) {
    if (pattern.test(input)) return category;
  }
  return null;
}

function categoryFromRecord(record = {}) {
  const raw = [
    record.category,
    record.subcategory,
    ...(Array.isArray(record.capabilities) ? record.capabilities : []),
  ].map((value) => clean(value, 160)).filter(Boolean).join(" ");
  return categoryFromText(raw);
}

function extractCityFromText(value) {
  const match = clean(value, 4000).match(
    /\b(?:in|near|around|at)\s+([A-Za-z][A-Za-z .'-]{1,60}?)(?=\s+(?:today|tomorrow|tonight|now|please|within|under|for|who|and)\b|[?!,.]|$)/i
  );
  if (!match) return null;
  const city = clean(match[1], 100);
  if (/^(me|my area|my location|here|there|nearby)$/i.test(city)) return null;
  return city || null;
}

function resolveRequest(task = {}, context = {}) {
  const requestText = clean(task.user_request || task.goal || task.objective, 4000);
  const category = categoryFromText(requestText);
  const locationObject = asObject(context.location || context.user_location || context.coordinates);
  const coordinates = validCoordinates(
    locationObject.latitude ?? locationObject.lat ?? context.latitude ?? context.lat,
    locationObject.longitude ?? locationObject.lon ?? context.longitude ?? context.lon
  );
  const rawCity = clean(
    locationObject.city ||
    locationObject.name ||
    context.city ||
    context.location_name ||
    context.locationName ||
    extractCityFromText(requestText) ||
    "",
    120
  ) || null;
  // A state name is not sufficiently precise for a nearby-provider request.
  const normalizedCity = rawCity
    ? (CITY_ALIASES.get(rawCity.toLowerCase()) || rawCity)
    : null;
  const city = normalizedCity && !BROAD_REGIONS.has(normalizedCity.toLowerCase())
    ? normalizedCity
    : null;
  const state = clean(locationObject.state || locationObject.admin1 || context.state || "", 120) || null;
  const radiusValue = toNumber(context.radius_km ?? context.radiusKm);
  const radiusKm = radiusValue === null
    ? DEFAULT_RADIUS_KM
    : Math.min(MAX_RADIUS_KM, Math.max(1, radiusValue));
  const locationLabel = city || (coordinates ? "your shared location" : null);

  if (!category) {
    return {
      valid: false,
      status: "needs_clarification",
      message: "What type of local service do you need—for example, an electrician or plumber?",
      missing_fields: ["service_type"],
    };
  }

  if (!coordinates && !city) {
    return {
      valid: false,
      status: "needs_clarification",
      message: "Which area or city should I search in? You can also share a WhatsApp location pin.",
      missing_fields: ["location"],
    };
  }

  return {
    valid: true,
    request_text: requestText,
    category,
    coordinates,
    city,
    state,
    radius_km: radiusKm,
    location_label: locationLabel,
  };
}

function safePublicUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:") return null;
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_[a-z0-9_]+|fbclid|gclid|trackingid)$/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    return url.toString();
  } catch {
    return null;
  }
}

function readStagingConfig(env = {}) {
  // Fail closed. Do not reuse SUPABASE_URL, VITE_SUPABASE_URL,
  // SUPABASE_SECRET_KEY, or any other general/Production configuration.
  if (clean(env.FETCH_IOI_SERVICE_DIRECTORY_ENV, 40).toLowerCase() !== "staging") {
    return null;
  }

  const base = clean(env.FETCH_IOI_SERVICE_DIRECTORY_SUPABASE_URL, 300);
  const key = clean(env.FETCH_IOI_SERVICE_DIRECTORY_KEY, 4000);
  const projectRef = clean(env.FETCH_IOI_SERVICE_DIRECTORY_PROJECT_REF, 100);

  if (!base || !key || !/^[a-z0-9]{20}$/i.test(projectRef)) return null;

  try {
    const url = new URL(base);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      url.hostname.toLowerCase() !== (projectRef.toLowerCase() + ".supabase.co")
    ) {
      return null;
    }
    return {
      base_url: url.origin,
      api_key: key,
      project_ref: projectRef,
    };
  } catch {
    return null;
  }
}

function makeDirectoryUrl(baseUrl, params) {
  const url = new URL(baseUrl + "/rest/v1/" + TABLE_NAME);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function getJson(fetchImpl, url, apiKey, signal) {
  const response = await fetchImpl(url, {
    method: "GET",
    signal,
    headers: {
      apikey: apiKey,
      Authorization: "Bearer " + apiKey,
      Accept: "application/json",
    },
  });

  if (!response || response.ok !== true) {
    throw new Error("directory_request_failed");
  }

  const data = await response.json();
  if (!Array.isArray(data)) throw new Error("directory_response_invalid");
  return data;
}

function publicArea(record = {}) {
  const metadata = asObject(record.metadata);
  return clean(
    record.service_area ||
    metadata.public_service_area ||
    metadata.service_area ||
    [metadata.city, metadata.state].filter(Boolean).join(", "),
    200
  ) || null;
}

function sanitizeOperatingHours(value) {
  const input = asObject(value);
  const output = {};
  for (const day of [
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  ]) {
    const valueForDay = input[day];
    if (typeof valueForDay === "string") {
      output[day] = clean(valueForDay, 80);
    } else if (valueForDay && typeof valueForDay === "object" && !Array.isArray(valueForDay)) {
      const slot = {};
      if (typeof valueForDay.open === "string") slot.open = clean(valueForDay.open, 20);
      if (typeof valueForDay.close === "string") slot.close = clean(valueForDay.close, 20);
      if (typeof valueForDay.closed === "boolean") slot.closed = valueForDay.closed;
      if (Object.keys(slot).length) output[day] = slot;
    }
  }
  return output;
}

function isPubliclyListed(record = {}) {
  const metadata = asObject(record.metadata);
  return String(record.status || "").toLowerCase() === "approved" &&
    enabledFlag(metadata.public_listing);
}

function matchesArea(record, city, state) {
  if (!city) return false;
  const metadata = asObject(record.metadata);
  const area = [
    record.service_area,
    record.address,
    metadata.public_service_area,
    metadata.service_area,
    metadata.city,
    metadata.state,
    state,
  ].map((item) => clean(item, 200)).join(" ").toLowerCase();
  return area.includes(city.toLowerCase());
}

function normalizePhone(value) {
  const raw = clean(value, 80);
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  return raw.startsWith("+") ? "+" + digits : digits;
}

function buildMatches(rows, details) {
  const matches = [];

  for (const record of rows) {
    if (!isPubliclyListed(record)) continue;
    if (categoryFromRecord(record) !== details.category) continue;

    const providerCoordinates = validCoordinates(record.latitude, record.longitude);
    let distanceKm = null;
    let areaMatched = false;

    if (details.coordinates && providerCoordinates) {
      distanceKm = haversineKm(details.coordinates, providerCoordinates);
      if (distanceKm > details.radius_km) continue;
    } else {
      areaMatched = matchesArea(record, details.city, details.state);
      if (!areaMatched) continue;
    }

    const metadata = asObject(record.metadata);
    const name = clean(record.business_name, 180);
    if (!name) continue;

    const profileUrl = safePublicUrl(metadata.public_profile_url || metadata.website_url || metadata.profile_url);
    const matchReasons = ["service_category_match"];
    if (distanceKm !== null) matchReasons.push("within_radius");
    if (areaMatched) matchReasons.push("service_area_match");
    if (enabledFlag(metadata.verified)) matchReasons.push("provider_marked_verified");

    matches.push({
      id: clean(record.id, 120),
      business_name: name,
      service_type: details.category,
      subcategory: clean(record.subcategory, 160) || null,
      service_area: publicArea(record),
      distance_km: distanceKm === null ? null : Math.round(distanceKm * 10) / 10,
      verification_status: enabledFlag(metadata.verified) ? "provider_marked_verified" : "approved_not_independently_verified",
      profile_url: profileUrl,
      contact_sharing_consent: enabledFlag(metadata.share_contact_with_customers),
      match_reasons: matchReasons,
      operating_hours: sanitizeOperatingHours(record.operating_hours),
      contact_status: "not_contacted",
      acceptance_status: "not_requested",
      appointment_status: "not_booked",
      _record_id: clean(record.id, 120),
    });
  }

  matches.sort((a, b) => {
    if (a.distance_km === null && b.distance_km !== null) return 1;
    if (a.distance_km !== null && b.distance_km === null) return -1;
    if (a.distance_km !== null && b.distance_km !== null && a.distance_km !== b.distance_km) {
      return a.distance_km - b.distance_km;
    }
    return a.business_name.localeCompare(b.business_name);
  });

  return matches;
}

function unavailableResult() {
  return {
    success: false,
    status: "source_unavailable",
    message: "The staging service directory is not configured or is temporarily unavailable. No provider has been contacted and no appointment has been booked.",
    side_effect: false,
    result: {
      outcome: "source_unavailable",
      provider_count: 0,
      providers: [],
      resource_refs: [],
      contact_status: "not_contacted",
      acceptance_status: "not_requested",
      appointment_status: "not_booked",
    },
  };
}

export function createFetchServiceDiscoveryAdapter({
  fetchImpl = globalThis.fetch,
  env = typeof process !== "undefined" ? process.env : {},
} = {}) {
  return {
    manifest: {
      capability_key: CAPABILITY_KEY,
      version: "1.0.0",
      provider_id: "fetch_service_directory",
      provider_name: "Fetch Service Directory",
      display_name: "Local service-provider discovery",
      resource_type: "approved_partner_directory",
      status: "active",
      domains: ["home_service", "service", "human_service"],
      tags: Object.keys(SERVICE_ALIASES),
      execution_modes: ["read_only"],
      policy: {
        requires_confirmation: false,
        supports_idempotency: true,
        side_effect_class: "read_only",
      },
      trust: {
        level: "application_registry",
        verified: false,
        evidence_count: 0,
      },
      source_registry: "fetch_partner_applications",
    },

    async execute({ task = {}, context = {}, signal } = {}) {
      const details = resolveRequest(task, asObject(context));

      if (!details.valid) {
        return {
          success: false,
          status: details.status,
          message: details.message,
          side_effect: false,
          result: {
            outcome: "needs_clarification",
            missing_fields: details.missing_fields,
            providers: [],
            resource_refs: [],
            contact_status: "not_contacted",
            acceptance_status: "not_requested",
            appointment_status: "not_booked",
          },
        };
      }

      const config = readStagingConfig(env);
      if (!config || typeof fetchImpl !== "function") return unavailableResult();

      try {
        // The first query contains only explicitly public listings and omits
        // phone numbers. This adapter never reads pending/unapproved applicants.
        const listingUrl = makeDirectoryUrl(config.base_url, {
          select: "id,business_name,category,subcategory,address,latitude,longitude,service_area,capabilities,operating_hours,status,updated_at,metadata",
          status: "eq.approved",
          "metadata->>public_listing": "eq.true",
          order: "updated_at.desc",
          limit: "100",
        });
        const rows = await getJson(fetchImpl, listingUrl, config.api_key, signal);
        const matches = buildMatches(rows, details);
        const selected = matches.slice(0, MAX_RESULTS);

        // Read contact numbers in a second, narrowly scoped query and only
        // for matched IDs with explicit customer-contact sharing consent.
        const consentedIds = selected
          .filter((provider) => provider.contact_sharing_consent && /^[0-9a-f-]{36}$/i.test(provider._record_id))
          .map((provider) => provider._record_id);

        const phoneById = new Map();
        if (consentedIds.length) {
          const phoneUrl = makeDirectoryUrl(config.base_url, {
            select: "id,whatsapp_phone",
            id: "in.(" + consentedIds.join(",") + ")",
            status: "eq.approved",
            "metadata->>public_listing": "eq.true",
            "metadata->>share_contact_with_customers": "eq.true",
          });
          const phoneRows = await getJson(fetchImpl, phoneUrl, config.api_key, signal);
          for (const row of phoneRows) {
            const phone = normalizePhone(row.whatsapp_phone);
            if (phone && consentedIds.includes(String(row.id))) phoneById.set(String(row.id), phone);
          }
        }

        const providers = selected.map((provider) => {
          const result = {
            id: provider.id,
            business_name: provider.business_name,
            service_type: provider.service_type,
            subcategory: provider.subcategory,
            service_area: provider.service_area,
            distance_km: provider.distance_km,
            verification_status: provider.verification_status,
            profile_url: provider.profile_url,
            match_reasons: provider.match_reasons,
            operating_hours: provider.operating_hours,
            contact_status: "not_contacted",
            acceptance_status: "not_requested",
            appointment_status: "not_booked",
          };
          const contactPhone = phoneById.get(provider._record_id);
          if (contactPhone) result.contact_phone = contactPhone;
          return result;
        });

        const resourceRefs = selected.map((provider) => ({
          resource_id: provider._record_id,
          resource_type: "service_provider",
          source_registry: TABLE_NAME,
          match_reason: provider.match_reasons.join(","),
          observed_at: null,
        }));

        const sources = providers
          .filter((provider) => provider.profile_url)
          .map((provider) => ({
            title: provider.business_name,
            url: provider.profile_url,
            publisher: "Fetch public partner listing",
            evidence_type: "public_partner_listing",
          }));

        const locationPhrase = details.location_label || "the requested area";
        const serviceName = details.category.replace(/_/g, " ");
        const summary = providers.length
          ? "Found " + matches.length + " approved public listing(s) for " + serviceName +
            " near " + locationPhrase + " within " + details.radius_km +
            " km. No provider has been contacted and no appointment has been booked."
          : "No approved public listing matched " + serviceName + " near " + locationPhrase +
            " within " + details.radius_km +
            " km. No provider has been contacted and no appointment has been booked.";

        return {
          success: true,
          status: "completed",
          execution_type: CAPABILITY_KEY,
          message: summary,
          side_effect: false,
          sources,
          result: {
            outcome: providers.length ? "providers_found" : "no_candidates",
            requested_service: details.category,
            location: {
              label: locationPhrase,
              city: details.city,
              state: details.state,
              coordinates_used: Boolean(details.coordinates),
            },
            radius_km: details.radius_km,
            provider_count: matches.length,
            providers,
            resource_refs: resourceRefs,
            contact_status: "not_contacted",
            acceptance_status: "not_requested",
            appointment_status: "not_booked",
            execution_scope: "discovery_only",
          },
        };
      } catch (error) {
        // Do not leak provider payloads, API errors, project details or keys.
        if (signal?.aborted) throw error;
        return unavailableResult();
      }
    },
  };
}

export const IOI_SERVICE_DISCOVERY_CAPABILITY_KEY = CAPABILITY_KEY;
