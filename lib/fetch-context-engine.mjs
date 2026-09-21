/* Fetch V8 Context Engine */
import { listCustomerMemory, memoryRowsToObject } from "./fetch-memory-v8.mjs";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || "https://skfxzagxlxputwpwxwbe.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
function headers(extra = {}) { return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", ...extra }; }
async function db(path, options = {}) {
  if (!SUPABASE_KEY) throw new Error("SUPABASE_SECRET_KEY is missing");
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...options, headers: headers(options.headers || {}) });
  const raw = await r.text(); let data = null; try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  if (!r.ok) throw new Error(`Fetch Context ${r.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  return data;
}

export async function getConversationContext({ customerId = null, conversationId = null, channel = "unknown" } = {}) {
  if (!conversationId) return null;
  const rows = await db(`fetch_conversation_context?channel=eq.${encodeURIComponent(channel)}&conversation_id=eq.${encodeURIComponent(conversationId)}&limit=1`);
  return Array.isArray(rows) ? rows[0] || null : null;
}

export async function saveConversationContext({ customerId = null, conversationId, channel = "unknown", context = {}, lastUserText = null, activeTaskId = null, expiresAt = null } = {}) {
  if (!conversationId) return null;
  const payload = { customer_id: customerId ? String(customerId) : null, conversation_id: String(conversationId), channel: String(channel), context: context || {}, last_user_text: lastUserText, active_task_id: activeTaskId, expires_at: expiresAt };
  const rows = await db("fetch_conversation_context?on_conflict=channel,conversation_id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(payload) });
  return Array.isArray(rows) ? rows[0] || null : rows;
}

export async function getRecentIntentDecisions(customerId, limit = 5) {
  if (!customerId) return [];
  try {
    const rows = await db(`fetch_intent_decisions?customer_id=eq.${encodeURIComponent(customerId)}&order=created_at.desc&limit=${Math.min(Number(limit) || 5, 20)}`);
    return Array.isArray(rows) ? rows : [];
  } catch { return []; }
}

export async function getRecentTaskSteps(taskId, limit = 20) {
  if (!taskId) return [];
  try {
    const rows = await db(`fetch_task_steps?task_id=eq.${encodeURIComponent(taskId)}&order=step_index.asc&limit=${Math.min(Number(limit) || 20, 50)}`);
    return Array.isArray(rows) ? rows : [];
  } catch { return []; }
}

export async function saveContextSnapshot({ customerId = null, conversationId = null, sourceChannel = null, rawText, resolvedContext = {} } = {}) {
  if (!rawText) return null;
  try {
    const rows = await db("fetch_context_snapshots", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ customer_id: customerId ? String(customerId) : null, conversation_id: conversationId, source_channel: sourceChannel, raw_text: String(rawText), resolved_context: resolvedContext || {} }) });
    return Array.isArray(rows) ? rows[0] || null : rows;
  } catch { return null; }
}

export async function resolveFetchContext({ text = "", customerId = null, conversationId = null, channel = "unknown", activeTaskId = null, suppliedContext = {} } = {}) {
  const [memoryRows, conversation, recentDecisions] = await Promise.all([
    customerId ? listCustomerMemory(customerId, { limit: 50 }) : Promise.resolve([]),
    getConversationContext({ customerId, conversationId, channel }),
    getRecentIntentDecisions(customerId, 5),
  ]);
  const memory = memoryRowsToObject(memoryRows);
  const recent = recentDecisions.map((row) => ({ intent: row.intent, entities: row.entities, decision: row.decision, created_at: row.created_at }));
  const context = {
    current_request: { text: String(text || "") },
    customer: { memory },
    conversation: conversation?.context || {},
    active_task_id: activeTaskId || conversation?.active_task_id || null,
    recent_decisions: recent,
    supplied: suppliedContext || {},
  };
  return { context, memory, conversation, recent_decisions: recent };
}
