/* FETCH CAPABILITY REGISTRY
 *
 * Runtime view over public.fetch_capabilities.
 * The database is the source of truth for which agent capabilities exist
 * and whether they are active/planned/disabled.
 */

const SUPABASE_URL =
  process.env.VITE_SUPABASE_URL ||
  "https://skfxzagxlxputwpwxwbe.supabase.co";

const SUPABASE_KEY =
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE;

async function db(path) {
  if (!SUPABASE_KEY) throw new Error("SUPABASE_SECRET_KEY is missing");

  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
    },
  });

  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }

  if (!response.ok) {
    throw new Error(`Fetch Capability Registry ${response.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  }

  return data;
}

let cache = null;
let cacheExpiresAt = 0;

export async function listCapabilities({ force = false } = {}) {
  if (!force && cache && Date.now() < cacheExpiresAt) return cache;

  const rows = await db(
    "fetch_capabilities?select=id,capability_key,display_name,resource_type,status,metadata,updated_at&order=capability_key.asc"
  );

  cache = Array.isArray(rows) ? rows : [];
  cacheExpiresAt = Date.now() + 60_000;
  return cache;
}

export async function getCapability(capabilityKey) {
  const key = String(capabilityKey || "").trim().toLowerCase();
  if (!key) return null;

  const capabilities = await listCapabilities();
  return (
    capabilities.find(
      (item) =>
        String(item?.capability_key || "").toLowerCase() === key
    ) || null
  );
}

export async function isCapabilityActive(capabilityKey) {
  const capability = await getCapability(capabilityKey);
  return capability?.status === "active";
}

const DOMAIN_TO_CAPABILITY = [
  ["shopping", "physical_network"],
  ["physical", "physical_network"],
  ["mobility", "connected_app"],
  ["ride", "connected_app"],
  ["taxi", "connected_app"],
  ["travel", "flight_api"],
  ["reservation", "reservation_api_or_phone"],
  ["restaurant", "reservation_api_or_phone"],
  ["phone", "phone_agent"],
  ["messaging", "messaging_api"],
  ["calendar", "calendar_api"],
  ["connected_app", "connected_app"],
  ["digital", "digital_agent"],
];

export async function resolveCapabilityForTask(task = {}) {
  const explicit =
    task?.capability ||
    task?.resource?.capability_key ||
    task?.resource?.capability ||
    null;

  if (explicit) {
    const capability = await getCapability(explicit);
    if (capability) return capability;
  }

  const domain = String(
    task?.domain ||
    task?.intent?.domain ||
    ""
  ).trim().toLowerCase();

  const key =
    DOMAIN_TO_CAPABILITY.find(([candidate]) =>
      domain === candidate || domain.includes(candidate)
    )?.[1] || null;

  return key ? getCapability(key) : null;
}

export async function buildCapabilityDecision(task = {}) {
  const capability = await resolveCapabilityForTask(task);

  if (!capability) {
    return {
      available: false,
      status: "unknown",
      capability: null,
      reason: "no_registered_capability",
    };
  }

  if (capability.status !== "active") {
    return {
      available: false,
      status: capability.status,
      capability,
      reason: "capability_not_active",
    };
  }

  return {
    available: true,
    status: "active",
    capability,
    reason: "capability_active",
  };
}
