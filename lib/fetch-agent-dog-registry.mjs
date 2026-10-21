/*
 * Fetch Agent Dog Registry v1
 *
 * These are specialist profiles, not independent execution runtimes.
 * Fetch remains the single front door and ATC/IoI remains authoritative for
 * provider selection, permissions, confirmations, execution and receipts.
 *
 * The resolver is deliberately advisory: it labels the likely specialist
 * for UI/trace purposes but never chooses or executes a provider.
 */

export const FETCH_AGENT_DOGS = Object.freeze([
  Object.freeze({
    id: "fetch",
    name: "Fetch",
    title: "Coordinator",
    greeting: "Tell me what you need. I'll coordinate the work.",
    mission: "Understands the full request, keeps context, and coordinates specialist capabilities.",
    accent: "#2d8472",
    status: "active",
    status_label: "Core assistant",
    capabilities: ["intent_understanding", "task_planning", "atc_coordination", "approvals", "task_tracking"],
    examples: ["Help me get this done", "Plan my day", "Continue what we were doing"],
  }),
  Object.freeze({
    id: "scout",
    name: "Scout",
    title: "Research & discovery",
    greeting: "I'll look for useful evidence and bring back what I find.",
    mission: "Finds information, compares options, and separates source-backed facts from uncertainty.",
    accent: "#64815a",
    status: "existing_route",
    status_label: "Uses existing Fetch research routes",
    capabilities: ["web_research", "news_search", "source_evidence", "comparison"],
    examples: ["Research the latest AI agents", "Compare these two options", "Find evidence for this question"],
  }),
  Object.freeze({
    id: "shopper",
    name: "Rover",
    title: "Shopping & errands",
    greeting: "I'll work out what you need and how Fetch can fulfil it.",
    mission: "Helps find products and routes shopping requests through Fetch's existing fulfilment flow.",
    accent: "#c7894c",
    status: "existing_route",
    status_label: "Uses existing Fetch fulfilment routes",
    capabilities: ["product_search", "catalog_matching", "substitutions", "physical_fulfilment"],
    examples: ["Get me milk and bread", "Find a product", "Help me place a grocery request"],
  }),
  Object.freeze({
    id: "local_helper",
    name: "Patch",
    title: "Local services",
    greeting: "I'll help find a nearby professional when a reliable source is available.",
    mission: "Discovers local service providers while clearly communicating source quality and availability.",
    accent: "#4f85a7",
    status: "preview_experimental",
    status_label: "Experimental Preview capability",
    capabilities: ["local_service_discovery", "provider_evidence", "location_context"],
    examples: ["Find an electrician near me", "Find a plumber nearby", "Look for a carpenter"],
  }),
  Object.freeze({
    id: "scribe",
    name: "Scribe",
    title: "Daily minutes & memory",
    greeting: "I'll organise your notes, decisions and follow-ups.",
    mission: "Structures captured minutes into summaries, decisions, commitments and next actions without inventing facts.",
    accent: "#8c72a5",
    status: "companion_prototype",
    status_label: "Local capture prototype",
    capabilities: ["daily_minutes", "decision_extraction", "commitment_tracking", "eod_summary"],
    examples: ["Capture these meeting minutes", "Summarise today's notes", "List my open follow-ups"],
  }),
  Object.freeze({
    id: "journey",
    name: "Trek",
    title: "Travel & journey",
    greeting: "I'll help organise the journey and keep its details together.",
    mission: "Plans trips and can track progress when authorised location and mobility capabilities are connected.",
    accent: "#4b9b99",
    status: "planned",
    status_label: "Needs travel and live-location integrations",
    capabilities: ["trip_planning", "travel_search", "journey_elapsed_time", "arrival_updates"],
    examples: ["Plan my trip to Bangalore", "Track the minutes on my journey", "Compare train options"],
  }),
]);

const matches = {
  local_helper: /\b(electrician|plumber|carpenter|appliance repair|washing machine repair|fridge repair|ac repair|air conditioner repair|pest control|cleaning service|house cleaning|handyman)\b/i,
  scribe: /\b(daily minutes?|meeting minutes?|eod|end.of.day|daily brief|summari[sz]e .*\b(notes?|minutes?|meeting|day)\b|what happened today|decisions? and commitments|action items?)\b/i,
  journey: /\b(journey|trip|travel|train|flight|boarding|arrival time|eta\b|elapsed minutes?|track my minutes|to bangalore|to ernakulam|to chennai|to mumbai)\b/i,
  shopper: /\b(grocer(?:y|ies)|shopping|shop for|buy|purchase|order|deliver|delivery|milk|bread|supermarket|product|cart|checkout|kitkat|kit.kat)\b/i,
  scout: /\b(research|latest|news|find information|compare|look up|what is|explain|sources?|evidence|analyse|analyze)\b/i,
};

const byId = new Map(FETCH_AGENT_DOGS.map((agent) => [agent.id, agent]));

function safeAgent(agent) {
  return {
    id: agent.id,
    name: agent.name,
    title: agent.title,
    mission: agent.mission,
    accent: agent.accent,
    status: agent.status,
    status_label: agent.status_label,
    capabilities: [...agent.capabilities],
  };
}

/**
 * Return the suggested specialist for display and observability only.
 * A result is not permission to execute any tool or claim the capability works.
 */
export function resolveFetchAgentDog(requestText = "") {
  const text = String(requestText || "").trim().slice(0, 5000);
  if (!text) return safeAgent(byId.get("fetch"));

  for (const id of ["local_helper", "scribe", "journey", "shopper", "scout"]) {
    if (matches[id].test(text)) return safeAgent(byId.get(id));
  }
  return safeAgent(byId.get("fetch"));
}

export function getFetchAgentDog(agentId = "fetch") {
  return safeAgent(byId.get(String(agentId)) || byId.get("fetch"));
}
