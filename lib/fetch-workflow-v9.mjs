/* Fetch V9 Workflow Engine
   Persists multi-step task plans and controls dependency/confirmation state.
   It does not perform external side effects by itself.
*/

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || "https://skfxzagxlxputwpwxwbe.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;

function headers(extra = {}) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function db(path, options = {}) {
  if (!SUPABASE_KEY) throw new Error("SUPABASE_SECRET_KEY is missing");
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: headers(options.headers || {}),
  });
  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  if (!response.ok) {
    throw new Error(`Fetch Workflow ${response.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  }
  return data;
}

function asArray(value) { return Array.isArray(value) ? value : []; }

export function splitWorkflowRequests(text = "") {
  const input = String(text || "").trim().replace(/\s+/g, " ");
  if (!input) return [];

  const chunks = input
    .split(/\s*(?:;|\.|\bthen\b|\band then\b)\s*/i)
    .map((item) => item.trim())
    .filter(Boolean);

  if (chunks.length <= 1) return [input];

  const domainWord = /\b(flight|flights|airfare|ticket|hotel|restaurant|table|reservation|calendar|meeting|appointment|message|whatsapp|call|phone|grocery|groceries|milk|bread|eggs|food|kitkat|munch|buy|purchase|deliver|remind|reminder)\b/i;
  const meaningful = chunks.filter((chunk) => domainWord.test(chunk));
  if (meaningful.length <= 1) return [input];
  return meaningful;
}

export function buildWorkflowSteps({ decisions = [], originalText = "" } = {}) {
  const normalized = asArray(decisions);
  return normalized.map((item, index) => {
    const decision = item.decision || {};
    const intent = item.intent || {};
    const plan = item.plan || {};
    const firstStep = plan.steps?.[0] || decision.first_step || null;
    const previous = index > 0 ? [index - 1] : [];

    return {
      step_index: index,
      step_key: firstStep?.key || `${intent.domain || "task"}_${intent.action || "request"}`,
      purpose: firstStep?.purpose || `Handle: ${item.received_text || originalText}`,
      domain: intent.domain || "unknown",
      action: intent.action || "request",
      depends_on: previous,
      status: decision.status === "ready" && index === 0 ? "ready" : "blocked",
      input: {
        text: item.received_text || originalText,
        entities: item.entities || {},
      },
      output: {},
      decision,
      confirmation_required: Boolean(decision.confirmation_required),
      confirmation_status: decision.confirmation_required ? "pending" : "not_required",
      retry_count: 0,
      max_retries: 2,
      idempotency_key: null,
      execution_id: null,
    };
  });
}

export async function createWorkflow({
  customerId = null,
  conversationId = null,
  sourceChannel = "unknown",
  sourceText,
  objective = null,
  plan = {},
  contextSnapshotId = null,
  confirmationStatus = "not_required",
  metadata = {},
  steps = [],
} = {}) {
  if (!sourceText) throw new Error("sourceText is required");

  const workflowRows = await db("fetch_workflows", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      customer_id: customerId ? String(customerId) : null,
      conversation_id: conversationId ? String(conversationId) : null,
      source_channel: String(sourceChannel || "unknown"),
      source_text: String(sourceText),
      objective,
      status: steps.length ? (confirmationStatus === "pending" ? "awaiting_confirmation" : "ready") : "needs_clarification",
      plan: plan || {},
      context_snapshot_id: contextSnapshotId ? String(contextSnapshotId) : null,
      current_step_index: steps.length ? 0 : null,
      confirmation_status: confirmationStatus,
      metadata: metadata || {},
    }),
  });

  const workflow = asArray(workflowRows)[0] || workflowRows;
  if (!workflow?.id) throw new Error("Workflow creation failed");

  if (steps.length) {
    await db("fetch_workflow_steps", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(steps.map((step) => ({ workflow_id: workflow.id, ...step }))),
    });
  }

  await recordWorkflowEvent(workflow.id, null, "workflow_created", {
    step_count: steps.length,
    confirmation_status: confirmationStatus,
  });

  return workflow;
}

export async function getWorkflow(workflowId, { includeSteps = true } = {}) {
  if (!workflowId) return null;
  const workflows = await db(`fetch_workflows?id=eq.${encodeURIComponent(workflowId)}&limit=1`);
  const workflow = asArray(workflows)[0] || null;
  if (!workflow) return null;
  if (!includeSteps) return workflow;
  const steps = await db(`fetch_workflow_steps?workflow_id=eq.${encodeURIComponent(workflowId)}&order=step_index.asc`);
  return { ...workflow, steps: asArray(steps) };
}

export async function listCustomerWorkflows(customerId, limit = 10) {
  if (!customerId) return [];
  const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 50);
  const rows = await db(`fetch_workflows?customer_id=eq.${encodeURIComponent(customerId)}&order=created_at.desc&limit=${safeLimit}`);
  return asArray(rows);
}

function dependencySatisfied(step, allSteps) {
  const dependencies = asArray(step.depends_on);
  return dependencies.every((index) => {
    const dependency = allSteps.find((candidate) => Number(candidate.step_index) === Number(index));
    return dependency && dependency.status === "completed";
  });
}

export function getRunnableSteps(workflow) {
  const steps = asArray(workflow?.steps);
  return steps.filter((step) => {
    if (!["ready", "blocked"].includes(step.status)) return false;
    if (step.confirmation_required && step.confirmation_status !== "approved") return false;
    return dependencySatisfied(step, steps);
  });
}

export async function refreshWorkflowReadiness(workflowId) {
  const workflow = await getWorkflow(workflowId, { includeSteps: true });
  if (!workflow) return null;

  const runnable = getRunnableSteps(workflow);
  for (const step of runnable) {
    if (step.status === "ready") continue;
    await updateWorkflowStep(step.id, { status: "ready" });
  }

  const refreshed = await getWorkflow(workflowId, { includeSteps: true });
  if (!refreshed) return null;

  const pendingConfirmation = refreshed.steps.some((step) => step.confirmation_required && step.confirmation_status === "pending" && ["blocked", "ready"].includes(step.status));
  const allCompleted = refreshed.steps.length > 0 && refreshed.steps.every((step) => step.status === "completed");
  const hasFailed = refreshed.steps.some((step) => step.status === "failed" && Number(step.retry_count || 0) >= Number(step.max_retries || 0));

  let status = refreshed.status;
  if (allCompleted) status = "completed";
  else if (hasFailed) status = "failed";
  else if (pendingConfirmation) status = "awaiting_confirmation";
  else if (getRunnableSteps(refreshed).length) status = "ready";
  else status = "blocked";

  const current = refreshed.steps.find((step) => ["ready", "running"].includes(step.status));
  await updateWorkflow(refreshed.id, {
    status,
    current_step_index: current ? Number(current.step_index) : (allCompleted ? null : refreshed.current_step_index),
    confirmation_status: pendingConfirmation ? "pending" : (allCompleted ? "not_required" : refreshed.confirmation_status),
    completed_at: allCompleted ? new Date().toISOString() : null,
  });

  return getWorkflow(workflowId, { includeSteps: true });
}

export async function updateWorkflow(workflowId, patch = {}) {
  const rows = await db(`fetch_workflows?id=eq.${encodeURIComponent(workflowId)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
  return asArray(rows)[0] || rows;
}

export async function updateWorkflowStep(stepId, patch = {}) {
  const rows = await db(`fetch_workflow_steps?id=eq.${encodeURIComponent(stepId)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
  const step = asArray(rows)[0] || rows;
  if (step?.workflow_id) {
    await recordWorkflowEvent(step.workflow_id, step.id, "step_updated", patch);
  }
  return step;
}

export async function approveWorkflowStep(stepId) {
  return updateWorkflowStep(stepId, {
    confirmation_status: "approved",
    status: "ready",
  });
}

export async function rejectWorkflowStep(stepId) {
  return updateWorkflowStep(stepId, {
    confirmation_status: "rejected",
    status: "cancelled",
  });
}

export async function startWorkflowStep(stepId) {
  return updateWorkflowStep(stepId, {
    status: "running",
    started_at: new Date().toISOString(),
  });
}

export async function completeWorkflowStep(stepId, output = {}) {
  return updateWorkflowStep(stepId, {
    status: "completed",
    output: output || {},
    completed_at: new Date().toISOString(),
  });
}

export async function failWorkflowStep(stepId, error, { retryable = true } = {}) {
  const rows = await db(`fetch_workflow_steps?id=eq.${encodeURIComponent(stepId)}&limit=1`);
  const step = asArray(rows)[0];
  if (!step) throw new Error("Workflow step not found");
  const retryCount = Number(step.retry_count || 0);
  const maxRetries = Number(step.max_retries || 0);
  const canRetry = retryable && retryCount < maxRetries;

  return updateWorkflowStep(stepId, {
    status: canRetry ? "ready" : "failed",
    retry_count: retryCount + 1,
    output: { ...(step.output || {}), error: String(error?.message || error || "unknown_error") },
  });
}

export async function recordWorkflowEvent(workflowId, stepId, eventType, payload = {}) {
  if (!workflowId || !eventType) return null;
  try {
    const rows = await db("fetch_workflow_events", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ workflow_id: workflowId, step_id: stepId || null, event_type: eventType, payload: payload || {} }),
    });
    return asArray(rows)[0] || rows;
  } catch {
    return null;
  }
}
