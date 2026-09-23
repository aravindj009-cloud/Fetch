/* FETCH WEB AGENT — PHYSICAL WEB BRIDGE
 *
 * Purpose:
 * - Provide the customer-facing web API for Fetch.
 * - Let the Universal Task Engine understand the request first.
 * - When the request is physical, hand it to the existing physical
 *   order engine instead of returning needs_clarification.
 * - Preserve the existing ATC -> partner store -> customer approval ->
 *   shopper flow.
 *
 * IMPORTANT:
 * - This file does NOT replace fetch-universal-execution.mjs.
 * - This file does NOT replace fetch-v9.mjs.
 * - This file does NOT contain fake product prices.
 * - The partner store supplies the real price/availability.
 */

import { executeUniversalFetchRequest } from "../../lib/fetch-universal-execution.mjs";

import {
  getOrCreateCustomer,
  createOrder,
  updateOrder,
  getOrderById,
  dispatchOrderToPartnerStore,
  offerOrderToShopper,
} from "../whatsapp/webhook.mjs";

const ALLOWED_ORIGINS = new Set([
  "https://tryfetch.in",
  "https://www.tryfetch.in",
]);

function cleanText(value) {
  return String(value ?? "").trim();
}

function normalizePhone(value) {
  return String(value || "").replace(/[^\d]/g, "");
}

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.has(origin)
    ? origin
    : "https://tryfetch.in";

  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function sendJson(res, status, payload, origin = "") {
  res.status(status);

  for (const [key, value] of Object.entries(corsHeaders(origin))) {
    res.setHeader(key, value);
  }

  return res.json(payload);
}

function isPhysicalResult(result) {
  const network =
    cleanText(
      result?.task?.execution_network ||
      result?.task?.intent?.domain ||
      result?.fetch?.decisions?.[0]?.decision?.network
    ).toLowerCase();

  const resourceType =
    cleanText(
      result?.atc?.resource_type ||
      result?.task?.resource?.type ||
      result?.execution?.resource_type
    ).toLowerCase();

  const fetchDomain =
    cleanText(
      result?.fetch?.decisions?.[0]?.intent?.domain
    ).toLowerCase();

  return (
    network === "physical_network" ||
    resourceType === "partner_store" ||
    fetchDomain === "physical"
  );
}

function extractPhysicalItems(result) {
  const decisions = Array.isArray(result?.fetch?.decisions)
    ? result.fetch.decisions
    : [];

  const items = [];

  for (const decision of decisions) {
    const decisionItems = Array.isArray(decision?.entities?.items)
      ? decision.entities.items
      : [];

    for (const item of decisionItems) {
      const name = cleanText(
        item?.name ||
        item?.item ||
        item?.product ||
        item?.title
      );

      const quantity = Number(item?.quantity || 1);

      if (!name) continue;

      const safeQuantity =
        Number.isFinite(quantity) && quantity > 0
          ? Math.floor(quantity)
          : 1;

      const existing = items.find(
        (entry) =>
          entry.name.toLowerCase() === name.toLowerCase()
      );

      if (existing) {
        existing.quantity += safeQuantity;
      } else {
        items.push({
          name,
          quantity: safeQuantity,
        });
      }
    }
  }

  return items;
}

function formatOrderItems(items) {
  return items
    .map(
      (item) =>
        `${item.quantity} ${item.name}`
    )
    .join(", ");
}

function validCoordinates(latitude, longitude) {
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

function syntheticWebPhone(conversationId) {
  const raw = cleanText(conversationId)
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(-12);

  /*
   * The customers.phone column is used as the customer identity by the
   * existing physical engine. A deterministic web-only identifier keeps
   * repeat requests on the same browser conversation tied to one customer.
   *
   * This is intentionally NOT presented as a real phone number.
   */
  return `web${raw || "customer"}`;
}

async function handlePhysicalWebRequest({
  result,
  text,
  conversationId,
  latitude,
  longitude,
}) {
  if (!validCoordinates(latitude, longitude)) {
    return {
      status: "needs_location",
      message:
        "Please allow location access so Fetch can find the right nearby store and calculate delivery.",
      workflow_id: result?.workflow_id || null,
      fetch: result?.fetch || null,
      atc: result?.atc || null,
      execution: result?.execution || null,
    };
  }

  const items = extractPhysicalItems(result);

  if (!items.length) {
    return {
      status: "needs_clarification",
      message:
        "I understood this as a shopping request, but I could not identify the item(s).",
      workflow_id: result?.workflow_id || null,
      fetch: result?.fetch || null,
      atc: result?.atc || null,
      execution: result?.execution || null,
    };
  }

  const phone = syntheticWebPhone(conversationId);

  const customer = await getOrCreateCustomer(phone);

  if (!customer?.id) {
    throw new Error("Could not create web customer");
  }

  const itemsText = formatOrderItems(items);

  /*
   * The web customer supplies coordinates directly. We keep a readable
   * delivery_address because the existing partner/store/shopper messages
   * display this field, while the coordinates are the authoritative
   * routing data for ATC.
   */
  const order = await createOrder({
    customerId: customer.id,
    storeName: "Any available local store",
    items: itemsText,
    budget: null,
    deliveryAddress: "Customer location (web)",
    status: "finding_partner",
  });

  if (!order?.id) {
    throw new Error("Could not create Fetch order");
  }

  const locatedOrder = await updateOrder(order.id, {
    customer_latitude: Number(latitude),
    customer_longitude: Number(longitude),
    customer_location_shared_at: new Date().toISOString(),
    customer_location_source: "web_browser",
    delivery_address: "Customer location (web)",
    status: "finding_partner",
  });

  /*
   * ATC is now the selector of the partner store.
   *
   * The selector uses:
   * - requested items
   * - partner-store catalog
   * - partner availability
   * - customer coordinates
   *
   * The selected store then receives the real order request and supplies
   * the real item price. No hard-coded product price is introduced here.
   */
  const dispatch = await dispatchOrderToPartnerStore({
    order: locatedOrder || order,
  });

  if (dispatch?.success) {
    const offeredOrder = await updateOrder(
      order.id,
      {
        status: "partner_offered",
        partner_store_id:
          dispatch?.partnerStore?.id ||
          dispatch?.match?.partnerStoreId ||
          null,
        partner_request_id:
          dispatch?.request?.id ||
          null,
      }
    );

    return {
      status: "partner_offered",
      message:
        "Your request has been sent to a matching nearby partner store. I’ll get the real price and availability before asking you to approve the order.",
      orderId: offeredOrder?.id || order.id,
      order: offeredOrder || order,
      workflow_id: result?.workflow_id || null,
      fetch: result?.fetch || null,
      atc: result?.atc || null,
      execution: {
        success: true,
        status: "partner_store_offer_sent",
        partner_store_id:
          dispatch?.partnerStore?.id ||
          dispatch?.match?.partnerStoreId ||
          null,
        partner_request_id:
          dispatch?.request?.id ||
          null,
      },
    };
  }

  /*
   * No catalog-qualified partner store:
   * use the existing human-shopper fallback rather than failing the
   * customer request or asking the customer to choose a store.
   */
  const fallbackOrder = await updateOrder(order.id, {
    status: "finding_shopper",
    partner_store_id: null,
    partner_request_id: null,
  });

  const shopperDispatch = await offerOrderToShopper(
    fallbackOrder || locatedOrder || order
  );

  if (shopperDispatch?.success) {
    return {
      status: "finding_shopper",
      message:
        "I couldn’t find a matching partner store, so I’ve sent the request to a Fetch shopper who can source the item for you.",
      orderId: order.id,
      order: fallbackOrder || locatedOrder || order,
      workflow_id: result?.workflow_id || null,
      fetch: result?.fetch || null,
      atc: result?.atc || null,
      execution: {
        success: true,
        status: "human_shopper_fallback",
        reason:
          dispatch?.reason ||
          "no_partner_store_available",
      },
    };
  }

  return {
    status: "finding_partner",
    message:
      "Your request is saved, but there is currently no available partner store or shopper. Fetch will keep the order in the fulfilment queue.",
    orderId: order.id,
    order: fallbackOrder || locatedOrder || order,
    workflow_id: result?.workflow_id || null,
    fetch: result?.fetch || null,
    atc: result?.atc || null,
    execution: {
      success: false,
      status: "queued_no_resource",
      reason:
        dispatch?.reason ||
        shopperDispatch?.reason ||
        "no_available_resource",
    },
  };
}

async function handleGet(req, res) {
  const origin = req.headers.origin || "";
  const orderId = cleanText(req.query?.orderId);

  if (!orderId) {
    return sendJson(
      res,
      400,
      {
        success: false,
        error: "orderId is required",
      },
      origin
    );
  }

  const order = await getOrderById(orderId);

  if (!order) {
    return sendJson(
      res,
      404,
      {
        success: false,
        error: "Order not found",
      },
      origin
    );
  }

  return sendJson(
    res,
    200,
    {
      success: true,
      orderId: order.id,
      status: order.status || "unknown",
      order,
    },
    origin
  );
}

async function handlePost(req, res) {
  const origin = req.headers.origin || "";
  const body =
    req.body && typeof req.body === "object"
      ? req.body
      : {};

  const text = cleanText(body.text);
  const conversationId =
    cleanText(body.conversationId) ||
    `web:${Date.now()}`;

  const latitude = body.latitude;
  const longitude = body.longitude;

  if (!text) {
    return sendJson(
      res,
      400,
      {
        success: false,
        error: "text is required",
      },
      origin
    );
  }

  /*
   * IMPORTANT:
   * Always let the Universal Task Engine understand the request first.
   * The web bridge only takes over once the result identifies a physical
   * request. This keeps the web channel aligned with Fetch's core brain.
   */
  const result = await executeUniversalFetchRequest({
    text,
    customerId: null,
    conversationId,
    channel: "web",
    activeTaskId: null,
    suppliedContext: {
      source: "fetch_web",
      web_location: validCoordinates(latitude, longitude)
        ? {
            latitude: Number(latitude),
            longitude: Number(longitude),
          }
        : null,
    },
  });

  console.log(
    "FETCH WEB UNIVERSAL RESULT:",
    JSON.stringify({
      status: result?.status || null,
      workflow_id: result?.workflow_id || null,
      task_status: result?.task?.status || null,
      network: result?.task?.execution_network || null,
      resource_type: result?.atc?.resource_type || null,
      decision_status:
        result?.fetch?.decisions?.[0]?.decision?.status ||
        null,
      domain:
        result?.fetch?.decisions?.[0]?.intent?.domain ||
        null,
    })
  );

  if (isPhysicalResult(result)) {
    const physical = await handlePhysicalWebRequest({
      result,
      text,
      conversationId,
      latitude,
      longitude,
    });

    return sendJson(
      res,
      200,
      {
        success: true,
        ...physical,
      },
      origin
    );
  }

  /*
   * Non-physical requests remain on the Universal Task Engine path.
   * Do not pretend that an unimplemented connector completed.
   */
  return sendJson(
    res,
    200,
    {
      success: true,
      status: result?.status || "awaiting_connector",
      workflow_id: result?.workflow_id || null,
      message:
        result?.execution?.message ||
        "Fetch understood the request, but this channel does not have an execution connector for it yet.",
      fetch: result?.fetch || null,
      atc: result?.atc || null,
      execution: result?.execution || null,
    },
    origin
  );
}

export default async function handler(req, res) {
  const origin = req.headers.origin || "";

  if (req.method === "OPTIONS") {
    return sendJson(
      res,
      204,
      {},
      origin
    );
  }

  try {
    if (req.method === "GET") {
      return await handleGet(req, res);
    }

    if (req.method === "POST") {
      return await handlePost(req, res);
    }

    return sendJson(
      res,
      405,
      {
        success: false,
        error: "Method not allowed",
      },
      origin
    );
  } catch (error) {
    console.error(
      "FETCH WEB AGENT ERROR:",
      error
    );

    return sendJson(
      res,
      500,
      {
        success: false,
        error:
          error?.message ||
          "Fetch web request failed",
      },
      origin
    );
  }
}
