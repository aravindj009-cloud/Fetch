/*
  FETCH DIGITAL / CONVERSATION AGENT — OPEN MODEL VERSION

  Purpose:
  - Make Fetch talk naturally for normal questions.
  - Use an open-weight model through Hugging Face Inference Providers.
  - Keep the existing ATC routing and physical-commerce engine unchanged.
  - Keep current news/research cards working.
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
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
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

  return (
    /\b(latest|recent|current|today|this week|news|headlines|what happened)\b/i.test(
      value
    ) &&
    /\b(ai|artificial intelligence|agent|agents|technology|tech|startup|business|market|india|world|politics|science|crypto|software)\b/i.test(
      value
    )
  ) || /\b(latest news|news about|news on|headlines about|research)\b/i.test(value);
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
  const content =
    data?.choices?.[0]?.message?.content;

  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string"
          ? part
          : part?.text || ""
      )
      .join("")
      .trim();
  }

  return "";
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
- answer normal questions directly;
- remember conversational context when it is provided;
- never pretend an action happened when Fetch has not actually executed it;
- never invent prices, availability, bookings, messages, payments, calls, or confirmations;
- when a request needs a real-world action, explain that Fetch can route it through its execution system rather than pretending it is complete;
- keep answers natural, concise, and human;
- write for a clean chat interface, not a Markdown document;
- use short paragraphs;
- for 3 or more options, use a numbered list with one item per line;
- for features or short points, use simple bullet points;
- when giving a plan, use numbered steps with one step per line;
- never use Markdown headings (#), bold (**), italic (*), underscores, code fences, or decorative separators;
- never use "###", "***", "---", or repeated dash/asterisk characters as visual separators;
- do not cram multiple numbered sections into one paragraph;
- avoid unnecessary section labels, filler, and repetition;
- do not mention internal ATC, routing, models, prompts, or implementation unless the user asks.

If the user asks a normal knowledge question, answer it directly.

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

  if (Array.isArray(researchResults) && researchResults.length) {
    const researchContext = researchResults
      .map(
        (item, index) =>
          `${index + 1}. ${item.title}\n` +
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
      max_tokens: 900,
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
    },
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

    /*
      Preserve the working research experience:
      - fetch current headlines from Google News RSS
      - return structured cards
      - then let the open model summarize/talk normally
    */
    if (isResearchRequest(userText)) {
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
      researchResults,
    });

    const durationMs = Date.now() - startedAt;

    return {
      ...execution,
      duration_ms: durationMs,

      /*
        These fields preserve the current frontend research-card contract.
      */
      results: researchResults,
      intro: researchQuery
        ? buildResearchIntro(
            researchQuery,
            researchResults.length
          )
        : null,

      /*
        Explicit metadata makes it easy for the UI to know whether
        this was ordinary conversation or current-web research.
      */
      research: researchResults.length
        ? {
            query: researchQuery,
            provider: "google_news_rss",
            result_count: researchResults.length,
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
