import test from "node:test";
import assert from "node:assert/strict";
import { createFetchServiceDiscoveryCollaboration } from "./fetch-agent-collaboration.mjs";

test("Patch asks Scout to assess source metadata using a bounded, explicit handoff", async () => {
  const collaboration = createFetchServiceDiscoveryCollaboration();
  const result = await collaboration.run({
    taskId: "task_patch_scout_1",
    traceId: "trace_patch_scout_1",
    discovery: {
      outcome: "providers_found",
      requested_service: "electrician",
      source_registry: "openstreetmap_overpass",
      location: { city: "Thiruvananthapuram", latitude: 8.5, longitude: 76.9 },
      providers: [{
        id: "provider-1",
        business_name: "Example Electrician",
        service_type: "electrician",
        source_name: "OpenStreetMap contributors",
        trust_level: "community_mapped_not_independently_verified",
        listing_uri: "https://www.openstreetmap.org/node/123",
        independently_verified: false,
        contact_phone: "+919999999999",
        private_notes: "must not cross the agent boundary",
      }],
    },
  });

  assert.equal(result.status, "completed");
  assert.equal(result.ok, true);
  assert.equal(result.trace.message_count, 2);
  assert.equal(result.trace.event_count, 2);
  assert.deepEqual(result.trace.events.map((event) => [event.from_agent, event.to_agent]).sort(), [
    ["fetch", "local_helper"],
    ["local_helper", "scout"],
  ].sort());
  const scoutEvent = result.trace.events.find((event) => event.from_agent === "local_helper" && event.to_agent === "scout");
  assert.ok(scoutEvent?.parent_message_id);
  assert.equal(result.result.specialist_handoff.to_agent, "scout");
  assert.equal(result.result.providers[0].source_assessment.evidence_status, "source_reference_present");
  assert.equal(result.result.providers[0].source_assessment.verification_status, "not_independently_verified");
  assert.equal(result.result.safety.providers_contacted, false);
  assert.equal(result.result.safety.appointments_booked, false);
  assert.equal(result.result.safety.independently_verified_by_scout, false);
  const serialised = JSON.stringify(result);
  assert.equal(serialised.includes("+919999999999"), false);
  assert.equal(serialised.includes("must not cross the agent boundary"), false);
});

test("Scout does not upgrade missing-source listings to verified", async () => {
  const result = await createFetchServiceDiscoveryCollaboration().run({
    taskId: "task_patch_scout_2",
    discovery: {
      requested_service: "plumber",
      providers: [{ id: "provider-2", business_name: "Unlinked listing" }],
    },
  });
  assert.equal(result.status, "completed");
  assert.equal(result.result.providers[0].source_assessment.evidence_status, "source_reference_missing");
  assert.equal(result.result.providers[0].source_assessment.verification_status, "not_independently_verified");
  assert.match(result.result.providers[0].source_assessment.note, /No public source reference/);
});

test("collaboration stays bounded and handles an empty discovery result", async () => {
  const result = await createFetchServiceDiscoveryCollaboration({ maxMessages: 2 }).run({
    taskId: "task_patch_scout_empty",
    discovery: { outcome: "no_candidates", requested_service: "electrician", providers: [] },
  });
  assert.equal(result.status, "completed");
  assert.equal(result.trace.message_count, 2);
  assert.equal(result.result.provider_count, 0);
  assert.deepEqual(result.result.providers, []);
});
