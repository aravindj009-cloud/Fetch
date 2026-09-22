/* FETCH V9 ORCHESTRATION — MEMORY + CONTEXT V4
 *
 * Keeps the existing V9 workflow behavior and adds a deterministic
 * personal-memory layer for the Fetch MVP.
 *
 * Supports:
 *   "Remember that I prefer deliveries after 7 PM."
 *   "What time do I prefer deliveries?"
 *
 * Explicit memory is saved before normal task routing.
 * Explicit memory questions are answered from durable memory before
 * normal task routing.
 *
 * Physical shopping / ATC behavior remains unchanged.
 */

import {
  resolveFetchContext,
  saveConversationContext,
  saveContextSnapshot,
} from "./fetch-context-engine.mjs";

import {
  listCustomerMemory,
  memoryRowsToObject,
  upsertCustomerMemory,
} from "./fetch-memory-v8.mjs";

import { decideFetchRequest } from "./fetch-decision-engine.mjs";

import {
  splitWorkflowRequests,
  buildWorkflowSteps,
  createWorkflow,
} from "./fetch-workflow-v9.mjs";

function cleanText(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ");
}

function safeKeyPart(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/^my\s+/i, "")
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.|\.$/g, "")
    .replace(/\.{2,}/g, ".");
}

function containsSensitiveMemory(text) {
  return /(password|passcode|otp|pin|cvv|card number|bank account|account number|api key|secret|token)/i.test(
    String(text || "")
  );
}

/*
 * Extract an explicit memory statement.
 *
 * The MVP deliberately stores only explicit, non-sensitive facts.
 */
function detectExplicitMemoryRequest(text = "") {
  const input = cleanText(text);
  if (!input) return null;

  const hasMemoryVerb =
    /\b(remember|memorize|save|store|keep\s+(?:this|that)\s+in\s+mind|don't\s+forget|do\s+not\s+forget)\b/i.test(
      input
    );

  if (!hasMemoryVerb) return null;
  if (containsSensitiveMemory(input)) {
    return {
      memory_key: null,
      memory_value: null,
      memory_type: "fact",
      source: "user_explicit",
      confidence: 1,
      explicit: true,
      needs_clarification: true,
      reason: "sensitive_memory_not_supported",
    };
  }

  /*
   * High-value preference pattern:
   * "Remember that I prefer deliveries after 7 PM."
   *
   * Store it as:
   * preference.delivery_time
   * { preference: "deliveries", value: "after 7 PM" }
   */
  const deliveryPreference = input.match(
    /\bremember(?:\s+that)?\s+i\s+prefer\s+(?:my\s+)?deliver(?:y|ies)\s+(?:to\s+be\s+)?(.+?)[.!?]?$/i
  );

  if (deliveryPreference) {
    const value = cleanText(deliveryPreference[1]).replace(/[.!?]+$/, "");
    if (value) {
      return {
        memory_key: "preference.delivery_time",
        memory_value: {
          preference: "deliveries",
          value,
        },
        memory_type: "preference",
        source: "user_explicit",
        confidence: 1,
        explicit: true,
      };
    }
  }

  /*
   * Generic preference:
   * "Remember that I prefer quiet restaurants."
   * "Remember I like evening deliveries."
   */
  const genericPreference = input.match(
    /\bremember(?:\s+that)?\s+i\s+(?:prefer|like|want)\s+(.+?)[.!?]?$/i
  );

  if (genericPreference) {
    const statement = cleanText(genericPreference[1]).replace(/[.!?]+$/, "");

    if (statement) {
      /*
       * Keep the complete explicit preference as the value.
       * This avoids pretending we understand a semantic category
       * that the user did not explicitly define.
       */
      return {
        memory_key: `preference.${safeKeyPart(statement.slice(0, 80))}`,
        memory_value: {
          value: statement,
        },
        memory_type: "preference",
        source: "user_explicit",
        confidence: 1,
        explicit: true,
      };
    }
  }

  /*
   * Mother/father birthday examples from the previous memory layer.
   */
  const motherBirthday = input.match(
    /\bmy\s+mother(?:'s|s)?\s+birthday\s+(?:is|falls?\s+on)\s+(.+?)(?:\.|!|\?|$)/i
  );

  if (motherBirthday) {
    const date = cleanText(motherBirthday[1]).replace(/[.!?]+$/, "");
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
    const date = cleanText(fatherBirthday[1]).replace(/[.!?]+$/, "");
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

  /*
   * Generic explicit "X is Y" fact.
   */
  const genericFact = input.match(
    /^(.{2,80}?)\s+(?:is|are)\s+(.{1,160}?)(?:\.|!|\?|$)/i
  );

  if (genericFact) {
    const subject = cleanText(genericFact[1]);
    const value = cleanText(genericFact[2]);

    if (
      subject &&
      value &&
      !containsSensitiveMemory(`${subject} ${value}`)
    ) {
      const normalizedSubject = safeKeyPart(subject);

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

async function persistExplicitMemory({
  customerId,
  memoryRequest,
} = {}) {
  if (
    !customerId ||
    !memoryRequest ||
    memoryRequest.needs_clarification ||
    !memoryRequest.memory_key
  ) {
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

function memoryValueText(row) {
  const value = row?.memory_value;

  if (value == null) return null;
  if (typeof value === "string") return value;

  return (
    value?.value ||
    value?.date ||
    value?.preference ||
    null
  );
}

/*
 * Convert a natural memory question into search terms.
 *
 * We intentionally search the durable memory rows rather than requiring
 * an exact memory key. This makes:
 *
 *   "What time do I prefer deliveries?"
 *
 * match:
 *
 *   preference.delivery_time
 */
function memoryQuestionTerms(text = "") {
  const input = cleanText(text).toLowerCase();

  const terms = [];

  if (/\bdeliver(y|ies|ing)\b/i.test(input)) {
    terms.push("delivery", "deliveries", "delivery_time");
  }

  if (/\bprefer|preference|like\b/i.test(input)) {
    terms.push("preference", "prefer");
  }

  if (/\btime\b/i.test(input)) {
    terms.push("time");
  }

  if (/\bbirthday\b/i.test(input)) {
    terms.push("birthday");
  }

  /*
   * Add meaningful words from the question, excluding conversational
   * stop words. This gives us a lightweight semantic-ish matcher
   * without introducing another model dependency.
   */
  const stopWords = new Set([
    "what",
    "when",
    "where",
    "who",
    "how",
    "do",
    "does",
    "did",
    "is",
    "are",
    "was",
    "were",
    "my",
    "me",
    "i",
    "the",
    "a",
    "an",
    "to",
    "of",
    "for",
    "in",
    "on",
    "about",
    "remember",
  ]);

  for (const word of input.match(/[a-z0-9]+/g) || []) {
    if (word.length >= 3 && !stopWords.has(word)) {
      terms.push(word);
    }
  }

  return [...new Set(terms)];
}

function scoreMemoryRow(row, terms) {
  const key = cleanText(row?.memory_key).toLowerCase();
  const value = JSON.stringify(row?.memory_value || {}).toLowerCase();

  if (!key) return 0;

  let score = 0;

  for (const term of terms) {
    if (key.includes(term)) score += 5;
    if (value.includes(term)) score += 2;
  }

  /*
   * Strong explicit preference/delivery match.
   */
  if (
    key === "preference.delivery_time" &&
    terms.some((term) =>
      ["delivery", "deliveries", "delivery_time", "time"].includes(term)
    )
  ) {
    score += 20;
  }

  return score;
}

async function findRequestedMemory({
  customerId,
  text,
} = {}) {
  if (!customerId) return null;

  const rows = await listCustomerMemory(customerId, {
    limit: 100,
  });

  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }

  const terms = memoryQuestionTerms(text);

  if (!terms.length) return null;

  const ranked = rows
    .map((row) => ({
      row,
      score: scoreMemoryRow(row, terms),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  return ranked[0]?.row || null;
}

function isLikelyMemoryQuestion(text = "") {
  const input = cleanText(text).toLowerCase();

  return (
    /\bwhat\s+(?:time|is|are|was|were)\b/i.test(input) &&
    /\b(?:my|i)\b/i.test(input) &&
    /\b(?:prefer|preference|deliver|delivery|birthday|remember)\b/i.test(
      input
    )
  ) || /\bwhat\s+do\s+i\s+prefer\b/i.test(input);
}

async function handleMemoryQuestion({
  customerId,
  conversationId,
  channel,
  activeTaskId,
  resolved,
  receivedText,
} = {}) {
  if (!isLikelyMemoryQuestion(receivedText)) {
    return null;
  }

  const row = await findRequestedMemory({
    customerId,
    text: receivedText,
  });

  const answer = memoryValueText(row);

  const memorySnapshot = {
    memory_keys_used: answer ? [row.memory_key] : [],
    memory_request: {
      key: row?.memory_key || null,
      value: row?.memory_value || null,
      found: Boolean(row),
    },
    stored_memory_id: row?.id || null,
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
          action: "retrieve",
          confidence: 1,
        },
        last_entities: {
          memory_key: row?.memory_key || null,
        },
        last_decision: {
          status: answer ? "completed" : "not_found",
          network: null,
        },
        memory_keys_used: answer
          ? [row.memory_key]
          : [],
      },
      lastUserText: receivedText,
      activeTaskId:
        activeTaskId ||
        resolved.context.active_task_id,
    });
  }

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
      status: answer ? "found" : "not_found",
      key: row?.memory_key || null,
      value: row?.memory_value || null,
      value_text: answer,
      memory_id: row?.id || null,
    },
    answer:
      answer ||
      "I don't have that preference saved yet.",
    decisions: [],
    steps: [],
    atc_requests: [],
  };
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

  if (!receivedText) {
    throw new Error("text is required");
  }

  const resolved = await resolveFetchContext({
    text: receivedText,
    customerId,
    conversationId,
    channel,
    activeTaskId,
    suppliedContext,
  });

  /*
   * MEMORY SAVE
   */
  const memoryRequest =
    detectExplicitMemoryRequest(receivedText);

  if (memoryRequest) {
    const stored = await persistExplicitMemory({
      customerId,
      memoryRequest,
    });

    const memorySnapshot = {
      memory_keys_used: Object.keys(
        resolved.memory || {}
      ),
      memory_request: {
        key: memoryRequest.memory_key,
        value: memoryRequest.memory_value,
        needs_clarification: Boolean(
          memoryRequest.needs_clarification
        ),
      },
      stored_memory_id: stored?.id || null,
      recent_decisions:
        resolved.recent_decisions.slice(0, 5),
      conversation_context:
        resolved.conversation?.context || {},
      active_task_id:
        resolved.context.active_task_id,
      workflow_segments: [receivedText],
    };

    const snapshot =
      await saveContextSnapshot({
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
          last_entities:
            memoryRequest.memory_key
              ? {
                  memory_key:
                    memoryRequest.memory_key,
                  memory_value:
                    memoryRequest.memory_value,
                }
              : {},
          last_decision: {
            status:
              memoryRequest.needs_clarification
                ? "needs_clarification"
                : "completed",
            network: null,
          },
          memory_key_saved:
            memoryRequest.memory_key || null,
        },
        lastUserText: receivedText,
        activeTaskId:
          activeTaskId ||
          resolved.context.active_task_id,
      });
    }

    const storedValue =
      stored?.memory_value ??
      memoryRequest.memory_value ??
      null;

    const storedValueText =
      memoryValueText({
        memory_value: storedValue,
      });

    return {
      version: "v9",
      received_text: receivedText,
      customer_id: customerId,
      conversation_id: conversationId,
      channel,
      context: memorySnapshot,
      context_snapshot_id:
        snapshot?.id || null,
      workflow_id: null,
      workflow_status: "completed",
      segments: [receivedText],
      memory: {
        status:
          memoryRequest.needs_clarification
            ? "needs_clarification"
            : "saved",
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

  /*
   * MEMORY RETRIEVAL
   */
  const memoryQuestion =
    await handleMemoryQuestion({
      customerId,
      conversationId,
      channel,
      activeTaskId,
      resolved,
      receivedText,
    });

  if (memoryQuestion) {
    return memoryQuestion;
  }

  /*
   * EXISTING V9 WORKFLOW
   *
   * Everything below this point intentionally follows the existing
   * orchestration behavior.
   */
  const segments =
    splitWorkflowRequests(receivedText);

  const decisions = [];

  for (const segment of segments) {
    const decision =
      await decideFetchRequest({
        text: segment,
        memory: resolved.memory,
        suppliedIntent:
          segments.length === 1
            ? suppliedIntent
            : null,
      });

    decisions.push({
      ...decision,
      received_text: segment,
    });
  }

  const contextSnapshot = {
    memory_keys_used: Object.keys(
      resolved.memory || {}
    ),
    recent_decisions:
      resolved.recent_decisions.slice(0, 5),
    conversation_context:
      resolved.conversation?.context || {},
    active_task_id:
      resolved.context.active_task_id,
    workflow_segments: segments,
  };

  const snapshot =
    await saveContextSnapshot({
      customerId,
      conversationId,
      sourceChannel: channel,
      rawText: receivedText,
      resolvedContext: contextSnapshot,
    });

  const steps = buildWorkflowSteps({
    decisions,
    originalText: receivedText,
  });

  const readyDecisions =
    decisions.filter(
      (item) =>
        item.decision?.status ===
        "ready"
    );

  const needsClarification =
    decisions.some(
      (item) =>
        item.decision?.status !==
        "ready"
    );

  const requiresConfirmation =
    decisions.some(
      (item) =>
        item.decision
          ?.confirmation_required
    );

  const workflow =
    await createWorkflow({
      customerId,
      conversationId,
      sourceChannel: channel,
      sourceText: receivedText,

      objective:
        readyDecisions.length === 1
          ? readyDecisions[0].plan
              ?.source_text ||
            receivedText
          : `Complete ${decisions.length} requested task(s).`,

      plan: {
        version: "v9",
        segments,
        decisions,
        execution_policy: {
          dependency_mode:
            "sequential",
          external_side_effects_require_connector:
            true,
          confirmation_before_side_effects:
            true,
        },
      },

      contextSnapshotId:
        snapshot?.id || null,

      confirmationStatus:
        requiresConfirmation
          ? "pending"
          : "not_required",

      metadata: {
        memory_keys_used:
          Object.keys(
            resolved.memory || {}
          ),
        active_task_id:
          resolved.context
            .active_task_id,
        decision_count:
          decisions.length,
        needs_clarification:
          needsClarification,
      },

      steps,
    });

  if (conversationId) {
    const lastDecision =
      decisions[
        decisions.length - 1
      ] || {};

    await saveConversationContext({
      customerId,
      conversationId,
      channel,

      context: {
        last_intent:
          lastDecision.intent ||
          null,
        last_entities:
          lastDecision.entities ||
          {},
        last_decision:
          lastDecision.decision ||
          {},
        active_workflow_id:
          workflow?.id || null,
        memory_keys_used:
          Object.keys(
            resolved.memory || {}
          ),
      },

      lastUserText: receivedText,

      activeTaskId:
        workflow?.id ||
        activeTaskId ||
        resolved.context
          .active_task_id,
    });
  }

  return {
    version: "v9",
    received_text: receivedText,
    customer_id: customerId,
    conversation_id:
      conversationId,
    channel,

    context:
      contextSnapshot,

    context_snapshot_id:
      snapshot?.id || null,

    workflow_id:
      workflow?.id || null,

    workflow_status:
      workflow?.status || null,

    segments,
    decisions,
    steps,

    atc_requests:
      decisions
        .filter(
          (item) =>
            item.decision?.status ===
            "ready"
        )
        .map((item) => ({
          network:
            item.decision
              .network,

          resource_type:
            item.decision
              .resource_type,

          objective:
            item.plan?.steps?.[0]
              ?.purpose || null,

          input: {
            text:
              item.received_text,
            entities:
              item.entities || {},
            intent:
              item.intent || {},
            memory:
              resolved.memory || {},
            context:
              contextSnapshot,
          },
        })),
  };
}

export {
  detectExplicitMemoryRequest,
  findRequestedMemory,
};
