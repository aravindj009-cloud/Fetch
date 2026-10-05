/* FETCH SPECIALIST REGISTRY — V1
 *
 * Fetch-native specialist definitions inspired by the role/workflow pattern
 * used by Agency Agents.
 *
 * IMPORTANT:
 * - Specialists do not execute side effects.
 * - ATC remains the execution authority.
 * - These definitions are intentionally lightweight so they do not add
 *   another LLM call or increase customer-facing latency.
 * - A specialist is a routing/contract concept, not a separate process.
 */

export const FETCH_SPECIALISTS = Object.freeze({
  shopping: {
    key: "shopping",
    displayName: "Fetch Shopping Specialist",
    domains: ["physical"],
    capabilities: ["physical_network"],
    objective: "Resolve products, quantities, source options and fulfillment constraints.",
    workflow: ["identify_items", "resolve_source", "validate_availability", "handoff_to_atc"],
    handoff: {
      required: ["items"],
      optional: ["budget", "delivery_location", "preferred_source", "substitutions"],
    },
  },

  mobility: {
    key: "mobility",
    displayName: "Fetch Mobility Specialist",
    domains: ["mobility"],
    capabilities: ["connected_app", "human_service"],
    objective: "Resolve journeys, pickup/drop locations, timing and provider options.",
    workflow: ["identify_trip", "resolve_provider", "validate_constraints", "handoff_to_atc"],
    handoff: {
      required: ["origin", "destination"],
      optional: ["pickup_time", "passengers", "vehicle_type", "budget"],
    },
  },

  travel: {
    key: "travel",
    displayName: "Fetch Travel Specialist",
    domains: ["flight", "travel", "reservation"],
    capabilities: ["flight_api", "reservation_api_or_phone"],
    objective: "Turn travel requests into structured, constraint-aware execution plans.",
    workflow: ["identify_trip", "collect_constraints", "search_options", "confirm_before_execution"],
    handoff: {
      required: ["travel_intent"],
      optional: ["origin", "destination", "dates", "passengers", "budget", "preferences"],
    },
  },

  services: {
    key: "services",
    displayName: "Fetch Services Specialist",
    domains: ["home_service", "service", "human_service"],
    capabilities: ["human_service", "digital_agent", "phone_service"],
    objective: "Resolve service requirements and match them to an available resource.",
    workflow: ["identify_service", "collect_constraints", "resolve_resource", "handoff_to_atc"],
    handoff: {
      required: ["service_type"],
      optional: ["location", "time", "budget", "urgency", "details"],
    },
  },

  research: {
    key: "research",
    displayName: "Fetch Research Specialist",
    domains: ["digital_agent", "research"],
    capabilities: ["digital_agent", "browser_agent"],
    objective: "Research, compare and synthesize information without performing transactional side effects.",
    workflow: ["define_question", "gather_information", "compare_or_synthesize", "return_evidence"],
    handoff: {
      required: ["question"],
      optional: ["constraints", "sources", "budget", "location"],
    },
  },

  assisted_services: {
    key: "assisted_services",
    displayName: "Fetch Assisted Services Specialist",
    domains: ["assisted_service", "human_service"],
    capabilities: ["human_service", "phone_service", "digital_agent"],
    objective: "Handle requests where a human or assisted workflow is preferable to an automated connector.",
    workflow: ["understand_need", "assess_constraints", "resolve_human_resource", "handoff_to_atc"],
    handoff: {
      required: ["request"],
      optional: ["person_details", "location", "time", "urgency"],
    },
  },
});

const DOMAIN_TO_SPECIALIST = Object.freeze({
  physical: "shopping",
  shopping: "shopping",
  mobility: "mobility",
  ride: "mobility",
  taxi: "mobility",
  flight: "travel",
  travel: "travel",
  reservation: "travel",
  restaurant: "travel",
  home_service: "services",
  service: "services",
  human_service: "assisted_services",
  assisted_service: "assisted_services",
  digital_agent: "research",
  research: "research",
});

export function getSpecialist(specialistKey) {
  const key = String(specialistKey || "").trim().toLowerCase();
  return FETCH_SPECIALISTS[key] || null;
}

export function resolveSpecialist({ domain, capability = null } = {}) {
  const normalizedDomain = String(domain || "").trim().toLowerCase();

  const key = DOMAIN_TO_SPECIALIST[normalizedDomain];
  if (key) return FETCH_SPECIALISTS[key];

  const normalizedCapability = String(capability || "").trim().toLowerCase();

  if (["physical_network"].includes(normalizedCapability)) {
    return FETCH_SPECIALISTS.shopping;
  }

  if (["flight_api"].includes(normalizedCapability)) {
    return FETCH_SPECIALISTS.travel;
  }

  if (["reservation_api_or_phone"].includes(normalizedCapability)) {
    return FETCH_SPECIALISTS.travel;
  }

  if (["human_service", "phone_service"].includes(normalizedCapability)) {
    return FETCH_SPECIALISTS.assisted_services;
  }

  if (["digital_agent", "browser_agent"].includes(normalizedCapability)) {
    return FETCH_SPECIALISTS.research;
  }

  return null;
}

export function buildSpecialistHandoff({ text = "", intent = {}, entities = {}, plan = null, memory = {} } = {}) {
  const specialist = resolveSpecialist({
    domain: intent?.domain,
    capability: intent?.capability || plan?.capability,
  });

  if (!specialist) {
    return {
      status: "unresolved",
      specialist: null,
      source_text: String(text || "").trim(),
      intent,
      entities,
    };
  }

  return {
    status: "ready",
    specialist: specialist.key,
    specialist_name: specialist.displayName,
    objective: specialist.objective,
    source_text: String(text || "").trim(),
    intent: {
      domain: intent?.domain || null,
      action: intent?.action || null,
      confidence: Number(intent?.confidence || 0),
    },
    entities: entities && typeof entities === "object" ? entities : {},
    plan: plan || null,
    memory_available: Boolean(memory && typeof memory === "object" && Object.keys(memory).length),
    workflow: specialist.workflow,
    handoff_contract: specialist.handoff,
    execution_authority: "atc",
  };
}

export function listSpecialists() {
  return Object.values(FETCH_SPECIALISTS);
}
