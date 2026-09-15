import {
  atcSafe,
  atcSyncShopperResource,
  atcSelectResourceForOrder,
  atcRecordAssignment,
  atcUpdateAssignmentStatus,
  atcRecordEvent,
} from "../../lib/atc.mjs";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || "https://skfxzagxlxputwpwxwbe.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const CRON_SECRET = process.env.CRON_SECRET;
const STALE_ACCEPTED_SHOPPER_MINUTES = 7;

function normalizePhone(phone) { return phone ? String(phone).replace(/[^\d]/g, "") : ""; }

async function supabaseRequest(path, options = {}) {
  if (!SUPABASE_KEY) throw new Error("SUPABASE_SECRET_KEY is missing");
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const raw = await response.text();
  let data = null;
  if (raw) { try { data = JSON.parse(raw); } catch { data = raw; } }
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

async function sendWhatsAppMessage(to, message) {
  if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) throw new Error("WhatsApp environment variables are missing");
  const response = await fetch(`https://graph.facebook.com/v26.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: normalizePhone(to), type: "text", text: { preview_url: false, body: message } }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`WhatsApp ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

async function updateOrder(orderId, updates) {
  const data = await supabaseRequest(`orders?id=eq.${encodeURIComponent(orderId)}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(updates) });
  return Array.isArray(data) && data.length ? data[0] : null;
}
async function updateShopper(shopperId, updates) {
  const data = await supabaseRequest(`shoppers?id=eq.${encodeURIComponent(shopperId)}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(updates) });
  return Array.isArray(data) && data.length ? data[0] : null;
}
async function updateShopperJob(jobId, updates) {
  const data = await supabaseRequest(`shopper_jobs?id=eq.${encodeURIComponent(jobId)}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(updates) });
  return Array.isArray(data) && data.length ? data[0] : null;
}
async function createShopperJob(orderId, shopperId) {
  const data = await supabaseRequest("shopper_jobs", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ order_id: orderId, shopper_id: shopperId, status: "offered", offered_at: new Date().toISOString() }) });
  return Array.isArray(data) ? data[0] : data;
}
async function getAvailableShoppers(excludedIds = []) {
  const data = await supabaseRequest("shoppers?available=eq.true&whatsapp_opted_in=eq.true&approval_status=eq.approved&select=*&limit=100");
  if (!Array.isArray(data)) return [];
  return data.filter(s => !excludedIds.includes(s.id) && !s.current_order_id);
}
async function offerOrderToAvailableShoppers(order, excludedIds = []) {
  if (!order?.id) return { offeredCount: 0, shoppers: [] };

  let shoppers = await getAvailableShoppers(excludedIds);
  if (!shoppers.length) return { offeredCount: 0, shoppers: [] };

  const atcMatch = await atcSafe(
    () => atcSelectResourceForOrder({
      order,
      excludedShopperIds: excludedIds,
    }),
    "recovery_resource_matching"
  );

  if (atcMatch?.shopperId) {
    shoppers = shoppers.filter(
      (shopper) => String(shopper.id) === String(atcMatch.shopperId)
    );
  }

  let offeredCount = 0;
  const offeredShoppers = [];

  for (const shopper of shoppers) {
    try {
      const job = await createShopperJob(order.id, shopper.id);
      if (!job?.id) continue;

      await atcSafe(
        () => atcRecordAssignment({
          orderId: order.id,
          shopperId: shopper.id,
          status: "offered",
          jobId: job.id,
        }),
        "recovery_assignment_offered"
      );

      await sendWhatsAppMessage(
        shopper.phone,
        `🛍️ *New Fetch Job*\n\n` +
        `🛒 Items: ${order.items || "Requested items"}\n` +
        (order.delivery_address
          ? `📍 Deliver to: ${order.delivery_address}\n`
          : "📍 Delivery location: customer will share location\n") +
        `\nPlease find the requested item at a suitable source and report the product price.\n\n` +
        `Reply *ACCEPT* to take this job.\n` +
        `Reply *DECLINE* to skip it.\n\n` +
        `⚡ The first shopper to ACCEPT gets this order.`
      );

      offeredCount += 1;
      offeredShoppers.push(shopper.id);

      await atcSafe(
        () => atcRecordEvent({
          orderId: order.id,
          eventType: "resource_offered",
          actorType: "atc",
          actorId: shopper.id,
          metadata: {
            job_id: job.id,
            recovery: true,
            match_reason: atcMatch?.reason || "recovery_fallback",
            distance_km: atcMatch?.distanceKm ?? null,
          },
        }),
        "recovery_resource_offered_event"
      );
    } catch (error) {
      console.error(
        "FETCH RECOVERY OFFER FAILED:",
        JSON.stringify({ orderId: order.id, shopperId: shopper.id, error: error?.message || String(error) })
      );
    }
  }

  return { offeredCount, shoppers: offeredShoppers };
}

async function getCustomerPhone(customerId) {
  if (!customerId) return null;
  const data = await supabaseRequest(`customers?id=eq.${encodeURIComponent(customerId)}&select=phone&limit=1`);
  return Array.isArray(data) && data.length ? data[0].phone : null;
}

async function recoverStaleAcceptedOrders() {
  const cutoff = new Date(Date.now() - STALE_ACCEPTED_SHOPPER_MINUTES * 60 * 1000).toISOString();
  const jobs = await supabaseRequest(`shopper_jobs?status=eq.accepted&accepted_at=lt.${encodeURIComponent(cutoff)}&select=*&order=accepted_at.asc&limit=100`);
  if (!Array.isArray(jobs) || !jobs.length) return { scanned: 0, recovered: 0, skipped: 0 };
  let recovered = 0, skipped = 0;

  for (const job of jobs) {
    try {
      if (!job?.order_id || !job?.shopper_id) { skipped++; continue; }
      const orders = await supabaseRequest(`orders?id=eq.${encodeURIComponent(job.order_id)}&select=*&limit=1`);
      const order = Array.isArray(orders) && orders.length ? orders[0] : null;
      if (!order || order.status !== "shopper_assigned" || order.shopper_id !== job.shopper_id) { skipped++; continue; }
      const paymentStatus = String(order.payment_status || "unpaid").toLowerCase();
      if (paymentStatus === "paid") { skipped++; continue; }
      const shoppers = await supabaseRequest(`shoppers?id=eq.${encodeURIComponent(job.shopper_id)}&select=*&limit=1`);
      const shopper = Array.isArray(shoppers) && shoppers.length ? shoppers[0] : null;
      if (!shopper || shopper.current_order_id !== order.id) { skipped++; continue; }
      const lastSeen = shopper.last_seen_at ? Date.parse(shopper.last_seen_at) : 0;
      if (lastSeen && Date.now() - lastSeen < STALE_ACCEPTED_SHOPPER_MINUTES * 60 * 1000) { skipped++; continue; }

      const released = await supabaseRequest(`orders?id=eq.${encodeURIComponent(order.id)}&status=eq.shopper_assigned&shopper_id=eq.${encodeURIComponent(shopper.id)}`, {
        method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ status: "finding_shopper", shopper_id: null }),
      });
      if (!Array.isArray(released) || !released.length) { skipped++; continue; }

      await updateShopperJob(job.id, { status: "cancelled" });
      const releasedShopper = await updateShopper(shopper.id, { available: true, current_order_id: null, last_seen_at: new Date().toISOString() });

      await atcSafe(
        () => atcSyncShopperResource(releasedShopper || { ...shopper, available: true, current_order_id: null }),
        "cron_released_shopper_resource_sync"
      );

      await atcSafe(
        () => atcUpdateAssignmentStatus({
          orderId: order.id,
          shopperId: shopper.id,
          jobId: job.id,
          status: "expired",
        }),
        "cron_assignment_expired"
      );

      await atcSafe(
        () => atcRecordEvent({
          orderId: order.id,
          eventType: "resource_expired",
          actorType: "system",
          actorId: shopper.id,
          metadata: { job_id: job.id, reason: "inactive", recovery: "redispatch" },
        }),
        "cron_resource_expired_event"
      );

      if (shopper.phone) await sendWhatsAppMessage(shopper.phone, "⏱️ This Fetch job was released because there was no activity for 7 minutes. You’re available for the next Fetch job.");

      let dispatchResult = { offeredCount: 0, shoppers: [] };
      try {
        dispatchResult = await offerOrderToAvailableShoppers(released[0], [shopper.id]);
      } catch (dispatchError) {
        console.error("FETCH RECOVERY DISPATCH ERROR:", dispatchError);
      }

      console.log("FETCH RECOVERY DISPATCH RESULT:", JSON.stringify({
        orderId: order.id,
        previousShopperId: shopper.id,
        offeredCount: dispatchResult.offeredCount,
        offeredShoppers: dispatchResult.shoppers,
      }));

      await atcSafe(
        () => atcRecordEvent({
          orderId: order.id,
          eventType: dispatchResult.offeredCount > 0 ? "resource_redispatched" : "resource_redispatch_pending",
          actorType: "atc",
          metadata: {
            failed_shopper_id: shopper.id,
            replacement_shopper_ids: dispatchResult.shoppers || [],
            recovery: "stale_shopper",
          },
        }),
        "cron_redispatch_result_event"
      );

      // Customer notification is independent from shopper dispatch.
      // A failed shopper offer must never suppress the customer update.
      try {
        const customerPhone = await getCustomerPhone(order.customer_id);
        console.log("FETCH RECOVERY CUSTOMER PHONE:", customerPhone ? "found" : "not_found");
        if (customerPhone) {
          const customerMessage = dispatchResult.offeredCount > 0
            ? "⚠️ Your Fetch shopper didn’t continue after accepting the order. I’m finding another shopper for you now."
            : "⚠️ Your Fetch shopper didn’t continue after accepting the order. I’m looking for another available shopper now.";
          await sendWhatsAppMessage(customerPhone, customerMessage);
          console.log("FETCH RECOVERY CUSTOMER NOTIFIED:", order.id);
        }
      } catch (customerError) {
        console.error("FETCH RECOVERY CUSTOMER NOTIFICATION ERROR:", customerError);
      }

      recovered++;
    } catch (error) { console.error("FETCH STALE SHOPPER RECOVERY ERROR:", error); }
  }
  return { scanned: jobs.length, recovered, skipped };
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  if (!CRON_SECRET || req.headers.authorization !== `Bearer ${CRON_SECRET}`) return res.status(401).json({ ok: false, error: "Unauthorized" });
  try {
    const result = await recoverStaleAcceptedOrders();
    console.log("FETCH STALE SHOPPER RECOVERY:", JSON.stringify(result));
    return res.status(200).json({ ok: true, ...result });
  } catch (error) {
    console.error("FETCH STALE RECOVERY CRON ERROR:", error);
    return res.status(500).json({ ok: false, error: error.message });
  }
}
