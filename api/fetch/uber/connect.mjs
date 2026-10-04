import crypto from "node:crypto";
import { createOAuthState } from "../../../lib/fetch-provider-connections.mjs";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const clientId = String(process.env.UBER_CLIENT_ID || "").trim();
  const redirectUri = String(process.env.UBER_REDIRECT_URI || "https://tryfetch.in/api/fetch/uber/callback.mjs").trim();
  if (!clientId) return res.status(503).send("Fetch Uber connection is not configured yet. Add UBER_CLIENT_ID in Vercel.");
  const url = new URL(req.url, `https://${req.headers.host || "tryfetch.in"}`);
  const conversationId = String(url.searchParams.get("conversation_id") || "").trim();
  if (!conversationId) return res.status(400).send("Missing Fetch conversation.");
  const state = crypto.randomBytes(32).toString("base64url");
  await createOAuthState({ state, conversationId, providerId: "uber", redirectUri, clientId });
  const authorize = new URL("https://auth.uber.com/oauth/v2/authorize");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("scope", "profile offline_access");
  authorize.searchParams.set("state", state);
  res.statusCode = 302;
  res.setHeader("Location", authorize.toString());
  return res.end();
}
