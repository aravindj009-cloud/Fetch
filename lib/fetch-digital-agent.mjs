/*
  FETCH DIGITAL / CONVERSATION AGENT — OPEN MODEL VERSION

  Purpose:
  - Make Fetch talk naturally for normal questions.
  - Use an open-weight model through Hugging Face Inference Providers.
  - Keep the existing ATC routing and physical-commerce engine unchanged.
  - Keep current news/research cards working.
  - Add a reliability gate so fresh/external facts are never answered from model memory when evidence is missing.
  - Never use OPENAI_API_KEY.
  - Never claim an external side effect unless a real connector completed it.

  REQUIRED VERCEL ENVIRONMENT VARIABLE:
    HF_TOKEN

  OPTIONAL:
    FETCH_CHAT_MODEL=Qwen/Qwen3-32B:fastest

  The model is open-weight; Hugging Face is used only as the inference
  gateway/provider router. This module does not train a model.
*/

const HF_TOKEN = String(process.env.HF_TOKEN || "").trim();

const HF_MODEL =
  String(
    process.env.FETCH_CHAT_MODEL ||
      "Qwen/Qwen3-32B:fastest"
  ).trim();

const HF_URL =
  "https://router.huggingface.co/v1/chat/completions";

function cleanText(value) {
  if (value == null) return "";

  if (typeof value === "string") {
    return value.replace(/\s+/g, " ").trim();
  }

  if (Array.isArray(value)) {
    return value.map((item) => cleanText(item)).filter(Boolean).join(" ").trim();
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
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }

  return String(value).replace(/\s+/g, " ").trim();
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function decodeXml(value) {
  return String(value ?? "")
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/");
}

function stripHtml(value) {
  return decodeXml(String(value ?? ""))
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/p>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isResearchRequest(text) {
  const value = cleanText(text).toLowerCase();

  // Any request whose correctness depends on information that can change
  // over time must be grounded in an external source. This is intentionally
  // broader than the old "latest news" detector.
  const freshSignal =
    /\b(latest|recent|current|today|tonight|yesterday|this week|this month|now|currently|as of|updated|newest|news|headlines|what happened|available now|open now|price|prices|cost|costs|salary|salaries|stock|stocks|share price|weather|forecast|flight|flights|hotel|hotels|restaurant|restaurants|jobs|job openings|vacancy|vacancies|deadline|schedule|score|scores|ranking|rankings|ceo|chief executive|founder|president|minister|mayor|election|event|events|research|investigate|verify|check|compare|find|look up|search|browse)\b/i.test(value);

  const externalDomain =
    /\b(ai|artificial intelligence|agent|agents|technology|tech|startup|business|market|india|world|politics|science|crypto|software|company|companies|product|products|laptop|phone|iphone|android|shoe|shoes|travel|visa|passport|college|university|course|courses|sports|football|cricket|bank|banking|insurance|government|law|legal|medical|health)\b/i.test(value);

  const liveUtilityDomain =
    /\b(weather|forecast|temperature|rain|raining|humidity|wind|sunrise|sunset|time|timezone)\b/i.test(value);

  return freshSignal && (
    externalDomain ||
    liveUtilityDomain ||
    /\b(on|online|web|internet|website|official)\b/i.test(value)
  );
}

function requiresFreshEvidence(text) {
  return isResearchRequest(text);
}

function buildGoogleNewsUrl(query) {
  return (
    "https://news.google.com/rss/search?q=" +
    encodeURIComponent(query) +
    "&hl=en-IN&gl=IN&ceid=IN:en"
  );
}

function getTag(xml, tag) {
  const pattern = new RegExp(
    "<" + tag + "[^>]*>([\\s\\S]*?)</" + tag + ">",
    "i"
  );

  const match = String(xml || "").match(pattern);
  return match ? decodeXml(match[1]) : "";
}

function getAllItems(xml) {
  return String(xml || "").match(
    /<item\b[\s\S]*?<\/item>/gi
  ) || [];
}

function cleanTitle(value) {
  return cleanText(
    String(value || "")
      .replace(/\s+-\s+[^-]+$/, "")
      .replace(/\s+\|\s+[^|]+$/, "")
  );
}

function sourceFromLink(link) {
  try {
    return new URL(link).hostname
      .replace(/^www\./, "")
      .replace(/^news\./, "");
  } catch {
    return "web";
  }
}

function formatPublishedDate(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

async function fetchNewsResults(query) {
  const url = buildGoogleNewsUrl(query);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": "Fetch/1.0",
      Accept: "application/rss+xml, application/xml, text/xml",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Google News RSS ${response.status}`
    );
  }

  const xml = await response.text();

  const results = getAllItems(xml)
    .map((item) => {
      const title = cleanTitle(getTag(item, "title"));
      const link = cleanText(getTag(item, "link"));
      const publishedAt =
        cleanText(getTag(item, "pubDate")) ||
        cleanText(getTag(item, "published"));

      const description = stripHtml(
        getTag(item, "description")
      );

      if (!title || !link) {
        return null;
      }

      return {
        title,
        link,
        published_at: publishedAt || null,
        published_display:
          formatPublishedDate(publishedAt),
        description:
          description.length > 280
            ? description.slice(0, 277) + "..."
            : description,
        source: sourceFromLink(link),
      };
    })
    .filter(Boolean)
    .filter(
      (item, index, array) =>
        array.findIndex(
          (other) =>
            other.link === item.link ||
            other.title.toLowerCase() ===
              item.title.toLowerCase()
        ) === index
    )
    .slice(0, 8);

  return results;
}

function extractChatText(data) {
  const content = data?.choices?.[0]?.message?.content;

  const extract = (value) => {
    if (value == null) return "";

    if (typeof value === "string") {
      return value;
    }

    if (Array.isArray(value)) {
      return value.map(extract).filter(Boolean).join("\n");
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
        return extract(preferred);
      }
    }

    return "";
  };

  return extract(content).trim();
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history
    .filter(
      (item) =>
        item &&
        (item.role === "user" ||
          item.role === "assistant") &&
        cleanText(item.content)
    )
    .slice(-10)
    .map((item) => ({
      role: item.role,
      content: cleanText(item.content).slice(0, 4000),
    }));
}


function formatFetchAnswer(value) {
  let text = String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .trim();

  if (!text) return "";

  // Strip code fences and escaped Markdown.
  text = text
    .replace(/```(?:markdown|md|text)?/gi, "")
    .replace(/```/g, "")
    .replace(/\\([*_#`])/g, "$1");

  // Turn common model-generated separators/headings into real line breaks.
  text = text
    .replace(/\s*(?:---+|—{2,}|–{2,})\s*/g, "\n")
    .replace(/\s+(#{1,6})\s+/g, "\n")
    .replace(/^\s*#{1,6}\s*/gm, "")
    .replace(/\s+([•▪◦])\s+/g, "\n• ")
    .replace(/^\s*[-*•▪◦]\s*/gm, "• ");

  // Separate numbered sections even when the model returned them inline.
  text = text
    .replace(/\s+(\d{1,2})\.\s+(?=[A-Z][A-Za-z])/g, "\n$1. ")
    .replace(/^\s*(\d{1,2})\.\s+/gm, "$1. ");

  // Remove Markdown emphasis markers without removing their content.
  text = text
    .replace(/\*\*\*([^*]+)\*\*\*/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, "$1")
    .replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, "$1");

  // Clean Markdown links but retain the destination.
  text = text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    "$1 ($2)"
  );

  // Remove leftover decorative Markdown fragments.
  text = text
    .replace(/(?:^|\s)\*{2,}(?=\s|$)/g, " ")
    .replace(/(?:^|\s)#{1,6}(?=\s|$)/g, " ")
    .replace(/^\s*[|]+\s*/gm, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // If the model produced a long run-on answer, break after sentence
  // boundaries before numbered/bullet content where possible.
  text = text
    .replace(/([.!?])\s+(?=(?:\d{1,2}\.|•\s))/g, "$1\n")
    .replace(/([.!?])\s+(?=[A-Z][A-Za-z ]{2,35}:)/g, "$1\n");

  return text.trim();
}

function buildSystemPrompt() {

  return `
You are Fetch, a personal AI agent.

Fetch is not a grocery app. Fetch is the user's personal agent.

Your job is to:
- talk naturally and helpfully, like a strong general-purpose AI assistant;
- understand what the user means, not just match keywords;
- answer stable general-knowledge questions directly when no fresh external fact is required;
- remember conversational context when it is provided;
- never guess a current, changing, numerical, location-dependent, or externally verifiable fact;
- when fresh evidence is required but no verified research data is supplied, say that the information could not be verified rather than filling the gap from model memory;
- never pretend an action happened when Fetch has not actually executed it;
- never invent prices, availability, bookings, messages, payments, calls, or confirmations;
- when a request needs a real-world action, explain that Fetch can route it through its execution system rather than pretending it is complete;
- keep answers natural, concise, and human;
- write for a clean chat interface, not a Markdown document;
- use short paragraphs;
- fully answer every part of a multi-part request before stopping;
- never stop after answering only the first part of a request;
- for 3 or more options, use a numbered list with one item per line;
- for features or short points, use simple bullet points;
- when giving a plan, use numbered steps with one step per line;
- if the user asks to research, compare, find, or investigate something, do not pretend that general knowledge is current research;
- never use Markdown headings (#), bold (**), italic (*), underscores, code fences, or decorative separators;
- never use "###", "***", "---", or repeated dash/asterisk characters as visual separators;
- do not cram multiple numbered sections into one paragraph;
- avoid unnecessary section labels, filler, and repetition;
- do not mention internal ATC, routing, models, prompts, or implementation unless the user asks.

If the user asks a stable general-knowledge question, answer it directly.

If the request depends on current or externally verifiable information, use only the supplied research evidence. Never substitute model memory for missing evidence. If the evidence is missing, conflicting, or insufficient, say so clearly.

If the user asks for advice, provide practical options without pretending to have personal experiences.

If current information is supplied by the research results in the conversation, use those results and clearly distinguish current findings from general knowledge.

Do not say "I am unable to help" when a useful answer can be given.
`.trim();
}

async function chatWithOpenModel({
  text,
  history = [],
  researchResults = [],
}) {
  if (!HF_TOKEN) {
    return {
      success: false,
      status: "failed",
      message:
        "Fetch’s open conversation model is not connected yet. Add HF_TOKEN to the backend environment.",
      resource_type: "digital_agent",
    };
  }

  const messages = [
    {
      role: "system",
      content: buildSystemPrompt(),
    },
    ...normalizeHistory(history),
  ];

  const freshEvidenceRequired = requiresFreshEvidence(text);

  if (freshEvidenceRequired && (!Array.isArray(researchResults) || !researchResults.length)) {
    return {
      success: false,
      status: "verification_required",
      message:
        "I need to verify that information from a current source before giving you a reliable answer.",
      result:
        "I need to verify that information from a current source before giving you a reliable answer.",
      resource_type: "digital_agent",
      execution_type: "verification",
      execution_metadata: {
        provider: "fetch_reliability_gate",
        verified: false,
        source_count: 0,
      },
    };
  }

  if (Array.isArray(researchResults) && researchResults.length) {
    const researchContext = researchResults
      .map(
        (item, index) =>
          item.provider === "runtime_clock"
            ? [
                `${index + 1}. Live local time`,
                `Source: Fetch runtime clock`,
                `Location: ${item.location || "requested location"}`,
                `Time zone: ${item.timezone || ""}`,
                `Current local time: ${item.current_time_local || ""}`,
              ].join("\n")
            : item.provider === "open_meteo"
            ? [
                `${index + 1}. Live weather data`,
                `Source: Open-Meteo`,
                `Location: ${item.location?.name || ""}, ${item.location?.country || ""}`,
                `Forecast date: ${item.forecast_date || ""}`,
                `Condition: ${item.weather || ""}`,
                `Minimum temperature: ${item.temperature_min_c ?? "unknown"} °C`,
                `Maximum temperature: ${item.temperature_max_c ?? "unknown"} °C`,
                `Rain probability: ${item.precipitation_probability_percent ?? "unknown"}%`,
              ].join("\n")
            : `${index + 1}. ${item.title}\n` +
              `Source: ${item.source || "web"}\n` +
              `Date: ${item.published_display || item.published_at || ""}\n` +
              `Summary: ${item.description || ""}\n` +
              `Link: ${item.link || ""}`
      )
      .join("\n\n");

    messages.push({
      role: "system",
      content:
        "Current web research results are below. Use them when answering the user's question. Do not invent facts that are not supported by them.\n\n" +
        researchContext,
    });
  }

  messages.push({
    role: "user",
    content: cleanText(text),
  });

  const response = await fetch(HF_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${HF_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: HF_MODEL,
      messages,
      temperature: 0.4,
      // Give Fetch enough room to complete multi-part answers.
      // 900 was causing research/planning responses to stop mid-answer.
      max_tokens: 1800,
      stream: false,
    }),
  });

  const raw = await response.text();

  let data = null;

  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = raw;
  }

  if (!response.ok) {
    throw new Error(
      `Hugging Face ${response.status}: ${
        typeof data === "string"
          ? data
          : JSON.stringify(data)
      }`
    );
  }

  const message = extractChatText(data);

  if (!message) {
    throw new Error(
      "The open conversation model returned no usable text."
    );
  }

  const formattedMessage = formatFetchAnswer(message);

  return {
    success: true,
    status: "completed",
    message: formattedMessage,
    result: formattedMessage,
    resource_type: "digital_agent",
    execution_type: "conversation",
    execution_metadata: {
      provider: "huggingface_inference_providers",
      model: HF_MODEL,
      side_effect: false,
      grounded: freshEvidenceRequired ? researchResults.length > 0 : false,
      verification_status: freshEvidenceRequired
        ? "web_sourced"
        : "model_knowledge_allowed",
      source_count: researchResults.length,
    },
  };
}

function extractWeatherLocation(text = "", context = {}) {
  const value = cleanText(text);

  // 1. Prefer an explicitly named location in the user's message.
  const match =
    value.match(/\b(?:in|at|near|around)\s+([A-Za-z][A-Za-z .'-]{2,60}?)(?=\s+(?:tomorrow|today|tonight|this\s+week|next\s+week|on\s+\w+)|[?.!,]|$)/i);

  const explicit = cleanText(match?.[1] || "");
  if (explicit) return explicit;

  // 2. Fall back to the customer's known location.
  const customerLocation =
    context?.customer_location ||
    context?.customer?.location ||
    context?.customer ||
    {};

  return cleanText(
    customerLocation?.city ||
    customerLocation?.address ||
    context?.active_order?.delivery_address ||
    ""
  );
}

function extractTimeLocation(text = "") {
  const value = cleanText(text);
  const match =
    value.match(/\b(?:in|at)\s+([A-Za-z][A-Za-z .'-]{1,60}?)(?:\?|[.!]|$)/i);
  return cleanText(match?.[1] || "");
}

function resolveTimeZone(location) {
  const normalized = cleanText(location).toLowerCase();

  const aliases = {
    tokyo: "Asia/Tokyo",
    japan: "Asia/Tokyo",
    "new york": "America/New_York",
    "los angeles": "America/Los_Angeles",
    london: "Europe/London",
    "dubai": "Asia/Dubai",
    singapore: "Asia/Singapore",
    bangalore: "Asia/Kolkata",
    bengaluru: "Asia/Kolkata",
    trivandrum: "Asia/Kolkata",
    thiruvananthapuram: "Asia/Kolkata",
    india: "Asia/Kolkata",
    delhi: "Asia/Kolkata",
    mumbai: "Asia/Kolkata",
    "new delhi": "Asia/Kolkata",
    paris: "Europe/Paris",
    berlin: "Europe/Berlin",
    sydney: "Australia/Sydney",
    "hong kong": "Asia/Hong_Kong",
    "seoul": "Asia/Seoul",
    toronto: "America/Toronto",
    chicago: "America/Chicago",
    sanfrancisco: "America/Los_Angeles",
    "san francisco": "America/Los_Angeles",
  };

  return aliases[normalized] || null;
}

function fetchCurrentTime(query) {
  const location = extractTimeLocation(query);
  const timeZone = resolveTimeZone(location);

  if (!timeZone) {
    return null;
  }

  const now = new Date();

  return {
    query,
    provider: "runtime_clock",
    source_type: "time",
    location,
    timezone: timeZone,
    current_time_iso: now.toISOString(),
    current_time_local: new Intl.DateTimeFormat("en-IN", {
      dateStyle: "full",
      timeStyle: "short",
      timeZone,
    }).format(now),
  };
}

async function fetchWeatherForecast(query, context = {}) {
  const customerLocation =
    context?.customer_location ||
    context?.customer?.location ||
    {};

  const knownLatitude = Number(
    customerLocation?.latitude ??
    context?.active_order?.customer_latitude
  );
  const knownLongitude = Number(
    customerLocation?.longitude ??
    context?.active_order?.customer_longitude
  );

  let place = null;

  // Use stored coordinates when available. This is the most reliable
  // source for a location-dependent request and avoids guessing from
  // the user's sentence.
  if (
    Number.isFinite(knownLatitude) &&
    Number.isFinite(knownLongitude) &&
    knownLatitude !== 0 &&
    knownLongitude !== 0
  ) {
    place = {
      latitude: knownLatitude,
      longitude: knownLongitude,
      name:
        customerLocation?.city ||
        customerLocation?.name ||
        customerLocation?.address ||
        "your location",
      country: customerLocation?.country || "India",
    };
  }

  const locationQuery = extractWeatherLocation(query, context);

  // If there are no coordinates, only geocode an actual location name.
  // Never send the whole natural-language weather question to geocoding.
  if (!place && locationQuery) {
    const geoResponse = await fetch(
      "https://geocoding-api.open-meteo.com/v1/search?name=" +
        encodeURIComponent(locationQuery) +
        "&count=1&language=en&format=json",
      {
        headers: { "User-Agent": "Fetch/1.0" },
      }
    );

    if (!geoResponse.ok) {
      throw new Error("Weather geocoding failed");
    }

    const geo = await geoResponse.json();
    place = geo?.results?.[0] || null;
  }

  if (!place?.latitude || !place?.longitude) {
    return {
      query,
      provider: "open_meteo",
      status: "location_required",
      message:
        "Sure — what city or area should I check the weather for?",
    };
  }

  const forecastResponse = await fetch(
    "https://api.open-meteo.com/v1/forecast?latitude=" +
      encodeURIComponent(place.latitude) +
      "&longitude=" +
      encodeURIComponent(place.longitude) +
      "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=3",
    {
      headers: { "User-Agent": "Fetch/1.0" },
    }
  );

  if (!forecastResponse.ok) {
    throw new Error("Weather forecast failed");
  }

  const forecast = await forecastResponse.json();
  const daily = forecast?.daily;

  if (!daily?.time?.length) {
    throw new Error("No weather forecast returned");
  }

  const lowerQuery = cleanText(query).toLowerCase();
  const requestedOffset =
    /\bday after tomorrow\b/.test(lowerQuery) ? 2 :
    /\btomorrow\b/.test(lowerQuery) ? 1 :
    0;

  const index = Math.min(
    requestedOffset,
    Math.max(0, daily.time.length - 1)
  );

  const weatherCode = Number(daily.weather_code?.[index]);
  const weatherDescriptions = {
    0: "clear sky",
    1: "mainly clear",
    2: "partly cloudy",
    3: "overcast",
    45: "fog",
    48: "depositing rime fog",
    51: "light drizzle",
    53: "moderate drizzle",
    55: "dense drizzle",
    61: "slight rain",
    63: "moderate rain",
    65: "heavy rain",
    71: "slight snow",
    73: "moderate snow",
    75: "heavy snow",
    80: "slight rain showers",
    81: "moderate rain showers",
    82: "violent rain showers",
    95: "thunderstorm",
    96: "thunderstorm with slight hail",
    99: "thunderstorm with heavy hail",
  };

  return {
    query,
    provider: "open_meteo",
    location: {
      name: place.name,
      country: place.country,
      latitude: place.latitude,
      longitude: place.longitude,
    },
    forecast_date: daily.time[index],
    weather: weatherDescriptions[weatherCode] || "mixed conditions",
    location_source:
      Number.isFinite(knownLatitude) && Number.isFinite(knownLongitude)
        ? "customer_saved_coordinates"
        : locationQuery
        ? "explicit_user_location"
        : "geocoded_location",
    temperature_max_c: daily.temperature_2m_max?.[index] ?? null,
    temperature_min_c: daily.temperature_2m_min?.[index] ?? null,
    precipitation_probability_percent:
      daily.precipitation_probability_max?.[index] ?? null,
  };
}

function buildResearchIntro(query, count) {
  return count
    ? `Here’s what I found for “${query}”:`
    : `I couldn’t find fresh results for “${query}”.`;
}

export async function executeDigitalAgent({
  task = {},
  route = {},
  resource = {},
  context = {},
} = {}) {
  const startedAt = Date.now();

  const userText = cleanText(
    task?.source_text ||
      task?.goal ||
      task?.task_data?.source_text ||
      task?.task_data?.text ||
      context?.text ||
      ""
  );

  if (!userText) {
    return {
      success: false,
      status: "failed",
      message: "Fetch needs the user's request.",
      resource_type:
        resource?.resource_type || "digital_agent",
    };
  }

  try {
    let researchResults = [];
    let researchQuery = null;
    let weatherResult = null;
    let timeResult = null;

    /*
      CONVERSATIONAL CLARIFICATION MEMORY
      If Fetch previously asked for a weather location, the next short
      location message must complete that weather request rather than
      becoming a standalone knowledge query.
    */
    const history = Array.isArray(context?.conversation_history)
      ? context.conversation_history
      : Array.isArray(context?.history)
      ? context.history
      : [];

    const normalizedCurrent = cleanText(userText).toLowerCase();
    const recentMessages = history.slice(-12);

    const latestWeatherRequest = [...recentMessages]
      .reverse()
      .find((message) =>
        message?.role === "user" &&
        /\b(weather|forecast|temperature|rain|raining|humidity|wind)\b/i.test(
          cleanText(message?.message || message?.content || "")
        )
      );

    const latestAssistantWeatherClarification = [...recentMessages]
      .reverse()
      .find((message) =>
        message?.role === "assistant" &&
        /what city or area.*weather|check the weather for/i.test(
          cleanText(message?.message || message?.content || "")
        )
      );

    const looksLikeShortLocation =
      userText.length <= 80 &&
      !/[?!]/.test(userText) &&
      !/\b(weather|forecast|temperature|rain|raining|humidity|wind)\b/i.test(userText) &&
      /^[A-Za-z][A-Za-z .,'-]{1,79}$/.test(userText);

    let effectiveUserText = userText;

    if (
      looksLikeShortLocation &&
      latestAssistantWeatherClarification &&
      latestWeatherRequest
    ) {
      const previousWeatherText = cleanText(
        latestWeatherRequest.message ||
        latestWeatherRequest.content ||
        ""
      );

      effectiveUserText =
        previousWeatherText +
        " in " +
        userText;
    } else if (
      /\b(weather|forecast|temperature|rain|raining|humidity|wind)\b/i.test(userText) &&
      !/\b(?:in|at|near|around)\s+[A-Za-z]/i.test(userText)
    ) {
      /*
        If the user asks "Weather" immediately after giving a city,
        reuse that latest short location from the conversation.
      */
      const latestShortUserLocation = [...recentMessages]
        .reverse()
        .find((message) => {
          if (message?.role !== "user") return false;
          const value = cleanText(message?.message || message?.content || "");
          return (
            value.length >= 2 &&
            value.length <= 80 &&
            /^[A-Za-z][A-Za-z .,'-]{1,79}$/.test(value) &&
            !/\b(weather|forecast|temperature|rain|raining|humidity|wind|today|tomorrow|yesterday|what|how|why|when|where|who)\b/i.test(value)
          );
        });

      if (latestShortUserLocation) {
        effectiveUserText =
          userText +
          " in " +
          cleanText(
            latestShortUserLocation.message ||
            latestShortUserLocation.content ||
            ""
          );
      }
    }

    /*
      SOURCE-FIRST ROUTING:
      Live utility requests must reach a live source before the language
      model is allowed to answer. The model summarizes verified data; it
      does not decide whether the data is current.
    */
    if (/\b(weather|forecast|temperature|rain|raining|humidity|wind)\b/i.test(effectiveUserText)) {
      try {
        weatherResult = await fetchWeatherForecast(effectiveUserText, {
          customer_location: context?.customer_location || null,
          active_order: context?.active_order || null,
        });
      } catch (weatherError) {
        console.error(
          "FETCH WEATHER SOURCE ERROR:",
          weatherError
        );
      }
    }

    if (/\b(?:current\s+time|time\s+now|what\s+time|local\s+time|clock)\b/i.test(userText)) {
      try {
        timeResult = fetchCurrentTime(userText);
      } catch (timeError) {
        console.error(
          "FETCH TIME SOURCE ERROR:",
          timeError
        );
      }
    }

    if (weatherResult?.status === "location_required") {
      const durationMs = Date.now() - startedAt;

      return {
        success: true,
        status: "needs_location",
        message: weatherResult.message,
        result: weatherResult.message,
        resource_type: "digital_agent",
        execution_type: "clarification",
        duration_ms: durationMs,
        results: [],
        intro: null,
        research: {
          query: userText,
          provider: "open_meteo",
          result_count: 0,
          verification_status: "location_required",
          source_type: "weather",
        },
      };
    }

    /*
      Preserve the working research experience:
      - fetch current headlines from Google News RSS
      - return structured cards
      - then let the open model summarize/talk normally
    */
    if (!weatherResult && isResearchRequest(userText)) {
      researchQuery = userText;

      try {
        researchResults =
          await fetchNewsResults(userText);
      } catch (researchError) {
        console.error(
          "FETCH NEWS RESEARCH ERROR:",
          researchError
        );
      }
    }

    const execution = await chatWithOpenModel({
      text: userText,
      history:
        context?.conversation_history ||
        context?.history ||
        [],
      researchResults: weatherResult
        ? [weatherResult]
        : timeResult
        ? [timeResult]
        : researchResults,
    });

    const durationMs = Date.now() - startedAt;

    return {
      ...execution,
      duration_ms: durationMs,

      /*
        These fields preserve the current frontend research-card contract.
      */
      results: weatherResult
        ? [weatherResult]
        : timeResult
        ? [timeResult]
        : researchResults,
      intro: weatherResult
        ? `Live weather forecast for ${weatherResult.location?.name || "the requested location"}:`
        : timeResult
        ? `Current time in ${timeResult.location}: ${timeResult.current_time_local}`
        : researchQuery
        ? buildResearchIntro(
            researchQuery,
            researchResults.length
          )
        : null,

      /*
        Explicit metadata makes it easy for the UI to know whether
        this was ordinary conversation or current-web research.
      */
      research: weatherResult
        ? {
            query: userText,
            provider: "open_meteo",
            result_count: 1,
            verification_status: "live_source",
            source_type: "weather",
          }
        : timeResult
        ? {
            query: userText,
            provider: "runtime_clock",
            result_count: 1,
            verification_status: "live_source",
            source_type: "time",
          }
        : researchResults.length
        ? {
            query: researchQuery,
            provider: "google_news_rss",
            result_count: researchResults.length,
            verification_status: "web_sourced",
          }
        : null,
    };
  } catch (error) {
    console.error(
      "FETCH OPEN CONVERSATION AGENT ERROR:",
      error
    );

    return {
      success: false,
      status: "failed",
      message:
        error?.message ||
        "Fetch could not complete the conversation response.",
      resource_type:
        resource?.resource_type || "digital_agent",
      execution_type: "conversation",
    };
  }
}
