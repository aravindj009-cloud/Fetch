import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import FetchOnboarding from "./FetchOnboarding.jsx";

const starters = [
  "Get me 2 KitKats and milk",
  "Find the latest news about AI agents",
  "Find me a good restaurant for tonight",
  "Remember that I prefer things after 7 PM"
];

const makeId = () =>
  `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const API_URL = "/api/web/agent.mjs";
async function readApiJson(response) {
  const contentType = response.headers.get("content-type") || "";
  const body = await response.text();
  if (!contentType.toLowerCase().includes("application/json")) {
    const excerpt = body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 150);
    throw new Error(
      `Fetch API returned ${response.status} instead of JSON at ${response.url}. ` +
      `Check that api/web/agent.mjs is deployed on this domain. ${excerpt}`
    );
  }
  try {
    return JSON.parse(body);
  } catch (_) {
    throw new Error(`Fetch API returned invalid JSON (HTTP ${response.status}) at ${response.url}`);
  }
}

const ACTIVE_ORDER_KEY = "fetch_active_order_id";
const ORDER_POLL_INTERVAL_MS = 3000;
const MAX_ORDER_CHECKS = 600;

function getConversationId() {
  const existing = localStorage.getItem("fetch_conversation_id");

  if (existing) {
    return existing;
  }

  const created = `web:${makeId()}`;
  localStorage.setItem("fetch_conversation_id", created);

  return created;
}


function normalizeAssistantText(value) {
  if (typeof value === "string") return value;

  if (value == null) return "";

  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeAssistantText(item))
      .filter(Boolean)
      .join("\n");
  }

  if (typeof value === "object") {
    const preferred =
      value.text ??
      value.content ??
      value.message ??
      value.result ??
      value.answer;

    if (preferred !== undefined) {
      return normalizeAssistantText(preferred);
    }

    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  return String(value);
}

function isObjectString(value) {
  return typeof value === "string" && /^\[object Object\]$/i.test(value.trim());
}

function extractApiMessage(payload) {
  const seen = new Set();

  function visit(value, depth = 0) {
    if (depth > 8 || value == null) return "";

    if (typeof value === "string") {
      const text = value.trim();
      return isObjectString(text) ? "" : text;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item, depth + 1);
        if (found) return found;
      }
      return "";
    }

    if (typeof value === "object") {
      if (seen.has(value)) return "";
      seen.add(value);

      const preferredKeys = [
        "message",
        "text",
        "content",
        "answer",
        "result",
        "output",
      ];

      for (const key of preferredKeys) {
        const found = visit(value[key], depth + 1);
        if (found) return found;
      }

      for (const key of Object.keys(value)) {
        if (preferredKeys.includes(key)) continue;
        const found = visit(value[key], depth + 1);
        if (found) return found;
      }
    }

    return "";
  }

  return visit(payload);
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function getHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "Web source";
  }
}

function parseResearchResults(text) {
  const raw = decodeEntities(text);

  if (
    !/here[’']s what i found/i.test(raw) &&
    !/i found these recent results/i.test(raw)
  ) {
    return null;
  }

  const results = [];
  const itemPattern = /(?:^|\s)(\d+)\.\s+([\s\S]*?)(?=\s+\d+\.\s+|$)/g;
  let match;

  while ((match = itemPattern.exec(raw)) !== null) {
    const number = Number(match[1]);
    let content = match[2].trim();

    const urlMatch = content.match(/https?:\/\/\S+/i);
    const url = urlMatch ? urlMatch[0].replace(/[),.;]+$/, "") : "";

    if (urlMatch) {
      content = content.replace(urlMatch[0], " ").trim();
    }

    // The backend may include a human-readable "Link:" label before
    // the URL. The URL is rendered separately as the Read source button,
    // so remove that label from the metadata text.
    content = content.replace(/\s*\bLink:\s*$/i, "").trim();

    let published = "";
    let source = "";

    // Support the current Fetch research format:
    // "Title Source: Publisher Published: Tue, 22 Sep 2026 ..."
    const publishedMatch = content.match(
      /\s+Published:\s*(.+?)\s*$/i
    );

    if (publishedMatch) {
      published = publishedMatch[1].trim();
      content = content.slice(0, publishedMatch.index).trim();
    }

    const sourceMatch = content.match(
      /\s+Source:\s*(.+?)\s*$/i
    );

    if (sourceMatch) {
      source = sourceMatch[1].trim();
      content = content.slice(0, sourceMatch.index).trim();
    }

    // Older research responses used "Source: X · 22 Sep 2026".
    if (!source || !published) {
      const sourceDateMatch = content.match(
        /\s+Source:\s*(.*?)\s*[·|-]\s*(\d{1,2}\s+[A-Za-z]{3,4}\s+\d{4})\s*$/i
      );

      if (sourceDateMatch) {
        source = source || sourceDateMatch[1].trim();
        published = published || sourceDateMatch[2].trim();
        content = content.slice(0, sourceDateMatch.index).trim();
      }
    }

    if (!source && url) {
      source = getHost(url);
    }

    // RSS titles often contain the headline followed by the publisher's
    // repeated headline/context. Use the first clean headline and retain
    // only a short context sentence when available.
    const separators = /\s+(?:–|—)\s+/;
    const parts = content.split(separators).map((part) => part.trim()).filter(Boolean);

    let title = parts[0] || content;
    let summary = parts.slice(1).join(" — ");

    // Remove duplicated headline text caused by Google News RSS.
    const lowerTitle = title.toLowerCase();
    if (summary.toLowerCase().startsWith(lowerTitle)) {
      summary = summary.slice(title.length).trim();
    }

    // Keep cards compact. The complete article is available through the link.
    title = title.replace(/\s+/g, " ").trim();
    summary = summary.replace(/\s+/g, " ").trim();

    // Google News commonly appends the publisher to the headline itself.
    // Keep publisher only in the metadata row.
    if (source) {
      const lowerTitleValue = title.toLowerCase();
      const lowerSourceValue = source.toLowerCase();
      for (const separator of [" - ", " – ", " — "]) {
        const suffix = separator + lowerSourceValue;
        if (lowerTitleValue.endsWith(suffix)) {
          title = title.slice(0, title.length - suffix.length).trim();
          break;
        }
      }
    }

    // RSS feeds often contain several related headlines in one item.
    // Do not dump that noisy feed text into the customer chat.
    if (summary.length > 160) {
      summary = summary.slice(0, 157).trimEnd() + "…";
    }

    results.push({
      number,
      title: title.slice(0, 180),
      summary: summary.slice(0, 240),
      source: source || "Web",
      published,
      url
    });

    if (results.length >= 8) break;
  }

  return results.length ? results : null;
}

function renderInline(text, keyPrefix = "inline") {
  const value = String(text || "");
  const tokenPattern = /(\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^)]+\)|https?:\/\/[^\s<]+|\*[^*]+\*)/g;
  const parts = value.split(tokenPattern);

  return parts.map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (/^\*\*[^*]+\*\*$/.test(part)) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    const markdownLink = part.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/);
    if (markdownLink) {
      return <a key={key} href={markdownLink[2]} target="_blank" rel="noopener noreferrer" className="messageLink">{markdownLink[1]} ↗</a>;
    }
    if (/^https?:\/\//i.test(part)) {
      const cleanUrl = part.replace(/[),.;]+$/, "");
      return <a key={key} href={cleanUrl} target="_blank" rel="noopener noreferrer" className="messageLink">{getHost(cleanUrl)} ↗</a>;
    }
    if (/^\*[^*]+\*$/.test(part)) {
      return <em key={key}>{part.slice(1, -1)}</em>;
    }
    return <React.Fragment key={key}>{part}</React.Fragment>;
  });
}

function FormattedAssistantMessage({ text }) {
  const normalized = normalizeAssistantText(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!normalized) return null;

  const lines = normalized.split("\n");
  const blocks = [];
  let listItems = [];

  const flushList = () => {
    if (!listItems.length) return;
    blocks.push(
      <ul className="messageList" key={`list-${blocks.length}`}>
        {listItems.map((item, index) => (
          <li key={`item-${index}`}>{renderInline(item, `list-${index}`)}</li>
        ))}
      </ul>
    );
    listItems = [];
  };

  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) {
      flushList();
      return;
    }

    const bullet = line.match(/^(?:[-•*])\s+(.+)$/);
    if (bullet) {
      listItems.push(bullet[1]);
      return;
    }

    flushList();

    const heading = line.match(/^#{1,3}\s+(.+)$/);
    if (heading) {
      blocks.push(<h4 className="messageHeading" key={`heading-${index}`}>{renderInline(heading[1], `heading-${index}`)}</h4>);
      return;
    }

    const numbered = line.match(/^\d+[.)]\s+(.+)$/);
    if (numbered) {
      blocks.push(
        <div className="messageNumbered" key={`number-${index}`}>
          <span>{line.match(/^\d+/)[0]}</span>
          <div>{renderInline(numbered[1], `number-${index}`)}</div>
        </div>
      );
      return;
    }

    blocks.push(<p className="messageParagraph" key={`paragraph-${index}`}>{renderInline(line, `paragraph-${index}`)}</p>);
  });

  flushList();
  return <div className="formattedMessage">{blocks}</div>;
}

function ResearchResults({ text, citations = [] }) {
  const safeText = normalizeAssistantText(text);
  const results = parseResearchResults(safeText);

  if (!results) {
    return <>{safeText}</>;
  }

  return (
    <div className="researchResults">
      <div className="researchIntro">
        <strong>Here’s what I found</strong>
        <span>Latest web results</span>
      </div>

      <div className="researchList">
        {results.map((result) => (
          <article
            className="researchCard"
            key={`${result.number}-${result.url || result.title}`}
          >
            <div className="researchNumber">
              {String(result.number).padStart(2, "0")}
            </div>

            <div className="researchBody">
              <h3>{result.title}</h3>

              {result.summary && <p>{result.summary}</p>}

              <div className="researchMeta">
                <span>{result.source}</span>
                {result.published && <span>· {result.published}</span>}
              </div>

              {(() => {
                const citation =
                  citations.find((item) => Number(item?.number) === result.number) ||
                  citations[result.number - 1] ||
                  citations.find((item) =>
                    String(item?.title || "").toLowerCase().includes(result.title.toLowerCase().slice(0, 40))
                  );
                const sourceUrl = result.url || citation?.url || citation?.link || citation?.source_url || "";
                if (!sourceUrl) return null;
                return (
                  <a
                    href={sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="researchLink"
                    aria-label={`Read source: ${result.title}`}
                  >
                    Read source ↗
                  </a>
                );
              })()}
            </div>
          </article>
        ))}
      </div>

      <div className="researchDisclaimer">
        Fetch found these live web results. The underlying claims have not been independently verified by Fetch.
      </div>
    </div>
  );
}

export default function App() {
  const [showOnboarding, setShowOnboarding] = useState(() => {
    try { return localStorage.getItem("fetch_onboarding_v2_complete") !== "1"; } catch { return true; }
  });
  const [messages, setMessages] = useState([
    {
      id: "welcome",
      role: "assistant",
      text: "Hi, I’m Fetch. Tell me what you need done.",
      meta: null
    }
  ]);

  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [task, setTask] = useState(null);
  const [agentTasks, setAgentTasks] = useState([]);
  const [agentTaskId, setAgentTaskId] = useState(null);
  const [taskCenterOpen, setTaskCenterOpen] = useState(false);
  const [selectedAgentTask, setSelectedAgentTask] = useState(null);

  const activeWatchRef = useRef(null);
  const lastOrderMessageRef = useRef(new Map());

  const inputRef = useRef(null);
  const recognitionRef = useRef(null);
  const conversationRef = useRef(getConversationId());

  async function refreshAgentTasks() {
    try {
      const response = await fetch(
        `/api/fetch/tasks?conversation_id=${encodeURIComponent(conversationRef.current)}&channel=web&limit=10`,
        { cache: "no-store", headers: { Accept: "application/json" } }
      );
      const data = await readApiJson(response);
      if (response.ok && data?.success) {
        setAgentTasks(Array.isArray(data.tasks) ? data.tasks : []);
      }
    } catch (error) {
      console.error("FETCH TASK LEDGER ERROR", error);
    }
  }

  async function refreshAgentTask(taskId) {
    if (!taskId) return;
    try {
      const response = await fetch(
        `/api/fetch/tasks?task_id=${encodeURIComponent(taskId)}`,
        { cache: "no-store", headers: { Accept: "application/json" } }
      );
      const data = await readApiJson(response);
      if (response.ok && data?.success && data.task) {
        setAgentTaskId(taskId);
        setAgentTasks((current) => {
          const next = current.filter((item) => item.id !== taskId);
          return [data.task, ...next].slice(0, 10);
        });
      }
    } catch (error) {
      console.error("FETCH TASK ERROR", error);
    }
  }

  useEffect(() => {
    refreshAgentTasks();
    const timer = window.setInterval(() => {
      refreshAgentTasks();
      if (taskCenterOpen && selectedAgentTask?.id) {
        openAgentTask(selectedAgentTask.id);
      }
    }, 3000);

    return () => window.clearInterval(timer);
  }, [taskCenterOpen, selectedAgentTask?.id]);

  async function openAgentTask(taskId) {
    if (!taskId) return;
    try {
      const response = await fetch(
        `/api/fetch/tasks?task_id=${encodeURIComponent(taskId)}`,
        { cache: "no-store", headers: { Accept: "application/json" } }
      );
      const data = await readApiJson(response);
      if (response.ok && data?.success && data.task) {
        setSelectedAgentTask(data.task);
        setTaskCenterOpen(true);
      }
    } catch (error) {
      console.error("FETCH TASK CENTER ERROR", error);
    }
  }

  async function taskAction(taskId, action) {
    if (!taskId) return;
    try {
      const response = await fetch("/api/fetch/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ task_id: taskId, action })
      });
      const data = await readApiJson(response);
      if (response.ok && data?.success && data.task) {
        setSelectedAgentTask(data.task);
        await refreshAgentTasks();
      }
    } catch (error) {
      console.error("FETCH TASK ACTION ERROR", error);
    }
  }

  async function refreshSelectedTask() {
    if (!selectedAgentTask?.id) return;
    await openAgentTask(selectedAgentTask.id);
  }

  async function send(rawText) {
    const text = String(rawText || "").trim();

    if (!text || busy) {
      return;
    }

    const conversationHistory = messages
      .slice(-10)
      .map((message) => ({
        role: message.role,
        content: normalizeAssistantText(message.text || "")
      }))
      .filter((message) => message.content);

    setMessages((current) => [
      ...current,
      {
        id: makeId(),
        role: "user",
        text,
        meta: null
      }
    ]);

    setInput("");
    setBusy(true);

    setTask({
      text,
      stage: "understanding",
      status: "working"
    });

    try {
      const isPhysicalRequest =
        /\b(buy|get|fetch|bring|pick up|pickup|purchase|deliver|delivery|order|need|source|find)\b/i.test(text) &&
        !/\b(news|restaurant|weather|remember|calendar|book a flight|research|explain)\b/i.test(text);

      let latitude = null;
      let longitude = null;

      if (isPhysicalRequest && navigator.geolocation) {
        const position = await new Promise((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(
            resolve,
            reject,
            {
              enableHighAccuracy: true,
              timeout: 10000,
              maximumAge: 60000
            }
          );
        }).catch(() => null);

        if (position?.coords) {
          latitude = position.coords.latitude;
          longitude = position.coords.longitude;
        }
      }

      const response = await fetch(
        API_URL,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json"
          },
          body: JSON.stringify({
            text,
            conversationId: conversationRef.current,
            channel: "web",
            latitude,
            longitude,
            conversationHistory,
            activeTask: task
          })
        }
      );

      const data = await readApiJson(response);

      if (!response.ok || !data?.success) {
        // For backend failures, prefer the explicit error field over
        // generic status values such as "server_error".
        const apiError =
          normalizeAssistantText(data?.error) ||
          normalizeAssistantText(data?.details) ||
          extractApiMessage(data) ||
          "Fetch request failed";

        throw new Error(apiError);
      }

      if (data?.agent_task_id) {
        setAgentTaskId(data.agent_task_id);
        refreshAgentTask(data.agent_task_id);
      }

      const route =
        data?.atc?.resource_type ||
        data?.atc?.network ||
        data?.fetch?.intent?.domain ||
        "agent";

      const stage =
        data.status === "completed"
          ? "done"
          : data.status === "needs_clarification"
            ? "needs input"
            : data.status === "needs_location"
              ? "location needed"
              : data.status === "partner_offered"
                ? "partner store contacted"
                : data.status === "awaiting_customer_price_confirmation"
                  ? "price ready for approval"
                  : data.status === "finding_shopper"
                    ? "finding shopper"
                    : data.status === "shopper_assigned"
                      ? "shopper assigned"
                      : data.status === "payment_pending"
                        ? "payment pending"
                        : data.status === "awaiting_agent_approval"
                          ? "waiting for your approval"
                        : data.status === "shopping"
                        ? "shopping"
                        : data.status === "out_for_delivery"
                          ? "out for delivery"
                          : data.status === "delivered"
                            ? "delivered"
                            : "coordinating";

      setTask({
        text,
        stage,
        status: data.status,
        network: route,
        workflowId: data.workflow_id,
        orderId: data.orderId || data.order_id || null
      });

      setMessages((current) => [
        ...current,
        {
          id: makeId(),
          role: "assistant",
          text:
            extractApiMessage(data) ||
            "I’m working on that.",
          citations: [
            ...(Array.isArray(data.citations) ? data.citations : []),
            ...(Array.isArray(data.sources) ? data.sources : []),
            ...(Array.isArray(data.execution?.citations) ? data.execution.citations : []),
            ...(Array.isArray(data.execution?.sources) ? data.execution.sources : []),
            ...(Array.isArray(data.task?.sources) ? data.task.sources : []),
            ...(Array.isArray(data.fetch?.sources) ? data.fetch.sources : []),
          ].filter((item, index, array) => {
            const url = item?.url || item?.link || item?.source_url || item?.uri;
            return url && array.findIndex((candidate) =>
              (candidate?.url || candidate?.link || candidate?.source_url || candidate?.uri) === url
            ) === index;
          }),
          meta: {
            status: data.status,
            network: route
          }
        }
      ]);

      const resolvedOrderId =
        data.orderId || data.order_id || null;

      if (resolvedOrderId) {
        localStorage.setItem(ACTIVE_ORDER_KEY, resolvedOrderId);
        watchOrder(resolvedOrderId, text, extractApiMessage(data) || "", data.status || "");
      }
    } catch (error) {
      console.error("FETCH UI ERROR", error);

      setTask({
        text,
        stage: "error",
        status: "error"
      });

      setMessages((current) => [
        ...current,
        {
          id: makeId(),
          role: "assistant",
          text:
            isObjectString(error?.message)
              ? "Fetch received an unexpected response from the agent. Please try again."
              : error?.message ||
                "I couldn’t process that right now.",
          meta: {
            status: "error"
          }
        }
      ]);
    } finally {
      refreshAgentTasks();
      setBusy(false);

      setTimeout(() => {
        inputRef.current?.focus();
      }, 0);
    }
  }

  async function watchOrder(orderId, originalText = "", initialMessage = "", initialStatus = "") {
    if (!orderId) return;

    // Never create two polling loops for the same order.
    if (activeWatchRef.current === orderId) {
      return;
    }

    activeWatchRef.current = orderId;
    if (initialMessage) {
      lastOrderMessageRef.current.set(orderId, String(initialStatus || "unknown") + "::" + normalizeAssistantText(initialMessage).trim());
    }

    for (let check = 0; check < MAX_ORDER_CHECKS; check += 1) {
      if (check > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, ORDER_POLL_INTERVAL_MS)
        );
      }

      // The user may have started a different order while this one was
      // running. Stop this watcher rather than allowing old state to
      // overwrite the new conversation.
      const currentStoredOrder =
        localStorage.getItem(ACTIVE_ORDER_KEY);

      if (currentStoredOrder && currentStoredOrder !== orderId) {
        break;
      }

      try {
        const response = await fetch(
          `${API_URL}?orderId=${encodeURIComponent(orderId)}`,
          {
            method: "GET",
            cache: "no-store",
            headers: {
              Accept: "application/json"
            }
          }
        );

        const data = await readApiJson(response);

        if (!response.ok || !data?.success || !data?.order) {
          continue;
        }

        const order = data.order;
        const status = String(order.status || "unknown").toLowerCase();

        const route =
          [
            "finding_shopper",
            "shopper_assigned",
            "shopping",
            "picked_up",
            "out_for_delivery"
          ].includes(status)
            ? "shopper"
            : status === "awaiting_customer_price_confirmation"
              ? order?.shopper_id
                ? "shopper"
                : "partner_store"
              : [
                  "finding_partner",
                  "partner_offered"
                ].includes(status)
                ? "partner_store"
                : "agent";

        let stage = "coordinating";

        if (status === "finding_partner") {
          stage = "finding partner store";
        } else if (status === "partner_offered") {
          stage = "partner store contacted";
        } else if (status === "awaiting_customer_price_confirmation") {
          stage = "price ready for approval";
        } else if (status === "finding_shopper") {
          stage = "finding shopper";
        } else if (status === "shopper_assigned") {
          stage = "shopper assigned";
        } else if (status === "shopping") {
          stage = "shopping";
        } else if (status === "picked_up") {
          stage = "picked up";
        } else if (status === "payment_pending") {
          stage = "payment pending";
        } else if (status === "out_for_delivery") {
          stage = "out for delivery";
        } else if (status === "delivered") {
          stage = "delivered";
        } else if (status === "cancelled") {
          stage = "cancelled";
        }

        setTask((current) => ({
          ...(current || {}),
          text: originalText || current?.text || "Fetch order",
          stage,
          status: order.status,
          network: route,
          workflowId: current?.workflowId || null,
          orderId
        }));

        const message = normalizeAssistantText(data.message).trim();
        const messageKey = `${status}::${message}`;
        const previousMessageKey =
          lastOrderMessageRef.current.get(orderId);

        const sameInitialState =
          check === 0 &&
          initialStatus &&
          String(initialStatus).toLowerCase() === status;

        if (messageKey !== previousMessageKey) {
          // The POST response and the first GET poll can legitimately
          // describe the same state using different wording. Seed the
          // polling key with the GET response without rendering a second
          // assistant bubble on that first poll.
          lastOrderMessageRef.current.set(orderId, messageKey);

          if (message && !sameInitialState) {
            setMessages((current) => [
              ...current,
              {
                id: makeId(),
                role: "assistant",
                text: message,
                meta: {
                  status: order.status,
                  network: route
                }
              }
            ]);
          }
        }

        if (data.terminal) {
          localStorage.removeItem(ACTIVE_ORDER_KEY);
          break;
        }
      } catch (error) {
        console.error("FETCH ORDER WATCH ERROR", error);
        // A temporary polling failure must not terminate the workflow.
      }
    }

    if (activeWatchRef.current === orderId) {
      activeWatchRef.current = null;
    }
  }

  useEffect(() => {
    refreshAgentTasks();

    const savedOrderId = localStorage.getItem(ACTIVE_ORDER_KEY);

    if (!savedOrderId) return;

    // Resume an in-flight order after a page refresh.
    watchOrder(savedOrderId, "Your Fetch order");
  }, []);

  function startVoice() {
    const SpeechRecognition =
      window.SpeechRecognition ||
      window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      alert(
        "Voice input is not supported in this browser yet."
      );
      return;
    }

    if (listening) {
      recognitionRef.current?.stop();
      return;
    }

    const recognition = new SpeechRecognition();

    recognition.lang = "en-IN";
    recognition.interimResults = true;
    recognition.continuous = false;

    recognition.onstart = () => {
      setListening(true);
    };

    recognition.onend = () => {
      setListening(false);
    };

    recognition.onerror = () => {
      setListening(false);
    };

    recognition.onresult = (event) => {
      let transcript = "";

      for (
        let i = event.resultIndex;
        i < event.results.length;
        i++
      ) {
        transcript +=
          event.results[i][0].transcript;
      }

      setInput(transcript);
    };

    recognitionRef.current = recognition;
    recognition.start();
  }

  function clearConversation() {
    activeWatchRef.current = null;
    localStorage.removeItem(ACTIVE_ORDER_KEY);

    const newConversation = `web:${makeId()}`;

    localStorage.setItem(
      "fetch_conversation_id",
      newConversation
    );

    conversationRef.current = newConversation;

    setMessages([
      {
        id: makeId(),
        role: "assistant",
        text: "Fresh start. What do you need done?",
        meta: null
      }
    ]);

    setTask(null);
    setAgentTaskId(null);
    setAgentTasks([]);
    setSelectedAgentTask(null);
    setTaskCenterOpen(false);
    setInput("");

    setTimeout(() => {
      inputRef.current?.focus();
    }, 0);
  }

  const handleOnboardingStarter = (starter) => {
    window.setTimeout(() => send(starter), 120);
  };

  const hasUserMessage = messages.some(
    (message) => message.role === "user"
  );

  return (
    <div className="app">
      {showOnboarding && (
        <FetchOnboarding
          onComplete={() => setShowOnboarding(false)}
          onStarter={handleOnboardingStarter}
        />
      )}
    {taskCenterOpen && selectedAgentTask && (
      <div className="taskCenterOverlay" role="dialog" aria-modal="true">
        <div className="taskCenterPanel">
          <div className="taskCenterHeader">
            <div>
              <small>FETCH TASK CENTER</small>
              <h2>{selectedAgentTask.goal || selectedAgentTask.raw_request || "Fetch task"}</h2>
            </div>
            <button className="taskCenterClose" onClick={() => setTaskCenterOpen(false)}>×</button>
          </div>
          <div className="taskCenterStatus">
            <strong>{String(selectedAgentTask.status || "unknown").replace(/_/g, " ")}</strong>
            <span>{selectedAgentTask.task_type || "agent task"}</span>
          </div>
          <div className="taskTimeline">
            {(Array.isArray(selectedAgentTask.steps) ? selectedAgentTask.steps : []).map((step,index) => (
              <div className={`taskTimelineStep ${step.status || "pending"}`} key={step.id || index}>
                <div className="timelineDot">{step.status === "completed" ? "✓" : String(index + 1).padStart(2,"0")}</div>
                <div className="timelineBody">
                  <strong>{step.input?.purpose || step.input?.goal || step.capability || "Fetch step"}</strong>
                  <span>{step.capability || "agent"} · {step.status || "pending"}</span>
                  {step.output?.message && <p>{normalizeAssistantText(step.output.message)}</p>}
                  {step.error?.message && <p>{step.error.message}</p>}
                </div>
              </div>
            ))}
          </div>
          <div className="taskCenterActions">
            {(selectedAgentTask.status === "waiting" || selectedAgentTask.confirmation_status === "pending") &&
              <button onClick={() => taskAction(selectedAgentTask.id,"approve")}>Approve</button>}
            {!["completed","cancelled","failed"].includes(selectedAgentTask.status) &&
              <button className="secondary" onClick={() => taskAction(selectedAgentTask.id,"cancel")}>Stop task</button>}
            {selectedAgentTask.status === "failed" &&
              <button onClick={() => taskAction(selectedAgentTask.id,"retry")}>Retry</button>}
            <button className="secondary" onClick={refreshSelectedTask}>Refresh</button>
          </div>
          {Array.isArray(selectedAgentTask.events) && selectedAgentTask.events.length > 0 && (
            <details className="taskEvents">
              <summary>Execution history</summary>
              {selectedAgentTask.events.slice().reverse().map((event,index) => (
                <div key={event.id || index}>
                  <strong>{String(event.event_type || "event").replace(/_/g," ")}</strong>
                  <span>{event.status || ""}</span>
                </div>
              ))}
            </details>
          )}
        </div>
      </div>
    )}


      <style>{`
        .approvalButton {
          margin-top: 12px;
          width: 100%;
          border: 0;
          border-radius: 12px;
          padding: 11px 14px;
          background: #111;
          color: #fff;
          font-size: 12px;
          font-weight: 700;
          cursor: pointer;
        }
        .approvalButton:hover { opacity: .88; }
        .approvalButton:disabled { opacity: .5; cursor: default; }
      `}</style>

      <header>
        <button
          className="brand"
          onClick={clearConversation}
        >
          fetch<span>.</span>
        </button>

        <div className="top">
          <span className="ready">
            <i />
            Fetch is ready
          </span>

          <button onClick={clearConversation}>
            New
          </button>
        </div>
      </header>

      <main>

        <section className="intro">
          <small>PERSONAL AI AGENT</small>

          <h1>
            Tell Fetch what you need.
            <br />
            <em>We’ll figure out how.</em>
          </h1>

          <p>
            Text naturally. Fetch understands the task,
            plans the work and coordinates the resources
            needed to get it done.
          </p>
        </section>

        <section className="workspace">

          <div className="chat">

            <div className="chatHead">

              <div className="identity">

                <b>F.</b>

                <span>
                  <strong>Fetch</strong>
                  <small>Personal assistant</small>
                </span>

              </div>

              <label>
                PRIVATE SESSION
              </label>

            </div>

            <div className="messages">

              {messages.map((message) => (

                <div
                  className={`row ${message.role}`}
                  key={message.id}
                >

                  {message.role === "assistant" && (
                    <b className="tiny">
                      F.
                    </b>
                  )}

                  <div
                    className={`bubble ${message.role}`}
                  >

                    {message.role === "assistant" ? (
                      <FormattedAssistantMessage text={message.text} />
                    ) : (
                      message.text
                    )}

                    {(
                      message.meta?.status === "awaiting_customer_price_confirmation" &&
                      task?.status === "awaiting_customer_price_confirmation"
                    ) && (
                      <button
                        type="button"
                        className="approvalButton"
                        onClick={() => send("approve")}
                        disabled={busy}
                      >
                        Approve order
                      </button>
                    )}

                    {(
                      message.meta?.status === "awaiting_agent_approval" &&
                      task?.status === "awaiting_agent_approval"
                    ) && (
                      <button
                        type="button"
                        className="approvalButton"
                        onClick={() => send("approve")}
                        disabled={busy}
                      >
                        Approve action
                      </button>
                    )}

                    {message.meta?.network && (
                      <small className="meta">
                        {message.meta.status}
                        {" · "}
                        {message.meta.network}
                      </small>
                    )}

                  </div>

                </div>

              ))}

              {busy && (

                <div className="row assistant">

                  <b className="tiny">
                    F.
                  </b>

                  <div className="bubble assistant thinking">

                    <i />
                    <i />
                    <i />

                    <small>
                      Figuring it out…
                    </small>

                  </div>

                </div>

              )}

            </div>

            <div className="composeArea">

              {!hasUserMessage && (

                <div className="starters">

                  {starters.map((starter) => (

                    <button
                      key={starter}
                      onClick={() =>
                        send(starter)
                      }
                    >
                      {starter}
                    </button>

                  ))}

                </div>

              )}

              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  send(input);
                }}
              >

                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(event) =>
                    setInput(event.target.value)
                  }
                  onKeyDown={(event) => {

                    if (
                      event.key === "Enter" &&
                      !event.shiftKey
                    ) {
                      event.preventDefault();
                      send(input);
                    }

                  }}
                  placeholder="Tell Fetch what you need…"
                  rows="1"
                  disabled={busy}
                />

                <button
                  type="button"
                  className={
                    listening ? "listen" : ""
                  }
                  onClick={startVoice}
                  aria-label="Voice input"
                >
                  {listening ? "●" : "⌕"}
                </button>

                <button
                  className="send"
                  disabled={
                    !input.trim() || busy
                  }
                  aria-label="Send"
                >
                  ↑
                </button>

              </form>

              <small className="hint">
                Enter to send · Fetch may ask for
                confirmation before an action
              </small>

            </div>

          </div>

          <aside>

            <small>FETCH ATC</small>

            <h2>
              You ask.
              <br />
              <em>Fetch coordinates.</em>
            </h2>

            <p>
              The user doesn't choose the service.
              Fetch determines the execution path
              behind the scenes.
            </p>

            <div className="flow">

              {[
                [
                  "01",
                  "Understand",
                  "Intent + context"
                ],
                [
                  "02",
                  "Plan",
                  "Task + workflow"
                ],
                [
                  "03",
                  "ATC",
                  "Choose resource"
                ],
                [
                  "04",
                  "Act",
                  "Execute + update"
                ]
              ].map((item, index) => (

                <React.Fragment key={item[0]}>

                  <div
                    className={`node ${
                      index === 0
                        ? "active"
                        : ""
                    }`}
                  >

                    <b>{item[0]}</b>

                    <span>
                      <strong>
                        {item[1]}
                      </strong>

                      <small>
                        {item[2]}
                      </small>
                    </span>

                  </div>

                  {index < 3 && (
                    <i className="line" />
                  )}

                </React.Fragment>

              ))}

            </div>

            {task && (

              <div className="live">

                <small>
                  LIVE TASK · {task.stage}
                </small>

                <p>
                  {task.text}
                </p>

                {task.network && (
                  <span>
                    Route{" "}
                    <b>{task.network}</b>
                  </span>
                )}

              </div>

            )}

            {agentTasks.length > 0 && (
              <div className="taskLedger">
                <small>AGENT LEDGER</small>
                <div className="taskLedgerList">
                  {agentTasks.slice(0, 5).map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={`ledgerItem ${agentTaskId === item.id ? "selected" : ""}`}
                      onClick={() => openAgentTask(item.id)}
                    >
                      <span className="ledgerDot" />
                      <span className="ledgerText">
                        <strong>{item.goal || item.raw_request || "Fetch task"}</strong>
                        <small>{item.status} · {item.task_type}</small>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="networks">

              <b>
                ◌
                <small>
                  Digital
                </small>
              </b>

              <b>
                ◇
                <small>
                  Physical
                </small>
              </b>

              <b>
                ⌁
                <small>
                  Human
                </small>
              </b>

            </div>

            <p className="note">
              Internal routing stays behind Fetch.
              Customers don't need to choose a
              store or service.
            </p>

          </aside>

        </section>

        <section className="statement">

          <small>THE IDEA</small>

          <h2>
            Don’t learn another app.
            <br />
            <em>Delegate the task.</em>
          </h2>

        </section>

      </main>

    </div>
  );
}

createRoot(
  document.getElementById("root")
).render(<App />);
