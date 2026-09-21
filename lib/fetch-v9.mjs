/* Fetch V9 orchestration layer — memory-aware
   V8 Memory + Context -> V7 Decision -> Durable Workflow

   This replacement keeps the existing V9 workflow behavior and adds one
   important Fetch Agent capability: explicit user memory statements are
   captured before normal task routing.

   Example:
     "My mother's birthday is on October 15. Remember that."

   -> durable memory key: person.mother.birthday
   -> value: { "date": "October 15" }

   Informational requests continue through the existing digital-agent path.
   Physical shopping / ATC behavior is unchanged.
*/

import {
  resolveFetchContext,
  saveConversationContext,
  saveContextSnapshot,
} from "./fetch-context-engine.mjs";
import { upsertCustomerMemory } from "./fetch-memory-v8.mjs";
import { decideFetchRequest } from "./fetch-decision-engine.mjs";
import {
  splitWorkflowRequests,
  buildWorkflowSteps,
  createWorkflow,
} from "./fetch-workflow-v9.mjs";

function cleanText(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function detectExplicitMemoryRequest(text = "") {
  const input = cleanText(text);
  if (!input) return null;

  const lower = input.toLowerCase();
  const hasMemoryVerb = /\b(remember|memorize|save|store|keep\s+(?:this|that)\s+in\s+mind|don't\s+forget|do\s+not\s+forget)\b/i.test(input);
  if (!hasMemoryVerb) return null;

  // Mother/father/parent birthday is a high-value, unambiguous MVP fact.
  const motherBirthday = input.match(
    /\bmy\s+mother(?:'s|s)?\s+birthday\s+(?:is|falls?\s+on)\s+(.+?)(?:\.|!|\?|$)/i
  );
  if (motherBirthday) {
    const date = cleanText(motherBirthday[1])
      .replace(/\bremember\s+(?:that|this)\b/gi, "")
      .replace(/[.!?]+$/, "")
      .trim();
    if (date) {
      return {
        memory_key: "person.mother.birthday",
        memory_value: { date },
        memory_type: "fact",
        source: "user_explicit",
        confidence: 1,
        explicit: true,
      };
    }
  }

  const fatherBirthday = input.match(
    /\bmy\s+father(?:'s|s)?\s+birthday\s+(?:is|falls?\s+on)\s+(.+?)(?:\.|!|\?|$)/i
  );
  if (fatherBirthday) {
    const date = cleanText(fatherBirthday[1])
      .replace(/\bremember\s+(?:that|this)\b/gi, "")
      .replace(/[.!?]+$/, "")
      .trim();
    if (date) {
      return {
        memory_key: "person.father.birthday",
        memory_value: { date },
        memory_type: "fact",
        source: "user_explicit",
        confidence: 1,
        explicit: true,
      };
    }
  }

  // Generic explicit "X is Y" facts are intentionally limited to safe,
  // non-secret personal facts. This gives Fetch a foundation for memory
  // without attempting to infer sensitive information.
  const generic = input.match(
    /^(.{2,80}?)\s+(?:is|are)\s+(.{1,160}?)(?:\.|!|\?|\s+(?:remember|save|store)\s+(?:that|this)\b|$)/i
  );
  if (generic) {
    const subject = cleanText(generic[1]);
    const value = cleanText(generic[2]);

    if (
      subject &&
      value &&
      !/(password|passcode|otp|pin|cvv|card|bank|account number|api key|secret|token)/i.test(subject) &&
      !/(password|passcode|otp|pin|cvv|card|bank|account number|api key|secret|token)/i.test(value)
    ) {
      const normalizedSubject = subject
        .replace(/^my\s+/i, "")
        .replace(/[^a-zA-Z0-9]+/g, ".")
        .replace(/^\.+|\.+$/g, "")
        .toLowerCase();

      if (normalizedSubject) {
        return {
          memory_key: `fact.${normalizedSubject}`,
          memory_value: { value },
          memory_type: "fact",
          source: "user_explicit",
          confidence: 1,
          explicit: true,
        };
      }
    }
  }

  // We detected an explicit memory instruction but could not safely extract
  // a fact. The caller should not silently store the whole message.
  return {
    memory_key: null,
    memory_value: null,
    memory_type: "fact",
    source: "user_explicit",
    confidence: 1,
    explicit: true,
    needs_clarification: true,
  };
}

async function persistExplicitMemory({ customerId, memoryRequest } = {}) {
  if (!customerId || !memoryRequest || memoryRequest.needs_clarification || !memoryRequest.memory_key) {
    return null;
  }

  return upsertCustomerMemory({
    customerId,
    memoryKey: memoryRequest.memory_key,
    memoryValue: memoryRequest.memory_value,
    memoryType: memoryRequest.memory_type,
    source: memoryRequest.source,
    confidence: memoryRequest.confidence,
    explicit: memoryRequest.explicit,
  });
}

export async function processFetchV9Request({
  text,
  customerId = null,
  conversationId = null,
  channel = "unknown",
  activeTaskId = null,
  suppliedIntent = null,
  suppliedContext = {},
} = {}) {
  const receivedText = cleanText(text);
  if (!receivedText) throw new Error("text is required");

  const resolved = await resolveFetchContext({
    text: receivedText,
    customerId,
    conversationId,
    channel,
    activeTaskId,
    suppliedContext,
  });

  /* ---------------------------------------------------------
     FETCH AGENT MEMORY
     Explicit "remember/save/store" statements are handled here,
     before task planning, because remembering is itself a Fetch
     Agent capability and does not require ATC or an external resource.
     --------------------------------------------------------- */
  const memoryRequest = detectExplicitMemoryRequest(receivedText);

  if (memoryRequest) {
    const stored = await persistExplicitMemory({
      customerId,
      memoryRequest,
    });

    const memorySnapshot = {
      memory_keys_used: Object.keys(resolved.memory || {}),
      memory_request: {
        key: memoryRequest.memory_key,
        value: memoryRequest.memory_value,
        needs_clarification: Boolean(memoryRequest.needs_clarification),
      },
      stored_memory_id: stored?.id || null,
      recent_decisions: resolved.recent_decisions.slice(0, 5),
      conversation_context: resolved.conversation?.context || {},
      active_task_id: resolved.context.active_task_id,
      workflow_segments: [receivedText],
    };

    const snapshot = await saveContextSnapshot({
      customerId,
      conversationId,
      sourceChannel: channel,
      rawText: receivedText,
      resolvedContext: memorySnapshot,
    });

    if (conversationId) {
      await saveConversationContext({
        customerId,
        conversationId,
        channel,
        context: {
          last_intent: {
            domain: "memory",
            action: "remember",
            confidence: 1,
          },
          last_entities: memoryRequest.memory_key
            ? { memory_key: memoryRequest.memory_key, memory_value: memoryRequest.memory_value }
            : {},
          last_decision: {
            status: memoryRequest.needs_clarification ? "needs_clarification" : "completed",
            network: null,
          },
          memory_keys_used: Object.keys(resolved.memory || {}),
          memory_key_saved: memoryRequest.memory_key || null,
        },
        lastUserText: receivedText,
        activeTaskId: activeTaskId || resolved.context.active_task_id,
      });
    }

    const storedValue = stored?.memory_value ?? memoryRequest.memory_value ?? null;
    const storedValueText =
      storedValue?.date ||
      storedValue?.value ||
      (storedValue == null ? null : String(storedValue));

    return {
      version: "v9",
      received_text: receivedText,
      customer_id: customerId,
      conversation_id: conversationId,
      channel,
      context: memorySnapshot,
      context_snapshot_id: snapshot?.id || null,
      workflow_id: null,
      workflow_status: "completed",
      segments: [receivedText],
      memory: {
        status: memoryRequest.needs_clarification ? "needs_clarification" : "saved",
        key: memoryRequest.memory_key || null,
        value: storedValue,
        value_text: storedValueText,
        memory_id: stored?.id || null,
      },
      decisions: [],
      steps: [],
      atc_requests: [],
    };
  }

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

export { detectExplicitMemoryRequest };
