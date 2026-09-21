/*
  FETCH ATC ROUTER - V1

  Purpose:
  - Connect Fetch V9 decisions to the ATC resource registry.
  - Resolve a concrete execution resource.
  - Keep physical shopping compatible with the existing ATC engine.
  - Provide the selected resource to the universal execution bridge.

  Flow:
  USER -> FETCH V9 -> ATC ROUTER -> RESOURCE -> EXECUTION
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
  if (!SUPABASE_KEY) {
    throw new Error("SUPABASE_SECRET_KEY is missing");
  }

  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: headers(options.headers || {}),
  });

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
  human_or_digital_service: [
    "digital_agent",
    "human_service",
    "phone_service",
  ],
};

export async function registerAtcResource(resource = {}) {
  const payload = {
    resource_key: resource.resource_key,
    resource_type: resource.resource_type,
    display_name: resource.display_name,
    status: resource.status || "available",
    capabilities: Array.isArray(resource.capabilities)
      ? resource.capabilities
      : [],
    endpoint: resource.endpoint || null,
    metadata: resource.metadata || {},
  };

  const rows = await db("fetch_atc_resources?on_conflict=resource_key", {
    method: "POST",
    headers: {
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify(payload),
  });

  return Array.isArray(rows) ? rows[0] || null : rows;
}

export async function findDigitalOrHumanResource({
  capability,
  exclude = [],
} = {}) {
  const types =
    CAPABILITY_TO_RESOURCE_TYPES[capability] || [
      "digital_agent",
      "human_service",
    ];

  const rows = await db(
    "fetch_atc_resources?status=eq.available&select=*&limit=200"
  );

  const blocked = new Set((exclude || []).map(String));

  const candidates = (Array.isArray(rows) ? rows : []).filter((resource) => {
    if (blocked.has(String(resource?.id))) return false;
    if (!types.includes(resource?.resource_type)) return false;

    const capabilities = Array.isArray(resource?.capabilities)
      ? resource.capabilities.map(String)
      : [];

    return (
      capabilities.includes(String(capability)) ||
      capabilities.includes("*")
    );
  });

  candidates.sort(
    (a, b) => Number(b?.priority || 0) - Number(a?.priority || 0)
  );

  return candidates[0] || null;
}

export async function routeFetchTask({
  task,
  decision,
  physicalOrder = null,
  excludedResourceIds = [],
} = {}) {
  const capability =
    String(decision?.preferred_capability || "").trim() ||
    "human_or_digital_service";

  if (capability === "physical_network" && physicalOrder) {
    const match = await atcSafe(
      () => atcSelectPartnerStoreForOrder({ order: physicalOrder }),
      "universal_physical_route"
    );

    if (match) {
      return {
        route_type: "physical",
        capability,
        status: "matched",
        resource_type: "partner_store",
        resource_id: match.resourceId || null,
        partner_store_id: match.partnerStoreId || null,
        distance_km: match.distanceKm ?? null,
        reason: match.reason || null,
        resource: match.resource || null,
      };
    }

    return {
      route_type: "physical",
      capability,
      status: "fallback_required",
      resource_type: "human_shopper",
      resource_id: null,
      reason: "No matching partner store/resource was found.",
    };
  }

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
