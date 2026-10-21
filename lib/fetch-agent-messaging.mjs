/*
 * FETCH AGENT MESSAGING PROTOCOL V1
 *
 * A bounded, request/response message bus for specialist-to-specialist handoffs.
 * The coordinator starts each task. Agents receive only an explicit JSON payload,
 * and can delegate through this bus; they never receive another agent's full
 * context or memory automatically.
 *
 * This module is server-side orchestration infrastructure. It does not expose
 * tools by itself; only injected capability handlers can execute work.
 */

import { FETCH_AGENT_DOGS } from "./fetch-agent-dog-registry.mjs";

export const FETCH_AGENT_MESSAGE_PROTOCOL = "fetch-agent-message-v1";

export const FETCH_AGENT_HANDOFF_ALLOWLIST = Object.freeze({
  fetch: Object.freeze(["scout", "shopper", "local_helper", "scribe", "journey"]),
  scout: Object.freeze(["shopper", "local_helper", "scribe", "journey"]),
  shopper: Object.freeze(["scout", "local_helper", "journey"]),
  local_helper: Object.freeze(["scout", "shopper", "journey"]),
  scribe: Object.freeze(["scout", "journey"]),
  journey: Object.freeze(["scout", "shopper", "local_helper", "scribe"]),
});

const KNOWN_AGENT_IDS = new Set(FETCH_AGENT_DOGS.map((agent) => agent.id));
const SIDE_EFFECT_CLASSES = new Set(["read_only", "user_visible", "external_action", "irreversible"]);
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_TIMEOUT_MS = 30000;
const DEFAULT_MAX_MESSAGES = 12;
const ABSOLUTE_MAX_MESSAGES = 24;
const DEFAULT_MAX_DEPTH = 3;
const ABSOLUTE_MAX_DEPTH = 4;
const DEFAULT_MAX_PAYLOAD_BYTES = 12000;
const ABSOLUTE_MAX_PAYLOAD_BYTES = 24000;
const MAX_JSON_DEPTH = 7;
const MAX_JSON_NODES = 800;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
let messageCounter = 0;

function clean(value, max = 180) {
  return String(value ?? "").trim().slice(0, max);
}
function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}
function makeId(prefix = "msg") {
  messageCounter += 1;
  return prefix + "_" + Date.now().toString(36) + "_" + messageCounter.toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}
function byteLength(text) {
  return new TextEncoder().encode(text).length;
}

/** Clone and bound JSON data; never allow executable values or prototype keys. */
export function copyFetchAgentJson(value, { maxBytes = DEFAULT_MAX_PAYLOAD_BYTES } = {}) {
  let nodes = 0;
  function copy(node, depth) {
    nodes += 1;
    if (nodes > MAX_JSON_NODES) throw new TypeError("payload_too_complex");
    if (depth > MAX_JSON_DEPTH) throw new TypeError("payload_too_deep");
    if (node === null || typeof node === "string" || typeof node === "boolean") return node;
    if (typeof node === "number") {
      if (!Number.isFinite(node)) throw new TypeError("payload_non_finite_number");
      return node;
    }
    if (Array.isArray(node)) return node.map((item) => copy(item, depth + 1));
    if (typeof node !== "object") throw new TypeError("payload_must_be_json");
    const prototype = Object.getPrototypeOf(node);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("payload_must_be_plain_json");
    const result = {};
    for (const key of Object.keys(node)) {
      if (FORBIDDEN_KEYS.has(key)) throw new TypeError("payload_forbidden_key");
      result[key] = copy(node[key], depth + 1);
    }
    return result;
  }
  const result = copy(value, 0);
  const encoded = JSON.stringify(result);
  if (byteLength(encoded) > maxBytes) throw new TypeError("payload_too_large");
  return result;
}

function capabilityDescriptor(handlers, agentId, capability) {
  const entry = asObject(handlers[agentId])[capability];
  if (!entry || typeof entry !== "object" || typeof entry.execute !== "function") return null;
  const sideEffectClass = clean(entry.sideEffectClass || entry.side_effect_class || "", 40).toLowerCase();
  if (!SIDE_EFFECT_CLASSES.has(sideEffectClass)) return { invalid: true };
  return { execute: entry.execute, sideEffectClass };
}

function recordTrace(session, event) {
  session.events.push({
    message_id: event.messageId,
    parent_message_id: event.parentMessageId || null,
    from_agent: event.fromAgent,
    to_agent: event.toAgent,
    capability: event.capability,
    status: event.status,
    reason: event.reason || null,
    depth: event.depth,
    duration_ms: Math.max(0, Number(event.durationMs) || 0),
  });
}

function statusResponse({ session, requestMessage, status, reason, result, fromAgent }) {
  const message = {
    protocol: FETCH_AGENT_MESSAGE_PROTOCOL,
    message_id: makeId("reply"),
    reply_to: requestMessage?.message_id || null,
    trace_id: session.traceId,
    task_id: session.taskId,
    from_agent: fromAgent || requestMessage?.to_agent || "fetch",
    to_agent: requestMessage?.from_agent || "fetch",
    message_type: status === "completed" ? "task_result" : "task_blocked",
    status,
    reason: reason || null,
    created_at: new Date().toISOString(),
  };
  if (result !== undefined) {
    try {
      message.payload = copyFetchAgentJson(result);
    } catch {
      message.status = "failed";
      message.message_type = "task_blocked";
      message.reason = "invalid_handler_result";
      return { ok: false, status: "failed", reason: "invalid_handler_result", message, result: null };
    }
  }
  return { ok: status === "completed", status, reason: reason || null, message, result };
}

function assertRootInput(input) {
  const taskId = clean(input?.taskId || input?.task_id, 180);
  const toAgent = clean(input?.toAgent || input?.to_agent, 80);
  const capability = clean(input?.capability, 140);
  if (!taskId) throw new TypeError("task_id_required");
  if (!toAgent || !KNOWN_AGENT_IDS.has(toAgent)) throw new TypeError("unknown_recipient");
  if (toAgent === "fetch") throw new TypeError("coordinator_cannot_message_itself");
  if (!/^[a-z][a-z0-9_.:-]{1,139}$/.test(capability)) throw new TypeError("invalid_capability");
  return { taskId, toAgent, capability };
}

/**
 * Create a per-task message bus with injected, trusted capabilities.
 *
 * Handler shape:
 * handlers[agentId][capability] = {
 *   sideEffectClass: "read_only" | "user_visible" | "external_action" | "irreversible",
 *   execute: async ({ message, signal, delegate }) => JSON result
 * }
 *
 * For non-read-only capabilities, authorizeSideEffect must consult the server's
 * trusted approval service. A client-provided boolean is not sufficient.
 */
export function createFetchAgentMessenger({
  handlers = {},
  authorizeSideEffect = async () => false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxMessages = DEFAULT_MAX_MESSAGES,
  maxDepth = DEFAULT_MAX_DEPTH,
  maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES,
  now = () => new Date(),
  idFactory = makeId,
} = {}) {
  const limitTimeout = boundedInteger(timeoutMs, DEFAULT_TIMEOUT_MS, 100, MAX_TIMEOUT_MS);
  const messageLimit = boundedInteger(maxMessages, DEFAULT_MAX_MESSAGES, 1, ABSOLUTE_MAX_MESSAGES);
  const depthLimit = boundedInteger(maxDepth, DEFAULT_MAX_DEPTH, 0, ABSOLUTE_MAX_DEPTH);
  const payloadLimit = boundedInteger(maxPayloadBytes, DEFAULT_MAX_PAYLOAD_BYTES, 128, ABSOLUTE_MAX_PAYLOAD_BYTES);

  async function executeMessage(input, session, depth, path, parentMessageId = null) {
    const fromAgent = input.fromAgent;
    const toAgent = clean(input.toAgent, 80);
    const capability = clean(input.capability, 140);
    const started = Date.now();
    const messageId = idFactory("msg");
    const messageBase = {
      protocol: FETCH_AGENT_MESSAGE_PROTOCOL,
      message_id: messageId,
      parent_message_id: parentMessageId,
      trace_id: session.traceId,
      task_id: session.taskId,
      from_agent: fromAgent,
      to_agent: toAgent,
      message_type: "task_request",
      capability,
      depth,
      created_at: now().toISOString(),
    };
    const requestMessage = { ...messageBase };

    function blocked(reason) {
      recordTrace(session, { messageId, parentMessageId, fromAgent, toAgent, capability, status: "blocked", reason, depth, durationMs: Date.now() - started });
      return statusResponse({ session, requestMessage, status: "blocked", reason, fromAgent: toAgent });
    }

    if (!KNOWN_AGENT_IDS.has(fromAgent) || !KNOWN_AGENT_IDS.has(toAgent)) return blocked("unknown_agent");
    if (fromAgent === toAgent) return blocked("self_handoff");
    if (!FETCH_AGENT_HANDOFF_ALLOWLIST[fromAgent]?.includes(toAgent)) return blocked("handoff_not_allowed");
    if (path.includes(toAgent)) return blocked("handoff_cycle_detected");
    if (depth > depthLimit) return blocked("max_handoff_depth_exceeded");
    if (session.messageCount >= messageLimit) return blocked("max_message_count_exceeded");
    if (!/^[a-z][a-z0-9_.:-]{1,139}$/.test(capability)) return blocked("invalid_capability");

    const descriptor = capabilityDescriptor(handlers, toAgent, capability);
    if (!descriptor) return blocked("capability_unavailable");
    if (descriptor.invalid) return blocked("capability_policy_invalid");

    let payload;
    try {
      payload = copyFetchAgentJson(input.payload ?? {}, { maxBytes: payloadLimit });
    } catch (error) {
      return blocked(error instanceof TypeError ? error.message : "invalid_payload");
    }
    requestMessage.payload = payload;

    if (descriptor.sideEffectClass !== "read_only") {
      let approved = false;
      try {
        approved = await authorizeSideEffect({
          taskId: session.taskId,
          traceId: session.traceId,
          fromAgent,
          toAgent,
          capability,
          sideEffectClass: descriptor.sideEffectClass,
          approval: input.approval ?? null,
        }) === true;
      } catch {
        approved = false;
      }
      if (!approved) return blocked("approval_required");
    }

    const routeKey = fromAgent + ">" + toAgent + ":" + capability;
    if (session.routes.has(routeKey)) return blocked("duplicate_handoff_detected");
    session.routes.add(routeKey);
    session.messageCount += 1;

    const controller = new AbortController();
    let timer = null;
    let timeout;
    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(() => {
        controller.abort(new Error("agent_message_timeout"));
        resolve({ timedOut: true });
      }, limitTimeout);
    });

    const delegate = async (next) => {
      if (controller.signal.aborted) {
        return { ok: false, status: "timed_out", reason: "parent_message_timed_out" };
      }
      if (!next || typeof next !== "object") return { ok: false, status: "blocked", reason: "invalid_handoff" };
      return executeMessage({
        fromAgent: toAgent,
        toAgent: next.toAgent || next.to_agent,
        capability: next.capability,
        payload: next.payload,
        approval: next.approval,
      }, session, depth + 1, [...path, toAgent], messageId);
    };

    try {
      const handlerPromise = Promise.resolve().then(() => descriptor.execute({
        message: requestMessage,
        signal: controller.signal,
        delegate,
      }));
      const winner = await Promise.race([
        handlerPromise.then((value) => ({ value }), (error) => ({ error })),
        timeoutPromise,
      ]);
      if (timer) clearTimeout(timer);

      if (winner.timedOut) {
        recordTrace(session, { messageId, parentMessageId, fromAgent, toAgent, capability, status: "timed_out", reason: "handler_timeout", depth, durationMs: Date.now() - started });
        return statusResponse({ session, requestMessage, status: "timed_out", reason: "handler_timeout", fromAgent: toAgent });
      }
      if (winner.error) {
        recordTrace(session, { messageId, parentMessageId, fromAgent, toAgent, capability, status: "failed", reason: "handler_failed", depth, durationMs: Date.now() - started });
        return statusResponse({ session, requestMessage, status: "failed", reason: "handler_failed", fromAgent: toAgent });
      }

      let result;
      try {
        result = copyFetchAgentJson(winner.value === undefined ? {} : winner.value, { maxBytes: payloadLimit });
      } catch {
        recordTrace(session, { messageId, parentMessageId, fromAgent, toAgent, capability, status: "failed", reason: "invalid_handler_result", depth, durationMs: Date.now() - started });
        return statusResponse({ session, requestMessage, status: "failed", reason: "invalid_handler_result", fromAgent: toAgent });
      }
      recordTrace(session, { messageId, parentMessageId, fromAgent, toAgent, capability, status: "completed", depth, durationMs: Date.now() - started });
      return statusResponse({ session, requestMessage, status: "completed", result, fromAgent: toAgent });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function run(input = {}) {
    const root = assertRootInput(input);
    const traceId = clean(input.traceId || input.trace_id || idFactory("trace"), 180);
    const session = {
      taskId: root.taskId,
      traceId,
      startedAt: now().toISOString(),
      messageCount: 0,
      routes: new Set(),
      events: [],
    };
    const dispatch = await executeMessage({
      fromAgent: "fetch",
      toAgent: root.toAgent,
      capability: root.capability,
      payload: input.payload ?? {},
      approval: input.approval ?? null,
    }, session, 0, ["fetch"], null);

    return {
      protocol: FETCH_AGENT_MESSAGE_PROTOCOL,
      task_id: session.taskId,
      trace_id: session.traceId,
      status: dispatch.status,
      ok: dispatch.ok,
      response: dispatch.message,
      result: dispatch.result ?? null,
      trace: {
        message_count: session.messageCount,
        event_count: session.events.length,
        events: session.events.map((event) => ({ ...event })),
        started_at: session.startedAt,
        completed_at: now().toISOString(),
      },
    };
  }

  return Object.freeze({ run, protocol: FETCH_AGENT_MESSAGE_PROTOCOL });
}
