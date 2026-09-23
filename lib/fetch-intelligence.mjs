/*
  FETCH INTELLIGENCE LAYER — V8/V9 COMPATIBLE

  Purpose:
  - Deterministically normalize user intent before workflow/ATC.
  - Support the three Fetch execution networks:
      1. physical
      2. digital_agent
      3. human_service / phone
  - Keep ATC provider-neutral.
  - Do not perform external side effects here.

  Important:
  - This layer decides WHAT the user is asking for.
  - ATC/workflow decides WHO/HOW/WHERE/SEQUENCE.
  - The digital-agent executor can handle informational/research requests.
*/

const ACTION_PATTERNS = [
  {
    type: "flight",
    verbs: /\b(book|find|search|reserve|compare)\b/i,
    nouns: /\b(flight|flights|airfare|ticket|tickets|fly|airline)\b/i,
  },
  {
    type: "reservation",
    verbs: /\b(book|reserve|find|search)\b/i,
    nouns: /\b(table|restaurant|dinner|lunch|reservation|restaurant booking)\b/i,
  },
  {
    type: "calendar",
    verbs: /\b(add|put|schedule|create|block|move|reschedule|cancel)\b/i,
    nouns: /\b(calendar|meeting|event|appointment)\b/i,
  },
  {
    type: "messaging",
    verbs: /\b(send|message|text|whatsapp|notify|tell)\b/i,
    nouns: /\b(message|text|whatsapp|person|people|friend|team)\b/i,
  },
  {
    type: "phone",
    verbs: /\b(call|phone|ring|speak|talk)\b/i,
    nouns: /\b(call|phone|number|person|restaurant|store|service)\b/i,
  },
  {
    type: "physical",
    verbs: /\b(buy|get|need|want|require|purchase|pick up|deliver|bring|order|fetch|grab|send)\b/i,
    nouns: /\b(grocery|groceries|milk|bread|eggs|food|item|items|product|products|kitkat|munch|rice|water|snack|snacks|medicine|gift)\b/i,
  },
];

const DIGITAL_PATTERNS = [
  /\b(give|suggest|recommend|recommendations|ideas|idea|explain|tell me|show me|find me|research|look up|search for)\b/i,
  /\b(what is|what are|how do i|how can i|why is|why are|when is|where is|who is)\b/i,
  /\b(ideas?|options?|suggestions?|information|info|advice|guide|guidance|comparison|compare|reviews?)\b/i,
  /\b(gift ideas?|birthday gift|present ideas?|things to buy)\b/i,
];

const HUMAN_SERVICE_PATTERNS = [
  /\b(human|person|someone|assistant|agent)\b.*\b(call|help|handle|do|contact)\b/i,
  /\b(call|phone)\b.*\b(store|restaurant|service|doctor|business|person)\b/i,
];

function cleanText(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function hasAny(patterns, input) {
  return patterns.some((pattern) => pattern.test(input));
}

export function classifyIntent(text = "") {
  const input = cleanText(text);
  const lower = input.toLowerCase();

  if (!input) {
    return {
      domain: "unknown",
      action: "request",
      confidence: 0,
      candidates: [],
    };
  }

  // Explicit human-service / phone intent comes before generic digital intent.
  if (hasAny(HUMAN_SERVICE_PATTERNS, input)) {
    return {
      domain: "human_service",
      action: "execute",
      confidence: 0.84,
      candidates: ["human_service", "phone"],
    };
  }

  const matches = ACTION_PATTERNS.filter(
    (pattern) => pattern.verbs.test(input) && pattern.nouns.test(input)
  );

  if (matches.length) {
    const first = matches[0];

    return {
      domain: first.type,
      action: "execute",
      confidence: 0.82,
      candidates: matches.map((match) => match.type),
    };
  }

  /*
    Natural shopping requests often omit an explicit verb:
    "milk and bread"
    "some eggs"
    "kitkat please"
    "one packet of biscuits"
  */
  if (
    /\b(grocery|groceries|milk|bread|eggs|food|item|items|product|products|kitkat|munch|rice|water|snack|snacks)\b/i.test(
      lower
    )
  ) {
    return {
      domain: "physical",
      action: "execute",
      confidence: 0.76,
      candidates: ["physical"],
    };
  }

  /*
    Digital-agent intent:
    information, recommendations, research, ideas, explanations,
    comparisons and other requests that do not require a physical
    resource or a connected transactional provider.
  */
  if (hasAny(DIGITAL_PATTERNS, input)) {
    return {
      domain: "digital_agent",
      action: "execute",
      confidence: 0.78,
      candidates: ["digital_agent"],
    };
  }

  /*
    Questions are generally digital-agent tasks unless they clearly
    match another execution domain.
  */
  if (
    /^(who|what|when|where|why|how|which|can you|could you|would you)\b/i.test(
      lower
    )
  ) {
    return {
      domain: "digital_agent",
      action: "execute",
      confidence: 0.7,
      candidates: ["digital_agent"],
    };
  }

  /*
    Preserve the original unknown/book fallback behavior so existing
    callers that rely on "needs_clarification" continue to work.
  */
  if (/\b(book|find|search)\b/.test(lower)) {
    return {
      domain: "unknown",
      action: "request",
      confidence: 0.35,
    };
  }

  return {
    domain: "unknown",
    action: "request",
    confidence: 0.2,
  };
}

function normalizeItemName(value = "") {
  return cleanText(value)
    .replace(/^[,;:+-]+|[,;:+-]+$/g, "")
    .replace(/\bplease\b/gi, "")
    .trim();
}

function canonicalPhysicalItemName(value = "") {
  const name = normalizeItemName(value);

  if (/^kit\s*kats?$/i.test(name)) return "KitKat";
  if (/^munch(?:es)?$/i.test(name)) return "Munch";
  if (/^milks?$/i.test(name)) return "milk";
  if (/^breads?$/i.test(name)) return "bread";
  if (/^egg?s$/i.test(name)) return "eggs";
  if (/^rices?$/i.test(name)) return "rice";
  if (/^waters?$/i.test(name)) return "water";
  if (/^snacks?$/i.test(name)) return "snacks";
  if (/^biscuits?$/i.test(name)) return "biscuits";

  return name;
}

function addPhysicalItem(items, name, quantity = 1) {
  const normalizedName = canonicalPhysicalItemName(name);
  if (!normalizedName) return;

  const existing = items.find(
    (item) => item.name.toLowerCase() === normalizedName.toLowerCase()
  );

  if (existing) {
    existing.quantity += Number(quantity) || 1;
    return;
  }

  items.push({
    name: normalizedName,
    quantity: Number(quantity) || 1,
  });
}

function extractPhysicalItems(text = "") {
  const input = cleanText(text);
  const items = [];

  /*
   * Explicit quantity + known/product-like item:
   *   "2 KitKats"
   *   "2 Kit Kats"
   *   "2 bottles of milk"
   *   "3 packets of biscuits"
   */
  const quantityFirstPattern =
    /\b(\d+)\s*(?:x\s*)?(?:(?:units?|items?|pieces?|packets?|bottles?|kg|kgs|litres?|liters?)\s+of\s+)?([a-z][a-z0-9]*(?:\s+[a-z][a-z0-9]*){0,4}?)(?=\s*(?:,|and|&|$))/gi;

  for (const match of input.matchAll(quantityFirstPattern)) {
    const quantity = Number(match[1]);
    let name = match[2];

    // Remove trailing quantity/container words accidentally captured.
    name = name
      .replace(/\b(?:units?|items?|pieces?|packets?|bottles?|kg|kgs|litres?|liters?)\b/gi, "")
      .trim();

    if (name) addPhysicalItem(items, name, quantity);
  }

  /*
   * Targeted natural-language fallback for the common MVP shopping items.
   * This deliberately stays deterministic and provider-neutral.
   */
  const knownItems = [
    "kit kat",
    "kitkat",
    "munch",
    "milk",
    "bread",
    "eggs",
    "rice",
    "water",
    "snacks",
    "snack",
    "biscuits",
    "biscuit",
  ];

  /*
   * Single-quantity known items:
   *   "milk"
   *   "and milk"
   *   "kitkat please"
   */
  for (const itemName of knownItems) {
    const escaped = itemName.replace(/\s+/g, "\\s+");
    const pattern = new RegExp(`\\b${escaped}s?\\b`, "gi");

    if (pattern.test(input)) {
      // Do not add a duplicate when an explicit quantity was already found.
      const alreadyFound = items.some(
        (item) => item.name.toLowerCase() === itemName.toLowerCase()
      );

      if (!alreadyFound) {
        addPhysicalItem(items, itemName, 1);
      }
    }
  }

  return items;
}

export function extractEntities(text = "", domain = "unknown") {
  const input = cleanText(text);
  const entities = {};

  const email = input.match(
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
  );
  if (email) entities.email = email[0];

  const phone = input.match(/(?:\+?\d[\d\s().-]{7,}\d)/);
  if (phone) entities.phone = phone[0].trim();

  const quantity = input.match(
    /\b(\d+)\s+(?:x\s*)?(?:units?|items?|pieces?|packets?|bottles?|kg|kgs|litres?|liters?)\b/i
  );
  if (quantity) entities.quantity = Number(quantity[1]);

  const budget = input.match(
    /(?:under|below|within|max(?:imum)?|budget(?:\s+of)?|less\s+than)\s*(?:₹|rs\.?|inr)?\s*([\d,]+(?:\.\d+)?)/i
  );
  if (budget) {
    entities.budget = Number(budget[1].replace(/,/g, ""));
  }

  if (domain === "physical") {
    const items = extractPhysicalItems(input);

    if (items.length) {
      entities.items = items;

      // Preserve the legacy scalar quantity field when there is one item.
      if (items.length === 1) {
        entities.quantity = items[0].quantity;
      }
    }
  }

  if (domain === "flight") {
    const route = input.match(
      /\bfrom\s+(.+?)\s+to\s+(.+?)(?:\s+on\s+|\s+for\s+|\s+tomorrow\b|\s+today\b|$)/i
    );

    if (route) {
      entities.origin = route[1].trim();
      entities.destination = route[2].trim();
    }
  }

  return entities;
}

export function buildPlan({
  text,
  intent = null,
  entities = {},
  memory = {},
} = {}) {
  const normalized = intent || classifyIntent(text);
  const domain = normalized.domain;

  if (domain === "unknown") {
    return {
      status: "needs_clarification",
      steps: [],
      reason:
        "Fetch could not confidently determine the requested service.",
    };
  }

  const base = {
    source_text: cleanText(text),
    domain,
    action: normalized.action,
    entities: { ...entities },
    memory_used: Object.keys(memory || {}).length > 0,
  };

  const templates = {
    physical: [
      {
        key: "source_resource",
        purpose:
          "Find a physical resource that can fulfill the requested items.",
      },
      {
        key: "fulfill",
        purpose:
          "Have the selected resource fulfill the request.",
      },
      {
        key: "deliver",
        purpose:
          "Complete delivery to the customer.",
      },
    ],

    digital_agent: [
      {
        key: "understand",
        purpose:
          "Understand the information, research, recommendation, or planning request.",
      },
      {
        key: "research",
        purpose:
          "Use the digital agent and available information sources to produce the requested result.",
      },
      {
        key: "respond",
        purpose:
          "Return the result to the customer.",
      },
    ],

    flight: [
      {
        key: "search",
        purpose:
          "Search available flights matching the customer's constraints.",
      },
      {
        key: "confirm",
        purpose:
          "Obtain customer confirmation before purchase when required.",
      },
      {
        key: "book",
        purpose:
          "Book the selected flight through an enabled provider.",
      },
    ],

    reservation: [
      {
        key: "search",
        purpose:
          "Find reservation options matching the customer's constraints.",
      },
      {
        key: "confirm",
        purpose:
          "Obtain customer confirmation when required.",
      },
      {
        key: "reserve",
        purpose:
          "Complete the reservation through an enabled provider.",
      },
    ],

    calendar: [
      {
        key: "validate",
        purpose:
          "Validate event details and conflicts.",
      },
      {
        key: "create",
        purpose:
          "Create the calendar event through an authorized calendar connector.",
      },
    ],

    messaging: [
      {
        key: "validate",
        purpose:
          "Validate recipient and message content.",
      },
      {
        key: "send",
        purpose:
          "Send the message through an authorized messaging connector.",
      },
    ],

    phone: [
      {
        key: "validate",
        purpose:
          "Validate target and call objective.",
      },
      {
        key: "call",
        purpose:
          "Place the call through an enabled voice connector.",
      },
    ],

    human_service: [
      {
        key: "validate",
        purpose:
          "Validate the human service request and required details.",
      },
      {
        key: "assign",
        purpose:
          "Find an appropriate human service resource.",
      },
      {
        key: "complete",
        purpose:
          "Complete the requested human service and return the result.",
      },
    ],
  };

  const selectedTemplate = templates[domain];

  if (!selectedTemplate) {
    return {
      status: "needs_clarification",
      ...base,
      steps: [],
      reason: `No execution plan is configured for domain "${domain}".`,
    };
  }

  const steps = selectedTemplate.map((step, index) => ({
    ...step,
    index,
    depends_on: index ? [index - 1] : [],
    status: index === 0 ? "ready" : "blocked",
  }));

  return {
    status: "planned",
    ...base,
    steps,
  };
}

export async function normalizeFetchIntent({
  text,
  memory = {},
  suppliedIntent = null,
} = {}) {
  const intent = suppliedIntent || classifyIntent(text);
  const entities = extractEntities(text, intent.domain);
  const plan = buildPlan({
    text,
    intent,
    entities,
    memory,
  });

  return {
    intent,
    entities,
    plan,
  };
}
