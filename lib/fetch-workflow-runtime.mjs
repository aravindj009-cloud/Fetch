/* FETCH WORKFLOW RUNTIME
 *
 * Durable workflow controller over fetch_workflows + fetch_workflow_steps.
 * This is intentionally connector-agnostic: execution engines report their
 * result here, and the workflow state records exactly where Fetch stopped.
 */

const SUPABASE_URL =
  process.env.VITE_SUPABASE_URL ||
  "https://skfxzagxlxputwpwxwbe.supabase.co";
const SUPABASE_KEY =
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE;

function cleanText(v) {
  return v == null ? "" : String(v).trim();
}

async function db(path, options = {}) {
  if (!SUPABASE_KEY) throw new Error("SUPABASE_SECRET_KEY is missing");

  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }

  if (!response.ok) {
    throw new Error(
      `Fetch Workflow Runtime ${response.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`
    );
  }

  return data;
}

export async function getWorkflow(workflowId, { includeSteps = true, includeEvents = true } = {}) {
  if (!workflowId) return null;

  const rows = await db(
    `fetch_workflows?id=eq.${encodeURIComponent(workflowId)}&limit=1`
  );
  const workflow = Array.isArray(rows) ? rows[0] : null;
  if (!workflow) return null;

  if (includeSteps) {
    workflow.steps = await db(
      `fetch_workflow_steps?workflow_id=eq.${encodeURIComponent(workflowId)}&order=step_index.asc`
    );
  }

  if (includeEvents) {
    workflow.events = await db(
      `fetch_workflow_events?workflow_id=eq.${encodeURIComponent(workflowId)}&order=created_at.asc`
    );
  }

  return workflow;
}

export async function updateWorkflow(workflowId, patch = {}) {
  if (!workflowId) return null;

  const allowed = [
    "status",
    "current_step_index",
    "confirmation_status",
    "metadata",
    "plan",
    "completed_at",
  ];

  const body = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) body[key] = patch[key];
  }

  if (!Object.keys(body).length) return null;

  const rows = await db(
    `fetch_workflows?id=eq.${encodeURIComponent(workflowId)}`,
    {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(body),
    }
  );

  return Array.isArray(rows) ? rows[0] : rows;
}

export async function updateWorkflowStep(stepId, patch = {}) {
  if (!stepId) return null;

  const allowed = [
    "status",
    "input",
    "output",
    "decision",
    "confirmation_required",
    "confirmation_status",
    "retry_count",
    "execution_id",
    "started_at",
    "completed_at",
  ];

  const body = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) body[key] = patch[key];
  }

  if (!Object.keys(body).length) return null;

  const rows = await db(
    `fetch_workflow_steps?id=eq.${encodeURIComponent(stepId)}`,
    {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(body),
    }
  );

  return Array.isArray(rows) ? rows[0] : rows;
}

export async function addWorkflowEvent({
  workflowId,
  stepId = null,
  eventType,
  payload = {},
} = {}) {
  if (!workflowId) return null;

  const rows = await db("fetch_workflow_events", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      workflow_id: workflowId,
      step_id: stepId || null,
      event_type: cleanText(eventType) || "workflow_event",
      payload: payload && typeof payload === "object" ? payload : {},
    }),
  });

  return Array.isArray(rows) ? rows[0] : rows;
}

export async function syncWorkflowExecution({
  workflowId,
  task = {},
  result = {},
} = {}) {
  if (!workflowId) return null;

  const workflow = await getWorkflow(workflowId, {
    includeSteps: true,
    includeEvents: false,
  });

  if (!workflow) return null;

  const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
  const currentIndex = Number(workflow.current_step_index || 0);
  const currentStep =
    steps.find((step) => Number(step.step_index) === currentIndex) ||
    steps.find((step) => cleanText(step.step_key) === cleanText(task?.current_step)) ||
    steps[0] ||
    null;

  const status = cleanText(result?.status || task?.status).toLowerCase();

  if (currentStep) {
    const stepStatus =
      status === "completed"
        ? "completed"
        : status === "failed" || status === "execution_failed"
          ? "failed"
          : status === "awaiting_agent_approval" ||
              status === "awaiting_customer_price_confirmation" ||
              status === "payment_pending"
            ? "waiting"
            : "running";

    await updateWorkflowStep(currentStep.id, {
      status: stepStatus,
      output: {
        status: result?.status || null,
        message:
          result?.execution?.message ||
          result?.task?.result ||
          null,
        agent_task_id: result?.agent_task_id || null,
        atc: result?.atc || null,
        risk: result?.risk || null,
        capability: result?.capability || null,
      },
      decision: task?.intent || null,
      completed_at:
        stepStatus === "completed" || stepStatus === "failed"
          ? new Date().toISOString()
          : null,
    });
  }

  const nextIndex =
    status === "completed"
      ? Math.min(currentIndex + 1, Math.max(steps.length - 1, 0))
      : currentIndex;

  const terminal =
    status === "completed" && currentIndex >= Math.max(steps.length - 1, 0);
  const failed = status === "failed" || status === "execution_failed";
  const waiting =
    status === "awaiting_agent_approval" ||
    status === "awaiting_customer_price_confirmation" ||
    status === "payment_pending" ||
    status === "capability_not_available";

  const workflowStatus =
    terminal
      ? "completed"
      : failed
        ? "failed"
        : waiting
          ? "waiting"
          : "running";

  const updated = await updateWorkflow(workflowId, {
    status: workflowStatus,
    current_step_index: nextIndex,
    confirmation_status:
      waiting ? "pending" : workflow.confirmation_status || "not_required",
    completed_at:
      terminal || failed ? new Date().toISOString() : null,
    metadata: {
      ...(workflow.metadata || {}),
      last_execution_status: status,
      last_agent_task_id: result?.agent_task_id || null,
      last_route: result?.atc || null,
      last_risk: result?.risk || null,
      last_capability: result?.capability || null,
    },
  });

  await addWorkflowEvent({
    workflowId,
    stepId: currentStep?.id || null,
    eventType:
      terminal
        ? "workflow_completed"
        : failed
          ? "workflow_failed"
          : waiting
            ? "workflow_waiting"
            : "step_executed",
    payload: {
      current_step_index: nextIndex,
      status,
      workflow_status: workflowStatus,
      agent_task_id: result?.agent_task_id || null,
    },
  });

  return updated;
}
