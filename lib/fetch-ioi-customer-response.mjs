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

export function createIOIServiceDiscoveryCustomerResponse(shadowEvaluation) {
  if (
    shadowEvaluation?.mode !== "shadow" ||
    shadowEvaluation?.capability_key !== "local_service_discovery" ||
    shadowEvaluation?.success !== true ||
    shadowEvaluation?.status !== "completed"
  ) {
    return null;
  }

  const discovery = shadowEvaluation.service_discovery;
  if (!discovery || !["providers_found", "no_candidates"].includes(discovery.outcome)) {
    return null;
  }

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
      service_area: text(provider?.service_area, 100),
      distance_km: safeDistance(provider?.distance_km),
      contact_phone: text(provider?.contact_phone, 40),
      contact_status: text(provider?.contact_status || "not_contacted", 40),
      acceptance_status: text(provider?.acceptance_status || "not_requested", 40),
      appointment_status: text(provider?.appointment_status || "not_booked", 40),
    }))
    .filter((provider) => provider.business_name);

  const where = location ? " near " + location : "";
  const radiusText = radius ? " within " + radius + " km" : "";
  const lines = [];

  if (discovery.outcome === "no_candidates" || providers.length === 0) {
    lines.push("I couldn't find an approved public listing for " + service + where + radiusText + ".");
  } else {
    lines.push("Here are " + providers.length + " approved public listing" +
      (providers.length === 1 ? "" : "s") + " for " + service + where + ":");
    providers.forEach((provider, index) => {
      const details = [];
      if (provider.service_area) details.push(provider.service_area);
      if (provider.distance_km !== null) details.push(provider.distance_km.toFixed(1) + " km away");
      if (provider.contact_phone) details.push("Phone: " + provider.contact_phone);
      lines.push((index + 1) + ". " + provider.business_name +
        (details.length ? " — " + details.join(" · ") : ""));
    });
  }

  lines.push("These are directory matches only. Fetch has not contacted anyone or booked an appointment.");
  return {
    kind: providers.length ? "service_providers" : "no_public_listings",
    text: lines.join("\n"),
    providers,
    requested_service: service,
    location: location || null,
    radius_km: radius,
    contact_status: "not_contacted",
    acceptance_status: "not_requested",
    appointment_status: "not_booked",
    outcome_confirmed: false,
    side_effect_completed: false,
  };
}
