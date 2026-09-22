/* FETCH UNIVERSAL TASK ENGINE — V1
 *
 * Purpose:
 * - Turn V9 Fetch intelligence into one stable Universal Task Contract.
 * - Give ATC a consistent task shape regardless of domain.
 * - Preserve the existing WhatsApp physical-order engine.
 * - Allow multiple requests to be represented as separate tasks.
 * - Execute only the first ready task in V1, preserving the current MVP behavior.
 * - Never claim an external side effect unless a real connector completed it.
 *
 * Architecture:
 *
 * USER
 *   ↓
 * V8 MEMORY + CONTEXT
 *   ↓
 * V9 INTELLIGENCE / WORKFLOW
 *   ↓
 * UNIVERSAL TASK ENGINE
 *   ↓
 * ATC
 *   ↓
 * DIGITAL / PHYSICAL / HUMAN / PHONE / CONNECTED APP
 *
 * IMPORTANT:
 * This file intentionally does NOT replace the physical shopping engine.
 * Existing physical WhatsApp execution remains the owner of:
 *   partner store → shopper → customer
 */

import { processFetchV9Request } from "./fetch-v9.mjs";
import { routeFetchTask } from "./fetch-atc-router.mjs";
import { executeDigitalAgent } from "./fetch-digital-agent.mjs";

function cleanText(value) {
  return String(value ?? "").trim();
}

function normalizeStatus(value, fallback = "unknown") {
  const status = cleanText(value).toLowerCase();
  return status || fallback;
}

function normalizeNetwork(decision = {}) {
  return cleanText(
    decision?.network ||
    decision?.preferred_capability ||
    "human_service"
  );
}

function normalizeResourceType(decision = {}) {
  const network = normalizeNetwork(decision);

  if (decision?.resource_type) {
    return cleanText(decision.resource_type);
  }

  if (network === "physical_network") {
    return "partner_store";
  }

  if (network === "digital_agent") {
    return "digital_agent";
  }

  return null;
}

function getFirstStep(decisionItem, v9Result) {
  return (
    decisionItem?.plan?.steps?.[0] ||
    decisionItem?.decision?.first_step ||
    v9Result?.steps?.[0] ||
    null
  );
}

/*
 * UNIVERSAL TASK CONTRACT
 *
 * This is the common language between Fetch and ATC.
 *
 * Fetch decides:
 *   what the user wants
 *   what domain it belongs to
 *   whether confirmation is required
 *   what workflow/step should happen first
 *
 * ATC decides:
 *   who/what can execute it
 *   which resource to use
 *   how it should be routed
 */
export function buildUniversalTask({
  request,
  decision,
  step,
  index = 0,
} = {}) {
  const decisionData = decision?.decision || {};
  const intent = decision?.intent || {};
  const entities = decision?.entities || {};

  const sourceText =
    cleanText(decision?.received_text) ||
    cleanText(request?.received_text);

  const network = normalizeNetwork(decisionData);
  const resourceType = normalizeResourceType(decisionData);

  const taskId =
    decision?.workflow_task_id ||
    `${request?.workflow_id || "fetch"}-${index + 1}`;

  const goal =
    cleanText(decision?.plan?.source_text) ||
    sourceText;

  const objective =
    cleanText(step?.purpose) ||
    goal;

  const requiresConfirmation =
    Boolean(decisionData?.confirmation_required);

  const executionMode =
    cleanText(decisionData?.execution_mode) ||
    (step?.key === "search" || step?.key === "source_resource"
      ? "discover"
      : "execute");

  return {
    contract_version: "fetch-task-v1",

    task_id: taskId,
    workflow_id: request?.workflow_id || null,
    parent_task_id: request?.context?.active_task_id || null,

    customer_id: request?.customer_id || null,
    conversation_id: request?.conversation_id || null,
    channel: request?.channel || "unknown",

    user_request: sourceText,

    intent: {
      domain: cleanText(intent?.domain) || null,
      action: cleanText(intent?.action) || null,
      goal,
    },

    goal,
    objective,

    domain: cleanText(intent?.domain) || null,

    priority:
      cleanText(entities?.priority) ||
      cleanText(entities?.urgency) ||
      "normal",

    requires_confirmation: requiresConfirmation,

    workflow: {
      step_key: cleanText(step?.key) || null,
      step_type: cleanText(step?.type) || null,
      step_index: index,
      total_steps: Array.isArray(decision?.plan?.steps)
        ? decision.plan.steps.length
        : null,
      execution_mode: executionMode,
    },

    current_step: cleanText(step?.key) || null,

    execution_network: network,

    resource: {
      type: resourceType,
      id: null,
      provider_id: null,
      name: null,
    },

    status: decisionData?.status === "ready"
      ? "ready_for_atc"
      : "needs_clarification",

    result: null,

    entities: entities || {},

    memory: request?.context?.memory || {},

    metadata: {
      source: "fetch-v9",
      decision_status: normalizeStatus(
        decisionData?.status,
        "unknown"
      ),
      confirmation_status: requiresConfirmation
        ? "pending"
        : "not_required",
    },

    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function getDecisionItems(v9Result) {
  return Array.isArray(v9Result?.decisions)
    ? v9Result.decisions
    : [];
}

function buildUniversalTasks(v9Result) {
  const decisions = getDecisionItems(v9Result);

  return decisions.map((decisionItem, index) => {
    const step = getFirstStep(decisionItem, v9Result);

    return buildUniversalTask({
      request: v9Result,
      decision: decisionItem,
      step,
      index,
    });
  });
}

function firstReadyTask(tasks) {
  return (
    tasks.find(
      (task) =>
        task?.status === "ready_for_atc"
    ) || null
  );
}

function buildExecutionResult({
  task,
  route,
  execution = null,
} = {}) {
  return {
    task_id: task?.task_id || null,
    network: task?.execution_network || null,
    resource_type:
      route?.resource_type ||
      task?.resource?.type ||
      null,
    route_status: route?.status || null,
    execution,
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

  /*
   * STEP 1
   * Let the existing V8/V9 intelligence layer understand the request.
   */
  const v9 = await processFetchV9Request({
    text: receivedText,
    customerId,
    conversationId,
    channel,
    activeTaskId,
    suppliedIntent,
    suppliedContext,
  });

  /*
   * STEP 2
   * Convert every V9 decision into the Universal Task Contract.
   *
   * We keep all tasks in the response, even though V1 executes only
   * the first ready task. This is the foundation for true multi-step
   * execution in the next versions.
   */
  const tasks = buildUniversalTasks(v9);
  const readyTask = firstReadyTask(tasks);

  if (!readyTask) {
    return {
      version: "universal-task-v1",
      status: "needs_clarification",
      workflow_id: v9?.workflow_id || null,
      task: null,
      tasks,
      fetch: v9,
      atc: null,
      execution: null,
    };
  }

  /*
   * STEP 3
   * Build the ATC-facing task.
   *
   * Physical shopping is deliberately passed through as context only.
   * The existing WhatsApp order engine remains responsible for the
   * real partner-store/shopper transaction.
   */
  const physicalOrder =
    suppliedContext?.physical_order || null;

  const route = await routeFetchTask({
    task: {
      id: readyTask.task_id,
      source_text: readyTask.user_request,
      goal: readyTask.goal,
      objective: readyTask.objective,
      task_data: {
        contract_version: readyTask.contract_version,
        task_id: readyTask.task_id,
        workflow_id: readyTask.workflow_id,
        customer_id: readyTask.customer_id,
        conversation_id: readyTask.conversation_id,
        channel: readyTask.channel,
        user_request: readyTask.user_request,
        intent: readyTask.intent,
        domain: readyTask.domain,
        entities: readyTask.entities,
        execution_network: readyTask.execution_network,
        resource: readyTask.resource,
        requires_confirmation:
          readyTask.requires_confirmation,
        workflow: readyTask.workflow,
      },
    },
    decision: {
      ...(
        v9?.decisions?.find(
          (item) =>
            item?.received_text ===
            readyTask.user_request
        )?.decision || {}
      ),
      network: readyTask.execution_network,
      resource_type: readyTask.resource?.type,
      confirmation_required:
        readyTask.requires_confirmation,
      execution_mode:
        readyTask.workflow?.execution_mode,
    },
    physicalOrder,
  });

  if (!route || route.status !== "matched") {
    return {
      version: "universal-task-v1",
      status:
        route?.status ||
        "awaiting_resource",
      workflow_id: v9?.workflow_id || null,
      task: readyTask,
      tasks,
      fetch: v9,
      atc: route || null,
      execution: null,
    };
  }

  /*
   * STEP 4A — DIGITAL NETWORK
   *
   * This is the currently live universal connector.
   */
  if (
    route.resource_type ===
    "digital_agent"
  ) {
    const execution =
      await executeDigitalAgent({
        task: {
          id: readyTask.task_id,
          source_text:
            readyTask.user_request,
          goal: readyTask.goal,
          objective:
            readyTask.objective,
          task_data: {
            ...readyTask,
            atc_route: route,
          },
        },
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
          task_id:
            readyTask.task_id,
          atc_route: route,
        },
      });

    return {
      version: "universal-task-v1",
      status: execution?.success
        ? "completed"
        : "execution_failed",
      workflow_id:
        v9?.workflow_id || null,
      task: {
        ...readyTask,
        status: execution?.success
          ? "completed"
          : "execution_failed",
        resource: {
          ...readyTask.resource,
          type:
            route.resource_type ||
            readyTask.resource.type,
          id:
            route.resource_id ||
            null,
          name:
            route.resource?.name ||
            null,
        },
        result:
          execution?.result ||
          execution?.message ||
          null,
      },
      tasks,
      fetch: v9,
      atc: route,
      execution: buildExecutionResult({
        task: readyTask,
        route,
        execution,
      }),
    };
  }

  /*
   * STEP 4B — PHYSICAL NETWORK
   *
   * Do not execute a second order engine here.
   * The existing WhatsApp MVP takes over the physical flow.
   */
  if (
    route.resource_type ===
    "partner_store"
  ) {
    return {
      version: "universal-task-v1",
      status: "physical_network",
      workflow_id:
        v9?.workflow_id || null,
      task: {
        ...readyTask,
        status: "routed_to_physical_network",
        resource: {
          ...readyTask.resource,
          type: "partner_store",
          id:
            route.resource_id ||
            route.partnerStoreId ||
            null,
        },
      },
      tasks,
      fetch: v9,
      atc: route,
      execution: {
        success: false,
        status:
          "handled_by_existing_physical_engine",
        message:
          "ATC routed the request to the physical network. The existing Fetch physical-order engine remains responsible for partner-store, shopper and delivery execution.",
      },
    };
  }

  /*
   * STEP 4C — CONNECTOR SEAM
   *
   * We intentionally do not pretend that phone, flight, reservation,
   * calendar, messaging, human-service or connected-app actions happened.
   */
  return {
    version: "universal-task-v1",
    status: "resource_matched",
    workflow_id:
      v9?.workflow_id || null,
    task: {
      ...readyTask,
      status: "awaiting_connector",
      resource: {
        ...readyTask.resource,
        type:
          route.resource_type ||
          readyTask.resource.type ||
          null,
        id:
          route.resource_id ||
          null,
        provider_id:
          route.provider_id ||
          null,
        name:
          route.resource?.name ||
          null,
      },
    },
    tasks,
    fetch: v9,
    atc: route,
    execution: {
      success: false,
      status: "awaiting_connector",
      message:
        `ATC matched ${
          route.resource_type ||
          readyTask.execution_network ||
          "a resource"
        }, but no universal execution connector is enabled for it yet.`,
    },
  };
}
