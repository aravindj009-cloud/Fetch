/* FETCH WEB AGENT — PHYSICAL WEB BRIDGE
 *
 * Purpose:
 * - Provide the customer-facing web API for Fetch.
 * - Let the Universal Task Engine understand the request first.
 * - When the request is physical, hand it to the existing physical
 *   order engine instead of returning needs_clarification.
 * - Preserve the existing ATC -> partner store -> customer approval ->
 *   shopper flow.
 *
 * IMPORTANT:
 * - This file does NOT replace fetch-universal-execution.mjs.
 * - This file does NOT replace fetch-v9.mjs.
 * - This file does NOT contain fake product prices.
 * - The partner store supplies the real price/availability.
 */

import { executeUniversalFetchRequest } from "../../lib/fetch-universal-execution.mjs";
import { executeDigitalAgent } from "../../lib/fetch-digital-agent.mjs";

let physicalOrderModulePromise = null;

async function getPhysicalOrderModule() {
  if (!physicalOrderModulePromise) {
    physicalOrderModulePromise = import("../whatsapp/webhook.mjs");
  }
  return physicalOrderModulePromise;
}

const FETCH_BUILD = "2026-09-28-LIVE-RESEARCH-V7";
const ALLOWED_ORIGINS = new Set([
  "https://tryfetch.in",
  "https://www.tryfetch.in",
]);

function cleanText(value) {
  if (value == null) return "";

  if (typeof value === "string") {
    const text = value.trim();
    return /^\[object Object\]$/i.test(text) ? "" : text;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => cleanText(item))
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  if (typeof value === "object") {
    const preferredKeys = [
      "text",
      "content",
      "message",
      "result",
      "answer",
      "output",
      "response",
      "summary",
    ];

    for (const key of preferredKeys) {
      if (value[key] === value) continue;
      const preferred = cleanText(value[key]);
      if (preferred) return preferred;
    }

    try {
      return JSON.stringify(value, null, 2).trim();
    } catch {
      return "";
    }
  }

  return String(value).trim();
}

function findResponseText(payload) {
  const seen = new Set();
  const preferredKeys = [
    "message",
    "text",
    "answer",
    "result",
    "output",
    "response",
    "summary",
    "content",
  ];

  function visit(value, depth = 0) {
    if (value == null || depth > 10) return "";

    if (typeof value === "string") {
      const text = value.trim();
      return /^\[object Object\]$/i.test(text) ? "" : text;
    }

    if (typeof value !== "object") return "";

    if (seen.has(value)) return "";
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item, depth + 1);
        if (found) return found;
      }
      return "";
    }

    for (const key of preferredKeys) {
      const found = visit(value[key], depth + 1);
      if (found) return found;
    }

    return "";
  }

  return visit(payload);
}

/* =========================================================
   GEMINI QUOTA HANDLING

   Google Search grounding is not available on the Gemini API free
   tier. When Gemini answers 429 we remember it for a while (per warm
   serverless instance) and stop sending doomed requests on every
   message.
========================================================= */
class QuotaError extends Error {
  constructor(message, retryAfterMs = null) {
    super(message);
    this.name = "QuotaError";
    this.retryAfterMs = retryAfterMs;
  }
}

let geminiGroundingBlockedUntil = 0;

function parseRetryDelayMs(raw) {
  const match = String(raw).match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  return match ? Math.ceil(Number(match[1]) * 1000) : null;
}


/* =========================================================
   SOURCE-OF-TRUTH EXECUTORS

   These are deterministic source adapters. They run before the
   generic conversational agent for domains where "current" data
   must come from an actual source rather than model memory.
========================================================= */

function normalizeCitations(value) {
  const items = Array.isArray(value) ? value : [];
  const seen = new Set();

  return items
    .map((item) => {
      if (typeof item === "string") {
        return { title: item, url: item };
      }

      if (!item || typeof item !== "object") return null;

      const url =
        cleanText(item.url) ||
        cleanText(item.link) ||
        cleanText(item.source_url) ||
        cleanText(item.uri);

      if (!url || !/^https?:\/\//i.test(url) || seen.has(url)) return null;
      seen.add(url);

      return {
        title:
          cleanText(item.title) ||
          cleanText(item.name) ||
          url,
        url,
      };
    })
    .filter(Boolean)
    .slice(0, 10);
}

function getConversationHistory(body) {
  return Array.isArray(body?.conversationHistory)
    ? body.conversationHistory
        .slice(-10)
        .map((message) => ({
          role: message?.role === "assistant" ? "assistant" : "user",
          content: String(message?.content || "").slice(0, 4000),
        }))
    : [];
}

function buildEffectiveRequestText(text, history) {
  const current = cleanText(text);
  if (!current) return current;

  const lower = current.toLowerCase();
  const looksLikeLocationFollowUp =
    /^(?:in|at|near|around)\s+.+$/i.test(current) ||
    /^(?:trivandrum|thiruvananthapuram|kochi|bangalore|bengaluru|chennai|mumbai|delhi|hyderabad|pune|kolkata|goa|new york|london|tokyo|dubai)$/i.test(current);

  if (!looksLikeLocationFollowUp) return current;

  const previousUserMessages = history
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .filter(Boolean);

  const previousAssistantMessages = history
    .filter((message) => message.role === "assistant")
    .map((message) => message.content)
    .filter(Boolean);

  const weatherContext = [...previousUserMessages, ...previousAssistantMessages]
    .some((value) => /\b(weather|temperature|forecast|rain|rainfall|humidity|wind)\b/i.test(value));

  if (weatherContext) {
    return `What is the weather today ${current}?`;
  }

  return current;
}

function isWeatherRequest(text = "") {
  return /\b(weather|temperature|forecast|rainfall|rain|humidity|wind speed|wind)\b/i.test(
    cleanText(text)
  );
}

function extractWeatherLocation(text = "") {
  const value = cleanText(text);
  const match = value.match(/\b(?:in|at|near|around)\s+([^,?.!]+?)(?:\s+(?:today|now|tonight|tomorrow|currently)\b|[,?.!]|$)/i);
  if (match?.[1]) return cleanText(match[1]);

  const standalone = value.match(/\b(?:trivandrum|thiruvananthapuram|kochi|cochin|bangalore|bengaluru|chennai|mumbai|delhi|new delhi|hyderabad|pune|kolkata|goa|tokyo|london|dubai|new york)\b/i);
  return standalone?.[0] ? cleanText(standalone[0]) : null;
}

async function geocodeWeatherLocation(location) {
  const query = cleanText(location);
  if (!query) return null;

  const response = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=5&language=en&format=json`
  );

  if (!response.ok) {
    throw new Error(`Weather geocoding failed (${response.status})`);
  }

  const data = await response.json();
  const results = Array.isArray(data?.results) ? data.results : [];
  if (!results.length) return null;

  const preferred =
    results.find((item) =>
      /india/i.test(`${item?.country || ""} ${item?.country_code || ""}`)
    ) || results[0];

  return {
    latitude: Number(preferred.latitude),
    longitude: Number(preferred.longitude),
    name: preferred.name || query,
    country: preferred.country || "",
    timezone: preferred.timezone || "auto",
  };
}

function weatherDescription(code) {
  const map = {
    0: "Clear sky",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Fog",
    48: "Depositing rime fog",
    51: "Light drizzle",
    53: "Moderate drizzle",
    55: "Dense drizzle",
    56: "Light freezing drizzle",
    57: "Dense freezing drizzle",
    61: "Slight rain",
    63: "Moderate rain",
    65: "Heavy rain",
    66: "Light freezing rain",
    67: "Heavy freezing rain",
    71: "Slight snow",
    73: "Moderate snow",
    75: "Heavy snow",
    77: "Snow grains",
    80: "Slight rain showers",
    81: "Moderate rain showers",
    82: "Violent rain showers",
    85: "Slight snow showers",
    86: "Heavy snow showers",
    95: "Thunderstorm",
    96: "Thunderstorm with slight hail",
    99: "Thunderstorm with heavy hail",
  };
  return map[Number(code)] || "Current conditions unavailable";
}

async function executeWeatherSource(text) {
  const location = extractWeatherLocation(text);
  if (!location) {
    return {
      success: true,
      status: "needs_clarification",
      message: "Which city or location should I check the weather for?",
      resource_type: "weather_source",
      source: "open_meteo",
    };
  }

  const place = await geocodeWeatherLocation(location);
  if (!place) {
    return {
      success: true,
      status: "needs_clarification",
      message: `I couldn't locate "${location}". Which city or location should I check?`,
      resource_type: "weather_source",
      source: "open_meteo",
    };
  }

  const weatherResponse = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(place.latitude)}&longitude=${encodeURIComponent(place.longitude)}&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m&timezone=auto`
  );

  if (!weatherResponse.ok) {
    throw new Error(`Weather source failed (${weatherResponse.status})`);
  }

  const weather = await weatherResponse.json();
  const current = weather?.current || {};
  const units = weather?.current_units || {};

  const temperature = current.temperature_2m;
  const apparent = current.apparent_temperature;
  const humidity = current.relative_humidity_2m;
  const wind = current.wind_speed_10m;
  const description = weatherDescription(current.weather_code);

  const parts = [
    `In ${place.name}, it is ${temperature}${units.temperature_2m || "°C"} and ${description.toLowerCase()}.`,
    apparent != null ? `Feels like ${apparent}${units.apparent_temperature || "°C"}.` : "",
    humidity != null ? `Humidity is ${humidity}${units.relative_humidity_2m || "%"}.` : "",
    wind != null ? `Wind is ${wind} ${units.wind_speed_10m || "km/h"}.` : "",
  ].filter(Boolean);

  return {
    success: true,
    status: "completed",
    message: parts.join(" "),
    resource_type: "weather_source",
    execution_type: "source_of_truth",
    source: "open_meteo",
    location: place,
    current,
    units,
  };
}


function isTimeRequest(text = "") {
  return /\b(current|local|present)\s+(time|date)|\bwhat(?:'s| is)\s+the\s+(?:current\s+)?time\b|\btime\s+in\s+[a-z]/i.test(
    cleanText(text)
  );
}

function extractTimeLocation(text = "") {
  const match = cleanText(text).match(/\btime\s+(?:in|at)\s+([^,?.!]+?)(?:[,?.!]|$)/i);
  return match?.[1] ? cleanText(match[1]) : null;
}

function timezoneForLocation(location = "") {
  const value = cleanText(location).toLowerCase();
  const map = [
    [/\b(tokyo|japan)\b/i, "Asia/Tokyo"],
    [/\b(delhi|new delhi|mumbai|trivandrum|thiruvananthapuram|kochi|bangalore|bengaluru|chennai|hyderabad|pune|kolkata|india)\b/i, "Asia/Kolkata"],
    [/\b(london|uk|united kingdom)\b/i, "Europe/London"],
    [/\b(dubai|uae|abu dhabi)\b/i, "Asia/Dubai"],
    [/\b(singapore)\b/i, "Asia/Singapore"],
    [/\b(sydney|melbourne|australia)\b/i, "Australia/Sydney"],
    [/\b(new york|nyc)\b/i, "America/New_York"],
    [/\b(los angeles|la|san francisco)\b/i, "America/Los_Angeles"],
    [/\b(chicago)\b/i, "America/Chicago"],
  ];
  return map.find(([pattern]) => pattern.test(value))?.[1] || null;
}

function executeTimeSource(text) {
  const location = extractTimeLocation(text);
  const timezone = timezoneForLocation(location || "");

  if (!location || !timezone) {
    return {
      success: true,
      status: "needs_clarification",
      message: "Which city or location should I check the time for?",
      resource_type: "deterministic_clock",
      execution_type: "source_of_truth",
    };
  }

  const now = new Date();
  const time = new Intl.DateTimeFormat("en-IN", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).format(now);

  const date = new Intl.DateTimeFormat("en-IN", {
    timeZone: timezone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(now);

  return {
    success: true,
    status: "completed",
    message: `The current time in ${location} is ${time} (${date}).`,
    resource_type: "deterministic_clock",
    execution_type: "source_of_truth",
    timezone,
  };
}

function isLiveResearchRequest(text = "") {
  const value = cleanText(text);
  return /\b(latest|today|tonight|current|currently|now|recent|happening|happened|news|event|events|odi|match|matches|score|scores|schedule|schedules|timing|timings|departure|departures|arrival|arrivals|route|routes|platform|platforms|fare|fares|duration|running|status|train|trains|railway|rail|express|bus|buses|flight|flights|airport|metro|cab|taxi|hotel|hotels|travel|trip|ticket|tickets|pnr|announcement|announced|price|prices|available|availability|deadline|official|research|investigate|look\s+up|verify|check)\b/i.test(value);
}

async function executeClaudeWebResearch(text, history = []) {
  const apiKey = cleanText(process.env.ANTHROPIC_API_KEY);
  if (!apiKey) return null;

  const model = cleanText(process.env.FETCH_RESEARCH_MODEL) || "claude-sonnet-5";
  const historyText = history
    .slice(-8)
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n");

  const prompt = [
    "You are Fetch's live research fallback.",
    "Use web search for current or changing information.",
    "Answer the user's request directly and concisely.",
    "Do not claim something is current unless the web search supports it.",
    "Include the most relevant source links at the end when available.",
    historyText ? `Recent conversation:\n${historyText}` : "",
    `User request:\n${cleanText(text)}`,
  ].filter(Boolean).join("\n\n");

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1800,
      messages: [{ role: "user", content: prompt }],
      tools: [
        {
          type: "web_search_20260318",
          name: "web_search",
          max_uses: 4,
          allowed_callers: ["direct"],
          response_inclusion: "full",
        },
      ],
    }),
  });

  const raw = await response.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    console.error("FETCH CLAUDE RESEARCH ERROR:", response.status, raw.slice(0, 500));
    return null;
  }

  const textParts = Array.isArray(data?.content)
    ? data.content
        .filter((part) => part?.type === "text" && part?.text)
        .map((part) => part.text.trim())
        .filter(Boolean)
    : [];

  const answer = textParts.join("\n\n").trim();
  if (!answer) return null;

  const citations = [];
  for (const part of Array.isArray(data?.content) ? data.content : []) {
    for (const citation of Array.isArray(part?.citations) ? part.citations : []) {
      if (citation?.url && !citations.some((item) => item.url === citation.url)) {
        citations.push({
          title: citation.title || citation.url,
          url: citation.url,
        });
      }
    }
  }

  const sourceBlock = citations.length
    ? `\n\nSources:\n${citations.slice(0, 5).map((item) => `• ${item.title} — ${item.url}`).join("\n")}`
    : "";

  return {
    success: true,
    status: "completed",
    message: answer + sourceBlock,
    resource_type: "browser_agent",
    execution_type: "web_research_fallback",
    provider: "anthropic_web_search",
    model,
    citations,
  };
}


async function executeGeminiWebResearch(text, history = []) {
  const apiKey = cleanText(process.env.GEMINI_API_KEY);
  if (!apiKey) return null;

  const model = cleanText(process.env.FETCH_GEMINI_RESEARCH_MODEL) || "gemini-3.8-flash";
  const historyText = history
    .slice(-8)
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n");

  const prompt = [
    "You are Fetch, a personal AI assistant with live web research.",
    "Use Google Search grounding for this request.",
    "Answer the user's exact request using current web evidence.",
    "Prefer primary/official sources when available.",
    "For schedules, timings, prices, events, scores, availability, and other changing facts, state the relevant date/time and do not guess.",
    "If sources disagree, explain the disagreement briefly instead of inventing a value.",
    "Be concise and user-friendly. Do not mention internal tools, browser agents, bot detection, or implementation details.",
    historyText ? `Recent conversation:\n${historyText}` : "",
    `User request:\n${cleanText(text)}`,
  ].filter(Boolean).join("\n\n");

  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: prompt,
      tools: [{ type: "google_search" }],
    }),
  });

  const raw = await response.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }

  if (response.status === 429) {
    console.error("FETCH GEMINI QUOTA (429):", raw.slice(0, 500));
    throw new QuotaError("gemini_quota_exceeded", parseRetryDelayMs(raw));
  }

  if (!response.ok) {
    console.error("FETCH GEMINI RESEARCH ERROR:", response.status, raw.slice(0, 1000));
    return null;
  }

  const textParts = [];
  const citations = [];

  if (cleanText(data?.output_text)) {
    textParts.push(cleanText(data.output_text));
  }

  for (const step of Array.isArray(data?.steps) ? data.steps : []) {
    if (step?.type !== "model_output") continue;

    for (const block of Array.isArray(step?.content) ? step.content : []) {
      if (block?.type === "text" && cleanText(block?.text)) {
        textParts.push(cleanText(block.text));
      }

      for (const annotation of Array.isArray(block?.annotations) ? block.annotations : []) {
        if (annotation?.type === "url_citation" && annotation?.url) {
          if (!citations.some((item) => item.url === annotation.url)) {
            citations.push({
              title: cleanText(annotation.title) || annotation.url,
              url: annotation.url,
            });
          }
        }
      }
    }
  }

  const answer = textParts.join("\n\n").trim();
  if (!answer) return null;

  const sourceBlock = citations.length
    ? `\n\nSources:\n${citations.slice(0, 6).map((item) => `• ${item.title} — ${item.url}`).join("\n")}`
    : "";

  return {
    success: true,
    status: "completed",
    message: answer + sourceBlock,
    resource_type: "research_engine",
    execution_type: "google_search_grounded",
    provider: "gemini",
    model,
    citations,
  };
}


/* =========================================================
   GEMINI LEGACY SEARCH FALLBACK
   Some deployments can reject the Interactions endpoint while the
   GenerateContent endpoint is available. Use the same Gemini model and
   Google Search grounding through the stable GenerateContent REST API.
========================================================= */
async function executeGeminiGenerateContentResearch(text, history = []) {
  const apiKey = cleanText(process.env.GEMINI_API_KEY);
  if (!apiKey) return null;

  const model = cleanText(process.env.FETCH_GEMINI_RESEARCH_MODEL) || "gemini-3.8-flash";
  const historyText = history
    .slice(-8)
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n");

  const prompt = [
    "You are Fetch, a personal AI assistant with live web research.",
    "Use Google Search grounding and current web evidence.",
    "Answer the user's exact request directly.",
    "Prefer official or primary sources when available.",
    "For schedules, timings, prices, events, scores, availability, and other changing facts, include the relevant date/time and never guess.",
    "If evidence is insufficient, say so clearly.",
    "Do not mention internal tools, browser agents, CAPTCHAs, or implementation details.",
    historyText ? `Recent conversation:\n${historyText}` : "",
    `User request:\n${cleanText(text)}`,
  ].filter(Boolean).join("\n\n");

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
      }),
    }
  );

  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }

  if (response.status === 429) {
    console.error("FETCH GEMINI QUOTA (429):", raw.slice(0, 500));
    throw new QuotaError("gemini_quota_exceeded", parseRetryDelayMs(raw));
  }

  if (!response.ok) {
    console.error("FETCH GEMINI GENERATE CONTENT ERROR:", response.status, raw.slice(0, 1000));
    return null;
  }

  const parts = data?.candidates?.[0]?.content?.parts;
  const answer = Array.isArray(parts)
    ? parts.map((part) => cleanText(part?.text)).filter(Boolean).join("\n\n").trim()
    : "";

  if (!answer) return null;

  const citations = [];
  const chunks = data?.candidates?.[0]?.groundingMetadata?.groundingChunks;
  for (const chunk of Array.isArray(chunks) ? chunks : []) {
    const web = chunk?.web;
    if (web?.uri && !citations.some((item) => item.url === web.uri)) {
      citations.push({
        title: cleanText(web.title) || web.uri,
        url: web.uri,
      });
    }
  }

  const sourceBlock = citations.length
    ? `\n\nSources:\n${citations.slice(0, 6).map((item) => `• ${item.title} — ${item.url}`).join("\n")}`
    : "";

  return {
    success: true,
    status: "completed",
    message: answer + sourceBlock,
    resource_type: "research_engine",
    execution_type: "google_search_grounded",
    provider: "gemini_generate_content",
    model,
    citations,
  };
}

function normalizePhone(value) {
  return String(value || "").replace(/[^\d]/g, "");
}

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.has(origin)
    ? origin
    : "https://tryfetch.in";

  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function sendJson(res, status, payload, origin = "") {
  const safePayload =
    payload && typeof payload === "object"
      ? { ...payload }
      : payload;

  if (safePayload && typeof safePayload === "object") {
    const directMessage = cleanText(safePayload.message);
    const recoveredMessage = directMessage || findResponseText(safePayload);

    safePayload.message =
      recoveredMessage ||
      "I’m working on that.";

    // Never expose the poisoned JavaScript object conversion.
    if (/^\[object Object\]$/i.test(safePayload.message)) {
      safePayload.message = "I’m working on that.";
    }
  }

  res.status(status);
  res.setHeader("X-Fetch-Build", FETCH_BUILD);

  for (const [key, value] of Object.entries(corsHeaders(origin))) {
    res.setHeader(key, value);
  }

  return res.json(safePayload);
}

function isLikelyPhysicalText(value) {
  const text = cleanText(value).toLowerCase();
  if (!text) return false;

  const acquisitionVerb = /\b(buy|purchase|order|get|bring|send|deliver|delivery|shop|pick up|pickup|arrange|source|need)\b/i.test(text);
  const physicalObject = /\b(item|product|goods?|grocery|groceries|medicine|medicines|food|drink|drinks|snack|snacks|pack|packs|box|boxes|bottle|bottles|piece|pieces|unit|units|supplies|stuff)\b/i.test(text);
  const deliveryCue = /\b(deliver|delivery|delivered|my address|our address|near me|nearby|at home|to my home)\b/i.test(text);
  const quantityObjectCue = /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+[a-z][a-z0-9-]*(?:\s+[a-z][a-z0-9-]*)?\b/i.test(text);

  return Boolean(
    acquisitionVerb &&
    (physicalObject || deliveryCue || quantityObjectCue)
  );
}

function isPhysicalResult(result, requestText = "") {
  const network =
    cleanText(
      result?.task?.execution_network ||
      result?.task?.intent?.execution_network ||
      result?.fetch?.decisions?.[0]?.decision?.network ||
      result?.atc?.execution_network ||
      result?.execution?.network
    ).toLowerCase();

  const resourceType =
    cleanText(
      result?.atc?.resource_type ||
      result?.task?.resource?.type ||
      result?.execution?.resource_type
    ).toLowerCase();

  const fetchDomain =
    cleanText(
      result?.fetch?.decisions?.[0]?.intent?.domain ||
      result?.task?.domain ||
      result?.task?.intent?.domain
    ).toLowerCase();

  const sourceClass = cleanText(
    result?.task?.metadata?.source_class ||
    result?.task?.metadata?.source_policy?.source_class
  ).toLowerCase();

  return (
    network === "physical_network" ||
    resourceType === "partner_store" ||
    fetchDomain === "physical" ||
    fetchDomain === "physical_commerce" ||
    sourceClass === "physical_fulfilment" ||
    isLikelyPhysicalText(requestText)
  );
}

function extractPhysicalItems(result) {
  /*
   * Physical entities can be preserved at several layers of the
   * Universal Task response. V9 normally exposes them under
   * fetch.decisions[].entities.items, while the Universal Task Contract
   * also preserves them under task.entities and task.task_data.entities.
   *
   * We check these structured locations first so the physical web bridge
   * does not depend on one exact response shape.
   */
  const candidateLists = [
    result?.fetch?.decisions?.[0]?.entities?.items,
    result?.task?.entities?.items,
    result?.task?.task_data?.entities?.items,
    result?.tasks?.[0]?.entities?.items,
    result?.tasks?.[0]?.task_data?.entities?.items,
    result?.fetch?.context?.conversation_context?.last_entities?.items,
    result?.fetch?.context?.last_entities?.items,
    result?.fetch?.decisions?.[0]?.plan?.entities?.items,
    result?.fetch?.decisions?.[0]?.decision?.entities?.items,
  ];

  const items = [];

  function addItem(rawItem) {
    const name = cleanText(
      rawItem?.name ||
      rawItem?.item ||
      rawItem?.product ||
      rawItem?.title
    );

    const quantity = Number(
      rawItem?.quantity ??
      rawItem?.qty ??
      rawItem?.count ??
      1
    );

    if (!name) return;

    const safeQuantity =
      Number.isFinite(quantity) && quantity > 0
        ? Math.floor(quantity)
        : 1;

    const existing = items.find(
      (entry) =>
        entry.name.toLowerCase() === name.toLowerCase()
    );

    if (existing) {
      existing.quantity += safeQuantity;
    } else {
      items.push({
        name,
        quantity: safeQuantity,
      });
    }
  }

  /*
   * Use the first structured source that contains items.
   * The same entities are often copied into multiple layers, so reading
   * all layers would incorrectly double quantities.
   */
  for (const list of candidateLists) {
    if (!Array.isArray(list) || !list.length) continue;

    for (const rawItem of list) {
      addItem(rawItem);
    }

    if (items.length) break;
  }

  /*
   * Last-resort parser for simple physical requests when structured
   * entities are unexpectedly absent. This is intentionally generic.
   * It never contains a hard-coded product catalogue.
   *
   * Examples it can recover:
   *   "get me two KitKats"
   *   "I need 3 bottles of water"
   *   "deliver 2 ice packs to my address"
   *
   * V9 structured entities remain the preferred source.
   */
  if (!items.length) {
    const rawText = cleanText(
      result?.task?.user_request ||
      result?.task?.source_text ||
      result?.fetch?.received_text
    );

    const genericPatterns = [
      /\b(?:get|buy|purchase|order|bring|send|deliver|find|source|need)\s+(?:me\s+|us\s+)?(\d+)\s+(.+?)(?:\s+(?:delivered|to\s+(?:my|our)\s+address|for\s+(?:me|us)))?$/i,
      /\b(?:get|buy|purchase|order|bring|send|deliver|find|source|need)\s+(?:me\s+|us\s+)?(.+?)(?:\s+(?:delivered|to\s+(?:my|our)\s+address|for\s+(?:me|us)))?$/i,
    ];

    for (const pattern of genericPatterns) {
      const match = rawText.match(pattern);
      if (!match) continue;

      const quantity = /^\d+$/.test(match[1] || '')
        ? Number(match[1])
        : 1;
      const rawName = /^\d+$/.test(match[1] || '')
        ? match[2]
        : match[1];

      const name = cleanText(rawName)
        .replace(/\b(?:delivered|delivery|to\s+(?:my|our)\s+address|for\s+(?:me|us))\b.*$/i, '')
        .replace(/\s+/g, ' ')
        .trim();

      if (name && name.length <= 120) {
        addItem({
          name,
          quantity: Number.isFinite(quantity) && quantity > 0
            ? Math.floor(quantity)
            : 1,
        });
        break;
      }
    }
  }
  return items;
}

function formatOrderItems(items) {
  return items
    .map(
      (item) =>
        `${item.quantity} ${item.name}`
    )
    .join(", ");
}

function validCoordinates(latitude, longitude) {
  const lat = Number(latitude);
  const lon = Number(longitude);

  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180 &&
    !(lat === 0 && lon === 0)
  );
}

function syntheticWebPhone(conversationId) {
  const raw = cleanText(conversationId)
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(-12);

  /*
   * The customers.phone column is used as the customer identity by the
   * existing physical engine. A deterministic web-only identifier keeps
   * repeat requests on the same browser conversation tied to one customer.
   *
   * This is intentionally NOT presented as a real phone number.
   */
  return `web${raw || "customer"}`;
}

async function handlePhysicalWebRequest({
  result,
  text,
  conversationId,
  latitude,
  longitude,
}) {
  if (!validCoordinates(latitude, longitude)) {
    return {
      status: "needs_location",
      message:
        "Please allow location access so Fetch can find the right nearby store and calculate delivery.",
      workflow_id: result?.workflow_id || null,
      fetch: result?.fetch || null,
      atc: result?.atc || null,
      execution: result?.execution || null,
    };
  }

  const items = extractPhysicalItems(result);

  if (!items.length) {
    return {
      status: "needs_clarification",
      message:
        "I understood this as a shopping request, but I could not identify the item(s).",
      workflow_id: result?.workflow_id || null,
      fetch: result?.fetch || null,
      atc: result?.atc || null,
      execution: result?.execution || null,
    };
  }

  // Load the physical-order/WhatsApp module only when a physical
  // request actually reaches this path. This keeps digital research
  // independent of WhatsApp/Supabase server-only configuration.
  const {
    getOrCreateCustomer,
    createOrder,
    updateOrder,
    getOrderById,
    dispatchOrderToPartnerStore,
    offerOrderToShopper,
  } = await getPhysicalOrderModule();

  const phone = syntheticWebPhone(conversationId);

  const customer = await getOrCreateCustomer(phone);

  if (!customer?.id) {
    throw new Error("Could not create web customer");
  }

  const itemsText = formatOrderItems(items);

  /*
   * The web customer supplies coordinates directly. We keep a readable
   * delivery_address because the existing partner/store/shopper messages
   * display this field, while the coordinates are the authoritative
   * routing data for ATC.
   */
  const order = await createOrder({
    customerId: customer.id,
    storeName: "Any available local store",
    items: itemsText,
    budget: null,
    deliveryAddress: "Customer location (web)",
    status: "finding_partner",
  });

  if (!order?.id) {
    throw new Error("Could not create Fetch order");
  }

  const locatedOrder = await updateOrder(order.id, {
    customer_latitude: Number(latitude),
    customer_longitude: Number(longitude),
    customer_location_shared_at: new Date().toISOString(),
    customer_location_source: "web_browser",
    delivery_address: "Customer location (web)",
    status: "finding_partner",
  });

  /*
   * ATC is now the selector of the partner store.
   *
   * The selector uses:
   * - requested items
   * - partner-store catalog
   * - partner availability
   * - customer coordinates
   *
   * The selected store then receives the real order request and supplies
   * the real item price. No hard-coded product price is introduced here.
   */
  const dispatch = await dispatchOrderToPartnerStore({
    order: locatedOrder || order,
  });

  if (dispatch?.success) {
    const offeredOrder = await updateOrder(
      order.id,
      {
        status: "partner_offered",
        partner_store_id:
          dispatch?.partnerStore?.id ||
          dispatch?.match?.partnerStoreId ||
          null,
        partner_request_id:
          dispatch?.request?.id ||
          null,
      }
    );

    return {
      status: "partner_offered",
      message:
        "Your request has been sent to a matching nearby partner store. I’ll get the real price and availability before asking you to approve the order.",
      orderId: offeredOrder?.id || order.id,
      order: offeredOrder || order,
      workflow_id: result?.workflow_id || null,
      fetch: result?.fetch || null,
      atc: result?.atc || null,
      execution: {
        success: true,
        status: "partner_store_offer_sent",
        partner_store_id:
          dispatch?.partnerStore?.id ||
          dispatch?.match?.partnerStoreId ||
          null,
        partner_request_id:
          dispatch?.request?.id ||
          null,
      },
    };
  }

  /*
   * No catalog-qualified partner store:
   * use the existing human-shopper fallback rather than failing the
   * customer request or asking the customer to choose a store.
   */
  const fallbackOrder = await updateOrder(order.id, {
    status: "finding_shopper",
    partner_store_id: null,
    partner_request_id: null,
  });

  const shopperDispatch = await offerOrderToShopper(
    fallbackOrder || locatedOrder || order
  );

  if (shopperDispatch?.success) {
    return {
      status: "finding_shopper",
      message:
        "I couldn’t find a matching partner store, so I’ve sent the request to a Fetch shopper who can source the item for you.",
      orderId: order.id,
      order: fallbackOrder || locatedOrder || order,
      workflow_id: result?.workflow_id || null,
      fetch: result?.fetch || null,
      atc: result?.atc || null,
      execution: {
        success: true,
        status: "human_shopper_fallback",
        reason:
          dispatch?.reason ||
          "no_partner_store_available",
      },
    };
  }

  return {
    status: "finding_partner",
    message:
      "Your request is saved, but there is currently no available partner store or shopper. Fetch will keep the order in the fulfilment queue.",
    orderId: order.id,
    order: fallbackOrder || locatedOrder || order,
    workflow_id: result?.workflow_id || null,
    fetch: result?.fetch || null,
    atc: result?.atc || null,
    execution: {
      success: false,
      status: "queued_no_resource",
      reason:
        dispatch?.reason ||
        shopperDispatch?.reason ||
        "no_available_resource",
    },
  };
}

function buildWebOrderMessage(order) {
  const status = cleanText(order?.status).toLowerCase();

  if (status === "finding_partner") {
    return "I’m finding a matching nearby partner store for your request.";
  }

  if (status === "partner_offered") {
    return "Your request has been sent to the matching nearby partner store. I’m waiting for its real availability and price.";
  }

  if (status === "awaiting_customer_price_confirmation") {
    const itemTotal = Number(order?.item_total);
    const deliveryFee = Number(order?.delivery_fee);
    const fetchFee = Number(order?.fetch_fee);
    const total = Number(order?.total_amount);

    const parts = [];

    if (Number.isFinite(itemTotal)) {
      parts.push(`Products: ₹${itemTotal.toFixed(2)}`);
    }

    if (Number.isFinite(deliveryFee)) {
      parts.push(`Delivery: ₹${deliveryFee.toFixed(2)}`);
    }

    if (Number.isFinite(fetchFee)) {
      parts.push(`Fetch fee: ₹${fetchFee.toFixed(2)}`);
    }

    if (Number.isFinite(total)) {
      parts.push(`Total: ₹${total.toFixed(2)}`);
    }

    const shopperSourced =
      Boolean(order?.shopper_id);

    return (
      (shopperSourced
        ? "Your Fetch shopper has sourced the items and sent the real price.\n\n"
        : "The partner store has confirmed the order and provided the real price.\n\n") +
      parts.join("\n") +
      "\n\nPlease approve the total to continue."
    );
  }

  if (status === "finding_shopper") {
    return "I couldn’t use a partner store, so Fetch is finding a shopper who can source the items for you.";
  }

  if (status === "shopper_assigned") {
    return "Your Fetch shopper has accepted the order and will start shopping soon.";
  }

  if (status === "payment_pending") {
    const total = Number(order?.total_amount);
    const totalLine = Number.isFinite(total)
      ? `Total: ₹${total.toFixed(2)}`
      : "Your approved total is ready.";
    const paymentStatus = cleanText(order?.payment_status).toLowerCase();

    if (paymentStatus === "customer_reported_paid") {
      return `Payment reported. ${totalLine} I’m waiting for your Fetch shopper to verify the payment.`;
    }

    if (paymentStatus === "paid") {
      return `Payment confirmed ✅ ${totalLine} Your Fetch shopper can continue shopping.`;
    }

    return `Your order is approved. ${totalLine} Payment is now pending. Ask Fetch for payment details when you’re ready to pay.`;
  }

  if (status === "shopping") {
    return "Your Fetch shopper is shopping for your order now.";
  }

  if (status === "picked_up") {
    return "Your order has been picked up and is on its way.";
  }

  if (status === "out_for_delivery") {
    return "Your order is out for delivery.";
  }

  if (status === "delivered") {
    return "Your Fetch order has been delivered.";
  }

  if (status === "cancelled") {
    return "Your Fetch order has been cancelled.";
  }

  return null;
}

async function handleGet(req, res) {
  const origin = req.headers.origin || "";

  const { getOrderById } = await getPhysicalOrderModule();

  const orderId = cleanText(req.query?.orderId);

  if (!orderId) {
    return sendJson(
      res,
      400,
      {
        success: false,
        error: "orderId is required",
      },
      origin
    );
  }

  const order = await getOrderById(orderId);

  if (!order) {
    return sendJson(
      res,
      404,
      {
        success: false,
        error: "Order not found",
      },
      origin
    );
  }

  return sendJson(
    res,
    200,
    {
      success: true,
      orderId: order.id,
      status: order.status || "unknown",
      message: buildWebOrderMessage(order),
      terminal: ["delivered", "cancelled"].includes(
        cleanText(order.status).toLowerCase()
      ),
      order,
    },
    origin
  );
}

async function handlePost(req, res) {
  const origin = req.headers.origin || "";
  const body =
    req.body && typeof req.body === "object"
      ? req.body
      : {};

  const text = cleanText(body.text);
  const conversationId =
    cleanText(body.conversationId) ||
    `web:${Date.now()}`;

  const latitude = body.latitude;
  const longitude = body.longitude;
  const conversationHistory = getConversationHistory(body);
  const effectiveText = buildEffectiveRequestText(text, conversationHistory);

  if (!text) {
    return sendJson(
      res,
      400,
      {
        success: false,
        error: "text is required",
      },
      origin
    );
  }

  /*
   * WEB CUSTOMER PRICE APPROVAL
   *
   * WhatsApp already has deterministic approval logic for an order
   * in awaiting_customer_price_confirmation. The web channel must
   * use the same state-machine path instead of sending "approve"
   * into the Universal Task Engine as a brand-new request.
   *
   * The web conversation maps to a deterministic synthetic customer
   * identity, so current_order_id is the authoritative order pointer.
   */
  const normalizedApproval = text
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .trim();

  const isWebApproval =
    /^(approve|approved|yes|y|yeah|yep|ya|ok|okay|sure|go ahead|confirm|confirmed|please confirm|please confirm my order)$/.test(
      normalizedApproval
    );

  const isWebRejection =
    /^(no|n|nope|cancel|cancelled|reject|rejected|decline|declined|don't|do not)$/.test(
      normalizedApproval
    );

  const isWebPaymentHelp =
    /^(pay|payment|pay now|make payment|how do i pay|how can i pay|payment details|upi|show payment|show me payment|send payment details|pay the shopper)$/.test(
      normalizedApproval
    );

  const isWebPaid =
    /^(paid|paid it|paid now|i paid|i've paid|i have paid|payment done|payment completed|payment sent|sent the payment|done with payment|paid the shopper|payment successful|payment success|paid successfully)$/.test(
      normalizedApproval
    );

  /*
   * IMPORTANT CONVERSATION RULE:
   *
   * Words such as "yes", "no", "okay" and "sure" are normal
   * conversational replies. They become order approval/rejection
   * ONLY when this web conversation has an order that is explicitly
   * waiting for customer price confirmation.
   *
   * This prevents a normal reply such as:
   *   Fetch: "Would you like the hourly weather forecast?"
   *   User: "Yes"
   *
   * from being incorrectly routed to the order state machine.
   */
  let activeOrder = null;

  if (isWebApproval || isWebRejection || isWebPaymentHelp || isWebPaid) {
    // Reuse the same physical-order state machine as WhatsApp for web approvals.
    // These functions live in the physical order module and must be loaded before
    // reading the synthetic web customer's current order.
    const {
      getOrCreateCustomer,
      getOrderById,
      updateOrder,
      offerOrderToShopper,
      getShopperById,
    } = await getPhysicalOrderModule();

    const phone = syntheticWebPhone(conversationId);
    const customer = await getOrCreateCustomer(phone);

    const currentOrderId =
      customer?.current_order_id || null;

    activeOrder = currentOrderId
      ? await getOrderById(currentOrderId)
      : null;

    if (
      activeOrder &&
      activeOrder.status === "payment_pending" &&
      (isWebPaymentHelp || isWebPaid)
    ) {
      if (isWebPaymentHelp) {
        const shopper = activeOrder.shopper_id
          ? await getPhysicalOrderModule().then((module) =>
              module.getShopperById(activeOrder.shopper_id)
            )
          : null;

        const destination =
          cleanText(shopper?.upi_id) ||
          cleanText(shopper?.phone);

        if (!destination) {
          return sendJson(
            res,
            200,
            {
              success: true,
              status: activeOrder.status,
              message: "Your order is approved, but your shopper’s payment details are not available yet.",
              orderId: activeOrder.id,
              order: activeOrder,
              terminal: false,
            },
            origin
          );
        }

        const total = Number(activeOrder.total_amount || 0);
        const totalText = Number.isFinite(total)
          ? `₹${total.toFixed(2)}`
          : "the approved amount";

        return sendJson(
          res,
          200,
          {
            success: true,
            status: activeOrder.status,
            message:
              `Please pay ${totalText} directly to your Fetch shopper via UPI.\n\nUPI / mobile: ${destination}\n\nAfter paying, reply “I have paid”. The shopper will verify the payment before shopping starts.`,
            orderId: activeOrder.id,
            order: activeOrder,
            terminal: false,
          },
          origin
        );
      }

      if (activeOrder.payment_status === "paid") {
        return sendJson(
          res,
          200,
          {
            success: true,
            status: activeOrder.status,
            message: "Payment is already verified ✅ Your Fetch shopper can continue.",
            orderId: activeOrder.id,
            order: activeOrder,
            terminal: false,
          },
          origin
        );
      }

      if (!activeOrder.shopper_id) {
        return sendJson(
          res,
          200,
          {
            success: true,
            status: activeOrder.status,
            message: "I’m still waiting for a shopper to accept the confirmed order. Payment details will appear as soon as one is assigned.",
            orderId: activeOrder.id,
            order: activeOrder,
            terminal: false,
          },
          origin
        );
      }

      const reported = await updateOrder(
        activeOrder.id,
        {
          payment_status: "customer_reported_paid",
        }
      );

      if (!reported) {
        throw new Error("Could not record web customer payment report");
      }

      const shopper = await getPhysicalOrderModule().then((module) =>
        module.getShopperById(activeOrder.shopper_id)
      );

      if (shopper?.phone) {
        const total = Number(activeOrder.total_amount || 0);
        await getPhysicalOrderModule().then((module) =>
          module.sendWhatsAppMessage(
            shopper.phone,
            `💳 The web customer says they have paid ${Number.isFinite(total) ? `₹${total.toFixed(2)}` : "the approved amount"} directly to you.\n\nPlease check your UPI account and reply RECEIVED only after the money is actually visible. Reply NOT RECEIVED if it has not arrived.`
          )
        );
      }

      return sendJson(
        res,
        200,
        {
          success: true,
          status: activeOrder.status,
          message: "Thanks 👍 I’ve told your shopper to verify the payment. The order will continue only after the shopper confirms RECEIVED.",
          orderId: activeOrder.id,
          order: reported,
          terminal: false,
        },
        origin
      );
    }

    if (
      activeOrder &&
      activeOrder.status ===
        "awaiting_customer_price_confirmation"
    ) {
      if (isWebRejection) {
        const cancelledOrder = await updateOrder(
          activeOrder.id,
          {
            status: "cancelled",
          }
        );

        return sendJson(
          res,
          200,
          {
            success: true,
            status: "cancelled",
            message: "Okay 👍 The order is cancelled.",
            orderId:
              cancelledOrder?.id ||
              activeOrder.id,
            order:
              cancelledOrder ||
              activeOrder,
            terminal: true,
          },
          origin
        );
      }

      if (
        activeOrder.delivery_pricing_status !==
        "calculated"
      ) {
        return sendJson(
          res,
          200,
          {
            success: true,
            status:
              activeOrder.status,
            message:
              "The delivery fee is still being calculated by Fetch from the road distance. Please wait for the final pricing before confirming.",
            orderId: activeOrder.id,
            order: activeOrder,
            terminal: false,
          },
          origin
        );
      }

      const approvedOrder = await updateOrder(
        activeOrder.id,
        {
          status: "payment_pending",
          payment_status: "pending",
        }
      );

      if (!approvedOrder) {
        throw new Error(
          "Could not move order to payment_pending"
        );
      }

      /*
       * If a human shopper already sourced the order, keep that same
       * shopper attached. Only partner-store orders need a shopper offer
       * after customer approval.
       */
      let shopperDispatch = null;

      if (!approvedOrder.shopper_id) {
        shopperDispatch =
          await offerOrderToShopper(
            approvedOrder
          );
      }

      const total = Number(
        approvedOrder.total_amount || 0
      );

      let paymentDestination = "";
      let shopperName = "";

      if (approvedOrder.shopper_id) {
        const shopper = await getShopperById(approvedOrder.shopper_id);
        paymentDestination =
          cleanText(shopper?.upi_id) ||
          cleanText(shopper?.phone);
        shopperName = cleanText(shopper?.name);
      }

      const paymentLine = paymentDestination
        ? `\n\n💳 Pay ${Number.isFinite(total) ? `₹${total.toFixed(2)}` : "the approved amount"} directly to${shopperName ? ` ${shopperName}` : " your Fetch shopper"} via UPI:\n${paymentDestination}\n\nAfter paying, reply “I have paid”. The shopper will verify the payment before shopping starts.`
        : "\n\nPayment details will appear as soon as the shopper’s UPI details are available.";

      const message =
        approvedOrder.shopper_id
          ? `Approved 👍\n\n💰 Total: ₹${total.toFixed(2)}${paymentLine}`
          : shopperDispatch?.success
            ? `Approved 👍\n\n💰 Total: ₹${total.toFixed(2)}\n\nA shopper has been offered the confirmed job. Payment details will appear automatically as soon as they accept.`
            : `Approved 👍\n\n💰 Total: ₹${total.toFixed(2)}\n\nI’m finding an available Fetch shopper now. Payment details will appear automatically as soon as the shopper accepts.`;

      return sendJson(
        res,
        200,
        {
          success: true,
          status: approvedOrder.status,
          message,
          orderId: approvedOrder.id,
          order: approvedOrder,
          terminal: false,
          execution: {
            success: Boolean(
              shopperDispatch?.success
            ),
            status:
              shopperDispatch?.success
                ? "shopper_offer_sent"
                : "shopper_queued",
          },
        },
        origin
      );
    }

    /*
     * No order is waiting for approval.
     *
     * DO NOT return NO_ACTIVE_ORDER here.
     * Let the Universal Task Engine handle the message as normal
     * conversation. This is what makes "yes", "no", "okay", etc.
     * work naturally after a Fetch answer.
     */
  }

  /*
   * SOURCE-OF-TRUTH WEATHER EXECUTION
   *
   * Weather is not a generic knowledge question. Resolve it against
   * a live weather source so a model cannot invent current conditions.
   * The effective text also carries a previous-turn location such as
   * "what's the weather today" -> "in Trivandrum".
   */
  if (isWeatherRequest(effectiveText)) {
    try {
      const weatherExecution = await executeWeatherSource(effectiveText);

      return sendJson(
        res,
        200,
        {
          success: true,
          status: weatherExecution.status,
          workflow_id: null,
          message: weatherExecution.message,
          fetch: { source_class: "weather" },
          atc: { resource_type: "weather_source" },
          execution: weatherExecution,
        },
        origin
      );
    } catch (weatherError) {
      console.error("FETCH WEATHER SOURCE ERROR:", weatherError);
      // Fall through to the existing intelligence stack if the source is unavailable.
    }
  }

  if (isTimeRequest(effectiveText)) {
    try {
      const timeExecution = executeTimeSource(effectiveText);

      return sendJson(
        res,
        200,
        {
          success: true,
          status: timeExecution.status,
          workflow_id: null,
          message: timeExecution.message,
          fetch: { source_class: "time" },
          atc: { resource_type: "deterministic_clock" },
          execution: timeExecution,
        },
        origin
      );
    } catch (timeError) {
      console.error("FETCH TIME SOURCE ERROR:", timeError);
    }
  }

  /*
   * LIVE RESEARCH FIRST
   *
   * Current information must not depend on Browser Use/Chromium. Those
   * sites can return bot-verification pages even when the browser itself
   * started successfully. Gemini's Google Search grounding gives Fetch a
   * server-side research path with source citations.
   *
   * NOTE: Google Search grounding is not available on the Gemini API
   * free tier. On a 429 we remember it for a while and fall through to
   * the Universal engine's search-results path (see below).
   *
   * Physical commerce is deliberately excluded: those requests continue
   * through the existing Universal -> ATC -> partner-store -> shopper flow.
   */
  let researchQuotaHit = false;
  const researchRequest =
    !isLikelyPhysicalText(effectiveText) && isLiveResearchRequest(effectiveText);

  if (researchRequest) {
    if (Date.now() < geminiGroundingBlockedUntil) {
      // Grounded Gemini was refused recently: go straight to the free path.
      researchQuotaHit = true;
    } else {
      try {
        // PRIMARY: Gemini GenerateContent + Google Search grounding.
        let researchExecution = await executeGeminiGenerateContentResearch(
          effectiveText,
          conversationHistory
        );

        // FALLBACK: Interactions API (skipped automatically on a 429,
        // because the QuotaError jumps straight to the catch below).
        if (!researchExecution?.success) {
          researchExecution = await executeGeminiWebResearch(
            effectiveText,
            conversationHistory
          );
        }

        if (researchExecution?.success && researchExecution?.message) {
          return sendJson(
            res,
            200,
            {
              success: true,
              status: "completed",
              workflow_id: null,
              message: researchExecution.message,
              fetch: { source_class: "live_research" },
              atc: { resource_type: "research_engine" },
              execution: researchExecution,
              citations: normalizeCitations(researchExecution?.citations),
            },
            origin
          );
        }
      } catch (researchError) {
        if (researchError instanceof QuotaError) {
          researchQuotaHit = true;
          const wait = researchError.retryAfterMs ?? 15 * 60 * 1000;
          geminiGroundingBlockedUntil =
            Date.now() + Math.min(Math.max(wait, 60 * 1000), 60 * 60 * 1000);
        }
        console.error("FETCH GEMINI LIVE RESEARCH ERROR:", researchError);
      }
    }
  }

  /*
   * IMPORTANT:
   * Always let the Universal Task Engine understand the request first.
   * The web bridge only takes over once the result identifies a physical
   * request. This keeps the web channel aligned with Fetch's core brain.
   */
  const result = await executeUniversalFetchRequest({
    text: effectiveText,
    customerId: null,
    conversationId,
    channel: "web",
    activeTaskId: null,
    suppliedContext: {
      source: "fetch_web",
      skip_browser_for_research: researchRequest,
      web_location: validCoordinates(latitude, longitude)
        ? {
            latitude: Number(latitude),
            longitude: Number(longitude),
          }
        : null,

      /*
       * Pass recent visible conversation into the universal engine.
       * This is used by the digital agent to understand follow-ups
       * such as "yes", "what do you mean?", "and tomorrow?", etc.
       */
      conversation_history: conversationHistory,
    },
  });

  console.log(
    "FETCH WEB UNIVERSAL RESULT:",
    JSON.stringify({
      status: result?.status || null,
      workflow_id: result?.workflow_id || null,
      task_status: result?.task?.status || null,
      network: result?.task?.execution_network || null,
      resource_type: result?.atc?.resource_type || null,
      answered_by: result?.task?.resource?.type || null,
      universal_version: result?.version || null,
      decision_status:
        result?.fetch?.decisions?.[0]?.decision?.status ||
        null,
      domain:
        result?.fetch?.decisions?.[0]?.intent?.domain ||
        null,
    })
  );

  if (isPhysicalResult(result, text)) {
    const physical = await handlePhysicalWebRequest({
      result,
      text,
      conversationId,
      latitude,
      longitude,
    });

    return sendJson(
      res,
      200,
      {
        success: true,
        ...physical,
      },
      origin
    );
  }

  /*
   * LIVE-RESEARCH RESULT HANDLING
   *
   * A research request that reaches this point has either failed the
   * Gemini grounded search or been refused by quota. The Universal engine
   * has then tried its search-results path. Accept that answer ONLY when it
   * was built from real search results (evidence_source === "public_search").
   * Raw Browser Agent and Claude results stay blocked here, so CAPTCHA or
   * bot-verification pages can never reach the customer.
   */
  if (researchRequest) {
    const answer = cleanText(result?.task?.result);

    if (
      result?.status === "completed" &&
      result?.evidence_source === "public_search" &&
      answer
    ) {
      return sendJson(
        res,
        200,
        {
          success: true,
          status: "completed",
          workflow_id: result?.workflow_id || null,
          message: answer,
          fetch: { source_class: "live_research", build: FETCH_BUILD, universal_version: result?.version || null },
          atc: { resource_type: "research_engine" },
          execution: {
            success: true,
            status: "completed",
            provider: "public_search_synthesis",
            citations:
              normalizeCitations([
                ...(Array.isArray(result?.sources) ? result.sources : []),
                ...(Array.isArray(result?.execution?.sources) ? result.execution.sources : []),
                ...(Array.isArray(result?.task?.sources) ? result.task.sources : []),
              ]),
          },
          citations:
            normalizeCitations([
              ...(Array.isArray(result?.sources) ? result.sources : []),
              ...(Array.isArray(result?.execution?.sources) ? result.execution.sources : []),
              ...(Array.isArray(result?.task?.sources) ? result.task.sources : []),
            ]),
        },
        origin
      );
    }

    console.warn(
      "FETCH RESEARCH ANSWER NOT USED:",
      JSON.stringify({
        status: result?.status || null,
        answered_by: cleanText(result?.task?.resource?.type) || null,
        evidence_source: result?.evidence_source || null,
        had_answer: Boolean(answer),
      })
    );

    return sendJson(
      res,
      200,
      {
        success: true,
        status: "research_unavailable",
        workflow_id: null,
        message: researchQuotaHit
          ? "Live research is temporarily unavailable. Please try again in a few minutes."
          : "I couldn't retrieve reliable live web information for that request right now.",
        fetch: { source_class: "live_research", build: FETCH_BUILD },
        atc: { resource_type: "research_engine" },
        execution: {
          success: false,
          status: researchQuotaHit ? "provider_quota_exceeded" : "provider_unavailable",
        },
      },
      origin
    );
  }

  /*
   * BROWSER AGENT BRIDGE
   *
   * The Universal Task Engine has already routed the request to the
   * Browser Agent and completed the worker call. The web API must expose
   * the worker's actual result instead of falling through to the generic
   * "no execution connector" message.
   */
  const browserResourceType = cleanText(
    result?.atc?.resource_type ||
    result?.task?.resource?.type ||
    result?.execution?.resource_type ||
    result?.execution?.execution?.execution_type
  ).toLowerCase();

  if (browserResourceType === "browser_agent") {
    const browserExecution =
      result?.execution?.execution || result?.execution || {};

    const browserMessage =
      browserExecution?.result ||
      browserExecution?.message ||
      result?.task?.result ||
      "The Browser Agent completed the task.";

    const browserSuccess =
      result?.status === "completed" ||
      browserExecution?.success === true ||
      result?.task?.status === "completed";

    /*
     * Browser Agent is a preferred research resource, not a hard
     * dependency. If it fails, hand the SAME user request to the existing
     * Digital Agent. That agent already has current-research support and
     * concise-answer formatting. Fetch must not expose connector errors
     * such as "Application not found" to the customer.
     */
    if (!browserSuccess) {
      try {
        const fallbackExecution = await executeDigitalAgent({
          task: {
            id: result?.task?.task_id || result?.workflow_id || `web:${Date.now()}`,
            source_text: text,
            goal: text,
            objective: text,
            task_data: {
              source_text: text,
              text,
              browser_fallback: true,
              browser_error: String(browserMessage),
            },
          },
          route: {
            resource_type: "digital_agent",
            fallback_from: "browser_agent",
          },
          resource: { resource_type: "digital_agent" },
          context: {
            channel: "web",
            text,
            conversation_id: conversationId,
            workflow_id: result?.workflow_id || null,
            use_web_search: true,
            conversation_history: Array.isArray(body.conversationHistory)
              ? body.conversationHistory.slice(-10).map((message) => ({
                  role: message?.role === "assistant" ? "assistant" : "user",
                  content: String(message?.content || "").slice(0, 4000),
                }))
              : [],
          },
        });

        if (fallbackExecution?.success && fallbackExecution?.message) {
          return sendJson(
            res,
            200,
            {
              success: true,
              status: "completed",
              workflow_id: result?.workflow_id || null,
              message: cleanText(fallbackExecution.message),
              fetch: result?.fetch || null,
              atc: {
                ...(result?.atc || {}),
                resource_type: "digital_agent",
                fallback_from: "browser_agent",
              },
              execution: fallbackExecution,
            },
            origin
          );
        }
      } catch (fallbackError) {
        console.error("FETCH BROWSER FALLBACK ERROR:", fallbackError);
      }
    }

    if (false && !browserSuccess && isLiveResearchRequest(effectiveText)) {
      try {
        const researchExecution = await executeClaudeWebResearch(
          effectiveText,
          conversationHistory
        );

        if (researchExecution?.success && researchExecution?.message) {
          return sendJson(
            res,
            200,
            {
              success: true,
              status: "completed",
              workflow_id: result?.workflow_id || null,
              message: researchExecution.message,
              fetch: result?.fetch || null,
              atc: {
                ...(result?.atc || {}),
                resource_type: "browser_agent",
                fallback_from: "browser_agent",
              },
              execution: researchExecution,
            },
            origin
          );
        }
      } catch (researchError) {
        console.error("FETCH BROWSER -> CLAUDE FALLBACK ERROR:", researchError);
      }
    }

    /*
     * If Browser Agent genuinely succeeded, return its result.
     * A successful connector result is already authoritative.
     */
    return sendJson(
      res,
      200,
      {
        success: browserSuccess,
        status: browserSuccess ? "completed" : "execution_failed",
        workflow_id: result?.workflow_id || null,
        message: browserSuccess
          ? cleanText(browserMessage)
          : "I couldn't complete that research right now. Please try again.",
        fetch: result?.fetch || null,
        atc: result?.atc || null,
        execution: browserExecution,
      },
      origin
    );
  }

  /*
   * LIVE RESEARCH FALLBACK
   *
   * If Browser Agent did not produce the result, use the already-connected
   * Claude web-search capability for current information before falling back
   * to the normal conversational model. This keeps current-data requests
   * grounded without making Browser Agent a single point of failure.
   */
  if (false && isLiveResearchRequest(effectiveText)) {
    try {
      const researchExecution = await executeClaudeWebResearch(
        effectiveText,
        conversationHistory
      );

      if (researchExecution?.success && researchExecution?.message) {
        return sendJson(
          res,
          200,
          {
            success: true,
            status: "completed",
            workflow_id: result?.workflow_id || null,
            message: researchExecution.message,
            fetch: result?.fetch || null,
            atc: {
              ...(result?.atc || {}),
              resource_type: "browser_agent",
              fallback_from: result?.atc?.resource_type || "digital_agent",
            },
            execution: researchExecution,
          },
          origin
        );
      }
    } catch (researchError) {
      console.error("FETCH LIVE RESEARCH FALLBACK ERROR:", researchError);
    }
  }

  /*
   * DIGITAL AGENT BRIDGE
   *
   * The ATC route is authoritative. If ATC selected digital_agent,
   * invoke the existing Fetch Digital Agent connector directly.
   *
   * This is deliberately NOT a new model and does NOT train anything.
   * It connects the existing agent executor to the web channel.
   *
   * The direct bridge also protects the web channel from an older
   * universal-execution deployment falling through to the generic
   * "awaiting connector" response.
   */
  if (
    cleanText(result?.atc?.resource_type).toLowerCase() ===
    "digital_agent"
  ) {
    const task = {
      id:
        result?.task?.task_id ||
        result?.workflow_id ||
        `web:${Date.now()}`,
      source_text: effectiveText,
      goal:
        result?.task?.goal ||
        result?.fetch?.decisions?.[0]?.plan?.source_text ||
        text,
      objective:
        result?.task?.objective ||
        result?.fetch?.decisions?.[0]?.plan?.steps?.[0]?.purpose ||
        text,
      task_data: {
        ...(result?.task || {}),
        source_text: text,
        text,
        atc_route: result?.atc || null,
      },
    };

    let digitalExecution;

    try {
      digitalExecution = await executeDigitalAgent({
        task,
        route: result?.atc || {},
        resource: result?.atc?.resource || {},
        context: {
          channel: "web",
          text,
          customer_id: null,
          conversation_id: conversationId,
          workflow_id: result?.workflow_id || null,
          task_id: task.id,
          atc_route: result?.atc || null,
          use_web_search: true,

          /*
           * Keep the same conversation context for the direct
           * digital-agent bridge. This is critical for normal
           * multi-turn conversation on the web channel.
           */
          conversation_history: conversationHistory,
        },
      });
    } catch (error) {
      console.error(
        "FETCH WEB DIGITAL AGENT BRIDGE ERROR:",
        error
      );

      digitalExecution = {
        success: false,
        status: "execution_error",
        message:
          error?.message ||
          "Fetch's digital agent could not complete the request.",
      };
    }

    return sendJson(
      res,
      200,
      {
        success: true,
        status: digitalExecution?.success
          ? "completed"
          : "execution_failed",
        workflow_id: result?.workflow_id || null,
        message:
          digitalExecution?.message ||
          "Fetch's digital agent could not complete the request.",
        fetch: result?.fetch || null,
        atc: result?.atc || null,
        execution: digitalExecution || null,
      },
      origin
    );
  }

  /*
   * Other non-physical requests remain on the Universal Task Engine path.
   * Do not pretend that an unimplemented connector completed.
   */
  return sendJson(
    res,
    200,
    {
      success: true,
      status: result?.status || "awaiting_connector",
      workflow_id: result?.workflow_id || null,
      message:
        result?.execution?.message ||
        "Fetch understood the request, but this channel does not have an execution connector for it yet.",
      fetch: result?.fetch || null,
      atc: result?.atc || null,
      execution: result?.execution || null,
    },
    origin
  );
}

export default async function handler(req, res) {
  const origin = req.headers.origin || "";

  if (req.method === "OPTIONS") {
    return sendJson(
      res,
      204,
      {},
      origin
    );
  }

  try {
    if (req.method === "GET") {
      return await handleGet(req, res);
    }

    if (req.method === "POST") {
      return await handlePost(req, res);
    }

    return sendJson(
      res,
      405,
      {
        success: false,
        error: "Method not allowed",
      },
      origin
    );
  } catch (error) {
    console.error("FETCH WEB AGENT ERROR:", error);

    const errorMessage =
      cleanText(error?.message) ||
      cleanText(error?.error) ||
      "Fetch web request failed";

    // Keep the error boundary independent from sendJson().
    // This prevents a secondary serialization error from masking
    // the original backend exception.
    try {
      res.status(500);
      res.setHeader("Content-Type", "application/json; charset=utf-8");

      for (const [key, value] of Object.entries(corsHeaders(origin))) {
        res.setHeader(key, value);
      }

      return res.end(
        JSON.stringify({
          success: false,
          status: "server_error",
          error: errorMessage,
          error_type: error?.name || "Error",
          build: FETCH_BUILD,
        })
      );
    } catch (responseError) {
      console.error("FETCH WEB ERROR RESPONSE FAILED:", responseError);
      return res.end(
        JSON.stringify({
          success: false,
          status: "server_error",
          error: "Fetch backend failed before it could serialize the error.",
          build: FETCH_BUILD,
        })
      );
    }
  }
}
