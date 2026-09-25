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
  const raw = cleanText(
    decision?.network ||
    decision?.preferred_capability ||
    "human_service"
  );

  const normalized = raw.toLowerCase();

  if (
    normalized === "browser" ||
    normalized === "browser_agent" ||
    normalized === "web_browser" ||
    normalized === "computer_use" ||
    normalized === "browser_use"
  ) {
    return "browser_agent";
  }

  return raw;
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


/*
 * Explicit browser-intent detection.
 *
 * V9 remains the general intelligence layer, but requests that explicitly
 * ask Fetch to interact with a website must be routed to the Browser Agent.
 *
 * Examples:
 *   "Open Wikipedia and tell me..."
 *   "Visit amazon.in and find..."
 *   "Search the web for..."
 *   "Go to this website..."
 *   "Check this webpage..."
 *   "Click the..."
 *   "Find this on the website..."
 *
 * Ordinary questions such as "Who founded Microsoft?" continue to use
 * the conversational Digital Agent.
 */
function hasExplicitBrowserIntent(text = "") {
  const value = cleanText(text).toLowerCase();

  if (!value) return false;

  const urlPattern =
    /\bhttps?:\/\/\S+|\bwww\.\S+|\b[a-z0-9-]+\.(?:com|in|org|net|io|ai|co|uk|gov|edu)\b/i;

  const browserPhrases = [
    /\bopen\s+(?:the\s+)?(?:website|webpage|site|url)\b/i,
    /\bopen\s+(?:wikipedia|amazon|flipkart|google|youtube|reddit|linkedin|instagram|facebook)\b/i,
    /\bvisit\s+(?:the\s+)?(?:website|webpage|site|url)\b/i,
    /\bgo\s+to\s+(?:the\s+)?(?:website|webpage|site|url)\b/i,
    /\bgo\s+to\s+(?:https?:\/\/|www\.)/i,
    /\bsearch\s+(?:the\s+)?(?:web|internet|online)\b/i,
    /\bsearch\s+online\s+for\b/i,
    /\blook\s+(?:it\s+)?up\s+online\b/i,
    /\bfind\s+(?:this|that|it)\s+(?:on|from)\s+(?:the\s+)?(?:website|web|internet)\b/i,
    /\bfind\s+.*\bon\s+(?:the\s+)?website\b/i,
    /\bcheck\s+(?:the\s+)?(?:website|webpage|site|url)\b/i,
    /\bcheck\s+.*\bonline\b/i,
    /\bclick\s+(?:on\s+)?(?:the\s+)?/i,
    /\bnavigate\s+to\b/i,
    /\bfill\s+(?:in\s+)?(?:the\s+)?(?:form|field)\b/i,
    /\bsubmit\s+(?:the\s+)?(?:form|application)\b/i,
    /\buse\s+(?:the\s+)?website\b/i,
    /\buse\s+(?:the\s+)?web\s+browser\b/i,
    /\bbrowse\s+(?:the\s+)?web\b/i,
    /\bfrom\s+(?:the\s+)?website\b/i,
    /\bon\s+(?:the\s+)?website\b/i,
  ];

  return (
    urlPattern.test(value) ||
    browserPhrases.some((pattern) => pattern.test(value))
  );
}

function hasResearchBrowserIntent(text = "") {
  const value = cleanText(text).toLowerCase();

  if (!value) return false;

  // Explicit research verbs: these mean Fetch should actually look at
  // current web pages rather than answer from model knowledge.
  const researchVerb =
    /\b(research|investigate|look\s+up|find|compare|check|verify|browse|search)\b/i.test(
      value
    );

  // Domains where a fresh web lookup is materially different from a
  // conversational knowledge answer.
  const researchDomain =
    /\b(flight|flights|hotel|hotels|restaurant|restaurants|football shoes|shoes|laptop|laptops|price|prices|product|products|job|jobs|event|events|visa|passport|travel|trip|ticket|tickets|course|courses|college|university|company|companies|startup|startups|service|services|coworking|coworking space|news|latest|current|official website|application deadline)\b/i.test(
      value
    );

  // Strong shopping/current-data phrases should browse even when the
  // wording doesn't contain "research".
  const transactionalResearch =
    /\b(under\s*[₹$€£]?\s*[\d,]+|below\s*[₹$€£]?\s*[\d,]+|cheapest|best\s+options|current\s+price|available\s+now|this\s+week|next\s+week|next\s+month|today|tonight|this\s+weekend)\b/i.test(
      value
    );

  return (
    (researchVerb && researchDomain) ||
    (researchVerb && /\b(on|online|web|internet|website)\b/i.test(value)) ||
    transactionalResearch
  );
}

function shouldUseBrowserForRequest(text = "") {
  return (
    hasExplicitBrowserIntent(text) ||
    hasResearchBrowserIntent(text)
  );
}

function applyBrowserIntentOverride(task, receivedText) {
  if (!task || !shouldUseBrowserForRequest(receivedText)) {
    return task;
  }

  /*
   * Never override a physical commerce request. Physical shopping remains
   * owned by the existing partner-store / shopper engine.
   */
  const existingNetwork = normalizeNetwork({
    network: task.execution_network,
  });

  if (
    existingNetwork === "physical_network" ||
    task.resource?.type === "partner_store"
  ) {
    return task;
  }

  return {
    ...task,
    execution_network: "browser_agent",
    resource: {
      ...(task.resource || {}),
      type: "browser_agent",
    },
    status: "ready_for_atc",
    metadata: {
      ...(task.metadata || {}),
      routing_override: hasExplicitBrowserIntent(receivedText)
        ? "explicit_browser_intent"
        : "research_browser_intent",
    },
  };
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


async function executeBrowserAgent({
  task,
  route,
  context = {},
} = {}) {
  const endpoint = cleanText(
    route?.endpoint ||
    route?.resource?.endpoint
  );

  if (!endpoint) {
    return {
      success: false,
      status: "awaiting_resource",
      message:
        "The Fetch Browser Agent is not connected yet.",
      execution_type: "browser_agent",
    };
  }

  const browserTask = cleanText(
    task?.user_request ||
    task?.goal ||
    task?.objective
  );

  if (!browserTask) {
    return {
      success: false,
      status: "invalid_task",
      message: "Fetch could not create a browser task.",
      execution_type: "browser_agent",
    };
  }

  const payload = {
    task: browserTask,
    url:
      context?.browser_url ||
      task?.entities?.url ||
      task?.entities?.website ||
      null,
    conversation_id:
      context?.conversation_id ||
      task?.conversation_id ||
      null,
    workflow_id:
      context?.workflow_id ||
      task?.workflow_id ||
      null,
  };

  const headers = {
    "Content-Type": "application/json",
  };

  const token = cleanText(
    process.env.BROWSER_WORKER_TOKEN ||
    route?.resource?.metadata?.token
  );

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  try {
    const response = await fetch(
      `${endpoint.replace(/\/+$/, "")}/execute`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      }
    );

    const raw = await response.text();

    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = raw;
    }

    if (!response.ok) {
      return {
        success: false,
        status: "browser_worker_error",
        message:
          typeof data === "string"
            ? data
            : data?.message ||
              `Browser worker returned HTTP ${response.status}.`,
        execution_type: "browser_agent",
      };
    }

    return {
      ...(data || {}),
      execution_type:
        data?.execution_type ||
        "browser_agent",
      worker_endpoint: endpoint,
    };
  } catch (error) {
    console.error(
      "FETCH BROWSER AGENT ERROR:",
      error
    );

    return {
      success: false,
      status: "browser_worker_unreachable",
      message:
        "Fetch could not reach the Browser Agent worker.",
      error:
        process.env.NODE_ENV === "development"
          ? error?.message || String(error)
          : undefined,
      execution_type: "browser_agent",
    };
  }
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
  let readyTask = firstReadyTask(tasks);

  /*
   * V9 may classify an explicit website request as a conversational
   * digital-agent task. Correct that at the Universal Execution boundary
   * so ATC receives the right execution network without changing the
   * general conversation behavior.
   */
  readyTask = applyBrowserIntentOverride(
    readyTask,
    receivedText
  );

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
   * STEP 4A — BROWSER NETWORK
   *
   * ATC selected the browser worker. The worker owns Chromium and
   * performs the actual website interaction.
   */
  if (
    route.resource_type ===
      "browser_agent"
  ) {
    const execution =
      await executeBrowserAgent({
        task: readyTask,
        route,
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
          browser_url:
            suppliedContext?.browser_url ||
            null,
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
          type: "browser_agent",
          id:
            route.resource_id ||
            null,
          name:
            route.display_name ||
            route.resource?.display_name ||
            "Fetch Browser Agent",
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
          conversation_history:
            Array.isArray(
              suppliedContext?.conversation_history
            )
              ? suppliedContext.conversation_history
              : [],
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
