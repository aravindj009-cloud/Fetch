import test from "node:test";
import assert from "node:assert/strict";
import {
  createOpenStreetMapServiceDiscoveryAdapter,
  clearOpenStreetMapServiceDiscoveryCacheForTests,
} from "./fetch-ioi-openstreetmap-adapter.mjs";

const fakeResponse = (body, { ok = true, status = 200 } = {}) => ({
  ok, status, async json() { return body; },
});
const task = (user_request) => ({ user_request });
const context = { latitude: 8.5241, longitude: 76.9366, city: "Thiruvananthapuram", radius_km: 10 };

test("requests a location pin rather than pretending a city name is a precise location", async () => {
  clearOpenStreetMapServiceDiscoveryCacheForTests();
  let calls = 0;
  const adapter = createOpenStreetMapServiceDiscoveryAdapter({
    fetchImpl: async () => { calls += 1; return fakeResponse({ elements: [] }); },
  });
  const result = await adapter.execute({
    task: task("Find an electrician in Trivandrum"),
    context: { city: "Trivandrum" },
  });
  assert.equal(result.status, "needs_clarification");
  assert.equal(result.success, false);
  assert.match(result.message, /location pin/i);
  assert.equal(calls, 0);
});

test("uses allowlisted tags and bounded radius; returns source attribution and unverified listing", async () => {
  clearOpenStreetMapServiceDiscoveryCacheForTests();
  let queryBody = "";
  let headers = {};
  const adapter = createOpenStreetMapServiceDiscoveryAdapter({
    fetchImpl: async (_url, options) => {
      queryBody = decodeURIComponent(String(options.body).replace(/^data=/, ""));
      headers = options.headers;
      return fakeResponse({
        osm3s: { timestamp_osm_base: "2026-10-20T00:00:00Z" },
        elements: [
          { type: "node", id: 123, lat: 8.525, lon: 76.937, tags: { name: "City Electricians", craft: "electrician", phone: "+91 90000 00000", website: "https://example.org", "addr:suburb": "Thirumala" } },
          { type: "way", id: 456, center: { lat: 8.53, lon: 76.94 }, tags: { name: "Second Electrical Works", craft: "electrician" } },
          { type: "node", id: 999, lat: 8.525, lon: 76.937, tags: { craft: "electrician" } },
        ],
      });
    },
  });
  const result = await adapter.execute({
    task: task("Find an electrician near me"),
    context: { ...context, radius_km: 100 },
  });
  assert.equal(result.success, true);
  assert.equal(result.status, "completed");
  assert.equal(result.result.outcome, "providers_found");
  assert.equal(result.result.provider_count, 2);
  assert.match(queryBody, /craft.*electrician/);
  assert.match(queryBody, /around:25000/);
  assert.match(headers["User-Agent"], /tryfetch\.in/);
  assert.equal(result.result.source_registry, "openstreetmap_overpass");
  assert.equal(result.result.independently_verified, false);
  assert.equal(result.result.attribution, "© OpenStreetMap contributors");
  assert.match(result.sources[0].uri, /openstreetmap\.org/);
  assert.equal(result.result.providers[0].contact_phone, "+91 90000 00000");
  assert.match(result.result.providers[0].listing_uri, /node\/123/);
});

test("supports plumber lookup but clarifies for a category without a tag mapping", async () => {
  clearOpenStreetMapServiceDiscoveryCacheForTests();
  const adapter = createOpenStreetMapServiceDiscoveryAdapter({
    fetchImpl: async (_url, options) => {
      const query = decodeURIComponent(String(options.body).replace(/^data=/, ""));
      return fakeResponse({
        elements: query.includes('craft"="plumber')
          ? [{ type: "node", id: 22, lat: 8.5241, lon: 76.9366, tags: { name: "Trade Pro" } }]
          : [],
      });
    },
  });
  const plumber = await adapter.execute({ task: task("Find a plumber nearby"), context });
  assert.equal(plumber.success, true);
  assert.equal(plumber.result.requested_service, "plumber");
  assert.equal(plumber.result.outcome, "providers_found");
  assert.equal(plumber.result.providers[0].business_name, "Trade Pro");
  const unsupported = await adapter.execute({ task: task("Find a pest control service"), context });
  assert.equal(unsupported.status, "needs_clarification");
  assert.match(unsupported.message, /electricians, plumbers, and carpenters/);
});


test("falls back sequentially when the primary Overpass endpoint is unavailable", async () => {
  clearOpenStreetMapServiceDiscoveryCacheForTests();
  const called = [];
  const adapter = createOpenStreetMapServiceDiscoveryAdapter({
    fetchImpl: async (url) => {
      called.push(url);
      if (url.includes("overpass-api.de")) return fakeResponse({}, { ok: false, status: 503 });
      return fakeResponse({
        elements: [
          { type: "node", id: 987, lat: 8.525, lon: 76.937, tags: { name: "Fallback Electrician", craft: "electrician" } },
        ],
      });
    },
  });
  const result = await adapter.execute({
    task: task("Find an electrician near me"),
    context,
  });
  assert.equal(result.success, true);
  assert.equal(result.result.outcome, "providers_found");
  assert.equal(result.result.provider_count, 1);
  assert.equal(result.result.providers[0].business_name, "Fallback Electrician");
  assert.equal(called.length, 2);
  assert.match(called[0], /overpass-api\.de/);
  assert.match(called[1], /overpass\.kumi\.systems/);
});

test("does not fan out to fallback endpoints after a rate-limit response", async () => {
  clearOpenStreetMapServiceDiscoveryCacheForTests();
  let calls = 0;
  const adapter = createOpenStreetMapServiceDiscoveryAdapter({
    fetchImpl: async () => {
      calls += 1;
      return fakeResponse({}, { ok: false, status: 429 });
    },
  });
  const result = await adapter.execute({ task: task("Find a carpenter nearby"), context });
  assert.equal(result.status, "source_unavailable");
  assert.equal(calls, 1);
});

test("does not retry a rate-limited public endpoint", async () => {
  clearOpenStreetMapServiceDiscoveryCacheForTests();
  let calls = 0;
  const adapter = createOpenStreetMapServiceDiscoveryAdapter({
    fetchImpl: async () => { calls += 1; return fakeResponse({}, { ok: false, status: 429 }); },
  });
  const result = await adapter.execute({ task: task("Find a carpenter nearby"), context });
  assert.equal(result.success, false);
  assert.equal(result.status, "source_unavailable");
  assert.equal(calls, 1);
  assert.match(result.message, /unavailable/i);
});

test("caches repeat queries briefly to reduce public Overpass traffic", async () => {
  clearOpenStreetMapServiceDiscoveryCacheForTests();
  let calls = 0;
  let now = 1000;
  const adapter = createOpenStreetMapServiceDiscoveryAdapter({
    now: () => now,
    fetchImpl: async () => { calls += 1; return fakeResponse({ elements: [] }); },
  });
  const first = await adapter.execute({ task: task("Find a plumber nearby"), context });
  const second = await adapter.execute({ task: task("Find a plumber nearby"), context });
  assert.equal(calls, 1);
  assert.equal(first.result.outcome, "no_candidates");
  assert.equal(second.result.outcome, "no_candidates");
  now += 6 * 60 * 1000;
  await adapter.execute({ task: task("Find a plumber nearby"), context });
  assert.equal(calls, 2);
});
