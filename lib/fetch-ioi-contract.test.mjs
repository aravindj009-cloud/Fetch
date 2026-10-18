import test from "node:test";
import assert from "node:assert/strict";

import {
  IOI_PROTOCOL_VERSION,
  normalizeIOICapability,
  discoverIOICapabilities,
  buildIOITaskEnvelope,
  buildIOIExecutionReceipt,
  attachIOITrace,
} from "./fetch-ioi-contract.mjs";

test("normalizes a capability without exposing provider endpoints or arbitrary metadata", () => {
  const result = normalizeIOICapability({
    capability_key: "weather_forecast",
    provider_id: "open_meteo",
    provider_name: "Open-Meteo",
    display_name: "Weather forecast",
    status: "active",
    resource_type: "public_api",
    tags: ["weather", "forecast"],
    domains: ["weather"],
    endpoint: "https://internal.example/with-secret",
    metadata: { token: "never expose", region: "eu-west" },
    policy: { supports_idempotency: true },
    trust: { level: "official", verified: true },
  });

  assert.equal(result.valid, true);
  assert.equal(result.capability.capability_key, "weather_forecast");
  assert.equal(result.capability.provider.id, "open_meteo");
  assert.equal(result.capability.status, "active");
  assert.equal(result.capability.policy.supports_idempotency, true);
  assert.equal(result.capability.trust.verified, true);
  assert.equal(JSON.stringify(result).includes("never expose"), false);
  assert.equal(JSON.stringify(result).includes("internal.example"), false);
});

test("rejects capability records without stable identifiers", () => {
  assert.deepEqual(
    normalizeIOICapability({ display_name: "Unnamed tool" }),
    {
      valid: false,
      reason: "capability_key_missing",
      capability: null,
    },
  );
});

test("discovery ranks the exact active capability and rejects inactive providers", () => {
  const discovery = discoverIOICapabilities({
    requiredCapabilities: ["weather_forecast"],
    candidates: [
      {
        capability_key: "digital_agent",
        provider_id: "fetch",
        display_name: "Generic digital agent",
        status: "active",
        tags: ["general_assistant"],
      },
      {
        capability_key: "weather_forecast",
        provider_id: "open_meteo",
        display_name: "Open-Meteo forecast",
        status: "active",
        tags: ["weather", "forecast"],
        domains: ["weather"],
        region: "global",
      },
      {
        capability_key: "weather_forecast",
        provider_id: "offline-weather",
        display_name: "Offline source",
        status: "offline",
        tags: ["weather"],
      },
    ],
    task: { domain: "weather" },
    region: "global",
  });

  assert.equal(discovery.status, "candidate_selected");
  assert.equal(discovery.selected_capability.capability_key, "weather_forecast");
  assert.equal(discovery.selected_capability.provider.id, "open_meteo");
  assert.equal(discovery.candidates_examined, 3);
  assert.equal(discovery.candidates.some((item) => item.capability.provider.id === "offline-weather" && item.compatible), false);
});

test("discovery explicitly reports when nothing compatible is available", () => {
  const discovery = discoverIOICapabilities({
    requiredCapabilities: ["flight_search"],
    candidates: [
      {
        capability_key: "weather_forecast",
        provider_id: "open_meteo",
        status: "active",
        tags: ["weather"],
      },
    ],
  });

  assert.equal(discovery.status, "no_compatible_candidate");
  assert.equal(discovery.selected_capability, null);
});

test("builds a portable task envelope with authorization and provenance", () => {
  const envelope = buildIOITaskEnvelope({
    createdAt: "2026-10-18T10:00:00.000Z",
    request: {
      text: "Book an electrician for tomorrow",
      channel: "whatsapp",
      conversationId: "conversation-1",
      suppliedContext: { approval_granted: false },
    },
    task: {
      task_id: "task-1",
      workflow_id: "workflow-1",
      contract_version: "fetch-task-v1",
      channel: "whatsapp",
      user_request: "Book an electrician for tomorrow",
      goal: "Arrange a qualified electrician visit",
      domain: "human_service",
      intent: { domain: "human_service", action: "book_service" },
      requires_confirmation: true,
      current_step: "discover_providers",
      metadata: { source: "fetch-v9", routing_override: "capability_discovery" },
      entities: { region: "Thiruvananthapuram" },
    },
    requiredCapabilities: ["electrician_discovery", "appointment_booking"],
  });

  assert.equal(envelope.protocol, "internet-of-intelligence");
  assert.equal(envelope.protocol_version, IOI_PROTOCOL_VERSION);
  assert.equal(envelope.origin.channel, "whatsapp");
  assert.equal(envelope.origin.workflow_id, "workflow-1");
  assert.deepEqual(envelope.requirements.capability_alternatives, [
    "electrician_discovery",
    "appointment_booking",
  ]);
  assert.equal(envelope.authorization.confirmation_required, true);
  assert.equal(envelope.authorization.approval_granted, false);
  assert.equal(envelope.requirements.region, "Thiruvananthapuram");
  assert.equal(envelope.provenance.created_by, "fetch-universal-execution");
});

test("execution receipt does not mistake a route match for a successful outcome", () => {
  const envelope = buildIOITaskEnvelope({
    request: { text: "Find an electrician" },
    task: { task_id: "task-2", status: "ready_for_atc" },
  });
  const receipt = buildIOIExecutionReceipt({
    envelope,
    result: {
      status: "resource_matched",
      atc: { status: "matched", resource_type: "human_service" },
      execution: { success: false, status: "awaiting_connector" },
    },
    completedAt: "2026-10-18T10:00:02.000Z",
  });

  assert.equal(receipt.outcome_confirmed, false);
  assert.equal(receipt.side_effect_completed, false);
  assert.equal(receipt.reported_status, "resource_matched");
});

test("execution receipt confirms a side effect only with explicit completed success", () => {
  const envelope = buildIOITaskEnvelope({
    request: { text: "Send the message" },
    task: { task_id: "task-3", requires_confirmation: false },
  });
  const receipt = buildIOIExecutionReceipt({
    envelope,
    result: {
      status: "completed",
      execution: {
        success: true,
        status: "completed",
        side_effect: true,
        execution_type: "messaging_api",
      },
    },
    startedAt: "2026-10-18T10:00:00.000Z",
    completedAt: "2026-10-18T10:00:01.500Z",
  });

  assert.equal(receipt.outcome_confirmed, true);
  assert.equal(receipt.side_effect_completed, true);
  assert.equal(receipt.timing.duration_ms, 1500);
});

test("evidence URIs are deduplicated and tracking parameters are removed", () => {
  const envelope = buildIOITaskEnvelope({
    request: { text: "Research semiconductor news" },
    task: { task_id: "task-4" },
  });
  const receipt = buildIOIExecutionReceipt({
    envelope,
    result: {
      status: "completed",
      sources: [
        {
          title: "Official announcement",
          url: "https://example.gov/release?utm_source=openai&id=42",
          publisher: "Example government",
        },
        {
          title: "Duplicate URL",
          url: "https://example.gov/release?id=42&utm_source=another",
        },
        { title: "Unsafe URI", url: "javascript:alert(1)" },
      ],
      execution: { success: true, status: "completed" },
    },
  });

  assert.equal(receipt.evidence_count, 1);
  assert.equal(receipt.evidence[0].uri, "https://example.gov/release?id=42");
  assert.equal(receipt.evidence[0].publisher, "Example government");
});

test("attachIOITrace is additive and preserves the existing Fetch result", () => {
  const original = {
    version: "universal-task-v7",
    status: "completed",
    workflow_id: "workflow-5",
    task: {
      task_id: "task-5",
      contract_version: "fetch-task-v1",
      channel: "api",
      user_request: "Get tomorrow's weather",
      domain: "weather",
      execution_network: "open_meteo",
      status: "completed",
      resource: { type: "weather_forecast", provider_id: "open_meteo", name: "Open-Meteo" },
    },
    atc: {
      status: "matched",
      capability: "weather_forecast",
      resource_type: "weather_forecast",
      provider_id: "open_meteo",
      resource: {
        id: "open-meteo-adapter",
        resource_type: "weather_forecast",
        display_name: "Open-Meteo",
        status: "available",
        capabilities: ["weather", "forecast"],
      },
    },
    execution: { success: true, status: "completed", execution: { success: true, status: "completed" } },
  };

  const traced = attachIOITrace({
    request: { text: "Get tomorrow's weather", channel: "api" },
    result: original,
    startedAt: "2026-10-18T10:00:00.000Z",
    completedAt: "2026-10-18T10:00:01.000Z",
  });

  assert.equal(traced.status, original.status);
  assert.equal(traced.workflow_id, original.workflow_id);
  assert.equal(traced.execution, original.execution);
  assert.equal(traced.ioi.protocol_version, IOI_PROTOCOL_VERSION);
  assert.equal(traced.ioi.task_envelope.task.task_id, "task-5");
  assert.equal(traced.ioi.execution_receipt.outcome_confirmed, true);
  assert.equal(traced.ioi.execution_receipt.provider_id, "open_meteo");
});
