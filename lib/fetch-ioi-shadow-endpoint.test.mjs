import test from "node:test";
import assert from "node:assert/strict";

import handler from "../api/fetch/universal.mjs";

function mockResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(key, value) {
      this.headers[key] = value;
    },
    json(value) {
      this.body = value;
      return this;
    },
  };
}

test("universal API hides direct IoI test mode when preview flag is off", async () => {
  const oldValue = process.env.FETCH_IOI_SHADOW_MODE;
  delete process.env.FETCH_IOI_SHADOW_MODE;
  try {
    const res = mockResponse();
    await handler({
      method: "POST",
      body: { text: "Weather in Mumbai tomorrow", shadow_only: true },
    }, res);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { error: "not_found" });
  } finally {
    if (oldValue === undefined) delete process.env.FETCH_IOI_SHADOW_MODE;
    else process.env.FETCH_IOI_SHADOW_MODE = oldValue;
  }
});

test("direct IoI test mode supports only read-only weather/AQI tasks", async () => {
  const oldValue = process.env.FETCH_IOI_SHADOW_MODE;
  process.env.FETCH_IOI_SHADOW_MODE = "true";
  try {
    const res = mockResponse();
    await handler({
      method: "POST",
      body: { text: "Book me an electrician tomorrow", shadow_only: true },
    }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.status, "not_applicable");
    assert.equal(res.body.success, false);
  } finally {
    if (oldValue === undefined) delete process.env.FETCH_IOI_SHADOW_MODE;
    else process.env.FETCH_IOI_SHADOW_MODE = oldValue;
  }
});

test("universal API rejects malformed JSON before direct IoI test mode", async () => {
  const oldValue = process.env.FETCH_IOI_SHADOW_MODE;
  process.env.FETCH_IOI_SHADOW_MODE = "true";
  try {
    const res = mockResponse();
    await handler({ method: "POST", body: "{bad json" }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, "invalid_json");
  } finally {
    if (oldValue === undefined) delete process.env.FETCH_IOI_SHADOW_MODE;
    else process.env.FETCH_IOI_SHADOW_MODE = oldValue;
  }
});

test("Preview endpoint returns the Patch-to-Scout collaboration trace for local-service discovery", async () => {
  const oldValue = process.env.FETCH_IOI_SHADOW_MODE;
  process.env.FETCH_IOI_SHADOW_MODE = "true";
  try {
    const res = mockResponse();
    await handler({
      method: "POST",
      body: {
        text: "Find an electrician in Thiruvananthapuram",
        shadow_only: true,
        supplied_context: { city: "Thiruvananthapuram" },
      },
    }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.mode, "preview_ioi_direct_test");
    assert.equal(res.body.result.capability_key, "local_service_discovery");

    const collaboration = res.body.result.agent_collaboration;
    assert.ok(collaboration, "endpoint should expose the collaboration receipt");
    assert.equal(collaboration.status, "completed");
    assert.equal(collaboration.ok, true);
    assert.equal(collaboration.trace.message_count, 2);
    assert.equal(collaboration.trace.event_count, 2);
    assert.deepEqual(
      collaboration.trace.events.map((event) => [event.from_agent, event.to_agent]).sort(),
      [["fetch", "local_helper"], ["local_helper", "scout"]].sort(),
    );

    const handoff = collaboration.trace.events.find(
      (event) => event.from_agent === "local_helper" && event.to_agent === "scout",
    );
    assert.ok(handoff?.parent_message_id, "Scout request must be linked to its parent Patch message");
    assert.equal(collaboration.result.safety.providers_contacted, false);
    assert.equal(collaboration.result.safety.appointments_booked, false);
    assert.equal(collaboration.result.safety.independently_verified_by_scout, false);
  } finally {
    if (oldValue === undefined) delete process.env.FETCH_IOI_SHADOW_MODE;
    else process.env.FETCH_IOI_SHADOW_MODE = oldValue;
  }
});
