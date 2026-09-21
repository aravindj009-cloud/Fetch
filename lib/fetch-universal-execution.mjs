/* FETCH UNIVERSAL EXECUTION BRIDGE - V1

Purpose:
- Connect V9 Fetch Agent decisions to the ATC router.
- Resolve the ATC resource.
- Execute a live DIGITAL AGENT request when ATC selects digital_agent.
- Leave the existing physical shopping/order state machine untouched.
- Fail closed: never claim an external side effect happened unless the selected connector actually completed it.

Flow:
USER -> FETCH V9 -> ATC ROUTER -> RESOURCE -> DIGITAL AGENT (live) -> RESULT

Physical shopping remains owned by the existing WhatsApp order engine:
ATC -> partner store -> shopper -> customer
*/

import { processFetchV9Request } from "./fetch-v9.mjs";
import { routeFetchTask } from "./fetch-atc-router.mjs";
import { executeDigitalAgent } from "./fetch-digital-agent.mjs";

function cleanText(value) {
  return String(value || "").trim();
}

function normalizeDecision(decision = {}) {
  const network = cleanText(
    decision?.preferred_capability || decision?.network || ""
  );

  return {
    ...decision,
    preferred_capability: network || "human_or_digital_service",
  };
}

function firstReadyDecision(result) {
  const decisions = Array.isArray(result?.decisions) ? result.decisions : [];

  return (
    decisions.find((item) => item?.decision?.status === "ready") || null
  );
}

function buildUniversalTask({ request, decision, step } = {}) {
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
      network: decision?.decision?.network || null,
      workflow_id: request?.workflow_id || null,
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

  const decisionItem = firstReadyDecision(v9);

  if (!decisionItem) {
    return {
      version: "universal-v1",
      status: "needs_clarification",
      workflow_id: v9?.workflow_id || null,
      fetch: v9,
      atc: null,
      execution: null,
    };
  }

  const normalizedDecision = normalizeDecision(decisionItem.decision || {});
  const step = decisionItem?.plan?.steps?.[0] || v9?.steps?.[0] || null;

  const task = buildUniversalTask({
    request: v9,
    decision: decisionItem,
    step,
  });

  /* Physical orders are deliberately not executed here.

     The current WhatsApp physical transaction already owns:
       partner store -> shopper -> customer

     Universal V1 only resolves the ATC route. This prevents a second
     execution engine from creating duplicate physical orders.
  */
  const physicalOrder = suppliedContext?.physical_order || null;

  const route = await routeFetchTask({
    task,
    decision: normalizedDecision,
    physicalOrder,
  });

  if (!route || route.status !== "matched") {
    return {
      version: "universal-v1",
      status: route?.status || "awaiting_resource",
      workflow_id: v9?.workflow_id || null,
      fetch: v9,
      atc: route || null,
      execution: null,
    };
  }

  /* DIGITAL NETWORK

     This is the first live universal execution path.
     ATC selected a digital_agent resource, then this bridge invokes the connector.
     No browser credentials are involved.
  */
  if (route.resource_type === "digital_agent") {
    const execution = await executeDigitalAgent({
      task,
      route,
      resource: route.resource || {},
      context: {
        channel,
        text: receivedText,
        customer_id: customerId,
        conversation_id: conversationId,
        workflow_id: v9?.workflow_id || null,
        atc_route: route,
      },
    });

    return {
      version: "universal-v1",
      status: execution?.success ? "completed" : "execution_failed",
      workflow_id: v9?.workflow_id || null,
      fetch: v9,
      atc: route,
      execution,
    };
  }

  /* HUMAN / PHONE / OTHER NETWORKS

     Resolve only. Do not fake execution. A later connector can plug into
     this exact seam without changing Fetch's decision layer.
  */
  return {
    version: "universal-v1",
    status: "resource_matched",
    workflow_id: v9?.workflow_id || null,
    fetch: v9,
    atc: route,
    execution: {
      success: false,
      status: "awaiting_connector",
      message:
        `ATC matched ${route.resource_type || "a resource"}, but no universal execution connector is enabled for it yet.`,
    },
  };
}
