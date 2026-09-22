/* Fetch ATC Router V5

   Fixes the V4 universal physical-network crash by removing the dependency
   on fetch-resource-registry.mjs. That module is not required for routing.

   Physical routing:
     V9 -> ATC -> partner catalog -> partner-store resource

   Real WhatsApp orders still use atcSelectPartnerStoreForOrder().
   Universal/pre-order requests use the read-only catalog matcher below.
*/

import { atcSafe, atcSelectPartnerStoreForOrder } from "./atc.mjs";

const SUPABASE_URL =
  process.env.VITE_SUPABASE_URL ||
  "https://skfxzagxlxputwpwxwbe.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;

function headers(extra = {}) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function db(path, options = {}) {
  if (!SUPABASE_KEY) throw new Error("SUPABASE_SECRET_KEY is missing");
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: headers(options.headers || {}),
  });
  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  if (!response.ok) {
    throw new Error(`Fetch ATC Router ${response.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  }
  return data;
}

const RESOURCE_TYPES = {
  flight_api: ["flight_api"],
  reservation_api_or_phone: ["reservation_api", "phone_service"],
  phone_agent: ["phone_service", "voice_agent"],
  connected_app: ["connected_app"],
  messaging_api: ["messaging_api"],
  calendar_api: ["calendar_api"],
  digital_agent: ["digital_agent"],
  human_or_digital_service: ["digital_agent", "human_service", "phone_service"],
};

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function validCoordinates(lat, lon) {
  const a = Number(lat), b = Number(lon);
  return Number.isFinite(a) && Number.isFinite(b) && a >= -90 && a <= 90 && b >= -180 && b <= 180 && !(a === 0 && b === 0);
}

function haversineKm(lat1, lon1, lat2, lon2) {
  if (!validCoordinates(lat1, lon1) || !validCoordinates(lat2, lon2)) return null;
  const rad = (v) => Number(v) * Math.PI / 180;
  const dLat = rad(Number(lat2) - Number(lat1));
  const dLon = rad(Number(lon2) - Number(lon1));
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function itemMatches(term, row) {
  const wanted = normalize(term);
  const names = [row?.item_name, row?.normalized_name, ...(Array.isArray(row?.aliases) ? row.aliases : [])]
    .filter(Boolean).map(normalize).filter(Boolean);
  return Boolean(wanted) && names.some((name) => wanted === name || wanted.includes(name) || name.includes(wanted));
}

function extractTerms(value) {
  if (Array.isArray(value)) {
    return value.flatMap((x) => extractTerms(typeof x === "object" ? (x?.name || x?.item_name || x?.product || x?.title || "") : x));
  }
  const raw = String(value || "").trim();
  if (!raw) return [];
  return raw.split(/\s*(?:,|\band\b|\+|&)\s*/i)
    .map((x) => x.replace(/^\s*\d+(?:\.\d+)?\s*(?:x|×)?\s*/i, "").replace(/\s*x\s*\d+\s*$/i, "").trim())
    .filter(Boolean);
}

function getSourceText(task, decision) {
  return String(
    task?.source_text ||
    task?.task_data?.source_text ||
    task?.task_data?.text ||
    decision?.received_text ||
    decision?.source_text ||
    ""
  ).trim();
}

function getTerms(task, decision) {
  const entities = decision?.entities || task?.task_data?.entities || {};
  const values = [
    entities.items, entities.item, entities.products, entities.product,
    task?.task_data?.items, task?.task_data?.item,
  ].filter((x) => x !== undefined && x !== null && x !== "");
  if (!values.length) values.push(getSourceText(task, decision));
  const out = [];
  for (const value of values) for (const term of extractTerms(value)) if (!out.includes(term)) out.push(term);
  return out.filter((x) => !["i need", "i want", "buy", "purchase", "get me", "fetch me", "please get", "please fetch", "order"].includes(normalize(x)));
}

function getCustomerLocation(task, decision) {
  const data = task?.task_data || {};
  const entities = decision?.entities || data.entities || {};
  const candidates = [entities, data, data.delivery_location, data.customer_location, data.location];
  for (const x of candidates) {
    if (!x || typeof x !== "object") continue;
    const lat = x.latitude ?? x.lat ?? x.customer_latitude;
    const lon = x.longitude ?? x.lon ?? x.lng ?? x.customer_longitude;
    if (validCoordinates(lat, lon)) return { latitude: Number(lat), longitude: Number(lon) };
  }
  return null;
}

async function matchUniversalPartnerStore({ task, decision, excludedPartnerStoreIds = [] } = {}) {
  const requestedTerms = getTerms(task, decision);
  if (!requestedTerms.length) return null;

  const excluded = new Set((Array.isArray(excludedPartnerStoreIds) ? excludedPartnerStoreIds : []).map(String));
  const catalogRows = await db("partner_store_catalog?available=eq.true&select=*&limit=1000");
  if (!Array.isArray(catalogRows) || !catalogRows.length) return null;

  const matches = requestedTerms.map((term) => ({ term, rows: catalogRows.filter((row) => itemMatches(term, row)) }));
  if (matches.some((x) => !x.rows.length)) return null;

  const storeIds = [...new Set(catalogRows.map((x) => x?.partner_store_id ? String(x.partner_store_id) : null).filter(Boolean))]
    .filter((id) => !excluded.has(id));
  const stores = storeIds.filter((id) => matches.every((m) => m.rows.some((row) => String(row.partner_store_id) === id)));
  if (!stores.length) return null;

  const resources = await db("atc_partner_store_resources?status=eq.available&select=*&limit=100");
  if (!Array.isArray(resources) || !resources.length) return null;

  const required = ["inventory_check", "price_quote", "order_fulfillment"];
  const customer = getCustomerLocation(task, decision);

  const candidates = resources.filter((r) => {
    const storeId = String(r?.partner_store_id || "");
    if (!stores.includes(storeId)) return false;
    const caps = Array.isArray(r?.capabilities) ? r.capabilities.map((x) => String(x).toLowerCase()) : [];
    return required.every((x) => caps.includes(x));
  }).map((r) => {
    const loc = r?.location || {};
    return {
      resource: r,
      resourceId: r.id,
      partnerStoreId: String(r.partner_store_id),
      distanceKm: customer ? haversineKm(customer.latitude, customer.longitude, loc.latitude, loc.longitude) : null,
      priority: Number(r.priority || 0),
    };
  });

  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    if (a.distanceKm !== null && b.distanceKm !== null) return a.distanceKm - b.distanceKm;
    if (a.distanceKm !== null) return -1;
    if (b.distanceKm !== null) return 1;
    return b.priority - a.priority;
  });

  const winner = candidates[0];
  const catalogMatches = matches.flatMap((m) => {
    const row = m.rows.find((x) => String(x.partner_store_id) === winner.partnerStoreId);
    return row ? [{ requested_term: m.term, catalog_id: row.id, item_name: row.item_name, normalized_name: row.normalized_name, price: row.price, partner_store_id: row.partner_store_id }] : [];
  });

  return {
    partnerStoreId: winner.partnerStoreId,
    resourceId: winner.resourceId,
    resource: winner.resource,
    distanceKm: winner.distanceKm === null ? null : Number(winner.distanceKm.toFixed(2)),
    reason: customer ? "universal_catalog_match_nearest_available_partner_store" : "universal_catalog_match_available_partner_store_no_customer_coordinates",
    requestedTerms,
    catalogMatches,
    customerLocation: customer,
  };
}

export async function registerAtcResource(resource) {
  const payload = {
    resource_key: resource.resource_key,
    resource_type: resource.resource_type,
    display_name: resource.display_name,
    status: resource.status || "available",
    capabilities: resource.capabilities || [],
    endpoint: resource.endpoint || null,
    metadata: resource.metadata || {},
  };
  const rows = await db("fetch_atc_resources?on_conflict=resource_key", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(payload),
  });
  return Array.isArray(rows) ? rows[0] || null : rows;
}

export async function findDigitalOrHumanResource({ capability, exclude = [] } = {}) {
  const types = RESOURCE_TYPES[capability] || ["digital_agent", "human_service"];
  const blocked = new Set((Array.isArray(exclude) ? exclude : []).map(String));
  const rows = await db("fetch_atc_resources?status=eq.available&select=*&limit=200");
  const candidates = (Array.isArray(rows) ? rows : []).filter((r) =>
    !blocked.has(String(r.id)) && types.includes(r.resource_type) && Array.isArray(r.capabilities) && r.capabilities.some((c) => String(c) === capability || String(c) === "*")
  );
  candidates.sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0));
  return candidates[0] || null;
}

export async function routeFetchTask({ task, decision, physicalOrder = null, excludedResourceIds = [], excludedPartnerStoreIds = [] } = {}) {
  const capability = String(decision?.preferred_capability || decision?.network || "").trim() || "human_or_digital_service";

  if (capability === "physical_network" && physicalOrder) {
    const match = await atcSafe(() => atcSelectPartnerStoreForOrder({ order: physicalOrder, excludedPartnerStoreIds }), "universal_physical_route");
    if (match) {
      return {
        route_type: "physical",
        capability,
        status: "matched",
        resource_type: "partner_store",
        resource_id: match.resourceId,
        partner_store_id: match.partnerStoreId,
        distance_km: match.distanceKm,
        reason: match.reason,
        requested_terms: match.requestedTerms || null,
        catalog_matches: match.catalogMatches || null,
        resource: match.resource || null,
      };
    }
    return { route_type: "physical", capability, status: "fallback_required", resource_type: "human_shopper", resource_id: null, reason: "No matching partner store/resource was found." };
  }

  if (capability === "physical_network") {
    const match = await atcSafe(() => matchUniversalPartnerStore({ task, decision, excludedPartnerStoreIds }), "universal_partner_store_route");
    if (match) {
      return {
        route_type: "physical",
        capability,
        status: "matched",
        resource_type: "partner_store",
        resource_id: match.resourceId,
        partner_store_id: match.partnerStoreId,
        distance_km: match.distanceKm,
        reason: match.reason,
        requested_terms: match.requestedTerms,
        catalog_matches: match.catalogMatches,
        customer_location: match.customerLocation,
        resource: match.resource,
      };
    }
    return {
      route_type: "physical",
      capability,
      status: "fallback_required",
      resource_type: "human_shopper",
      resource_id: null,
      reason: "No catalog-qualified partner store was found for all requested items.",
      requested_terms: getTerms(task, decision),
    };
  }

  const resource = await findDigitalOrHumanResource({ capability, exclude: excludedResourceIds });
  if (!resource) {
    return { route_type: "universal", capability, status: "awaiting_resource", resource_type: null, resource_id: null, reason: `No active resource is registered for ${capability}.` };
  }

  return {
    route_type: "universal",
    capability,
    status: "matched",
    resource_type: resource.resource_type,
    resource_id: resource.id,
    resource_key: resource.resource_key,
    display_name: resource.display_name,
    endpoint: resource.endpoint || null,
    resource,
  };
}

export async function atcRouterSafe(fn, label = "atc_router") {
  try { return await fn(); }
  catch (error) {
    console.error(`FETCH ATC ROUTER ERROR [${label}]:`, error);
    return null;
  }
}
