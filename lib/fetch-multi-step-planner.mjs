/* FETCH MULTI-STEP PLANNER
 *
 * Converts the existing V9 decision output into an explicit executable
 * plan. This module is pure: it does not create orders or external side
 * effects. The executor can consume the returned plan one step at a time.
 */

import { assessFetchRisk } from "./fetch-risk-engine.mjs";
import { resolveExecutionTool, buildToolPlan } from "./fetch-tool-router.mjs";

function text(value) {
  return value == null ? "" : String(value).trim();
}

export async function buildExecutablePlan({
  decisions = [],
  originalText = "",
} = {}) {
  const items = Array.isArray(decisions) ? decisions : [];
  const steps = [];

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index] || {};
    const decision = item.decision || {};
    const intent = item.intent || {};
    const task = {
      user_request: text(item.received_text || originalText),
      goal: text(decision.goal || item.received_text || originalText),
      objective: text(decision.objective || item.received_text || originalText),
      domain: text(intent.domain || decision.domain || "unknown"),
      action: text(intent.action || decision.action || "request"),
      intent,
      execution_network: text(decision.network || decision.execution_network),
      resource: {
        type: decision.resource_type || null,
        id: decision.resource_id || null,
      },
      requires_confirmation: Boolean(decision.confirmation_required),
    };

    const risk = assessFetchRisk({
      text: task.user_request,
      task,
      route: null,
    });

    const toolResolution = await resolveExecutionTool(task);
    const toolPlan = buildToolPlan(task, toolResolution);

    steps.push({
      step_index: index,
      step_key:
        decision.first_step?.key ||
        decision.step_key ||
        `${task.domain || "task"}_${task.action || "request"}_${index + 1}`,
      purpose:
        decision.first_step?.purpose ||
        task.goal ||
        `Complete step ${index + 1}`,
      input: {
        text: task.user_request,
        intent,
        entities: item.entities || {},
      },
      domain: task.domain,
      action: task.action,
      depends_on: index > 0 ? [index - 1] : [],
      status: index === 0 ? "ready" : "blocked",
      risk,
      tool: toolPlan,
      confirmation_required: Boolean(
        risk.approval_required || decision.confirmation_required
      ),
      confirmation_status:
        risk.approval_required || decision.confirmation_required
          ? "pending"
          : "not_required",
      retry_count: 0,
      max_retries: 2,
    });
  }

  return {
    version: "fetch-plan-v1",
    objective: text(originalText),
    execution_policy: {
      mode: "sequential",
      stop_on_failure: true,
      require_approval_for_side_effects: true,
    },
    step_count: steps.length,
    steps,
  };
}

export function getNextRunnablePlanStep(plan = {}) {
  const steps = Array.isArray(plan.steps) ? plan.steps : [];

  return (
    steps.find((step) => {
      if (!["ready", "blocked"].includes(step.status)) return false;
      if (
        step.confirmation_required &&
        step.confirmation_status !== "approved"
      ) {
        return false;
      }

      return (Array.isArray(step.depends_on) ? step.depends_on : []).every(
        (dependencyIndex) =>
          steps.find(
            (candidate) =>
              Number(candidate.step_index) === Number(dependencyIndex)
          )?.status === "completed"
      );
    }) || null
  );
}

export function advancePlan(plan = {}, stepIndex, patch = {}) {
  const steps = Array.isArray(plan.steps) ? [...plan.steps] : [];

  const current = steps.find(
    (step) => Number(step.step_index) === Number(stepIndex)
  );

  if (!current) return plan;

  const updated = {
    ...current,
    ...patch,
  };

  const next = steps.map((step) =>
    Number(step.step_index) === Number(stepIndex) ? updated : step
  );

  for (const step of next) {
    if (step.status !== "blocked") continue;

    const dependencies = Array.isArray(step.depends_on)
      ? step.depends_on
      : [];

    if (
      dependencies.every(
        (dependencyIndex) =>
          next.find(
            (candidate) =>
              Number(candidate.step_index) === Number(dependencyIndex)
          )?.status === "completed"
      )
    ) {
      step.status =
        step.confirmation_required &&
        step.confirmation_status !== "approved"
          ? "blocked"
          : "ready";
    }
  }

  return {
    ...plan,
    steps: next,
    completed:
      next.length > 0 &&
      next.every((step) => step.status === "completed"),
    failed: next.some((step) => step.status === "failed"),
  };
}
