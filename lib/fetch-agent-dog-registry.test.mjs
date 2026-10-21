import test from "node:test";
import assert from "node:assert/strict";
import { FETCH_AGENT_DOGS, getFetchAgentDog, resolveFetchAgentDog } from "./fetch-agent-dog-registry.mjs";

test("publishes six distinct Fetch dog profiles with capability and availability labels", () => {
  assert.equal(FETCH_AGENT_DOGS.length, 6);
  assert.equal(new Set(FETCH_AGENT_DOGS.map((agent) => agent.id)).size, 6);
  for (const agent of FETCH_AGENT_DOGS) {
    assert.ok(agent.name);
    assert.ok(agent.title);
    assert.ok(agent.capabilities.length);
    assert.ok(agent.status_label);
  }
});

test("routes local service intent to Patch without claiming live availability", () => {
  const agent = resolveFetchAgentDog("Find an electrician near me");
  assert.equal(agent.id, "local_helper");
  assert.equal(agent.status, "preview_experimental");
  assert.match(agent.status_label, /Experimental/);
});

test("routes daily minutes and EOD summary intent to Scribe", () => {
  assert.equal(resolveFetchAgentDog("Summarise today's meeting minutes and action items").id, "scribe");
  assert.equal(resolveFetchAgentDog("Prepare my end-of-day brief").id, "scribe");
});

test("routes journey requests to Trek without claiming live tracking is already enabled", () => {
  const agent = resolveFetchAgentDog("Track my minutes while I travel to Bangalore");
  assert.equal(agent.id, "journey");
  assert.equal(agent.status, "planned");
});

test("routes product/errand requests to Rover and research to Scout", () => {
  assert.equal(resolveFetchAgentDog("Get me milk and bread").id, "shopper");
  assert.equal(resolveFetchAgentDog("Research the latest AI agents").id, "scout");
});

test("uses Fetch Coordinator for unknown requests and unknown IDs", () => {
  assert.equal(resolveFetchAgentDog("Help me with a complicated personal task").id, "fetch");
  assert.equal(getFetchAgentDog("not-real").id, "fetch");
});
