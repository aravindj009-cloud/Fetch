/* FETCH UNIVERSAL TASK ENGINE — V1
 *
 * Purpose:
 * - Turn V9 Fetch intelligence into one stable Universal Task Contract.
 * - Give ATC a consistent task shape regardless of domain.
 * - Preserve the existing WhatsApp physical-order engine.
 * - Allow multiple requests to be represented as separate tasks.
 * - Execute only the first ready task in V1, preserving the current MVP behavior.
 * - Never claim an external side effect unless a real connector completed it.
 *
 * Architecture:
 *
 * USER
 *   ↓
 * V8 MEMORY + CONTEXT
 *   ↓
 * V9 INTELLIGENCE / WORKFLOW
 *   ↓
 * UNIVERSAL TASK ENGINE
 *   ↓
 * ATC
 *   ↓
 * DIGITAL / PHYSICAL / HUMAN / PHONE / CONNECTED APP
 *
 * IMPORTANT:
 * This file intentionally does NOT replace the physical shopping engine.
 * Existing physical WhatsApp execution remains the owner of:
 *   partner store → shopper → customer
 */

import { processFetchV9Request } from "./fetch-v9.mjs";
import { routeFetchTask } from "./fetch-atc-router.mjs";
import { executeDigitalAgent } from "./fetch-digital-agent.mjs";

function cleanText(value) {
  return String(value ?? "").trim();
}

/*
 * DETERMINISTIC UTILITY LAYER
 *
 * Time/date questions must never be answered by the language model.
 * The model can explain time zones, but the actual current time comes
 * from the runtime clock + an IANA timezone.
 */
const TIMEZONE_ALIASES = {
  sanfrancisco: "America/Los_Angeles",
  "san francisco": "America/Los_Angeles",
  sf: "America/Los_Angeles",
  losangeles: "America/Los_Angeles",
  "los angeles": "America/Los_Angeles",
  newyork: "America/New_York",
  "new york": "America/New_York",
  nyc: "America/New_York",
  chicago: "America/Chicago",
  london: "Europe/London",
  uk: "Europe/London",
  paris: "Europe/Paris",
  berlin: "Europe/Berlin",
  dubai: "Asia/Dubai",
  singapore: "Asia/Singapore",
  tokyo: "Asia/Tokyo",
  seoul: "Asia/Seoul",
  beijing: "Asia/Shanghai",
  shanghai: "Asia/Shanghai",
  hongkong: "Asia/Hong_Kong",
  "hong kong": "Asia/Hong_Kong",
  sydney: "Australia/Sydney",
  melbourne: "Australia/Melbourne",
  vancouver: "America/Vancouver",
  "vancouver canada": "America/Vancouver",
  toronto: "America/Toronto",
  "toronto canada": "America/Toronto",
  montreal: "America/Toronto",
  "montreal canada": "America/Toronto",
  ottawa: "America/Toronto",
  "ottawa canada": "America/Toronto",
  calgary: "America/Edmonton",
  "calgary canada": "America/Edmonton",
  edmonton: "America/Edmonton",
  "edmonton canada": "America/Edmonton",
  winnipeg: "America/Winnipeg",
  "winnipeg canada": "America/Winnipeg",
  halifax: "America/Halifax",
  "halifax canada": "America/Halifax",
  mexico: "America/Mexico_City",
  "mexico city": "America/Mexico_City",
  "mexico city mexico": "America/Mexico_City",
  singapore: "Asia/Singapore",
  delhi: "Asia/Kolkata",
  mumbai: "Asia/Kolkata",
  bangalore: "Asia/Kolkata",
  bengaluru: "Asia/Kolkata",
  chennai: "Asia/Kolkata",
  hyderabad: "Asia/Kolkata",
  kolkata: "Asia/Kolkata",
  kerala: "Asia/Kolkata",
  india: "Asia/Kolkata",
  ist: "Asia/Kolkata",
};

function looksLikeTimeRequest(text = "") {
  const value = cleanText(text).toLowerCase();
  return /\b(what(?:'s| is)\s+the\s+)?(?:current\s+)?time\b/i.test(value) ||
    /\btime\s+(?:in|at)\b/i.test(value) ||
    /\bwhat\s+time\s+is\s+it\b/i.test(value);
}

function extractTimeLocation(text = "") {
  const value = cleanText(text).toLowerCase();

  const match =
    value.match(/\btime\s+(?:in|at|for)\s+(.+?)(?:\s+(?:right\s+now|now|currently))?(?:\?|$)/i) ||
    value.match(/\b(?:in|at|for)\s+(.+?)\s+(?:now|currently|right now)(?:\?|$)/i);

  return cleanText(match?.[1] || "").replace(/[?.,]+$/, "");
}

function resolveTimezone(location) {
  const normalized = cleanText(location)
    .toLowerCase()
    .replace(/\s+/g, " ");

  if (!normalized) return null;

  // Accept inputs such as "Vancouver, Canada" or "Vancouver Canada".
  const candidates = [
    normalized,
    normalized.split(",")[0].trim(),
    normalized.replace(/\b(canada|usa|us|united states|uk|united kingdom|australia|india|japan|uae|china|south korea)\b/g, "").replace(/\s+/g, " ").trim(),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (TIMEZONE_ALIASES[candidate]) {
      return TIMEZONE_ALIASES[candidate];
    }

    const compact = candidate
      .replace(/[^a-z0-9 ]/g, "")
      .replace(/\s+/g, "");

    if (TIMEZONE_ALIASES[compact]) {
      return TIMEZONE_ALIASES[compact];
    }
  }

  return null;
}


/*
 * SOURCE SELECTION + EVIDENCE FALLBACK
 *
 * These functions are embedded in the Universal Execution Engine so source
 * selection does not depend on a growing list of question-specific patches.
 */

/* FETCH SOURCE ROUTER — V1
 *
 * Purpose:
 * - Decide WHAT SOURCE should answer a request before an LLM is allowed to answer.
 * - Use semantic categories, not question-by-question keyword patches.
 * - Keep deterministic utilities ahead of models.
 * - Route fresh/external requests to Browser Agent with a source policy.
 * - Keep physical commerce authoritative in the existing physical engine.
 *
 * Principle:
 *   Fetch does not choose a source because a word appeared in the question.
 *   Fetch chooses a source because the REQUEST TYPE requires that source.
 */

function sourceClean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function sourceLower(value) {
  return sourceClean(value).toLowerCase();
}

function sourceHas(value, pattern) {
  return pattern.test(sourceLower(value));
}

function resolveSourcePolicyInternal({ text = "", intent = {}, entities = {}, task = {} } = {}) {
  const value = sourceLower(text);
  const domain = sourceLower(intent?.domain || task?.domain);
  const action = sourceLower(intent?.action || "");

  const policy = {
    source_class: "digital_knowledge",
    execution_network: "digital_agent",
    freshness: "stable",
    verification_required: false,
    preferred_sources: [],
    fallback_sources: [],
    source_instruction: "Use model knowledge only for stable facts.",
  };

  /* Physical fulfilment remains authoritative. */
  if (
    domain === "physical_commerce" ||
    sourceHas(value, /\b(buy|purchase|order|deliver|delivery|shop|grocery|groceries|medicine|item|product)\b/) &&
    sourceHas(value, /\b(for me|to me|deliver|buy|purchase|order)\b/)
  ) {
    return {
      ...policy,
      source_class: "physical_fulfilment",
      execution_network: "physical_network",
      freshness: "live",
      verification_required: true,
      preferred_sources: ["fetch_partner_store_network"],
      fallback_sources: ["fetch_human_shopper"],
      source_instruction:
        "Use the physical fulfilment network as the source of truth for availability and price. Never invent stock or price.",
    };
  }

  /* Deterministic time. This is deliberately narrow: a train departure time
   * is travel data, not a timezone question, and is therefore handled below. */
  const pureClock =
    sourceHas(value, /\b(current time|what(?:'s| is) the time|what time is it)\b/) &&
    !sourceHas(value, /\b(train|express|railway|rail|flight|bus|ferry|departure|arrival|schedule|timetable|booking|meeting|event)\b/);

  if (pureClock) {
    return {
      ...policy,
      source_class: "deterministic_time",
      execution_network: "utility_network",
      freshness: "live",
      verification_required: true,
      preferred_sources: ["runtime_iana_timezone_clock"],
      fallback_sources: [],
      source_instruction:
        "Return the current time from the runtime clock using a resolved IANA timezone. Do not use model memory.",
    };
  }

  /* Weather is a data query, not a language-model question. */
  if (
    domain === "weather" ||
    sourceHas(value, /\b(weather|temperature|forecast|rain|raining|humidity|wind speed|snow)\b/)
  ) {
    return {
      ...policy,
      source_class: "live_weather",
      execution_network: "utility_network",
      freshness: "live",
      verification_required: true,
      preferred_sources: ["weather_api"],
      fallback_sources: ["browser_agent_official_weather_source"],
      source_instruction:
        "Use a live weather data provider. Do not answer current weather from model memory.",
    };
  }

  /* Travel schedules and availability require current sources. */
  const travelSignal =
    domain === "travel" ||
    sourceHas(value, /\b(train|express|railway|rail|flight|flights|airline|airport|bus|ferry|hotel|hotels|travel|trip|ticket|tickets)\b/);

  const scheduleSignal = sourceHas(
    value,
    /\b(time|timing|schedule|timetable|departure|depart|arrival|arrive|reach|platform|pnr|status|running|delay|availability|booking)\b/
  );

  if (travelSignal) {
    return {
      ...policy,
      source_class: scheduleSignal ? "live_travel_data" : "travel_research",
      execution_network: "browser_agent",
      freshness: "live",
      verification_required: true,
      preferred_sources: [
        "official_transport_operator",
        "official_railway_or_airline_source",
        "official_airport_or_station_source",
      ],
      fallback_sources: [
        "reputable_travel_schedule_provider",
        "browser_search_results",
      ],
      source_instruction:
        "Verify travel information from a current authoritative operator/railway/airline source first. If unavailable, use a reputable secondary schedule source and clearly identify it. Do not guess times, availability, delays, fares, or platforms.",
    };
  }

  /* Current facts about companies, products, people, laws, prices, jobs,
   * events and similar changing information require external evidence. */
  const currentSignal = sourceHas(
    value,
    /\b(current|currently|latest|recent|today|now|updated|newest|price|prices|cost|salary|jobs|job openings|vacancy|deadline|event|events|news|score|scores|ranking|rankings|ceo|founder|president|minister|mayor|stock|share price|available|open now|official|compare|research|investigate|verify|look up|find|search)\b/
  );

  const externalDomain =
    domain === "research" ||
    sourceHas(value, /\b(company|companies|startup|product|products|laptop|phone|iphone|android|shoe|shoes|college|university|course|courses|visa|passport|government|law|legal|sports|football|cricket|bank|banking|insurance|technology|tech|ai|artificial intelligence)\b/);

  if (currentSignal || externalDomain) {
    return {
      ...policy,
      source_class: "web_research",
      execution_network: "browser_agent",
      freshness: "current",
      verification_required: true,
      preferred_sources: [
        "official_primary_source",
        "official_government_or_regulator",
        "official_company_or_product_source",
      ],
      fallback_sources: [
        "reputable_news_or_industry_source",
        "browser_search_results",
      ],
      source_instruction:
        "Retrieve current evidence before answering. Prefer primary/official sources; use reputable secondary sources when primary evidence is unavailable. Cross-check important claims when practical.",
    };
  }

  /* Explicit web/research requests always browse. */
  if (
    sourceHas(value, /\b(research|investigate|look up|search online|browse|check online|verify online)\b/)
  ) {
    return {
      ...policy,
      source_class: "web_research",
      execution_network: "browser_agent",
      freshness: "current",
      verification_required: true,
      preferred_sources: ["official_primary_source"],
      fallback_sources: ["reputable_secondary_source", "browser_search_results"],
      source_instruction:
        "Use the Browser Agent to retrieve evidence. Do not answer from model memory when the user asked to research or verify.",
    };
  }

  return policy;
}

function resolveSourcePolicy({ text = "", task = {}, decision = {} } = {}) {
  return resolveSourcePolicyInternal({
    text,
    task,
    intent: task?.intent || decision?.intent || {},
    entities: task?.entities || decision?.entities || {},
  });
}

function applySourcePolicy(task, policy) {
  if (!task || !policy) return task;

  return {
    ...task,
    execution_network: policy.execution_network || task.execution_network,
    resource: {
      ...(task.resource || {}),
      type:
        policy.execution_network === "browser_agent"
          ? "browser_agent"
          : policy.execution_network === "utility_network"
            ? "utility_agent"
            : task.resource?.type || null,
    },
    metadata: {
      ...(task.metadata || {}),
      source_class: policy.source_class,
      freshness: policy.freshness,
      verification_required: policy.verification_required,
      preferred_sources: policy.preferred_sources,
      fallback_sources: policy.fallback_sources,
      source_instruction: policy.source_instruction,
    },
  };
}


/* FETCH CLAUDE RESEARCH FALLBACK — V2 DIAGNOSTIC
 *
 * Optional fallback research engine.
 *
 * It is NOT the default conversational model and it is NOT allowed to invent
 * current facts from memory. It is used only when Fetch needs live evidence
 * and the primary Browser Agent cannot complete the research task.
 *
 * Required only if this fallback is desired:
 *   ANTHROPIC_API_KEY
 *   ANTHROPIC_WORKSPACE_ID
 *
 * Optional:
 *   FETCH_RESEARCH_MODEL=claude-sonnet-5
 */

const ANTHROPIC_API_KEY = String(
  process.env.ANTHROPIC_API_KEY || ""
).trim();

const ANTHROPIC_WORKSPACE_ID = String(
  process.env.ANTHROPIC_WORKSPACE_ID || ""
).trim();

const CLAUDE_MODEL = String(
  process.env.FETCH_RESEARCH_MODEL || "claude-sonnet-5"
).trim();

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function buildResearchPrompt({ text, sourcePolicy } = {}) {
  return `
You are Fetch's evidence-gathering research worker.

User request:
${clean(text)}

Source policy:
${JSON.stringify(sourcePolicy || {}, null, 2)}

Rules:
1. Search the live web. Do not answer from model memory when the request requires current or externally verifiable information.
2. Prefer the source classes listed in preferred_sources.
3. For travel schedules, railway/airline/airport information, prefer the official operator or official transport source first.
4. For companies/products, prefer official company or manufacturer sources.
5. For government/legal information, prefer official government or regulator sources.
6. If an authoritative primary source cannot be found, use reputable secondary sources and clearly mark them as secondary.
7. Do not invent missing values.
8. If sources conflict, report the conflict rather than silently choosing a value.
9. Return concise evidence that another model can safely synthesize.
`.trim();
}

function extractText(blocks) {
  return (Array.isArray(blocks) ? blocks : [])
    .filter((block) => block?.type === "text")
    .map((block) => clean(block.text))
    .filter(Boolean)
    .join("\n\n");
}

function extractCitations(blocks) {
  const citations = [];

  for (const block of Array.isArray(blocks) ? blocks : []) {
    for (const citation of Array.isArray(block?.citations)
      ? block.citations
      : []) {
      if (citation?.url) {
        citations.push({
          url: citation.url,
          title: citation.title || "Web source",
          cited_text: citation.cited_text || "",
        });
      }
    }
  }

  const unique = [];
  const seen = new Set();
  for (const item of citations) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    unique.push(item);
  }

  return unique;
}

async function executeClaudeResearch({
  text,
  sourcePolicy = {},
} = {}) {
  if (!ANTHROPIC_API_KEY) {
    return {
      success: false,
      status: "not_configured",
      execution_type: "claude_web_research",
      message: "Claude research fallback is not configured.",
    };
  }

  const response = await fetch(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        ...(ANTHROPIC_WORKSPACE_ID
          ? { "anthropic-workspace-id": ANTHROPIC_WORKSPACE_ID }
          : {}),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 1800,
        messages: [
          {
            role: "user",
            content: buildResearchPrompt({ text, sourcePolicy }),
          },
        ],
        tools: [
          {
            type: "web_search_20260318",
            name: "web_search",
            max_uses: 5,
            allowed_callers: ["direct"],
          },
        ],
      }),
    }
  );

  const raw = await response.text();
  let data;

  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = { raw };
  }

  const requestId =
    response.headers.get("request-id") ||
    response.headers.get("x-request-id") ||
    data?.request_id ||
    null;

  if (!response.ok) {
    const apiType = clean(data?.error?.type || data?.type || "http_error");
    const apiMessage = clean(
      data?.error?.message ||
        data?.message ||
        data?.raw ||
        "Claude returned an HTTP API error."
    );

    console.error(
      "FETCH CLAUDE API HTTP ERROR:",
      JSON.stringify({
        http_status: response.status,
        api_type: apiType || "unknown",
        api_message: apiMessage,
        request_id: requestId,
        model: CLAUDE_MODEL,
      })
    );

    return {
      success: false,
      status: "claude_error",
      execution_type: "claude_web_research",
      message: `Claude API error (${response.status}).`,
      error: `${apiType || "unknown"}: ${apiMessage}`,
      diagnostics: {
        http_status: response.status,
        api_type: apiType || "unknown",
        api_message: apiMessage,
        request_id: requestId,
        model: CLAUDE_MODEL,
      },
    };
  }

  const content = Array.isArray(data?.content) ? data.content : [];
  const answer = extractText(content);
  const citations = extractCitations(content);

  const toolErrors = [];
  for (const block of content) {
    if (block?.type !== "web_search_tool_result") continue;

    const items = Array.isArray(block?.content)
      ? block.content
      : block?.content
        ? [block.content]
        : [];

    for (const item of items) {
      if (item?.type === "web_search_tool_result_error") {
        toolErrors.push({
          error_code: clean(item?.error_code || "unknown"),
        });
      }
    }
  }

  if (toolErrors.length) {
    console.error(
      "FETCH CLAUDE WEB SEARCH TOOL ERROR:",
      JSON.stringify({
        tool_errors: toolErrors,
        request_id: requestId,
        model: CLAUDE_MODEL,
        stop_reason: data?.stop_reason || null,
      })
    );

    return {
      success: false,
      status: "claude_web_search_error",
      execution_type: "claude_web_research",
      message: `Claude web search failed: ${toolErrors.map((x) => x.error_code).join(", ")}.`,
      error: toolErrors.map((x) => x.error_code).join(", "),
      diagnostics: {
        tool_errors: toolErrors,
        request_id: requestId,
        model: CLAUDE_MODEL,
        stop_reason: data?.stop_reason || null,
      },
    };
  }

  if (!answer || !citations.length) {
    console.error(
      "FETCH CLAUDE INSUFFICIENT EVIDENCE:",
      JSON.stringify({
        has_answer: Boolean(answer),
        citation_count: citations.length,
        request_id: requestId,
        model: CLAUDE_MODEL,
        stop_reason: data?.stop_reason || null,
      })
    );

    return {
      success: false,
      status: "insufficient_evidence",
      execution_type: "claude_web_research",
      message:
        "Claude could not return sufficient cited web evidence for this request.",
      citations,
      diagnostics: {
        has_answer: Boolean(answer),
        citation_count: citations.length,
        request_id: requestId,
        model: CLAUDE_MODEL,
        stop_reason: data?.stop_reason || null,
      },
    };
  }

  return {
    success: true,
    status: "completed",
    execution_type: "claude_web_research",
    result: answer,
    message: answer,
    evidence: citations,
    execution_metadata: {
      provider: "anthropic",
      model: CLAUDE_MODEL,
      verified: true,
      source_count: citations.length,
      source_policy: sourcePolicy,
      request_id: requestId,
    },
  };
}

function executeTimeUtility(text) {
  if (!looksLikeTimeRequest(text)) return null;

  const location = extractTimeLocation(text);
  const timeZone = resolveTimezone(location);

  if (!timeZone) {
    return {
      success: false,
      status: "timezone_required",
      message: location
        ? `I need the timezone for ${location} to give you the exact current time.`
        : "Which city or timezone should I check?",
      result: location
        ? `I need the timezone for ${location} to give you the exact current time.`
        : "Which city or timezone should I check?",
      resource_type: "utility_agent",
      execution_type: "time",
      execution_metadata: {
        provider: "runtime_intl",
        verified: false,
        utility: "time",
        timezone: null,
      },
    };
  }

  const now = new Date();
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(now);

  const answer = `The current time in ${location || timeZone} is ${formatted}.`;

  return {
    success: true,
    status: "completed",
    message: answer,
    result: answer,
    resource_type: "utility_agent",
    execution_type: "time",
    execution_metadata: {
      provider: "runtime_intl",
      verified: true,
      utility: "time",
      timezone: timeZone,
      observed_at: now.toISOString(),
    },
  };
}

function normalizeStatus(value, fallback = "unknown") {
  const status = cleanText(value).toLowerCase();
  return status || fallback;
}

function normalizeNetwork(decision = {}) {
  const raw = cleanText(
    decision?.network ||
    decision?.preferred_capability ||
    "human_service"
  );

  const normalized = raw.toLowerCase();

  if (
    normalized === "browser" ||
    normalized === "browser_agent" ||
    normalized === "web_browser" ||
    normalized === "computer_use" ||
    normalized === "browser_use"
  ) {
    return "browser_agent";
  }

  return raw;
}

function normalizeResourceType(decision = {}) {
  const network = normalizeNetwork(decision);

  if (decision?.resource_type) {
    return cleanText(decision.resource_type);
  }

  if (network === "physical_network") {
    return "partner_store";
  }

  if (network === "digital_agent") {
    return "digital_agent";
  }

  return null;
}


/*
 * Explicit browser-intent detection.
 *
 * V9 remains the general intelligence layer, but requests that explicitly
 * ask Fetch to interact with a website must be routed to the Browser Agent.
 *
 * Examples:
 *   "Open Wikipedia and tell me..."
 *   "Visit amazon.in and find..."
 *   "Search the web for..."
 *   "Go to this website..."
 *   "Check this webpage..."
 *   "Click the..."
 *   "Find this on the website..."
 *
 * Ordinary questions such as "Who founded Microsoft?" continue to use
 * the conversational Digital Agent. Current travel schedules/timetables
 * are routed to the Browser Agent because they require fresh verification.
 */
function hasExplicitBrowserIntent(text = "") {
  const value = cleanText(text).toLowerCase();

  if (!value) return false;

  const urlPattern =
    /\bhttps?:\/\/\S+|\bwww\.\S+|\b[a-z0-9-]+\.(?:com|in|org|net|io|ai|co|uk|gov|edu)\b/i;

  const browserPhrases = [
    /\bopen\s+(?:the\s+)?(?:website|webpage|site|url)\b/i,
    /\bopen\s+(?:wikipedia|amazon|flipkart|google|youtube|reddit|linkedin|instagram|facebook)\b/i,
    /\bvisit\s+(?:the\s+)?(?:website|webpage|site|url)\b/i,
    /\bgo\s+to\s+(?:the\s+)?(?:website|webpage|site|url)\b/i,
    /\bgo\s+to\s+(?:https?:\/\/|www\.)/i,
    /\bsearch\s+(?:the\s+)?(?:web|internet|online)\b/i,
    /\bsearch\s+online\s+for\b/i,
    /\blook\s+(?:it\s+)?up\s+online\b/i,
    /\bfind\s+(?:this|that|it)\s+(?:on|from)\s+(?:the\s+)?(?:website|web|internet)\b/i,
    /\bfind\s+.*\bon\s+(?:the\s+)?website\b/i,
    /\bcheck\s+(?:the\s+)?(?:website|webpage|site|url)\b/i,
    /\bcheck\s+.*\bonline\b/i,
    /\bclick\s+(?:on\s+)?(?:the\s+)?/i,
    /\bnavigate\s+to\b/i,
    /\bfill\s+(?:in\s+)?(?:the\s+)?(?:form|field)\b/i,
    /\bsubmit\s+(?:the\s+)?(?:form|application)\b/i,
    /\buse\s+(?:the\s+)?website\b/i,
    /\buse\s+(?:the\s+)?web\s+browser\b/i,
    /\bbrowse\s+(?:the\s+)?web\b/i,
    /\bfrom\s+(?:the\s+)?website\b/i,
    /\bon\s+(?:the\s+)?website\b/i,
  ];

  return (
    urlPattern.test(value) ||
    browserPhrases.some((pattern) => pattern.test(value))
  );
}

function hasResearchBrowserIntent(text = "") {
  const value = cleanText(text).toLowerCase();

  if (!value) return false;

  // Explicit research verbs: these mean Fetch should actually look at
  // current web pages rather than answer from model knowledge.
  const researchVerb =
    /\b(research|investigate|look\s+up|find|compare|check|verify|browse|search)\b/i.test(
      value
    );

  // Domains where a fresh web lookup is materially different from a
  // conversational knowledge answer.
  const researchDomain =
    /\b(flight|flights|hotel|hotels|restaurant|restaurants|football shoes|shoes|laptop|laptops|price|prices|product|products|job|jobs|event|events|visa|passport|travel|trip|ticket|tickets|course|courses|college|university|company|companies|startup|startups|service|services|coworking|coworking space|news|latest|current|official website|application deadline|train|trains|railway|railways|rail|express|train schedule|train timetable|timetable|arrival time|departure time|arrivals|departures|platform|pnr)\b/i.test(
      value
    );

  // A train name + route/time question is inherently schedule-dependent.
  // It must be verified from a current web source even when the user does
  // not explicitly say "search" or "check online".
  const trainScheduleIntent =
    /\b(train|express|railway|rail)\b/i.test(value) &&
    /\b(time|timing|schedule|timetable|departure|depart|arrival|arrive|reach|platform)\b/i.test(value) &&
    /\b(from|to|between|via)\b/i.test(value);

  // Strong shopping/current-data phrases should browse even when the
  // wording doesn't contain "research".
  const transactionalResearch =
    /\b(under\s*[₹$€£]?\s*[\d,]+|below\s*[₹$€£]?\s*[\d,]+|cheapest|best\s+options|current\s+price|available\s+now|this\s+week|next\s+week|next\s+month|today|tonight|this\s+weekend)\b/i.test(
      value
    );

  return (
    trainScheduleIntent ||
    (researchVerb && researchDomain) ||
    (researchVerb && /\b(on|online|web|internet|website)\b/i.test(value)) ||
    transactionalResearch
  );
}

function shouldUseBrowserForRequest(text = "") {
  return (
    hasExplicitBrowserIntent(text) ||
    hasResearchBrowserIntent(text)
  );
}

function applyBrowserIntentOverride(task, receivedText) {
  if (!task || !shouldUseBrowserForRequest(receivedText)) {
    return task;
  }

  /*
   * Never override a physical commerce request. Physical shopping remains
   * owned by the existing partner-store / shopper engine.
   */
  const existingNetwork = normalizeNetwork({
    network: task.execution_network,
  });

  if (
    existingNetwork === "physical_network" ||
    task.resource?.type === "partner_store"
  ) {
    return task;
  }

  return {
    ...task,
    execution_network: "browser_agent",
    resource: {
      ...(task.resource || {}),
      type: "browser_agent",
    },
    status: "ready_for_atc",
    metadata: {
      ...(task.metadata || {}),
      routing_override: hasExplicitBrowserIntent(receivedText)
        ? "explicit_browser_intent"
        : "research_browser_intent",
    },
  };
}

function getFirstStep(decisionItem, v9Result) {
  return (
    decisionItem?.plan?.steps?.[0] ||
    decisionItem?.decision?.first_step ||
    v9Result?.steps?.[0] ||
    null
  );
}

/*
 * UNIVERSAL TASK CONTRACT
 *
 * This is the common language between Fetch and ATC.
 *
 * Fetch decides:
 *   what the user wants
 *   what domain it belongs to
 *   whether confirmation is required
 *   what workflow/step should happen first
 *
 * ATC decides:
 *   who/what can execute it
 *   which resource to use
 *   how it should be routed
 */
export function buildUniversalTask({
  request,
  decision,
  step,
  index = 0,
} = {}) {
  const decisionData = decision?.decision || {};
  const intent = decision?.intent || {};
  const entities = decision?.entities || {};

  const sourceText =
    cleanText(decision?.received_text) ||
    cleanText(request?.received_text);

  const network = normalizeNetwork(decisionData);
  const resourceType = normalizeResourceType(decisionData);

  const taskId =
    decision?.workflow_task_id ||
    `${request?.workflow_id || "fetch"}-${index + 1}`;

  const goal =
    cleanText(decision?.plan?.source_text) ||
    sourceText;

  const objective =
    cleanText(step?.purpose) ||
    goal;

  const requiresConfirmation =
    Boolean(decisionData?.confirmation_required);

  const executionMode =
    cleanText(decisionData?.execution_mode) ||
    (step?.key === "search" || step?.key === "source_resource"
      ? "discover"
      : "execute");

  return {
    contract_version: "fetch-task-v1",

    task_id: taskId,
    workflow_id: request?.workflow_id || null,
    parent_task_id: request?.context?.active_task_id || null,

    customer_id: request?.customer_id || null,
    conversation_id: request?.conversation_id || null,
    channel: request?.channel || "unknown",

    user_request: sourceText,

    intent: {
      domain: cleanText(intent?.domain) || null,
      action: cleanText(intent?.action) || null,
      goal,
    },

    goal,
    objective,

    domain: cleanText(intent?.domain) || null,

    priority:
      cleanText(entities?.priority) ||
      cleanText(entities?.urgency) ||
      "normal",

    requires_confirmation: requiresConfirmation,

    workflow: {
      step_key: cleanText(step?.key) || null,
      step_type: cleanText(step?.type) || null,
      step_index: index,
      total_steps: Array.isArray(decision?.plan?.steps)
        ? decision.plan.steps.length
        : null,
      execution_mode: executionMode,
    },

    current_step: cleanText(step?.key) || null,

    execution_network: network,

    resource: {
      type: resourceType,
      id: null,
      provider_id: null,
      name: null,
    },

    status: decisionData?.status === "ready"
      ? "ready_for_atc"
      : "needs_clarification",

    result: null,

    entities: entities || {},

    memory: request?.context?.memory || {},

    metadata: {
      source: "fetch-v9",
      decision_status: normalizeStatus(
        decisionData?.status,
        "unknown"
      ),
      confirmation_status: requiresConfirmation
        ? "pending"
        : "not_required",
    },

    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function getDecisionItems(v9Result) {
  return Array.isArray(v9Result?.decisions)
    ? v9Result.decisions
    : [];
}

function buildUniversalTasks(v9Result) {
  const decisions = getDecisionItems(v9Result);

  return decisions.map((decisionItem, index) => {
    const step = getFirstStep(decisionItem, v9Result);

    return buildUniversalTask({
      request: v9Result,
      decision: decisionItem,
      step,
      index,
    });
  });
}

function firstReadyTask(tasks) {
  return (
    tasks.find(
      (task) =>
        task?.status === "ready_for_atc"
    ) || null
  );
}

function buildExecutionResult({
  task,
  route,
  execution = null,
} = {}) {
  return {
    task_id: task?.task_id || null,
    network: task?.execution_network || null,
    resource_type:
      route?.resource_type ||
      task?.resource?.type ||
      null,
    route_status: route?.status || null,
    execution,
  };
}


async function executeBrowserAgent({
  task,
  route,
  context = {},
} = {}) {
  const endpoint = cleanText(
    route?.endpoint ||
    route?.resource?.endpoint
  );

  if (!endpoint) {
    return {
      success: false,
      status: "awaiting_resource",
      message:
        "The Fetch Browser Agent is not connected yet.",
      execution_type: "browser_agent",
    };
  }

  const browserTask = cleanText(
    task?.user_request ||
    task?.goal ||
    task?.objective
  );

  if (!browserTask) {
    return {
      success: false,
      status: "invalid_task",
      message: "Fetch could not create a browser task.",
      execution_type: "browser_agent",
    };
  }

  const payload = {
    task: browserTask,
    url:
      context?.browser_url ||
      task?.entities?.url ||
      task?.entities?.website ||
      null,
    conversation_id:
      context?.conversation_id ||
      task?.conversation_id ||
      null,
    workflow_id:
      context?.workflow_id ||
      task?.workflow_id ||
      null,
  };

  const headers = {
    "Content-Type": "application/json",
  };

  const token = cleanText(
    process.env.BROWSER_WORKER_TOKEN ||
    route?.resource?.metadata?.token
  );

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  try {
    const response = await fetch(
      `${endpoint.replace(/\/+$/, "")}/execute`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      }
    );

    const raw = await response.text();

    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = raw;
    }

    if (!response.ok) {
      return {
        success: false,
        status: "browser_worker_error",
        message:
          typeof data === "string"
            ? data
            : data?.message ||
              `Browser worker returned HTTP ${response.status}.`,
        execution_type: "browser_agent",
      };
    }

    return {
      ...(data || {}),
      execution_type:
        data?.execution_type ||
        "browser_agent",
      worker_endpoint: endpoint,
    };
  } catch (error) {
    console.error(
      "FETCH BROWSER AGENT ERROR:",
      error
    );

    return {
      success: false,
      status: "browser_worker_unreachable",
      message:
        "Fetch could not reach the Browser Agent worker.",
      error:
        process.env.NODE_ENV === "development"
          ? error?.message || String(error)
          : undefined,
      execution_type: "browser_agent",
    };
  }
}

export async function executeUniversalFetchRequest({
  text,
  customerId = null,
  conversationId = null,
  channel = "api",
  activeTaskId = null,
  suppliedIntent = null,
  suppliedContext = {},
} = {}) {
  const receivedText = cleanText(text);

  if (!receivedText) {
    throw new Error("text is required");
  }

  /*
   * STEP 1
   * Let the existing V8/V9 intelligence layer understand the request.
   */
  const v9 = await processFetchV9Request({
    text: receivedText,
    customerId,
    conversationId,
    channel,
    activeTaskId,
    suppliedIntent,
    suppliedContext,
  });

  /*
   * STEP 2
   * Convert every V9 decision into the Universal Task Contract.
   *
   * We keep all tasks in the response, even though V1 executes only
   * the first ready task. This is the foundation for true multi-step
   * execution in the next versions.
   */
  const tasks = buildUniversalTasks(v9);
  let readyTask = firstReadyTask(tasks);

  /*
   * STEP 2A — SOURCE RESOLUTION
   *
   * Do not maintain one-off question patterns here. The Source Router
   * decides which class of source is appropriate for the request.
   */
  const sourcePolicy = resolveSourcePolicy({
    text: receivedText,
    task: readyTask || {},
    decision: v9?.decisions?.find(
      (item) => item?.received_text === receivedText
    )?.decision || {},
  });

  /*
   * STEP 2B — APPLY SOURCE POLICY BEFORE ANY EXECUTION
   */
  readyTask = applySourcePolicy(readyTask, sourcePolicy);

  /*
   * STEP 2C — DETERMINISTIC UTILITIES
   *
   * Only execute the time utility when the Source Router explicitly says
   * this is a pure clock request. This prevents travel schedules such as
   * "what time does Sabari Express leave..." from being misclassified.
   */
  if (sourcePolicy.execution_network === "utility_network" &&
      sourcePolicy.source_class === "deterministic_time") {
    const utilityExecution = executeTimeUtility(receivedText);

    if (utilityExecution) {
      const utilityTaskId = `utility-${Date.now()}`;

      return {
        version: "universal-task-v2",
        status: utilityExecution.success
          ? "completed"
          : "execution_failed",
        workflow_id: v9?.workflow_id || null,
        task: {
          ...(readyTask || {}),
          task_id: utilityTaskId,
          user_request: receivedText,
          goal: receivedText,
          objective: "Resolve the current time",
          execution_network: "utility_network",
          resource: {
            type: "utility_agent",
            id: "builtin-time",
            name: "Fetch Time Utility",
          },
          status: utilityExecution.success
            ? "completed"
            : "execution_failed",
          result: utilityExecution.result || utilityExecution.message,
          metadata: {
            ...(readyTask?.metadata || {}),
            source_verified: utilityExecution.success,
          },
        },
        tasks,
        fetch: v9,
        atc: {
          route_type: "utility",
          capability: "time",
          status: utilityExecution.success ? "matched" : "failed",
          resource_type: "utility_agent",
          resource_id: "builtin-time",
          display_name: "Fetch Time Utility",
        },
        execution: {
          task_id: utilityTaskId,
          network: "utility_network",
          resource_type: "utility_agent",
          route_status: utilityExecution.success ? "matched" : "failed",
          execution: utilityExecution,
        },
      };
    }
  }

  /*
   * V9 may classify an explicit website request as a conversational
   * digital-agent task. Correct that at the Universal Execution boundary
   * so ATC receives the right execution network without changing the
   * general conversation behavior.
   */
  if (sourcePolicy.execution_network === "browser_agent") {
    readyTask = {
      ...readyTask,
      execution_network: "browser_agent",
      resource: {
        ...(readyTask?.resource || {}),
        type: "browser_agent",
      },
      metadata: {
        ...(readyTask?.metadata || {}),
        source_class: sourcePolicy.source_class,
        preferred_sources: sourcePolicy.preferred_sources,
        fallback_sources: sourcePolicy.fallback_sources,
        source_instruction: sourcePolicy.source_instruction,
      },
    };
  } else {
    readyTask = applyBrowserIntentOverride(readyTask, receivedText);
  }

  if (!readyTask) {
    return {
      version: "universal-task-v2",
      status: "needs_clarification",
      workflow_id: v9?.workflow_id || null,
      task: null,
      tasks,
      fetch: v9,
      atc: null,
      execution: null,
    };
  }

  /*
   * STEP 3
   * Build the ATC-facing task.
   *
   * Physical shopping is deliberately passed through as context only.
   * The existing WhatsApp order engine remains responsible for the
   * real partner-store/shopper transaction.
   */
  const physicalOrder =
    suppliedContext?.physical_order || null;

  const route = await routeFetchTask({
    task: {
      id: readyTask.task_id,
      source_text: readyTask.user_request,
      goal: readyTask.goal,
      objective: readyTask.objective,
      task_data: {
        contract_version: readyTask.contract_version,
        task_id: readyTask.task_id,
        workflow_id: readyTask.workflow_id,
        customer_id: readyTask.customer_id,
        conversation_id: readyTask.conversation_id,
        channel: readyTask.channel,
        user_request: readyTask.user_request,
        intent: readyTask.intent,
        domain: readyTask.domain,
        entities: readyTask.entities,
        execution_network: readyTask.execution_network,
        resource: readyTask.resource,
        requires_confirmation:
          readyTask.requires_confirmation,
        workflow: readyTask.workflow,
        metadata: readyTask.metadata,
      },
    },
    decision: {
      ...(
        v9?.decisions?.find(
          (item) =>
            item?.received_text ===
            readyTask.user_request
        )?.decision || {}
      ),
      network: readyTask.execution_network,
      resource_type: readyTask.resource?.type,
      confirmation_required:
        readyTask.requires_confirmation,
      execution_mode:
        readyTask.workflow?.execution_mode,
    },
    physicalOrder,
    sourcePolicy,
  });

  if (!route || route.status !== "matched") {
    /*
     * The Browser Agent is a preferred execution resource, not a hard
     * dependency for fresh web research. If ATC cannot match/reach it,
     * fall back to Claude's live web-search tool before declaring failure.
     */
    if (sourcePolicy.verification_required &&
        sourcePolicy.execution_network === "browser_agent") {
      const claudeFallback = await executeClaudeResearch({
        text: receivedText,
        sourcePolicy,
      });

      if (claudeFallback?.success) {
        return {
          version: "universal-task-v2",
          status: "completed",
          workflow_id: v9?.workflow_id || null,
          task: {
            ...readyTask,
            status: "completed",
            result: claudeFallback.result || claudeFallback.message,
            metadata: {
              ...(readyTask?.metadata || {}),
              research_fallback: "claude_web_search",
              source_verified: true,
              evidence: claudeFallback.evidence || [],
            },
          },
          tasks,
          fetch: v9,
          atc: route || {
            status: "browser_route_unavailable",
            resource_type: "browser_agent",
          },
          execution: {
            task_id: readyTask.task_id,
            network: "browser_agent",
            resource_type: "claude_web_research",
            route_status: route?.status || "unmatched",
            execution: claudeFallback,
          },
        };
      }

      console.error(
        "FETCH RESEARCH FALLBACK FAILED:",
        JSON.stringify({
          route_status: route?.status || "unmatched",
          source_class: sourcePolicy.source_class,
          claude_status: claudeFallback?.status || "unknown",
          claude_message: claudeFallback?.message || "unknown",
          claude_error: claudeFallback?.error || undefined,
        })
      );
    }

    return {
      version: "universal-task-v1",
      status:
        route?.status ||
        "awaiting_resource",
      workflow_id: v9?.workflow_id || null,
      task: readyTask,
      tasks,
      fetch: v9,
      atc: route || null,
      execution: {
        success: false,
        status: route?.status || "awaiting_resource",
        message:
          route?.message ||
          "Fetch could not connect the required execution resource.",
      },
    };
  }

  /*
   * STEP 4A — BROWSER NETWORK
   *
   * ATC selected the browser worker. The worker owns Chromium and
   * performs the actual website interaction.
   */
  if (
    route.resource_type ===
      "browser_agent"
  ) {
    let execution =
      await executeBrowserAgent({
        task: readyTask,
        route,
        context: {
          channel,
          text: receivedText,
          customer_id: customerId,
          conversation_id:
            conversationId,
          workflow_id:
            v9?.workflow_id || null,
          task_id:
            readyTask.task_id,
          atc_route: route,
          browser_url:
            suppliedContext?.browser_url ||
            null,
          source_policy: sourcePolicy,
        },
      });

    /*
     * PRIMARY RESEARCH WORKER FAILED -> OPTIONAL CLAUDE WEB SEARCH
     *
     * Claude is a fallback evidence gatherer, not the final authority.
     * Its web-search citations are preserved in the execution result.
     */
    if (!execution?.success && sourcePolicy.verification_required) {
      console.error(
        "FETCH BROWSER PRIMARY EXECUTION FAILED:",
        JSON.stringify({
          status: execution?.status || "unknown",
          message: execution?.message || "unknown",
          error: execution?.error || undefined,
          source_class: sourcePolicy.source_class,
        })
      );

      const claudeFallback = await executeClaudeResearch({
        text: receivedText,
        sourcePolicy,
      });

      if (claudeFallback?.success) {
        execution = {
          ...claudeFallback,
          fallback_from: "browser_agent",
        };
      } else {
        console.error(
          "FETCH CLAUDE RESEARCH FALLBACK FAILED:",
          JSON.stringify({
            status: claudeFallback?.status || "unknown",
            message: claudeFallback?.message || "unknown",
            error: claudeFallback?.error || undefined,
            source_class: sourcePolicy.source_class,
          })
        );
      }
    }

    return {
      version: "universal-task-v1",
      status: execution?.success
        ? "completed"
        : "execution_failed",
      workflow_id:
        v9?.workflow_id || null,
      task: {
        ...readyTask,
        status: execution?.success
          ? "completed"
          : "execution_failed",
        resource: {
          ...readyTask.resource,
          type: "browser_agent",
          id:
            route.resource_id ||
            null,
          name:
            route.display_name ||
            route.resource?.display_name ||
            "Fetch Browser Agent",
        },
        result:
          execution?.result ||
          execution?.message ||
          null,
        metadata: {
          ...(readyTask.metadata || {}),
          execution_status: execution?.status || null,
          execution_type: execution?.execution_type || null,
          evidence: execution?.evidence || [],
        },
      },
      tasks,
      fetch: v9,
      atc: route,
      execution: buildExecutionResult({
        task: readyTask,
        route,
        execution,
      }),
    };
  }

  /*
   * STEP 4A — DIGITAL NETWORK
   *
   * This is the currently live universal connector.
   */
  if (
    route.resource_type ===
    "digital_agent"
  ) {
    const execution =
      await executeDigitalAgent({
        task: {
          id: readyTask.task_id,
          source_text:
            readyTask.user_request,
          goal: readyTask.goal,
          objective:
            readyTask.objective,
          task_data: {
            ...readyTask,
            atc_route: route,
          },
        },
        route,
        resource:
          route.resource || {},
        context: {
          channel,
          text: receivedText,
          customer_id: customerId,
          conversation_id:
            conversationId,
          workflow_id:
            v9?.workflow_id || null,
          task_id:
            readyTask.task_id,
          atc_route: route,
          conversation_history:
            Array.isArray(
              suppliedContext?.conversation_history
            )
              ? suppliedContext.conversation_history
              : [],
        },
      });

    return {
      version: "universal-task-v1",
      status: execution?.success
        ? "completed"
        : "execution_failed",
      workflow_id:
        v9?.workflow_id || null,
      task: {
        ...readyTask,
        status: execution?.success
          ? "completed"
          : "execution_failed",
        resource: {
          ...readyTask.resource,
          type:
            route.resource_type ||
            readyTask.resource.type,
          id:
            route.resource_id ||
            null,
          name:
            route.resource?.name ||
            null,
        },
        result:
          execution?.result ||
          execution?.message ||
          null,
        metadata: {
          ...(readyTask.metadata || {}),
          execution_status: execution?.status || null,
          execution_type: execution?.execution_type || null,
          evidence: execution?.evidence || [],
        },
      },
      tasks,
      fetch: v9,
      atc: route,
      execution: buildExecutionResult({
        task: readyTask,
        route,
        execution,
      }),
    };
  }

  /*
   * STEP 4B — PHYSICAL NETWORK
   *
   * Do not execute a second order engine here.
   * The existing WhatsApp MVP takes over the physical flow.
   */
  if (
    route.resource_type ===
    "partner_store"
  ) {
    return {
      version: "universal-task-v1",
      status: "physical_network",
      workflow_id:
        v9?.workflow_id || null,
      task: {
        ...readyTask,
        status: "routed_to_physical_network",
        resource: {
          ...readyTask.resource,
          type: "partner_store",
          id:
            route.resource_id ||
            route.partnerStoreId ||
            null,
        },
      },
      tasks,
      fetch: v9,
      atc: route,
      execution: {
        success: false,
        status:
          "handled_by_existing_physical_engine",
        message:
          "ATC routed the request to the physical network. The existing Fetch physical-order engine remains responsible for partner-store, shopper and delivery execution.",
      },
    };
  }

  /*
   * STEP 4C — CONNECTOR SEAM
   *
   * We intentionally do not pretend that phone, flight, reservation,
   * calendar, messaging, human-service or connected-app actions happened.
   */
  return {
    version: "universal-task-v1",
    status: "resource_matched",
    workflow_id:
      v9?.workflow_id || null,
    task: {
      ...readyTask,
      status: "awaiting_connector",
      resource: {
        ...readyTask.resource,
        type:
          route.resource_type ||
          readyTask.resource.type ||
          null,
        id:
          route.resource_id ||
          null,
        provider_id:
          route.provider_id ||
          null,
        name:
          route.resource?.name ||
          null,
      },
    },
    tasks,
    fetch: v9,
    atc: route,
    execution: {
      success: false,
      status: "awaiting_connector",
      message:
        `ATC matched ${
          route.resource_type ||
          readyTask.execution_network ||
          "a resource"
        }, but no universal execution connector is enabled for it yet.`,
    },
  };
}
