/*
 * Shared customer-facing projection for IoI's read-only local service discovery.
 * The same deterministic text is used by the website and WhatsApp. This module
 * never contacts providers, creates appointments, or claims independent verification.
 */

const text = (value, max = 180) => String(value ?? "").trim().replace(/\s+/g, " ").slice(0, max);

function safeDistance(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function getIOIServiceDiscoveryResponseStatus(customerResponse) {
  if (customerResponse?.kind === "service_discovery_clarification") {
    return { success: false, status: "needs_clarification" };
  }
  if (customerResponse?.kind === "service_discovery_unavailable") {
    return { success: false, status: "source_unavailable" };
  }
  return { success: true, status: "completed" };
}

export function createIOIServiceDiscoveryCustomerResponse(shadowEvaluation) {
  if (
    shadowEvaluation?.mode !== "shadow" ||
    shadowEvaluation?.capability_key !== "local_service_discovery"
  ) return null;

  const discovery = shadowEvaluation.service_discovery;
  if (
    shadowEvaluation?.status === "source_unavailable" &&
    shadowEvaluation?.success === false &&
    discovery?.outcome === "source_unavailable"
  ) {
    const publicMapSource = discovery.source_registry === "openstreetmap_overpass";
    const service = text(discovery.requested_service, 100) || "local service";
    return {
      kind: "service_discovery_unavailable",
      text: publicMapSource
        ? "The public OpenStreetMap directory is unavailable right now for " + service + ". No provider has been contacted or booked. Please try again shortly."
        : "The Fetch service directory is unavailable right now for " + service + ". No provider has been contacted or booked. Please try again shortly.",
      providers: [],
      requested_service: service,
      location: text(discovery.location?.city, 120) || null,
      radius_km: null,
      source_name: text(discovery.source_name || "Fetch Service Directory", 120),
      source_registry: text(discovery.source_registry || "fetch_partner_applications", 100),
      contact_status: "not_contacted",
      acceptance_status: "not_requested",
      appointment_status: "not_booked",
      outcome_confirmed: false,
      side_effect_completed: false,
    };
  }

  if (
    shadowEvaluation?.status === "needs_clarification" &&
    shadowEvaluation?.success === false &&
    discovery?.outcome === "needs_clarification" &&
    text(shadowEvaluation.summary, 1000)
  ) {
    return {
      kind: "service_discovery_clarification",
      text: text(shadowEvaluation.summary, 1000),
      providers: [],
      requested_service: text(discovery.requested_service, 100) || null,
      location: text(discovery.location?.city, 120) || null,
      radius_km: null,
      contact_status: "not_contacted",
      acceptance_status: "not_requested",
      appointment_status: "not_booked",
      outcome_confirmed: false,
      side_effect_completed: false,
    };
  }

  if (shadowEvaluation?.success !== true || shadowEvaluation?.status !== "completed") return null;
  if (!discovery || !["providers_found", "no_candidates"].includes(discovery.outcome)) return null;

  const publicMapSource = discovery.source_registry === "openstreetmap_overpass";
  const service = text(discovery.requested_service, 100) || "local service";
  const location = text(
    discovery.location?.city ||
    discovery.location?.location_name ||
    discovery.location?.name ||
    "",
    120
  );
  const radius = safeDistance(discovery.radius_km);
  const providers = (Array.isArray(discovery.providers) ? discovery.providers : [])
    .slice(0, 5)
    .map((provider) => ({
      business_name: text(provider?.business_name, 100),
      service_type: text(provider?.service_type || provider?.subcategory || service, 80),
      service_area: text(provider?.address || provider?.service_area, 150),
      distance_km: safeDistance(provider?.distance_km),
      contact_phone: text(provider?.contact_phone, 40),
      website: text(provider?.website, 180),
      listing_uri: text(provider?.listing_uri || provider?.profile_url, 250),
      contact_status: text(provider?.contact_status || "not_contacted", 40),
      acceptance_status: text(provider?.acceptance_status || "not_requested", 40),
      appointment_status: text(provider?.appointment_status || "not_booked", 40),
    }))
    .filter((provider) => provider.business_name);

  const where = location ? " near " + location : "";
  const radiusText = radius ? " within " + radius + " km" : "";
  const lines = [];

  if (discovery.outcome === "no_candidates" || providers.length === 0) {
    lines.push(publicMapSource
      ? "I couldn't find community-mapped OpenStreetMap listings for " + service + where + radiusText + ". This does not mean no providers operate in the area."
      : "I couldn't find an approved public listing for " + service + where + radiusText + ".");
  } else {
    lines.push(publicMapSource
      ? "Here are " + providers.length + " community-mapped OpenStreetMap listing" + (providers.length === 1 ? "" : "s") + " for " + service + where + ":"
      : "Here are " + providers.length + " approved public listing" + (providers.length === 1 ? "" : "s") + " for " + service + where + ":");
    providers.forEach((provider, index) => {
      const details = [];
      if (provider.service_area) details.push(provider.service_area);
      if (provider.distance_km !== null) details.push(provider.distance_km.toFixed(1) + " km from the shared location");
      if (provider.contact_phone) details.push("Phone: " + provider.contact_phone);
      if (provider.website) details.push("Website: " + provider.website);
      if (provider.listing_uri) details.push("Map: " + provider.listing_uri);
      lines.push((index + 1) + ". " + provider.business_name +
        (details.length ? " — " + details.join(" · ") : ""));
    });
  }

  if (publicMapSource) {
    lines.push("Source: © OpenStreetMap contributors. Listings are community-mapped, not independently verified by Fetch; availability and contact details may be outdated.");
  }
  lines.push("Directory results only: Fetch has not contacted anyone, confirmed availability, or booked an appointment.");
  return {
    kind: providers.length ? "service_providers" : "no_public_listings",
    text: lines.join("\n"),
    providers,
    requested_service: service,
    location: location || null,
    radius_km: radius,
    source_name: text(discovery.source_name || "Fetch Service Directory", 120),
    source_registry: text(discovery.source_registry || "fetch_partner_applications", 100),
    attribution: text(discovery.attribution || "", 180) || null,
    trust_level: text(discovery.trust_level || "application_registry", 100),
    contact_status: "not_contacted",
    acceptance_status: "not_requested",
    appointment_status: "not_booked",
    outcome_confirmed: false,
    side_effect_completed: false,
  };
}
