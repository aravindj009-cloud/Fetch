/* FETCH AGENT RUNTIME — V1
 *
 * Durable orchestration state for the Fetch personal agent.
 *
 * Responsibilities:
 * - Persist every user request as a Fetch Agent task.
 * - Persist planned steps and execution events.
 * - Keep the existing Universal Task Engine / ATC as the execution brain.
 * - Provide one durable task identity across Web, WhatsApp and future channels.
 *
 * This module deliberately uses the existing Supabase tables:
 *   fetch_agent_tasks
 *   fetch_agent_steps
 *   fetch_agent_events
 *   fetch_agent_sessions
 *
 * It never stores secrets or payment credentials.
 */

const SUPABASE_URL =
  process.env.VITE_SUPABASE_URL ||
  "https://skfxzagxlxputwpwxwbe.supabase.co";

const SUPABASE_KEY =
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE;

function headers(extra = {}) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function db(path, options = {}) {
  if (!SUPABASE_KEY) {
    throw new Error("SUPABASE_SECRET_KEY is missing");
  }

  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: headers(options.headers || {}),
  });

  const raw = await response.text();

  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = raw;
  }

  if (!response.ok) {
    throw new Error(
      `Fetch Agent Runtime ${response.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`
    );
  }

  return data;
}

function cleanText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(cleanText).filter(Boolean).join("\n").trim();

  if (typeof value === "object") {
    const preferred =
      value.text ??
      value.content ??
      value.message ??
      value.result ??
      value.answer ??
      value.output;

    if (preferred !== undefined && preferred !== value) {
      return cleanText(preferred);
    }

    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }

  return String(value).trim();
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "")
  );
}

function classifyTaskType(text, task = {}) {
  const value = cleanText(text).toLowerCase();
  const domain = cleanText(task?.domain || task?.intent?.domain).toLowerCase();

  if (
    /\b(milk|bread|eggs|grocery|groceries|kitkat|munch|buy|purchase|deliver|delivery|shop|shopping)\b/i.test(value) ||
    /physical|partner_store/i.test(String(task?.execution_network || ""))
  ) {
    return "shopping";
  }

  if (/\b(flight|flights|airfare|airport|train|hotel|travel|trip|ticket)\b/i.test(value)) {
    return "travel";
  }

  if (/\b(restaurant|table|reservation|reserve|dentist|doctor|appointment|book)\b/i.test(value)) {
    return "reservation";
  }

  if (/\b(email|inbox|mail|gmail|message|whatsapp|reply|send)\b/i.test(value)) {
    return "messaging";
  }

  if (/\b(calendar|meeting|schedule|remind|reminder)\b/i.test(value)) {
    return "calendar";
  }

  if (/\b(call|phone|ring|dial)\b/i.test(value)) {
    return "phone";
  }

  if (/\b(search|research|find out|look up|compare|latest|current|news)\b/i.test(value)) {
    return "research";
  }

  if (/\b(remember|forget|what do i prefer|my preference)\b/i.test(value)) {
    return "memory";
  }

  return domain || "other";
}

function mapResultStatus(result) {
  const status = cleanText(result?.status).toLowerCase();

  if (status === "completed") return "completed";
  if (
    status === "execution_failed" ||
    status === "server_error" ||
    status === "research_unavailable"
  ) {
    return "failed";
  }

  if (
    status === "awaiting_customer_price_confirmation" ||
    status === "awaiting_confirmation" ||
    status === "awaiting_agent_approval" ||
    status === "payment_pending" ||
    status === "needs_clarification" ||
    status === "awaiting_connector" ||
    status === "resource_matched"
  ) {
    return "waiting";
  }

  if (
    status === "physical_network" ||
    status === "routed_to_physical_network"
  ) {
    return "running";
  }

  return status || "running";
}

function mapStepStatus(value, fallback = "pending") {
  const status = cleanText(value).toLowerCase();

  if (["completed", "failed", "cancelled", "running", "pending", "waiting"].includes(status)) {
    return status;
  }

  if (["ready_for_atc", "routed_to_physical_network"].includes(status)) {
    return "running";
  }

  if (["needs_clarification", "awaiting_connector", "resource_matched"].includes(status)) {
    return "waiting";
  }

  return fallback;
}

function compactResult(result) {
  const task = result?.task || {};
  const execution = result?.execution || {};
  const atc = result?.atc || {};

  return {
    status: result?.status || null,
    workflow_id: result?.workflow_id || null,
    message: cleanText(
      execution?.message ||
      task?.result ||
      result?.message ||
      ""
    ).slice(0, 12000),
    task: {
      task_id: task?.task_id || null,
      status: task?.status || null,
      goal: cleanText(task?.goal),
      objective: cleanText(task?.objective),
      execution_network: cleanText(task?.execution_network),
      resource: task?.resource || null,
      result: task?.result || null,
    },
    risk: result?.risk || task?.risk || null,
    atc: {
      status: atc?.status || null,
      resource_type: atc?.resource_type || null,
      resource_id: atc?.resource_id || atc?.partnerStoreId || null,
      resource: atc?.resource || null,
    },
    execution: {
      success:
        execution?.success === true ||
        result?.status === "completed",
      status: execution?.status || null,
      execution_type: execution?.execution_type || null,
      provider: execution?.provider || null,
    },
    sources: Array.isArray(result?.sources)
      ? result.sources.slice(0, 10)
      : [],
  };
}

export async function createAgentTask({
  customerId = null,
  channel = "unknown",
  sourcePhone = null,
  rawRequest,
  taskType = "other",
  goal = null,
  confirmationRequired = false,
  confirmationStatus = "not_required",
  taskData = {},
  plan = [],
} = {}) {
  const body = {
    customer_id: isUuid(customerId) ? customerId : null,
    channel: cleanText(channel) || "unknown",
    source_phone: cleanText(sourcePhone) || null,
    raw_request: cleanText(rawRequest),
    task_type: cleanText(taskType) || "other",
    goal: cleanText(goal) || cleanText(rawRequest),
    status: "planning",
    confirmation_required: Boolean(confirmationRequired),
    confirmation_status: cleanText(confirmationStatus) || "not_required",
    task_data: taskData && typeof taskData === "object" ? taskData : {},
    plan: Array.isArray(plan) ? plan : [],
  };

  const rows = await db("fetch_agent_tasks", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(body),
  });

  return Array.isArray(rows) ? rows[0] : rows;
}

export async function updateAgentTask(taskId, patch = {}) {
  if (!isUuid(taskId)) return null;

  const allowed = [
    "status",
    "confirmation_required",
    "confirmation_status",
    "task_data",
    "plan",
    "result",
    "error",
    "completed_at",
  ];

  const body = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      body[key] = patch[key];
    }
  }

  if (!Object.keys(body).length) return null;

  const rows = await db(
    `fetch_agent_tasks?id=eq.${encodeURIComponent(taskId)}`,
    {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(body),
    }
  );

  return Array.isArray(rows) ? rows[0] : rows;
}

export async function addAgentEvent({
  taskId,
  customerId = null,
  eventType,
  status = null,
  actorType = "agent",
  actorId = null,
  metadata = {},
  payload = {},
} = {}) {
  if (!isUuid(taskId)) return null;

  const rows = await db("fetch_agent_events", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      task_id: taskId,
      agent_task_id: taskId,
      customer_id: isUuid(customerId) ? customerId : null,
      event_type: cleanText(eventType) || "event",
      status: cleanText(status) || null,
      actor_type: cleanText(actorType) || "agent",
      actor_id: cleanText(actorId) || null,
      metadata: metadata && typeof metadata === "object" ? metadata : {},
      payload: payload && typeof payload === "object" ? payload : {},
    }),
  });

  return Array.isArray(rows) ? rows[0] : rows;
}

export async function replaceAgentSteps(taskId, steps = []) {
  if (!isUuid(taskId)) return [];

  await db(
    `fetch_agent_steps?task_id=eq.${encodeURIComponent(taskId)}`,
    { method: "DELETE" }
  );

  const normalized = (Array.isArray(steps) ? steps : [])
    .slice(0, 25)
    .map((step, index) => ({
      task_id: taskId,
      sequence: Number(step?.sequence ?? step?.step_index ?? index),
      step_type:
        cleanText(step?.step_type || step?.type) ||
        "execution",
      capability:
        cleanText(
          step?.capability ||
          step?.execution_network ||
          step?.resource?.type
        ) || "unknown",
      status: mapStepStatus(step?.status),
      input: {
        purpose: cleanText(step?.purpose || step?.objective),
        goal: cleanText(step?.goal || step?.source_text),
        domain: cleanText(step?.domain || step?.intent?.domain),
        action: cleanText(step?.action || step?.intent?.action),
        resource: step?.resource || null,
      },
      output: step?.result || null,
      error: step?.error || null,
      started_at: null,
      completed_at: step?.status === "completed" ? new Date().toISOString() : null,
    }));

  if (!normalized.length) return [];

  const rows = await db("fetch_agent_steps", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(normalized),
  });

  return Array.isArray(rows) ? rows : [];
}

export async function getAgentTask(taskId, { includeSteps = true, includeEvents = true } = {}) {
  if (!isUuid(taskId)) return null;

  const taskRows = await db(
    `fetch_agent_tasks?id=eq.${encodeURIComponent(taskId)}&limit=1`
  );

  const task = Array.isArray(taskRows) ? taskRows[0] : null;
  if (!task) return null;

  const result = { ...task };

  if (includeSteps) {
    result.steps = await db(
      `fetch_agent_steps?task_id=eq.${encodeURIComponent(taskId)}&order=sequence.asc`
    );
  }

  if (includeEvents) {
    result.events = await db(
      `fetch_agent_events?task_id=eq.${encodeURIComponent(taskId)}&order=created_at.asc`
    );
  }

  return result;
}

export async function listAgentTasks({
  customerId = null,
  channel = null,
  conversationId = null,
  status = null,
  limit = 20,
} = {}) {
  const filters = [];
  if (isUuid(customerId)) {
    filters.push(`customer_id=eq.${encodeURIComponent(customerId)}`);
  }
  if (cleanText(channel)) {
    filters.push(`channel=eq.${encodeURIComponent(cleanText(channel))}`);
  }
  if (cleanText(status)) {
    filters.push(`status=eq.${encodeURIComponent(cleanText(status))}`);
  }

  /*
   * conversation_id lives in task_data because the existing task schema
   * predates the session table. Filter it in application space only when
   * necessary; the default endpoint remains cheap and indexed.
   */
  const rows = await db(
    `fetch_agent_tasks?${filters.join("&")}${filters.length ? "&" : ""}order=created_at.desc&limit=${Math.min(Math.max(Number(limit) || 20, 1), 100)}`
  );

  if (!cleanText(conversationId)) return rows;

  return (Array.isArray(rows) ? rows : []).filter(
    (row) => cleanText(row?.task_data?.conversation_id) === cleanText(conversationId)
  );
}

export async function upsertAgentSession({
  customerId = null,
  channel = "unknown",
  conversationId,
  context = {},
} = {}) {
  if (!cleanText(conversationId)) return null;

  const filters = [
    `conversation_id=eq.${encodeURIComponent(cleanText(conversationId))}`,
    `channel=eq.${encodeURIComponent(cleanText(channel) || "unknown")}`,
  ];

  if (isUuid(customerId)) {
    filters.push(`customer_id=eq.${encodeURIComponent(customerId)}`);
  }

  const existing = await db(
    `fetch_agent_sessions?${filters.join("&")}&limit=1`
  );

  const body = {
    customer_id: isUuid(customerId) ? customerId : null,
    channel: cleanText(channel) || "unknown",
    session_status: "active",
    context: context && typeof context === "object" ? context : {},
    last_message_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  if (Array.isArray(existing) && existing[0]?.id) {
    const rows = await db(
      `fetch_agent_sessions?id=eq.${encodeURIComponent(existing[0].id)}`,
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(body),
      }
    );
    return Array.isArray(rows) ? rows[0] : rows;
  }

  const rows = await db("fetch_agent_sessions", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      ...body,
      created_at: new Date().toISOString(),
    }),
  });

  return Array.isArray(rows) ? rows[0] : rows;
}

export async function persistUniversalRun({
  request = {},
  result = {},
  sourcePhone = null,
} = {}) {
  const rawRequest = cleanText(request?.text);
  const task = result?.task || {};
  const taskType = classifyTaskType(rawRequest, task);

  const initialPlan = Array.isArray(result?.tasks) && result.tasks.length
    ? result.tasks
    : [task].filter(Boolean);

  let agentTask = null;

  try {
    agentTask = await createAgentTask({
      customerId: request?.customerId,
      channel: request?.channel,
      sourcePhone,
      rawRequest,
      taskType,
      goal: task?.goal || task?.objective || rawRequest,
      confirmationRequired: Boolean(task?.requires_confirmation),
      confirmationStatus:
        task?.requires_confirmation
          ? "pending"
          : "not_required",
      taskData: {
        conversation_id: request?.conversationId || null,
        active_task_id: request?.activeTaskId || null,
        supplied_intent: request?.suppliedIntent || null,
        source: "universal_task_engine",
      },
      plan: initialPlan,
    });

    if (!agentTask?.id) {
      return result;
    }

    await addAgentEvent({
      taskId: agentTask.id,
      customerId: request?.customerId,
      eventType: "task_created",
      status: "planning",
      payload: {
        raw_request: rawRequest,
        channel: request?.channel || "unknown",
      },
    });

    await replaceAgentSteps(agentTask.id, initialPlan);

    await addAgentEvent({
      taskId: agentTask.id,
      customerId: request?.customerId,
      eventType: "plan_created",
      status: "planning",
      payload: {
        step_count: initialPlan.length,
        workflow_id: result?.workflow_id || null,
      },
    });

    const finalStatus = mapResultStatus(result);
    const compact = compactResult(result);

    await updateAgentTask(agentTask.id, {
      status: finalStatus,
      confirmation_required:
        Boolean(task?.requires_confirmation) ||
        finalStatus === "waiting",
      confirmation_status:
        finalStatus === "waiting"
          ? (
              cleanText(task?.confirmation_status) ||
              "pending"
            )
          : "not_required",
      result: compact,
      error:
        finalStatus === "failed"
          ? {
              status: result?.status || null,
              message: compact?.message || null,
            }
          : null,
      completed_at:
        finalStatus === "completed" || finalStatus === "failed"
          ? new Date().toISOString()
          : null,
      task_data: {
        conversation_id: request?.conversationId || null,
        active_task_id: request?.activeTaskId || null,
        workflow_id: result?.workflow_id || null,
        atc: result?.atc || null,
        execution_network: task?.execution_network || null,
      },
    });

    const eventType =
      finalStatus === "completed"
        ? "task_completed"
        : finalStatus === "failed"
          ? "task_failed"
          : finalStatus === "waiting"
            ? "task_waiting"
            : "task_running";

    await addAgentEvent({
      taskId: agentTask.id,
      customerId: request?.customerId,
      eventType,
      status: finalStatus,
      payload: compact,
    });

    if (request?.conversationId) {
      await upsertAgentSession({
        customerId: request?.customerId,
        channel: request?.channel,
        conversationId: request.conversationId,
        context: {
          active_task_id: agentTask.id,
          workflow_id: result?.workflow_id || null,
          last_status: finalStatus,
        },
      });
    }

    return {
      ...result,
      agent_task_id: agentTask.id,
      agent_task_status: finalStatus,
    };
  } catch (error) {
    /*
     * Agent persistence must never take Fetch's existing execution path
     * down. The Universal Task Engine remains the source of truth for
     * external execution; this layer is durable observability/orchestration.
     */
    console.error("FETCH AGENT RUNTIME ERROR:", error);

    return {
      ...result,
      agent_task_id: agentTask?.id || null,
      agent_task_status: mapResultStatus(result),
      agent_runtime_error: error?.message || String(error),
    };
  }
}
