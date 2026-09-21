/* Fetch V9 facade: V8 Memory + Context -> V7 Decision -> Durable Workflow */

import { resolveFetchContext, saveConversationContext, saveContextSnapshot } from "./fetch-context-engine.mjs";
import { decideFetchRequest } from "./fetch-decision-engine.mjs";
import {
  splitWorkflowRequests,
  buildWorkflowSteps,
  createWorkflow,
} from "./fetch-workflow-v9.mjs";

export async function processFetchV9Request({
  text,
  customerId = null,
  conversationId = null,
  channel = "unknown",
  activeTaskId = null,
  suppliedIntent = null,
  suppliedContext = {},
} = {}) {
  const receivedText = String(text || "").trim();
  if (!receivedText) throw new Error("text is required");

  const resolved = await resolveFetchContext({
    text: receivedText,
    customerId,
    conversationId,
    channel,
    activeTaskId,
    suppliedContext,
  });

  const segments = splitWorkflowRequests(receivedText);
  const decisions = [];

  for (const segment of segments) {
    const decision = await decideFetchRequest({
      text: segment,
      memory: resolved.memory,
      suppliedIntent: segments.length === 1 ? suppliedIntent : null,
    });
    decisions.push({
      ...decision,
      received_text: segment,
    });
  }

  const contextSnapshot = {
    memory_keys_used: Object.keys(resolved.memory || {}),
    recent_decisions: resolved.recent_decisions.slice(0, 5),
    conversation_context: resolved.conversation?.context || {},
    active_task_id: resolved.context.active_task_id,
    workflow_segments: segments,
  };

  const snapshot = await saveContextSnapshot({
    customerId,
    conversationId,
    sourceChannel: channel,
    rawText: receivedText,
    resolvedContext: contextSnapshot,
  });

  const steps = buildWorkflowSteps({ decisions, originalText: receivedText });
  const readyDecisions = decisions.filter((item) => item.decision?.status === "ready");
  const needsClarification = decisions.some((item) => item.decision?.status !== "ready");
  const requiresConfirmation = decisions.some((item) => item.decision?.confirmation_required);

  const workflow = await createWorkflow({
    customerId,
    conversationId,
    sourceChannel: channel,
    sourceText: receivedText,
    objective: readyDecisions.length === 1
      ? readyDecisions[0].plan?.source_text || receivedText
      : `Complete ${decisions.length} requested task(s).`,
    plan: {
      version: "v9",
      segments,
      decisions,
      execution_policy: {
        dependency_mode: "sequential",
        external_side_effects_require_connector: true,
        confirmation_before_side_effects: true,
      },
    },
    contextSnapshotId: snapshot?.id || null,
    confirmationStatus: requiresConfirmation ? "pending" : "not_required",
    metadata: {
      memory_keys_used: Object.keys(resolved.memory || {}),
      active_task_id: resolved.context.active_task_id,
      decision_count: decisions.length,
      needs_clarification: needsClarification,
    },
    steps,
  });

  if (conversationId) {
    const lastDecision = decisions[decisions.length - 1] || {};
    await saveConversationContext({
      customerId,
      conversationId,
      channel,
      context: {
        last_intent: lastDecision.intent || null,
        last_entities: lastDecision.entities || {},
        last_decision: lastDecision.decision || {},
        active_workflow_id: workflow?.id || null,
        memory_keys_used: Object.keys(resolved.memory || {}),
      },
      lastUserText: receivedText,
      activeTaskId: workflow?.id || activeTaskId || resolved.context.active_task_id,
    });
  }

  return {
    version: "v9",
    received_text: receivedText,
    customer_id: customerId,
    conversation_id: conversationId,
    channel,
    context: contextSnapshot,
    context_snapshot_id: snapshot?.id || null,
    workflow_id: workflow?.id || null,
    workflow_status: workflow?.status || null,
    segments,
    decisions,
    steps,
    atc_requests: decisions
      .filter((item) => item.decision?.status === "ready")
      .map((item) => ({
        network: item.decision.network,
        resource_type: item.decision.resource_type,
        objective: item.plan?.steps?.[0]?.purpose || null,
        input: {
          text: item.received_text,
          entities: item.entities || {},
          intent: item.intent || {},
          memory: resolved.memory || {},
          context: contextSnapshot,
        },
      })),
  };
}
