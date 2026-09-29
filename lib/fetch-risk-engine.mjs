/* FETCH TRUST / RISK ENGINE — V1
 *
 * Deterministic policy layer for the Fetch personal agent.
 *
 * Levels:
 * - low: read-only / reversible / research
 * - medium: user-visible communication or reversible changes
 * - high: money, booking, purchase, account/security or irreversible action
 *
 * This is intentionally deterministic. A model may suggest an action,
 * but it cannot lower the risk level.
 */

function cleanText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(cleanText).filter(Boolean).join(" ").trim();
  if (typeof value === "object") {
    return cleanText(
      value.text ??
      value.content ??
      value.message ??
      value.result ??
      value.answer ??
      value.output ??
      ""
    );
  }
  return String(value).trim();
}

const HIGH_RISK_PATTERNS = [
  /\b(buy|purchase|order|checkout|pay|payment|transfer|send money|upi|bank|card|wallet)\b/i,
  /\b(book|reserve|reservation|ticket|flight|hotel|appointment)\b/i,
  /\b(send|reply|post|publish|message|email|whatsapp|dm|call|phone|dial)\b/i,
  /\b(delete|remove|cancel subscription|unsubscribe|close account|change password)\b/i,
  /\b(submit|apply|application|sign|accept terms|agree to terms)\b/i,
];

const MEDIUM_RISK_PATTERNS = [
  /\b(add to calendar|create event|schedule|remind|reminder)\b/i,
  /\b(draft|compose|prepare a message|write an email)\b/i,
  /\b(save|remember|store this|update my preference)\b/i,
  /\b(change|update|edit)\b/i,
];

const READ_ONLY_PATTERNS = [
  /\b(search|research|find out|look up|compare|check|verify|latest|current|news|weather|time|explain|tell me)\b/i,
  /\b(open|visit|read|summarize|show me)\b/i,
];

function hasAny(patterns, text) {
  return patterns.some((pattern) => pattern.test(text));
}

export function assessFetchRisk({ text = "", task = {}, route = null, approvalGranted = false } = {}) {
  const value = cleanText(text);
  const network = cleanText(task?.execution_network || route?.resource_type).toLowerCase();
  const action = cleanText(task?.intent?.action || task?.action).toLowerCase();
  const domain = cleanText(task?.intent?.domain || task?.domain).toLowerCase();
  const executionMode = cleanText(task?.workflow?.execution_mode).toLowerCase();

  const physical =
    network === "physical_network" ||
    cleanText(route?.resource_type).toLowerCase() === "partner_store" ||
    domain === "shopping" && /\b(buy|get|purchase|deliver|order|shop)\b/i.test(value);

  if (physical) {
    return {
      level: "high",
      approval_required: !approvalGranted,
      reason: "physical_purchase",
      policy: "Physical purchases require customer approval after real pricing is available.",
      execution_gate: "physical_order_engine",
    };
  }

  if (hasAny(HIGH_RISK_PATTERNS, value) || ["book","reserve","purchase","pay","send","call","submit","delete"].some((x) => action.includes(x))) {
    return {
      level: "high",
      approval_required: !approvalGranted,
      reason: approvalGranted ? "approved_consequential_side_effect" : "consequential_side_effect",
      policy: approvalGranted
        ? "Customer approval has been explicitly recorded for this action."
        : "Fetch must receive explicit customer approval before a consequential external side effect.",
      execution_gate: "customer_approval",
    };
  }

  if (hasAny(MEDIUM_RISK_PATTERNS, value) || executionMode === "execute") {
    return {
      level: "medium",
      approval_required: false,
      reason: "reversible_or_user_visible_action",
      policy: "Fetch may prepare the action, but should ask before an irreversible consequence.",
      execution_gate: "connector_policy",
    };
  }

  return {
    level: "low",
    approval_required: false,
    reason: hasAny(READ_ONLY_PATTERNS, value) ? "read_only_request" : "non_consequential",
    policy: "Read-only or non-consequential work can run automatically.",
    execution_gate: "auto",
  };
}

export function shouldPauseForApproval({ text, task, route } = {}) {
  const risk = assessFetchRisk({ text, task, route });
  return Boolean(risk.approval_required);
}
