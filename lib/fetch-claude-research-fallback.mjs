/* FETCH CLAUDE RESEARCH FALLBACK — V2
 *
 * Purpose:
 * - Give Fetch a reliable general-purpose live-information fallback.
 * - Use Claude + web search when a specialized connector is unavailable
 *   or fails.
 * - Never claim a physical side effect was completed.
 */

const ANTHROPIC_API_KEY = String(process.env.ANTHROPIC_API_KEY || "").trim();
const ANTHROPIC_WORKSPACE_ID = String(process.env.ANTHROPIC_WORKSPACE_ID || "").trim();
const CLAUDE_MODEL = String(process.env.FETCH_RESEARCH_MODEL || "claude-sonnet-5").trim();

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function buildPrompt({ text, sourcePolicy = {}, connectorFailure = null } = {}) {
  return `
You are Fetch's general live-information fallback.

User request:
${clean(text)}

Source policy:
${JSON.stringify(sourcePolicy || {}, null, 2)}

Specialized connector status:
${clean(connectorFailure || "None")}

Rules:
1. Answer the user's actual question directly.
2. Use live web search whenever the request involves current, changing, local, scheduled, price, availability, news, sports, weather, travel, company, product, legal, or other externally verifiable information.
3. Prefer authoritative primary sources when available.
4. Do not invent facts, times, prices, availability, events, or sources.
5. If a specialized connector failed, do not expose internal connector names or technical errors unless they materially explain an unavailable result.
6. If current information cannot be verified, say so clearly and give the best supported answer.
7. Keep the answer concise and user-ready. Default to 2-5 short bullets or 2-4 short sentences.
8. Put the direct answer first. Do not write a long introduction or recap.
9. For current news, sports, travel, or event questions: give only the most relevant 3-5 findings unless the user asks for more.
10. For simple factual questions: answer in 1-3 sentences.
11. Use short bullets with one idea per line. Avoid dense paragraphs.
12. Include a compact Sources section with at most 3 sources when web sources are available.
`.trim();
}

function extractText(content) {
  return (Array.isArray(content) ? content : [])
    .filter((block) => block?.type === "text")
    .map((block) => clean(block.text))
    .filter(Boolean)
    .join("\n\n");
}

function extractCitations(content) {
  const output = [];
  const seen = new Set();

  for (const block of Array.isArray(content) ? content : []) {
    for (const citation of Array.isArray(block?.citations) ? block.citations : []) {
      if (!citation?.url || seen.has(citation.url)) continue;
      seen.add(citation.url);
      output.push({
        url: citation.url,
        title: citation.title || "Web source",
        cited_text: citation.cited_text || "",
      });
    }
  }

  return output;
}

export async function executeClaudeResearchFallback({
  text,
  sourcePolicy = {},
  connectorFailure = null,
} = {}) {
  if (!ANTHROPIC_API_KEY) {
    return {
      success: false,
      status: "not_configured",
      execution_type: "claude_web_research",
      message: "Fetch's live research fallback is not configured.",
    };
  }

  if (!clean(text)) {
    return {
      success: false,
      status: "invalid_request",
      execution_type: "claude_web_research",
      message: "Fetch could not create a research request.",
    };
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        ...(ANTHROPIC_WORKSPACE_ID ? { "anthropic-workspace-id": ANTHROPIC_WORKSPACE_ID } : {}),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 1200,
        messages: [{
          role: "user",
          content: buildPrompt({ text, sourcePolicy, connectorFailure }),
        }],
        tools: [{
          type: "web_search_20260318",
          name: "web_search",
          max_uses: 6,
          allowed_callers: ["direct"],
        }],
      }),
    });

    const raw = await response.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = { raw }; }

    if (!response.ok) {
      const message = clean(data?.error?.message || data?.message || data?.raw || `Claude returned HTTP ${response.status}.`);
      console.error("FETCH CLAUDE FALLBACK ERROR:", response.status, message);
      return {
        success: false,
        status: "research_failed",
        execution_type: "claude_web_research",
        message: "Fetch could not retrieve the latest information right now.",
        diagnostics: { http_status: response.status, model: CLAUDE_MODEL },
      };
    }

    const message = extractText(data?.content);
    const citations = extractCitations(data?.content);

    if (!message) {
      return {
        success: false,
        status: "empty_research_result",
        execution_type: "claude_web_research",
        message: "Fetch could not produce a verified answer from the available sources.",
      };
    }

    return {
      success: true,
      status: "completed",
      execution_type: "claude_web_research",
      model: CLAUDE_MODEL,
      message,
      citations,
      checked_at: new Date().toISOString(),
    };
  } catch (error) {
    console.error("FETCH CLAUDE FALLBACK NETWORK ERROR:", error);
    return {
      success: false,
      status: "research_unreachable",
      execution_type: "claude_web_research",
      message: "Fetch could not reach its live research source right now.",
    };
  }
}
