/*
  FETCH DIGITAL AGENT V2 — OPEN WEB EXECUTION LAYER

  Purpose:
  - No model training.
  - No OpenAI API dependency.
  - Uses public/open web sources.
  - Uses SearXNG when SEARXNG_URL is configured.
  - Uses Google News RSS for current/news queries when SearXNG is unavailable.
  - Uses Wikipedia search as a lightweight fallback for general knowledge queries.
  - Produces clean, compact research output for the Fetch UI.

  ATC -> DIGITAL_AGENT -> OPEN WEB SOURCES -> STRUCTURED RESULT
*/

const SEARXNG_URL = String(process.env.SEARXNG_URL || "").trim().replace(/\/+$/, "");

function cleanText(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeXml(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .trim();
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
  const blocks =
    String(xml || "").match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || [];

  for (const block of blocks) {
    const title = stripHtml(extractTag(block, "title"));
    const link = stripHtml(extractTag(block, "link"));
    const pubDate = stripHtml(extractTag(block, "pubDate"));
    const description = stripHtml(extractTag(block, "description"));
    const source = stripHtml(extractTag(block, "source"));

    if (!title) continue;

    items.push({
      title,
      link,
      published_at: pubDate || null,
      description: description || null,
      source: source || "Google News",
    });
  }

  return items;
}

function escapeSearchQuery(value) {
  return encodeURIComponent(cleanText(value));
}

function isNewsRequest(text) {
  return /\b(latest|current|recent|news|today|this week|this month|developments|updates|breaking)\b/i.test(
    cleanText(text)
  );
}

function buildSearchQuery(text) {
  const original = cleanText(text);

  return original
    .replace(/^research\s+/i, "")
    .replace(/^find\s+/i, "")
    .replace(/^search\s+(for\s+)?/i, "")
    .replace(/\bthe\s+latest\s+/i, "")
    .replace(/\blatest\s+/i, "")
    .replace(/\bcurrent\s+/i, "")
    .replace(/\bnews\b/gi, "")
    .replace(/\bupdates\b/gi, "")
    .replace(/\bdevelopments\b/gi, "")
    .replace(/\s+/g, " ")
    .trim() || original;
}

function buildGoogleNewsUrl(query) {
  return (
    "https://news.google.com/rss/search?q=" +
    escapeSearchQuery(query) +
    "&hl=en-IN&gl=IN&ceid=IN:en"
  );
}

function buildWikipediaSearchUrl(query) {
  return (
    "https://en.wikipedia.org/w/api.php?action=query&list=search" +
    "&srsearch=" +
    escapeSearchQuery(query) +
    "&srlimit=8&format=json&origin=*"
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

async function searchSearXNG(query, newsMode) {
  if (!SEARXNG_URL) return [];

  const category = newsMode ? "news" : "general";
  const url =
    `${SEARXNG_URL}/search?q=${escapeSearchQuery(query)}` +
    `&format=json&language=en&categories=${category}`;

  const data = await fetchJson(url);

  return (Array.isArray(data?.results) ? data.results : [])
    .slice(0, 8)
    .map((item) => ({
      title: cleanText(item?.title),
      link: cleanText(item?.url),
      published_at: item?.publishedDate || null,
      description: cleanText(item?.content || item?.snippet || ""),
      source: cleanText(item?.source || item?.engine_name || "Web"),
    }))
    .filter((item) => item.title && item.link);
}

async function searchGoogleNews(query) {
  const xml = await fetchText(buildGoogleNewsUrl(query));

  return parseRss(xml)
    .slice(0, 8)
    .map((item) => ({
      ...item,
      source: item.source || "Google News",
    }));
}

async function searchWikipedia(query) {
  const data = await fetchJson(buildWikipediaSearchUrl(query));
  const results = Array.isArray(data?.query?.search) ? data.query.search : [];

  return results.slice(0, 8).map((item) => ({
    title: cleanText(item?.title),
    link:
      "https://en.wikipedia.org/wiki/" +
      encodeURIComponent(String(item?.title || "").replace(/\s+/g, "_")),
    published_at: null,
    description: stripHtml(item?.snippet || ""),
    source: "Wikipedia",
  }));
}

function dedupeResults(results) {
  const unique = [];
  const seen = new Set();

  for (const item of Array.isArray(results) ? results : []) {
    const key = `${cleanText(item?.title)}|${cleanText(item?.link)}`.toLowerCase();

    if (!item?.title || !item?.link || seen.has(key)) continue;

    seen.add(key);
    unique.push({
      title: cleanText(item.title),
      link: cleanText(item.link),
      published_at: cleanText(item.published_at || "") || null,
      description: cleanText(item.description || "") || null,
      source: cleanText(item.source || "Web"),
    });

    if (unique.length >= 8) break;
  }

  return unique;
}

function formatDate(value) {
  if (!value) return null;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

function formatResults(query, results, provider) {
  const unique = dedupeResults(results);

  if (!unique.length) {
    return {
      text:
        `I couldn't find useful web results for "${query}". ` +
        "Try a more specific request.",
      results: [],
    };
  }

  const lines = [`Here’s what I found for “${query}”:`, ""];

  unique.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.title}`);

    if (item.description) {
      const description = item.description.slice(0, 300);
      lines.push(`   ${description}${item.description.length > 300 ? "…" : ""}`);
    }

    const date = formatDate(item.published_at);
    lines.push(`   Source: ${item.source}${date ? ` · ${date}` : ""}`);
    lines.push(`   ${item.link}`);
    lines.push("");
  });

  lines.push(
    provider === "searxng"
      ? "Fetched through the configured open-web search layer."
      : "Fetched from public web sources. Fetch has not independently verified every claim."
  );

  return {
    text: lines.join("\n").trim(),
    results: unique,
  };
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

  const query = buildSearchQuery(userText);
  const newsMode = isNewsRequest(userText);

  try {
    let results = [];
    let provider = "";

    if (SEARXNG_URL) {
      try {
        results = await searchSearXNG(query, newsMode);
        if (results.length) provider = "searxng";
      } catch (error) {
        console.error("FETCH SEARXNG ERROR:", error);
      }
    }

    if (!results.length && newsMode) {
      try {
        results = await searchGoogleNews(query);
        if (results.length) provider = "google_news_rss";
      } catch (error) {
        console.error("FETCH GOOGLE NEWS ERROR:", error);
      }
    }

    if (!results.length && !newsMode) {
      try {
        results = await searchWikipedia(query);
        if (results.length) provider = "wikipedia";
      } catch (error) {
        console.error("FETCH WIKIPEDIA ERROR:", error);
      }
    }

    const formatted = formatResults(query, results, provider);

    return {
      success: true,
      status: "completed",
      message: formatted.text,
      result: formatted.text,
      results: formatted.results,
      query,
      resource_type: resource?.resource_type || "digital_agent",
      execution_type: "open_web_research",
      side_effect: false,
      provider: provider || "open_web",
      model: null,
      web_search: true,
      result_count: formatted.results.length,
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
