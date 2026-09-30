/* FETCH STEP EXECUTOR
 *
 * Orchestrates one durable plan at a time.
 *
 * The executor owns state transitions; concrete tools own side effects.
 * A tool adapter is injected as executeStep(step, context), which keeps
 * this layer safe and testable while the existing Fetch engines remain the
 * source of truth for physical and digital execution.
 */

import {
  getNextRunnablePlanStep,
  advancePlan,
} from "./fetch-multi-step-planner.mjs";

function now() {
  return new Date().toISOString();
}

function normalizeResult(result = {}) {
  const status = String(result?.status || "").toLowerCase();

  if (
    ["awaiting_agent_approval", "awaiting_customer_price_confirmation",
      "payment_pending", "capability_not_available"].includes(status)
  ) {
    return {
      state: "waiting",
      status,
      result,
    };
  }

  if (
    ["failed", "execution_failed", "error", "cancelled"].includes(status)
  ) {
    return {
      state: "failed",
      status,
      result,
    };
  }

  if (
    ["completed", "success"].includes(status) ||
    result?.success === true
  ) {
    return {
      state: "completed",
      status: status || "completed",
      result,
    };
  }

  return {
    state: "running",
    status: status || "running",
    result,
  };
}

export async function executeNextPlanStep({
  plan,
  context = {},
  executeStep,
  onStepStateChange = null,
} = {}) {
  if (!plan || !Array.isArray(plan.steps)) {
    throw new Error("A valid Fetch execution plan is required");
  }

  if (typeof executeStep !== "function") {
    throw new Error("Fetch Step Executor requires an executeStep adapter");
  }

  if (plan.failed) {
    return {
      plan,
      state: "failed",
      reason: "plan_already_failed",
      step: null,
    };
  }

  if (plan.completed) {
    return {
      plan,
      state: "completed",
      reason: "plan_already_completed",
      step: null,
    };
  }

  const step = getNextRunnablePlanStep(plan);

  if (!step) {
    const waiting = plan.steps.find(
      (candidate) =>
        ["ready", "blocked"].includes(candidate.status) &&
        candidate.confirmation_required &&
        candidate.confirmation_status !== "approved"
    );

    return {
      plan,
      state: waiting ? "waiting" : "blocked",
      reason: waiting
        ? "customer_approval_required"
        : "dependencies_or_capability_blocked",
      step: waiting || null,
    };
  }

  const startedAt = now();

  const runningPlan = advancePlan(plan, step.step_index, {
    status: "running",
    started_at: startedAt,
    last_attempt_at: startedAt,
    retry_count: Number(step.retry_count || 0),
  });

  if (typeof onStepStateChange === "function") {
    await onStepStateChange({
      event: "step_started",
      step,
      plan: runningPlan,
    });
  }

  let rawResult;

  try {
    rawResult = await executeStep(step, {
      ...context,
      plan: runningPlan,
      step_index: step.step_index,
      step_key: step.step_key,
    });
  } catch (error) {
    rawResult = {
      success: false,
      status: "execution_failed",
      error: error?.message || String(error),
    };
  }

  const normalized = normalizeResult(rawResult);

  const terminalPatch =
    normalized.state === "completed"
      ? {
          status: "completed",
          output: rawResult,
          completed_at: now(),
        }
      : normalized.state === "failed"
        ? {
            status: "failed",
            output: rawResult,
            error: rawResult?.error || rawResult?.message || null,
            completed_at: now(),
          }
        : normalized.state === "waiting"
          ? {
              status: "waiting",
              output: rawResult,
            }
          : {
              status: "running",
              output: rawResult,
            };

  const nextPlan = advancePlan(
    runningPlan,
    step.step_index,
    terminalPatch
  );

  if (typeof onStepStateChange === "function") {
    await onStepStateChange({
      event:
        normalized.state === "completed"
          ? "step_completed"
          : normalized.state === "failed"
            ? "step_failed"
            : normalized.state === "waiting"
              ? "step_waiting"
              : "step_running",
      step: nextPlan.steps.find(
        (candidate) =>
          Number(candidate.step_index) === Number(step.step_index)
      ),
      plan: nextPlan,
      result: rawResult,
    });
  }

  return {
    plan: nextPlan,
    state:
      nextPlan.completed
        ? "completed"
        : nextPlan.failed
          ? "failed"
          : normalized.state,
    step: nextPlan.steps.find(
      (candidate) =>
        Number(candidate.step_index) === Number(step.step_index)
    ),
    result: rawResult,
    next_step: getNextRunnablePlanStep(nextPlan),
  };
}

export async function executePlan({
  plan,
  context = {},
  executeStep,
  onStepStateChange = null,
  maxSteps = 20,
} = {}) {
  let currentPlan = plan;
  const history = [];

  for (let iteration = 0; iteration < maxSteps; iteration += 1) {
    const outcome = await executeNextPlanStep({
      plan: currentPlan,
      context,
      executeStep,
      onStepStateChange,
    });

    currentPlan = outcome.plan;

    history.push({
      step_index: outcome.step?.step_index ?? null,
      step_key: outcome.step?.step_key ?? null,
      state: outcome.state,
      status: outcome.step?.status ?? null,
    });

    if (
      outcome.state === "failed" ||
      outcome.state === "waiting" ||
      outcome.state === "blocked"
    ) {
      return {
        plan: currentPlan,
        state: outcome.state,
        history,
        result: outcome.result || null,
        next_step: outcome.next_step || null,
      };
    }

    if (outcome.state === "completed" && outcome.plan.completed) {
      return {
        plan: currentPlan,
        state: "completed",
        history,
        result: outcome.result || null,
        next_step: null,
      };
    }

    // A completed step with more work remaining automatically unlocks the
    // next dependency and continues the same plan.
    if (outcome.state === "completed" && outcome.next_step) {
      continue;
    }
  }

  return {
    plan: currentPlan,
    state: "iteration_limit",
    history,
    result: null,
    next_step: getNextRunnablePlanStep(currentPlan),
  };
}
