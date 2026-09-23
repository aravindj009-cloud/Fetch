import {
  executeUniversalFetchRequest,
} from "../../lib/fetch-universal-execution.mjs";

import {
  getOrCreateCustomer,
  createOrder,
  updateOrder,
  getOrderById,
  dispatchOrderToPartnerStore,
  offerOrderToShopper,
} from "../whatsapp/webhook.mjs";

const ALLOWED_ORIGINS = [
  "https://tryfetch.in",
  "https://www.tryfetch.in",
];

function corsHeaders(origin) {
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin)
    ? origin
    : ALLOWED_ORIGINS[0];

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  };
}

function sendJson(res, status, data, origin) {
  return res
    .status(status)
    .setHeader("Access-Control-Allow-Origin",
      ALLOWED_ORIGINS.includes(origin)
        ? origin
        : ALLOWED_ORIGINS[0]
    )
    .setHeader(
      "Access-Control-Allow-Methods",
      "GET,POST,OPTIONS"
    )
    .setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type"
    )
    .setHeader("Cache-Control", "no-store")
    .json(data);
}

function normalizeWebPhone(conversationId) {
  const input = String(conversationId || "anonymous");

  let hash = 0;

  for (let i = 0; i < input.length; i++) {
    hash =
      (hash * 31 + input.charCodeAt(i)) >>> 0;
  }

  /*
    Synthetic Indian-style number used only as an internal
    customer identifier for web sessions.

    It is NOT used to send WhatsApp messages.
  */
  return `700${String(hash).slice(-7).padStart(7, "0")}`;
}

function extractItems(result) {
  const items =
    result?.fetch?.decisions?.[0]?.entities?.items;

  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((item) => ({
      quantity:
        Number(item?.quantity) > 0
          ? Number(item.quantity)
          : 1,

      item:
        String(item?.item || "").trim(),
    }))
    .filter((item) => item.item);
}

function itemsToText(items) {
  return items
    .map((item) =>
      `${item.quantity} ${item.item}`
    )
    .join(", ");
}

function buildStatusMessage(order) {
  if (!order) {
    return "I couldn't find that Fetch order.";
  }

  switch (order.status) {
    case "finding_partner":
      return (
        "I'm checking the most suitable nearby " +
        "Fetch partner store."
      );

    case "partner_offered":
      return (
        "I've routed your request to the selected " +
        "nearby partner store. I'm waiting for them " +
        "to confirm availability and price."
      );

    case "awaiting_customer_price_confirmation":
      return (
        `The partner store confirmed the items at ` +
        `₹${Number(order.item_total || 0).toFixed(0)}. ` +
        `Delivery is ₹${Number(order.delivery_fee || 0).toFixed(0)}. ` +
        `Your total is ₹${Number(order.total_amount || 0).toFixed(0)}. ` +
        `Please approve it to continue.`
      );

    case "finding_shopper":
      return (
        "The partner-store route wasn't available. " +
        "I'm finding a Fetch shopper now."
      );

    case "shopper_assigned":
      return (
        "A Fetch shopper has accepted your order."
      );

    case "shopping":
      return (
        "Your Fetch shopper is shopping for the order now."
      );

    case "picked_up":
      return (
        "Your order has been picked up and is being prepared for delivery."
      );

    case "out_for_delivery":
      return (
        "Your order is on the way."
      );

    case "payment_pending":
      return (
        "Your order is waiting for payment."
      );

    case "delivered":
      return (
        "Your order has been delivered 🎉"
      );

    case "cancelled":
      return (
        "Your order has been cancelled."
      );

    default:
      return (
        "Your Fetch order is being coordinated."
      );
  }
}

function isTerminalStatus(status) {
  return [
    "delivered",
    "cancelled",
  ].includes(String(status || ""));
}

export default async function handler(req, res) {
  const origin =
    req.headers.origin || "";

  if (req.method === "OPTIONS") {
    return res
      .status(204)
      .setHeader(
        "Access-Control-Allow-Origin",
        ALLOWED_ORIGINS.includes(origin)
          ? origin
          : ALLOWED_ORIGINS[0]
      )
      .setHeader(
        "Access-Control-Allow-Methods",
        "GET,POST,OPTIONS"
      )
      .setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type"
      )
      .end();
  }

  try {
    /*
      =========================================================
      GET
      Website polls this endpoint for the live order state.
      =========================================================
    */

    if (req.method === "GET") {
      const url = new URL(
        req.url,
        `https://${req.headers.host || "localhost"}`
      );

      const orderId =
        url.searchParams.get("orderId");

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

      const order =
        await getOrderById(orderId);

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
          order_id: order.id,
          status: order.status,
          order,
          message:
            buildStatusMessage(order),
          terminal:
            isTerminalStatus(order.status),
        },
        origin
      );
    }

    /*
      =========================================================
      POST
      Website sends a new Fetch request here.
      =========================================================
    */

    if (req.method !== "POST") {
      return sendJson(
        res,
        405,
        {
          success: false,
          error: "Method Not Allowed",
        },
        origin
      );
    }

    let body = req.body;

    if (typeof body === "string") {
      body = JSON.parse(body);
    }

    const text =
      String(body?.text || "").trim();

    const conversationId =
      String(
        body?.conversationId ||
        `web:${Date.now()}`
      );

    const latitude =
      Number(body?.latitude);

    const longitude =
      Number(body?.longitude);

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
      =========================================================
      UNIVERSAL FETCH
      Use the SAME universal execution layer as Fetch.
      =========================================================
    */

    const universalResult =
      await executeUniversalFetchRequest({
        text,
        conversationId,
        channel: "web",
      });

    /*
      Non-physical request:
      return the existing universal Fetch result.
    */

    const resourceType =
      String(
        universalResult?.atc?.resource_type || ""
      ).toLowerCase();

    const isPhysical =
      resourceType === "partner_store" ||
      resourceType === "physical_network" ||
      universalResult?.fetch?.decisions?.[0]?.intent?.domain ===
        "physical_commerce";

    if (!isPhysical) {
      return sendJson(
        res,
        200,
        {
          success: true,
          ...universalResult,
        },
        origin
      );
    }

    /*
      =========================================================
      PHYSICAL FETCH ORDER
      =========================================================
    */

    const items =
      extractItems(universalResult);

    if (!items.length) {
      return sendJson(
        res,
        200,
        {
          success: true,
          status: "needs_clarification",
          message:
            "Tell me what you'd like me to fetch.",
          fetch: universalResult.fetch,
          atc: universalResult.atc,
        },
        origin
      );
    }

    /*
      Location is mandatory for ATC partner-store selection.
    */

    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude)
    ) {
      return sendJson(
        res,
        200,
        {
          success: true,
          status: "needs_location",
          message:
            "I need your location so Fetch can find the nearest suitable partner store.",
          fetch: universalResult.fetch,
          atc: universalResult.atc,
        },
        origin
      );
    }

    /*
      Use the existing Fetch customer system.
    */

    const webPhone =
      normalizeWebPhone(conversationId);

    const customer =
      await getOrCreateCustomer(webPhone);

    if (!customer?.id) {
      throw new Error(
        "Could not create Fetch web customer"
      );
    }

    /*
      Use the EXISTING Fetch createOrder function.
      We are not creating a second order engine.
    */

    const order =
      await createOrder({
        customerId: customer.id,

        storeName:
          "Any available local store",

        items:
          itemsToText(items),

        budget:
          null,

        deliveryAddress:
          "Customer browser location",

        status:
          "finding_partner",
      });

    if (!order?.id) {
      throw new Error(
        "Could not create Fetch order"
      );
    }

    /*
      Store the browser location in the SAME order
      used by the WhatsApp Fetch engine.
    */

    const locatedOrder =
      await updateOrder(
        order.id,
        {
          customer_latitude:
            latitude,

          customer_longitude:
            longitude,

          customer_location_source:
            "web_browser",

          customer_location_shared_at:
            new Date().toISOString(),

          delivery_address:
            "Customer browser location",

          status:
            "finding_partner",

          delivery_pricing_status:
            "pending",

          delivery_fee:
            0,

          item_total:
            0,

          total_amount:
            0,
        }
      );

    /*
      =========================================================
      EXISTING FETCH ATC
      =========================================================
    */

    let partnerDispatch = null;

    try {
      partnerDispatch =
        await dispatchOrderToPartnerStore({
          order:
            locatedOrder || order,
        });
    } catch (error) {
      console.error(
        "FETCH WEB ATC PARTNER DISPATCH ERROR:",
        error
      );
    }

    /*
      Partner store found.
    */

    if (partnerDispatch?.success) {
      const partnerOffered =
        await updateOrder(
          order.id,
          {
            status:
              "partner_offered",

            partner_store_id:
              partnerDispatch
                ?.partnerStore
                ?.id || null,

            partner_request_id:
              partnerDispatch
                ?.request
                ?.id || null,

            store_name:
              partnerDispatch
                ?.partnerStore
                ?.business_name ||
              order.store_name ||
              null,
          }
        );

      return sendJson(
        res,
        200,
        {
          success: true,

          status:
            "partner_offered",

          message:
            "Got it 👍 I’ve routed your request through Fetch ATC to the selected nearby partner store. I’m waiting for the store to confirm the actual items and price. I’ll calculate delivery only after that.",

          order_id:
            partnerOffered?.id ||
            order.id,

          workflow_id:
            universalResult.workflow_id,

          fetch:
            universalResult.fetch,

          atc:
            {
              ...universalResult.atc,

              resource_type:
                "partner_store",

              partner_store_id:
                partnerDispatch
                  ?.partnerStore
                  ?.id || null,

              partner_store_name:
                partnerDispatch
                  ?.partnerStore
                  ?.business_name ||
                null,

              distance_km:
                partnerDispatch
                  ?.distanceKm ??
                null,
            },
        },
        origin
      );
    }

    /*
      =========================================================
      EXISTING FETCH SHOPPER FALLBACK
      =========================================================
    */

    const fallbackOrder =
      await updateOrder(
        order.id,
        {
          status:
            "finding_shopper",
        }
      );

    let shopperResult = null;

    try {
      shopperResult =
        await offerOrderToShopper(
          fallbackOrder || order
        );
    } catch (error) {
      console.error(
        "FETCH WEB SHOPPER FALLBACK ERROR:",
        error
      );
    }

    return sendJson(
      res,
      200,
      {
        success: true,

        status:
          "finding_shopper",

        message:
          shopperResult?.offeredCount
            ? "I couldn't route this request through a partner store, so Fetch is finding a shopper for you now."
            : "I couldn't find a partner store yet. Fetch is continuing through the shopper network.",

        order_id:
          order.id,

        workflow_id:
          universalResult.workflow_id,

        fetch:
          universalResult.fetch,

        atc:
          {
            ...universalResult.atc,

            resource_type:
              "shopper",
          },
      },
      origin
    );
  } catch (error) {
    console.error(
      "FETCH WEB API ERROR:",
      error
    );

    return sendJson(
      res,
      500,
      {
        success: false,
        error:
          error?.message ||
          "Fetch web API failed",
      },
      origin
    );
  }
}
