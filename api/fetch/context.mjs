/* V8 Context-aware decision endpoint */
import crypto from "node:crypto";
let providerConnectionsModulePromise;
async function providerConnectionsModule() {
  providerConnectionsModulePromise ||= import("../../lib/fetch-provider-connections.mjs");
  return providerConnectionsModulePromise;
}
async function createOAuthState(args) { return (await providerConnectionsModule()).createOAuthState(args); }
async function consumeOAuthState(state) { return (await providerConnectionsModule()).consumeOAuthState(state); }
async function saveProviderConnection(args) { return (await providerConnectionsModule()).saveProviderConnection(args); }
async function getProviderConnection(args) { return (await providerConnectionsModule()).getProviderConnection(args); }


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
    const phone = String(decoded.phone).replace(/\D/g, "");
    return {
      phone,
      conversationId: String(decoded.conversation_id || ("whatsapp:" + phone)).trim()
    };
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

function partnerPortalPage(message = "", success = false) {
  const safe = String(message).replace(/[&<>"]/g, (m) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[m]));
  const notice = message ? '<div class="notice ' + (success ? "ok" : "error") + '">' + safe + "</div>" : "";
  return '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fetch Partners</title><style>body{margin:0;background:#f6f4ef;color:#151515;font-family:system-ui,sans-serif;padding:24px}.wrap{max-width:760px;margin:auto}.brand{font-size:28px;font-weight:800;margin:8px 0 28px}.brand span{color:#ff5a00}.card{background:white;border:1px solid #e4e0d8;border-radius:22px;padding:28px}h1{font-size:36px;line-height:1.05;margin:0 0 10px}p{color:#666;line-height:1.5}.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.field{margin-top:16px}.full{grid-column:1/-1}label{display:block;font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;margin-bottom:6px;color:#555}input,select,textarea{width:100%;padding:12px;border:1px solid #d8d4cc;border-radius:10px;font:inherit;box-sizing:border-box}textarea{min-height:90px}.checks{display:flex;flex-wrap:wrap;gap:8px}.check{border:1px solid #ddd8d0;border-radius:9px;padding:8px;font-size:13px;text-transform:none;letter-spacing:0}.check input{width:auto}button{width:100%;margin-top:22px;padding:14px;border:0;border-radius:11px;background:#111;color:#fff;font-weight:700}.notice{padding:12px;border-radius:10px;margin:16px 0}.ok{background:#eaf8f0;color:#17633d}.error{background:#fff0ed;color:#9a2f1f}@media(max-width:600px){.grid{grid-template-columns:1fr}.full{grid-column:auto}h1{font-size:30px}}</style></head><body><main class="wrap"><div class="brand">fetch<span>.</span></div><section class="card"><div style="font-size:11px;font-weight:800;letter-spacing:.15em;color:#888">FETCH PARTNER NETWORK</div><h1>Become a Fetch partner.</h1><p>Receive relevant customer requests through Fetch. Applications are reviewed before activation.</p>' + notice + '<form method="POST" action="/api/fetch/context"><input type="hidden" name="action" value="partner_apply"><div class="grid"><div class="field"><label>Business / service name</label><input name="business_name" required></div><div class="field"><label>Contact person</label><input name="contact_name" required></div><div class="field"><label>WhatsApp number</label><input name="whatsapp_phone" required placeholder="+91..."></div><div class="field"><label>Category</label><select name="category" required><option value="">Select</option><option>Local Commerce</option><option>Home Services</option><option>Mobility</option><option>Assisted Services</option></select></div><div class="field"><label>Service / business type</label><input name="subcategory" placeholder="Grocery, electrician, taxi..."></div><div class="field"><label>Service area</label><input name="service_area" placeholder="Area / radius"></div><div class="field full"><label>Address</label><textarea name="address" required></textarea></div><div class="field full"><label>Capabilities</label><div class="checks"><label class="check"><input type="checkbox" name="capabilities" value="inventory_check"> Inventory</label><label class="check"><input type="checkbox" name="capabilities" value="price_quote"> Price quotes</label><label class="check"><input type="checkbox" name="capabilities" value="order_fulfillment"> Fulfillment</label><label class="check"><input type="checkbox" name="capabilities" value="phone_service"> Phone</label><label class="check"><input type="checkbox" name="capabilities" value="human_service"> Human service</label></div></div><div class="field full"><label>Notes</label><textarea name="notes"></textarea></div></div><button type="submit">Apply to become a partner →</button></form></section></main></body></html>';
}

async function handlePartnerApplication(req, res) {
  const body = req.body && typeof req.body === "object" ? req.body : Object.fromEntries(new URLSearchParams(String(req.body || "")));
  const businessName = String(body.business_name || "").trim();
  const contactName = String(body.contact_name || "").trim();
  const whatsappPhone = String(body.whatsapp_phone || "").replace(/\D/g, "");
  const category = String(body.category || "").trim();
  const address = String(body.address || "").trim();
  const subcategory = String(body.subcategory || "").trim();
  const serviceArea = String(body.service_area || "").trim();
  const notes = String(body.notes || "").trim();
  const raw = body.capabilities;
  const capabilities = Array.isArray(raw) ? raw.map(String) : raw ? [String(raw)] : [];
  if (!businessName || !contactName || whatsappPhone.length < 10 || !category || !address) return sendHtml(res, 400, partnerPortalPage("Please complete all required fields.", false));
  await supabaseRequest("fetch_partner_applications", { method:"POST", headers:{Prefer:"return=minimal"}, body:JSON.stringify({business_name:businessName,contact_name:contactName,whatsapp_phone:whatsappPhone,category,subcategory:subcategory||null,address,service_area:serviceArea||null,capabilities,notes:notes||null,status:"pending",source:"partner_portal"}) });
  return sendHtml(res, 200, partnerPortalPage("Application received. Fetch will review it and contact you on WhatsApp before activation.", true));
}

function customerProfilePage(customer, token, message = "", success = false) {
  const safe = (value) => String(value ?? "").replace(/[&<>"]/g, (m) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[m]));
  const prefs = customer?.connector_preferences && typeof customer.connector_preferences === "object" ? customer.connector_preferences : {};
  const profile = prefs.profile && typeof prefs.profile === "object" ? prefs.profile : {};
  const notice = message ? '<div class="notice ' + (success ? "ok" : "error") + '">' + safe(message) + "</div>" : "";
  const lat = profile.latitude ?? "";
  const lng = profile.longitude ?? "";
  const updated = profile.location_updated_at ? new Date(profile.location_updated_at).toLocaleString() : "";
  return '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fetch · My Profile</title><style>body{margin:0;background:#0b0d0e;color:#f5f7f8;font-family:system-ui,sans-serif;padding:22px}.wrap{max-width:560px;margin:auto}.card{background:#111516;border:1px solid #293033;border-radius:26px;padding:28px}.logo{width:50px;height:50px;border-radius:50%;background:#eaffef;color:#159447;display:grid;place-items:center;font:700 26px Georgia;margin-bottom:22px}h1{margin:0 0 8px;font-size:30px}p{color:#aeb8bb;line-height:1.5}.field{margin-top:17px}label{display:block;font-size:11px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#899396;margin-bottom:7px}input,textarea{width:100%;box-sizing:border-box;padding:13px 14px;border-radius:12px;border:1px solid #30383b;background:#0d1011;color:#fff;font:inherit}textarea{min-height:82px;resize:vertical}.location{display:flex;align-items:center;gap:12px;padding:14px;border:1px solid #30383b;border-radius:14px;margin-top:17px}.pin{width:38px;height:38px;border-radius:50%;display:grid;place-items:center;background:#1c2722;color:#52d58b;font-size:19px}.loccopy{flex:1}.loccopy strong,.loccopy small{display:block}.loccopy small{margin-top:3px;color:#899396;font-size:12px}.location button{width:auto;margin:0;padding:9px 12px;font-size:12px}button{width:100%;margin-top:22px;padding:14px;border:0;border-radius:13px;background:#f5f7f8;color:#101314;font-weight:800;font-size:15px}.notice{padding:12px 14px;border-radius:12px;margin:15px 0;font-size:14px}.ok{background:#173126;color:#7ee2ba}.error{background:#351b1b;color:#ff9c9c}.back{display:block;text-align:center;color:#8fe0b5;margin-top:18px;text-decoration:none;font-size:13px}</style></head><body><main class="wrap"><section class="card"><div class="logo">F</div><div style="font-size:11px;font-weight:800;letter-spacing:.16em;color:#7e8a8e">MY FETCH PROFILE</div><h1>Your profile, your context.</h1><p>Save your details and location once. Fetch will use them when finding nearby partners and services.</p>' + notice + '<form method="POST" action="/api/fetch/context"><input type="hidden" name="action" value="profile_update"><input type="hidden" name="token" value="' + safe(token) + '"><div class="field"><label>Name</label><input name="name" value="' + safe(customer?.name) + '"></div><div class="field"><label>Phone</label><input value="' + safe(customer?.phone) + '" disabled></div><div class="field"><label>Address</label><textarea name="address" placeholder="Your usual address">' + safe(customer?.address) + '</textarea></div><div class="field"><label>City</label><input name="city" value="' + safe(profile.city) + '"></div><input type="hidden" id="latitude" name="latitude" value="' + safe(lat) + '"><input type="hidden" id="longitude" name="longitude" value="' + safe(lng) + '"><div class="location"><div class="pin">⌖</div><div class="loccopy"><strong>Fetch location</strong><small id="locationStatus">' + safe(updated ? "Saved · " + updated : "Not saved yet") + '</small></div><button type="button" onclick="getLocation()">Update</button></div><button type="submit">Save my Fetch profile</button></form><a class="back" href="https://wa.me/919074559146">← Back to Fetch on WhatsApp</a></section></main><script>function getLocation(){const s=document.getElementById("locationStatus");if(!navigator.geolocation){s.textContent="Location is not supported";return}s.textContent="Requesting location…";navigator.geolocation.getCurrentPosition(p=>{document.getElementById("latitude").value=p.coords.latitude;document.getElementById("longitude").value=p.coords.longitude;s.textContent="Location ready · Fetch will use it for nearby matching";},()=>{s.textContent="Location permission was not granted";},{enableHighAccuracy:true,timeout:10000,maximumAge:60000})}</script></body></html>';
}
async function handleCustomerProfile(req, res) {
  const url = new URL(req.url, `https://${req.headers.host || "tryfetch.in"}`);
  const token = String(url.searchParams.get("token") || "").trim();
  const verified = verifyOnboardingToken(token);
  if (!verified) return sendHtml(res, 400, customerProfilePage({}, "", "This profile link has expired. Return to Fetch on WhatsApp and ask for your profile link again.", false));
  const rows = await supabaseRequest(`customers?phone=eq.${encodeURIComponent(verified.phone)}&select=*&limit=1`);
  const customer = Array.isArray(rows) && rows.length ? rows[0] : null;
  if (!customer) return sendHtml(res, 404, customerProfilePage({}, token, "We couldn't find your Fetch account.", false));
  return sendHtml(res, 200, customerProfilePage(customer, token));
}
async function handleCustomerProfileUpdate(req, res) {
  const body = req.body || {};
  const verified = verifyOnboardingToken(String(body.token || ""));
  if (!verified) return sendHtml(res, 400, customerProfilePage({}, "", "This profile link has expired.", false));
  const rows = await supabaseRequest(`customers?phone=eq.${encodeURIComponent(verified.phone)}&select=*&limit=1`);
  const customer = Array.isArray(rows) && rows.length ? rows[0] : null;
  if (!customer) return sendHtml(res, 404, customerProfilePage({}, String(body.token || ""), "We couldn't find your Fetch account.", false));
  const name = String(body.name || "").trim().slice(0, 120);
  const address = String(body.address || "").trim().slice(0, 500);
  const city = String(body.city || "").trim().slice(0, 120);
  const latitude = Number(body.latitude);
  const longitude = Number(body.longitude);
  const prefs = customer.connector_preferences && typeof customer.connector_preferences === "object" ? customer.connector_preferences : {};
  const oldProfile = prefs.profile && typeof prefs.profile === "object" ? prefs.profile : {};
  const profile = { ...oldProfile, city: city || null, latitude: Number.isFinite(latitude) ? latitude : (oldProfile.latitude ?? null), longitude: Number.isFinite(longitude) ? longitude : (oldProfile.longitude ?? null), location_updated_at: Number.isFinite(latitude) && Number.isFinite(longitude) ? new Date().toISOString() : (oldProfile.location_updated_at || null), location_source: Number.isFinite(latitude) && Number.isFinite(longitude) ? "whatsapp_profile" : (oldProfile.location_source || null) };
  const updated = await supabaseRequest(`customers?id=eq.${encodeURIComponent(customer.id)}`, { method:"PATCH", headers:{Prefer:"return=representation"}, body:JSON.stringify({name:name || customer.name || null,address:address || customer.address || null,connector_preferences:{...prefs,profile}}) });
  const next = Array.isArray(updated) && updated.length ? updated[0] : {...customer,name,address,connector_preferences:{...prefs,profile}};
  return sendHtml(res, 200, customerProfilePage(next, String(body.token || ""), "Your Fetch profile is saved. Nearby partner searches will use your saved location.", true));
}
function sendHtml(res, statusCode, html) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(html);
}

function onboardingPage(heading, body, success = true, options = {}) {
  const connectors = [
    { id: "swiggy", name: "Swiggy", detail: "Food, groceries & local delivery", icon: "S" },
    { id: "instamart", name: "Instamart", detail: "Groceries & everyday essentials", icon: "I" },
    { id: "email", name: "Email", detail: "Send, read and manage email with Fetch", icon: "@" },
    { id: "github", name: "GitHub", detail: "Repositories, issues, pull requests & code", icon: "GH" },
  ];
  const selected = options.selected || {};
  const token = String(options.token || "");
  const conversationId = String(options.conversationId || "").trim();
  const connectorRows = connectors.map((item) => {
    const connected = Boolean(selected[item.id]);
    let href = "/api/fetch/context?token=" + encodeURIComponent(token) + "&connector=" + encodeURIComponent(item.id);
    if (token && conversationId) {
      const connectParam = item.id === "email" ? "google_connect" : item.id === "instamart" ? "instamart_connect" : item.id === "github" ? "github_connect" : "swiggy_connect";
      href = "/api/fetch/context?" + connectParam + "=1&token=" + encodeURIComponent(token);
    }
    return '<div class="connector '+(connected ? "connected" : "")+'"><div class="icon">'+item.icon+'</div><div class="copy"><strong>'+item.name+'</strong><span>'+item.detail+'</span></div><a class="'+(connected ? "done" : "")+'" href="'+href+'">'+(connected ? "Connected ✓" : "Connect")+'</a></div>';
  }).join("");
  const connectorBlock = options.showConnectors ? '<section class="connectors"><div class="sectionTitle">CONNECTORS</div><p class="sub">Tools your Fetch agent can use. Choose the services you want available to Fetch.</p>'+connectorRows+'</section>' : "";
  const returnLink = options.showConnectors ? '<a class="whatsapp" href="https://wa.me/919074559146">Back to Fetch on WhatsApp →</a>' : "";
  const page = "<!doctype html><html><head><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Fetch · Connections</title><style>body{margin:0;background:#0b0d0e;color:#f5f7f8;font-family:Inter,system-ui,-apple-system,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}.card{width:min(560px,100%);background:#111516;border:1px solid #293033;border-radius:26px;padding:30px;box-sizing:border-box;box-shadow:0 24px 70px rgba(0,0,0,.45)}.logo{width:52px;height:52px;border-radius:50%;background:#fff;color:#111;display:flex;align-items:center;justify-content:center;font:700 27px Georgia;margin-bottom:24px}h1{font-size:30px;line-height:1.1;margin:0 0 12px}p{color:#aeb8bb;line-height:1.55;font-size:15px;margin:0}.status{display:inline-flex;color:__COLOR__;font-weight:700;margin:4px 0 12px}.connectors{margin-top:28px}.sectionTitle{font-size:11px;letter-spacing:.16em;color:#7e8a8e;font-weight:800;margin-bottom:8px}.sub{font-size:14px;margin-bottom:14px}.connector{display:flex;align-items:center;gap:14px;padding:14px 0;border-top:1px solid #252b2d}.icon{width:42px;height:42px;border-radius:12px;background:#1b2022;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:18px;flex:0 0 42px}.copy{display:flex;flex-direction:column;gap:4px;flex:1;min-width:0}.copy strong{font-size:16px}.copy span{font-size:13px;color:#8f9a9e}.connector a{background:#f5f7f8;color:#101314;text-decoration:none;padding:9px 14px;border-radius:10px;font-weight:700;font-size:13px}.connector a.done{background:#1e2925;color:#7ee2ba}.whatsapp{display:block;text-align:center;text-decoration:none;background:#fff;color:#111;padding:14px 18px;border-radius:13px;font-weight:700;margin-top:26px}</style></head><body><main class=\"card\"><div class=\"logo\">F</div><div class=\"status\">__STATUS__ Fetch</div><h1>__HEADING__</h1><p>__BODY__</p>__CONNECTORS____RETURN__</main></body></html>"
    .replace("__COLOR__", success ? "#20c997" : "#ff6b6b")
    .replace("__STATUS__", success ? "✓ Connected" : "!")
    .replace("__HEADING__", String(heading))
    .replace("__BODY__", String(body))
    .replace("__CONNECTORS__", connectorBlock)
    .replace("__RETURN__", returnLink);
  return page;
}
function oauthPage(title, body, success, conversationId = "") {
  const color = success ? "#20c997" : "#ff6b6b";
  const returnUrl = conversationId
    ? "/?uber=" + (success ? "connected" : "error") + "&conversation_id=" + encodeURIComponent(conversationId)
    : "/";
  return '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fetch · Uber</title><style>body{margin:0;background:#0b0d0e;color:#f5f7f8;font-family:Inter,system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center}.card{width:min(520px,calc(100% - 40px));background:#15191b;border:1px solid #293033;border-radius:24px;padding:34px;box-sizing:border-box}.logo{width:56px;height:56px;border-radius:50%;background:#fff;color:#111;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:28px;margin-bottom:28px}.status{color:'+color+';font-weight:700;margin-bottom:12px}h1{font-size:30px;line-height:1.1;margin:0 0 14px}p{color:#aeb8bb;line-height:1.6;font-size:16px}a{display:block;text-align:center;text-decoration:none;background:#fff;color:#111;padding:15px 18px;border-radius:14px;font-weight:700;margin-top:26px}</style></head><body><main class="card"><div class="logo">F</div><div class="status">'+(success ? "Connected" : "Connection failed")+'</div><h1>'+title+'</h1><p>'+body+'</p><a href="'+returnUrl+'">Return to Fetch →</a></main></body></html>';
}

async function handleUberConnect(req, res) {
  const clientId = String(process.env.UBER_CLIENT_ID || "").trim();
  const redirectUri = String(process.env.UBER_REDIRECT_URI || "https://tryfetch.in/api/fetch/context.mjs?uber_callback=1").trim();
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

async function handleUberCallback(req, res) {
  const url = new URL(req.url, `https://${req.headers.host || "tryfetch.in"}`);
  const state = url.searchParams.get("state");
  if (url.searchParams.get("error")) return res.status(400).send(oauthPage("Uber connection cancelled", "The authorization was not completed.", false));
  if (!state) return res.status(400).send(oauthPage("Invalid connection", "Fetch did not receive the OAuth state from Uber.", false));
  const stateRow = await consumeOAuthState(state);
  if (!stateRow) return res.status(400).send(oauthPage("Connection expired", "Please start the connection again.", false));
  const code = url.searchParams.get("code");
  if (!code) return res.status(400).send(oauthPage("No authorization code", "Uber did not return an authorization code.", false, stateRow.conversation_id));
  const clientId = String(process.env.UBER_CLIENT_ID || stateRow.client_id || "").trim();
  const clientSecret = String(process.env.UBER_CLIENT_SECRET || "").trim();
  const redirectUri = String(process.env.UBER_REDIRECT_URI || stateRow.redirect_uri || "").trim();
  if (!clientId || !clientSecret) return res.status(503).send(oauthPage("Fetch is not configured", "The Uber client credentials are not configured on the server yet.", false, stateRow.conversation_id));
  const tokenResponse = await fetch("https://auth.uber.com/oauth/v2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "authorization_code", redirect_uri: redirectUri, code }),
  });
  const data = await tokenResponse.json();
  if (!tokenResponse.ok || !data?.access_token) {
    console.error("FETCH UBER TOKEN ERROR", tokenResponse.status, JSON.stringify(data).slice(0, 500));
    return res.status(502).send(oauthPage("Uber could not connect", "Uber rejected the authorization. Check the Fetch redirect URI and Uber application settings.", false, stateRow.conversation_id));
  }
  await saveProviderConnection({
    conversationId: stateRow.conversation_id,
    providerId: "uber",
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    tokenType: data.token_type || "Bearer",
    expiresIn: data.expires_in,
    scopes: String(data.scope || "").split(/\s+/).filter(Boolean),
  });
  return res.status(200).send(oauthPage("Uber is connected", "Fetch securely stored the connection on the server. Return to Fetch and your pending request can continue.", true, stateRow.conversation_id));
}

async function handleOnboarding(req, res) {
  const requestUrl = new URL(req.url, `https://${req.headers.host || "tryfetch.in"}`);
  const token = requestUrl.searchParams.get("token");
  const connector = String(requestUrl.searchParams.get("connector") || "").trim().toLowerCase();
  const verified = verifyOnboardingToken(token);
  if (!verified) return sendHtml(res, 400, onboardingPage("This connection link has expired", "Return to WhatsApp and say “Hey Fetch” to receive a fresh connection link.", false));

  const rows = await supabaseRequest(`customers?phone=eq.${encodeURIComponent(verified.phone)}&select=id,name,connector_preferences&limit=1`);
  if (!Array.isArray(rows) || !rows.length) return sendHtml(res, 404, onboardingPage("We couldn't find your Fetch account", "Return to WhatsApp and say “Hey Fetch” again to start a fresh connection.", false));

  const customer = rows[0];
  const preferences = customer.connector_preferences && typeof customer.connector_preferences === "object" ? customer.connector_preferences : {};
  const allowed = new Set(["swiggy", "instamart", "email"]);
  if (connector && allowed.has(connector)) {
    preferences[connector] = true;
    await supabaseRequest(`customers?id=eq.${encodeURIComponent(customer.id)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        connector_preferences: preferences,
        whatsapp_connected: true,
        whatsapp_connected_at: new Date().toISOString(),
        whatsapp_onboarding_sent: true,
      }),
    });
  } else {
    await supabaseRequest(`customers?id=eq.${encodeURIComponent(customer.id)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ whatsapp_connected: true, whatsapp_connected_at: new Date().toISOString(), whatsapp_onboarding_sent: true }),
    });
  }

  const firstName = String(customer.name || "").trim().split(/\s+/)[0];
  const selected = { ...preferences };
  const title = connector ? `${connector.charAt(0).toUpperCase() + connector.slice(1)} is connected.` : `You're connected${firstName ? `, ${firstName}` : ""}.`;
  const body = connector
    ? `Fetch will now keep ${connector} available as an execution path. You can connect another service below.`
    : "WhatsApp is connected to Fetch. Choose the services you want Fetch to be able to use.";
  return sendHtml(
    res,
    200,
    onboardingPage(title, body, true, { showConnectors: true, selected, token, conversationId: verified.conversationId })
  );
}

const SWIGGY_BASE = "https://mcp.swiggy.com";
const FETCH_BASE = "https://tryfetch.in";

function makePkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function connectorCallbackUrl(provider) {
  if (provider === "swiggy") {
    return "https://fetch-website-tan.vercel.app/api/fetch/swiggy/callback.mjs";
  }
  if (provider === "github") {
    return FETCH_BASE + "/api/fetch/context.mjs?github_callback=1";
  }
  return FETCH_BASE + "/api/fetch/context.mjs?" + (provider === "google" ? "google_callback=1" : "swiggy_callback=1");
}

async function registerSwiggyClient(redirectUri) {
  if (process.env.SWIGGY_CLIENT_ID) {
    return { clientId: String(process.env.SWIGGY_CLIENT_ID), clientSecret: process.env.SWIGGY_CLIENT_SECRET || null };
  }
  const response = await fetch(SWIGGY_BASE + "/auth/register", {
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
    throw new Error("Swiggy client registration failed (" + response.status + ")");
  }
  return { clientId: data.client_id, clientSecret: data.client_secret || null };
}

async function handleOAuthWhatsAppResume(req, res) {
  const url = new URL(req.url, FETCH_BASE);
  const conversationId = String(url.searchParams.get("conversation_id") || "").trim();
  if (!conversationId.startsWith("whatsapp:")) {
    return sendHtml(res, 400, onboardingPage("Invalid WhatsApp session", "Please return to Fetch.", false));
  }

  const phone = conversationId.slice("whatsapp:".length);
  if (phone.length < 8 || phone.length > 15 || !/^\d+$/.test(phone)) {
    return sendHtml(res, 400, onboardingPage("Invalid WhatsApp session", "Please return to Fetch.", false));
  }

  const contextRows = await supabaseRequest(
    "fetch_conversation_context?conversation_id=eq." +
    encodeURIComponent(conversationId) +
    "&select=context&limit=1"
  );
  const context =
    Array.isArray(contextRows) && contextRows[0]?.context && typeof contextRows[0].context === "object"
      ? contextRows[0].context
      : {};
  const pendingRequest = String(context?.instamart?.pendingRequest || "").trim();

  const message =
    "Instamart is connected to Fetch.\n\n" +
    (pendingRequest
      ? "I’m ready to continue your request: " + pendingRequest + "\n\nSend it again here and I’ll continue in WhatsApp."
      : "You can now use Instamart directly from this WhatsApp chat.\n\nFor example: Get me a KitKat.");

  const response = await fetch(
    "https://graph.facebook.com/v26.0/" +
      String(process.env.WHATSAPP_PHONE_NUMBER_ID || "") +
      "/messages",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + String(process.env.WHATSAPP_ACCESS_TOKEN || ""),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: phone,
        type: "text",
        text: { body: message },
      }),
    }
  );

  if (!response.ok) {
    const raw = await response.text();
    throw new Error("WhatsApp resume message failed: " + response.status + " " + raw.slice(0, 300));
  }

  return sendHtml(
    res,
    200,
    onboardingPage(
      "Instamart connected",
      "Fetch has connected Instamart. Return to your WhatsApp chat — your next Instamart request will stay inside WhatsApp.",
      true
    )
  );
}

async function handleSwiggyConnect(req, res, provider) {
  const url = new URL(req.url, FETCH_BASE);
  const onboardingToken = String(url.searchParams.get("token") || "").trim();
  const verified = onboardingToken ? verifyOnboardingToken(onboardingToken) : null;
  const conversationId = verified?.conversationId || String(url.searchParams.get("conversation_id") || "").trim();
  if (!conversationId) return sendHtml(res, 400, onboardingPage("Fetch session missing", "Open Fetch in this browser first, then return to Connectors.", false));
  const redirectUri = connectorCallbackUrl(provider);
  const { verifier, challenge } = makePkce();
  const { clientId } = await registerSwiggyClient(redirectUri);
  const state = crypto.randomBytes(32).toString("base64url");
  await createOAuthState({ state, conversationId, providerId: provider, redirectUri, clientId, codeVerifier: verifier });
  const authorize = new URL(SWIGGY_BASE + "/auth/authorize");
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

async function handleSwiggyCallback(req, res) {
  const url = new URL(req.url, FETCH_BASE);
  const state = url.searchParams.get("state");
  if (url.searchParams.get("error")) return sendHtml(res, 400, onboardingPage("Connection cancelled", "No connection was saved. Return to Connectors and try again.", false));
  if (!state) return sendHtml(res, 400, onboardingPage("Invalid connection", "Fetch did not receive a valid OAuth state.", false));
  const stateRow = await consumeOAuthState(state);
  if (!stateRow) return sendHtml(res, 400, onboardingPage("Connection expired", "Please start the connection again.", false));
  const code = url.searchParams.get("code");
  if (!code) return sendHtml(res, 400, onboardingPage("Authorization incomplete", "The provider did not return an authorization code.", false));
  const tokenResponse = await fetch(SWIGGY_BASE + "/auth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: stateRow.code_verifier || "",
      redirect_uri: stateRow.redirect_uri,
    }),
  });
  const data = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !data?.access_token) {
    console.error("FETCH SWIGGY TOKEN ERROR", tokenResponse.status, JSON.stringify(data).slice(0, 500));
    return sendHtml(res, 502, onboardingPage("Provider could not connect", "The authorization reached the provider, but the token exchange was rejected. The provider may need Fetch's callback URL allowlisted.", false));
  }
  const connectionPayload = {
    conversationId: stateRow.conversation_id,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    tokenType: data.token_type || "Bearer",
    expiresIn: data.expires_in,
    scopes: String(data.scope || "").split(/\s+/).filter(Boolean),
  };

  // One Swiggy OAuth grant covers both Food and Instamart.
  await saveProviderConnection({ ...connectionPayload, providerId: "swiggy" });
  await saveProviderConnection({ ...connectionPayload, providerId: "instamart" });
  await saveProviderConnection({ ...connectionPayload, providerId: "swiggy_instamart" });
  return sendHtml(res, 200, onboardingPage(
    stateRow.provider_id === "instamart" ? "Instamart is connected." : "Swiggy is connected.",
    "Fetch securely stored the provider connection. You can return to Fetch and continue your task.",
    true,
    { showConnectors: true, selected: { swiggy: true, instamart: true }, token: onboardingToken, conversationId: stateRow.conversation_id }
  ));
}


function githubOAuthConfig() {
  const clientId = String(process.env.GITHUB_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.GITHUB_CLIENT_SECRET || "").trim();
  const redirectUri = String(process.env.GITHUB_REDIRECT_URI || (FETCH_BASE + "/api/fetch/context.mjs?github_callback=1")).trim();
  return { clientId, clientSecret, redirectUri };
}

async function handleGitHubConnect(req, res) {
  const { clientId, redirectUri } = githubOAuthConfig();
  if (!clientId) {
    return sendHtml(res, 503, onboardingPage(
      "GitHub is not configured yet",
      "Fetch has the GitHub connector ready, but the GitHub OAuth application credentials have not been added to Vercel yet.",
      false
    ));
  }
  const url = new URL(req.url, FETCH_BASE);
  const onboardingToken = String(url.searchParams.get("token") || "").trim();
  const verified = onboardingToken ? verifyOnboardingToken(onboardingToken) : null;
  const conversationId =
    verified?.conversationId ||
    String(url.searchParams.get("conversation_id") || "").trim();
  if (!conversationId) return sendHtml(res, 400, onboardingPage("Fetch session missing", "Open Fetch in this browser first, then return to Connectors.", false));
  const { verifier, challenge } = makePkce();
  const state = crypto.randomBytes(32).toString("base64url");
  await createOAuthState({ state, conversationId, providerId: "github", redirectUri, clientId, codeVerifier: verifier });
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("scope", "read:user user:email repo");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("allow_signup", "false");
  res.statusCode = 302;
  res.setHeader("Location", authorize.toString());
  return res.end();
}

async function handleGitHubCallback(req, res) {
  const url = new URL(req.url, FETCH_BASE);
  const state = url.searchParams.get("state");
  if (url.searchParams.get("error")) return sendHtml(res, 400, onboardingPage("GitHub connection cancelled", "No GitHub connection was saved. Return to Connectors and try again.", false));
  if (!state) return sendHtml(res, 400, onboardingPage("Invalid GitHub connection", "Fetch did not receive a valid OAuth state.", false));
  const stateRow = await consumeOAuthState(state);
  if (!stateRow || stateRow.provider_id !== "github") return sendHtml(res, 400, onboardingPage("GitHub connection expired", "Please start the GitHub connection again.", false));
  const code = String(url.searchParams.get("code") || "").trim();
  if (!code) return sendHtml(res, 400, onboardingPage("GitHub authorization incomplete", "GitHub did not return an authorization code.", false));
  const { clientId, clientSecret, redirectUri } = githubOAuthConfig();
  if (!clientId || !clientSecret) return sendHtml(res, 503, onboardingPage("GitHub is not configured yet", "Add GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET to the Fetch production environment, then try again.", false));
  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri || stateRow.redirect_uri,
      code_verifier: stateRow.code_verifier || "",
    }),
  });
  const data = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !data?.access_token) {
    console.error("FETCH GITHUB TOKEN ERROR", tokenResponse.status, JSON.stringify(data).slice(0, 500));
    return sendHtml(res, 502, onboardingPage("GitHub could not connect", "GitHub rejected the authorization. Check the Fetch callback URL and GitHub OAuth application settings.", false));
  }
  const accessToken = String(data.access_token);
  const meResponse = await fetch("https://api.github.com/user", {
    headers: {
      "Authorization": "Bearer " + accessToken,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10",
      "User-Agent": "Fetch",
    },
  });
  const me = await meResponse.json().catch(() => ({}));
  if (!meResponse.ok || !me?.id) {
    console.error("FETCH GITHUB IDENTITY ERROR", meResponse.status, JSON.stringify(me).slice(0, 500));
    return sendHtml(res, 502, onboardingPage("GitHub identity could not be verified", "Fetch received a token but could not verify the GitHub account. Please reconnect.", false));
  }
  await saveProviderConnection({
    conversationId: stateRow.conversation_id,
    providerId: "github",
    accessToken,
    refreshToken: data.refresh_token || null,
    tokenType: data.token_type || "Bearer",
    expiresIn: data.expires_in,
    scopes: String(data.scope || "").split(/[ ,]+/).filter(Boolean),
  });
  return sendHtml(res, 200, onboardingPage(
    "GitHub is connected.",
    "Fetch securely stored the GitHub connection. Repositories, issues, pull requests and code are now available as an execution path.",
    true
  ));
}

async function handleGoogleConnect(req, res) {
  const clientId = String(process.env.GOOGLE_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.GOOGLE_CLIENT_SECRET || "").trim();
  if (!clientId || !clientSecret) return sendHtml(res, 503, onboardingPage("Email is not configured yet", "Fetch is ready for Gmail OAuth, but Google OAuth credentials have not been added to Vercel yet.", false));
  const url = new URL(req.url, FETCH_BASE);
  const conversationId = String(url.searchParams.get("conversation_id") || "").trim();
  if (!conversationId) return sendHtml(res, 400, onboardingPage("Fetch session missing", "Open Fetch in this browser first, then return to Connectors.", false));
  const state = crypto.randomBytes(32).toString("base64url");
  const redirectUri = connectorCallbackUrl("google");
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

async function handleGoogleCallback(req, res) {
  const url = new URL(req.url, FETCH_BASE);
  const stateRow = await consumeOAuthState(url.searchParams.get("state") || "");
  if (!stateRow) return sendHtml(res, 400, onboardingPage("Connection expired", "Please start the email connection again.", false));
  const code = url.searchParams.get("code");
  const clientId = String(process.env.GOOGLE_CLIENT_ID || stateRow.client_id || "").trim();
  const clientSecret = String(process.env.GOOGLE_CLIENT_SECRET || "").trim();
  if (!code || !clientId || !clientSecret) return sendHtml(res, 400, onboardingPage("Email authorization incomplete", "Google did not return everything Fetch needs.", false));
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: stateRow.redirect_uri, grant_type: "authorization_code" }),
  });
  const data = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !data?.access_token) return sendHtml(res, 502, onboardingPage("Google could not connect", "Google rejected the token exchange. Check the OAuth redirect URI and consent configuration.", false));
  await saveProviderConnection({
    conversationId: stateRow.conversation_id,
    providerId: "email",
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    tokenType: data.token_type || "Bearer",
    expiresIn: data.expires_in,
    scopes: String(data.scope || "").split(/\s+/).filter(Boolean),
  });
  return sendHtml(res, 200, onboardingPage("Email is connected.", "Fetch securely stored the Google connection. Email is now available as an execution path.", true));
}

async function handleConnectorStatus(req, res) {
  const url = new URL(req.url, FETCH_BASE);
  const conversationId = String(url.searchParams.get("conversation_id") || "").trim();
  if (!conversationId) return res.status(400).json({ success: false, error: "conversation_id_required" });
  const result = {};
  for (const providerId of ["swiggy", "instamart", "swiggy_instamart", "email", "uber", "github"]) {
    const connection = await getProviderConnection({ conversationId, providerId });
    result[providerId] = Boolean(connection?.access_token);
  }
  return res.status(200).json({ success: true, connections: result });
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    const requestUrl = new URL(req.url, `https://${req.headers.host || "tryfetch.in"}`);
    if (requestUrl.searchParams.get("partner") === "1") return sendHtml(res, 200, partnerPortalPage());
    if (requestUrl.searchParams.get("profile") === "1") return await handleCustomerProfile(req, res);
    if (requestUrl.searchParams.get("oauth_resume") === "1") {
      try { return await handleOAuthWhatsAppResume(req, res); }
      catch (error) {
        console.error("FETCH OAUTH WHATSAPP RESUME ERROR:", error);
        return sendHtml(res, 500, onboardingPage("Connection saved", "Your connector was saved. Return to WhatsApp to continue.", true));
      }
    }
    if (requestUrl.searchParams.get("status") === "1") {
      try { return await handleConnectorStatus(req, res); }
      catch (error) { console.error("FETCH CONNECTOR STATUS ERROR:", error); return res.status(500).json({ success:false, error:"connector_status_failed" }); }
    }
    if (requestUrl.searchParams.get("swiggy_connect") === "1") {
      try { return await handleSwiggyConnect(req, res, "swiggy"); }
      catch (error) { console.error("FETCH SWIGGY CONNECT ERROR:", error); return sendHtml(res, 500, onboardingPage("Fetch could not start Swiggy", error?.message || "Please try again.", false)); }
    }
    if (requestUrl.searchParams.get("instamart_connect") === "1") {
      try { return await handleSwiggyConnect(req, res, "instamart"); }
      catch (error) { console.error("FETCH INSTANTMART CONNECT ERROR:", error); return sendHtml(res, 500, onboardingPage("Fetch could not start Instamart", error?.message || "Please try again.", false)); }
    }
    if (requestUrl.searchParams.get("swiggy_callback") === "1") {
      try { return await handleSwiggyCallback(req, res); }
      catch (error) { console.error("FETCH SWIGGY CALLBACK ERROR:", error); return sendHtml(res, 500, onboardingPage("Connection failed", "Fetch could not finish the provider connection.", false)); }
    }
    if (requestUrl.searchParams.get("github_connect") === "1") {
      try { return await handleGitHubConnect(req, res); }
      catch (error) { console.error("FETCH GITHUB CONNECT ERROR:", error); return sendHtml(res, 500, onboardingPage("Fetch could not start GitHub connection", error?.message || "Please try again.", false)); }
    }
    if (requestUrl.searchParams.get("github_callback") === "1") {
      try { return await handleGitHubCallback(req, res); }
      catch (error) { console.error("FETCH GITHUB CALLBACK ERROR:", error); return sendHtml(res, 500, onboardingPage("GitHub connection failed", "Fetch could not finish the GitHub connection.", false)); }
    }
    if (requestUrl.searchParams.get("google_connect") === "1") {
      try { return await handleGoogleConnect(req, res); }
      catch (error) { console.error("FETCH GOOGLE CONNECT ERROR:", error); return sendHtml(res, 500, onboardingPage("Fetch could not start email connection", error?.message || "Please try again.", false)); }
    }
    if (requestUrl.searchParams.get("google_callback") === "1") {
      try { return await handleGoogleCallback(req, res); }
      catch (error) { console.error("FETCH GOOGLE CALLBACK ERROR:", error); return sendHtml(res, 500, onboardingPage("Email connection failed", "Fetch could not finish the Google connection.", false)); }
    }
    if (requestUrl.searchParams.get("uber_connect") === "1") {
      try { return await handleUberConnect(req, res); }
      catch (error) {
        console.error("FETCH UBER CONNECT ERROR:", error);
        return res.status(500).send("Fetch could not start the Uber connection.");
      }
    }
    if (requestUrl.searchParams.get("uber_callback") === "1") {
      try { return await handleUberCallback(req, res); }
      catch (error) {
        console.error("FETCH UBER CALLBACK ERROR:", error);
        return res.status(500).send(oauthPage("Connection failed", "Fetch could not finish the Uber connection.", false));
      }
    }
    if (requestUrl.searchParams.has("token")) {
    try { return await handleOnboarding(req, res); }
    catch (error) {
      console.error("FETCH WHATSAPP ONBOARDING ERROR:", error);
      return sendHtml(res, 500, onboardingPage("Something went wrong", "Please return to WhatsApp and try again.", false));
    }
  }
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const body = req.body || {};

    /*
     * Existing endpoint, new action seam:
     * keep Instamart execution inside this already-deployed serverless
     * function so the Hobby-plan 12-function limit is not increased.
     */
    const action = String(body.action || "").trim();
    if (action === "profile_update") return await handleCustomerProfileUpdate(req, res);
    if (action.startsWith("instamart_")) {
      const conversationId = String(body.conversation_id || body.conversationId || "").trim();
      if (!conversationId) return res.status(400).json({ success: false, error: "conversation_id_required" });

      const connection =
        await getProviderConnection({ conversationId, providerId: "swiggy_instamart" }) ||
        await getProviderConnection({ conversationId, providerId: "instamart" }) ||
        await getProviderConnection({ conversationId, providerId: "swiggy" });

      const accessToken = connection?.access_token;
      if (!accessToken) {
        return res.status(401).json({
          success: false,
          status: "connection_required",
          provider: "swiggy_instamart",
          message: "Connect Swiggy to Fetch before using Instamart."
        });
      }

      const {
        prepareInstamartOrder,
        applyInstamartSelection,
        confirmInstamartCheckout,
        checkInstamartPaymentStatus,
        trackInstamartOrder,
      } = await import("../../lib/fetch-instamart-execution.mjs");

      if (action === "instamart_prepare") {
        return res.status(200).json(await prepareInstamartOrder({
          accessToken,
          items: Array.isArray(body.items) ? body.items : [],
          addressId: String(body.addressId || "").trim(),
          autoSelect: body.autoSelect === true
        }));
      }

      if (action === "instamart_selection") {
        return res.status(200).json(await applyInstamartSelection({
          accessToken,
          addressId: String(body.addressId || "").trim(),
          items: Array.isArray(body.items) ? body.items : []
        }));
      }

      if (action === "instamart_checkout") {
        return res.status(200).json(await confirmInstamartCheckout({
          accessToken,
          addressId: String(body.addressId || "").trim(),
          paymentMethod: String(body.paymentMethod || "").trim(),
          intentApp: String(body.intentApp || "").trim() || undefined,
          generateUPIQR: body.generateUPIQR === true,
          confirmed: body.confirmed === true
        }));
      }

      if (action === "instamart_payment_status") {
        return res.status(200).json(await checkInstamartPaymentStatus({
          accessToken,
          paasId: String(body.paasId || "").trim(),
          orderId: String(body.orderId || "").trim()
        }));
      }

      if (action === "instamart_track") {
        return res.status(200).json(await trackInstamartOrder({
          accessToken,
          orderId: String(body.orderId || "").trim()
        }));
      }

      return res.status(400).json({ success: false, error: "unknown_instamart_action" });
    }

    if (!body.text || typeof body.text !== "string") return res.status(400).json({ error: "text is required" });
    const { processFetchV8Request } = await import("../../lib/fetch-v8.mjs");
    const result = await processFetchV8Request({ text: body.text, customerId: body.customer_id || null, conversationId: body.conversation_id || null, channel: body.channel || "api", activeTaskId: body.active_task_id || null, suppliedIntent: body.intent || null, suppliedContext: body.context || {} });
    return res.status(200).json(result);
  } catch (error) {
    console.error("FETCH V8 CONTEXT ERROR:", error);
    return res.status(500).json({ error: "context_decision_failed", message: error?.message || String(error) });
  }
}