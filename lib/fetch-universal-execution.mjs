/* FETCH UNIVERSAL EXECUTION BRIDGE - V2

Purpose:
- Connect V9 Fetch Agent decisions to the ATC router.
- Execute a live DIGITAL AGENT request when ATC selects digital_agent.
- Execute a PHYSICAL partner-store request when an existing physical order
  is supplied by the authoritative WhatsApp order engine.
- Keep the existing physical order state machine authoritative.
- Never claim a physical order is completed merely because a store offer was sent.
- Fail closed when required execution context is missing.

Flow:
USER -> FETCH V9 -> ATC -> RESOURCE

DIGITAL:
  digital_agent -> live digital agent -> RESULT

PHYSICAL:
  partner_store -> existing partner-store WhatsApp engine
  -> store response -> existing shopper/delivery state machine -> RESULT

This is an integration layer, not a second order system.
*/

import { processFetchV9Request } from "./fetch-v9.mjs";
import { routeFetchTask } from "./fetch-atc-router.mjs";
import { executeDigitalAgent } from "./fetch-digital-agent.mjs";
import { executePhysicalPartnerStore } from "./fetch-physical-partner-store.mjs";

function cleanText(value) {
  return String(value || "").trim();
}

function normalizeDecision(decision = {}) {
  const network = cleanText(
    decision?.preferred_capability || decision?.network || ""
  );

  return {
    ...decision,
    preferred_capability:
      network || "human_or_digital_service",
  };
}

function firstReadyDecision(result) {
  const decisions = Array.isArray(result?.decisions)
    ? result.decisions
    : [];

  return (
    decisions.find(
      (item) => item?.decision?.status === "ready"
    ) || null
  );
}

function buildUniversalTask({
  request,
  decision,
  step,
} = {}) {
  return {
    id: request?.workflow_id || null,
    source_text: request?.received_text || "",
    goal:
      decision?.plan?.source_text ||
      request?.received_text ||
      "",
    objective:
      step?.purpose ||
      decision?.plan?.source_text ||
      request?.received_text ||
      "",
    task_data: {
      source_text: request?.received_text || "",
      text: request?.received_text || "",
      intent: decision?.intent || {},
      entities: decision?.entities || {},
      network:
        decision?.decision?.network || null,
      workflow_id:
        request?.workflow_id || null,
    },
  };
}

export async function executeUniversalFetchRequest({
  text,
  customerId = null,
  conversationId = null,
  channel = "api",
  activeTaskId = null,
  suppliedIntent = null,
  suppliedContext = {},
} = {}) {
  const receivedText = cleanText(text);

  if (!receivedText) {
    throw new Error("text is required");
  }

  const v9 = await processFetchV9Request({
    text: receivedText,
    customerId,
    conversationId,
    channel,
    activeTaskId,
    suppliedIntent,
    suppliedContext,
  });

  const decisionItem =
    firstReadyDecision(v9);

  if (!decisionItem) {
    return {
      version: "universal-v1",
      status: "needs_clarification",
      workflow_id:
        v9?.workflow_id || null,
      fetch: v9,
      atc: null,
      execution: null,
    };
  }

  const normalizedDecision =
    normalizeDecision(
      decisionItem.decision || {}
    );

  const step =
    decisionItem?.plan?.steps?.[0] ||
    v9?.steps?.[0] ||
    null;

  const task =
    buildUniversalTask({
      request: v9,
      decision: decisionItem,
      step,
    });

  /*
    The physical_order is optional.

    In the live WhatsApp flow, the existing order engine supplies it.
    For a standalone universal API request there may be no persisted
    physical order yet, so the physical connector will fail closed with
    awaiting_physical_order instead of creating a duplicate order.
  */
  const physicalOrder =
    suppliedContext?.physical_order ||
    suppliedContext?.physicalOrder ||
    null;

  const route =
    await routeFetchTask({
      task,
      decision: normalizedDecision,
      physicalOrder,
    });

  if (
    !route ||
    route.status !== "matched"
  ) {
    return {
      version: "universal-v1",
      status:
        route?.status ||
        "awaiting_resource",
      workflow_id:
        v9?.workflow_id || null,
      fetch: v9,
      atc: route || null,
      execution: null,
    };
  }

  /*
    DIGITAL NETWORK

    This is the live universal digital execution path.
  */
  if (
    route.resource_type ===
    "digital_agent"
  ) {
    const execution =
      await executeDigitalAgent({
        task,
        route,
        resource:
          route.resource || {},
        context: {
          channel,
          text: receivedText,
          customer_id: customerId,
          conversation_id:
            conversationId,
          workflow_id:
            v9?.workflow_id || null,
          atc_route: route,
        },
      });

    return {
      version: "universal-v1",
      status:
        execution?.success
          ? "completed"
          : "execution_failed",
      workflow_id:
        v9?.workflow_id || null,
      fetch: v9,
      atc: route,
      execution,
    };
  }

  /*
    PHYSICAL NETWORK

    ATC has already selected the partner store.
    The connector hands that decision to the existing physical
    execution engine. It does NOT create a second order workflow.

    If physical_order is absent, the connector returns
    awaiting_physical_order and no side effect occurs.
  */
  if (
    route.resource_type ===
    "partner_store"
  ) {
    const execution =
      await executePhysicalPartnerStore({
        task,
        route,
        physicalOrder,
        context: {
          channel,
          text: receivedText,
          customer_id: customerId,
          conversation_id:
            conversationId,
          workflow_id:
            v9?.workflow_id || null,
          atc_route: route,
        },
      });

    let status =
      execution?.success
        ? "submitted_to_partner_store"
        : "execution_failed";

    if (
      execution?.status ===
      "awaiting_physical_order"
    ) {
      status =
        "awaiting_physical_order";
    }

    return {
      version: "universal-v1",
      status,
      workflow_id:
        v9?.workflow_id || null,
      fetch: v9,
      atc: route,
      execution,
    };
  }

  /*
    HUMAN / PHONE / OTHER NETWORKS

    Resolve only. Never fake execution.
  */
  return {
    version: "universal-v1",
    status: "resource_matched",
    workflow_id:
      v9?.workflow_id || null,
    fetch: v9,
    atc: route,
    execution: {
      success: false,
      status: "awaiting_connector",
      message:
        `ATC matched ${
          route.resource_type ||
          "a resource"
        }, but no universal execution connector is enabled for it yet.`,
    },
  };
}
