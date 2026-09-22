/* Fetch ATC Router V4 — universal routing layer

V4 fixes the universal physical-network routing gap.

Previous:
V9 -> physical_network -> routeFetchTask()
-> required physicalOrder
-> /api/fetch/universal has no persisted order
-> generic resource lookup
-> awaiting_resource

V4:
- Real physical orders keep using the existing catalog-aware ATC matcher.
- Universal/pre-order requests can match directly against the partner catalog.
- Customer coordinates are used when available.
- Without coordinates, ATC can still identify a partner store carrying ALL requested items.
- No physical order is created by this router.
*/

import {
  atcSafe,
  atcSelectPartnerStoreForOrder,
} from "./atc.mjs";

import {
  getAtcResourceById,
} from "./fetch-resource-registry.mjs";

const SUPABASE_URL =
  process.env.VITE_SUPABASE_URL ||
  "https://skfxzagxlxputwpwxwbe.supabase.co";

const SUPABASE_KEY =
  process.env.SUPABASE_SECRET_KEY;

function headers(extra = {}) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function db(path, options = {}) {
  if (!SUPABASE_KEY) {
    throw new Error("SUPABASE_SECRET_KEY is missing");
  }

  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/${path}`,
    {
      ...options,
      headers: headers(options.headers || {}),
    }
  );

  const raw = await response.text();
  let data = null;

  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = raw;
    }
  }

  if (!response.ok) {
    throw new Error(
      `Fetch ATC Router ${response.status}: ${
        typeof data === "string" ? data : JSON.stringify(data)
      }`
    );
  }

  return data;
}

const CAPABILITY_TO_RESOURCE_TYPES = {
  physical_network: ["partner_store", "human_shopper"],
  flight_api: ["flight_api"],
  reservation_api_or_phone: ["reservation_api", "phone_service"],
  phone_agent: ["phone_service", "voice_agent"],
  connected_app: ["connected_app"],
  messaging_api: ["messaging_api"],
  calendar_api: ["calendar_api"],
  digital_agent: ["digital_agent"],
  human_or_digital_service: ["digital_agent", "human_service", "phone_service"],
};

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

  const rows = await db(
    "fetch_atc_resources?on_conflict=resource_key",
    {
      method: "POST",
      headers: {
        Prefer: "resolution=merge-duplicates,return=representation",
      },
      body: JSON.stringify(payload),
    }
  );

  return Array.isArray(rows) ? rows[0] || null : rows;
}

export async function findDigitalOrHumanResource({ capability, exclude = [] } = {}) {
  const types =
    CAPABILITY_TO_RESOURCE_TYPES[capability] ||
    ["digital_agent", "human_service"];

  const rows = await db(
    "fetch_atc_resources?status=eq.available&select=*&limit=200"
  );

  const blocked = new Set(exclude.map(String));

  const candidates = (rows || []).filter(
    (resource) =>
      !blocked.has(String(resource.id)) &&
      types.includes(resource.resource_type) &&
      Array.isArray(resource.capabilities) &&
      resource.capabilities.some(
        (name) => String(name) === capability || String(name) === "*"
      )
  );

  candidates.sort(
    (a, b) => Number(b.priority || 0) - Number(a.priority || 0)
  );

  return candidates[0] || null;
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function itemNameMatches(term, row) {
  const normalizedTerm = normalizeText(term);
  if (!normalizedTerm) return false;

  const names = [
    row?.item_name,
    row?.normalized_name,
    ...(Array.isArray(row?.aliases) ? row.aliases : []),
  ]
    .filter(Boolean)
    .map(normalizeText)
    .filter(Boolean);

  return names.some(
    (name) =>
      normalizedTerm === name ||
      normalizedTerm.includes(name) ||
      name.includes(normalizedTerm)
  );
}

function extractItemTerms(value) {
  if (Array.isArray(value)) {
    return value
      .flatMap((item) => {
        if (typeof item === "string") return extractItemTerms(item);
        if (item && typeof item === "object") {
          return [item.name || item.item_name || item.product || item.title || ""];
        }
        return [];
      })
      .map((item) =>
        String(item || "")
          .replace(/^\s*\d+(?:\.\d+)?\s*(?:x|×)?\s*/i, "")
          .trim()
      )
      .filter(Boolean);
  }

  const raw = String(value || "").trim();
  if (!raw) return [];

  return raw
    .split(/\s*(?:,|\band\b|\+|&)\s*/i)
    .map((part) =>
      part
        .replace(/^\s*\d+(?:\.\d+)?\s*(?:x|×)?\s*/i, "")
        .replace(/\s*x\s*\d+\s*$/i, "")
        .trim()
    )
    .filter(Boolean);
}

function collectTaskItemValues(task, decision) {
  const values = [];
  const taskData = task?.task_data || {};
  const entities = decision?.entities || taskData?.entities || {};

  const candidates = [
    entities?.items,
    entities?.item,
    entities?.products,
    entities?.product,
    taskData?.items,
    taskData?.item,
    taskData?.products,
    taskData?.product,
  ];

  for (const candidate of candidates) {
    if (candidate !== null && candidate !== undefined && candidate !== "") {
      values.push(candidate);
    }
  }

  if (!values.length) {
    values.push(
      task?.source_text ||
      task?.task_data?.source_text ||
      task?.task_data?.text ||
      ""
    );
  }

  return values;
}

function extractUniversalItemTerms(task, decision) {
  const values = collectTaskItemValues(task, decision);
  const terms = [];

  for (const value of values) {
    for (const item of extractItemTerms(value)) {
      if (!terms.includes(item)) terms.push(item);
    }
  }

  const genericTerms = new Set([
    "i need to buy",
    "i need",
    "i want to buy",
    "i want",
    "buy",
    "purchase",
    "get me",
    "fetch me",
    "please get",
    "please fetch",
    "order",
  ]);

  return terms.filter(
    (term) => !genericTerms.has(normalizeText(term))
  );
}

function validCoordinates(latitude, longitude) {
  const lat = Number(latitude);
  const lon = Number(longitude);

  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180 &&
    !(lat === 0 && lon === 0)
  );
}

function haversineKm(latitude1, longitude1, latitude2, longitude2) {
  if (
    !validCoordinates(latitude1, longitude1) ||
    !validCoordinates(latitude2, longitude2)
  ) {
    return null;
  }

  const toRadians = (degrees) => degrees * Math.PI / 180;
  const lat1 = toRadians(Number(latitude1));
  const lat2 = toRadians(Number(latitude2));
  const deltaLat = toRadians(Number(latitude2) - Number(latitude1));
  const deltaLon = toRadians(Number(longitude2) - Number(longitude1));

  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) *
      Math.cos(lat2) *
      Math.sin(deltaLon / 2) ** 2;

  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getTaskCustomerCoordinates(task, decision) {
  const taskData = task?.task_data || {};
  const entities = decision?.entities || taskData?.entities || {};

  const locations = [
    entities,
    taskData,
    taskData?.delivery_location,
    taskData?.customer_location,
    taskData?.location,
  ];

  for (const location of locations) {
    if (!location || typeof location !== "object") continue;

    const latitude =
      location.latitude ??
      location.lat ??
      location.customer_latitude;

    const longitude =
      location.longitude ??
      location.lon ??
      location.lng ??
      location.customer_longitude;

    if (validCoordinates(latitude, longitude)) {
      return {
        latitude: Number(latitude),
        longitude: Number(longitude),
      };
    }
  }

  return null;
}

/*
  READ-ONLY universal partner-store matcher.

  Real persisted orders continue through atcSelectPartnerStoreForOrder().
  This path exists because /api/fetch/universal may be called before an
  order exists in the physical order system.
*/
async function matchUniversalPartnerStore({
  task,
  decision,
  excludedPartnerStoreIds = [],
} = {}) {
  const requestedTerms = extractUniversalItemTerms(task, decision);
  if (!requestedTerms.length) return null;

  const excluded = new Set(
    (Array.isArray(excludedPartnerStoreIds) ? excludedPartnerStoreIds : [])
      .map(String)
  );

  const catalogRows = await db(
    "partner_store_catalog?available=eq.true&select=*&limit=1000"
  );

  if (!Array.isArray(catalogRows) || !catalogRows.length) return null;

  const matchedByTerm = requestedTerms.map((requestedTerm) => ({
    requestedTerm,
    rows: catalogRows.filter((row) => itemNameMatches(requestedTerm, row)),
  }));

  if (!matchedByTerm.every((entry) => entry.rows.length > 0)) return null;

  const candidateStoreIds = [
    ...new Set(
      catalogRows
        .map((row) => row?.partner_store_id ? String(row.partner_store_id) : null)
        .filter(Boolean)
    ),
  ].filter((storeId) => !excluded.has(storeId));

  const storesThatCanFulfilAll = candidateStoreIds.filter((storeId) =>
    matchedByTerm.every((entry) =>
      entry.rows.some((row) => String(row.partner_store_id) === storeId)
    )
  );

  if (!storesThatCanFulfilAll.length) return null;

  const resources = await db(
    "atc_partner_store_resources?status=eq.available&select=*&limit=100"
  );

  if (!Array.isArray(resources) || !resources.length) return null;

  const requiredCapabilities = [
    "inventory_check",
    "price_quote",
    "order_fulfillment",
  ];

  const customerLocation = getTaskCustomerCoordinates(task, decision);

  const candidates = resources
    .filter((resource) => {
      const storeId = String(resource?.partner_store_id || "");
      if (!storeId || !storesThatCanFulfilAll.includes(storeId)) return false;

      const capabilities = Array.isArray(resource?.capabilities)
        ? resource.capabilities.map((value) => String(value).toLowerCase())
        : [];

      return requiredCapabilities.every((capability) =>
        capabilities.includes(capability)
      );
    })
    .map((resource) => {
      const location = resource?.location || {};
      const distanceKm = customerLocation
        ? haversineKm(
            customerLocation.latitude,
            customerLocation.longitude,
            location.latitude,
            location.longitude
          )
        : null;

      return {
        resource,
        partnerStoreId: String(resource.partner_store_id),
        resourceId: resource.id,
        distanceKm,
        priority: Number(resource.priority || 0),
      };
    });

  if (!candidates.length) return null;

  candidates.sort((a, b) => {
    if (a.distanceKm !== null && b.distanceKm !== null) {
      return a.distanceKm - b.distanceKm;
    }
    if (a.distanceKm !== null) return -1;
    if (b.distanceKm !== null) return 1;

    const priorityDifference = b.priority - a.priority;
    if (priorityDifference !== 0) return priorityDifference;
    return a.partnerStoreId.localeCompare(b.partnerStoreId);
  });

  const winner = candidates[0];

  const catalogMatches = matchedByTerm.flatMap((entry) => {
    const row = entry.rows.find(
      (item) => String(item.partner_store_id) === winner.partnerStoreId
    );
    if (!row) return [];

    return [{
      requested_term: entry.requestedTerm,
      catalog_id: row.id,
      item_name: row.item_name,
      normalized_name: row.normalized_name,
      price: row.price,
      partner_store_id: row.partner_store_id,
    }];
  });

  return {
    partnerStoreId: winner.partnerStoreId,
    resourceId: winner.resourceId,
    resource: winner.resource,
    distanceKm:
      winner.distanceKm === null
        ? null
        : Number(winner.distanceKm.toFixed(2)),
    reason: customerLocation
      ? "universal_catalog_match_nearest_available_partner_store"
      : "universal_catalog_match_available_partner_store_no_customer_coordinates",
    requestedTerms,
    catalogMatches,
    customerLocation,
  };
}

export async function routeFetchTask({
  task,
  decision,
  physicalOrder = null,
  excludedResourceIds = [],
  excludedPartnerStoreIds = [],
} = {}) {
  const capability =
    String(
      decision?.preferred_capability ||
      decision?.network ||
      ""
    ).trim() || "human_or_digital_service";

  /* REAL PHYSICAL ORDER */
  if (capability === "physical_network" && physicalOrder) {
    const match = await atcSafe(
      () =>
        atcSelectPartnerStoreForOrder({
          order: physicalOrder,
          excludedPartnerStoreIds,
        }),
      "universal_physical_route"
    );

    if (match) {
      const resource = await getAtcResourceById(match.resourceId);

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
        resource,
      };
    }

    return {
      route_type: "physical",
      capability,
      status: "fallback_required",
      resource_type: "human_shopper",
      reason: "No matching partner store/resource was found.",
    };
  }

  /* UNIVERSAL / PRE-ORDER PHYSICAL REQUEST */
  if (capability === "physical_network") {
    const universalMatch = await atcSafe(
      () =>
        matchUniversalPartnerStore({
          task,
          decision,
          excludedPartnerStoreIds,
        }),
      "universal_partner_store_route"
    );

    if (universalMatch) {
      return {
        route_type: "physical",
        capability,
        status: "matched",
        resource_type: "partner_store",
        resource_id: universalMatch.resourceId,
        partner_store_id: universalMatch.partnerStoreId,
        distance_km: universalMatch.distanceKm,
        reason: universalMatch.reason,
        requested_terms: universalMatch.requestedTerms,
        catalog_matches: universalMatch.catalogMatches,
        customer_location: universalMatch.customerLocation,
        resource: universalMatch.resource,
      };
    }

    return {
      route_type: "physical",
      capability,
      status: "fallback_required",
      resource_type: "human_shopper",
      resource_id: null,
      reason: "No catalog-qualified partner store was found for all requested items.",
      requested_terms: extractUniversalItemTerms(task, decision),
    };
  }

  /* OTHER NETWORKS */
  const resource = await findDigitalOrHumanResource({
    capability,
    exclude: excludedResourceIds,
  });

  if (!resource) {
    return {
      route_type: "universal",
      capability,
      status: "awaiting_resource",
      resource_type: null,
      resource_id: null,
      reason: `No active resource is registered for ${capability}.`,
    };
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
  try {
    return await fn();
  } catch (error) {
    console.error(`FETCH ATC ROUTER ERROR [${label}]:`, error);
    return null;
  }
}
