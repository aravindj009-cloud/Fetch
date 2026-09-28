/* FETCH UNIVERSAL TASK ENGINE — V6 LIVE RESEARCH ROUTING
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

const BROWSER_WORKER_URL = String(process.env.BROWSER_WORKER_URL || "https://fetch-browser-worker.onrender.com").trim();
const BROWSER_WORKER_TOKEN = String(process.env.BROWSER_WORKER_TOKEN || "").trim();
const FETCH_UNIVERSAL_BUILD = "2026-09-28-UNIVERSAL-V7-RESEARCH-FIRST";

function cleanText(value) {
  if (value == null) return "";

  if (typeof value === "string") {
    return value.trim();
  }

  if (Array.isArray(value)) {
    return value.map((item) => cleanText(item)).filter(Boolean).join("\n").trim();
  }

  if (typeof value === "object") {
    const preferred =
      value.text ??
      value.content ??
      value.message ??
      value.result ??
      value.answer ??
      value.output;

    if (preferred !== undefined && preferred !== value) {
      return cleanText(preferred);
    }

    try {
      return JSON.stringify(value).trim();
    } catch {
      return "";
    }
  }

  return String(value).trim();
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
 * the conversational Digital Agent.
 */
function hasExplicitBrowserIntent(text = "") {
  const value = cleanText(text).toLowerCase();
  if (!value) return false;

  /*
   * Interactive browser use means Fetch must actually open/navigate/click/
   * fill a site. Plain "search the web" is research and should use the
   * lightweight source path first.
   */
  const interactiveUrlPattern =
    /\bhttps?:\/\/\S+|\bwww\.\S+|\b[a-z0-9-]+\.(?:com|in|org|net|io|ai|co|uk|gov|edu)\b/i;

  const interactivePhrases = [
    /\bopen\s+(?:the\s+)?(?:website|webpage|site|url)\b/i,
    /\bopen\s+(?:wikipedia|amazon|flipkart|google|youtube|reddit|linkedin|instagram|facebook)\b/i,
    /\bvisit\s+(?:the\s+)?(?:website|webpage|site|url)\b/i,
    /\bgo\s+to\s+(?:the\s+)?(?:website|webpage|site|url)\b/i,
    /\bgo\s+to\s+(?:https?:\/\/|www\.)/i,
    /\bclick\s+(?:on\s+)?/i,
    /\bnavigate\s+to\b/i,
    /\bfill\s+(?:in\s+)?(?:the\s+)?(?:form|field)\b/i,
    /\bsubmit\s+(?:the\s+)?(?:form|application)\b/i,
    /\buse\s+(?:the\s+)?website\b/i,
    /\buse\s+(?:the\s+)?web\s+browser\b/i,
    /\bfrom\s+(?:the\s+)?website\b/i,
    /\bon\s+(?:the\s+)?website\b/i,
  ];

  return (
    interactiveUrlPattern.test(value) ||
    interactivePhrases.some((pattern) => pattern.test(value))
  );
}

function hasResearchBrowserIntent(text = "") {
  const value = cleanText(text).toLowerCase();

  if (!value) return false;

  /*
   * SOURCE-OF-TRUTH RULE
   *
   * Route requests to a live research/execution source whenever the answer
   * depends on changing external information. Importantly, the user does NOT
   * have to say "search", "look up", or "latest". Natural requests such as
   * "Ernakulam Bangalore express timing" must be recognized too.
   */
  const freshCue =
    /\b(today|tonight|right\s+now|currently|current|latest|live|just\s+now|this\s+morning|this\s+afternoon|this\s+evening|this\s+week|this\s+weekend|happening|recent|recently|just\s+announced|as\s+of\s+today)\b/i.test(
      value
    );

  const researchVerb =
    /\b(research|investigate|look\s+up|find|compare|check|verify|browse|search|confirm|tell\s+me\s+about|do\s+you\s+know\s+anything\s+about|what\s+is\s+happening|what\s+happened|who\s+is\s+playing|when\s+is|where\s+is)\b/i.test(
      value
    );

  const currentDomain =
    /\b(odi|one[-\s]?day\s+international|t20|test\s+match|cricket|football|soccer|tennis|sports?|score|scores|match|matches|game|games|stadium|tournament|fixture|fixtures|event|events|concert|news|latest|current|flight|flights|train|trains|railway|rail|express|hotel|hotels|restaurant|restaurants|price|prices|product|products|job|jobs|visa|passport|travel|trip|ticket|tickets|company|companies|startup|startups|official\s+website|application\s+deadline)\b/i.test(
      value
    );

  /*
   * INFORMATION-SHAPED REQUESTS are live research even without words such as
   * "latest". This is the key routing fix for schedules, timings, fares,
   * routes, availability and status queries.
   */
  const liveInfoShape =
    /\b(schedule|schedules|timing|timings|departure|departures|arrival|arrivals|arrive|depart|route|routes|platform|fare|fares|duration|status|running|runs|operating|availability|available|booking|bookings|reservation|reservations|opening\s+hours|hours|showtimes|showtime|fixture|fixtures|result|results|score|scores|price|prices)\b/i.test(
      value
    );

  const travelObject =
    /\b(train|trains|railway|rail|express|flight|flights|bus|buses|metro|cab|taxi|hotel|hotels|airport|station|travel|trip|ticket|tickets)\b/i.test(
      value
    );

  const eventObject =
    /\b(odi|t20|test\s+match|cricket|football|soccer|tennis|match|matches|game|games|tournament|fixture|fixtures|concert|event|events|stadium)\b/i.test(
      value
    );

  const transactionalResearch =
    /\b(under\s*[₹$€£]?\s*[\d,]+|below\s*[₹$€£]?\s*[\d,]+|cheapest|best\s+options|current\s+price|available\s+now|this\s+week|next\s+week|next\s+month|today|tonight|this\s+weekend)\b/i.test(
      value
    );

  /*
   * Weather and time have deterministic source handlers elsewhere in Fetch.
   * Never steal those requests for generic web research.
   */
  const deterministicSourceRequest =
    /\b(weather|temperature|forecast|rain|raining|humidity|wind|sunrise|sunset|time|timezone|what\s+time\s+is\s+it)\b/i.test(
      value
    );

  if (deterministicSourceRequest) return false;

  return Boolean(
    /* Explicit current/recent domain request. */
    (freshCue && currentDomain) ||
    /* Research verb + a current domain. */
    (researchVerb && currentDomain) ||
    /* Explicit web research language. */
    (researchVerb && /\b(on|online|web|internet|website)\b/i.test(value)) ||
    /* Travel/event information request, even without an explicit research verb. */
    (liveInfoShape && (travelObject || eventObject)) ||
    /* A known current domain plus an information-shaped request. */
    (currentDomain && liveInfoShape) ||
    /* Strong transactional/current-data phrases. */
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
    conversation_history:
      Array.isArray(context?.conversation_history)
        ? context.conversation_history.slice(-10)
        : [],
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

    const workerSuccess =
      data?.success === true ||
      data?.ok === true ||
      data?.status === "completed";

    return {
      ...(data || {}),
      success: workerSuccess,
      status:
        data?.status ||
        (workerSuccess ? "completed" : "failed"),
      result:
        data?.result ??
        data?.message ??
        null,
      message:
        data?.message ||
        (typeof data?.result === "string" ? data.result : null) ||
        (workerSuccess
          ? "Browser task completed."
          : "Browser worker did not complete the task."),
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


/*
 * GEMINI EVIDENCE SYNTHESIS — FREE-TIER SAFE MODE
 *
 * IMPORTANT:
 * Gemini is NOT used here as an independent source of current facts.
 * The free API tier must not be treated as a live-web research source.
 * Instead, Browser Agent supplies the fresh web evidence first, and Gemini
 * may optionally turn that evidence into a cleaner Fetch response.
 * If Gemini is unavailable, Fetch returns the Browser Agent result unchanged.
 */
async function executeGeminiEvidenceSynthesis({ task, browserExecution, context = {} } = {}) {
  const apiKey = cleanText(process.env.GEMINI_API_KEY);
  if (!apiKey) {
    return { success: false, status: "gemini_not_configured", execution_type: "gemini_evidence_synthesis" };
  }

  const model = cleanText(process.env.FETCH_GEMINI_MODEL) || "gemini-3.5-flash-lite";
  const question = cleanText(task?.user_request || task?.goal || task?.objective);
  const evidence = cleanText(
    browserExecution?.result ||
    browserExecution?.message ||
    browserExecution?.answer ||
    browserExecution?.text ||
    ""
  );

  if (!question || !evidence) {
    return { success: false, status: "insufficient_evidence", execution_type: "gemini_evidence_synthesis" };
  }

  const prompt = [
    "You are Fetch's response editor.",
    "Use ONLY the browser evidence supplied below for current/fresh facts.",
    "Do not add facts from your own memory.",
    "Do not invent or alter dates, scores, prices, locations, schedules, or names.",
    "If the evidence is incomplete, say that clearly.",
    "Answer the user's question directly and concisely.",
    `User request: ${question}`,
    `Browser evidence:\n${evidence}`,
  ].join("\n\n");

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 900 },
        }),
      }
    );

    const raw = await response.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }

    if (!response.ok) {
      return {
        success: false,
        status: "gemini_error",
        execution_type: "gemini_evidence_synthesis",
        message: typeof data === "string" ? data : data?.error?.message || `Gemini returned HTTP ${response.status}.`,
      };
    }

    const answer = (Array.isArray(data?.candidates?.[0]?.content?.parts) ? data.candidates[0].content.parts : [])
      .map((part) => cleanText(part?.text))
      .filter(Boolean)
      .join("\n")
      .trim();

    if (!answer) {
      return { success: false, status: "gemini_empty_response", execution_type: "gemini_evidence_synthesis" };
    }

    return {
      success: true,
      status: "completed",
      execution_type: "gemini_evidence_synthesis",
      model,
      result: answer,
      message: answer,
      based_on_browser_evidence: true,
    };
  } catch (error) {
    console.error("FETCH GEMINI EVIDENCE SYNTHESIS ERROR:", error);
    return {
      success: false,
      status: "gemini_unreachable",
      execution_type: "gemini_evidence_synthesis",
    };
  }
}

/*
 * CLAUDE LIVE RESEARCH FALLBACK
 *
 * Browser Agent remains first. Claude is only called when Browser Agent
 * cannot complete a fresh-information request. This preserves the user's
 * remaining Claude credits instead of using Claude for normal traffic.
 */
async function executeClaudeLiveResearchFallback({ text, context = {}, connectorFailure = null } = {}) {
  const apiKey = cleanText(process.env.ANTHROPIC_API_KEY);
  if (!apiKey || !cleanText(text)) {
    return { success: false, status: "not_configured", execution_type: "claude_web_research" };
  }

  const model = cleanText(process.env.FETCH_RESEARCH_MODEL) || "claude-sonnet-5";
  const prompt = [
    "You are Fetch's live-information fallback.",
    `User request: ${cleanText(text)}`,
    connectorFailure ? `Browser connector status: ${cleanText(connectorFailure)}` : "",
    "Use web search for current or changing information.",
    "Prefer primary and authoritative sources.",
    "Do not invent facts, schedules, prices, scores, availability, or sources.",
    "Answer concisely and include a short Sources section when citations are available.",
  ].filter(Boolean).join("\n\n");

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1200,
        messages: [{ role: "user", content: prompt }],
        tools: [{
          type: "web_search_20260318",
          name: "web_search",
          max_uses: 4,
          allowed_callers: ["direct"],
        }],
      }),
    });

    const raw = await response.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = { raw }; }

    if (!response.ok) {
      return {
        success: false,
        status: "claude_error",
        execution_type: "claude_web_research",
        message: data?.error?.message || `Claude returned HTTP ${response.status}.`,
      };
    }

    const blocks = Array.isArray(data?.content) ? data.content : [];
    const answer = blocks.filter((b) => b?.type === "text").map((b) => cleanText(b.text)).filter(Boolean).join("\n\n").trim();
    const citations = [];
    const seen = new Set();
    for (const block of blocks) {
      for (const citation of Array.isArray(block?.citations) ? block.citations : []) {
        if (!citation?.url || seen.has(citation.url)) continue;
        seen.add(citation.url);
        citations.push({ url: citation.url, title: citation.title || "Web source" });
      }
    }

    if (!answer) return { success: false, status: "empty_research_result", execution_type: "claude_web_research" };
    return { success: true, status: "completed", execution_type: "claude_web_research", model, result: answer, message: answer, citations };
  } catch (error) {
    console.error("FETCH CLAUDE LIVE RESEARCH ERROR:", error);
    return { success: false, status: "claude_unreachable", execution_type: "claude_web_research" };
  }
}



/*
 * LIGHTWEIGHT LIVE RESEARCH FALLBACK
 *
 * Simple current-information questions should not require Chromium.
 * The Browser Worker remains the computer-use executor, but this lightweight
 * path can retrieve public search results directly from DuckDuckGo HTML.
 * It is intentionally read-only and does not claim that a search result is
 * an authoritative source. Browser Agent remains the fallback for tasks that
 * require actual website interaction.
 */
function decodeHtmlEntities(value = "") {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, "/")
    .replace(/\s+/g, " ")
    .trim();
}

function stripHtml(value = "") {
  return decodeHtmlEntities(
    String(value || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  );
}

function parseDuckDuckGoResults(html = "") {
  const results = [];
  const source = String(html || "");

  const blocks = source.match(/<div[^>]+class=["'][^"']*result[^"']*["'][\s\S]*?<\/div>\s*<\/div>/gi) || [];

  for (const block of blocks) {
    const linkMatch = block.match(/<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;

    const rawUrl = decodeHtmlEntities(linkMatch[1]);
    const title = stripHtml(linkMatch[2]);
    const snippetMatch = block.match(/<a[^>]+class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/a>/i) ||
      block.match(/<div[^>]+class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);

    let url = rawUrl;
    try {
      const parsed = new URL(rawUrl, "https://html.duckduckgo.com");
      const uddg = parsed.searchParams.get("uddg");
      if (uddg) url = uddg;
    } catch {}

    if (!title || !url) continue;

    results.push({
      title: title.slice(0, 240),
      url,
      snippet: stripHtml(snippetMatch?.[1] || "").slice(0, 500),
    });

    if (results.length >= 8) break;
  }

  return results;
}

function parseRssItems(xml = "") {
  const source = String(xml || "");
  const items = [];
  const blocks = source.match(/<item\\b[\\s\\S]*?<\\/item>/gi) || [];

  function tag(block, name) {
    const match = block.match(new RegExp("<" + name + "(?:\\\\s[^>]*)?>([\\\\s\\\\S]*?)<\\/" + name + ">", "i"));
    if (!match) return "";
    return decodeHtmlEntities(
      String(match[1] || "")
        .replace(/<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>/gi, "$1")
        .replace(/<[^>]+>/g, " ")
        .replace(/\\s+/g, " ")
        .trim()
    );
  }

  for (const block of blocks) {
    const title = tag(block, "title");
    const link = tag(block, "link") || tag(block, "guid");
    const description = tag(block, "description");
    const pubDate = tag(block, "pubDate");

    if (!title || !link || !/^https?:\\/\\//i.test(link)) continue;

    items.push({
      title: title.slice(0, 240),
      url: link,
      snippet: description.slice(0, 500),
      published_at: pubDate || null,
    });

    if (items.length >= 8) break;
  }

  return items;
}

async function fetchResearchFeed(url, headers) {
  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      console.error("FETCH RESEARCH FEED HTTP:", response.status, url);
      return [];
    }

    const xml = await response.text();
    return parseRssItems(xml);
  } catch (error) {
    console.error("FETCH RESEARCH FEED ERROR:", error);
    return [];
  }
}

async function executeLightweightLiveResearch({ text } = {}) {
  const question = cleanText(text);
  if (!question) {
    return { success: false, status: "empty_query", execution_type: "live_research" };
  }

  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
    Accept: "application/rss+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.8",
    "Accept-Language": "en-IN,en;q=0.9",
  };

  try {
    /*
     * Provider 1: Google News RSS.
     * This is deliberately used as a feed, not scraped HTML, so bot-check
     * pages and layout changes cannot masquerade as evidence.
     */
    const googleUrl =
      "https://news.google.com/rss/search?q=" +
      encodeURIComponent(question) +
      "&hl=en-IN&gl=IN&ceid=IN:en";

    let results = await fetchResearchFeed(googleUrl, headers);

    /*
     * Provider 2: Bing News RSS.
     * Keep a second independent feed because public search providers can
     * occasionally rate-limit a Vercel region.
     */
    if (!results.length) {
      const bingUrl =
        "https://www.bing.com/news/search?q=" +
        encodeURIComponent(question) +
        "&format=rss";

      results = await fetchResearchFeed(bingUrl, headers);
    }

    /*
     * Provider 3: DuckDuckGo HTML remains a fallback for non-news research.
     * It is only accepted when actual result links parse successfully.
     */
    if (!results.length) {
      const ddgHeaders = {
        ...headers,
        Referer: "https://html.duckduckgo.com/",
      };

      let response = await fetch(
        "https://html.duckduckgo.com/html/",
        {
          method: "POST",
          headers: {
            ...ddgHeaders,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ q: question, b: "" }).toString(),
          signal: AbortSignal.timeout(10000),
        }
      );

      if (!response.ok) {
        response = await fetch(
          "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(question),
          {
            method: "GET",
            headers: ddgHeaders,
            signal: AbortSignal.timeout(8000),
          }
        );
      }

      if (response.ok) {
        const html = await response.text();

        if (!/g-recaptcha|are you a human|id=["']challenge-form["']|name=["']challenge["']/i.test(html)) {
          results = parseDuckDuckGoResults(html);
        }
      }
    }

    if (!results.length) {
      return {
        success: false,
        status: "research_source_unavailable",
        execution_type: "live_research",
      };
    }

    const evidence = [
      `Live search results for: ${question}`,
      ...results.map(
        (item, index) =>
          `${index + 1}. ${item.title}` +
          (item.published_at ? `\\nPublished: ${item.published_at}` : "") +
          `\\n${item.snippet || "No snippet available."}` +
          `\\nSource: ${item.url}`
      ),
    ].join("\\n\\n");

    return {
      success: true,
      status: "completed",
      execution_type: "live_research",
      source: results[0]?.published_at ? "news_rss" : "public_search",
      result: evidence,
      sources: results.map((item) => ({
        url: item.url,
        title: item.title,
        published_at: item.published_at || null,
      })),
    };
  } catch (error) {
    console.error("FETCH LIGHTWEIGHT RESEARCH ERROR:", error);
    return {
      success: false,
      status: "research_source_unavailable",
      execution_type: "live_research",
    };
  }
}

function buildForcedBrowserRoute() {
  if (!BROWSER_WORKER_URL) return null;
  const endpoint = BROWSER_WORKER_URL.replace(/\/+$/, "");
  return {
    route_type: "universal",
    capability: "browser_agent",
    status: "matched",
    resource_type: "browser_agent",
    resource_id: "builtin-fetch-browser-agent",
    resource_key: "builtin:fetch:browser-agent",
    display_name: "Fetch Browser Agent",
    endpoint,
    resource: {
      id: "builtin-fetch-browser-agent",
      resource_key: "builtin:fetch:browser-agent",
      resource_type: "browser_agent",
      display_name: "Fetch Browser Agent",
      status: "available",
      capabilities: ["browser_agent", "web_browser", "computer_use", "*"],
      endpoint,
      metadata: {
        provider: "fetch",
        mode: "external_worker",
        auth: BROWSER_WORKER_TOKEN ? "bearer" : "none",
      },
    },
  };
}

function isFreshResearchRequest(text = "") {
  /*
   * "Fresh research" is read-only information retrieval.
   * Interactive website tasks must go to the Browser Agent.
   */
  return hasResearchBrowserIntent(text) && !hasExplicitBrowserIntent(text);
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
   * RESEARCH FAST PATH
   *
   * Live read-only research has no dependency on customer memory,
   * conversation persistence, workflow persistence, ATC, or Supabase.
   * Resolve it before V9 so a missing database credential can never
   * prevent Fetch from answering a simple research question.
   */
  if (isFreshResearchRequest(receivedText)) {
    const lightweight = await executeLightweightLiveResearch({
      text: receivedText,
    });

    if (lightweight.success) {
      return {
        version: "universal-task-v8",
        status: "completed",
        evidence_source: "public_search",
        workflow_id: null,
        task: {
          contract_version: "fetch-task-v1",
          task_id: "research-direct",
          user_request: receivedText,
          goal: receivedText,
          objective: receivedText,
          execution_network: "digital_agent",
          status: "completed",
          resource: {
            type: "live_research",
            id: null,
            name: "Fetch Live Research",
          },
          result: lightweight.result,
        },
        tasks: [],
        fetch: null,
        atc: {
          resource_type: "live_research",
          research_route: "direct_public_search",
        },
        execution: lightweight,
      };
    }

    return {
      version: "universal-task-v8",
      status: "execution_failed",
      evidence_source: "none",
      workflow_id: null,
      task: {
        contract_version: "fetch-task-v1",
        task_id: "research-direct",
        user_request: receivedText,
        goal: receivedText,
        objective: receivedText,
        execution_network: "digital_agent",
        status: "execution_failed",
        resource: {
          type: "live_research",
          id: null,
          name: "Fetch Live Research",
        },
        result: null,
      },
      tasks: [],
      fetch: null,
      atc: {
        resource_type: "live_research",
        research_route: "direct_public_search",
      },
      execution: {
        success: false,
        status: lightweight?.status || "research_source_unavailable",
        execution_type: "live_research",
        message: "Fetch could not retrieve reliable public search results for this request.",
      },
    };
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
   * V9 may classify an explicit website request as a conversational
   * digital-agent task. Correct that at the Universal Execution boundary
   * so ATC receives the right execution network without changing the
   * general conversation behavior.
   */
  readyTask = applyBrowserIntentOverride(
    readyTask,
    receivedText
  );

  if (!readyTask && shouldUseBrowserForRequest(receivedText)) {
    /*
     * V9 is still the intelligence layer, but live research is an execution
     * capability. If V9 does not emit a ready task for a clear live-data
     * request, create a minimal universal browser task rather than asking the
     * user to repeat a perfectly valid request.
     */
    readyTask = {
      contract_version: "fetch-task-v1",
      task_id: `${v9?.workflow_id || "fetch"}-research-1`,
      workflow_id: v9?.workflow_id || null,
      parent_task_id: activeTaskId || null,
      customer_id: customerId,
      conversation_id: conversationId,
      channel,
      user_request: receivedText,
      intent: { domain: "live_research", action: "research", goal: receivedText },
      goal: receivedText,
      objective: receivedText,
      domain: "live_research",
      priority: "normal",
      requires_confirmation: false,
      workflow: { step_key: "research", step_type: "research", step_index: 0, total_steps: 1, execution_mode: "discover" },
      current_step: "research",
      execution_network: "browser_agent",
      resource: { type: "browser_agent", id: null, provider_id: null, name: "Fetch Browser Agent" },
      status: "ready_for_atc",
      result: null,
      entities: {},
      memory: suppliedContext?.memory || {},
      metadata: { source: "universal-browser-fallback", routing_override: "v7_explicit_browser_fallback_task", build: FETCH_UNIVERSAL_BUILD },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    tasks.push(readyTask);
  }

  if (!readyTask) {
    return {
      version: "universal-task-v7",
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

  /*
   * IMPORTANT ROUTING ORDER:
   * Fresh research is read-only and must not touch the ATC/Supabase router.
   * The ATC router requires SUPABASE_SECRET_KEY for resource selection.
   * Research should therefore resolve before ATC.
   */
  let route = null;

  if (!isFreshResearchRequest(receivedText)) {
    route = await routeFetchTask({
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
    });
  }

  /*
   * RESEARCH-FIRST GUARDRAIL — V7
   *
   * Plain live-information questions are read-only research, not browser
   * interaction. Resolve them through the lightweight public-search path
   * BEFORE ATC/browser execution. This prevents a Gemini quota error or an
   * ATC classification from accidentally booting Chromium for a question
   * such as "Ernakulam Bangalore express timings".
   *
   * Browser Agent is reserved for explicit website interaction.
   * Physical commerce remains owned by the existing physical engine.
   */
  if (
    isFreshResearchRequest(receivedText) &&
    readyTask.execution_network !== "physical_network" &&
    readyTask.resource?.type !== "partner_store"
  ) {
    const lightweight = await executeLightweightLiveResearch({
      text: receivedText,
    });

    if (lightweight.success) {
      const gemini = await executeGeminiEvidenceSynthesis({
        task: readyTask,
        browserExecution: lightweight,
        context: {
          conversation_history: suppliedContext?.conversation_history || [],
        },
      });

      const sourceBlock =
        lightweight.sources?.length
          ? `\n\nSources:\n${lightweight.sources
              .slice(0, 6)
              .map((item) => `• ${item.title} — ${item.url}`)
              .join("\n")}`
          : "";

      const finalResult =
        (gemini.success ? gemini.result : lightweight.result || lightweight.message || "") +
        sourceBlock;

      return {
        version: "universal-task-v7",
        status: "completed",
        evidence_source: "public_search",
        workflow_id: v9?.workflow_id || null,
        task: {
          ...readyTask,
          status: "completed",
          resource: {
            ...readyTask.resource,
            type: gemini.success ? "gemini_evidence_synthesis" : "live_research",
            id: null,
            name: gemini.success ? "Gemini Evidence Synthesis" : "Fetch Live Research",
          },
          result: finalResult,
        },
        tasks,
        fetch: v9,
        atc: {
          ...(route || {}),
          resource_type: gemini.success ? "gemini_evidence_synthesis" : "live_research",
          research_route: "public_search",
        },
        execution: {
          success: true,
          status: "completed",
          execution_type: "live_research",
          research: lightweight,
          gemini: gemini.success ? gemini : null,
        },
      };
    }

    /*
     * Plain research must not continue to Browser Agent. If the web source
     * is unavailable, return a controlled research failure. The customer-
     * facing web API can then present a truthful unavailable message.
     */
    return {
      version: "universal-task-v7",
      status: "execution_failed",
      evidence_source: "none",
      workflow_id: v9?.workflow_id || null,
      task: {
        ...readyTask,
        status: "execution_failed",
        resource: {
          ...readyTask.resource,
          type: "live_research",
          id: null,
          name: "Fetch Live Research",
        },
        result: null,
      },
      tasks,
      fetch: v9,
      atc: route || null,
      execution: {
        success: false,
        status: lightweight?.status || "research_sources_unavailable",
        execution_type: "live_research",
        message: "Fetch could not retrieve reliable public search results for this request.",
      },
    };
  }

  if (!route || route.status !== "matched") {
    return {
      version: "universal-task-v7",
      status:
        route?.status ||
        "awaiting_resource",
      workflow_id: v9?.workflow_id || null,
      task: readyTask,
      tasks,
      fetch: v9,
      atc: route || null,
      execution: null,
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
    /*
     * Defensive research branch. V7 normally resolves plain research before
     * ATC reaches this browser executor. Keep this guard so an explicit
     * browser request is never mistaken for a research-only request.
     */
    if (isFreshResearchRequest(receivedText) && !hasExplicitBrowserIntent(receivedText)) {
      const lightweight = await executeLightweightLiveResearch({
        text: receivedText,
      });

      if (lightweight.success) {
        const gemini = await executeGeminiEvidenceSynthesis({
          task: readyTask,
          browserExecution: lightweight,
          context: { conversation_history: suppliedContext?.conversation_history || [] },
        });

        const sourceBlock =
          gemini.success && lightweight.sources?.length
            ? `\n\nSources:\n${lightweight.sources
                .slice(0, 4)
                .map((item) => `• ${item.title} — ${item.url}`)
                .join("\n")}`
            : "";

        const finalResult = gemini.success
          ? gemini.result + sourceBlock
          : lightweight.result || lightweight.message || null;

        return {
          version: "universal-task-v7",
          status: "completed",
          evidence_source: "public_search",
          workflow_id: v9?.workflow_id || null,
          task: {
            ...readyTask,
            status: "completed",
            resource: {
              ...readyTask.resource,
              type: gemini.success ? "gemini_evidence_synthesis" : "live_research",
              id: null,
              name: gemini.success ? "Gemini Evidence Synthesis" : "Fetch Live Research",
            },
            result: finalResult,
          },
          tasks,
          fetch: v9,
          atc: route,
          execution: buildExecutionResult({
            task: readyTask,
            route: { ...route, resource_type: gemini.success ? "gemini_evidence_synthesis" : "live_research" },
            execution: gemini.success ? { research: lightweight, gemini } : lightweight,
          }),
        };
      }
    }

    /*
     * Web channel: research requests must never boot the Browser worker.
     * The customer-facing API sets skip_browser_for_research and handles
     * this "no evidence" outcome itself.
     */
    if (
      suppliedContext?.skip_browser_for_research &&
      isFreshResearchRequest(receivedText)
    ) {
      return {
        version: "universal-task-v7",
        status: "execution_failed",
        workflow_id: v9?.workflow_id || null,
        task: { ...readyTask, status: "execution_failed", result: null },
        tasks,
        fetch: v9,
        atc: route,
        execution: buildExecutionResult({
          task: readyTask,
          route,
          execution: { success: false, status: "research_sources_unavailable" },
        }),
      };
    }

    const execution =
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
          conversation_history:
            Array.isArray(suppliedContext?.conversation_history)
              ? suppliedContext.conversation_history
              : [],
        },
      });

    if (execution?.success) {
      const gemini = await executeGeminiEvidenceSynthesis({
        task: readyTask,
        browserExecution: execution,
        context: { conversation_history: suppliedContext?.conversation_history || [] },
      });

      const finalResult = gemini.success
        ? gemini.result
        : execution?.result || execution?.message || null;

      return {
        version: "universal-task-v7",
        status: "completed",
        workflow_id: v9?.workflow_id || null,
        task: {
          ...readyTask,
          status: "completed",
          resource: {
            ...readyTask.resource,
            type: gemini.success ? "gemini_evidence_synthesis" : "browser_agent",
            id: route.resource_id || null,
            name: gemini.success ? "Gemini Evidence Synthesis" : (route.display_name || route.resource?.display_name || "Fetch Browser Agent"),
          },
          result: finalResult,
        },
        tasks,
        fetch: v9,
        atc: route,
        execution: buildExecutionResult({
          task: readyTask,
          route: { ...route, resource_type: gemini.success ? "gemini_evidence_synthesis" : "browser_agent" },
          execution: gemini.success ? { browser: execution, gemini } : execution,
        }),
      };
    }

    /*
     * Claude fallback is OFF unless you set FETCH_ENABLE_CLAUDE_FALLBACK=true
     * in Vercel. This stops it spending Anthropic credits by surprise.
     */
    const claude =
      process.env.FETCH_ENABLE_CLAUDE_FALLBACK === "true"
        ? await executeClaudeLiveResearchFallback({
            text: receivedText,
            context: suppliedContext,
            connectorFailure: execution?.status || "browser_execution_failed",
          })
        : { success: false, status: "disabled", execution_type: "claude_web_research" };

    if (claude.success) {
      return {
        version: "universal-task-v7",
        status: "completed",
        workflow_id: v9?.workflow_id || null,
        task: {
          ...readyTask,
          status: "completed",
          resource: { ...readyTask.resource, type: "claude_web_research", id: null, name: "Claude Live Research Fallback" },
          result: claude.result || claude.message || null,
        },
        tasks,
        fetch: v9,
        atc: route,
        execution: buildExecutionResult({
          task: readyTask,
          route: { ...route, resource_type: "claude_web_research" },
          execution: { browser: execution, claude },
        }),
      };
    }

    return {
      version: "universal-task-v7",
      status: "execution_failed",
      workflow_id: v9?.workflow_id || null,
      task: {
        ...readyTask,
        status: "execution_failed",
        resource: { ...readyTask.resource, type: "browser_agent" },
        result: "Live research is temporarily unavailable because Fetch could not verify the latest information from its connected research sources.",
      },
      tasks,
      fetch: v9,
      atc: route,
      execution: buildExecutionResult({ task: readyTask, route, execution: { browser: execution, claude } }),
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
      version: "universal-task-v7",
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
      version: "universal-task-v7",
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
    version: "universal-task-v7",
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
