import test from "node:test";
import assert from "node:assert/strict";

import handler from "./ioi-shadow.mjs";

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

test("direct IoI preview endpoint is hidden when the shadow feature flag is off", async () => {
  const oldValue = process.env.FETCH_IOI_SHADOW_MODE;
  delete process.env.FETCH_IOI_SHADOW_MODE;
  try {
    const res = mockResponse();
    await handler({ method: "POST", body: { text: "Weather in Mumbai tomorrow" } }, res);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { error: "not_found" });
  } finally {
    if (oldValue === undefined) delete process.env.FETCH_IOI_SHADOW_MODE;
    else process.env.FETCH_IOI_SHADOW_MODE = oldValue;
  }
});

test("direct IoI preview endpoint accepts only read-only weather/AQI tasks", async () => {
  const oldValue = process.env.FETCH_IOI_SHADOW_MODE;
  process.env.FETCH_IOI_SHADOW_MODE = "true";
  try {
    const res = mockResponse();
    await handler({ method: "POST", body: { text: "Book me an electrician tomorrow" } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.status, "not_applicable");
    assert.equal(res.body.success, false);
  } finally {
    if (oldValue === undefined) delete process.env.FETCH_IOI_SHADOW_MODE;
    else process.env.FETCH_IOI_SHADOW_MODE = oldValue;
  }
});

test("direct IoI preview endpoint rejects malformed request bodies", async () => {
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
