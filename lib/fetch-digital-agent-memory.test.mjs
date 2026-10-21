import test from "node:test";
import assert from "node:assert/strict";
import { normalizePermittedMemoryContext } from "./fetch-digital-agent.mjs";

test("requires an explicit owner-bound memory receipt before passing memory to the model", () => {
  assert.deepEqual(
    normalizePermittedMemoryContext([{ id: "m1", key: "city", value: "Kochi" }], null),
    [],
  );
  assert.deepEqual(
    normalizePermittedMemoryContext([{ id: "m1", key: "city", value: "Kochi" }], {
      policy: "explicit_consent_allowlist_v1",
      owner_bound: false,
      memory_ids: ["m1"],
    }),
    [],
  );
});

test("only sends items whose IDs appear in the permission receipt", () => {
  const items = [
    { id: "m1", key: "preferred_city", value: "Kochi" },
    { id: "m2", key: "other_customer_secret", value: "private" },
  ];
  const result = normalizePermittedMemoryContext(items, {
    policy: "explicit_consent_allowlist_v1",
    owner_bound: true,
    memory_ids: ["m1"],
  });
  assert.deepEqual(result, [{ key: "preferred_city", value: "Kochi" }]);
});

test("filters credential-like keys and bounds memory count and content", () => {
  const items = [
    { id: "m1", key: "api_key", value: "must not pass" },
    ...Array.from({ length: 20 }, (_, i) => ({
      id: "m" + (i + 2),
      key: "fact_" + i,
      value: "x".repeat(1000),
    })),
  ];
  const result = normalizePermittedMemoryContext(items, {
    policy: "explicit_consent_allowlist_v1",
    owner_bound: true,
    memory_ids: items.map((item) => item.id),
  });
  assert.ok(result.length <= 12);
  assert.ok(result.every((item) => !/api.?key/i.test(item.key)));
  assert.ok(result.reduce((sum, item) => sum + JSON.stringify(item.value).length + item.key.length, 0) <= 9000);
});
