/* Fetch V7 Decision Engine
   Converts an intent/plan into an ATC-ready decision without performing side effects.
*/
import { normalizeFetchIntent } from "./fetch-intelligence.mjs";

const CONFIRMATION_REQUIRED = new Set(["book", "reserve", "purchase", "send", "call", "create"]);

export function needsConfirmation({ domain, action, entities = {}, step = null } = {}) {
  const explicit = entities.confirmation_required;
  if (typeof explicit === "boolean") return explicit;
  if (step?.key && CONFIRMATION_REQUIRED.has(step.key)) return true;
  return ["flight", "reservation"].includes(domain) && ["execute", "request"].includes(action);
}

export function chooseNetwork(domain) {
  const map = {
    physical: "physical_network",
    flight: "flight",
    reservation: "reservation",
    calendar: "calendar",
    messaging: "messaging",
    phone: "phone_service",
    human: "human_service",
    digital_agent: "digital_agent",
    connected_app: "connected_app",
  };
  return map[domain] || "human_service";
}

export async function decideFetchRequest({ text, memory = {}, suppliedIntent = null } = {}) {
  const normalized = await normalizeFetchIntent({ text, memory, suppliedIntent });
  const { intent, entities, plan } = normalized;
  if (plan.status !== "planned") return { ...normalized, decision: { status: "needs_clarification", reason: plan.reason } };
  const firstStep = plan.steps[0] || null;
  return {
    ...normalized,
    decision: {
      status: "ready",
      network: chooseNetwork(intent.domain),
      resource_type: chooseNetwork(intent.domain) === "physical_network" ? "partner_store" : null,
      first_step: firstStep,
      confirmation_required: needsConfirmation({ domain: intent.domain, action: intent.action, entities, step: firstStep }),
      execution_mode: firstStep?.key === "source_resource" || firstStep?.key === "search" ? "discover" : "execute",
    },
  };
}
