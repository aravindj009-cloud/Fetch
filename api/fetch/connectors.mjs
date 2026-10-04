/* Fetch connector authorization gateway.
   Providers:
   - Swiggy Food MCP: /food
   - Swiggy Instamart MCP: /im
   - Google Gmail: optional, enabled when GOOGLE_CLIENT_ID/SECRET are configured.
*/
import crypto from "node:crypto";
import {
  createOAuthState,
  consumeOAuthState,
  saveProviderConnection,
  getProviderConnection,
} from "../../lib/fetch-provider-connections.mjs";

const BASE = "https://tryfetch.in";
const SWIGGY_BASE = "https://mcp.swiggy.com";
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || "https://skfxzagxlxputwpwxwbe.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;

async function db(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  return data;
}

function html(res, status, title, body, button = null) {
  const action = button
    ? `<a href="${String(button.href).replace(/"/g, "&quot;")}">${button.label}</a>`
    : "";
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fetch · Connectors</title><style>
  body{margin:0;background:#090b0c;color:#f4f6f7;font-family:Inter,system-ui,-apple-system,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:22px;box-sizing:border-box}
  .card{width:min(560px,100%);background:#121617;border:1px solid #293033;border-radius:26px;padding:32px;box-sizing:border-box;box-shadow:0 24px 80px rgba(0,0,0,.45)}
  .logo{width:54px;height:54px;border-radius:50%;background:#fff;color:#111;display:flex;align-items:center;justify-content:center;font:bold 28px Georgia;margin-bottom:25px}
  .eyebrow{font-size:11px;letter-spacing:.16em;color:#20c997;font-weight:800;margin-bottom:10px}.eyebrow.bad{color:#ff7676}
  h1{font-size:30px;line-height:1.08;margin:0 0 12px}p{color:#aeb8bb;line-height:1.6;font-size:15px;margin:0}
  a{display:block;text-align:center;text-decoration:none;background:#fff;color:#111;padding:14px 18px;border-radius:13px;font-weight:800;margin-top:25px}
  code{display:block;margin-top:18px;padding:12px;border-radius:12px;background:#0c1011;color:#bfc8ca;overflow:auto;font-size:12px}
  </style></head><body><main class="card"><div class="logo">F</div><div class="eyebrow ${status >= 400 ? "bad" : ""}">${status >= 400 ? "CONNECTION ISSUE" : "FETCH CONNECTOR"}</div><h1>${title}</h1><p>${body}</p>${action}</main></body></html>`);
}

function callbackUrl(provider) {
  return `${BASE}/api/fetch/connectors.mjs?${provider === "google" ? "google_callback" : "swiggy_callback"}=1`;
}

function makePkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function registerSwiggyClient(redirectUri) {
  if (process.env.SWIGGY_CLIENT_ID) {
    return { clientId: String(process.env.SWIGGY_CLIENT_ID), clientSecret: process.env.SWIGGY_CLIENT_SECRET || null };
  }
  const response = await fetch(`${SWIGGY_BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Fetch",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.client_id) {
    throw new Error(`Swiggy client registration failed (${response.status}). ${JSON.stringify(data).slice(0, 500)}`);
  }
  return { clientId: data.client_id, clientSecret: data.client_secret || null };
}

async function startSwiggy(req, res, provider) {
  const url = new URL(req.url, BASE);
  const conversationId = String(url.searchParams.get("conversation_id") || "").trim();
  if (!conversationId) return html(res, 400, "Fetch session missing", "Open Fetch in the same browser first, then return to Connectors.");

  const redirectUri = callbackUrl(provider);
  const { verifier, challenge } = makePkce();
  const { clientId } = await registerSwiggyClient(redirectUri);
  const state = crypto.randomBytes(32).toString("base64url");

  await createOAuthState({
    state,
    conversationId,
    providerId: provider,
    redirectUri,
    clientId,
    codeVerifier: verifier,
  });

  const authorize = new URL(`${SWIGGY_BASE}/auth/authorize`);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("scope", "mcp:tools");

  res.statusCode = 302;
  res.setHeader("Location", authorize.toString());
  return res.end();
}

async function finishSwiggy(req, res) {
  const url = new URL(req.url, BASE);
  const state = url.searchParams.get("state");
  const provider = url.searchParams.get("provider") || "swiggy";
  if (url.searchParams.get("error")) return html(res, 400, "Swiggy connection cancelled", "No connection was saved. You can return to Connectors and try again.");
  if (!state) return html(res, 400, "Invalid connection", "Fetch did not receive a valid OAuth state.");

  const stateRow = await consumeOAuthState(state);
  if (!stateRow) return html(res, 400, "Connection expired", "Please start the connection again.");
  const code = url.searchParams.get("code");
  if (!code) return html(res, 400, "Authorization incomplete", "Swiggy did not return an authorization code.");

  const tokenResponse = await fetch(`${SWIGGY_BASE}/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      code_verifier: stateRow.code_verifier,
      redirect_uri: stateRow.redirect_uri,
    }),
  });
  const data = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !data?.access_token) {
    console.error("FETCH SWIGGY TOKEN ERROR", tokenResponse.status, JSON.stringify(data).slice(0, 500));
    return html(res, 502, "Swiggy could not connect", "The authorization reached Swiggy, but the token exchange was rejected. The most common cause is that Fetch’s callback URL has not yet been allowlisted by Swiggy.");
  }

  await saveProviderConnection({
    conversationId: stateRow.conversation_id,
    providerId: provider,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    tokenType: data.token_type || "Bearer",
    expiresIn: data.expires_in,
    scopes: String(data.scope || "").split(/\\s+/).filter(Boolean),
  });

  return html(res, 200, `${provider === "instamart" ? "Instamart" : "Swiggy"} is connected`, "Fetch securely stored the provider connection. Your next request can use it as an execution path.", { href: "/connectors", label: "Return to Fetch Connectors →" });
}

async function startGoogle(req, res) {
  const clientId = String(process.env.GOOGLE_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.GOOGLE_CLIENT_SECRET || "").trim();
  if (!clientId || !clientSecret) {
    return html(res, 503, "Email is not configured yet", "Fetch is ready for Gmail OAuth, but the Google OAuth client credentials have not been added to Vercel. Nothing is being falsely marked as connected.");
  }
  const url = new URL(req.url, BASE);
  const conversationId = String(url.searchParams.get("conversation_id") || "").trim();
  if (!conversationId) return html(res, 400, "Fetch session missing", "Open Fetch in the same browser first, then return to Connectors.");

  const state = crypto.randomBytes(32).toString("base64url");
  const redirectUri = callbackUrl("google");
  await createOAuthState({ state, conversationId, providerId: "email", redirectUri, clientId });

  const authorize = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("scope", "openid email https://www.googleapis.com/auth/gmail.modify");
  authorize.searchParams.set("access_type", "offline");
  authorize.searchParams.set("include_granted_scopes", "true");
  authorize.searchParams.set("prompt", "consent");
  authorize.searchParams.set("state", state);

  res.statusCode = 302;
  res.setHeader("Location", authorize.toString());
  return res.end();
}

async function finishGoogle(req, res) {
  const url = new URL(req.url, BASE);
  const state = url.searchParams.get("state");
  if (url.searchParams.get("error")) return html(res, 400, "Email connection cancelled", "No connection was saved.");
  const stateRow = await consumeOAuthState(state || "");
  if (!stateRow) return html(res, 400, "Connection expired", "Please start the connection again.");
  const code = url.searchParams.get("code");
  const clientId = String(process.env.GOOGLE_CLIENT_ID || stateRow.client_id || "").trim();
  const clientSecret = String(process.env.GOOGLE_CLIENT_SECRET || "").trim();
  if (!code || !clientId || !clientSecret) return html(res, 400, "Email authorization incomplete", "Google did not return everything Fetch needs.");

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: stateRow.redirect_uri,
      grant_type: "authorization_code",
    }),
  });
  const data = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !data?.access_token) return html(res, 502, "Google could not connect", "Google rejected the token exchange. Check the OAuth redirect URI and consent-screen configuration.");

  await saveProviderConnection({
    conversationId: stateRow.conversation_id,
    providerId: "email",
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    tokenType: data.token_type || "Bearer",
    expiresIn: data.expires_in,
    scopes: String(data.scope || "").split(/\\s+/).filter(Boolean),
  });
  return html(res, 200, "Email is connected", "Fetch securely stored the Google connection. Email can now become an execution path for this Fetch session.", { href: "/connectors", label: "Return to Fetch Connectors →" });
}

async function status(req, res) {
  const url = new URL(req.url, BASE);
  const conversationId = String(url.searchParams.get("conversation_id") || "").trim();
  if (!conversationId) return res.status(400).json({ success: false, error: "conversation_id_required" });
  const providers = ["swiggy", "instamart", "email", "uber"];
  const result = {};
  for (const providerId of providers) {
    const connection = await getProviderConnection({ conversationId, providerId });
    result[providerId] = Boolean(connection?.access_token);
  }
  return res.status(200).json({ success: true, connections: result });
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
    const url = new URL(req.url, BASE);
    if (url.searchParams.get("status") === "1") return status(req, res);
    if (url.searchParams.get("swiggy_connect") === "1") return startSwiggy(req, res, "swiggy");
    if (url.searchParams.get("instamart_connect") === "1") return startSwiggy(req, res, "instamart");
    if (url.searchParams.get("swiggy_callback") === "1") return finishSwiggy(req, res);
    if (url.searchParams.get("google_connect") === "1") return startGoogle(req, res);
    if (url.searchParams.get("google_callback") === "1") return finishGoogle(req, res);
    return html(res, 404, "Connector not found", "This Fetch connector endpoint does not exist.");
  } catch (error) {
    console.error("FETCH CONNECTOR ERROR:", error);
    return html(res, 500, "Fetch could not start this connection", error?.message || "Please try again.");
  }
}
