import { getSwiggyToken } from "../../../lib/swiggy-oauth-v2.mjs";
import { prepareInstamartOrder, applyInstamartSelection, confirmInstamartCheckout, checkInstamartPaymentStatus, trackInstamartOrder } from "../../../lib/fetch-instamart-execution.mjs";

function clean(value) { return String(value ?? "").trim(); }
function json(res, status, body) {
  res.status(status);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { success: false, error: "Method not allowed" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const conversationId = clean(body.conversationId);
    if (!conversationId) return json(res, 400, { success: false, error: "conversationId is required" });

    const token = await getSwiggyToken(conversationId);
    if (!token) return json(res, 401, {
      success: false,
      status: "connection_required",
      error: "SWIGGY_CONNECTION_REQUIRED",
      message: "Your Swiggy connection has expired or is missing. Reconnect Swiggy to Fetch to continue."
    });

    const action = clean(body.action) || "prepare";

    if (action === "prepare") return json(res, 200, await prepareInstamartOrder({
      accessToken: token.access_token,
      items: Array.isArray(body.items) ? body.items : [],
      addressId: clean(body.addressId),
      autoSelect: body.autoSelect === true
    }));
    if (action === "selection") return json(res, 200, await applyInstamartSelection({ accessToken: token.access_token, addressId: clean(body.addressId), items: Array.isArray(body.items) ? body.items : [] }));
    if (action === "checkout") return json(res, 200, await confirmInstamartCheckout({ accessToken: token.access_token, addressId: clean(body.addressId), paymentMethod: clean(body.paymentMethod) || undefined, intentApp: clean(body.intentApp) || undefined, generateUPIQR: body.generateUPIQR === true, confirmed: body.confirmed === true }));
    if (action === "payment_status") return json(res, 200, await checkInstamartPaymentStatus({ accessToken: token.access_token, paasId: clean(body.paasId), orderId: clean(body.orderId) }));
    if (action === "track") return json(res, 200, await trackInstamartOrder({ accessToken: token.access_token, orderId: clean(body.orderId) }));

    return json(res, 400, { success: false, error: "Unknown Instamart action" });
  } catch (error) {
    console.error("FETCH SWIGGY EXECUTION ERROR", error);
    return json(res, 500, { success: false, error: error?.message || "Swiggy execution failed" });
  }
}
