const SUPABASE_URL =
  process.env.VITE_SUPABASE_URL || "https://skfxzagxlxputwpwxwbe.supabase.co";
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
  "picked_up",
  "out_for_delivery",
];

function normalizePhone(phone) {
  return phone ? String(phone).replace(/[^\d]/g, "") : "";
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(body, status = 200) {
  return new Response(String(body), {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

async function supabaseRequest(path, options = {}) {
  if (!SUPABASE_KEY) {
    throw new Error("VITE_SUPABASE_PUBLISHABLE_KEY is missing");
  }

  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

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

  const normalizedTo = normalizePhone(to);

  console.log(
    "FETCH WHATSAPP SEND:",
    JSON.stringify({ to: normalizedTo, message })
  );

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

  console.log(
    "FETCH WHATSAPP API RESPONSE:",
    JSON.stringify(data)
  );

  return data;
}

/* CUSTOMERS */

async function getCustomer(phone) {
  const data = await supabaseRequest(
    `customers?phone=eq.${encodeURIComponent(
      normalizePhone(phone)
    )}&select=*&limit=1`
  );

  return Array.isArray(data) && data.length ? data[0] : null;
}

async function getOrCreateCustomer(phone) {
  const normalizedPhone = normalizePhone(phone);

  let customer = await getCustomer(normalizedPhone);

  if (customer) {
    return customer;
  }

  try {
    const data = await supabaseRequest("customers", {
      method: "POST",
      headers: {
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        phone: normalizedPhone,
      }),
    });

    return Array.isArray(data) ? data[0] : data;
  } catch (error) {
    customer = await getCustomer(normalizedPhone);

    if (customer) {
      return customer;
    }

    throw error;
  }
}

async function updateCustomerAddress(customerId, address) {
  if (!address) return;

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
}

/* SHOPPERS */

async function getShopperByPhone(phone) {
  const normalizedPhone = normalizePhone(phone);

  const exact = await supabaseRequest(
    `shoppers?phone=eq.${encodeURIComponent(
      normalizedPhone
    )}&select=*&limit=1`
  );

  if (Array.isArray(exact) && exact.length) {
    return exact[0];
  }

  const shoppers = await supabaseRequest(
    "shoppers?select=*&limit=100"
  );

  if (!Array.isArray(shoppers)) {
    return null;
  }

  return (
    shoppers.find(
      (s) => normalizePhone(s.phone) === normalizedPhone
    ) || null
  );
}

async function createShopper(phone) {
  const normalizedPhone = normalizePhone(phone);

  const data = await supabaseRequest("shoppers", {
    method: "POST",
    headers: {
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      name: `Fetch Shopper ${normalizedPhone.slice(-4)}`,
      phone: normalizedPhone,
      available: true,
      whatsapp_opted_in: true,
      last_seen_at: new Date().toISOString(),
    }),
  });

  return Array.isArray(data) ? data[0] : data;
}

async function getOrCreateShopper(phone) {
  let shopper = await getShopperByPhone(phone);

  if (shopper) {
    return shopper;
  }

  try {
    return await createShopper(phone);
  } catch (error) {
    shopper = await getShopperByPhone(phone);

    if (shopper) {
      return shopper;
    }

    throw error;
  }
}

async function updateShopper(shopperId, updates) {
  const data = await supabaseRequest(
    `shoppers?id=eq.${encodeURIComponent(shopperId)}`,
    {
      method: "PATCH",
      headers: {
        Prefer: "return=representation",
      },
      body: JSON.stringify(updates),
    }
  );

  return Array.isArray(data) && data.length ? data[0] : null;
}

/* ORDERS */

async function getActiveOrder(customerId) {
  const statusQuery = ACTIVE_ORDER_STATUSES.join(",");

  const data = await supabaseRequest(
    `orders?customer_id=eq.${encodeURIComponent(
      customerId
    )}&status=in.(${encodeURIComponent(
      statusQuery
    )})&select=*&order=created_at.desc&limit=1`
  );

  return Array.isArray(data) && data.length ? data[0] : null;
}

async function getLatestOrder(customerId) {
  const data = await supabaseRequest(
    `orders?customer_id=eq.${encodeURIComponent(
      customerId
    )}&select=*&order=created_at.desc&limit=1`
  );

  return Array.isArray(data) && data.length ? data[0] : null;
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
      budget: budget ?? null,
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

  return Array.isArray(data) && data.length ? data[0] : null;
}

async function getOrderById(orderId) {
  const data = await supabaseRequest(
    `orders?id=eq.${encodeURIComponent(
      orderId
    )}&select=*&limit=1`
  );

  return Array.isArray(data) && data.length ? data[0] : null;
}

/* MEMORY */

async function getRecentMessages(customerId) {
  try {
    const data = await supabaseRequest(
      `messages?customer_id=eq.${encodeURIComponent(
        customerId
      )}&select=role,message,created_at&order=created_at.desc&limit=12`
    );

    return Array.isArray(data) ? data.reverse() : [];
  } catch (error) {
    console.error(
      "FETCH MESSAGE HISTORY ERROR:",
      error
    );

    return [];
  }
}

async function saveMessage({
  customerId = null,
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
        phone: normalizePhone(phone),
        role,
        message,
      }),
    });
  } catch (error) {
    console.error(
      "FETCH SAVE MESSAGE ERROR:",
      error
    );
  }
}

/* SHOPPER JOBS */

async function getOpenShopperJob(shopperId) {
  const data = await supabaseRequest(
    `shopper_jobs?shopper_id=eq.${encodeURIComponent(
      shopperId
    )}&status=eq.offered&select=*&order=offered_at.desc&limit=1`
  );

  return Array.isArray(data) && data.length ? data[0] : null;
}

async function getAcceptedShopperJob(shopperId) {
  const data = await supabaseRequest(
    `shopper_jobs?shopper_id=eq.${encodeURIComponent(
      shopperId
    )}&status=eq.accepted&select=*&order=accepted_at.desc&limit=1`
  );

  return Array.isArray(data) && data.length ? data[0] : null;
}

async function createShopperJob(orderId, shopperId) {
  const data = await supabaseRequest("shopper_jobs", {
    method: "POST",
    headers: {
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      order_id: orderId,
      shopper_id: shopperId,
      status: "offered",
      offered_at: new Date().toISOString(),
    }),
  });

  return Array.isArray(data) ? data[0] : data;
}

async function updateShopperJob(jobId, updates) {
  const data = await supabaseRequest(
    `shopper_jobs?id=eq.${encodeURIComponent(jobId)}`,
    {
      method: "PATCH",
      headers: {
        Prefer: "return=representation",
      },
      body: JSON.stringify(updates),
    }
  );

  return Array.isArray(data) && data.length ? data[0] : null;
}

async function getAvailableShoppers(excludedIds = []) {
  const data = await supabaseRequest(
    "shoppers?available=eq.true&whatsapp_opted_in=eq.true&select=*&limit=100"
  );

  if (!Array.isArray(data)) {
    return [];
  }

  return data.filter(
    (shopper) =>
      !excludedIds.includes(shopper.id) &&
      !shopper.current_order_id
  );
}

async function offerOrderToShopper(
  order,
  excludedIds = []
) {
  const shoppers = await getAvailableShoppers(
    excludedIds
  );

  if (!shoppers.length) {
    return {
      success: false,
      shopper: null,
      job: null,
    };
  }

  for (const shopper of shoppers) {
    try {
      const existing = await supabaseRequest(
        `shopper_jobs?order_id=eq.${encodeURIComponent(
          order.id
        )}&shopper_id=eq.${encodeURIComponent(
          shopper.id
        )}&status=eq.offered&select=*&limit=1`
      );

      const job =
        Array.isArray(existing) && existing.length
          ? existing[0]
          : await createShopperJob(
              order.id,
              shopper.id
            );

      const shopperMessage =
        `🛍️ *New Fetch Job*\n\n` +
        `🏪 Store: ${order.store_name}\n` +
        `🛒 Items: ${order.items}\n` +
        `📍 Deliver to: ${order.delivery_address}\n` +
        (order.budget != null
          ? `💰 Budget: ₹${order.budget}\n`
          : "") +
        `\nReply *ACCEPT* to take this job.\n` +
        `Reply *DECLINE* to skip it.`;

      await sendWhatsAppMessage(
        shopper.phone,
        shopperMessage
      );

      await updateOrder(order.id, {
        status: "finding_shopper",
        shopper_id: null,
      });

      return {
        success: true,
        shopper,
        job,
      };
    } catch (error) {
      console.error(
        "FETCH DISPATCH SHOPPER ERROR:",
        error
      );
    }
  }

  return {
    success: false,
    shopper: null,
    job: null,
  };
}

function getOrderStatusText(status) {
  switch (status) {
    case "collecting_details":
      return "I’m still collecting the details for your order.";

    case "awaiting_confirmation":
      return "Your order is waiting for your confirmation.";

    case "finding_shopper":
      return "I’m finding a Fetch shopper for your order right now.";

    case "shopper_assigned":
      return "A Fetch shopper has accepted your order and will start shopping soon.";

    case "shopping":
      return "Your Fetch shopper is shopping for your items now.";

    case "picked_up":
      return "Your items have been picked up and are ready for delivery.";

    case "out_for_delivery":
      return "Your order is on the way to you.";

    case "delivered":
      return "Your order has been delivered. 🎉";

    case "cancelled":
      return "Your order has been cancelled.";

    default:
      return "I’m checking your latest order status.";
  }
}

/* OPENAI */

function extractResponseText(data) {
  if (
    typeof data?.output_text === "string" &&
    data.output_text.trim()
  ) {
    return data.output_text.trim();
  }

  const pieces = [];

  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === "string") {
        pieces.push(content.text);
      }
    }
  }

  return pieces.join("\n").trim();
}

function cleanJsonText(text) {
  return String(text || "")
    .trim()
    .replace(/^```json/i, "")
    .replace(/^```/i, "")
    .replace(/```$/i, "")
    .trim();
}

async function callFetchAI({
  userMessage,
  history,
  activeOrder,
  latestOrder,
  customer,
}) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is missing");
  }

  const systemPrompt = `
You are Fetch, a friendly AI shopping agent operating through WhatsApp in India.

Your job is to understand natural customer messages and help them order items from a store using a human Fetch shopper.

Understand English, Malayalam, Manglish, Hindi, Tamil, Telugu, Kannada, mixed languages, typos, slang and short messages.

Examples you must understand:
- "vere nthoke und?" means "what else is there?"
- "add 10 eggs" means add 10 eggs to the current order
- "where is my order?" means status
- "cancel it" means cancel
- "yes", "ya", "yep", "okay", "go ahead" can mean confirmation when an order is awaiting confirmation
- "no", "nope", "don't" can mean rejection/cancellation depending on context

Rules:
1. Never invent a store, item, address or price.
2. Keep replies natural and concise for WhatsApp.
3. If the customer gives enough information for store + items + delivery address, prepare a shopping request.
4. If information is missing, ask for only the missing information.
5. If an active order exists, understand updates such as adding/removing items or changing the address.
6. A confirmation means the customer wants the order placed. Do not claim a shopper accepted until the system tells you that.
7. Do not say the order is delivered unless the database status is delivered.
8. Reply in the customer's language/style when practical.

Return only the requested JSON structure.
`;

  const context = {
    customer: {
      name: customer?.name || null,
      address: customer?.address || null,
    },

    active_order: activeOrder || null,

    latest_order: latestOrder || null,

    conversation: history,

    current_message: userMessage,
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

        input: [
          {
            role: "system",
            content: [
              {
                type: "input_text",
                text: systemPrompt,
              },
            ],
          },

          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: JSON.stringify(context),
              },
            ],
          },
        ],

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

                store_name: {
                  type: "string",
                },

                items: {
                  type: "string",
                },

                delivery_address: {
                  type: "string",
                },

                budget: {
                  type: ["number", "null"],
                },

                reply: {
                  type: "string",
                },
              },

              required: [
                "intent",
                "store_name",
                "items",
                "delivery_address",
                "budget",
                "reply",
              ],
            },
          },
        },
      }),
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `OpenAI ${response.status}: ${JSON.stringify(data)}`
    );
  }

  const text = cleanJsonText(
    extractResponseText(data)
  );

  const decision = JSON.parse(text);

  console.log(
    "FETCH AI DECISION:",
    JSON.stringify(decision)
  );

  return decision;
}

function fallbackDecision(
  userMessage,
  activeOrder,
  customer
) {
  const text = String(userMessage || "").trim();

  const lower = text.toLowerCase();

  const yes =
    /^(yes|y|yeah|yep|ya|ok|okay|sure|go ahead|confirm|confirmed)$/i.test(
      text
    );

  const no =
    /^(no|n|nope|cancel|don't|dont)$/i.test(text);

  if (
    yes &&
    activeOrder?.status === "awaiting_confirmation"
  ) {
    return {
      intent: "confirm",

      store_name: activeOrder.store_name,

      items: activeOrder.items,

      delivery_address:
        activeOrder.delivery_address ||
        customer?.address ||
        "",

      budget: activeOrder.budget ?? null,

      reply: "Confirmed 👍",
    };
  }

  if (no && activeOrder) {
    return {
      intent: "reject",

      store_name: activeOrder.store_name,

      items: activeOrder.items,

      delivery_address:
        activeOrder.delivery_address || "",

      budget: activeOrder.budget ?? null,

      reply: "Okay — I won’t place that order.",
    };
  }

  if (
    /where.*order|order.*where|status|track/i.test(
      lower
    )
  ) {
    return {
      intent: "status",

      store_name: "",

      items: "",

      delivery_address: "",

      budget: null,

      reply: "Let me check your order status.",
    };
  }

  return {
    intent: "general_question",

    store_name: "",

    items: "",

    delivery_address: "",

    budget: null,

    reply:
      "Tell me what you’d like me to fetch, which store, and where to deliver it.",
  };
}

/* CUSTOMER ENGINE */

async function handleCustomerMessage({
  phone,
  userMessage,
}) {
  const normalizedPhone = normalizePhone(phone);

  const customer =
    await getOrCreateCustomer(normalizedPhone);

  const activeOrder =
    await getActiveOrder(customer.id);

  const latestOrder =
    await getLatestOrder(customer.id);

  const history =
    await getRecentMessages(customer.id);

  await saveMessage({
    customerId: customer.id,

    orderId:
      activeOrder?.id ||
      latestOrder?.id ||
      null,

    phone: normalizedPhone,

    role: "user",

    message: userMessage,
  });

  let decision;

  try {
    decision = await callFetchAI({
      userMessage,
      history,
      activeOrder,
      latestOrder,
      customer,
    });
  } catch (error) {
    console.error(
      "FETCH AI ERROR:",
      error
    );

    decision = fallbackDecision(
      userMessage,
      activeOrder,
      customer
    );
  }

  let order = activeOrder;

  /* STATUS */

  if (decision.intent === "status") {
    const statusOrder =
      activeOrder || latestOrder;

    const reply = statusOrder
      ? getOrderStatusText(
          statusOrder.status
        )
      : "I don’t see an order for you yet. Tell me what you’d like to buy.";

    await saveMessage({
      customerId: customer.id,

      orderId:
        statusOrder?.id || null,

      phone: normalizedPhone,

      role: "assistant",

      message: reply,
    });

    await sendWhatsAppMessage(
      normalizedPhone,
      reply
    );

    return;
  }

  /* CANCEL */

  if (decision.intent === "cancel") {
    if (!activeOrder) {
      const reply =
        "There isn’t an active order to cancel.";

      await saveMessage({
        customerId: customer.id,

        phone: normalizedPhone,

        role: "assistant",

        message: reply,
      });

      await sendWhatsAppMessage(
        normalizedPhone,
        reply
      );

      return;
    }

    await updateOrder(activeOrder.id, {
      status: "cancelled",
    });

    const reply =
      "Done — I’ve cancelled your order.";

    await saveMessage({
      customerId: customer.id,

      orderId: activeOrder.id,

      phone: normalizedPhone,

      role: "assistant",

      message: reply,
    });

    await sendWhatsAppMessage(
      normalizedPhone,
      reply
    );

    return;
  }

  /* REJECT */

  if (decision.intent === "reject") {
    if (
      activeOrder?.status ===
      "awaiting_confirmation"
    ) {
      await updateOrder(activeOrder.id, {
        status: "cancelled",
      });
    }

    const reply =
      decision.reply ||
      "Okay — I won’t place that order.";

    await saveMessage({
      customerId: customer.id,

      orderId:
        activeOrder?.id || null,

      phone: normalizedPhone,

      role: "assistant",

      message: reply,
    });

    await sendWhatsAppMessage(
      normalizedPhone,
      reply
    );

    return;
  }

  /* CONFIRM */

  if (decision.intent === "confirm") {
    if (
      !activeOrder ||
      activeOrder.status !==
        "awaiting_confirmation"
    ) {
      const reply =
        "I don’t have an order waiting for confirmation. Tell me what you’d like to fetch.";

      await saveMessage({
        customerId: customer.id,

        phone: normalizedPhone,

        role: "assistant",

        message: reply,
      });

      await sendWhatsAppMessage(
        normalizedPhone,
        reply
      );

      return;
    }

    order = await updateOrder(
      activeOrder.id,
      {
        status: "finding_shopper",
      }
    );

    const confirmReply =
      "Confirmed 👍 I’m finding a shopper for your order now.";

    await saveMessage({
      customerId: customer.id,

      orderId: order.id,

      phone: normalizedPhone,

      role: "assistant",

      message: confirmReply,
    });

    await sendWhatsAppMessage(
      normalizedPhone,
      confirmReply
    );

    const dispatch =
      await offerOrderToShopper(order);

    if (dispatch.success) {
      const reply =
        "🛍️ I’ve sent your order to an available shopper.\n\nI’ll let you know as soon as someone accepts it.";

      await saveMessage({
        customerId: customer.id,

        orderId: order.id,

        phone: normalizedPhone,

        role: "assistant",

        message: reply,
      });

      await sendWhatsAppMessage(
        normalizedPhone,
        reply
      );
    } else {
      const reply =
        "Your order is confirmed, but I couldn’t find an available shopper right now. I’ll keep it in the queue.";

      await saveMessage({
        customerId: customer.id,

        orderId: order.id,

        phone: normalizedPhone,

        role: "assistant",

        message: reply,
      });

      await sendWhatsAppMessage(
        normalizedPhone,
        reply
      );
    }

    return;
  }

  /* SHOPPING REQUEST */

  if (
    decision.intent ===
    "shopping_request"
  ) {
    const storeName =
      decision.store_name?.trim();

    const items =
      decision.items?.trim();

    const deliveryAddress = (
      decision.delivery_address ||
      customer.address ||
      ""
    ).trim();

    if (
      !storeName ||
      !items ||
      !deliveryAddress
    ) {
      const reply =
        decision.reply ||
        "Sure. Tell me the items, the store, and the delivery location.";

      await saveMessage({
        customerId: customer.id,

        orderId:
          activeOrder?.id ||
          null,

        phone: normalizedPhone,

        role: "assistant",

        message: reply,
      });

      await sendWhatsAppMessage(
        normalizedPhone,
        reply
      );

      return;
    }

    await updateCustomerAddress(
      customer.id,
      deliveryAddress
    );

    if (
      activeOrder &&
      [
        "collecting_details",
        "awaiting_confirmation",
      ].includes(activeOrder.status)
    ) {
      order = await updateOrder(
        activeOrder.id,
        {
          store_name: storeName,

          items,

          budget:
            decision.budget ??
            activeOrder.budget ??
            null,

          delivery_address:
            deliveryAddress,

          status:
            "awaiting_confirmation",
        }
      );
    } else {
      order = await createOrder({
        customerId: customer.id,

        storeName,

        items,

        budget:
          decision.budget ?? null,

        deliveryAddress,

        status:
          "awaiting_confirmation",
      });
    }

    const reply =
      decision.reply &&
      decision.reply.trim()
        ? decision.reply.trim()
        : `Sure – ${items} from ${storeName}, delivered to ${deliveryAddress}. Shall I place this order?`;

    await saveMessage({
      customerId: customer.id,

      orderId: order.id,

      phone: normalizedPhone,

      role: "assistant",

      message: reply,
    });

    await sendWhatsAppMessage(
      normalizedPhone,
      reply
    );

    return;
  }

  /* UPDATE ORDER */

  if (
    decision.intent ===
      "update_order" &&
    activeOrder
  ) {
    const updates = {};

    if (decision.store_name?.trim()) {
      updates.store_name =
        decision.store_name.trim();
    }

    if (decision.items?.trim()) {
      updates.items =
        decision.items.trim();
    }

    if (
      decision.delivery_address?.trim()
    ) {
      updates.delivery_address =
        decision.delivery_address.trim();

      await updateCustomerAddress(
        customer.id,
        updates.delivery_address
      );
    }

    if (decision.budget != null) {
      updates.budget =
        decision.budget;
    }

    updates.status =
      "awaiting_confirmation";

    order = await updateOrder(
      activeOrder.id,
      updates
    );

    const reply =
      decision.reply ||
      "Updated your order. Shall I place it?";

    await saveMessage({
      customerId: customer.id,

      orderId: order.id,

      phone: normalizedPhone,

      role: "assistant",

      message: reply,
    });

    await sendWhatsAppMessage(
      normalizedPhone,
      reply
    );

    return;
  }

  /* DEFAULT */

  const reply =
    decision.reply ||
    "Hi! I’m Fetch. Tell me what you’d like me to buy, which store, and where to deliver it.";

  await saveMessage({
    customerId: customer.id,

    orderId:
      activeOrder?.id ||
      null,

    phone: normalizedPhone,

    role: "assistant",

    message: reply,
  });

  await sendWhatsAppMessage(
    normalizedPhone,
    reply
  );
}

/* CUSTOMER NOTIFICATION */

async function notifyCustomerForOrder(
  orderId,
  message
) {
  const order =
    await getOrderById(orderId);

  if (!order?.customer_id) {
    return;
  }

  const customer =
    await supabaseRequest(
      `customers?id=eq.${encodeURIComponent(
        order.customer_id
      )}&select=*&limit=1`
    );

  const customerRow =
    Array.isArray(customer) &&
    customer.length
      ? customer[0]
      : null;

  if (!customerRow?.phone) {
    return;
  }

  await saveMessage({
    customerId:
      customerRow.id,

    orderId,

    phone:
      customerRow.phone,

    role: "assistant",

    message,
  });

  await sendWhatsAppMessage(
    customerRow.phone,
    message
  );
}

/* SHOPPER ENGINE */

async function handleShopperMessage({
  phone,
  text,
}) {
  const normalizedPhone =
    normalizePhone(phone);

  const command =
    String(text || "")
      .trim()
      .toUpperCase();

  let shopper =
    await getShopperByPhone(
      normalizedPhone
    );

  /* START / JOIN */

  if (
    command === "START" ||
    command === "JOIN"
  ) {
    if (!shopper) {
      shopper =
        await getOrCreateShopper(
          normalizedPhone
        );
    } else {
      await updateShopper(
        shopper.id,
        {
          available: true,

          whatsapp_opted_in:
            true,

          last_seen_at:
            new Date().toISOString(),
        }
      );
    }

    await sendWhatsAppMessage(
      normalizedPhone,
      `Welcome to Fetch Shopper 🛍️\n\nYou’re now active. I’ll send you nearby Fetch jobs here.\n\nCommands:\nACCEPT\nDECLINE\nSHOPPING\nPICKED UP\nOUT FOR DELIVERY\nDELIVERED\nSTATUS`
    );

    return;
  }

  if (!shopper) {
    await sendWhatsAppMessage(
      normalizedPhone,
      "You’re not registered as a Fetch shopper yet. Reply START to join."
    );

    return;
  }

  await updateShopper(
    shopper.id,
    {
      last_seen_at:
        new Date().toISOString(),
    }
  );

  /* ACCEPT */

  if (command === "ACCEPT") {
    const job =
      await getOpenShopperJob(
        shopper.id
      );

    if (!job) {
      await sendWhatsAppMessage(
        normalizedPhone,
        "You don’t have a new Fetch job waiting right now."
      );

      return;
    }

    const order =
      await getOrderById(
        job.order_id
      );

    if (!order) {
      await updateShopperJob(
        job.id,
        {
          status: "declined",
        }
      );

      await sendWhatsAppMessage(
        normalizedPhone,
        "That Fetch job is no longer available."
      );

      return;
    }

    await updateShopperJob(
      job.id,
      {
        status: "accepted",

        accepted_at:
          new Date().toISOString(),
      }
    );

    await updateOrder(
      order.id,
      {
        shopper_id:
          shopper.id,

        status:
          "shopper_assigned",
      }
    );

    await updateShopper(
      shopper.id,
      {
        available: false,

        current_order_id:
          order.id,

        last_seen_at:
          new Date().toISOString(),
      }
    );

    await sendWhatsAppMessage(
      normalizedPhone,
      "Accepted ✅\n\nReply SHOPPING when you start shopping."
    );

    await notifyCustomerForOrder(
      order.id,
      "✅ A Fetch shopper has accepted your order. They’ll start shopping soon."
    );

    return;
  }

  /* DECLINE */

  if (command === "DECLINE") {
    const job =
      await getOpenShopperJob(
        shopper.id
      );

    if (!job) {
      await sendWhatsAppMessage(
        normalizedPhone,
        "You don’t have a new Fetch job waiting right now."
      );

      return;
    }

    const order =
      await getOrderById(
        job.order_id
      );

    await updateShopperJob(
      job.id,
      {
        status: "declined",
      }
    );

    await sendWhatsAppMessage(
      normalizedPhone,
      "Declined. 👍"
    );

    if (order) {
      await updateOrder(
        order.id,
        {
          status:
            "finding_shopper",

          shopper_id: null,
        }
      );

      await offerOrderToShopper(
        order,
        [shopper.id]
      );
    }

    return;
  }

  /* STATUS */

  if (command === "STATUS") {
    if (!shopper.current_order_id) {
      await sendWhatsAppMessage(
        normalizedPhone,
        "You don’t have an active Fetch order."
      );

      return;
    }

    const order =
      await getOrderById(
        shopper.current_order_id
      );

    await sendWhatsAppMessage(
      normalizedPhone,
      order
        ? getOrderStatusText(
            order.status
          )
        : "I couldn’t find your active Fetch order."
    );

    return;
  }

  const job =
    await getAcceptedShopperJob(
      shopper.id
    );

  if (!job) {
    await sendWhatsAppMessage(
      normalizedPhone,
      "You don’t have an accepted Fetch job. Reply START to activate your shopper account."
    );

    return;
  }

  const order =
    await getOrderById(
      job.order_id
    );

  if (!order) {
    await sendWhatsAppMessage(
      normalizedPhone,
      "I couldn’t find the order linked to your job."
    );

    return;
  }

  /* SHOPPING */

  if (
    command === "SHOPPING" ||
    command === "START SHOPPING"
  ) {
    await updateOrder(
      order.id,
      {
        status: "shopping",
      }
    );

    await sendWhatsAppMessage(
      normalizedPhone,
      "Shopping started 🛒"
    );

    await notifyCustomerForOrder(
      order.id,
      "🛒 Your Fetch shopper has started shopping for your order."
    );

    return;
  }

  /* PICKED UP */

  if (
    command === "PICKED UP" ||
    command === "PICKEDUP" ||
    command === "PICKED"
  ) {
    await updateOrder(
      order.id,
      {
        status: "picked_up",
      }
    );

    await sendWhatsAppMessage(
      normalizedPhone,
      "Items picked up ✅\n\nReply OUT FOR DELIVERY when you’re on the way."
    );

    await notifyCustomerForOrder(
      order.id,
      "📦 Your Fetch shopper has picked up your items."
    );

    return;
  }

  /* OUT FOR DELIVERY */

  if (
    command ===
      "OUT FOR DELIVERY"
  ) {
    await updateOrder(
      order.id,
      {
        status:
          "out_for_delivery",
      }
    );

    await sendWhatsAppMessage(
      normalizedPhone,
      "Out for delivery 🚴"
    );

    await notifyCustomerForOrder(
      order.id,
      "🚴 Your Fetch order is on the way."
    );

    return;
  }

  /* DELIVERED */

  if (
    command === "DELIVERED" ||
    command === "DELIVERED DONE"
  ) {
    await updateOrder(
      order.id,
      {
        status: "delivered",
      }
    );

    await updateShopperJob(
      job.id,
      {
        status: "completed",

        completed_at:
          new Date().toISOString(),
      }
    );

    await updateShopper(
      shopper.id,
      {
        available: true,

        current_order_id:
          null,

        last_seen_at:
          new Date().toISOString(),
      }
    );

    await sendWhatsAppMessage(
      normalizedPhone,
      "Delivered 🎉\n\nYou’re available for the next Fetch job."
    );

    await notifyCustomerForOrder(
      order.id,
      "🎉 Your Fetch order has been delivered. Enjoy!"
    );

    return;
  }

  await sendWhatsAppMessage(
    normalizedPhone,
    "I didn’t recognise that command. Use ACCEPT, DECLINE, SHOPPING, PICKED UP, OUT FOR DELIVERY, DELIVERED or STATUS."
  );
}

/* WHATSAPP MESSAGE EXTRACTION */

function extractIncomingWhatsAppMessage(
  body
) {
  const value =
    body?.entry?.[0]?.changes?.[0]
      ?.value;

  const message =
    value?.messages?.[0];

  if (!message) {
    return null;
  }

  return {
    from: normalizePhone(
      message.from
    ),

    text:
      message?.text?.body?.trim() ||
      "",

    messageId:
      message.id || null,

    type:
      message.type || null,
  };
}

/* VERCEL NODE HANDLER */

export default async function handler(
  req,
  res
) {
  try {
    /* META WEBHOOK VERIFICATION */

    if (req.method === "GET") {
      const url = new URL(
        req.url,
        `https://${
          req.headers.host ||
          "localhost"
        }`
      );

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
        token ===
          WHATSAPP_VERIFY_TOKEN
      ) {
        return res
          .status(200)
          .send(challenge || "");
      }

      return res
        .status(403)
        .send("Forbidden");
    }

    if (req.method !== "POST") {
      return res
        .status(405)
        .send("Method Not Allowed");
    }

    let body = req.body;

    /* Vercel may already parse JSON. */

    if (typeof body === "string") {
      body = JSON.parse(body);
    }

    /* If body is still unavailable, read stream. */

    if (
      !body ||
      typeof body !== "object"
    ) {
      const chunks = [];

      for await (
        const chunk of req
      ) {
        chunks.push(
          Buffer.from(chunk)
        );
      }

      const raw =
        Buffer.concat(chunks)
          .toString("utf8");

      body = raw
        ? JSON.parse(raw)
        : {};
    }

    console.log(
      "FETCH WEBHOOK RECEIVED:",
      JSON.stringify(
        body,
        null,
        2
      )
    );

    const incoming =
      extractIncomingWhatsAppMessage(
        body
      );

    if (
      !incoming ||
      !incoming.from ||
      !incoming.text
    ) {
      return res
        .status(200)
        .json({
          success: true,
          ignored: true,
        });
    }

    const {
      from,
      text,
    } = incoming;

    console.log(
      "FETCH INCOMING:",
      JSON.stringify({
        from,
        text,
      })
    );

    const shopper =
      await getShopperByPhone(
        from
      );

    const command =
      text
        .trim()
        .toUpperCase();

    const isShopperCommand =
      [
        "START",
        "JOIN",
        "ACCEPT",
        "DECLINE",
        "SHOPPING",
        "START SHOPPING",
        "PICKED UP",
        "PICKEDUP",
        "PICKED",
        "OUT FOR DELIVERY",
        "DELIVERED",
        "DELIVERED DONE",
        "STATUS",
      ].includes(command);

    if (
      shopper ||
      isShopperCommand
    ) {
      await handleShopperMessage({
        phone: from,
        text,
      });
    } else {
      await handleCustomerMessage({
        phone: from,
        userMessage: text,
      });
    }

    return res
      .status(200)
      .json({
        success: true,
      });
  } catch (error) {
    console.error(
      "FETCH WEBHOOK ERROR:",
      error
    );

    /* Always acknowledge Meta. */

    return res
      .status(200)
      .json({
        success: false,
      });
  }
}
