/*
  FETCH DIGITAL AGENT — OPEN WEB EXECUTION LAYER

  Purpose:
  - No model training.
  - No OpenAI API dependency.
  - Uses public web sources for research/news requests.
  - Optional SearXNG endpoint can be configured with SEARXNG_URL.
  - Falls back to Google News RSS when SearXNG is not configured.
  - Returns sourced results directly to Fetch.
  - Does not claim external side effects.

  ATC -> DIGITAL_AGENT -> OPEN WEB SOURCES -> RESULT
*/

const SEARXNG_URL = String(process.env.SEARXNG_URL || "").trim().replace(/\/+$/, "");

function cleanText(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function decodeXml(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function stripHtml(value) {
  return decodeXml(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTag(block, tag) {
  const re = new RegExp(
    `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,
    "i"
  );
  const match = block.match(re);
  return match ? decodeXml(match[1]).trim() : "";
}

function parseRss(xml) {
  const items = [];
  const blocks = String(xml || "").match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || [];

  for (const block of blocks) {
    const title = stripHtml(extractTag(block, "title"));
    const link = stripHtml(extractTag(block, "link"));
    const pubDate = stripHtml(extractTag(block, "pubDate"));
    const description = stripHtml(extractTag(block, "description"));

    if (!title) continue;

    items.push({
      title,
      link,
      published_at: pubDate || null,
      description: description || null,
    });
  }

  return items;
}

function escapeSearchQuery(value) {
  return encodeURIComponent(cleanText(value));
}

function looksLikeNewsRequest(text) {
  return /\b(latest|current|recent|news|today|this week|developments|updates)\b/i.test(
    cleanText(text)
  );
}

function buildGoogleNewsUrl(query) {
  return (
    "https://news.google.com/rss/search?q=" +
    escapeSearchQuery(query) +
    "&hl=en-IN&gl=IN&ceid=IN:en"
  );
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Fetch/1.0 research-agent",
    },
  });

  const raw = await response.text();

  if (!response.ok) {
    throw new Error(`Web search ${response.status}: ${raw.slice(0, 500)}`);
  }

  return JSON.parse(raw);
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/rss+xml, application/xml, text/xml, text/plain",
      "User-Agent": "Fetch/1.0 research-agent",
    },
  });

  const raw = await response.text();

  if (!response.ok) {
    throw new Error(`Web source ${response.status}: ${raw.slice(0, 500)}`);
  }

  return raw;
}

async function searchSearXNG(query) {
  if (!SEARXNG_URL) return [];

  const url =
    `${SEARXNG_URL}/search?q=${escapeSearchQuery(query)}` +
    "&format=json&language=en&categories=news";

  const data = await fetchJson(url);

  return (Array.isArray(data?.results) ? data.results : [])
    .slice(0, 8)
    .map((item) => ({
      title: cleanText(item?.title),
      link: cleanText(item?.url),
      published_at: item?.publishedDate || null,
      description: cleanText(item?.content || item?.snippet || ""),
      source: cleanText(item?.engine_name || item?.source || "web"),
    }))
    .filter((item) => item.title && item.link);
}

async function searchGoogleNews(query) {
  const xml = await fetchText(buildGoogleNewsUrl(query));
  return parseRss(xml)
    .slice(0, 8)
    .map((item) => ({
      ...item,
      source: "Google News RSS",
    }));
}

function formatResults(query, results) {
  const unique = [];
  const seen = new Set();

  for (const item of results) {
    const key = `${item.title}|${item.link}`.toLowerCase();

    if (seen.has(key)) continue;
    seen.add(key);

    unique.push(item);

    if (unique.length >= 8) break;
  }

  if (!unique.length) {
    return (
      `I couldn't find current web results for "${query}". ` +
      "Try a more specific search."
    );
  }

  const lines = [
    `Here are the latest web results I found for "${query}":`,
    "",
  ];

  unique.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.title}`);

    if (item.description) {
      lines.push(`   ${item.description.slice(0, 260)}`);
    }

    if (item.published_at) {
      lines.push(`   Published: ${item.published_at}`);
    }

    if (item.link) {
      lines.push(`   Source: ${item.link}`);
    }

    lines.push("");
  });

  lines.push(
    "These are live web results. Fetch has not independently verified the claims in each article."
  );

  return lines.join("\n").trim();
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
      message: "Digital agent requires task text.",
      resource_type: resource?.resource_type || "digital_agent",
    };
  }

  try {
    /*
     * Current-news requests use the news topic directly.
     * SearXNG is preferred when configured; Google News RSS is the
     * zero-key fallback so the agent can work without paid model credits.
     */
    let results = [];

    if (SEARXNG_URL) {
      try {
        results = await searchSearXNG(userText);
      } catch (error) {
        console.error("FETCH SEARXNG ERROR:", error);
      }
    }

    if (!results.length) {
      results = await searchGoogleNews(userText);
    }

    const answer = formatResults(userText, results);

    return {
      success: true,
      status: "completed",
      message: answer,
      result: answer,
      resource_type: resource?.resource_type || "digital_agent",
      execution_type: "open_web_research",
      side_effect: false,
      provider: SEARXNG_URL ? "searxng_or_google_news_rss" : "google_news_rss",
      model: null,
      web_search: true,
      result_count: results.length,
      duration_ms: Date.now() - startedAt,
    };
  } catch (error) {
    console.error("FETCH OPEN WEB DIGITAL AGENT ERROR:", error);

    return {
      success: false,
      status: "failed",
      message:
        error?.message ||
        "Fetch could not retrieve current web information.",
      resource_type: resource?.resource_type || "digital_agent",
      execution_type: "open_web_research",
      side_effect: false,
    };
  }
}
