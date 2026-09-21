/*
  FETCH DIGITAL AGENT — MVP EXECUTION LAYER

  Purpose:
  - Gives ATC a real digital execution target.
  - Uses the existing server-side OPENAI_API_KEY.
  - Handles digital/information requests without touching the
    existing physical shopping state machine.
  - Can optionally use OpenAI web search for current information.
  - Never exposes provider credentials to the browser.
  - Never claims an external side effect occurred unless this
    connector itself completed it.

  This is the first live DIGITAL NETWORK implementation for Fetch.
*/

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_DIGITAL_MODEL || "gpt-5.6-luna";
const OPENAI_URL = "https://api.openai.com/v1/responses";

function cleanText(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function extractOutputText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const parts = [];

  for (const item of Array.isArray(data?.output) ? data.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if (typeof content?.text === "string" && content.text.trim()) {
        parts.push(content.text.trim());
      }
    }
  }

  return parts.join("\n").trim();
}

function shouldUseWebSearch(text, context = {}) {
  if (context.use_web_search === true) return true;

  const value = cleanText(text).toLowerCase();

  return /\b(today|latest|current|now|news|price|weather|opening hours|available|availability|recent|this week|tomorrow)\b/i.test(
    value
  );
}

function buildInstructions({ task, context = {} }) {
  const goal = cleanText(task?.goal || task?.objective || task?.source_text || "");
  const channel = cleanText(context.channel || "api");

  return `
You are the Fetch Digital Agent.

Fetch is a personal agent that receives a user's request and delegates
digital work through an ATC execution layer.

Your job in this connector is to perform DIGITAL information/research work
and return a useful result to Fetch.

Rules:
1. Answer the user's actual request directly.
2. Be concise and useful.
3. Do not claim that you booked, purchased, cancelled, sent, called, or
   changed anything in an external service unless this connector actually
   performed that side effect.
4. If the request requires an external account, payment, authentication,
   or unavailable API, clearly say that the action needs a connected
   provider instead of pretending it happened.
5. Never invent prices, availability, people, businesses, or confirmations.
6. If current information is needed and web search is enabled, use it.
7. Return plain text suitable for Fetch to send back to the customer.
8. Channel: ${channel}
9. User request: ${goal}
`.trim();
}

export async function executeDigitalAgent({
  task = {},
  route = {},
  resource = {},
  context = {},
} = {}) {
  const startedAt = Date.now();

  if (!OPENAI_API_KEY) {
    return {
      success: false,
      status: "failed",
      message: "OPENAI_API_KEY is missing.",
      resource_type: resource?.resource_type || "digital_agent",
    };
  }

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

  const useWebSearch = shouldUseWebSearch(userText, context);

  const body = {
    model: OPENAI_MODEL,
    input: [
      {
        role: "developer",
        content: buildInstructions({ task, context }),
      },
      {
        role: "user",
        content: userText,
      },
    ],
    max_output_tokens: 900,
    store: false,
  };

  if (useWebSearch) {
    body.tools = [{ type: "web_search" }];
  }

  try {
    console.log(
      "FETCH DIGITAL AGENT START:",
      JSON.stringify({
        resource_type: resource?.resource_type || "digital_agent",
        resource_id: route?.resource_id || resource?.id || null,
        web_search: useWebSearch,
      })
    );

    const response = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
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
        `OpenAI ${response.status}: ${
          typeof data === "string" ? data : JSON.stringify(data)
        }`
      );
    }

    const resultText = extractOutputText(data);

    if (!resultText) {
      return {
        success: false,
        status: "failed",
        message: "Digital agent returned no usable text.",
        resource_type: resource?.resource_type || "digital_agent",
        response_id: data?.id || null,
      };
    }

    const durationMs = Date.now() - startedAt;

    console.log(
      "FETCH DIGITAL AGENT COMPLETED:",
      JSON.stringify({
        response_id: data?.id || null,
        duration_ms: durationMs,
        web_search: useWebSearch,
      })
    );

    return {
      success: true,
      status: "completed",
      message: resultText,
      result: resultText,
      resource_type: resource?.resource_type || "digital_agent",
      response_id: data?.id || null,
      duration_ms: durationMs,
      execution_metadata: {
        provider: "openai",
        model: OPENAI_MODEL,
        web_search: useWebSearch,
      },
    };
  } catch (error) {
    console.error("FETCH DIGITAL AGENT ERROR:", error);

    return {
      success: false,
      status: "failed",
      message: error?.message || "Digital agent execution failed.",
      resource_type: resource?.resource_type || "digital_agent",
    };
  }
}
