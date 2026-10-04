import { getProviderConnection } from "../../lib/fetch-provider-connections.mjs";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const url = new URL(req.url, `https://${req.headers.host || "tryfetch.in"}`);
    const conversationId = String(url.searchParams.get("conversation_id") || "").trim();
    const provider = String(url.searchParams.get("provider") || "").trim().toLowerCase();
    if (!conversationId || !provider) return res.status(400).json({ success: false, error: "conversation_id and provider are required" });
    const connection = await getProviderConnection({ conversationId, providerId: provider });
    return res.status(200).json({ success: true, provider, connected: Boolean(connection?.access_token), expires_at: connection?.expires_at || null, scopes: Array.isArray(connection?.scopes) ? connection.scopes : [] });
  } catch (error) {
    console.error("FETCH CONNECTOR STATUS ERROR", error);
    return res.status(500).json({ success: false, error: "connector_status_failed" });
  }
}
