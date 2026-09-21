/*
  FETCH PARTNER STORE V2
  Partner-store procurement channel for ATC.

  Flow:
  CUSTOMER -> ATC -> PARTNER STORE -> ACCEPT/REJECT

  Partner store replies:
    ACCEPT ₹PRICE
    REJECT

  This module:
  - identifies partner stores by WhatsApp number
  - keeps partner resources synced
  - creates partner-store requests
  - selects the nearest available partner resource
  - sends procurement requests
  - handles ACCEPT ₹PRICE / REJECT
  - returns structured results to the main webhook

  IMPORTANT:
  - Does not replace shopper matching.
  - Does not handle customer payment.
  - Does not create a product catalog.
*/

const SUPABASE_URL =
  process.env.VITE_SUPABASE_URL ||
  "https://skfxzagxlxputwpwxwbe.supabase.co";

const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID =
  process.env.WHATSAPP_PHONE_NUMBER_ID;

import {
  atcSelectPartnerStoreForOrder,
} from "./atc.mjs";

function normalizePhone(phone) {
  return phone
    ? String(phone).replace(/[^\d]/g, "")
    : "";
}

function formatRupees(amount) {
  const value = Number(amount || 0);
  return value.toFixed(2).replace(/\.00$/, "");
}

function shortReference(id) {
  return String(id || "")
    .replace(/-/g, "")
    .slice(0, 6)
    .toUpperCase();
}

async function request(path, options = {}) {
  if (!SUPABASE_KEY) {
    throw new Error("SUPABASE_SECRET_KEY is missing");
  }

  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/${path}`,
    {
      ...options,
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    }
  );

  const raw = await response.text();

  let data = null;

  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = raw;
    }
  }

  if (!response.ok) {
    throw new Error(
      `Partner Store Supabase ${response.status}: ${
        typeof data === "string"
          ? data
          : JSON.stringify(data)
      }`
    );
  }

  return data;
}

async function sendWhatsAppMessage(to, message) {
  if (
    !WHATSAPP_ACCESS_TOKEN ||
    !WHATSAPP_PHONE_NUMBER_ID
  ) {
    throw new Error(
      "WhatsApp environment variables are missing"
    );
  }

  const normalizedTo = normalizePhone(to);

  if (!normalizedTo) {
    throw new Error(
      "Partner store WhatsApp number is missing"
    );
  }

  const response = await fetch(
    `https://graph.facebook.com/v26.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization:
          `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: normalizedTo,
        type: "text",
        text: {
          preview_url: false,
          body: message,
        },
      }),
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `WhatsApp ${response.status}: ${JSON.stringify(data)}`
    );
  }

  return data;
}


async function sendPartnerStoreButtons(
  to,
  body
) {
  if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    throw new Error("WhatsApp environment variables are missing");
  }

  const normalizedTo = normalizePhone(to);

  if (!normalizedTo) {
    throw new Error("Partner store WhatsApp number is missing");
  }

  console.log(
    "FETCH PARTNER STORE WHATSAPP SEND:",
    JSON.stringify({
      to: normalizedTo,
      message_type: "interactive",
    })
  );

  const response = await fetch(
    `https://graph.facebook.com/v26.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization:
          `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: normalizedTo,
        type: "interactive",
        interactive: {
          type: "button",
          body: {
            text: body,
          },
          action: {
            buttons: [
              {
                type: "reply",
                reply: {
                  id: "fetch_partner_accept",
                  title: "Available",
                },
              },
              {
                type: "reply",
                reply: {
                  id: "fetch_partner_reject",
                  title: "Unavailable",
                },
              },
            ],
          },
        },
      }),
    }
  );

  const raw = await response.text();
  let data = null;

  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = raw;
  }

  console.log(
    "FETCH PARTNER STORE WHATSAPP RESPONSE:",
    JSON.stringify({
      to: normalizedTo,
      ok: response.ok,
      status: response.status,
      message_id: data?.messages?.[0]?.id || null,
      error: data?.error || null,
    })
  );

  if (!response.ok) {
    throw new Error(
      `WhatsApp interactive ${response.status}: ${JSON.stringify(data)}`
    );
  }

  return data;
}

async function sendPartnerStoreTextFallback(to, body) {
  return sendWhatsAppMessage(to, body);
}

export async function getPartnerStoreByPhone(phone) {
  const normalized = normalizePhone(phone);

  if (!normalized) return null;

  const rows = await request(
    `partner_stores?whatsapp_phone=eq.${encodeURIComponent(
      normalized
    )}&select=*&limit=1`
  );

  return Array.isArray(rows) && rows.length
    ? rows[0]
    : null;
}

export function isActivePartnerStore(store) {
  return Boolean(
    store &&
      String(store.status || "").toLowerCase() ===
        "approved" &&
      Boolean(store.whatsapp_opted_in)
  );
}

async function syncPartnerStoreResource(store) {
  if (!store?.id) return null;

  const active = isActivePartnerStore(store);

  const payload = {
    partner_store_id: store.id,
    status: active ? "available" : "offline",
    capabilities:
      Array.isArray(store.capabilities) &&
      store.capabilities.length
        ? store.capabilities
        : [
            "inventory_check",
            "price_quote",
            "order_fulfillment",
          ],
    location: {
      latitude: Number.isFinite(
        Number(store.latitude)
      )
        ? Number(store.latitude)
        : null,
      longitude: Number.isFinite(
        Number(store.longitude)
      )
        ? Number(store.longitude)
        : null,
    },
    metadata: {
      business_name:
        store.business_name || null,
      whatsapp_phone:
        store.whatsapp_phone || null,
      approval_status:
        store.status || null,
      whatsapp_opted_in:
        Boolean(store.whatsapp_opted_in),
    },
  };

  const rows = await request(
    "atc_partner_store_resources?on_conflict=partner_store_id",
    {
      method: "POST",
      headers: {
        Prefer:
          "resolution=merge-duplicates,return=representation",
      },
      body: JSON.stringify(payload),
    }
  );

  return Array.isArray(rows)
    ? rows[0] || null
    : rows;
}

/* =========================================================
   PARTNER RESPONSE PARSER
   ========================================================= */

function parsePartnerResponse(text) {
  const raw = String(text || "")
    .trim()
    .replace(/,/g, "")
    .replace(/\s+/g, " ");

  if (!raw) {
    return {
      action: "unknown",
      price: null,
    };
  }

  /*
    ACCEPT ₹120
    ACCEPT 120
    ACCEPT Rs 120
    ACCEPT INR 120
  */
  if (/^ACCEPT$/i.test(raw)) {
    return {
      action: "accepted_pending_price",
      price: null,
    };
  }

  const acceptMatch = raw.match(
    /^ACCEPT\s*(?:₹|RS\.?|INR)?\s*(\d+(?:\.\d{1,2})?)\s*$/i
  );

  if (acceptMatch) {
    const price = Number(acceptMatch[1]);

    if (
      Number.isFinite(price) &&
      price > 0
    ) {
      return {
        action: "accepted",
        price,
      };
    }
  }

  if (/^REJECT$/i.test(raw)) {
    return {
      action: "rejected",
      price: null,
    };
  }

  return {
    action: "unknown",
    price: null,
  };
}

/* =========================================================
   CREATE PARTNER REQUEST
   ========================================================= */

export async function createPartnerStoreRequest({
  order,
  partnerStore,
  distanceKm = null,
  resourceId = null,
}) {
  if (!order?.id) {
    throw new Error("Order is required");
  }

  if (!partnerStore?.id) {
    throw new Error("Partner store is required");
  }

  const existing = await request(
    `partner_store_requests?order_id=eq.${encodeURIComponent(
      order.id
    )}&partner_store_id=eq.${encodeURIComponent(
      partnerStore.id
    )}&status=in.(offered,accepted)&select=*&limit=1`
  );

  if (
    Array.isArray(existing) &&
    existing.length
  ) {
    return existing[0];
  }

  const requestData = await request(
    "partner_store_requests",
    {
      method: "POST",
      headers: {
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        partner_store_id: partnerStore.id,
        order_id: order.id,
        customer_id: order.customer_id,
        items: order.items || null,
        status: "offered",
        metadata: {
          source:
            "atc_partner_store_dispatch",
          distance_km: distanceKm,
          resource_id: resourceId,
          matched_at:
            new Date().toISOString(),
        },
      }),
    }
  );

  const created =
    Array.isArray(requestData)
      ? requestData[0]
      : requestData;

  if (!created?.id) {
    throw new Error(
      "Partner store request creation failed"
    );
  }

  return created;
}

/* =========================================================
   OFFER ORDER TO PARTNER STORE
   ========================================================= */

export async function offerOrderToPartnerStore({
  order,
  partnerStore,
  distanceKm = null,
  resourceId = null,
}) {
  if (!order?.id) {
    return {
      success: false,
      reason: "missing_order",
      request: null,
      partnerStore: null,
    };
  }

  if (!partnerStore?.id) {
    return {
      success: false,
      reason: "missing_partner_store",
      request: null,
      partnerStore: null,
    };
  }

  if (!isActivePartnerStore(partnerStore)) {
    return {
      success: false,
      reason: "partner_store_inactive",
      request: null,
      partnerStore,
    };
  }

  const requestRow =
    await createPartnerStoreRequest({
      order,
      partnerStore,
      distanceKm,
      resourceId,
    });

  const message =
    `🛒 *New Fetch Order Request*\n\n` +
    `🔖 Ref: *${shortReference(
      requestRow.id
    )}*\n\n` +
    `📦 Items: ${
      order.items || "Requested items"
    }\n\n` +
    `📍 Deliver to: ${
      order.delivery_address ||
      "Customer location"
    }\n\n` +
    `Please check whether you have the requested item(s).\n\n` +
    `If available, reply:\n` +
    `*ACCEPT ₹PRICE*\n\n` +
    `If unavailable, reply:\n` +
    `*REJECT*\n\n` +
    `Example: *ACCEPT ₹120*`;

  try {
    try {
      const sendResult =
        await sendPartnerStoreButtons(
          partnerStore.whatsapp_phone,
          message
        );

      console.log(
        "FETCH PARTNER STORE OFFER SENT:",
        JSON.stringify({
          partnerStoreId: partnerStore.id,
          whatsappTo: normalizePhone(partnerStore.whatsapp_phone),
          requestId: requestRow.id,
          whatsappMessageId:
            sendResult?.messages?.[0]?.id || null,
        })
      );
    } catch (interactiveError) {
      console.warn(
        "FETCH PARTNER STORE INTERACTIVE SEND FAILED, TRYING TEXT:",
        interactiveError
      );

      const fallbackResult =
        await sendPartnerStoreTextFallback(
          partnerStore.whatsapp_phone,
          message
        );

      console.log(
        "FETCH PARTNER STORE TEXT FALLBACK SENT:",
        JSON.stringify({
          partnerStoreId: partnerStore.id,
          whatsappTo: normalizePhone(partnerStore.whatsapp_phone),
          requestId: requestRow.id,
          whatsappMessageId:
            fallbackResult?.messages?.[0]?.id || null,
        })
      );
    }
  } catch (error) {
    console.error(
      "FETCH PARTNER STORE WHATSAPP ERROR:",
      error
    );

    await request(
      `partner_store_requests?id=eq.${encodeURIComponent(
        requestRow.id
      )}`,
      {
        method: "PATCH",
        headers: {
          Prefer: "return=representation",
        },
        body: JSON.stringify({
          status: "rejected",
          response_message:
            "WhatsApp delivery failed",
          metadata: {
            ...(requestRow.metadata || {}),
            dispatch_error: String(
              error?.message || error
            ),
          },
        }),
      }
    );

    return {
      success: false,
      reason: "partner_whatsapp_failed",
      request: null,
      partnerStore,
    };
  }

  return {
    success: true,
    reason: "offered_to_partner_store",
    request: requestRow,
    partnerStore,
    distanceKm,
  };
}

/* =========================================================
   PARTNER RESPONSE HANDLER
   ========================================================= */

export async function handlePartnerStoreMessage({
  phone,
  text,
}) {
  const normalizedPhone = normalizePhone(phone);

  if (!normalizedPhone) {
    return {
      handled: false,
      reason: "missing_phone",
    };
  }

  const partnerStore =
    await getPartnerStoreByPhone(
      normalizedPhone
    );

  if (!partnerStore) {
    return {
      handled: false,
      reason: "not_partner_store",
    };
  }

  /*
    Keep the ATC resource in sync whenever the
    partner store communicates with Fetch.
  */
  try {
    await syncPartnerStoreResource(
      partnerStore
    );
  } catch (error) {
    console.error(
      "FETCH PARTNER RESOURCE SYNC ERROR:",
      error
    );
  }

  const parsed =
    parsePartnerResponse(text);

  if (parsed.action === "unknown") {
    await sendWhatsAppMessage(
      normalizedPhone,
      "Please reply using one of these formats:\n\n" +
        "ACCEPT ₹120\n" +
        "or\n" +
        "REJECT"
    );

    return {
      handled: true,
      action: "unknown",
      partnerStore,
    };
  }

  /*
    Only an OFFERED request can be answered.

    We order by created_at descending so the latest
    outstanding request is selected.
  */
  const requests = await request(
    `partner_store_requests?partner_store_id=eq.${encodeURIComponent(
      partnerStore.id
    )}&status=eq.offered&select=*&order=created_at.desc&limit=1`
  );

  const partnerRequest =
    Array.isArray(requests) &&
    requests.length
      ? requests[0]
      : null;

  if (!partnerRequest) {
    await sendWhatsAppMessage(
      normalizedPhone,
      "There is no active Fetch order request waiting for your response."
    );

    return {
      handled: true,
      action: "no_active_request",
      partnerStore,
      request: null,
    };
  }

  if (parsed.action === "accepted_pending_price") {
    await sendWhatsAppMessage(
      normalizedPhone,
      "Available selected ✅\n\nPlease send the exact total price of the requested item(s), for example: ₹120."
    );

    return {
      handled: true,
      action: "accepted_pending_price",
      partnerStore,
      request: partnerRequest,
      orderId: partnerRequest.order_id,
    };
  }


  /*
    EXACT PRICE FOLLOW-UP
    This is the only free-form numeric input still required in the
    current pilot because the partner price is not stored in a catalog.
  */
  const numericPrice = Number(
    String(text || "")
      .trim()
      .replace(/,/g, "")
      .replace(/^₹|^RS\.?|^INR/i, "")
      .trim()
  );

  if (
    Number.isFinite(numericPrice) &&
    numericPrice > 0
  ) {
    const numericRows = await request(
      `partner_store_requests?partner_store_id=eq.${encodeURIComponent(
        partnerStore.id
      )}&status=eq.offered&select=*&order=created_at.desc&limit=1`
    );

    const numericRequest =
      Array.isArray(numericRows) &&
      numericRows.length
        ? numericRows[0]
        : null;

    if (numericRequest) {
      const updatedRows = await request(
        `partner_store_requests?id=eq.${encodeURIComponent(
          numericRequest.id
        )}&status=eq.offered`,
        {
          method: "PATCH",
          headers: {
            Prefer: "return=representation",
          },
          body: JSON.stringify({
            status: "accepted",
            quoted_item_total: numericPrice,
            response_message:
              `ACCEPT ₹${formatRupees(numericPrice)}`,
            responded_at:
              new Date().toISOString(),
            metadata: {
              ...(numericRequest.metadata || {}),
              response_action:
                "partner_store_accept",
              quoted_item_total: numericPrice,
              responded_via: "whatsapp",
            },
          }),
        }
      );

      const updatedRequest =
        Array.isArray(updatedRows) &&
        updatedRows.length
          ? updatedRows[0]
          : null;

      if (updatedRequest) {
        await sendWhatsAppMessage(
          normalizedPhone,
          `Accepted ✅\\n\\nOrder: *${shortReference(
            numericRequest.id
          )}*\\nQuoted product price: *₹${formatRupees(
            numericPrice
          )}*`
        );

        return {
          handled: true,
          action: "accepted",
          partnerStore,
          request: updatedRequest,
          orderId: numericRequest.order_id,
          quotedItemTotal: numericPrice,
        };
      }
    }
  }

  /*
    ACCEPT:
    Save the store's quoted item price.
  */
  if (parsed.action === "accepted") {
    const updatedRows = await request(
      `partner_store_requests?id=eq.${encodeURIComponent(
        partnerRequest.id
      )}&status=eq.offered`,
      {
        method: "PATCH",
        headers: {
          Prefer: "return=representation",
        },
        body: JSON.stringify({
          status: "accepted",
          quoted_item_total:
            parsed.price,
          response_message:
            `ACCEPT ₹${formatRupees(
              parsed.price
            )}`,
          responded_at:
            new Date().toISOString(),
          metadata: {
            ...(partnerRequest.metadata || {}),
            response_action:
              "partner_store_accept",
            quoted_item_total:
              parsed.price,
            responded_via:
              "whatsapp",
          },
        }),
      }
    );

    const updatedRequest =
      Array.isArray(updatedRows) &&
      updatedRows.length
        ? updatedRows[0]
        : null;

    /*
      If no row was updated, another process may
      already have consumed the offer.
    */
    if (!updatedRequest) {
      await sendWhatsAppMessage(
        normalizedPhone,
        "This Fetch order request is no longer available."
      );

      return {
        handled: true,
        action: "already_processed",
        partnerStore,
        request: partnerRequest,
      };
    }

    await sendWhatsAppMessage(
      normalizedPhone,
      `Accepted ✅\n\n` +
        `Order: *${shortReference(
          partnerRequest.id
        )}*\n` +
        `Quoted product price: *₹${formatRupees(
          parsed.price
        )}*\n\n` +
        `Fetch will now process the customer approval/payment step.`
    );

    return {
      handled: true,
      action: "accepted",
      partnerStore,
      request: updatedRequest,
      orderId: partnerRequest.order_id,
      quotedItemTotal: parsed.price,
    };
  }

  /*
    REJECT:
    Mark this offer rejected and return the
    partner store ID to the main ATC layer.
  */
  if (parsed.action === "rejected") {
    const updatedRows = await request(
      `partner_store_requests?id=eq.${encodeURIComponent(
        partnerRequest.id
      )}&status=eq.offered`,
      {
        method: "PATCH",
        headers: {
          Prefer: "return=representation",
        },
        body: JSON.stringify({
          status: "rejected",
          response_message: "REJECT",
          responded_at:
            new Date().toISOString(),
          metadata: {
            ...(partnerRequest.metadata || {}),
            response_action:
              "partner_store_reject",
            responded_via:
              "whatsapp",
          },
        }),
      }
    );

    const updatedRequest =
      Array.isArray(updatedRows) &&
      updatedRows.length
        ? updatedRows[0]
        : null;

    if (!updatedRequest) {
      await sendWhatsAppMessage(
        normalizedPhone,
        "This Fetch order request is no longer available."
      );

      return {
        handled: true,
        action: "already_processed",
        partnerStore,
        request: partnerRequest,
      };
    }

    await sendWhatsAppMessage(
      normalizedPhone,
      `Rejected 👍\n\n` +
        `Order: *${shortReference(
          partnerRequest.id
        )}*\n\n` +
        `Fetch will look for the next available fulfillment resource.`
    );

    return {
      handled: true,
      action: "rejected",
      partnerStore,
      request: updatedRequest,
      orderId: partnerRequest.order_id,
      rejectedPartnerStoreId:
        partnerStore.id,
    };
  }

  return {
    handled: true,
    action: "unknown",
    partnerStore,
    request: partnerRequest,
  };
}

/* =========================================================
   SAFE WRAPPER
   ========================================================= */

export async function partnerStoreSafe(
  fn,
  label = "partner_store"
) {
  try {
    return await fn();
  } catch (error) {
    console.error(
      `FETCH ${label.toUpperCase()} ERROR:`,
      error
    );

    return {
      handled: false,
      success: false,
      error: String(
        error?.message || error
      ),
      reason: "partner_store_error",
    };
  }
}

/*
  Optional named export for backwards compatibility
  with code that may still reference the old helper.
*/
export const parseYesPrice = parsePartnerResponse;


/* =========================================================
   PARTNER RESOURCE SELECTION + DISPATCH
========================================================= */

function partnerValidCoordinates(latitude, longitude) {
  const lat = Number(latitude);
  const lon = Number(longitude);

  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180 &&
    !(lat === 0 && lon === 0)
  );
}

function partnerHaversineKm(lat1, lon1, lat2, lon2) {
  const a1 = Number(lat1);
  const o1 = Number(lon1);
  const a2 = Number(lat2);
  const o2 = Number(lon2);

  if (![a1, o1, a2, o2].every(Number.isFinite)) {
    return null;
  }

  const toRad = (value) => (value * Math.PI) / 180;
  const dLat = toRad(a2 - a1);
  const dLon = toRad(o2 - o1);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a1)) *
      Math.cos(toRad(a2)) *
      Math.sin(dLon / 2) ** 2;

  return 6371 * 2 * Math.atan2(
    Math.sqrt(h),
    Math.sqrt(1 - h)
  );
}

async function getPartnerStoreById(id) {
  if (!id) return null;

  const rows = await request(
    `partner_stores?id=eq.${encodeURIComponent(String(id))}&select=*&limit=1`
  );

  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

export async function selectNearestPartnerStore({
  order,
  excludedPartnerStoreIds = [],
}) {
  if (!order?.id) return null;

  const resources = await request(
    "atc_partner_store_resources?status=eq.available&select=*&limit=100"
  );

  if (!Array.isArray(resources) || !resources.length) {
    return null;
  }

  const excluded = new Set(
    (Array.isArray(excludedPartnerStoreIds)
      ? excludedPartnerStoreIds
      : []
    ).map(String)
  );

  const customerLat = Number(order.customer_latitude);
  const customerLon = Number(order.customer_longitude);

  if (!partnerValidCoordinates(customerLat, customerLon)) {
    return null;
  }

  const requiredCapabilities = [
    "inventory_check",
    "price_quote",
    "order_fulfillment",
  ];

  const candidates = resources
    .filter((resource) => {
      const partnerStoreId = String(resource.partner_store_id || "");

      if (!partnerStoreId || excluded.has(partnerStoreId)) {
        return false;
      }

      if (
        String(resource.status || "").toLowerCase() !==
        "available"
      ) {
        return false;
      }

      const capabilities = Array.isArray(resource.capabilities)
        ? resource.capabilities.map((value) =>
            String(value).toLowerCase()
          )
        : [];

      if (
        !requiredCapabilities.every((capability) =>
          capabilities.includes(capability)
        )
      ) {
        return false;
      }

      const location = resource.location || {};

      return partnerValidCoordinates(
        location.latitude,
        location.longitude
      );
    })
    .map((resource) => {
      const location = resource.location || {};

      return {
        resource,
        partnerStoreId: String(resource.partner_store_id),
        distanceKm: partnerHaversineKm(
          customerLat,
          customerLon,
          Number(location.latitude),
          Number(location.longitude)
        ),
      };
    })
    .filter((candidate) =>
      Number.isFinite(candidate.distanceKm)
    )
    .sort(
      (a, b) => a.distanceKm - b.distanceKm
    );

  return candidates[0] || null;
}

export async function dispatchOrderToPartnerStore({
  order,
  excludedPartnerStoreIds = [],
}) {
  if (!order?.id) {
    return {
      success: false,
      reason: "missing_order",
    };
  }

  const match = await atcSelectPartnerStoreForOrder({
    order,
    excludedPartnerStoreIds,
  });

  if (!match) {
    return {
      success: false,
      reason: "no_partner_store_available",
    };
  }

  const partnerStore = await getPartnerStoreById(
    match.partnerStoreId
  );

  if (!partnerStore) {
    return {
      success: false,
      reason: "partner_store_not_found",
    };
  }

  console.log(
    "FETCH ATC PARTNER STORE SELECTED:",
    JSON.stringify({
      orderId: order.id,
      partnerStoreId: partnerStore.id,
      businessName: partnerStore.business_name || null,
      whatsappTo: normalizePhone(partnerStore.whatsapp_phone),
      distanceKm: match.distanceKm ?? null,
      resourceId: match.resourceId || match.resource?.id || null,
      reason: match.reason || null,
    })
  );

  return offerOrderToPartnerStore({
    order,
    partnerStore,
    distanceKm: match.distanceKm,
    resourceId: match.resourceId || match.resource?.id || null,
  });
}
