import { consumeOAuthState, saveProviderConnection } from "../../../lib/fetch-provider-connections.mjs";

function page(title, body, success, conversationId) {
  const color = success ? "#20c997" : "#ff6b6b";
  const status = success ? "Connected" : "Connection failed";
  const returnUrl = conversationId ? "/?uber=" + (success ? "connected" : "error") + "&conversation_id=" + encodeURIComponent(conversationId) : "/";
  return '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fetch · Uber</title><style>body{margin:0;background:#0b0d0e;color:#f5f7f8;font-family:Inter,system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center}.card{width:min(520px,calc(100% - 40px));background:#15191b;border:1px solid #293033;border-radius:24px;padding:34px;box-sizing:border-box;box-shadow:0 24px 70px rgba(0,0,0,.45)}.logo{width:56px;height:56px;border-radius:50%;background:#fff;color:#111;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:28px;margin-bottom:28px}h1{font-size:30px;line-height:1.1;margin:0 0 14px}p{color:#aeb8bb;line-height:1.6;font-size:16px}.status{color:'+color+';font-weight:700;margin-bottom:12px}a{display:block;text-align:center;text-decoration:none;background:#fff;color:#111;padding:15px 18px;border-radius:14px;font-weight:700;margin-top:26px}</style></head><body><main class="card"><div class="logo">F</div><div class="status">'+status+'</div><h1>'+title+'</h1><p>'+body+'</p><a href="'+returnUrl+'">Return to Fetch →</a></main></body></html>';
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).send("Method not allowed");
  try {
    const url = new URL(req.url, `https://${req.headers.host || "tryfetch.in"}`);
    const error = url.searchParams.get("error");
    const state = url.searchParams.get("state");
    if (error) return res.status(400).send(page("Uber connection cancelled", "The authorization was not completed.", false, ""));
    if (!state) return res.status(400).send(page("Invalid connection", "Fetch did not receive the OAuth state from Uber.", false, ""));
    const stateRow = await consumeOAuthState(state);
    if (!stateRow) return res.status(400).send(page("Connection expired", "Please start the connection again.", false, ""));
    const code = url.searchParams.get("code");
    if (!code) return res.status(400).send(page("No authorization code", "Uber did not return an authorization code.", false, stateRow.conversation_id));
    const clientId = String(process.env.UBER_CLIENT_ID || stateRow.client_id || "").trim();
    const clientSecret = String(process.env.UBER_CLIENT_SECRET || "").trim();
    const redirectUri = String(process.env.UBER_REDIRECT_URI || stateRow.redirect_uri || "").trim();
    if (!clientId || !clientSecret) return res.status(503).send(page("Fetch is not configured", "The Uber client credentials are not configured on the server yet.", false, stateRow.conversation_id));
    const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "authorization_code", redirect_uri: redirectUri, code });
    const tokenResponse = await fetch("https://auth.uber.com/oauth/v2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    const data = await tokenResponse.json();
    if (!tokenResponse.ok || !data?.access_token) {
      console.error("FETCH UBER TOKEN ERROR", tokenResponse.status, JSON.stringify(data).slice(0, 500));
      return res.status(502).send(page("Uber could not connect", "Uber rejected the authorization. Check the Fetch redirect URI and Uber application settings.", false, stateRow.conversation_id));
    }
    await saveProviderConnection({
      conversationId: stateRow.conversation_id, providerId: "uber",
      accessToken: data.access_token, refreshToken: data.refresh_token || null,
      tokenType: data.token_type || "Bearer", expiresIn: data.expires_in,
      scopes: String(data.scope || "").split(/\s+/).filter(Boolean),
    });
    return res.status(200).send(page("Uber is connected", "Fetch securely stored the connection on the server. Return to Fetch and your pending request can continue.", true, stateRow.conversation_id));
  } catch (error) {
    console.error("FETCH UBER OAUTH CALLBACK ERROR", error);
    return res.status(500).send(page("Connection failed", "Fetch could not finish the Uber connection. Please try again.", false, ""));
  }
}
