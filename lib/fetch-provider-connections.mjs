/* Fetch provider OAuth persistence helpers. */
import crypto from "node:crypto";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || "https://skfxzagxlxputwpwxwbe.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;

async function db(path, options = {}) {
  if (!SUPABASE_KEY) throw new Error("SUPABASE_SECRET_KEY is missing");
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const raw = await response.text();
  let data = null; try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  return data;
}

function encryptionKey() {
  const secret = process.env.FETCH_OAUTH_ENCRYPTION_SECRET || SUPABASE_KEY || "";
  if (!secret) throw new Error("OAuth encryption secret is missing");
  return crypto.createHash("sha256").update(secret).digest();
}

export function encryptToken(value) {
  if (!value) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`;
}

export function decryptToken(value) {
  if (!value) return null;
  const raw = String(value);
  if (!raw.startsWith("v1:")) return raw;
  const [, ivText, tagText, ciphertextText] = raw.split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextText, "base64url")), decipher.final()]).toString("utf8");
}

export async function createOAuthState({ state, conversationId, customerId = null, providerId, redirectUri, clientId, codeVerifier = null }) {
  await db("fetch_provider_oauth_states", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      state, conversation_id: conversationId, customer_id: customerId, provider_id: providerId,
      code_verifier: codeVerifier, client_id: clientId, redirect_uri: redirectUri,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    }),
  });
}

export async function consumeOAuthState(state) {
  const rows = await db(`fetch_provider_oauth_states?state=eq.${encodeURIComponent(state)}&select=state,conversation_id,customer_id,provider_id,client_id,redirect_uri,code_verifier,expires_at&limit=1`);
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return null;
  await db(`fetch_provider_oauth_states?state=eq.${encodeURIComponent(state)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
  if (!row.expires_at || new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}

export async function saveProviderConnection({ conversationId, customerId = null, providerId, accessToken, refreshToken, tokenType = "Bearer", expiresIn = null, scopes = [] }) {
  const payload = {
    conversation_id: conversationId, customer_id: customerId, provider_id: providerId,
    access_token: encryptToken(accessToken), refresh_token: encryptToken(refreshToken),
    token_type: tokenType, expires_at: expiresIn ? new Date(Date.now() + Number(expiresIn) * 1000).toISOString() : null,
    scopes: Array.isArray(scopes) ? scopes : [], updated_at: new Date().toISOString(),
  };
  const existing = await db(`fetch_provider_connections?conversation_id=eq.${encodeURIComponent(conversationId)}&provider_id=eq.${encodeURIComponent(providerId)}&select=id&limit=1`);
  if (Array.isArray(existing) && existing.length) {
    await db(`fetch_provider_connections?id=eq.${encodeURIComponent(existing[0].id)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(payload) });
  } else {
    await db("fetch_provider_connections", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(payload) });
  }
  return { providerId, conversationId, expiresAt: payload.expires_at, scopes: payload.scopes };
}

export async function getProviderConnection({ conversationId, customerId = null, providerId }) {
  let rows = [];
  if (customerId) {
    rows = await db(`fetch_provider_connections?customer_id=eq.${encodeURIComponent(customerId)}&provider_id=eq.${encodeURIComponent(providerId)}&select=id,conversation_id,customer_id,provider_id,access_token,refresh_token,token_type,expires_at,scopes,updated_at&order=updated_at.desc&limit=1`);
  }
  if (!Array.isArray(rows) || !rows.length) {
    rows = await db(`fetch_provider_connections?conversation_id=eq.${encodeURIComponent(conversationId || "")}&provider_id=eq.${encodeURIComponent(providerId)}&select=id,conversation_id,customer_id,provider_id,access_token,refresh_token,token_type,expires_at,scopes,updated_at&limit=1`);
  }
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return null;
  return { ...row, access_token: decryptToken(row.access_token), refresh_token: decryptToken(row.refresh_token) };
}
