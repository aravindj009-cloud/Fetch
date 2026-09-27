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
import { executeDigitalAgent } from "../../lib/fetch-digital-agent.mjs";
import { executeClaudeResearchFallback } from "../../lib/fetch-claude-research-fallback.mjs";

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

function isLikelyPhysicalText(value) {
  const text = cleanText(value).toLowerCase();
  if (!text) return false;

  const acquisitionVerb = /\b(buy|purchase|order|get|bring|send|deliver|delivery|shop|pick up|pickup|arrange|source|need)\b/i.test(text);
  const physicalObject = /\b(item|product|goods?|grocery|groceries|medicine|medicines|food|drink|drinks|snack|snacks|pack|packs|box|boxes|bottle|bottles|piece|pieces|unit|units|supplies|stuff)\b/i.test(text);
  const deliveryCue = /\b(deliver|delivery|delivered|my address|our address|near me|nearby|at home|to my home)\b/i.test(text);
  const quantityObjectCue = /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+[a-z][a-z0-9-]*(?:\s+[a-z][a-z0-9-]*)?\b/i.test(text);

  return Boolean(
    acquisitionVerb &&
    (physicalObject || deliveryCue || quantityObjectCue)
  );
}

function isPhysicalResult(result, requestText = "") {
  const network =
    cleanText(
      result?.task?.execution_network ||
      result?.task?.intent?.execution_network ||
      result?.fetch?.decisions?.[0]?.decision?.network ||
      result?.atc?.execution_network ||
      result?.execution?.network
    ).toLowerCase();

  const resourceType =
    cleanText(
      result?.atc?.resource_type ||
      result?.task?.resource?.type ||
      result?.execution?.resource_type
    ).toLowerCase();

  const fetchDomain =
    cleanText(
      result?.fetch?.decisions?.[0]?.intent?.domain ||
      result?.task?.domain ||
      result?.task?.intent?.domain
    ).toLowerCase();

  const sourceClass = cleanText(
    result?.task?.metadata?.source_class ||
    result?.task?.metadata?.source_policy?.source_class
  ).toLowerCase();

  return (
    network === "physical_network" ||
    resourceType === "partner_store" ||
    fetchDomain === "physical" ||
    fetchDomain === "physical_commerce" ||
    sourceClass === "physical_fulfilment" ||
    isLikelyPhysicalText(requestText)
  );
}

function extractPhysicalItems(result) {
  /*
   * Physical entities can be preserved at several layers of the
   * Universal Task response. V9 normally exposes them under
   * fetch.decisions[].entities.items, while the Universal Task Contract
   * also preserves them under task.entities and task.task_data.entities.
   *
   * We check these structured locations first so the physical web bridge
   * does not depend on one exact response shape.
   */
  const candidateLists = [
    result?.fetch?.decisions?.[0]?.entities?.items,
    result?.task?.entities?.items,
    result?.task?.task_data?.entities?.items,
    result?.tasks?.[0]?.entities?.items,
    result?.tasks?.[0]?.task_data?.entities?.items,
    result?.fetch?.context?.conversation_context?.last_entities?.items,
    result?.fetch?.context?.last_entities?.items,
    result?.fetch?.decisions?.[0]?.plan?.entities?.items,
    result?.fetch?.decisions?.[0]?.decision?.entities?.items,
  ];

  const items = [];

  function addItem(rawItem) {
    const name = cleanText(
      rawItem?.name ||
      rawItem?.item ||
      rawItem?.product ||
      rawItem?.title
    );

    const quantity = Number(
      rawItem?.quantity ??
      rawItem?.qty ??
      rawItem?.count ??
      1
    );

    if (!name) return;

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

  /*
   * Use the first structured source that contains items.
   * The same entities are often copied into multiple layers, so reading
   * all layers would incorrectly double quantities.
   */
  for (const list of candidateLists) {
    if (!Array.isArray(list) || !list.length) continue;

    for (const rawItem of list) {
      addItem(rawItem);
    }

    if (items.length) break;
  }

  /*
   * Last-resort parser for simple physical requests when structured
   * entities are unexpectedly absent. This is intentionally generic.
   * It never contains a hard-coded product catalogue.
   *
   * Examples it can recover:
   *   "get me two KitKats"
   *   "I need 3 bottles of water"
   *   "deliver 2 ice packs to my address"
   *
   * V9 structured entities remain the preferred source.
   */
  if (!items.length) {
    const rawText = cleanText(
      result?.task?.user_request ||
      result?.task?.source_text ||
      result?.fetch?.received_text
    );

    const genericPatterns = [
      /\b(?:get|buy|purchase|order|bring|send|deliver|find|source|need)\s+(?:me\s+|us\s+)?(\d+)\s+(.+?)(?:\s+(?:delivered|to\s+(?:my|our)\s+address|for\s+(?:me|us)))?$/i,
      /\b(?:get|buy|purchase|order|bring|send|deliver|find|source|need)\s+(?:me\s+|us\s+)?(.+?)(?:\s+(?:delivered|to\s+(?:my|our)\s+address|for\s+(?:me|us)))?$/i,
    ];

    for (const pattern of genericPatterns) {
      const match = rawText.match(pattern);
      if (!match) continue;

      const quantity = /^\d+$/.test(match[1] || '')
        ? Number(match[1])
        : 1;
      const rawName = /^\d+$/.test(match[1] || '')
        ? match[2]
        : match[1];

      const name = cleanText(rawName)
        .replace(/\b(?:delivered|delivery|to\s+(?:my|our)\s+address|for\s+(?:me|us))\b.*$/i, '')
        .replace(/\s+/g, ' ')
        .trim();

      if (name && name.length <= 120) {
        addItem({
          name,
          quantity: Number.isFinite(quantity) && quantity > 0
            ? Math.floor(quantity)
            : 1,
        });
        break;
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

function buildWebOrderMessage(order) {
  const status = cleanText(order?.status).toLowerCase();

  if (status === "finding_partner") {
    return "I’m finding a matching nearby partner store for your request.";
  }

  if (status === "partner_offered") {
    return "Your request has been sent to the matching nearby partner store. I’m waiting for its real availability and price.";
  }

  if (status === "awaiting_customer_price_confirmation") {
    const itemTotal = Number(order?.item_total);
    const deliveryFee = Number(order?.delivery_fee);
    const fetchFee = Number(order?.fetch_fee);
    const total = Number(order?.total_amount);

    const parts = [];

    if (Number.isFinite(itemTotal)) {
      parts.push(`Products: ₹${itemTotal.toFixed(2)}`);
    }

    if (Number.isFinite(deliveryFee)) {
      parts.push(`Delivery: ₹${deliveryFee.toFixed(2)}`);
    }

    if (Number.isFinite(fetchFee)) {
      parts.push(`Fetch fee: ₹${fetchFee.toFixed(2)}`);
    }

    if (Number.isFinite(total)) {
      parts.push(`Total: ₹${total.toFixed(2)}`);
    }

    return (
      "The partner store has confirmed the order and provided the real price.\n\n" +
      parts.join("\n") +
      "\n\nPlease approve the total to continue."
    );
  }

  if (status === "finding_shopper") {
    return "I couldn’t use a partner store, so Fetch is finding a shopper who can source the items for you.";
  }

  if (status === "shopper_assigned") {
    return "Your Fetch shopper has accepted the order and will start shopping soon.";
  }

  if (status === "shopping") {
    return "Your Fetch shopper is shopping for your order now.";
  }

  if (status === "picked_up") {
    return "Your order has been picked up and is on its way.";
  }

  if (status === "out_for_delivery") {
    return "Your order is out for delivery.";
  }

  if (status === "delivered") {
    return "Your Fetch order has been delivered.";
  }

  if (status === "cancelled") {
    return "Your Fetch order has been cancelled.";
  }

  return null;
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
      message: buildWebOrderMessage(order),
      terminal: ["delivered", "cancelled"].includes(
        cleanText(order.status).toLowerCase()
      ),
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
   * WEB CUSTOMER PRICE APPROVAL
   *
   * WhatsApp already has deterministic approval logic for an order
   * in awaiting_customer_price_confirmation. The web channel must
   * use the same state-machine path instead of sending "approve"
   * into the Universal Task Engine as a brand-new request.
   *
   * The web conversation maps to a deterministic synthetic customer
   * identity, so current_order_id is the authoritative order pointer.
   */
  const normalizedApproval = text
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .trim();

  const isWebApproval =
    /^(approve|approved|yes|y|yeah|yep|ya|ok|okay|sure|go ahead|confirm|confirmed|please confirm|please confirm my order)$/.test(
      normalizedApproval
    );

  const isWebRejection =
    /^(no|n|nope|cancel|cancelled|reject|rejected|decline|declined|don't|do not)$/.test(
      normalizedApproval
    );

  /*
   * IMPORTANT CONVERSATION RULE:
   *
   * Words such as "yes", "no", "okay" and "sure" are normal
   * conversational replies. They become order approval/rejection
   * ONLY when this web conversation has an order that is explicitly
   * waiting for customer price confirmation.
   *
   * This prevents a normal reply such as:
   *   Fetch: "Would you like the hourly weather forecast?"
   *   User: "Yes"
   *
   * from being incorrectly routed to the order state machine.
   */
  let activeOrder = null;

  if (isWebApproval || isWebRejection) {
    const phone = syntheticWebPhone(conversationId);
    const customer = await getOrCreateCustomer(phone);

    const currentOrderId =
      customer?.current_order_id || null;

    activeOrder = currentOrderId
      ? await getOrderById(currentOrderId)
      : null;

    if (
      activeOrder &&
      activeOrder.status ===
        "awaiting_customer_price_confirmation"
    ) {
      if (isWebRejection) {
        const cancelledOrder = await updateOrder(
          activeOrder.id,
          {
            status: "cancelled",
          }
        );

        return sendJson(
          res,
          200,
          {
            success: true,
            status: "cancelled",
            message: "Okay 👍 The order is cancelled.",
            orderId:
              cancelledOrder?.id ||
              activeOrder.id,
            order:
              cancelledOrder ||
              activeOrder,
            terminal: true,
          },
          origin
        );
      }

      if (
        activeOrder.delivery_pricing_status !==
        "calculated"
      ) {
        return sendJson(
          res,
          200,
          {
            success: true,
            status:
              activeOrder.status,
            message:
              "The delivery fee is still being calculated by Fetch from the road distance. Please wait for the final pricing before confirming.",
            orderId: activeOrder.id,
            order: activeOrder,
            terminal: false,
          },
          origin
        );
      }

      const approvedOrder = await updateOrder(
        activeOrder.id,
        {
          status: "payment_pending",
          payment_status: "pending",
        }
      );

      if (!approvedOrder) {
        throw new Error(
          "Could not move order to payment_pending"
        );
      }

      /*
       * Match the existing WhatsApp customer-approval flow:
       * only after the customer approves the real total do we
       * offer the confirmed procurement job to a shopper.
       */
      const shopperDispatch =
        await offerOrderToShopper(
          approvedOrder
        );

      const total = Number(
        approvedOrder.total_amount || 0
      );

      const message =
        shopperDispatch?.success
          ? `Approved 👍\n\n💰 Total: ₹${total.toFixed(2)}\n\nA shopper has been offered the confirmed job. As soon as they accept, payment details will appear automatically.`
          : `Approved 👍\n\n💰 Total: ₹${total.toFixed(2)}\n\nI’m finding an available Fetch shopper now. Payment details will appear automatically as soon as the shopper accepts.`;

      return sendJson(
        res,
        200,
        {
          success: true,
          status: approvedOrder.status,
          message,
          orderId: approvedOrder.id,
          order: approvedOrder,
          terminal: false,
          execution: {
            success: Boolean(
              shopperDispatch?.success
            ),
            status:
              shopperDispatch?.success
                ? "shopper_offer_sent"
                : "shopper_queued",
          },
        },
        origin
      );
    }

    /*
     * No order is waiting for approval.
     *
     * DO NOT return NO_ACTIVE_ORDER here.
     * Let the Universal Task Engine handle the message as normal
     * conversation. This is what makes "yes", "no", "okay", etc.
     * work naturally after a Fetch answer.
     */
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

      /*
       * Pass recent visible conversation into the universal engine.
       * This is used by the digital agent to understand follow-ups
       * such as "yes", "what do you mean?", "and tomorrow?", etc.
       */
      conversation_history: Array.isArray(body.conversationHistory)
        ? body.conversationHistory
            .slice(-10)
            .map((message) => ({
              role:
                message?.role === "assistant"
                  ? "assistant"
                  : "user",
              content: String(message?.content || "").slice(0, 4000),
            }))
        : [],
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

  /*
   * DETERMINISTIC CLOCK BRIDGE
   *
   * Time was resolved by the universal engine using the system clock.
   * Expose that result directly instead of allowing the request to fall
   * through to the Digital Agent.
   */
  const deterministicResourceType = cleanText(
    result?.atc?.resource_type ||
    result?.task?.resource?.type ||
    result?.execution?.resource_type
  ).toLowerCase();

  if (deterministicResourceType === "deterministic_clock") {
    const timeMessage =
      result?.execution?.result ||
      result?.task?.result ||
      result?.completed_results?.[0]?.message ||
      "Fetch resolved the current time.";

    return sendJson(
      res,
      200,
      {
        success: true,
        status: "completed",
        workflow_id: result?.workflow_id || null,
        message: String(timeMessage),
        atc: result?.atc || null,
        execution: result?.execution || null,
        source: "deterministic_clock",
      },
      origin
    );
  }

  if (isPhysicalResult(result, text)) {
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

  /* LIVE WEATHER SOURCE BRIDGE */
  const resourceType = cleanText(
    result?.atc?.resource_type ||
    result?.task?.resource?.type ||
    result?.execution?.resource_type
  ).toLowerCase();

  if (resourceType === "weather_source") {
    const weatherExecution = result?.execution || {};
    const weatherMessage =
      weatherExecution?.result ||
      weatherExecution?.message ||
      result?.task?.result ||
      "Fetch could not retrieve the current weather.";

    return sendJson(res, 200, {
      success: Boolean(weatherExecution?.success),
      status: weatherExecution?.success ? "completed" : "execution_failed",
      workflow_id: result?.workflow_id || null,
      message: String(weatherMessage),
      fetch: result?.fetch || null,
      atc: result?.atc || null,
      execution: weatherExecution,
    }, origin);
  }

  /*
   * BROWSER AGENT BRIDGE
   *
   * The Universal Task Engine has already routed the request to the
   * Browser Agent and completed the worker call. The web API must expose
   * the worker's actual result instead of falling through to the generic
   * "no execution connector" message.
   */
  const browserResourceType = cleanText(
    result?.atc?.resource_type ||
    result?.task?.resource?.type ||
    result?.execution?.resource_type ||
    result?.execution?.execution?.execution_type
  ).toLowerCase();

  if (browserResourceType === "browser_agent") {
    const browserExecution =
      result?.execution?.execution || result?.execution || {};

    const browserMessage =
      browserExecution?.result ||
      browserExecution?.message ||
      result?.task?.result ||
      "The Browser Agent completed the task.";

    const browserSuccess =
      result?.status === "completed" ||
      browserExecution?.success === true ||
      result?.task?.status === "completed";

    /*
     * IMPORTANT: Browser Agent is a preferred execution resource, not a
     * terminal dependency. If it is unavailable, Fetch must continue using
     * its live research fallback rather than exposing "Application not found"
     * to the customer.
     */
    if (!browserSuccess) {
      const fallback = await executeClaudeResearchFallback({
        text,
        sourcePolicy: {
          preferred_sources: [
            "official sources",
            "reputable current web sources",
            "local/competition/event sources when relevant",
          ],
          resource_attempted: "browser_agent",
        },
        connectorFailure: String(browserMessage),
      });

      if (fallback?.success) {
        return sendJson(res, 200, {
          success: true,
          status: "completed",
          workflow_id: result?.workflow_id || null,
          message: fallback.message,
          fetch: result?.fetch || null,
          atc: {
            ...(result?.atc || {}),
            fallback: "claude_web_research",
            preferred_resource: "browser_agent",
          },
          execution: {
            ...fallback,
            fallback: true,
            preferred_execution: browserExecution,
          },
        }, origin);
      }
    }

    return sendJson(
      res,
      200,
      {
        /* HTTP 200 means the web API handled the request. The connector
         * may still have failed; expose that state without making the UI
         * mistake a handled execution failure for a transport failure. */
        success: true,
        status: browserSuccess
          ? "completed"
          : "execution_failed",
        workflow_id: result?.workflow_id || null,
        message: browserSuccess
          ? String(browserMessage)
          : "Fetch could not verify the latest information from its connected sources right now.",
        fetch: result?.fetch || null,
        atc: result?.atc || null,
        execution: browserExecution,
      },
      origin
    );
  }

  /*
   * DIGITAL AGENT BRIDGE
   *
   * The ATC route is authoritative. If ATC selected digital_agent,
   * invoke the existing Fetch Digital Agent connector directly.
   *
   * This is deliberately NOT a new model and does NOT train anything.
   * It connects the existing agent executor to the web channel.
   *
   * The direct bridge also protects the web channel from an older
   * universal-execution deployment falling through to the generic
   * "awaiting connector" response.
   */
  if (
    cleanText(result?.atc?.resource_type).toLowerCase() ===
    "digital_agent"
  ) {
    const task = {
      id:
        result?.task?.task_id ||
        result?.workflow_id ||
        `web:${Date.now()}`,
      source_text: text,
      goal:
        result?.task?.goal ||
        result?.fetch?.decisions?.[0]?.plan?.source_text ||
        text,
      objective:
        result?.task?.objective ||
        result?.fetch?.decisions?.[0]?.plan?.steps?.[0]?.purpose ||
        text,
      task_data: {
        ...(result?.task || {}),
        source_text: text,
        text,
        atc_route: result?.atc || null,
      },
    };

    let digitalExecution;

    try {
      digitalExecution = await executeDigitalAgent({
        task,
        route: result?.atc || {},
        resource: result?.atc?.resource || {},
        context: {
          channel: "web",
          text,
          customer_id: null,
          conversation_id: conversationId,
          workflow_id: result?.workflow_id || null,
          task_id: task.id,
          atc_route: result?.atc || null,
          use_web_search: true,

          /*
           * Keep the same conversation context for the direct
           * digital-agent bridge. This is critical for normal
           * multi-turn conversation on the web channel.
           */
          conversation_history: Array.isArray(body.conversationHistory)
            ? body.conversationHistory
                .slice(-10)
                .map((message) => ({
                  role:
                    message?.role === "assistant"
                      ? "assistant"
                      : "user",
                  content: String(message?.content || "").slice(0, 4000),
                }))
            : [],
        },
      });
    } catch (error) {
      console.error(
        "FETCH WEB DIGITAL AGENT BRIDGE ERROR:",
        error
      );

      digitalExecution = {
        success: false,
        status: "execution_error",
        message:
          error?.message ||
          "Fetch's digital agent could not complete the request.",
      };
    }

    if (!digitalExecution?.success) {
      const fallback = await executeClaudeResearchFallback({
        text,
        sourcePolicy: {
          preferred_sources: ["authoritative current web sources", "official sources"],
          resource_attempted: "digital_agent",
        },
        connectorFailure: digitalExecution?.message || "Digital Agent execution failed.",
      });

      if (fallback?.success) {
        return sendJson(res, 200, {
          success: true,
          status: "completed",
          workflow_id: result?.workflow_id || null,
          message: fallback.message,
          fetch: result?.fetch || null,
          atc: { ...(result?.atc || {}), fallback: "claude_web_research" },
          execution: { ...fallback, fallback: true },
        }, origin);
      }
    }

    return sendJson(
      res,
      200,
      {
        /* The request itself was handled successfully. Preserve connector
         * success separately in status/execution so the frontend can render
         * the real outcome instead of "API request failed (200)". */
        success: true,
        status: digitalExecution?.success
          ? "completed"
          : "execution_failed",
        workflow_id: result?.workflow_id || null,
        message:
          digitalExecution?.message ||
          "Fetch's digital agent could not complete the request.",
        fetch: result?.fetch || null,
        atc: result?.atc || null,
        execution: digitalExecution || null,
      },
      origin
    );
  }

  /* UNIVERSAL LIVE RESEARCH FALLBACK */
  const fallbackResource = cleanText(
    result?.atc?.resource_type ||
    result?.task?.resource?.type ||
    result?.execution?.resource_type ||
    result?.task?.execution_network
  ).toLowerCase();

  const fallbackEligible = ![
    "partner_store", "physical_network", "human_shopper", "shopper", "physical"
  ].includes(fallbackResource);

  if (fallbackEligible) {
    const fallback = await executeClaudeResearchFallback({
      text,
      sourcePolicy: {
        preferred_sources: fallbackResource === "browser_agent"
          ? ["official sources", "reputable current web sources"]
          : ["authoritative current web sources", "official sources"],
        resource_attempted: fallbackResource || null,
      },
      connectorFailure: result?.execution?.message || result?.task?.result || result?.status || null,
    });

    if (fallback?.success) {
      return sendJson(res, 200, {
        success: true,
        status: "completed",
        workflow_id: result?.workflow_id || null,
        message: fallback.message,
        fetch: result?.fetch || null,
        atc: { ...(result?.atc || {}), fallback: "claude_web_research" },
        execution: { ...fallback, fallback: true },
      }, origin);
    }
  }

  /*
   * Other non-physical requests remain on the Universal Task Engine path.
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
