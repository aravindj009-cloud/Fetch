import test from "node:test";
import assert from "node:assert/strict";

import { createFetchServiceDiscoveryAdapter } from "./fetch-ioi-service-discovery.mjs";
import { executeIOITask } from "./fetch-ioi-provider-runtime.mjs";
import { classifyIOIReadOnlyIntent, runIOIShadowEvaluation } from "./fetch-ioi-shadow.mjs";

const STAGING_ENV = {
  FETCH_IOI_SERVICE_DIRECTORY_ENV: "staging",
  FETCH_IOI_SERVICE_DIRECTORY_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
  FETCH_IOI_SERVICE_DIRECTORY_PROJECT_REF: "abcdefghijklmnopqrst",
  FETCH_IOI_SERVICE_DIRECTORY_KEY: "server-only-test-key",
};

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}

function provider({
  id = "00000000-0000-4000-8000-000000000001",
  name = "Spark Electric Demo",
  latitude = 8.5341,
  longitude = 76.9366,
  publicListing = true,
  shareContact = true,
  status = "approved",
  category = "electrician",
  metadata = {},
} = {}) {
  return {
    id,
    business_name: name,
    category,
    subcategory: null,
    address: "Demo service area",
    latitude,
    longitude,
    service_area: "Thiruvananthapuram",
    capabilities: ["electrical_repair"],
    operating_hours: {
      monday: { open: "09:00", close: "18:00", internal_note: "must not leak" },
      internal_field: "must not leak",
    },
    status,
    updated_at: "2026-10-20T00:00:00.000Z",
    whatsapp_phone: "+919999999999",
    metadata: {
      public_listing: publicListing,
      share_contact_with_customers: shareContact,
      verified: false,
      public_service_area: "Thiruvananthapuram",
      public_profile_url: "https://directory.example/providers/spark?utm_source=test",
      private_note: "must not leak",
      ...metadata,
    },
  };
}

function createDirectoryFetch(rows, calls = []) {
  return async (input, options = {}) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), method: options.method || "GET" });
    if (url.hostname !== "abcdefghijklmnopqrst.supabase.co") {
      throw new Error("unexpected host");
    }
    if ((url.searchParams.get("select") || "") === "id,whatsapp_phone") {
      const ids = (url.searchParams.get("id") || "")
        .replace(/^in\.\(/, "")
        .replace(/\)$/, "")
        .split(",");
      return jsonResponse(rows
        .filter((row) => ids.includes(row.id) &&
          row.status === "approved" &&
          row.metadata?.public_listing === true &&
          row.metadata?.share_contact_with_customers === true)
        .map((row) => ({ id: row.id, whatsapp_phone: row.whatsapp_phone })));
    }
    return jsonResponse(rows);
  };
}

const sharedContext = {
  latitude: 8.5241,
  longitude: 76.9366,
  city: "Thiruvananthapuram",
  state: "Kerala",
  radius_km: 10,
};

test("classifier routes local service discovery but not booking side effects", () => {
  assert.equal(classifyIOIReadOnlyIntent("Find an electrician near me"), "local_service_discovery");
  assert.equal(classifyIOIReadOnlyIntent("I need a plumber in Trivandrum"), "local_service_discovery");
  assert.equal(classifyIOIReadOnlyIntent("Book me an electrician tomorrow"), null);
  assert.equal(classifyIOIReadOnlyIntent("Send a WhatsApp to an electrician"), null);
});

test("asks for service type instead of guessing", async () => {
  let calls = 0;
  const adapter = createFetchServiceDiscoveryAdapter({
    env: STAGING_ENV,
    fetchImpl: async () => { calls += 1; throw new Error("must not call provider"); },
  });
  const result = await adapter.execute({
    task: { user_request: "Find a good local professional" },
    context: sharedContext,
  });
  assert.equal(result.status, "needs_clarification");
  assert.deepEqual(result.result.missing_fields, ["service_type"]);
  assert.equal(calls, 0);
});

test("asks for city or a location pin rather than treating a state as a nearby location", async () => {
  const adapter = createFetchServiceDiscoveryAdapter({
    env: STAGING_ENV,
    fetchImpl: async () => { throw new Error("must not call provider"); },
  });
  const result = await adapter.execute({
    task: { user_request: "Find an electrician in Maharashtra" },
    context: {},
  });
  assert.equal(result.status, "needs_clarification");
  assert.deepEqual(result.result.missing_fields, ["location"]);
});

test("fails closed when staging configuration is absent and never falls back to production settings", async () => {
  let calls = 0;
  const adapter = createFetchServiceDiscoveryAdapter({
    env: {
      SUPABASE_URL: "https://production-project.supabase.co",
      SUPABASE_SECRET_KEY: "production-secret-that-must-not-be-used",
    },
    fetchImpl: async () => { calls += 1; throw new Error("must not call provider"); },
  });
  const result = await adapter.execute({
    task: { user_request: "Find an electrician in Thiruvananthapuram" },
    context: sharedContext,
  });
  assert.equal(result.status, "source_unavailable");
  assert.equal(result.result.outcome, "source_unavailable");
  assert.equal(calls, 0);
  assert.doesNotMatch(JSON.stringify(result), /production-secret/);
});

test("rejects staging URLs whose host does not match the explicit project ref", async () => {
  let calls = 0;
  const adapter = createFetchServiceDiscoveryAdapter({
    env: {
      ...STAGING_ENV,
      FETCH_IOI_SERVICE_DIRECTORY_SUPABASE_URL: "https://other-project.supabase.co",
    },
    fetchImpl: async () => { calls += 1; return jsonResponse([]); },
  });
  const result = await adapter.execute({
    task: { user_request: "Find an electrician in Thiruvananthapuram" },
    context: sharedContext,
  });
  assert.equal(result.status, "source_unavailable");
  assert.equal(calls, 0);
});

test("returns only approved, public, nearby providers with provenance", async () => {
  const rows = [
    provider(),
    provider({
      id: "00000000-0000-4000-8000-000000000002",
      name: "Far Away Electric Demo",
      latitude: 9.8,
      longitude: 76.9,
    }),
    provider({
      id: "00000000-0000-4000-8000-000000000003",
      name: "Private Listing Demo",
      publicListing: false,
    }),
    provider({
      id: "00000000-0000-4000-8000-000000000004",
      name: "Pending Listing Demo",
      status: "pending",
    }),
  ];
  const calls = [];
  const adapter = createFetchServiceDiscoveryAdapter({
    env: STAGING_ENV,
    fetchImpl: createDirectoryFetch(rows, calls),
  });
  const result = await executeIOITask({
    request: { text: "Find an electrician in Thiruvananthapuram", channel: "api" },
    task: {
      task_id: "service-discovery-test-1",
      user_request: "Find an electrician in Thiruvananthapuram",
      goal: "Find a nearby electrician",
      domain: "home_service",
    },
    requiredCapabilities: ["local_service_discovery"],
    adapters: [adapter],
    context: sharedContext,
    timeoutMs: 1000,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.provider.id, "fetch_service_directory");
  assert.equal(result.execution.success, true);
  assert.equal(result.execution.side_effect, false);
  assert.equal(result.receipt.outcome_confirmed, true);
  assert.equal(result.receipt.side_effect_completed, false);
  assert.equal(result.execution.result.provider_count, 1);
  assert.equal(result.execution.result.providers[0].business_name, "Spark Electric Demo");
  assert.equal(result.execution.result.providers[0].contact_phone, "+919999999999");
  assert.equal(result.execution.result.providers[0].contact_status, "not_contacted");
  assert.equal(result.execution.result.providers[0].acceptance_status, "not_requested");
  assert.equal(result.execution.result.providers[0].appointment_status, "not_booked");
  assert.equal(result.receipt.resource_refs.length, 1);
  assert.equal(result.receipt.resource_refs[0].source_registry, "fetch_partner_applications");
  assert.match(result.receipt.evidence[0].uri, /^https:\/\/directory\.example\//);
  assert.equal(calls.every((call) => call.method === "GET"), true);
  assert.equal(calls.length, 2);
  assert.equal(JSON.stringify(result).includes("private_note"), false);
  assert.equal(JSON.stringify(result).includes("internal_note"), false);
});

test("does not read or return contact details without partner contact-sharing consent", async () => {
  const rows = [provider({ shareContact: false })];
  const calls = [];
  const adapter = createFetchServiceDiscoveryAdapter({
    env: STAGING_ENV,
    fetchImpl: createDirectoryFetch(rows, calls),
  });
  const result = await adapter.execute({
    task: { user_request: "Find an electrician in Thiruvananthapuram" },
    context: sharedContext,
  });
  assert.equal(result.status, "completed");
  assert.equal(result.result.providers.length, 1);
  assert.equal("contact_phone" in result.result.providers[0], false);
  assert.equal(calls.length, 1);
});

test("out-of-radius providers are not returned even if the service category matches", async () => {
  const rows = [provider({ latitude: 9.8, longitude: 76.9 })];
  const adapter = createFetchServiceDiscoveryAdapter({
    env: STAGING_ENV,
    fetchImpl: createDirectoryFetch(rows),
  });
  const result = await adapter.execute({
    task: { user_request: "Find an electrician in Thiruvananthapuram" },
    context: sharedContext,
  });
  assert.equal(result.status, "completed");
  assert.equal(result.result.outcome, "no_candidates");
  assert.equal(result.result.providers.length, 0);
  assert.match(result.message, /No provider has been contacted/);
});

test("matches common city aliases when searching without GPS coordinates", async () => {
  const rows = [provider({ latitude: 8.5341, longitude: 76.9366 })];
  const adapter = createFetchServiceDiscoveryAdapter({
    env: STAGING_ENV,
    fetchImpl: createDirectoryFetch(rows),
  });
  const result = await adapter.execute({
    task: { user_request: "Find an electrician in Trivandrum" },
    context: {},
  });
  assert.equal(result.status, "completed");
  assert.equal(result.result.providers.length, 1);
  assert.equal(result.result.location.city, "Thiruvananthapuram");
  assert.equal(result.result.providers[0].business_name, "Spark Electric Demo");
});

test("IoI shadow result exposes a structured directory result and registry references", async () => {
  const rows = [provider({ shareContact: false })];
  const serviceDiscoveryAdapter = createFetchServiceDiscoveryAdapter({
    env: STAGING_ENV,
    fetchImpl: createDirectoryFetch(rows),
  });
  const shadow = await runIOIShadowEvaluation({
    request: {
      text: "Find an electrician in Thiruvananthapuram",
      channel: "api",
      suppliedContext: sharedContext,
    },
    existingResult: { status: "not_run", task: { task_id: "shadow-service-test" } },
    serviceDiscoveryAdapter,
    timeoutMs: 1000,
  });
  assert.equal(shadow.capability_key, "local_service_discovery");
  assert.equal(shadow.provider_id, "fetch_service_directory");
  assert.equal(shadow.status, "completed");
  assert.equal(shadow.service_discovery.provider_count, 1);
  assert.equal(shadow.service_discovery.providers[0].business_name, "Spark Electric Demo");
  assert.equal(shadow.service_discovery.contact_status, "not_contacted");
  assert.equal(shadow.service_discovery.appointment_status, "not_booked");
  assert.equal(shadow.receipt.outcome_confirmed, true);
  assert.equal(shadow.receipt.side_effect_completed, false);
  assert.equal(shadow.receipt.resource_refs.length, 1);
});


test("falls back to read-only OpenStreetMap when the internal directory is unavailable", async () => {
  const { clearOpenStreetMapServiceDiscoveryCacheForTests } = await import("./fetch-ioi-openstreetmap-adapter.mjs");
  clearOpenStreetMapServiceDiscoveryCacheForTests();
  let externalCalls = 0;
  const result = await runIOIShadowEvaluation({
    request: {
      text: "Find an electrician near me",
      channel: "website",
      suppliedContext: {
        customer_location: {
          city: "Thiruvananthapuram",
          latitude: 8.5241,
          longitude: 76.9366,
          radius_km: 10,
        },
      },
    },
    existingResult: { status: "conversation", execution: { success: true } },
    fetchImpl: async (_url, options) => {
      externalCalls += 1;
      assert.match(options.headers["User-Agent"], /tryfetch\.in/);
      return jsonResponse({
        osm3s: { timestamp_osm_base: "2026-10-20T00:00:00Z" },
        elements: [{
          type: "node", id: 9876, lat: 8.525, lon: 76.937,
          tags: { name: "Public Map Electrician", craft: "electrician", phone: "+91 90000 11111" },
        }],
      });
    },
  });
  assert.equal(result.status, "completed");
  assert.equal(result.success, true);
  assert.equal(result.provider_id, "openstreetmap_overpass");
  assert.equal(result.service_discovery.source_registry, "openstreetmap_overpass");
  assert.equal(result.service_discovery.providers[0].business_name, "Public Map Electrician");
  assert.equal(result.service_discovery.independently_verified, false);
  assert.equal(externalCalls, 1);
  assert.equal(result.side_effect_completed, false);
});
