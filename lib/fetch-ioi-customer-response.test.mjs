import test from "node:test";
import assert from "node:assert/strict";
import { createIOIServiceDiscoveryCustomerResponse, getIOIServiceDiscoveryResponseStatus } from "./fetch-ioi-customer-response.mjs";

const base = {
  mode: "shadow",
  capability_key: "local_service_discovery",
  success: true,
  status: "completed",
  service_discovery: {
    outcome: "providers_found",
    requested_service: "electrician",
    location: { city: "Thiruvananthapuram" },
    radius_km: 25,
    providers: [{
      business_name: "Example Electricals",
      service_area: "Thirumala",
      distance_km: 2.35,
      contact_phone: "+91-90000-00000",
      contact_status: "not_contacted",
      acceptance_status: "not_requested",
      appointment_status: "not_booked",
    }],
  },
};

test("projects approved local listings to one concise cross-channel response", () => {
  const response = createIOIServiceDiscoveryCustomerResponse(base);
  assert.equal(response.kind, "service_providers");
  assert.match(response.text, /Example Electricals/);
  assert.match(response.text, /2.4 km from the shared location/);
  assert.match(response.text, /Phone: \+91-90000-00000/);
  assert.match(response.text, /not contacted anyone.*booked an appointment/);
  assert.equal(response.outcome_confirmed, false);
  assert.equal(response.side_effect_completed, false);
});

test("does not publish a provider when the directory has no candidates", () => {
  const response = createIOIServiceDiscoveryCustomerResponse({
    ...base,
    service_discovery: { ...base.service_discovery, outcome: "no_candidates", providers: [] },
  });
  assert.equal(response.kind, "no_public_listings");
  assert.match(response.text, /couldn't find an approved public listing/);
  assert.equal(response.providers.length, 0);
});

test("fails closed for unavailable, unsuccessful, or unrelated shadow runs", () => {
  assert.equal(createIOIServiceDiscoveryCustomerResponse({ ...base, success: false }), null);
  assert.equal(createIOIServiceDiscoveryCustomerResponse({ ...base, status: "source_unavailable" }), null);
  assert.equal(createIOIServiceDiscoveryCustomerResponse({ ...base, capability_key: "weather_forecast" }), null);
  assert.equal(createIOIServiceDiscoveryCustomerResponse({ ...base, service_discovery: { ...base.service_discovery, outcome: "needs_clarification" } }), null);
});

test("does not leak malformed provider records or default unsafe statuses to success", () => {
  const response = createIOIServiceDiscoveryCustomerResponse({
    ...base,
    service_discovery: { ...base.service_discovery, providers: [{ business_name: "  Valid   Listing  ", contact_phone: "" }] },
  });
  assert.equal(response.providers.length, 1);
  assert.equal(response.providers[0].business_name, "Valid Listing");
  assert.equal(response.providers[0].contact_status, "not_contacted");
  assert.equal(response.providers[0].acceptance_status, "not_requested");
  assert.equal(response.providers[0].appointment_status, "not_booked");
});

test("does not convert missing distance values to zero kilometres", () => {
  const response = createIOIServiceDiscoveryCustomerResponse({
    ...base,
    service_discovery: {
      ...base.service_discovery,
      providers: [{ business_name: "Listing Without Distance", distance_km: null }],
    },
  });
  assert.equal(response.providers[0].distance_km, null);
  assert.doesNotMatch(response.text, /0\.0 km away/);
});


test("labels OSM results as community-mapped and not independently verified", () => {
  const response = createIOIServiceDiscoveryCustomerResponse({
    ...base,
    service_discovery: {
      ...base.service_discovery,
      source_registry: "openstreetmap_overpass",
      source_name: "OpenStreetMap contributors",
      trust_level: "community_mapped_not_independently_verified",
      attribution: "© OpenStreetMap contributors",
      providers: [{
        business_name: "OSM Electrician",
        listing_uri: "https://www.openstreetmap.org/node/123",
        distance_km: 1.2,
      }],
    },
  });
  assert.match(response.text, /community-mapped OpenStreetMap listing/);
  assert.match(response.text, /not independently verified by Fetch/);
  assert.match(response.text, /openstreetmap\.org\/node\/123/);
  assert.equal(response.source_registry, "openstreetmap_overpass");
});

test("projects a safe clarification when the public adapter needs a location pin", () => {
  const response = createIOIServiceDiscoveryCustomerResponse({
    ...base,
    success: false,
    status: "needs_clarification",
    summary: "Please share a location pin to search accurately.",
    service_discovery: {
      outcome: "needs_clarification",
      requested_service: "electrician",
      location: { city: "Trivandrum" },
      providers: [],
    },
  });
  assert.equal(response.kind, "service_discovery_clarification");
  assert.match(response.text, /location pin/);
  assert.equal(response.side_effect_completed, false);
});


test("returns a clear non-success response when the public directory is unavailable", () => {
  const response = createIOIServiceDiscoveryCustomerResponse({
    ...base,
    success: false,
    status: "source_unavailable",
    summary: "The public OpenStreetMap directory is unavailable right now.",
    service_discovery: {
      outcome: "source_unavailable",
      requested_service: "electrician",
      source_registry: "openstreetmap_overpass",
      source_name: "OpenStreetMap contributors",
      providers: [],
    },
  });
  assert.equal(response.kind, "service_discovery_unavailable");
  assert.match(response.text, /public OpenStreetMap directory is unavailable/);
  assert.match(response.text, /No provider has been contacted or booked/);
  assert.equal(response.side_effect_completed, false);
});

test("maps clarification and source-unavailable responses to honest execution states", () => {
  assert.deepEqual(getIOIServiceDiscoveryResponseStatus({ kind: "service_discovery_clarification" }), { success: false, status: "needs_clarification" });
  assert.deepEqual(getIOIServiceDiscoveryResponseStatus({ kind: "service_discovery_unavailable" }), { success: false, status: "source_unavailable" });
  assert.deepEqual(getIOIServiceDiscoveryResponseStatus({ kind: "service_providers" }), { success: true, status: "completed" });
  assert.deepEqual(getIOIServiceDiscoveryResponseStatus({ kind: "no_public_listings" }), { success: true, status: "completed" });
});
