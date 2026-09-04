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

async function createCustomer(phone) {
  const data = await supabaseRequest("customers", {
    method: "POST",
    headers: {
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      phone,
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
    return await createCustomer(phone);
  } catch (error) {
    customer = await getCustomer(phone);

    if (customer) {
      return customer;
    }

    throw error;
  }
}

async function getActiveOrder(customerId) {
  const statusList = ACTIVE_ORDER_STATUSES
    .map((status) => `"${status}"`)
    .join(",");

  const data = await supabaseRequest(
    `orders?customer_id=eq.${encodeURIComponent(
      customerId
    )}&status=in.(${encodeURIComponent(
      statusList
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
  orderId,
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
        order_id: orderId || null,
        phone,
        role,
        message,
      }),
    });
  } catch (error) {
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
  const data = await supabaseRequest(
    `orders?id=eq.${encodeURIComponent(orderId)}`,
    {
      method: "PATCH",
      headers: {
        Prefer: "return=representation",
      },
      body: JSON.stringify(updates),
    }
  );

  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

function getOrderStatusText(status) {
  switch (status) {
    case "collecting_details":
      return "I'm still collecting the details for your order.";

    case "awaiting_confirmation":
      return "Your order is ready and waiting for your confirmation.";

    case "finding_shopper":
      return "I'm finding a shopper for your order.";

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
    "stop",
    "vendam",
    "വേണ്ട",
  ];

  return rejections.includes(text);
}

function missingRequiredFields(order) {
  const missing = [];

  if (!order?.store_name || order.store_name === "Not specified") {
    missing.push("store");
  }

  if (!order?.items || order.items === "Not specified") {
    missing.push("items");
  }

  if (!order?.delivery_address) {
    missing.push("delivery address");
  }

  return missing;
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

Fetch helps people request products from stores and coordinates human shoppers.

Your job is to understand the customer's message naturally and respond conversationally.

LANGUAGE:

Understand and respond naturally in:

- English
- Malayalam
- Manglish
- Hindi
- Tamil
- Telugu
- Kannada
- Mixed languages
- Informal WhatsApp language
- Typos
- Slang
- Short messages

Always try to respond in the same language and style as the customer.

If the customer writes Manglish, replying in Manglish is acceptable.

Do not unnecessarily translate their message into English.

CONVERSATION:

Understand the meaning using the previous conversation.

Examples:

"vere nthoke und?"
"add 10 eggs"
"remove bread"
"change the store"
"where is my order?"
"cancel it"
"yes"
"no"

These must be interpreted based on conversation context.

Do NOT create a new order just because the customer sent another message.

If an active order exists, continue working with that order unless the customer clearly asks for a separate new order.

ORDER:

Required:

1. Store
2. Items
3. Delivery address

Budget is optional.

Never invent:

- Store
- Items
- Address
- Price
- Budget
- Shopper
- Delivery time
- Order status
- Product availability

Only use information actually supplied by the customer or supplied by the database.

CONFIRMATION:

When all required information is available, summarize the order and ask the customer to confirm.

Do not claim the order is confirmed merely because you generated the summary.

STATUS:

If the customer asks where their order is, what is happening, or asks for status, use the database status.

GENERAL QUESTIONS:

You can answer normal conversational questions.

Do not pretend to have live information if it is not provided.

Keep WhatsApp responses natural and reasonably short.

Return ONLY JSON matching the required schema.
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

  const response = await fetch(
    "https://api.openai.com/v1/responses",
    {
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
    }
  );

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

  if (!data.output_text) {
    throw new Error("OpenAI returned no output_text");
  }

  const cleaned = cleanAIText(data.output_text);

  let decision;

  try {
    decision = JSON.parse(cleaned);
  } catch {
    throw new Error(
      `OpenAI JSON parsing failed: ${cleaned}`
    );
  }

  return decision;
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
    text === "status" ||
    text.includes("where is my order?")
  ) {
    const order = activeOrder || latestOrder;

    if (!order) {
      return "I don't see an order for you yet. Tell me what you'd like to buy and which store you want it from.";
    }

    return getOrderStatusText(order.status);
  }

  if (isConfirmation(userMessage)) {
    if (activeOrder?.status === "awaiting_confirmation") {
      return "Done 👍 Your order is being processed.";
    }

    return "Sure 👍 Tell me what you'd like to order.";
  }

  if (isRejection(userMessage)) {
    return "No problem 👍 Tell me what you'd like to change.";
  }

  if (
    text === "hi" ||
    text === "hello" ||
    text === "hey" ||
    text === "hi fetch" ||
    text === "hello fetch"
  ) {
    return "Hi 👋 I'm Fetch. Tell me what you need and which store you want it from.";
  }

  return "I'm Fetch 👋 Tell me what you'd like to buy, which store it's from, and where you'd like it delivered.";
}

async function processMessage({
  phone,
  customer,
  userMessage,
}) {
  const conversationHistory =
    await getRecentMessages(customer.id);

  const activeOrder =
    await getActiveOrder(customer.id);

  const latestOrder =
    await getLatestOrder(customer.id);

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
   * STATUS
   */

  if (decision.intent === "status") {
    const statusOrder =
      activeOrder || latestOrder;

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
   * CANCEL
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

    order = await updateOrder(
      activeOrder.id,
      {
        status: "cancelled",
      }
    );

    return {
      reply:
        decision.reply ||
        "Done. I've cancelled the order.",

      order,
    };
  }

  /*
   * REJECT
   */

  if (
    decision.intent === "reject" ||
    isRejection(userMessage)
  ) {
    if (
      activeOrder?.status ===
      "awaiting_confirmation"
    ) {
      order = await updateOrder(
        activeOrder.id,
        {
          status: "collecting_details",
        }
      );
    }

    return {
      reply:
        decision.reply ||
        "No problem 👍 Tell me what you'd like to change.",

      order,
    };
  }

  /*
   * CONFIRM
   */

  if (
    decision.intent === "confirm" ||
    isConfirmation(userMessage)
  ) {
    if (
      activeOrder?.status ===
      "awaiting_confirmation"
    ) {
      order = await updateOrder(
        activeOrder.id,
        {
          status: "finding_shopper",
        }
      );

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
   * SHOPPING REQUEST / ORDER UPDATE
   */

  if (
    decision.intent ===
      "shopping_request" ||
    decision.intent ===
      "update_order"
  ) {
    /*
     * Don't create another order when
     * the existing order is already processing.
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
          "Your current order is already being processed. If you want to create a separate order, tell me that it is a new order.",

        order: activeOrder,
      };
    }

    /*
     * Existing draft:
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
        updates.store_name =
          decision.store;
      }

      if (decision.items) {
        updates.items =
          decision.items;
      }

      if (
        decision.budget !== null &&
        decision.budget !== undefined
      ) {
        updates.budget =
          decision.budget;
      }

      if (decision.delivery_address) {
        updates.delivery_address =
          decision.delivery_address;

        await updateCustomerAddress(
          customer.id,
          decision.delivery_address
        );
      }

      const mergedOrder = {
        ...activeOrder,
        ...updates,
      };

      const missing =
        missingRequiredFields(
          mergedOrder
        );

      if (missing.length === 0) {
        updates.status =
          "awaiting_confirmation";
      } else {
        updates.status =
          "collecting_details";
      }

      order = await updateOrder(
        activeOrder.id,
        updates
      );

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
     * create one.
     */

    const store =
      decision.store || null;

    const items =
      decision.items || null;

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

        storeName:
          store || "Not specified",

        items:
          items || "Not specified",

        budget,

        deliveryAddress,

        status:
          "collecting_details",
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

      status:
        "awaiting_confirmation",
    });

    await updateCustomerAddress(
      customer.id,
      deliveryAddress
    );

    return {
      reply:
        decision.reply ||
        `Here's your order:\n\n🏪 ${store}\n🛒 ${items}\n📍 ${deliveryAddress}${
          budget
            ? `\n💰 Budget: ₹${budget}`
            : ""
        }\n\nShould I place this order?`,

      order,
    };
  }

  /*
   * NORMAL CONVERSATION
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

  const phone =
    normalizePhone(message.from);

  const userMessage =
    message.text?.body?.trim();

  if (!phone || !userMessage) {
    return;
  }

  console.log(
    `FETCH INCOMING MESSAGE FROM ${phone}: ${userMessage}`
  );

  const customer =
    await getOrCreateCustomer(phone);

  const activeOrderBefore =
    await getActiveOrder(customer.id);

  /*
   * Save customer message.
   */

  await saveMessage({
    customerId: customer.id,

    orderId:
      activeOrderBefore?.id || null,

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
    console.error(
      "FETCH AI PROCESSING ERROR:",
      error
    );

    /*
     * AI failure should not kill Fetch.
     */

    result = {
      reply: buildFallbackReply({
        userMessage,

        activeOrder:
          activeOrderBefore,

        latestOrder:
          await getLatestOrder(
            customer.id
          ),
      }),

      order:
        activeOrderBefore,
    };
  }

  const reply =
    result.reply?.trim();

  if (!reply) {
    return;
  }

  /*
   * Save Fetch's response.
   */

  await saveMessage({
    customerId: customer.id,

    orderId:
      result.order?.id ||
      activeOrderBefore?.id ||
      null,

    phone,

    role: "assistant",

    message: reply,
  });

  /*
   * Send response to WhatsApp.
   */

  await sendWhatsAppMessage(
    phone,
    reply
  );
}

export async function GET(request) {
  const url =
    new URL(request.url);

  const mode =
    url.searchParams.get(
      "hub.mode"
    );

  const token =
    url.searchParams.get(
      "hub.verify_token"
    );

  const challenge =
    url.searchParams.get(
      "hub.challenge"
    );

  if (
    mode === "subscribe" &&
    token === WHATSAPP_VERIFY_TOKEN
  ) {
    return textResponse(
      challenge || "",
      200
    );
  }

  return textResponse(
    "Forbidden",
    403
  );
}

export async function POST(request) {
  try {
    const rawBody =
      await request.text();

    let body;

    try {
      body =
        JSON.parse(rawBody);
    } catch {
      return jsonResponse(
        {
          error:
            "Invalid JSON",
        },
        400
      );
    }

    console.log(
      "FETCH WEBHOOK RECEIVED:",
      JSON.stringify(
        body,
        null,
        2
      )
    );

    const entries =
      Array.isArray(body.entry)
        ? body.entry
        : [];

    for (const entry of entries) {
      const changes =
        Array.isArray(
          entry.changes
        )
          ? entry.changes
          : [];

      for (const change of changes) {
        const value =
          change.value;

        if (!value) {
          continue;
        }

        const messages =
          Array.isArray(
            value.messages
          )
            ? value.messages
            : [];

        for (const message of messages) {
          try {
            await handleIncomingMessage(
              message
            );
          } catch (error) {
            console.error(
              "FETCH MESSAGE HANDLING ERROR:",
              error
            );
          }
        }
      }
    }

    return jsonResponse({
      success: true,
    });
  } catch (error) {
    console.error(
      "FETCH WEBHOOK ERROR:",
      error
    );

    return jsonResponse({
      success: false,
    });
  }
}
