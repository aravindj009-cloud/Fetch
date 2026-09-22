/*
  FETCH PHYSICAL EXECUTION CONNECTOR — V1

  Purpose:
  - Connect a matched ATC partner_store resource to the EXISTING
    partner-store WhatsApp execution engine.
  - Do not create a second physical-order state machine.
  - Do not claim the order is completed when the store has only been offered it.
  - Reuse the existing partner_store_requests idempotency behavior.
  - Fail closed if an existing physical order is not supplied.

  Flow:
    FETCH -> ATC -> partner_store -> this connector
      -> existing partner-store engine -> WhatsApp store
      -> store response -> existing webhook state machine

  The existing WhatsApp order engine remains authoritative for:
    partner acceptance/rejection, price, shopper assignment,
    payment, pickup, delivery, and completion.
*/

import { offerOrderToPartnerStore } from "./partner-store.mjs";

function cleanText(value) {
  return String(value || "").trim();
}

function normalizeId(value) {
  const text = cleanText(value);
  return text || null;
}

function routePartnerStoreId(route = {}) {
  return normalizeId(
    route?.partner_store_id ||
    route?.partnerStoreId ||
    route?.resource?.metadata?.partner_store_id ||
    null
  );
}

async function fetchPartnerStoreById(partnerStoreId) {
  const supabaseUrl =
    process.env.VITE_SUPABASE_URL ||
    "https://skfxzagxlxputwpwxwbe.supabase.co";
  const supabaseKey = process.env.SUPABASE_SECRET_KEY;

  if (!supabaseKey) {
    throw new Error("SUPABASE_SECRET_KEY is missing");
  }

  const response = await fetch(
    `${supabaseUrl}/rest/v1/partner_stores?id=eq.${encodeURIComponent(
      partnerStoreId
    )}&select=*&limit=1`,
    {
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        "Content-Type": "application/json",
      },
    }
  );

  const raw = await response.text();

  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = raw;
  }

  if (!response.ok) {
    throw new Error(
      `Fetch Physical Store ${response.status}: ${
        typeof data === "string" ? data : JSON.stringify(data)
      }`
    );
  }

  return Array.isArray(data) && data.length ? data[0] : null;
}

export async function executePhysicalPartnerStore({
  task = {},
  route = {},
  physicalOrder = null,
  context = {},
} = {}) {
  const order =
    physicalOrder?.id
      ? physicalOrder
      : physicalOrder?.order
      ? physicalOrder.order
      : null;

  if (!order?.id) {
    return {
      success: false,
      status: "awaiting_physical_order",
      message:
        "ATC matched a partner store, but the existing physical order context was not supplied.",
      execution_type: "partner_store",
      side_effect: false,
    };
  }

  const partnerStoreId = routePartnerStoreId(route);

  if (!partnerStoreId) {
    return {
      success: false,
      status: "execution_failed",
      message:
        "ATC matched a partner-store resource but did not provide a partner store ID.",
      execution_type: "partner_store",
      side_effect: false,
    };
  }

  const partnerStore = await fetchPartnerStoreById(partnerStoreId);

  if (!partnerStore?.id) {
    return {
      success: false,
      status: "execution_failed",
      message: "The ATC-selected partner store could not be loaded.",
      execution_type: "partner_store",
      side_effect: false,
    };
  }

  const result = await offerOrderToPartnerStore({
    order,
    partnerStore,
    distanceKm:
      route?.distance_km ??
      route?.distanceKm ??
      null,
    resourceId:
      route?.resource_id ??
      route?.resourceId ??
      null,
  });

  if (!result?.success) {
    return {
      success: false,
      status: "execution_failed",
      message:
        result?.reason ||
        "The partner-store offer could not be submitted.",
      execution_type: "partner_store",
      side_effect: false,
      partner_store_id: partnerStore.id,
      request: result?.request || null,
    };
  }

  return {
    success: true,
    status: "submitted_to_partner_store",
    message:
      "The ATC-selected partner store has been sent the request. The existing partner-store workflow now owns the store response and downstream shopper/delivery execution.",
    execution_type: "partner_store",
    side_effect: true,
    completion: false,
    partner_store_id: partnerStore.id,
    partner_store_name:
      partnerStore.business_name ||
      partnerStore.name ||
      null,
    request_id: result?.request?.id || null,
    distance_km:
      result?.distanceKm ??
      route?.distance_km ??
      route?.distanceKm ??
      null,
    workflow_id: task?.id || context?.workflow_id || null,
  };
}
