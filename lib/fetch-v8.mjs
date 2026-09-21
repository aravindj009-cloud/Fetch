/* Fetch V8 facade: Memory + Context -> V7 Decision Engine */
import { decideFetchRequest } from "./fetch-decision-engine.mjs";
import { resolveFetchContext, saveConversationContext, saveContextSnapshot } from "./fetch-context-engine.mjs";

export async function processFetchV8Request({ text, customerId = null, conversationId = null, channel = "unknown", activeTaskId = null, suppliedIntent = null, suppliedContext = {} } = {}) {
  const receivedText = String(text || "").trim();
  if (!receivedText) throw new Error("text is required");
  const resolved = await resolveFetchContext({ text: receivedText, customerId, conversationId, channel, activeTaskId, suppliedContext });
  const decision = await decideFetchRequest({ text: receivedText, memory: resolved.memory, suppliedIntent });
  const contextSnapshot = {
    memory_keys_used: Object.keys(resolved.memory || {}),
    recent_decisions: resolved.recent_decisions.slice(0, 5),
    conversation_context: resolved.conversation?.context || {},
    active_task_id: resolved.context.active_task_id,
  };
  const snapshot = await saveContextSnapshot({ customerId, conversationId, sourceChannel: channel, rawText: receivedText, resolvedContext: contextSnapshot });
  if (conversationId) {
    await saveConversationContext({ customerId, conversationId, channel, context: { last_intent: decision.intent, last_entities: decision.entities, last_decision: decision.decision, memory_keys_used: contextSnapshot.memory_keys_used }, lastUserText: receivedText, activeTaskId: activeTaskId || resolved.context.active_task_id });
  }
  return {
    version: "v8",
    received_text: receivedText,
    customer_id: customerId,
    conversation_id: conversationId,
    channel,
    context: contextSnapshot,
    context_snapshot_id: snapshot?.id || null,
    ...decision,
    atc_request: decision.decision?.status === "ready" ? {
      network: decision.decision.network,
      resource_type: decision.decision.resource_type,
      objective: decision.plan?.steps?.[0]?.purpose || null,
      input: { text: receivedText, entities: decision.entities || {}, intent: decision.intent || {}, memory: resolved.memory || {}, context: contextSnapshot },
    } : null,
  };
}
