/* V8 Context-aware decision endpoint */
import crypto from "node:crypto";
import { processFetchV8Request } from "../../lib/fetch-v8.mjs";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || "https://skfxzagxlxputwpwxwbe.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;

function verifyOnboardingToken(token) {
  const [payload, signature] = String(token || "").split(".");
  if (!payload || !signature) return null;
  const secret = String(process.env.FETCH_ONBOARDING_SECRET || "").trim() || String(SUPABASE_KEY || "").trim();
  if (!secret) return null;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  const received = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (received.length !== expectedBuffer.length || !crypto.timingSafeEqual(received, expectedBuffer)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!decoded?.phone || Number(decoded.exp) < Math.floor(Date.now() / 1000)) return null;
    return { phone: String(decoded.phone).replace(/\D/g, "") };
  } catch { return null; }
}

async function supabaseRequest(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

function onboardingPage(heading, body, success = true) {
  const page = "<!doctype html><html><head><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Fetch</title><style>body{margin:0;background:#0b0d0e;color:#f5f7f8;font-family:Inter,system-ui,-apple-system,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center}.card{width:min(520px,calc(100% - 40px));background:#15191b;border:1px solid #293033;border-radius:24px;padding:34px;box-sizing:border-box;box-shadow:0 24px 70px rgba(0,0,0,.45)}.logo{width:56px;height:56px;border-radius:50%;background:#fff;color:#111;display:flex;align-items:center;justify-content:center;font:700 28px Georgia;margin-bottom:28px}h1{font-size:30px;line-height:1.1;margin:0 0 14px}p{color:#aeb8bb;line-height:1.6;font-size:16px}.status{display:inline-flex;color:__COLOR__;font-weight:700;margin:12px 0}a{display:block;text-align:center;text-decoration:none;background:#fff;color:#111;padding:15px 18px;border-radius:14px;font-weight:700;margin-top:26px}</style></head><body><main class=\"card\"><div class=\"logo\">F</div><div class=\"status\">__STATUS__ Fetch</div><h1>__HEADING__</h1><p>__BODY__</p>__LINK__</main></body></html>"
    .replace("__COLOR__", success ? "#20c997" : "#ff6b6b")
    .replace("__STATUS__", success ? "✓ Connected" : "!")
    .replace("__HEADING__", String(heading))
    .replace("__BODY__", String(body))
    .replace("__LINK__", success ? '<a href="https://wa.me/919074559146">Return to Fetch on WhatsApp →</a>' : "");
  return page;
}

async function handleOnboarding(req, res) {
  const token = new URL(req.url, `https://${req.headers.host || "tryfetch.in"}`).searchParams.get("token");
  const verified = verifyOnboardingToken(token);
  if (!verified) return res.status(400).setHeader("Content-Type", "text/html; charset=utf-8").send(onboardingPage("This connection link has expired", "Return to WhatsApp and say “Hey Fetch” to receive a fresh connection link.", false));

  const rows = await supabaseRequest(`customers?phone=eq.${encodeURIComponent(verified.phone)}&select=id,name&limit=1`);
  if (!Array.isArray(rows) || !rows.length) return res.status(404).setHeader("Content-Type", "text/html; charset=utf-8").send(onboardingPage("We couldn't find your Fetch account", "Return to WhatsApp and say “Hey Fetch” again to start a fresh connection.", false));

  await supabaseRequest(`customers?id=eq.${encodeURIComponent(rows[0].id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ whatsapp_connected: true, whatsapp_connected_at: new Date().toISOString(), whatsapp_onboarding_sent: true }),
  });

  const firstName = String(rows[0].name || "").trim().split(/\s+/)[0];
  return res.status(200).setHeader("Content-Type", "text/html; charset=utf-8").send(
    onboardingPage(`You're connected${firstName ? `, ${firstName}` : ""}.`, "Fetch is now connected to this WhatsApp number. Go back to the chat and tell Fetch what you need — no menus, no store selection, no separate app required.")
  );
}

export default async function handler(req, res) {
  if (req.method === "GET" && new URL(req.url, `https://${req.headers.host || "tryfetch.in"}`).searchParams.has("token")) {
    try { return await handleOnboarding(req, res); }
    catch (error) {
      console.error("FETCH WHATSAPP ONBOARDING ERROR:", error);
      return res.status(500).setHeader("Content-Type", "text/html; charset=utf-8").send(onboardingPage("Something went wrong", "Please return to WhatsApp and try again.", false));
    }
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const body = req.body || {};
    if (!body.text || typeof body.text !== "string") return res.status(400).json({ error: "text is required" });
    const result = await processFetchV8Request({ text: body.text, customerId: body.customer_id || null, conversationId: body.conversation_id || null, channel: body.channel || "api", activeTaskId: body.active_task_id || null, suppliedIntent: body.intent || null, suppliedContext: body.context || {} });
    return res.status(200).json(result);
  } catch (error) {
    console.error("FETCH V8 CONTEXT ERROR:", error);
    return res.status(500).json({ error: "context_decision_failed", message: error?.message || String(error) });
  }
}