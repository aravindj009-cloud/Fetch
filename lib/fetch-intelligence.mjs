/* Fetch V7 Intelligence Layer
   Deterministic intent normalization + planning contracts.
   LLM/NLU providers can plug into normalizeFetchIntent() later without changing ATC.
*/

const ACTION_PATTERNS = [
  { type: "flight", verbs: /\b(book|find|search|reserve)\b/i, nouns: /\b(flight|flights|airfare|ticket|tickets|fly|airline)\b/i },
  { type: "reservation", verbs: /\b(book|reserve|find)\b/i, nouns: /\b(table|restaurant|dinner|lunch|reservation)\b/i },
  { type: "calendar", verbs: /\b(add|put|schedule|create|block)\b/i, nouns: /\b(calendar|meeting|event|appointment)\b/i },
  { type: "messaging", verbs: /\b(send|message|text|whatsapp|notify)\b/i, nouns: /\b(message|text|whatsapp)\b/i },
  { type: "phone", verbs: /\b(call|phone|ring|speak)\b/i, nouns: /\b(call|phone)\b/i },
  { type: "physical", verbs: /\b(buy|get|need|want|require|purchase|pick up|deliver|bring|order|fetch|grab)\b/i, nouns: /\b(grocery|groceries|milk|bread|eggs|food|item|items|product|products|kitkat|munch)\b/i },
];

function cleanText(value) { return String(value || "").trim().replace(/\s+/g, " "); }

export function classifyIntent(text = "") {
  const input = cleanText(text);
  const matches = ACTION_PATTERNS.filter((p) => p.verbs.test(input) && p.nouns.test(input));
  if (!matches.length) {
    const lower = input.toLowerCase();

    if (/\b(book|find|search)\b/.test(lower)) {
      return { domain: "unknown", action: "request", confidence: 0.35 };
    }

    // Natural shopping requests often omit an explicit verb:
    // "milk and bread", "some eggs", "kitkat please".
    if (/\b(grocery|groceries|milk|bread|eggs|food|item|items|product|products|kitkat|munch)\b/i.test(lower)) {
      return { domain: "physical", action: "execute", confidence: 0.74, candidates: ["physical"] };
    }

    return { domain: "unknown", action: "request", confidence: 0.2 };
  }
  const first = matches[0];
  return { domain: first.type, action: "execute", confidence: 0.82, candidates: matches.map((m) => m.type) };
}

export function extractEntities(text = "", domain = "unknown") {
  const input = cleanText(text);
  const entities = {};
  const email = input.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (email) entities.email = email[0];
  const phone = input.match(/(?:\+?\d[\d\s().-]{7,}\d)/);
  if (phone) entities.phone = phone[0].trim();
  const quantity = input.match(/\b(\d+)\s+(?:x\s*)?(?:units?|items?|pieces?)\b/i);
  if (quantity) entities.quantity = Number(quantity[1]);
  if (domain === "flight") {
    const route = input.match(/\bfrom\s+(.+?)\s+to\s+(.+?)(?:\s+on\s+|\s+for\s+|$)/i);
    if (route) { entities.origin = route[1].trim(); entities.destination = route[2].trim(); }
  }
  return entities;
}

export function buildPlan({ text, intent = null, entities = {}, memory = {} } = {}) {
  const normalized = intent || classifyIntent(text);
  const domain = normalized.domain;
  if (domain === "unknown") return { status: "needs_clarification", steps: [], reason: "Fetch could not confidently determine the requested service." };

  const base = { source_text: cleanText(text), domain, action: normalized.action, entities: { ...entities }, memory_used: Object.keys(memory || {}).length > 0 };
  const templates = {
    physical: [{ key: "source_resource", purpose: "Find a physical resource that can fulfill the requested items." }, { key: "fulfill", purpose: "Have the selected resource fulfill the request." }, { key: "deliver", purpose: "Complete delivery to the customer." }],
    flight: [{ key: "search", purpose: "Search available flights matching the customer's constraints." }, { key: "confirm", purpose: "Obtain customer confirmation before purchase when required." }, { key: "book", purpose: "Book the selected flight through an enabled provider." }],
    reservation: [{ key: "search", purpose: "Find reservation options matching the customer's constraints." }, { key: "confirm", purpose: "Obtain customer confirmation when required." }, { key: "reserve", purpose: "Complete the reservation through an enabled provider." }],
    calendar: [{ key: "validate", purpose: "Validate event details and conflicts." }, { key: "create", purpose: "Create the calendar event through an authorized calendar connector." }],
    messaging: [{ key: "validate", purpose: "Validate recipient and message content." }, { key: "send", purpose: "Send the message through an authorized messaging connector." }],
    phone: [{ key: "validate", purpose: "Validate target and call objective." }, { key: "call", purpose: "Place the call through an enabled voice connector." }],
  };
  const steps = (templates[domain] || []).map((step, index) => ({ ...step, index, depends_on: index ? [index - 1] : [], status: index === 0 ? "ready" : "blocked" }));
  return { status: "planned", ...base, steps };
}

export async function normalizeFetchIntent({ text, memory = {}, suppliedIntent = null } = {}) {
  const intent = suppliedIntent || classifyIntent(text);
  const entities = extractEntities(text, intent.domain);
  const plan = buildPlan({ text, intent, entities, memory });
  return { intent, entities, plan };
}
