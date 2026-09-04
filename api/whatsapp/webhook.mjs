import { createHmac, timingSafeEqual } from "crypto";

const SUPABASE_URL =
  process.env.VITE_SUPABASE_URL ||
  "https://skfxzagxlxputwpwxwbe.supabase.co";

const SUPABASE_KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const OPENAI_MODEL = "gpt-5.6-luna";

const ACTIVE_ORDER_STATUSES = [
  "collecting_details",
  "awaiting_confirmation",
  "finding_shopper",
  "shopper_assigned",
  "shopping",
  "out_for_delivery",
];

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function textResponse(body, status = 200) {
  return new Response(String(body), {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

function normalizePhone(phone) {
  if (!phone) return "";
  return String(phone).replace(/[^\d]/g, "");
}

function escapePostgrestValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function supabaseRequest(path, options = {}) {
  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
    ...options.headers,
  };

  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers,
  });

  const text = await response.text();

  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    throw new Error(
      `Supabase ${response.status}: ${
        typeof data === "string" ? data : JSON.stringify(data)
      }`
    );
  }

  return data;
}

async function sendWhatsAppMessage(to, message) {
  if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    throw new Error("WhatsApp environment variables are missing");
  }

  const response = await fetch(
    `https://graph.facebook.com/v26.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
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

async function getCustomer(phone) {
  const encodedPhone = encodeURIComponent(phone);

  const data = await supabaseRequest(
    `customers?phone=eq.${encodedPhone}&select=*&limit=1`
  );

  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

async function createCustomer(phone, name = null) {
  const data = await supabaseRequest("customers", {
    method: "POST",
    headers: {
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      phone,
      name: name || null,
    }),
  });

  return Array.isArray(data) ? data[0] : data;
}

async function getOrCreateCustomer(phone) {
  let customer = await getCustomer(phone);

  if (customer) {
    return customer;
  }

  try {
    customer = await createCustomer(phone);
    return customer;
  } catch (error) {
    // Possible race condition:
    // another request may have created the customer at the same time.
    customer = await getCustomer(phone);

    if (customer) {
      return customer;
    }

    throw error;
  }
}

async function getActiveOrder(customerId) {
  const statuses = ACTIVE_ORDER_STATUSES.map(
    (status) => `"${escapePostgrestValue(status)}"`
  ).join(",");

  const data = await supabaseRequest(
    `orders?customer_id=eq.${encodeURIComponent(
      customerId
    )}&status=in.(${encodeURIComponent(
      statuses
    )})&select=*&order=created_at.desc&limit=1`
  );

  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

async function getLatestOrder(customerId) {
  const data = await supabaseRequest(
    `orders?customer_id=eq.${encodeURIComponent(
      customerId
    )}&select=*&order=created_at.desc&limit=1`
  );

  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

async function getRecentMessages(customerId) {
  try {
    const data = await supabaseRequest(
      `messages?customer_id=eq.${encodeURIComponent(
        customerId
      )}&select=role,message,created_at&order=created_at.desc&limit=12`
    );

    if (!Array.isArray(data)) {
      return [];
    }

    return data.reverse();
  } catch (error) {
    console.error("FETCH MESSAGE HISTORY ERROR:", error);
    return [];
  }
}

async function saveMessage({
  customerId,
  orderId = null,
  phone,
  role,
  message,
}) {
  try {
    await supabaseRequest("messages", {
      method: "POST",
      headers: {
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        customer_id: customerId,
        order_id: orderId,
        phone,
        role,
        message,
      }),
    });
  } catch (error) {
    // Conversation memory should never prevent WhatsApp from working.
    console.error("FETCH SAVE MESSAGE ERROR:", error);
  }
}

async function updateCustomerAddress(customerId, address) {
  if (!address) return;

  try {
    await supabaseRequest(
      `customers?id=eq.${encodeURIComponent(customerId)}`,
      {
        method: "PATCH",
        headers: {
          Prefer: "return=minimal",
        },
        body: JSON.stringify({
          address,
        }),
      }
    );
  } catch (error) {
    console.error("FETCH CUSTOMER ADDRESS UPDATE ERROR:", error);
  }
}

async function createOrder({
  customerId,
  storeName,
  items,
  budget,
  deliveryAddress,
  status,
}) {
  const data = await supabaseRequest("orders", {
    method: "POST",
    headers: {
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      customer_id: customerId,
      store_name: storeName,
      items,
      budget,
      delivery_address: deliveryAddress,
      status,
    }),
  });

  return Array.isArray(data) ? data[0] : data;
}

async function updateOrder(orderId, updates) {
  const cleanUpdates = {};

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      cleanUpdates[key] = value;
    }
  }

  const data = await supabaseRequest(
    `orders?id=eq.${encodeURIComponent(orderId)}`,
    {
      method: "PATCH",
      headers: {
        Prefer: "return=representation",
      },
      body: JSON.stringify(cleanUpdates),
    }
  );

  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

function getOrderStatusText(status) {
  switch (status) {
    case "collecting_details":
      return "I’m still collecting the details for your order.";

    case "awaiting_confirmation":
      return "Your order is ready and waiting for your confirmation.";

    case "finding_shopper":
      return "I’m finding a shopper for your order.";

    case "shopper_assigned":
      return "A shopper has been assigned to your order.";

    case "shopping":
      return "Your shopper is currently shopping for your items.";

    case "out_for_delivery":
      return "Your order is out for delivery.";

    case "delivered":
      return "Your order has been delivered.";

    case "cancelled":
      return "Your order has been cancelled.";

    default:
      return `Your order status is ${status || "unknown"}.`;
  }
}

function getOrderSummary(order) {
  if (!order) return null;

  return {
    id: order.id,
    store_name: order.store_name,
    items: order.items,
    budget: order.budget,
    delivery_address: order.delivery_address,
    status: order.status,
    total_amount: order.total_amount,
    shopper_fee: order.shopper_fee,
    created_at: order.created_at,
  };
}

function cleanAIText(text) {
  if (!text) return "";

  return String(text)
    .trim()
    .replace(/^```json/i, "")
    .replace(/^```/i, "")
    .replace(/```$/i, "")
    .trim();
}

async function callFetchAI({
  userMessage,
  conversationHistory,
  activeOrder,
  latestOrder,
  customer,
}) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is missing");
  }

  const systemPrompt = `
You are Fetch, a friendly AI shopping assistant operating through WhatsApp.

Fetch helps people ask for products from stores and coordinates human shoppers.

Your job is to understand the customer's message naturally and respond conversationally.

LANGUAGE RULES:
- Reply in the same language/style the customer is using.
- You understand English, Malayalam, Manglish, Hindi, Tamil, Telugu, Kannada and mixed-language messages.
- You understand slang, abbreviations, spelling mistakes and informal WhatsApp language.
- If the customer writes Manglish, you can reply in Manglish.
- Do not unnecessarily translate the customer's language into English.
- Keep replies natural and WhatsApp-friendly.
- Never say that you cannot understand a language just because it is mixed or informal.

CONVERSATION RULES:
- Understand the conversation, not just individual keywords.
- "vere nthoke und?" can mean "what else is there?" depending on context.
- "add 10 eggs" means modify the existing shopping request if there is an active order.
- "remove bread" means modify the existing order.
- "change store" means modify the current order if the customer clearly indicates a new store.
- "yes", "yep", "ok", "okay", "haan", "അതെ", "ശരി", etc. may mean confirmation depending on context.
- "no", "nope", "vendam", "വേണ്ട", etc. may mean rejection depending on context.
- "where is my order?" is a status request.
- "cancel it" is a cancellation request.
- Greetings are normal conversation and should not create orders.

ORDER RULES:
- Never create a new order merely because the customer sends another message.
- If there is an active order, normally continue that order.
- Only create a new order when there is no relevant active order, or the customer clearly asks for a new/separate order.
- Never invent store names, items, addresses, budgets, prices, delivery times or shopper information.
- Only extract information that the customer actually provided.
- If information is missing, ask for it naturally.
- Delivery address is required before an order can be confirmed.
- Store and items are required before an order can be confirmed.
- Budget is optional.
- Do not claim a shopper has been found unless the database says so.
- Do not claim an order is delivered unless the database says so.
- Do not claim an exact delivery time unless the database provides it.
- Do not invent availability or product prices.

CONFIRMATION:
- When all required shopping information is available, summarize the order and ask for confirmation.
- Do not mark an order as confirmed yourself. The application will do that after the customer confirms.
- If the customer rejects the order, help them modify it.

STATUS:
- When the customer asks about an order, use the database status supplied to you.
- Do not invent a status.

GENERAL QUESTIONS:
- You can answer normal conversational questions naturally.
- If the question requires live/current external information that is not provided in the conversation or database, do not pretend you have live access.
- Be helpful and concise.

OUTPUT:
Return ONLY valid JSON matching the schema.
`;

  const inputPayload = {
    customer: {
      id: customer?.id || null,
      name: customer?.name || null,
      phone: customer?.phone || null,
      address: customer?.address || null,
    },

    current_active_order: getOrderSummary(activeOrder),

    latest_order: getOrderSummary(latestOrder),

    conversation_history: conversationHistory.map((item) => ({
      role: item.role,
      message: item.message,
    })),

    latest_customer_message: userMessage,
  };

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      instructions: systemPrompt,
      input: JSON.stringify(inputPayload),

      text: {
        format: {
          type: "json_schema",
          name: "fetch_agent_decision",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              intent: {
                type: "string",
                enum: [
                  "greeting",
                  "shopping_request",
                  "update_order",
                  "confirm",
                  "reject",
                  "status",
                  "cancel",
                  "general_question",
                ],
              },

              store: {
                type: ["string", "null"],
              },

              items: {
                type: ["string", "null"],
              },

              delivery_address: {
                type: ["string", "null"],
              },

              budget: {
                type: ["number", "null"],
              },

              response_language: {
                type: "string",
              },

              needs_confirmation: {
                type: "boolean",
              },

              reply: {
                type: "string",
              },
            },
            required: [
              "intent",
              "store",
              "items",
              "delivery_address",
              "budget",
              "response_language",
              "needs_confirmation",
              "reply",
            ],
          },
        },
      },
    }),
  });

  const raw = await response.text();

  if (!response.ok) {
    throw new Error(`OpenAI ${response.status}: ${raw}`);
  }

  let data;

  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid OpenAI response: ${raw}`);
  }

  const outputText = data.output_text;

  if (!outputText) {
    throw new Error("OpenAI returned no output_text");
  }

  const cleaned = cleanAIText(outputText);

  let decision;

  try {
    decision = JSON.parse(cleaned);
  } catch {
    throw new Error(`OpenAI JSON parsing failed: ${cleaned}`);
  }

  return decision;
}

function isConfirmation(message) {
  const text = String(message || "")
    .trim()
    .toLowerCase();

  const confirmations = [
    "yes",
    "y",
    "yeah",
    "yep",
    "yup",
    "yes please",
    "ok",
    "okay",
    "confirm",
    "confirmed",
    "go ahead",
    "do it",
    "sure",
    "haan",
    "ha",
    "haan ji",
    "ശരി",
    "അതെ",
    "ok bro",
    "okay bro",
  ];

  return confirmations.includes(text);
}

function isRejection(message) {
  const text = String(message || "")
    .trim()
    .toLowerCase();

  const rejections = [
    "no",
    "n",
    "nope",
    "not now",
    "don't",
    "dont",
    "cancel",
    "stop",
    "vendam",
    "വേണ്ട",
  ];

  return rejections.includes(text);
}

function missingRequiredFields(order) {
  const missing = [];

  if (!order?.store_name) {
    missing.push("store");
  }

  if (!order?.items) {
    missing.push("items");
  }

  if (!order?.delivery_address) {
    missing.push("delivery address");
  }

  return missing;
}

function buildConfirmationReply(order, languageReply) {
  if (languageReply) {
    return languageReply;
  }

  return `Here’s your order:\n\n🏪 ${order.store_name}\n🛒 ${order.items}\n📍 ${order.delivery_address}${
    order.budget ? `\n💰 Budget: ₹${order.budget}` : ""
  }\n\nShould I place this order?`;
}

function buildFallbackReply({
  userMessage,
  activeOrder,
  latestOrder,
}) {
  const text = String(userMessage || "")
    .trim()
    .toLowerCase();

  if (
    text.includes("where is my order") ||
    text.includes("order status") ||
    text.includes("status")
  ) {
    const order = activeOrder || latestOrder;

    if (!order) {
      return "I don't see an order for you yet. Tell me what you'd like to buy and from which store.";
    }

    return getOrderStatusText(order.status);
  }

  if (isConfirmation(message = userMessage)) {
    if (activeOrder?.status === "awaiting_confirmation") {
      return "Done 👍 Your order is being processed.";
    }
  }

  if (isRejection(userMessage)) {
    return "No problem 👍 Tell me what you'd like to change.";
  }

  if (text === "hi" || text === "hello" || text === "hey") {
    return "Hi 👋 I'm Fetch. Tell me what you need and which store you want it from.";
  }

  return "I'm Fetch 👋 Tell me what you'd like to buy, which store it's from, and where you'd like it delivered.";
}

async function processMessage({
  phone,
  customer,
  userMessage,
}) {
  const conversationHistory = await getRecentMessages(customer.id);

  const activeOrder = await getActiveOrder(customer.id);
  const latestOrder = await getLatestOrder(customer.id);

  const decision = await callFetchAI({
    userMessage,
    conversationHistory,
    activeOrder,
    latestOrder,
    customer,
  });

  console.log(
    "FETCH AI DECISION:",
    JSON.stringify(decision, null, 2)
  );

  let order = activeOrder;

  /*
   * 1. STATUS
   */
  if (decision.intent === "status") {
    const statusOrder = activeOrder || latestOrder;

    if (!statusOrder) {
      return {
        reply:
          decision.reply ||
          "I don't see an order for you yet. Tell me what you'd like to buy.",
        order: null,
      };
    }

    return {
      reply:
        decision.reply ||
        getOrderStatusText(statusOrder.status),
      order: statusOrder,
    };
  }

  /*
   * 2. CANCEL
   */
  if (decision.intent === "cancel") {
    if (!activeOrder) {
      return {
        reply:
          decision.reply ||
          "I don't see an active order to cancel.",
        order: null,
      };
    }

    if (
      [
        "finding_shopper",
        "shopper_assigned",
        "shopping",
        "out_for_delivery",
      ].includes(activeOrder.status)
    ) {
      return {
        reply:
          decision.reply ||
          "Your order is already being processed, so I can't cancel it automatically right now.",
        order: activeOrder,
      };
    }

    order = await updateOrder(activeOrder.id, {
      status: "cancelled",
    });

    return {
      reply:
        decision.reply ||
        "Done. I've cancelled the order.",
      order,
    };
  }

  /*
   * 3. REJECT / NO
   */
  if (
    decision.intent === "reject" ||
    isRejection(userMessage)
  ) {
    if (activeOrder?.status === "awaiting_confirmation") {
      order = await updateOrder(activeOrder.id, {
        status: "collecting_details",
      });
    }

    return {
      reply:
        decision.reply ||
        "No problem 👍 Tell me what you'd like to change.",
      order,
    };
  }

  /*
   * 4. CONFIRM / YES
   */
  if (
    decision.intent === "confirm" ||
    isConfirmation(userMessage)
  ) {
    if (activeOrder?.status === "awaiting_confirmation") {
      order = await updateOrder(activeOrder.id, {
        status: "finding_shopper",
      });

      return {
        reply:
          decision.reply ||
          "Confirmed 👍 I'm finding a shopper for your order now.",
        order,
      };
    }

    if (activeOrder) {
      return {
        reply:
          decision.reply ||
          "Your current order is already being processed.",
        order: activeOrder,
      };
  }

    return {
      reply:
        decision.reply ||
        "Sure 👍 Tell me what you'd like to order.",
      order: null,
    };
  }

  /*
   * 5. SHOPPING REQUEST / ORDER UPDATE
   */
  if (
    decision.intent === "shopping_request" ||
    decision.intent === "update_order"
  ) {
    /*
     * If there is already a confirmed/processing order,
     * don't accidentally create another order.
     */
    if (
      activeOrder &&
      [
        "finding_shopper",
        "shopper_assigned",
        "shopping",
        "out_for_delivery",
      ].includes(activeOrder.status)
    ) {
      return {
        reply:
          decision.reply ||
          "Your current order is already being processed. If you want to create a separate new order, tell me that it's a new order.",
        order: activeOrder,
      };
    }

    /*
     * Existing draft/order:
     * update the SAME order.
     */
    if (
      activeOrder &&
      [
        "collecting_details",
        "awaiting_confirmation",
      ].includes(activeOrder.status)
    ) {
      const updates = {};

      if (decision.store) {
        updates.store_name = decision.store;
      }

      if (decision.items) {
        updates.items = decision.items;
      }

      if (decision.budget !== null && decision.budget !== undefined) {
        updates.budget = decision.budget;
      }

      if (decision.delivery_address) {
        updates.delivery_address = decision.delivery_address;

        await updateCustomerAddress(
          customer.id,
          decision.delivery_address
        );
      }

      const mergedOrder = {
        ...activeOrder,
        ...updates,
      };

      const missing = missingRequiredFields(mergedOrder);

      if (missing.length === 0) {
        updates.status = "awaiting_confirmation";
      } else {
        updates.status = "collecting_details";
      }

      order = await updateOrder(activeOrder.id, updates);

      if (missing.length === 0) {
        return {
          reply:
            decision.reply ||
            buildConfirmationReply(order),
          order,
        };
      }

      return {
        reply:
          decision.reply ||
          `I just need your ${missing.join(
            " and "
          )} to complete the order.`,
        order,
      };
    }

    /*
     * No active order:
     * create one if we have enough information.
     */
    const store = decision.store || null;
    const items = decision.items || null;
    const deliveryAddress =
      decision.delivery_address ||
      customer.address ||
      null;

    const budget =
      decision.budget !== null &&
      decision.budget !== undefined
        ? decision.budget
        : null;

    const missing = [];

    if (!store) {
      missing.push("store");
    }

    if (!items) {
      missing.push("items");
    }

    if (!deliveryAddress) {
      missing.push("delivery address");
    }

    if (missing.length > 0) {
      order = await createOrder({
        customerId: customer.id,
        storeName: store || "Not specified",
        items: items || "Not specified",
        budget,
        deliveryAddress,
        status: "collecting_details",
      });

      if (deliveryAddress) {
        await updateCustomerAddress(
          customer.id,
          deliveryAddress
        );
      }

      return {
        reply:
          decision.reply ||
          `Sure 👍 I just need your ${missing.join(
            " and "
          )}.`,
        order,
      };
    }

    order = await createOrder({
      customerId: customer.id,
      storeName: store,
      items,
      budget,
      deliveryAddress,
      status: "awaiting_confirmation",
    });

    await updateCustomerAddress(
      customer.id,
      deliveryAddress
    );

    return {
      reply:
        decision.reply ||
        buildConfirmationReply(order),
      order,
    };
  }

  /*
   * 6. NORMAL CONVERSATION
   */
  return {
    reply:
      decision.reply ||
      "I'm Fetch 👋 How can I help?",
    order: activeOrder || null,
  };
}

async function handleIncomingMessage(message) {
  if (!message) {
    return;
  }

  if (message.type !== "text") {
    return;
  }

  const phone = normalizePhone(message.from);
  const userMessage = message.text?.body?.trim();

  if (!phone || !userMessage) {
    return;
  }

  console.log(
    `FETCH INCOMING MESSAGE FROM ${phone}: ${userMessage}`
  );

  const customer = await getOrCreateCustomer(phone);

  const activeOrderBefore = await getActiveOrder(customer.id);

  await saveMessage({
    customerId: customer.id,
    orderId: activeOrderBefore?.id || null,
    phone,
    role: "user",
    message: userMessage,
  });

  let result;

  try {
    result = await processMessage({
      phone,
      customer,
      userMessage,
    });
  } catch (error) {
    console.error("FETCH AI PROCESSING ERROR:", error);

    result = {
      reply: buildFallbackReply({
        userMessage,
        activeOrder: activeOrderBefore,
        latestOrder: await getLatestOrder(customer.id),
      }),
      order: activeOrderBefore,
    };
  }

  const reply = result.reply?.trim();

  if (!reply) {
    return;
  }

  await saveMessage({
    customerId: customer.id,
    orderId: result.order?.id || activeOrderBefore?.id || null,
    phone,
    role: "assistant",
    message: reply,
  });

  await sendWhatsAppMessage(phone, reply);
}

async function verifyMetaSignature(request, rawBody) {
  /*
   * Meta signature verification can be enabled later when
   * the app's App Secret is configured in Vercel.
   *
   * For the current MVP, we rely on Meta webhook verification
   * plus the WhatsApp access token.
   */

  return true;
}

export async function GET(request) {
  const url = new URL(request.url);

  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (
    mode === "subscribe" &&
    token === WHATSAPP_VERIFY_TOKEN
  ) {
    return textResponse(challenge || "", 200);
  }

  return textResponse("Forbidden", 403);
}

export async function POST(request) {
  try {
    const rawBody = await request.text();

    await verifyMetaSignature(request, rawBody);

    let body;

    try {
      body = JSON.parse(rawBody);
    } catch {
      return jsonResponse(
        {
          error: "Invalid JSON",
        },
        400
      );
    }

    console.log(
      "FETCH WEBHOOK RECEIVED:",
      JSON.stringify(body, null, 2)
    );

    /*
     * WhatsApp Cloud API webhook structure:
     *
     * entry[]
     *   changes[]
     *     value
     *       messages[]
     */

    const entries = Array.isArray(body.entry)
      ? body.entry
      : [];

    for (const entry of entries) {
      const changes = Array.isArray(entry.changes)
        ? entry.changes
        : [];

      for (const change of changes) {
        const value = change.value;

        if (!value) {
          continue;
        }

        const messages = Array.isArray(value.messages)
          ? value.messages
          : [];

        for (const message of messages) {
          try {
            await handleIncomingMessage(message);
          } catch (error) {
            console.error(
              "FETCH MESSAGE HANDLING ERROR:",
              error
            );
          }
        }
      }
    }

    /*
     * Meta expects a quick 200 response.
     */
    return jsonResponse({
      success: true,
    });
  } catch (error) {
    console.error("FETCH WEBHOOK ERROR:", error);

    /*
     * Return 200 so Meta doesn't continuously retry
     * a malformed/non-critical webhook event.
     */
    return jsonResponse({
      success: false,
    });
  }
}
