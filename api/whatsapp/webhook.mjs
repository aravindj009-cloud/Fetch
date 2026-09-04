const SUPABASE_URL =
  process.env.VITE_SUPABASE_URL ||
  "https://skfxzagxlxputwpwxwbe.supabase.co";

const SUPABASE_KEY =
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

const WHATSAPP_ACCESS_TOKEN =
  process.env.WHATSAPP_ACCESS_TOKEN;

const WHATSAPP_PHONE_NUMBER_ID =
  process.env.WHATSAPP_PHONE_NUMBER_ID;

const WHATSAPP_VERIFY_TOKEN =
  process.env.WHATSAPP_VERIFY_TOKEN;

const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY;

const OPENAI_MODEL =
  "gpt-5.6-luna";

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
  return phone
    ? String(phone).replace(/[^\d]/g, "")
    : "";
}

async function supabaseRequest(path, options = {}) {
  if (!SUPABASE_KEY) {
    throw new Error(
      "VITE_SUPABASE_PUBLISHABLE_KEY is missing"
    );
  }

  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/${path}`,
    {
      ...options,
      headers: {
        apikey: SUPABASE_KEY,
        Authorization:
          `Bearer ${SUPABASE_KEY}`,
        "Content-Type":
          "application/json",
        ...(options.headers || {}),
      },
    }
  );

  const raw =
    await response.text();

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
        typeof data === "string"
          ? data
          : JSON.stringify(data)
      }`
    );
  }

  return data;
}

async function sendWhatsAppMessage(
  to,
  message
) {
  if (
    !WHATSAPP_ACCESS_TOKEN ||
    !WHATSAPP_PHONE_NUMBER_ID
  ) {
    throw new Error(
      "WhatsApp environment variables are missing"
    );
  }

  const normalizedTo =
    normalizePhone(to);

  console.log(
    "FETCH WHATSAPP SEND:",
    JSON.stringify({
      to: normalizedTo,
      message,
    })
  );

  const response =
    await fetch(
      `https://graph.facebook.com/v26.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization:
            `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
          "Content-Type":
            "application/json",
        },
        body: JSON.stringify({
          messaging_product:
            "whatsapp",
          recipient_type:
            "individual",
          to: normalizedTo,
          type: "text",
          text: {
            preview_url: false,
            body: message,
          },
        }),
      }
    );

  const data =
    await response.json();

  if (!response.ok) {
    throw new Error(
      `WhatsApp ${response.status}: ${JSON.stringify(
        data
      )}`
    );
  }

  console.log(
    "FETCH WHATSAPP API RESPONSE:",
    JSON.stringify(data)
  );

  return data;
}

/* =========================================================
   CUSTOMER
========================================================= */

async function getCustomer(phone) {
  const normalizedPhone =
    normalizePhone(phone);

  const data =
    await supabaseRequest(
      `customers?phone=eq.${encodeURIComponent(
        normalizedPhone
      )}&select=*&limit=1`
    );

  return Array.isArray(data) &&
    data.length
    ? data[0]
    : null;
}

async function getOrCreateCustomer(
  phone
) {
  const normalizedPhone =
    normalizePhone(phone);

  let customer =
    await getCustomer(
      normalizedPhone
    );

  if (customer) {
    return customer;
  }

  try {
    const data =
      await supabaseRequest(
        "customers",
        {
          method: "POST",
          headers: {
            Prefer:
              "return=representation",
          },
          body: JSON.stringify({
            phone:
              normalizedPhone,
          }),
        }
      );

    return Array.isArray(data)
      ? data[0]
      : data;
  } catch (error) {
    customer =
      await getCustomer(
        normalizedPhone
      );

    if (customer) {
      return customer;
    }

    throw error;
  }
}

async function updateCustomerAddress(
  customerId,
  address
) {
  if (!address) return;

  await supabaseRequest(
    `customers?id=eq.${encodeURIComponent(
      customerId
    )}`,
    {
      method: "PATCH",
      headers: {
        Prefer:
          "return=minimal",
      },
      body: JSON.stringify({
        address,
      }),
    }
  );
}

/* =========================================================
   SHOPPERS
========================================================= */

async function getShopperByPhone(
  phone
) {
  const normalizedPhone =
    normalizePhone(phone);

  const data =
    await supabaseRequest(
      `shoppers?phone=eq.${encodeURIComponent(
        normalizedPhone
      )}&select=*&limit=1`
    );

  return Array.isArray(data) &&
    data.length
    ? data[0]
    : null;
}

async function createShopper(
  phone
) {
  const normalizedPhone =
    normalizePhone(phone);

  const data =
    await supabaseRequest(
      "shoppers",
      {
        method: "POST",
        headers: {
          Prefer:
            "return=representation",
        },
        body: JSON.stringify({
          name:
            `Fetch Shopper ${normalizedPhone.slice(
              -4
            )}`,
          phone:
            normalizedPhone,
          available:
            true,
          whatsapp_opted_in:
            true,
          last_seen_at:
            new Date().toISOString(),
        }),
      }
    );

  return Array.isArray(data)
    ? data[0]
    : data;
}

async function getOrCreateShopper(
  phone
) {
  let shopper =
    await getShopperByPhone(
      phone
    );

  if (shopper) {
    return shopper;
  }

  try {
    return await createShopper(
      phone
    );
  } catch (error) {
    shopper =
      await getShopperByPhone(
        phone
      );

    if (shopper) {
      return shopper;
    }

    throw error;
  }
}

async function updateShopper(
  shopperId,
  updates
) {
  const data =
    await supabaseRequest(
      `shoppers?id=eq.${encodeURIComponent(
        shopperId
      )}`,
      {
        method: "PATCH",
        headers: {
          Prefer:
            "return=representation",
        },
        body: JSON.stringify(
          updates
        ),
      }
    );

  return Array.isArray(data) &&
    data.length
    ? data[0]
    : null;
}

/* =========================================================
   ORDERS
========================================================= */

async function getActiveOrder(
  customerId
) {
  const statuses =
    ACTIVE_ORDER_STATUSES.join(",");

  const data =
    await supabaseRequest(
      `orders?customer_id=eq.${encodeURIComponent(
        customerId
      )}&status=in.(${encodeURIComponent(
        statuses
      )})&select=*&order=created_at.desc&limit=1`
    );

  return Array.isArray(data) &&
    data.length
    ? data[0]
    : null;
}

async function getLatestOrder(
  customerId
) {
  const data =
    await supabaseRequest(
      `orders?customer_id=eq.${encodeURIComponent(
        customerId
      )}&select=*&order=created_at.desc&limit=1`
    );

  return Array.isArray(data) &&
    data.length
    ? data[0]
    : null;
}

async function getOrderById(
  orderId
) {
  const data =
    await supabaseRequest(
      `orders?id=eq.${encodeURIComponent(
        orderId
      )}&select=*&limit=1`
    );

  return Array.isArray(data) &&
    data.length
    ? data[0]
    : null;
}

async function createOrder({
  customerId,
  storeName,
  items,
  budget,
  deliveryAddress,
  status,
}) {
  const data =
    await supabaseRequest(
      "orders",
      {
        method: "POST",
        headers: {
          Prefer:
            "return=representation",
        },
        body: JSON.stringify({
          customer_id:
            customerId,
          store_name:
            storeName,
          items,
          budget:
            budget ?? null,
          delivery_address:
            deliveryAddress,
          status,
        }),
      }
    );

  return Array.isArray(data)
    ? data[0]
    : data;
}

async function updateOrder(
  orderId,
  updates
) {
  const data =
    await supabaseRequest(
      `orders?id=eq.${encodeURIComponent(
        orderId
      )}`,
      {
        method: "PATCH",
        headers: {
          Prefer:
            "return=representation",
        },
        body: JSON.stringify(
          updates
        ),
      }
    );

  return Array.isArray(data) &&
    data.length
    ? data[0]
    : null;
}

/* =========================================================
   MESSAGES
========================================================= */

async function getRecentMessages(
  customerId
) {
  try {
    const data =
      await supabaseRequest(
        `messages?customer_id=eq.${encodeURIComponent(
          customerId
        )}&select=role,message,created_at&order=created_at.desc&limit=12`
      );

    return Array.isArray(data)
      ? data.reverse()
      : [];
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
    await supabaseRequest(
      "messages",
      {
        method: "POST",
        headers: {
          Prefer:
            "return=minimal",
        },
        body: JSON.stringify({
          customer_id:
            customerId,
          order_id:
            orderId,
          phone:
            normalizePhone(phone),
          role,
          message,
        }),
      }
    );
  } catch (error) {
    console.error(
      "FETCH SAVE MESSAGE ERROR:",
      error
    );
  }
}

/* =========================================================
   SHOPPER JOBS
========================================================= */

async function getOpenShopperJob(
  shopperId
) {
  const data =
    await supabaseRequest(
      `shopper_jobs?shopper_id=eq.${encodeURIComponent(
        shopperId
      )}&status=eq.offered&select=*&order=offered_at.desc&limit=1`
    );

  return Array.isArray(data) &&
    data.length
    ? data[0]
    : null;
}

async function getAcceptedShopperJob(
  shopperId
) {
  const data =
    await supabaseRequest(
      `shopper_jobs?shopper_id=eq.${encodeURIComponent(
        shopperId
      )}&status=eq.accepted&select=*&order=accepted_at.desc&limit=1`
    );

  return Array.isArray(data) &&
    data.length
    ? data[0]
    : null;
}

async function createShopperJob(
  orderId,
  shopperId
) {
  const data =
    await supabaseRequest(
      "shopper_jobs",
      {
        method: "POST",
        headers: {
          Prefer:
            "return=representation",
        },
        body: JSON.stringify({
          order_id:
            orderId,
          shopper_id:
            shopperId,
          status:
            "offered",
          offered_at:
            new Date().toISOString(),
        }),
      }
    );

  return Array.isArray(data)
    ? data[0]
    : data;
}

async function updateShopperJob(
  jobId,
  updates
) {
  const data =
    await supabaseRequest(
      `shopper_jobs?id=eq.${encodeURIComponent(
        jobId
      )}`,
      {
        method: "PATCH",
        headers: {
          Prefer:
            "return=representation",
        },
        body: JSON.stringify(
          updates
        ),
      }
    );

  return Array.isArray(data) &&
    data.length
    ? data[0]
    : null;
}

async function getAvailableShoppers(
  excludedIds = []
) {
  const data =
    await supabaseRequest(
      "shoppers?available=eq.true&whatsapp_opted_in=eq.true&select=*&limit=100"
    );

  if (!Array.isArray(data)) {
    return [];
  }

  return data.filter(
    (shopper) =>
      !excludedIds.includes(
        shopper.id
      ) &&
      !shopper.current_order_id
  );
}

async function offerOrderToShopper(
  order,
  excludedIds = []
) {
  const shoppers =
    await getAvailableShoppers(
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
      const existing =
        await supabaseRequest(
          `shopper_jobs?order_id=eq.${encodeURIComponent(
            order.id
          )}&shopper_id=eq.${encodeURIComponent(
            shopper.id
          )}&status=eq.offered&select=*&limit=1`
        );

      const job =
        Array.isArray(existing) &&
        existing.length
          ? existing[0]
          : await createShopperJob(
              order.id,
              shopper.id
            );

      const message =
        `🛍️ *New Fetch Job*\n\n` +
        `🏪 Store: ${order.store_name}\n` +
        `🛒 Items: ${order.items}\n` +
        `📍 Deliver to: ${order.delivery_address}\n` +
        (
          order.budget != null
            ? `💰 Budget: ₹${order.budget}\n`
            : ""
        ) +
        `\nReply *ACCEPT* to take this job.\n` +
        `Reply *DECLINE* to skip it.`;

      await sendWhatsAppMessage(
        shopper.phone,
        message
      );

      await updateOrder(
        order.id,
        {
          status:
            "finding_shopper",
          shopper_id:
            null,
        }
      );

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

/* =========================================================
   STATUS
========================================================= */

function getOrderStatusText(
  status
) {
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

/* =========================================================
   SUBSTITUTIONS
========================================================= */

async function getPendingSubstitution(
  orderId
) {
  const data =
    await supabaseRequest(
      `substitution_requests?order_id=eq.${encodeURIComponent(
        orderId
      )}&status=eq.pending&select=*&order=created_at.desc&limit=1`
    );

  return Array.isArray(data) &&
    data.length
    ? data[0]
    : null;
}

async function createSubstitutionRequest({
  orderId,
  shopperId,
  originalItem,
  proposedItem,
}) {
  const data =
    await supabaseRequest(
      "substitution_requests",
      {
        method: "POST",
        headers: {
          Prefer:
            "return=representation",
        },
        body: JSON.stringify({
          order_id:
            orderId,
          shopper_id:
            shopperId,
          original_item:
            originalItem,
          proposed_item:
            proposedItem,
          status:
            "pending",
        }),
      }
    );

  return Array.isArray(data)
    ? data[0]
    : data;
}

async function updateSubstitutionRequest(
  id,
  updates
) {
  const data =
    await supabaseRequest(
      `substitution_requests?id=eq.${encodeURIComponent(
        id
      )}`,
      {
        method: "PATCH",
        headers: {
          Prefer:
            "return=representation",
        },
        body: JSON.stringify(
          updates
        ),
      }
    );

  return Array.isArray(data) &&
    data.length
    ? data[0]
    : null;
}

function parseSubstitutionCommand(
  text
) {
  const raw =
    String(text || "").trim();

  const match =
    raw.match(
      /^SUBSTITUTE\s*:?\s*(.+?)\s*(?:->|=>|WITH|TO)\s*(.+)$/i
    );

  if (!match) {
    return null;
  }

  return {
    originalItem:
      match[1].trim(),
    proposedItem:
      match[2].trim(),
  };
}

async function applyApprovedSubstitution(
  order,
  substitution
) {
  const original =
    substitution.original_item.trim();

  const proposed =
    substitution.proposed_item.trim();

  const currentItems =
    String(
      order.items || ""
    ).trim();

  const escaped =
    original.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&"
    );

  const regex =
    new RegExp(
      escaped,
      "i"
    );

  let updatedItems;

  if (regex.test(currentItems)) {
    updatedItems =
      currentItems.replace(
        regex,
        `${proposed} (substituted for ${original})`
      );
  } else {
    updatedItems =
      `${currentItems}; ${proposed} (substituted for ${original})`;
  }

  return updateOrder(
    order.id,
    {
      items:
        updatedItems,
    }
  );
}

/* =========================================================
   CUSTOMER NOTIFICATION
========================================================= */

async function notifyCustomerForOrder(
  orderId,
  message
) {
  const order =
    await getOrderById(
      orderId
    );

  if (!order?.customer_id) {
    return;
  }

  const customers =
    await supabaseRequest(
      `customers?id=eq.${encodeURIComponent(
        order.customer_id
      )}&select=*&limit=1`
    );

  const customer =
    Array.isArray(customers) &&
    customers.length
      ? customers[0]
      : null;

  if (!customer?.phone) {
    return;
  }

  await saveMessage({
    customerId:
      customer.id,
    orderId,
    phone:
      customer.phone,
    role:
      "assistant",
    message,
  });

  await sendWhatsAppMessage(
    customer.phone,
    message
  );
}

/* =========================================================
   OPENAI
========================================================= */

function extractResponseText(
  data
) {
  if (
    typeof data?.output_text ===
      "string" &&
    data.output_text.trim()
  ) {
    return data.output_text.trim();
  }

  const parts = [];

  for (
    const item of
      data?.output || []
  ) {
    for (
      const content of
        item?.content || []
    ) {
      if (
        typeof content?.text ===
        "string"
      ) {
        parts.push(
          content.text
        );
      }
    }
  }

  return parts.join("\n").trim();
}

function cleanJsonText(
  text
) {
  return String(text || "")
    .trim()
    .replace(
      /^```json/i,
      ""
    )
    .replace(
      /^```/i,
      ""
    )
    .replace(
      /```$/i,
      ""
    )
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
    throw new Error(
      "OPENAI_API_KEY is missing"
    );
  }

  const systemPrompt = `
You are Fetch, a friendly AI shopping agent operating through WhatsApp in India.

Understand English, Malayalam, Manglish, Hindi, Tamil, Telugu, Kannada, mixed languages, typos, slang and short messages.

Examples:
"vere nthoke und?" = what else is there
"add 10 eggs" = add 10 eggs to current order
"where is my order?" = order status
"cancel it" = cancel
"yes", "ya", "yep", "okay", "go ahead" = confirmation when appropriate
"no", "nope" = rejection when appropriate

Rules:
1. Never invent a store, item, address or price.
2. Keep WhatsApp replies concise and natural.
3. If store, items and delivery address are available, prepare the order.
4. Ask only for missing information.
5. If an active order exists, understand additions and changes.
6. "new order" means start a new shopping request.
7. Never claim a shopper accepted unless the system does so.
8. Never claim delivery unless the database status is delivered.
9. Match the customer's language/style where practical.
10. Return only the JSON requested.
`;

  const context = {
    customer: {
      name:
        customer?.name ||
        null,
      address:
        customer?.address ||
        null,
    },

    active_order:
      activeOrder || null,

    latest_order:
      latestOrder || null,

    conversation:
      history,

    current_message:
      userMessage,
  };

  const response =
    await fetch(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",

        headers: {
          Authorization:
            `Bearer ${OPENAI_API_KEY}`,
          "Content-Type":
            "application/json",
        },

        body: JSON.stringify({
          model:
            OPENAI_MODEL,

          input: [
            {
              role:
                "system",
              content: [
                {
                  type:
                    "input_text",
                  text:
                    systemPrompt,
                },
              ],
            },

            {
              role:
                "user",
              content: [
                {
                  type:
                    "input_text",
                  text:
                    JSON.stringify(
                      context
                    ),
                },
              ],
            },
          ],

          text: {
            format: {
              type:
                "json_schema",

              name:
                "fetch_agent_decision",

              strict:
                true,

              schema: {
                type:
                  "object",

                additionalProperties:
                  false,

                properties: {
                  intent: {
                    type:
                      "string",

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
                    type:
                      "string",
                  },

                  items: {
                    type:
                      "string",
                  },

                  delivery_address: {
                    type:
                      "string",
                  },

                  budget: {
                    type: [
                      "number",
                      "null",
                    ],
                  },

                  reply: {
                    type:
                      "string",
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

  const data =
    await response.json();

  if (!response.ok) {
    throw new Error(
      `OpenAI ${response.status}: ${JSON.stringify(
        data
      )}`
    );
  }

  const text =
    cleanJsonText(
      extractResponseText(
        data
      )
    );

  const decision =
    JSON.parse(text);

  console.log(
    "FETCH AI DECISION:",
    JSON.stringify(
      decision
    )
  );

  return decision;
}

/* =========================================================
   FALLBACK
========================================================= */

function fallbackDecision(
  userMessage,
  activeOrder,
  customer
) {
  const text =
    String(
      userMessage || ""
    ).trim();

  const lower =
    text.toLowerCase();

  const yes =
    /^(yes|y|yeah|yep|ya|ok|okay|sure|go ahead|confirm|confirmed)$/i.test(
      text
    );

  const no =
    /^(no|n|nope|cancel|don't|dont)$/i.test(
      text
    );

  if (
    yes &&
    activeOrder?.status ===
      "awaiting_confirmation"
  ) {
    return {
      intent:
        "confirm",

      store_name:
        activeOrder.store_name,

      items:
        activeOrder.items,

      delivery_address:
        activeOrder.delivery_address ||
        customer?.address ||
        "",

      budget:
        activeOrder.budget ??
        null,

      reply:
        "Confirmed 👍",
    };
  }

  if (
    no &&
    activeOrder
  ) {
    return {
      intent:
        "reject",

      store_name:
        activeOrder.store_name,

      items:
        activeOrder.items,

      delivery_address:
        activeOrder.delivery_address ||
        "",

      budget:
        activeOrder.budget ??
        null,

      reply:
        "Okay — I won’t place that order.",
    };
  }

  if (
    /where.*order|order.*where|status|track/i.test(
      lower
    )
  ) {
    return {
      intent:
        "status",

      store_name:
        "",

      items:
        "",

      delivery_address:
        "",

      budget:
        null,

      reply:
        "Let me check your order status.",
    };
  }

  return {
    intent:
      "general_question",

    store_name:
      "",

    items:
      "",

    delivery_address:
      "",

    budget:
      null,

    reply:
      "Tell me what you’d like me to fetch, which store, and where to deliver it.",
  };
}

/* =========================================================
   CUSTOMER ENGINE
========================================================= */

async function handleCustomerMessage({
  phone,
  userMessage,
}) {
  const normalizedPhone =
    normalizePhone(phone);

  const customer =
    await getOrCreateCustomer(
      normalizedPhone
    );

  const activeOrder =
    await getActiveOrder(
      customer.id
    );

  const latestOrder =
    await getLatestOrder(
      customer.id
    );

  const history =
    await getRecentMessages(
      customer.id
    );

  /*
    IMPORTANT:
    Handle a pending substitution BEFORE AI.
    Therefore YES/NO goes directly to the
    substitution request.
  */

  if (activeOrder) {
    const pending =
      await getPendingSubstitution(
        activeOrder.id
      );

    if (pending) {
      const answer =
        String(
          userMessage || ""
        ).trim();

      const approved =
        /^(yes|y|yeah|yep|ya|ok|okay|sure|approve|approved|go ahead|confirm|confirmed)$/i.test(
          answer
        );

      const rejected =
        /^(no|n|nope|reject|rejected|don't|dont|cancel)$/i.test(
          answer
        );

      if (
        approved ||
        rejected
      ) {
        if (approved) {
          await applyApprovedSubstitution(
            activeOrder,
            pending
          );

          await updateSubstitutionRequest(
            pending.id,
            {
              status:
                "approved",

              customer_response:
                userMessage,

              resolved_at:
                new Date().toISOString(),
            }
          );

          const reply =
            `Done 👍 I’ve approved the substitution to ${pending.proposed_item}.`;

          await saveMessage({
            customerId:
              customer.id,

            orderId:
              activeOrder.id,

            phone:
              normalizedPhone,

            role:
              "assistant",

            message:
              reply,
          });

          await sendWhatsAppMessage(
            normalizedPhone,
            reply
          );

          if (
            pending.shopper_id
          ) {
            const shoppers =
              await supabaseRequest(
                `shoppers?id=eq.${encodeURIComponent(
                  pending.shopper_id
                )}&select=*&limit=1`
              );

            const shopper =
              Array.isArray(
                shoppers
              ) &&
              shoppers.length
                ? shoppers[0]
                : null;

            if (
              shopper?.phone
            ) {
              await sendWhatsAppMessage(
                shopper.phone,

                `✅ Customer approved the substitution.\n\nReplace ${pending.original_item} with ${pending.proposed_item}.`
              );
            }
          }
        } else {
          await updateSubstitutionRequest(
            pending.id,
            {
              status:
                "rejected",

              customer_response:
                userMessage,

              resolved_at:
                new Date().toISOString(),
            }
          );

          const reply =
            "No problem 👍 Please keep the original item if it’s available.";

          await saveMessage({
            customerId:
              customer.id,

            orderId:
              activeOrder.id,

            phone:
              normalizedPhone,

            role:
              "assistant",

            message:
              reply,
          });

          await sendWhatsAppMessage(
            normalizedPhone,
            reply
          );

          if (
            pending.shopper_id
          ) {
            const shoppers =
              await supabaseRequest(
                `shoppers?id=eq.${encodeURIComponent(
                  pending.shopper_id
                )}&select=*&limit=1`
              );

            const shopper =
              Array.isArray(
                shoppers
              ) &&
              shoppers.length
                ? shoppers[0]
                : null;

            if (
              shopper?.phone
            ) {
              await sendWhatsAppMessage(
                shopper.phone,

                `❌ Customer rejected the substitution.\n\nPlease keep ${pending.original_item} if it’s available.`
              );
            }
          }
        }

        await saveMessage({
          customerId:
            customer.id,

          orderId:
            activeOrder.id,

          phone:
            normalizedPhone,

          role:
            "user",

          message:
            userMessage,
        });

        return;
      }
    }
  }

  await saveMessage({
    customerId:
      customer.id,

    orderId:
      activeOrder?.id ||
      latestOrder?.id ||
      null,

    phone:
      normalizedPhone,

    role:
      "user",

    message:
      userMessage,
  });

  let decision;

  try {
    decision =
      await callFetchAI({
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

    decision =
      fallbackDecision(
        userMessage,
        activeOrder,
        customer
      );
  }

  if (
    decision.intent ===
    "status"
  ) {
    const order =
      activeOrder ||
      latestOrder;

    const reply =
      order
        ? getOrderStatusText(
            order.status
          )
        : "I don’t see an order for you yet. Tell me what you’d like to buy.";

    await saveMessage({
      customerId:
        customer.id,

      orderId:
        order?.id ||
        null,

      phone:
        normalizedPhone,

      role:
        "assistant",

      message:
        reply,
    });

    await sendWhatsAppMessage(
      normalizedPhone,
      reply
    );

    return;
  }

  if (
    decision.intent ===
    "cancel"
  ) {
    if (!activeOrder) {
      const reply =
        "There isn’t an active order to cancel.";

      await sendWhatsAppMessage(
        normalizedPhone,
        reply
      );

      return;
    }

    await updateOrder(
      activeOrder.id,
      {
        status:
          "cancelled",
      }
    );

    await sendWhatsAppMessage(
      normalizedPhone,
      "Done — I’ve cancelled your order."
    );

    return;
  }

  if (
    decision.intent ===
    "reject"
  ) {
    if (
      activeOrder?.status ===
      "awaiting_confirmation"
    ) {
      await updateOrder(
        activeOrder.id,
        {
          status:
            "cancelled",
        }
      );
    }

    await sendWhatsAppMessage(
      normalizedPhone,
      decision.reply ||
        "Okay — I won’t place that order."
    );

    return;
  }

  if (
    decision.intent ===
    "confirm"
  ) {
    if (
      !activeOrder ||
      activeOrder.status !==
        "awaiting_confirmation"
    ) {
      await sendWhatsAppMessage(
        normalizedPhone,

        "I don’t have an order waiting for confirmation. Tell me what you’d like to fetch."
      );

      return;
    }

    const order =
      await updateOrder(
        activeOrder.id,
        {
          status:
            "finding_shopper",
        }
      );

    await sendWhatsAppMessage(
      normalizedPhone,

      "Confirmed 👍 I’m finding a shopper for your order now."
    );

    const dispatch =
      await offerOrderToShopper(
        order
      );

    if (
      dispatch.success
    ) {
      await sendWhatsAppMessage(
        normalizedPhone,

        "🛍️ I’ve sent your order to an available shopper.\n\nI’ll let you know as soon as someone accepts it."
      );
    } else {
      await sendWhatsAppMessage(
        normalizedPhone,

        "Your order is confirmed, but I couldn’t find an available shopper right now. I’ll keep it in the queue."
      );
    }

    return;
  }

  if (
    decision.intent ===
    "shopping_request"
  ) {
    const store =
      decision.store_name?.trim();

    const items =
      decision.items?.trim();

    const address =
      (
        decision.delivery_address ||
        customer.address ||
        ""
      ).trim();

    if (
      !store ||
      !items ||
      !address
    ) {
      await sendWhatsAppMessage(
        normalizedPhone,

        decision.reply ||
          "Sure. Tell me the items, the store, and the delivery location."
      );

      return;
    }

    await updateCustomerAddress(
      customer.id,
      address
    );

    let order;

    if (
      activeOrder &&
      [
        "collecting_details",
        "awaiting_confirmation",
      ].includes(
        activeOrder.status
      )
    ) {
      order =
        await updateOrder(
          activeOrder.id,
          {
            store_name:
              store,

            items,

            budget:
              decision.budget ??
              activeOrder.budget ??
              null,

            delivery_address:
              address,

            status:
              "awaiting_confirmation",
          }
        );
    } else {
      order =
        await createOrder({
          customerId:
            customer.id,

          storeName:
            store,

          items,

          budget:
            decision.budget ??
            null,

          deliveryAddress:
            address,

          status:
            "awaiting_confirmation",
        });
    }

    const reply =
      decision.reply &&
      decision.reply.trim()
        ? decision.reply.trim()
        : `Sure – ${items} from ${store}, delivered to ${address}. Shall I place this order?`;

    await saveMessage({
      customerId:
        customer.id,

      orderId:
        order.id,

      phone:
        normalizedPhone,

      role:
        "assistant",

      message:
        reply,
    });

    await sendWhatsAppMessage(
      normalizedPhone,
      reply
    );

    return;
  }

  if (
    decision.intent ===
      "update_order" &&
    activeOrder
  ) {
    const updates = {};

    if (
      decision.store_name?.trim()
    ) {
      updates.store_name =
        decision.store_name.trim();
    }

    if (
      decision.items?.trim()
    ) {
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

    if (
      decision.budget != null
    ) {
      updates.budget =
        decision.budget;
    }

    updates.status =
      "awaiting_confirmation";

    const order =
      await updateOrder(
        activeOrder.id,
        updates
      );

    await sendWhatsAppMessage(
      normalizedPhone,

      decision.reply ||
        "Updated your order. Shall I place it?"
    );

    return;
  }

  await sendWhatsAppMessage(
    normalizedPhone,

    decision.reply ||
      "Hi! I’m Fetch. Tell me what you’d like me to buy, which store, and where to deliver it."
  );
}

/* =========================================================
   SHOPPER ENGINE
========================================================= */

async function handleShopperMessage({
  phone,
  text,
}) {
  const normalizedPhone =
    normalizePhone(phone);

  const rawText =
    String(text || "").trim();

  const command =
    rawText.toUpperCase();

  let shopper =
    await getShopperByPhone(
      normalizedPhone
    );

  /*
    ONLY START/JOIN can create a shopper.
  */

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
          available:
            true,

          whatsapp_opted_in:
            true,

          last_seen_at:
            new Date().toISOString(),
        }
      );
    }

    await sendWhatsAppMessage(
      normalizedPhone,

      `Welcome to Fetch Shopper 🛍️\n\nYou’re now active. I’ll send you Fetch jobs here.\n\nCommands:\nACCEPT\nDECLINE\nSHOPPING\nSUBSTITUTE: old item -> new item\nPICKED UP\nOUT FOR DELIVERY\nDELIVERED\nSTATUS`
    );

    return;
  }

  /*
    If the number isn't already a shopper,
    NEVER create one here.
  */

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

  if (
    command === "ACCEPT"
  ) {
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
          status:
            "declined",
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
        status:
          "accepted",

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
        available:
          false,

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

  if (
    command === "DECLINE"
  ) {
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
        status:
          "declined",
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

          shopper_id:
            null,
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

  if (
    command === "STATUS"
  ) {
    if (
      !shopper.current_order_id
    ) {
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

  /* =======================================================
     SUBSTITUTE
  ======================================================= */

  const substitution =
    parseSubstitutionCommand(
      rawText
    );

  if (substitution) {
    const pending =
      await getPendingSubstitution(
        order.id
      );

    if (pending) {
      await sendWhatsAppMessage(
        normalizedPhone,

        "There is already a substitution waiting for the customer’s response."
      );

      return;
    }

    await createSubstitutionRequest({
      orderId:
        order.id,

      shopperId:
        shopper.id,

      originalItem:
        substitution.originalItem,

      proposedItem:
        substitution.proposedItem,
    });

    await sendWhatsAppMessage(
      normalizedPhone,

      `📨 Substitution request sent.\n\n${substitution.originalItem} → ${substitution.proposedItem}\n\nI’ll tell you as soon as the customer responds.`
    );

    await notifyCustomerForOrder(
      order.id,

      `⚠️ Your Fetch shopper has a substitution request.\n\n${substitution.originalItem} is unavailable.\n\nThey propose: ${substitution.proposedItem}\n\nReply YES to approve or NO to reject.`
    );

    return;
  }

  /* SHOPPING */

  if (
    command === "SHOPPING" ||
    command ===
      "START SHOPPING"
  ) {
    await updateOrder(
      order.id,
      {
        status:
          "shopping",
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
        status:
          "picked_up",
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
    command ===
      "DELIVERED DONE"
  ) {
    await updateOrder(
      order.id,
      {
        status:
          "delivered",
      }
    );

    await updateShopperJob(
      job.id,
      {
        status:
          "completed",

        completed_at:
          new Date().toISOString(),
      }
    );

    await updateShopper(
      shopper.id,
      {
        available:
          true,

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

    "I didn’t recognise that command. Use ACCEPT, DECLINE, SHOPPING, SUBSTITUTE: old item -> new item, PICKED UP, OUT FOR DELIVERY, DELIVERED or STATUS."
  );
}

/* =========================================================
   WHATSAPP MESSAGE EXTRACTION
========================================================= */

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
    from:
      normalizePhone(
        message.from
      ),

    text:
      message?.text?.body?.trim() ||
      "",

    messageId:
      message.id ||
      null,

    type:
      message.type ||
      null,
  };
}

/* =========================================================
   VERCEL NODE HANDLER
========================================================= */

export default async function handler(
  req,
  res
) {
  try {
    /* META VERIFICATION */

    if (
      req.method === "GET"
    ) {
      const url =
        new URL(
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
          .send(
            challenge || ""
          );
      }

      return res
        .status(403)
        .send(
          "Forbidden"
        );
    }

    if (
      req.method !== "POST"
    ) {
      return res
        .status(405)
        .send(
          "Method Not Allowed"
        );
    }

    let body =
      req.body;

    if (
      typeof body ===
      "string"
    ) {
      body =
        JSON.parse(body);
    }

    if (
      !body ||
      typeof body !==
        "object"
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
        Buffer.concat(
          chunks
        ).toString(
          "utf8"
        );

      body =
        raw
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
          success:
            true,

          ignored:
            true,
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

    /*
      CRITICAL ROUTING RULE:

      Existing shopper -> shopper flow.

      START/JOIN -> may create shopper.

      Everything else from an unknown number
      -> customer.

      In particular:
      SUBSTITUTE can NEVER create a shopper.
    */

    const shopper =
      await getShopperByPhone(
        from
      );

    const command =
      text
        .trim()
        .toUpperCase();

    const isRegistrationCommand =
      command === "START" ||
      command === "JOIN";

    if (
      shopper ||
      isRegistrationCommand
    ) {
      await handleShopperMessage({
        phone:
          from,

        text,
      });
    } else {
      await handleCustomerMessage({
        phone:
          from,

        userMessage:
          text,
      });
    }

    return res
      .status(200)
      .json({
        success:
          true,
      });
  } catch (error) {
    console.error(
      "FETCH WEBHOOK ERROR:",
      error
    );

    /*
      Always return 200 to Meta so the same
      webhook event isn't repeatedly retried.
    */

    return res
      .status(200)
      .json({
        success:
          false,
      });
  }
}
