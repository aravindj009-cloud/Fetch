/*
 * Read-only public map listing discovery for IoI. Requires shared coordinates;
 * never contacts providers, books appointments, or claims independent verification.
 */
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const SOURCE_NAME = "OpenStreetMap contributors";
const MAX_RADIUS_KM = 25;
const DEFAULT_RADIUS_KM = 10;
const RESULT_LIMIT = 5;
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 80;
const cache = new Map();
const inFlight = new Map();

const SERVICES = [
  { label: "electrician", pattern: /\belectrician(?:s)?\b/i, tag: "electrician" },
  { label: "plumber", pattern: /\bplumb(?:er|ers|ing)\b/i, tag: "plumber" },
  { label: "carpenter", pattern: /\bcarpent(?:er|ers|ry)\b/i, tag: "carpenter" },
];
const clean = (value, max = 180) => String(value ?? "").trim().replace(/\s+/g, " ").slice(0, max);
const obj = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};

function findService(text) {
  return SERVICES.find((item) => item.pattern.test(text)) || null;
}
function getCoordinates(context) {
  const raw = obj(context);
  const nested = obj(raw.location || raw.user_location || raw.coordinates);
  const lat = Number(nested.latitude ?? nested.lat ?? raw.latitude ?? raw.lat);
  const lon = Number(nested.longitude ?? nested.lon ?? raw.longitude ?? raw.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 ||
      lon < -180 || lon > 180 || (lat === 0 && lon === 0)) return null;
  return { latitude: lat, longitude: lon };
}
function getLocationName(text, context) {
  const raw = obj(context);
  const nested = obj(raw.location || raw.user_location);
  const label = nested.city || nested.name || raw.city || raw.location_name;
  if (label) return clean(label, 120);
  const match = clean(text, 4000).match(/\b(?:in|near|around|at)\s+([a-z][a-z .'-]{1,90}?)(?=\s+(?:please|for me|right now|today|tomorrow)\b|[?.!,]|$)/i);
  return clean(match?.[1] || "", 120) || null;
}
function getRadius(context) {
  const raw = obj(context);
  const nested = obj(raw.location || raw.user_location);
  const value = Number(nested.radius_km ?? raw.radius_km ?? raw.radiusKm);
  return Number.isFinite(value) ? Math.max(1, Math.min(MAX_RADIUS_KM, value)) : DEFAULT_RADIUS_KM;
}
function distanceKm(aLat, aLon, bLat, bLon) {
  const rad = (x) => x * Math.PI / 180;
  const dLat = rad(bLat - aLat), dLon = rad(bLon - aLon);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}
function safeHttps(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:") return null;
    url.username = ""; url.password = "";
    return url.toString();
  } catch { return null; }
}
function osmUri(type, id) {
  return ["node", "way", "relation"].includes(type) && /^\d{1,16}$/.test(String(id || ""))
    ? "https://www.openstreetmap.org/" + type + "/" + id : null;
}
function formatAddress(tags) {
  return clean(tags["addr:full"], 220) || [
    tags["addr:housenumber"], tags["addr:street"], tags["addr:suburb"] || tags["addr:neighbourhood"],
    tags["addr:city"] || tags["addr:town"] || tags["addr:village"], tags["addr:postcode"],
  ].map((v) => clean(v, 90)).filter(Boolean).join(", ").slice(0, 220);
}
function failure(status, message, service, location) {
  return {
    success: false, status, message, side_effect: false,
    result: {
      outcome: status === "needs_clarification" ? "needs_clarification" : "source_unavailable",
      requested_service: service?.label || null,
      location: location ? { city: location } : {},
      radius_km: null, provider_count: 0, providers: [], resource_refs: [],
      source_registry: "openstreetmap_overpass", source_name: SOURCE_NAME,
      trust_level: "community_mapped_not_independently_verified",
      attribution: "© OpenStreetMap contributors", independently_verified: false,
      contact_status: "not_contacted", acceptance_status: "not_requested",
      appointment_status: "not_booked", execution_scope: "read_only_public_directory",
    },
  };
}
function cachedCopy(result) { return JSON.parse(JSON.stringify(result)); }

async function fetchListings({ fetchImpl, service, origin, location, radiusKm, signal, now }) {
  // Round to roughly a 10-metre grid for short-lived de-duplication, not persistent tracking.
  const key = [service.tag, origin.latitude.toFixed(4), origin.longitude.toFixed(4), radiusKm].join(":");
  const item = cache.get(key);
  if (item && item.expiresAt > now()) {
    const hit = cachedCopy(item.result);
    hit.result.location = location ? { city: location } : {};
    return hit;
  }
  if (inFlight.has(key)) {
    const hit = cachedCopy(await inFlight.get(key));
    hit.result.location = location ? { city: location } : {};
    return hit;
  }

  const ql = [
    "[out:json][timeout:8];",
    "(",
    "nwr(around:" + Math.round(radiusKm * 1000) + "," + origin.latitude + "," + origin.longitude + ")[\"craft\"=\"" + service.tag + "\"];",
    ");",
    "out center tags 40;",
  ].join("\n");

  const promise = (async () => {
    const response = await fetchImpl(OVERPASS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "Accept": "application/json",
        "User-Agent": "Fetch-IoI/0.1 (+https://tryfetch.in)",
      },
      body: "data=" + encodeURIComponent(ql),
      signal,
    });
    if (!response?.ok) {
      const error = new Error("OpenStreetMap Overpass source returned HTTP " + Number(response?.status || 0));
      error.code = "source_unavailable";
      throw error; // No retry: public endpoints may rate-limit requests.
    }
    const payload = await response.json();
    if (!payload || !Array.isArray(payload.elements)) throw new Error("Invalid Overpass response");

    const providers = [];
    for (const element of payload.elements) {
      const tags = obj(element.tags);
      const name = clean(tags.name || tags.operator || tags.brand, 140);
      const uri = osmUri(element.type, element.id);
      const lat = Number(element.lat ?? element.center?.lat);
      const lon = Number(element.lon ?? element.center?.lon);
      if (!name || !uri || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const address = formatAddress(tags);
      providers.push({
        id: clean(element.type, 16) + "/" + String(element.id),
        business_name: name,
        service_type: service.label,
        service_area: address,
        address: address || null,
        distance_km: Math.round(distanceKm(origin.latitude, origin.longitude, lat, lon) * 10) / 10,
        contact_phone: clean(tags["contact:phone"] || tags.phone, 50) || null,
        website: safeHttps(tags["contact:website"] || tags.website),
        operating_hours: { opening_hours: clean(tags.opening_hours, 100) || null },
        listing_uri: uri,
        source_name: SOURCE_NAME,
        source_registry: "openstreetmap_overpass",
        trust_level: "community_mapped_not_independently_verified",
        independently_verified: false,
        match_reasons: ["OpenStreetMap public map data", "trade tag: craft=" + service.tag],
      });
    }
    providers.sort((a, b) => a.distance_km - b.distance_km || a.business_name.localeCompare(b.business_name));
    const best = providers.slice(0, RESULT_LIMIT);
    const sourceRefs = best.map((p) => ({
      source_registry: "openstreetmap_overpass", resource_type: "osm_element", resource_id: p.id, uri: p.listing_uri,
    }));
    const sources = best.length ? best.map((p) => ({
      uri: p.listing_uri, title: p.business_name, publisher: SOURCE_NAME, evidence_type: "community_mapped_public_listing",
    })) : [{
      uri: OVERPASS_URL, title: "OpenStreetMap Overpass public directory query",
      publisher: SOURCE_NAME, evidence_type: "public_directory_query",
    }];
    const result = {
      success: true, status: "completed", side_effect: false,
      message: best.length
        ? "Found " + best.length + " community-mapped " + service.label + " listing(s) near the shared location. Fetch has not independently verified the listings or checked provider availability."
        : "No matching community-mapped " + service.label + " listings were returned. This does not mean no providers operate in the area.",
      sources,
      result: {
        outcome: best.length ? "providers_found" : "no_candidates",
        requested_service: service.label,
        location: location ? { city: location } : {},
        radius_km: radiusKm,
        provider_count: best.length,
        providers: best,
        resource_refs: sourceRefs,
        source_registry: "openstreetmap_overpass",
        source_name: SOURCE_NAME,
        trust_level: "community_mapped_not_independently_verified",
        attribution: "© OpenStreetMap contributors",
        independently_verified: false,
        observed_at: clean(payload.osm3s?.timestamp_osm_base, 80) || new Date(now()).toISOString(),
        contact_status: "not_contacted", acceptance_status: "not_requested",
        appointment_status: "not_booked", execution_scope: "read_only_public_directory",
      },
    };
    cache.set(key, { expiresAt: now() + CACHE_TTL_MS, result });
    while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
    return cachedCopy(result);
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return await promise;
}

export function createOpenStreetMapServiceDiscoveryAdapter({ fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  return {
    manifest: {
      capability_key: "local_service_discovery", version: "1.0.0",
      provider_id: "openstreetmap_overpass", provider_name: "OpenStreetMap / Overpass",
      display_name: "Community-mapped local service discovery",
      resource_type: "public_open_map_data", status: "active",
      domains: ["home_service", "service", "human_service"],
      tags: ["electrician", "plumber", "carpenter"],
      execution_modes: ["read_only"],
      policy: { requires_confirmation: false, supports_idempotency: true, side_effect_class: "read_only" },
      trust: { level: "community_mapped_not_independently_verified", verified: false, evidence_count: 0 },
      source_registry: "openstreetmap_overpass",
    },
    async execute({ task = {}, context = {}, signal } = {}) {
      const requestText = clean(task.user_request || task.goal || task.objective || "", 4000);
      const service = findService(requestText);
      const location = getLocationName(requestText, context);
      if (!service) {
        return failure("needs_clarification",
          "The public map connector currently supports electricians, plumbers, and carpenters. Which type do you need?",
          null, location);
      }
      const origin = getCoordinates(context);
      if (!origin) {
        return failure("needs_clarification",
          "To search nearby public map listings accurately, please share your WhatsApp location pin or enable location on the Fetch website. A city name alone is not precise enough to calculate distance.",
          service, location);
      }
      if (typeof fetchImpl !== "function") {
        return failure("source_unavailable", "The OpenStreetMap source is unavailable.", service, location);
      }
      try {
        return await fetchListings({ fetchImpl, service, origin, location, radiusKm: getRadius(context), signal, now });
      } catch (error) {
        // Log only a bounded error detail; never log user coordinates or the query.
        console.warn("FETCH IOI OSM SOURCE UNAVAILABLE:", clean(error?.message || "request_failed", 160));
        return failure("source_unavailable",
          "The public OpenStreetMap directory is unavailable right now. No provider has been contacted or booked.",
          service, location);
      }
    },
  };
}
export function clearOpenStreetMapServiceDiscoveryCacheForTests() {
  cache.clear(); inFlight.clear();
}
