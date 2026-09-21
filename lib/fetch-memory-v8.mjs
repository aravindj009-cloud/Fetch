/* Fetch V8 Memory Layer
   Durable memory for explicit/confirmed customer facts.
   Never store passwords, API keys, payment credentials, or secrets.
*/
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || "https://skfxzagxlxputwpwxwbe.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;

function headers(extra = {}) { return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", ...extra }; }
async function db(path, options = {}) {
  if (!SUPABASE_KEY) throw new Error("SUPABASE_SECRET_KEY is missing");
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...options, headers: headers(options.headers || {}) });
  const raw = await response.text();
  let data = null; try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  if (!response.ok) throw new Error(`Fetch Memory ${response.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  return data;
}

const FORBIDDEN_KEY_RE = /(password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|card|cvv|cvc|pin|otp|bank[_-]?account|private[_-]?key)/i;
function assertSafeMemoryKey(key) { if (FORBIDDEN_KEY_RE.test(String(key || ""))) throw new Error("Unsafe memory key"); }

export async function listCustomerMemory(customerId, { limit = 50 } = {}) {
  if (!customerId) return [];
  const rows = await db(`fetch_customer_memory?customer_id=eq.${encodeURIComponent(customerId)}&or=(expires_at.is.null,expires_at.gt.${encodeURIComponent(new Date().toISOString())})&order=updated_at.desc&limit=${Math.min(Number(limit) || 50, 100)}`);
  return Array.isArray(rows) ? rows : [];
}

export function memoryRowsToObject(rows = []) {
  const out = {};
  for (const row of rows) if (row?.memory_key) out[row.memory_key] = row.memory_value;
  return out;
}

export async function upsertCustomerMemory({ customerId, memoryKey, memoryValue, memoryType = "fact", source = "user_explicit", confidence = 1, explicit = true, expiresAt = null } = {}) {
  if (!customerId) throw new Error("customerId is required");
  assertSafeMemoryKey(memoryKey);
  if (!explicit && source !== "system_confirmed") throw new Error("Durable memory must be explicit or system-confirmed");
  const payload = { customer_id: String(customerId), memory_key: String(memoryKey), memory_value: memoryValue ?? {}, memory_type: memoryType, source, confidence: Math.max(0, Math.min(1, Number(confidence) || 0)), explicit: Boolean(explicit), expires_at: expiresAt };
  const rows = await db("fetch_customer_memory?on_conflict=customer_id,memory_key", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(payload) });
  return Array.isArray(rows) ? rows[0] || null : rows;
}

export async function deleteCustomerMemory({ customerId, memoryKey } = {}) {
  if (!customerId || !memoryKey) throw new Error("customerId and memoryKey are required");
  assertSafeMemoryKey(memoryKey);
  await db(`fetch_customer_memory?customer_id=eq.${encodeURIComponent(customerId)}&memory_key=eq.${encodeURIComponent(memoryKey)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
  return { deleted: true };
}
