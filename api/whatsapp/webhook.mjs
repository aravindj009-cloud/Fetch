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


/* =========================================================
   ORDER STATUSES
========================================================= */

const ACTIVE_ORDER_STATUSES = [
  "collecting_details",
  "awaiting_confirmation",
  "finding_shopper",
  "shopper_assigned",
  "shopping",
  "picked_up",
  "out_for_delivery",
];

const PROCESSING_ORDER_STATUSES = [
  "finding_shopper",
  "shopper_assigned",
  "shopping",
  "picked_up",
  "out_for_delivery",
];


/* =========================================================
   BASIC RESPONSE HELPERS
========================================================= */

function jsonResponse(body, status = 200) {
  return new Response(
    JSON.stringify(body),
    {
      status,
      headers: {
        "Content-Type": "application/json",
      },
    }
  );
}


function textResponse(body, status = 200) {
  return new Response(
    String(body),
    {
      status,
      headers: {
        "Content-Type":
          "text/plain; charset=utf-8",
      },
    }
  );
}


/* =========================================================
   PHONE
========================================================= */

function normalizePhone(phone) {
  if (!phone) {
    return "";
  }

  return String(phone).replace(
    /[^\d]/g,
    ""
  );
}


/* =========================================================
   SUPABASE
========================================================= */

async function supabaseRequest(
  path,
  options = {}
) {
  if (!SUPABASE_KEY) {
    throw new Error(
      "VITE_SUPABASE_PUBLISHABLE_KEY is missing"
    );
  }

  const headers = {
    apikey: SUPABASE_KEY,
    Authorization:
      `Bearer ${SUPABASE_KEY}`,
    "Content-Type":
      "application/json",
    ...options.headers,
  };

  const response =
    await fetch(
      `${SUPABASE_URL}/rest/v1/${path}`,
      {
        ...options,
        headers,
      }
    );

  const text =
    await response.text();

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
        typeof data === "string"
          ? data
          : JSON.stringify(data)
      }`
    );
  }

  return data;
}


/* =========================================================
   WHATSAPP
========================================================= */

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
   CUSTOMERS
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
    data.length > 0
    ? data[0]
    : null;
}


async function getCustomerById(customerId) {
  if (!customerId) {
    return null;
  }

  const data =
    await supabaseRequest(
      `customers?id=eq.${encodeURIComponent(
        customerId
      )}&select=*&limit=1`
    );

  return Array.isArray(data) &&
    data.length > 0
    ? data[0]
    : null;
}


async function createCustomer(phone) {
  const normalizedPhone =
    normalizePhone(phone);

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
}


async function getOrCreateCustomer(phone) {
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
    return await createCustomer(
      normalizedPhone
    );
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
  if (!customerId || !address) {
    return;
  }

  try {
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
  } catch (error) {
    console.error(
      "FETCH ADDRESS UPDATE ERROR:",
      error
    );
  }
}


/* =========================================================
   SHOPPERS
========================================================= */

async function getShopperByPhone(phone) {
  const normalizedPhone =
    normalizePhone(phone);

  console.log(
    "FETCH SHOPPER LOOKUP:",
    normalizedPhone
  );

  const exact =
    await supabaseRequest(
      `shoppers?phone=eq.${encodeURIComponent(
        normalizedPhone
      )}&select=*&limit=1`
    );

  if (
    Array.isArray(exact) &&
    exact.length > 0
  ) {
    return exact[0];
  }

  const shoppers =
    await supabaseRequest(
      "shoppers?select=*&limit=100"
    );

  if (!Array.isArray(shoppers)) {
    return null;
  }

  return (
    shoppers.find(
      shopper =>
        normalizePhone(
          shopper.phone
        ) === normalizedPhone
    ) || null
  );
}


async function createShopper(phone) {
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

          available: true,

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


async function getOrCreateShopper(phone) {
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

        body:
          JSON.stringify(
            updates
          ),
      }
    );

  return Array.isArray(data) &&
    data.length > 0
    ? data[0]
    : null;
}


async function activateShopper(shopper) {
  return updateShopper(
    shopper.id,
    {
      available: true,
      whatsapp_opted_in: true,
      current_order_id: null,
      last_seen_at:
        new Date().toISOString(),
    }
  );
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
    data.length > 0
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
    data.length > 0
    ? data[0]
    : null;
}


async function getOrderById(orderId) {
  if (!orderId) {
    return null;
  }

  const data =
    await supabaseRequest(
      `orders?id=eq.${encodeURIComponent(
        orderId
      )}&select=*&limit=1`
    );

  return Array.isArray(data) &&
    data.length > 0
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

          budget,

          delivery_address:
            deliveryAddress,

          status,
        }),
      }
    );

  const order =
    Array.isArray(data)
      ? data[0]
      : data;

  console.log(
    "FETCH ORDER CREATED:",
    JSON.stringify(order)
  );

  return order;
}


async function updateOrder(
  orderId,
  updates
) {
  console.log(
    "FETCH ORDER UPDATE:",
    JSON.stringify({
      orderId,
      updates,
    })
  );

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

        body:
          JSON.stringify(
            updates
          ),
      }
    );

  return Array.isArray(data) &&
    data.length > 0
    ? data[0]
    : null;
}


/* =========================================================
   MESSAGES / MEMORY
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

    if (!Array.isArray(data)) {
      return [];
    }

    return data.reverse();
  } catch (error) {
    console.error(
      "FETCH MESSAGE HISTORY ERROR:",
      error
    );

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
            orderId || null,

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
    data.length > 0
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
    data.length > 0
    ? data[0]
    : null;
}


async function getShopperJobsForOrder(
  orderId
) {
  const data =
    await supabaseRequest(
      `shopper_jobs?order_id=eq.${encodeURIComponent(
        orderId
      )}&select=*&order=created_at.asc`
    );

  return Array.isArray(data)
    ? data
    : [];
}


async function createShopperJob({
  orderId,
  shopperId,
}) {
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

        body:
          JSON.stringify(
            updates
          ),
      }
    );

  return Array.isArray(data) &&
    data.length > 0
    ? data[0]
    : null;
}


/* =========================================================
   AVAILABLE SHOPPERS
========================================================= */

async function getAvailableShoppers(
  excludedShopperIds = []
) {
  const data =
    await supabaseRequest(
      `shoppers?available=eq.true&whatsapp_opted_in=eq.true&select=*&limit=100`
    );

  if (!Array.isArray(data)) {
    return [];
  }

  return data.filter(
    shopper =>
      !excludedShopperIds.includes(
        shopper.id
      ) &&
      !shopper.current_order_id
  );
}


/* =========================================================
   CUSTOMER NOTIFICATION ENGINE
========================================================= */

async function notifyCustomer(
  order,
  message
) {
  try {
    if (!order?.customer_id) {
      console.error(
        "FETCH CUSTOMER NOTIFICATION FAILED: NO CUSTOMER ID",
        order
      );

      return false;
    }

    const customer =
      await getCustomerById(
        order.customer_id
      );

    if (!customer?.phone) {
      console.error(
        "FETCH CUSTOMER NOTIFICATION FAILED: CUSTOMER PHONE NOT FOUND",
        order.customer_id
      );

      return false;
    }

    console.log(
      "FETCH CUSTOMER NOTIFICATION:",
      JSON.stringify({
        orderId: order.id,
        customerId:
          customer.id,
        phone:
          normalizePhone(
            customer.phone
          ),
        message,
      })
    );

    await sendWhatsAppMessage(
      customer.phone,
      message
    );

    await saveMessage({
      customerId:
        customer.id,

      orderId:
        order.id,

      phone:
        customer.phone,

      role:
        "assistant",

      message,
    });

    return true;
  } catch (error) {
    console.error(
      "FETCH CUSTOMER NOTIFICATION ERROR:",
      error
    );

    return false;
  }
}


/* =========================================================
   STATUS NOTIFICATIONS
========================================================= */

async function notifyOrderStatus(
  order,
  status
) {
  if (!order) {
    return;
  }

  let message = "";

  switch (status) {
    case "shopper_assigned":
      message =
        `✅ Good news! A Fetch shopper has accepted your order.\n\n` +
        `🏪 ${order.store_name}\n` +
        `🛒 ${order.items}\n\n` +
        `I'll keep you updated as your order moves along.`;
      break;

    case "shopping":
      message =
        `🛒 Your Fetch shopper has started shopping for your order.\n\n` +
        `🏪 ${order.store_name}\n` +
        `🛒 ${order.items}`;
      break;

    case "picked_up":
      message =
        `📦 Your items have been picked up from ${order.store_name}.\n\n` +
        `They're getting ready to come to you.`;
      break;

    case "out_for_delivery":
      message =
        `🚴 Your Fetch order is now out for delivery.\n\n` +
        `📍 Delivering to: ${order.delivery_address}`;
      break;

    case "delivered":
      message =
        `🎉 Your Fetch order has been delivered successfully!\n\n` +
        `Thank you for using Fetch ❤️`;
      break;

    default:
      return;
  }

  await notifyCustomer(
    order,
    message
  );
}


/* =========================================================
   OFFER ORDER TO SHOPPER
========================================================= */

async function offerOrderToShopper(
  order,
  excludedShopperIds = []
) {
  if (!order?.id) {
    return {
      success: false,
      shopper: null,
      job: null,
    };
  }

  const shoppers =
    await getAvailableShoppers(
      excludedShopperIds
    );

  if (!shoppers.length) {
    return {
      success: false,
      shopper: null,
      job: null,
    };
  }

  for (
    const shopper of shoppers
  ) {
    try {
      let job = null;

      const existingJobs =
        await supabaseRequest(
          `shopper_jobs?order_id=eq.${encodeURIComponent(
            order.id
          )}&shopper_id=eq.${encodeURIComponent(
            shopper.id
          )}&status=eq.offered&select=*&limit=1`
        );

      if (
        Array.isArray(
          existingJobs
        ) &&
        existingJobs.length
      ) {
        job =
          existingJobs[0];
      } else {
        job =
          await createShopperJob({
            orderId:
              order.id,

            shopperId:
              shopper.id,
          });
      }

      const shopperMessage =
        `🛍️ *New Fetch Job*\n\n` +
        `🏪 Store: ${order.store_name}\n` +
        `🛒 Items: ${order.items}\n` +
        `📍 Deliver to: ${order.delivery_address}\n` +
        `${
          order.budget !== null &&
          order.budget !== undefined
            ? `💰 Budget: ₹${order.budget}\n`
            : ""
        }\n` +
        `Reply *ACCEPT* to take this job.\n` +
        `Reply *DECLINE* to skip it.`;

      await sendWhatsAppMessage(
        shopper.phone,
        shopperMessage
      );

      await updateOrder(
        order.id,
        {
          shopper_id: null,
          status:
            "finding_shopper",
        }
      );

      console.log(
        "FETCH JOB OFFERED:",
        JSON.stringify({
          orderId:
            order.id,

          shopperId:
            shopper.id,

          jobId:
            job?.id,
        })
      );

      return {
        success: true,
        shopper,
        job,
      };
    } catch (error) {
      console.error(
        "FETCH SHOPPER OFFER ERROR:",
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
   DISPATCH
========================================================= */

async function dispatchOrder(
  order
) {
  if (!order?.id) {
    return {
      success: false,
    };
  }

  const jobs =
    await getShopperJobsForOrder(
      order.id
    );

  const excluded =
    jobs
      .filter(
        job =>
          job.status ===
            "declined" ||
          job.status ===
            "accepted" ||
          job.status ===
            "completed"
      )
      .map(
        job =>
          job.shopper_id
      );

  return offerOrderToShopper(
    order,
    excluded
  );
}


/* =========================================================
   ORDER STATUS TEXT
========================================================= */

function getOrderStatusText(
  status
) {
  switch (status) {
    case "collecting_details":
      return "I'm still collecting the details for your order.";

    case "awaiting_confirmation":
      return "Your order is ready and waiting for your confirmation.";

    case "finding_shopper":
      return "I'm finding a shopper for your order.";

    case "shopper_assigned":
      return "A shopper has accepted your order and will start shopping soon.";

    case "shopping":
      return "Your shopper is currently shopping for your items.";

    case "picked_up":
      return "Your items have been picked up and are getting ready for delivery.";

    case "out_for_delivery":
      return "Your order is out for delivery.";

    case "delivered":
      return "Your order has been delivered.";

    case "cancelled":
      return "Your order has been cancelled.";

    default:
      return `Your order status is ${
        status || "unknown"
      }.`;
  }
}


function getOrderSummary(
  order
) {
  if (!order) {
    return null;
  }

  return {
    id:
      order.id,

    store_name:
      order.store_name,

    items:
      order.items,

    budget:
      order.budget,

    delivery_address:
      order.delivery_address,

    status:
      order.status,

    total_amount:
      order.total_amount,

    shopper_fee:
      order.shopper_fee,

    created_at:
      order.created_at,
  };
}


/* =========================================================
   SIMPLE YES / NO
========================================================= */

function isConfirmation(
  message
) {
  const text =
    String(message || "")
      .trim()
      .toLowerCase();

  return [
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
  ].includes(text);
}


function isRejection(
  message
) {
  const text =
    String(message || "")
      .trim()
      .toLowerCase();

  return [
    "no",
    "n",
    "nope",
    "not now",
    "don't",
    "dont",
    "stop",
    "vendam",
    "വേണ്ട",
  ].includes(text);
}


/* =========================================================
   OPENAI HELPERS
========================================================= */

function extractOpenAIText(
  data
) {
  if (
    typeof data?.output_text ===
      "string" &&
    data.output_text.trim()
  ) {
    return data.output_text.trim();
  }

  const output =
    Array.isArray(data?.output)
      ? data.output
      : [];

  let collected = "";

  for (
    const item of output
  ) {
    if (
      Array.isArray(
        item?.content
      )
    ) {
      for (
        const content of
          item.content
      ) {
        if (
          typeof content?.text ===
          "string"
        ) {
          collected +=
            content.text;
        }
      }
    }
  }

  return collected.trim();
}


function cleanAIText(
  text
) {
  return String(text || "")
    .replace(/^```json/i, "")
    .replace(/^```/i, "")
    .replace(/```$/i, "")
    .trim();
}


/* =========================================================
   AI AGENT
========================================================= */

async function getAIDecision({
  userMessage,
  customer,
  activeOrder,
  latestOrder,
  conversationHistory,
}) {
  if (!OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY is missing"
    );
  }

  const systemPrompt = `
You are Fetch, a human-powered shopping assistant in India.

Your job is to understand what a customer wants to buy and help create/manage a shopping order.

You must understand:
- English
- Malayalam
- Manglish
- Hindi
- Hinglish
- Tamil
- Telugu
- Kannada
- mixed languages
- typos
- slang
- short messages

Examples:
"vere nthoke und?"
"10 eggs add cheyyu"
"milk venam"
"haan"
"yes"
"cancel it"
"where is my order?"
"order evide?"
"same store"
"change delivery to Kowdiar"

Never force the customer to speak English.

Use the customer's language naturally in your reply.

IMPORTANT:
If an active order already contains information, preserve it unless the customer clearly changes it.

A new order request should collect:
1. Store
2. Items
3. Delivery address

Budget is optional.

If information is missing, ask for only the missing information.

If all required information is present, summarize the order and ask for confirmation.

Do not say the order is placed until the customer confirms.

If the customer confirms an awaiting_confirmation order:
- intent = confirm
- needs_confirmation = false
- reply should say the order is confirmed and a shopper is being found.

If the customer asks about status:
- intent = status

If the customer asks to cancel:
- intent = cancel

If the customer wants a completely new order:
- intent = shopping_request
- do not reuse the old order as the new order.

For casual messages such as thanks:
respond naturally and briefly.

Return JSON only.
`;

  const inputPayload = {
    customer: {
      id:
        customer?.id || null,

      phone:
        customer?.phone || null,

      address:
        customer?.address || null,
    },

    current_active_order:
      getOrderSummary(
        activeOrder
      ),

    latest_order:
      getOrderSummary(
        latestOrder
      ),

    conversation_history:
      conversationHistory.map(
        item => ({
          role:
            item.role,

          message:
            item.message,
        })
      ),

    latest_customer_message:
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

          instructions:
            systemPrompt,

          input:
            JSON.stringify(
              inputPayload
            ),

          text: {
            format: {
              type:
                "json_schema",

              name:
                "fetch_agent_decision",

              strict: true,

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

                  store: {
                    type: [
                      "string",
                      "null",
                    ],
                  },

                  items: {
                    type: [
                      "string",
                      "null",
                    ],
                  },

                  delivery_address: {
                    type: [
                      "string",
                      "null",
                    ],
                  },

                  budget: {
                    type: [
                      "number",
                      "null",
                    ],
                  },

                  response_language: {
                    type:
                      "string",
                  },

                  needs_confirmation: {
                    type:
                      "boolean",
                  },

                  reply: {
                    type:
                      "string",
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

  const raw =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `OpenAI ${response.status}: ${raw}`
    );
  }

  let data;

  try {
    data =
      JSON.parse(raw);
  } catch {
    throw new Error(
      `Invalid OpenAI response: ${raw}`
    );
  }

  const outputText =
    extractOpenAIText(
      data
    );

  if (!outputText) {
    throw new Error(
      "OpenAI returned no usable text"
    );
  }

  const cleaned =
    cleanAIText(
      outputText
    );

  try {
    return JSON.parse(
      cleaned
    );
  } catch {
    throw new Error(
      `OpenAI JSON parsing failed: ${cleaned}`
    );
  }
}


/* =========================================================
   FALLBACK
========================================================= */

function buildFallbackReply({
  userMessage,
  activeOrder,
  latestOrder,
}) {
  const text =
    String(userMessage || "")
      .trim()
      .toLowerCase();

  if (
    text.includes(
      "where is my order"
    ) ||
    text.includes(
      "order status"
    ) ||
    text === "status" ||
    text.includes(
      "order evide"
    )
  ) {
    const order =
      activeOrder ||
      latestOrder;

    if (!order) {
      return "I don't see an order for you yet. Tell me what you'd like to buy and which store you want it from.";
    }

    return getOrderStatusText(
      order.status
    );
  }

  if (
    isConfirmation(
      userMessage
    )
  ) {
    return "Done 👍 Your order is being processed.";
  }

  if (
    isRejection(
      userMessage
    )
  ) {
    return "No problem 👍 Tell me what you'd like to change.";
  }

  if (
    [
      "hi",
      "hello",
      "hey",
      "hi fetch",
      "hello fetch",
    ].includes(text)
  ) {
    return "Hi 👋 I'm Fetch. Tell me what you need and which store you want it from.";
  }

  return "Sure 👍 Tell me what you'd like to order, which store you want it from, and where it should be delivered.";
}


/* =========================================================
   CUSTOMER ORDER PROCESSING
========================================================= */

async function processCustomerMessage({
  phone,
  customer,
  userMessage,
}) {
  let activeOrder =
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

  let decision;

  try {
    decision =
      await getAIDecision({
        userMessage,

        customer,

        activeOrder,

        latestOrder,

        conversationHistory:
          history,
      });
  } catch (error) {
    console.error(
      "FETCH AI ERROR:",
      error
    );

    const fallback =
      buildFallbackReply({
        userMessage,
        activeOrder,
        latestOrder,
      });

    await saveMessage({
      customerId:
        customer.id,

      orderId:
        activeOrder?.id ||
        null,

      phone,

      role:
        "user",

      message:
        userMessage,
    });

    await saveMessage({
      customerId:
        customer.id,

      orderId:
        activeOrder?.id ||
        null,

      phone,

      role:
        "assistant",

      message:
        fallback,
    });

    return {
      reply:
        fallback,

      shouldDispatch:
        false,
    };
  }


  /* -------------------------------------------------------
     NEW ORDER
  ------------------------------------------------------- */

  if (
    decision.intent ===
      "shopping_request" &&
    (
      !activeOrder ||
      decision.reply
        ?.toLowerCase()
        .includes(
          "new order"
        )
    )
  ) {
    activeOrder = null;
  }


  /* -------------------------------------------------------
     STATUS
  ------------------------------------------------------- */

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
        : "I don't see an order for you yet. Tell me what you'd like to buy and which store you want it from.";

    await saveMessage({
      customerId:
        customer.id,

      orderId:
        order?.id || null,

      phone,

      role:
        "user",

      message:
        userMessage,
    });

    await saveMessage({
      customerId:
        customer.id,

      orderId:
        order?.id || null,

      phone,

      role:
        "assistant",

      message:
        reply,
    });

    return {
      reply,
      shouldDispatch:
        false,
    };
  }


  /* -------------------------------------------------------
     CANCEL
  ------------------------------------------------------- */

  if (
    decision.intent ===
      "cancel"
  ) {
    if (
      activeOrder
    ) {
      const cancelled =
        await updateOrder(
          activeOrder.id,
          {
            status:
              "cancelled",
          }
        );

      const reply =
        "Your order has been cancelled. 👍";

      await saveMessage({
        customerId:
          customer.id,

        orderId:
          cancelled?.id ||
          activeOrder.id,

        phone,

        role:
          "user",

        message:
          userMessage,
      });

      await saveMessage({
        customerId:
          customer.id,

        orderId:
          cancelled?.id ||
          activeOrder.id,

        phone,

        role:
          "assistant",

        message:
          reply,
      });

      return {
        reply,
        shouldDispatch:
          false,
      };
    }

    return {
      reply:
        "You don't have an active order to cancel. 👍",
      shouldDispatch:
        false,
    };
  }


  /* -------------------------------------------------------
     CONFIRM EXISTING ORDER
  ------------------------------------------------------- */

  if (
    activeOrder &&
    activeOrder.status ===
      "awaiting_confirmation" &&
    (
      decision.intent ===
        "confirm" ||
      isConfirmation(
        userMessage
      )
    )
  ) {
    const confirmed =
      await updateOrder(
        activeOrder.id,
        {
          status:
            "finding_shopper",
        }
      );

    const reply =
      "Confirmed 👍 I'm finding a shopper for your order now.";

    await saveMessage({
      customerId:
        customer.id,

      orderId:
        confirmed?.id ||
        activeOrder.id,

      phone,

      role:
        "user",

      message:
        userMessage,
    });

    await saveMessage({
      customerId:
        customer.id,

      orderId:
        confirmed?.id ||
        activeOrder.id,

      phone,

      role:
        "assistant",

      message:
        reply,
    });

    return {
      reply,
      shouldDispatch:
        true,
      order:
        confirmed ||
        activeOrder,
    };
  }


  /* -------------------------------------------------------
     REJECT CONFIRMATION
  ------------------------------------------------------- */

  if (
    activeOrder &&
    activeOrder.status ===
      "awaiting_confirmation" &&
    (
      decision.intent ===
        "reject" ||
      isRejection(
        userMessage
      )
    )
  ) {
    const reply =
      "No problem 👍 Tell me what you'd like to change.";

    await saveMessage({
      customerId:
        customer.id,

      orderId:
        activeOrder.id,

      phone,

      role:
        "user",

      message:
        userMessage,
    });

    await saveMessage({
      customerId:
        customer.id,

      orderId:
        activeOrder.id,

      phone,

      role:
        "assistant",

      message:
        reply,
    });

    return {
      reply,
      shouldDispatch:
        false,
    };
  }


  /* -------------------------------------------------------
     BUILD / UPDATE ORDER
  ------------------------------------------------------- */

  const store =
    decision.store ||
    activeOrder?.store_name ||
    null;

  const items =
    decision.items ||
    activeOrder?.items ||
    null;

  const deliveryAddress =
    decision.delivery_address ||
    activeOrder?.delivery_address ||
    customer?.address ||
    null;

  const budget =
    decision.budget !== null &&
    decision.budget !== undefined
      ? decision.budget
      : activeOrder?.budget ??
        null;


  /* -------------------------------------------------------
     MISSING INFORMATION
  ------------------------------------------------------- */

  if (
    !store ||
    !items ||
    !deliveryAddress
  ) {
    const reply =
      decision.reply ||
      "Sure 👍 Tell me the store, items, and delivery address.";

    await saveMessage({
      customerId:
        customer.id,

      orderId:
        activeOrder?.id ||
        null,

      phone,

      role:
        "user",

      message:
        userMessage,
    });

    await saveMessage({
      customerId:
        customer.id,

      orderId:
        activeOrder?.id ||
        null,

      phone,

      role:
        "assistant",

      message:
        reply,
    });

    return {
      reply,
      shouldDispatch:
        false,
    };
  }


  /* -------------------------------------------------------
     UPDATE CUSTOMER ADDRESS
  ------------------------------------------------------- */

  if (
    deliveryAddress &&
    deliveryAddress !==
      customer.address
  ) {
    await updateCustomerAddress(
      customer.id,
      deliveryAddress
    );
  }


  /* -------------------------------------------------------
     CREATE NEW ORDER
  ------------------------------------------------------- */

  let order;

  if (!activeOrder) {
    order =
      await createOrder({
        customerId:
          customer.id,

        storeName:
          store,

        items,

        budget,

        deliveryAddress,

        status:
          "awaiting_confirmation",
      });
  } else {
    order =
      await updateOrder(
        activeOrder.id,
        {
          store_name:
            store,

          items,

          budget,

          delivery_address:
            deliveryAddress,

          status:
            "awaiting_confirmation",
        }
      );
  }


  /* -------------------------------------------------------
     SAVE CONVERSATION
  ------------------------------------------------------- */

  await saveMessage({
    customerId:
      customer.id,

    orderId:
      order?.id ||
      activeOrder?.id ||
      null,

    phone,

    role:
      "user",

    message:
      userMessage,
  });


  const reply =
    decision.reply ||
    `Sure – ${items} from ${store}, delivered to ${deliveryAddress}. Shall I place this order?`;


  await saveMessage({
    customerId:
      customer.id,

    orderId:
      order?.id ||
      activeOrder?.id ||
      null,

    phone,

    role:
      "assistant",

    message:
      reply,
  });


  return {
    reply,

    shouldDispatch:
      false,

    order,
  };
}


/* =========================================================
   SHOPPER COMMAND NORMALIZATION
========================================================= */

function normalizeShopperCommand(
  message
) {
  return String(
    message || ""
  )
    .trim()
    .toLowerCase()
    .replace(
      /\s+/g,
      " "
    );
}


function isShopperStart(
  text
) {
  return [
    "start",
    "join",
    "register",
    "shopper",
    "fetch shopper",
    "available",
  ].includes(text);
}


function isShopperAccept(
  text
) {
  return [
    "accept",
    "accepted",
    "yes",
    "y",
    "take it",
    "i'll take it",
    "ill take it",
  ].includes(text);
}


function isShopperDecline(
  text
) {
  return [
    "decline",
    "declined",
    "no",
    "n",
    "skip",
    "reject",
  ].includes(text);
}


function isShoppingCommand(
  text
) {
  return [
    "shopping",
    "start shopping",
    "started shopping",
    "i started shopping",
  ].includes(text);
}


function isPickedUpCommand(
  text
) {
  return [
    "picked up",
    "pickedup",
    "pickup",
    "picked",
    "items picked up",
  ].includes(text);
}


function isOutForDeliveryCommand(
  text
) {
  return [
    "out for delivery",
    "outfordelivery",
    "on the way",
    "on my way",
    "delivery",
  ].includes(text);
}


function isDeliveredCommand(
  text
) {
  return [
    "delivered",
    "delivery complete",
    "delivered successfully",
    "done",
    "completed",
  ].includes(text);
}


/* =========================================================
   SHOPPER MESSAGE HANDLER
========================================================= */

async function handleShopperMessage({
  phone,
  text,
}) {
  const command =
    normalizeShopperCommand(
      text
    );

  let shopper =
    await getShopperByPhone(
      phone
    );


  /* -------------------------------------------------------
     START
  ------------------------------------------------------- */

  if (
    isShopperStart(
      command
    )
  ) {
    if (!shopper) {
      shopper =
        await getOrCreateShopper(
          phone
        );
    }

    await activateShopper(
      shopper
    );

    await sendWhatsAppMessage(
      phone,
      `👋 Welcome to Fetch Shopper!\n\n` +
      `You are now marked as available.\n\n` +
      `When a customer order is available, I'll send it here.\n\n` +
      `Reply *ACCEPT* to take a job.\n` +
      `Reply *DECLINE* to skip a job.`
    );

    return true;
  }


  /* -------------------------------------------------------
     ONLY TREAT AS SHOPPER IF REGISTERED
  ------------------------------------------------------- */

  if (!shopper) {
    return false;
  }


  await updateShopper(
    shopper.id,
    {
      last_seen_at:
        new Date().toISOString(),
    }
  );


  /* -------------------------------------------------------
     ACCEPT
  ------------------------------------------------------- */

  if (
    isShopperAccept(
      command
    )
  ) {
    const job =
      await getOpenShopperJob(
        shopper.id
      );

    if (!job) {
      await sendWhatsAppMessage(
        phone,
        "There is no open Fetch job for you right now."
      );

      return true;
    }

    const order =
      await getOrderById(
        job.order_id
      );

    if (!order) {
      await sendWhatsAppMessage(
        phone,
        "I couldn't find that order. Please contact Fetch support."
      );

      return true;
    }

    if (
      order.status ===
        "delivered" ||
      order.status ===
        "cancelled"
    ) {
      await updateShopperJob(
        job.id,
        {
          status:
            "completed",

          completed_at:
            new Date().toISOString(),
        }
      );

      await sendWhatsAppMessage(
        phone,
        "That order is already closed."
      );

      return true;
    }


    /* Claim the job */

    await updateShopperJob(
      job.id,
      {
        status:
          "accepted",

        accepted_at:
          new Date().toISOString(),
      }
    );


    const updatedShopper =
      await updateShopper(
        shopper.id,
        {
          available:
            false,

          current_order_id:
            order.id,

          whatsapp_opted_in:
            true,

          last_seen_at:
            new Date().toISOString(),
        }
      );


    const updatedOrder =
      await updateOrder(
        order.id,
        {
          shopper_id:
            shopper.id,

          status:
            "shopper_assigned",
        }
      );


    await sendWhatsAppMessage(
      phone,
      `✅ Job accepted!\n\n` +
      `🏪 ${order.store_name}\n` +
      `🛒 ${order.items}\n` +
      `📍 ${order.delivery_address}\n\n` +
      `When you start shopping, reply *SHOPPING*.`
    );


    /* CUSTOMER UPDATE */

    await notifyOrderStatus(
      updatedOrder ||
        order,
      "shopper_assigned"
    );

    return true;
  }


  /* -------------------------------------------------------
     DECLINE
  ------------------------------------------------------- */

  if (
    isShopperDecline(
      command
    )
  ) {
    const job =
      await getOpenShopperJob(
        shopper.id
      );

    if (!job) {
      await sendWhatsAppMessage(
        phone,
        "There is no open Fetch job to decline."
      );

      return true;
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
      phone,
      "👍 No problem. I've skipped that job."
    );

    if (order) {
      const refreshedOrder =
        await getOrderById(
          order.id
        );

      if (
        refreshedOrder &&
        PROCESSING_ORDER_STATUSES.includes(
          refreshedOrder.status
        ) &&
        !refreshedOrder.shopper_id
      ) {
        await dispatchOrder(
          refreshedOrder
        );
      }
    }

    return true;
  }


  /* -------------------------------------------------------
     SHOPPING
  ------------------------------------------------------- */

  if (
    isShoppingCommand(
      command
    )
  ) {
    const job =
      await getAcceptedShopperJob(
        shopper.id
      );

    if (!job) {
      await sendWhatsAppMessage(
        phone,
        "I don't see an accepted Fetch job for you."
      );

      return true;
    }

    const order =
      await getOrderById(
        job.order_id
      );

    if (!order) {
      return true;
    }

    const updatedOrder =
      await updateOrder(
        order.id,
        {
          status:
            "shopping",
        }
      );

    await sendWhatsAppMessage(
      phone,
      `🛒 Shopping started.\n\n` +
      `🏪 ${order.store_name}\n` +
      `🛒 ${order.items}\n\n` +
      `When you have the items, reply *PICKED UP*.`
    );

    await notifyOrderStatus(
      updatedOrder ||
        order,
      "shopping"
    );

    return true;
  }


  /* -------------------------------------------------------
     PICKED UP
  ------------------------------------------------------- */

  if (
    isPickedUpCommand(
      command
    )
  ) {
    const job =
      await getAcceptedShopperJob(
        shopper.id
      );

    if (!job) {
      await sendWhatsAppMessage(
        phone,
        "I don't see an active Fetch job for you."
      );

      return true;
    }

    const order =
      await getOrderById(
        job.order_id
      );

    if (!order) {
      return true;
    }

    /*
     * IMPORTANT:
     * This is now a REAL picked_up status.
     */

    const updatedOrder =
      await updateOrder(
        order.id,
        {
          status:
            "picked_up",
        }
      );

    await sendWhatsAppMessage(
      phone,
      `📦 Items picked up successfully.\n\n` +
      `When you leave for the customer, reply *OUT FOR DELIVERY*.`
    );

    await notifyOrderStatus(
      updatedOrder ||
        order,
      "picked_up"
    );

    return true;
  }


  /* -------------------------------------------------------
     OUT FOR DELIVERY
  ------------------------------------------------------- */

  if (
    isOutForDeliveryCommand(
      command
    )
  ) {
    const job =
      await getAcceptedShopperJob(
        shopper.id
      );

    if (!job) {
      await sendWhatsAppMessage(
        phone,
        "I don't see an active Fetch job for you."
      );

      return true;
    }

    const order =
      await getOrderById(
        job.order_id
      );

    if (!order) {
      return true;
    }

    const updatedOrder =
      await updateOrder(
        order.id,
        {
          status:
            "out_for_delivery",
        }
      );

    await sendWhatsAppMessage(
      phone,
      `🚴 You're now out for delivery.\n\n` +
      `📍 ${order.delivery_address}\n\n` +
      `Reply *DELIVERED* once the customer receives the order.`
    );

    await notifyOrderStatus(
      updatedOrder ||
        order,
      "out_for_delivery"
    );

    return true;
  }


  /* -------------------------------------------------------
     DELIVERED
  ------------------------------------------------------- */

  if (
    isDeliveredCommand(
      command
    )
  ) {
    const job =
      await getAcceptedShopperJob(
        shopper.id
      );

    if (!job) {
      await sendWhatsAppMessage(
        phone,
        "I don't see an active Fetch job for you."
      );

      return true;
    }

    const order =
      await getOrderById(
        job.order_id
      );

    if (!order) {
      return true;
    }

    const updatedOrder =
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
      phone,
      `🎉 Delivery completed!\n\n` +
      `Thank you for shopping with Fetch.\n\n` +
      `You are now marked as available for the next job.`
    );

    await notifyOrderStatus(
      updatedOrder ||
        order,
      "delivered"
    );

    return true;
  }


  /* -------------------------------------------------------
     UNKNOWN SHOPPER MESSAGE
  ------------------------------------------------------- */

  if (
    shopper.current_order_id
  ) {
    await sendWhatsAppMessage(
      phone,
      `I'm managing your current Fetch job.\n\n` +
      `Reply with:\n` +
      `*SHOPPING* – start shopping\n` +
      `*PICKED UP* – items collected\n` +
      `*OUT FOR DELIVERY* – leaving for customer\n` +
      `*DELIVERED* – customer received the order`
    );

    return true;
  }


  await sendWhatsAppMessage(
    phone,
    `You're currently available for Fetch jobs. 👍\n\n` +
    `I'll send you a message when a new order is available.`
  );

  return true;
}


/* =========================================================
   CUSTOMER WEBHOOK HANDLER
========================================================= */

async function handleCustomerMessage({
  phone,
  text,
}) {
  const customer =
    await getOrCreateCustomer(
      phone
    );

  const result =
    await processCustomerMessage({
      phone,

      customer,

      userMessage:
        text,
    });

  if (result.reply) {
    await sendWhatsAppMessage(
      phone,
      result.reply
    );
  }


  /* -------------------------------------------------------
     DISPATCH AFTER CUSTOMER CONFIRMATION
  ------------------------------------------------------- */

  if (
    result.shouldDispatch &&
    result.order
  ) {
    const order =
      await getOrderById(
        result.order.id
      );

    if (
      order &&
      (
        order.status ===
          "finding_shopper"
      )
    ) {
      const dispatch =
        await dispatchOrder(
          order
        );

      if (
        dispatch.success
      ) {
        const dispatchMessage =
          `🛍️ I've sent your order to an available shopper.\n\n` +
          `I'll let you know as soon as someone accepts it.`;

        await sendWhatsAppMessage(
          phone,
          dispatchMessage
        );

        await saveMessage({
          customerId:
            customer.id,

          orderId:
            order.id,

          phone,

          role:
            "assistant",

          message:
            dispatchMessage,
        });
      } else {
        const noShopperMessage =
          `I'm still looking for an available shopper for your order. I'll keep the order open and try again when one is available.`;

        await sendWhatsAppMessage(
          phone,
          noShopperMessage
        );

        await saveMessage({
          customerId:
            customer.id,

          orderId:
            order.id,

          phone,

          role:
            "assistant",

          message:
            noShopperMessage,
        });
      }
    }
  }
}


/* =========================================================
   WHATSAPP WEBHOOK PARSER
========================================================= */

function extractIncomingWhatsAppMessage(
  body
) {
  try {
    const value =
      body?.entry?.[0]
        ?.changes?.[0]
        ?.value;

    const messages =
      value?.messages;

    if (
      !Array.isArray(
        messages
      ) ||
      !messages.length
    ) {
      return null;
    }

    const message =
      messages[0];

    const from =
      message?.from;

    if (!from) {
      return null;
    }

    let text = "";

    if (
      message.type ===
      "text"
    ) {
      text =
        message.text?.body ||
        "";
    } else if (
      message.type ===
      "button"
    ) {
      text =
        message.button?.text ||
        "";
    } else if (
      message.type ===
      "interactive"
    ) {
      text =
        message.interactive
          ?.button_reply?.title ||
        message.interactive
          ?.list_reply?.title ||
        "";
    }

    return {
      from:
        normalizePhone(
          from
        ),

      text:
        String(text || "")
          .trim(),

      messageId:
        message.id,

      type:
        message.type,
    };
  } catch (error) {
    console.error(
      "FETCH WEBHOOK PARSE ERROR:",
      error
    );

    return null;
  }
}


/* =========================================================
   MAIN WEBHOOK
========================================================= */

/* =========================================================
   WEBHOOK VERIFICATION
========================================================= */

export async function GET(request) {
  try {
    const url =
      new URL(
        request.url,
        `https://${request.headers.host}`
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

    console.log(
      "FETCH WEBHOOK VERIFICATION:",
      JSON.stringify({
        mode,
        tokenReceived: !!token,
        challengeReceived: !!challenge,
      })
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

  } catch (error) {
    console.error(
      "FETCH WEBHOOK GET ERROR:",
      error
    );

    return textResponse(
      "Forbidden",
      403
    );
  }
}


/* =========================================================
   WEBHOOK POST
========================================================= */

export async function POST(request) {
  try {
    /*
     * Vercel Node runtime gives us
     * a Node IncomingMessage rather than
     * a Web Request.
     *
     * Therefore we read request.body
     * instead of calling request.json().
     */

    let body = request.body;

    /*
     * Some runtimes may provide the body
     * as a string/buffer.
     */

    if (
      typeof body === "string"
    ) {
      try {
        body = JSON.parse(body);
      } catch {
        return jsonResponse(
          {
            error:
              "Invalid JSON",
          },
          400
        );
      }
    }

    /*
     * If Vercel has not parsed the body,
     * collect it manually.
     */

    if (
      !body ||
      typeof body !== "object"
    ) {
      const chunks = [];

      for await (
        const chunk of request
      ) {
        chunks.push(
          Buffer.from(chunk)
        );
      }

      const rawBody =
        Buffer.concat(
          chunks
        ).toString("utf8");

      try {
        body =
          JSON.parse(
            rawBody
          );
      } catch {
        return jsonResponse(
          {
            error:
              "Invalid JSON",
          },
          400
        );
      }
    }

    console.log(
      "FETCH WEBHOOK RECEIVED:",
      JSON.stringify(
        body,
        null,
        2
      )
    );

    /*
     * Process every Meta entry/change/message.
     */

    const entries =
      Array.isArray(
        body?.entry
      )
        ? body.entry
        : [];

    for (
      const entry of entries
    ) {
      const changes =
        Array.isArray(
          entry?.changes
        )
          ? entry.changes
          : [];

      for (
        const change of changes
      ) {
        const value =
          change?.value;

        if (!value) {
          continue;
        }

        const messages =
          Array.isArray(
            value.messages
          )
            ? value.messages
            : [];

        for (
          const message of messages
        ) {
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
      success:
        true,
    });

  } catch (error) {
    console.error(
      "FETCH WEBHOOK POST ERROR:",
      error
    );

    /*
     * Return 200 to Meta so it doesn't
     * repeatedly resend the same webhook.
     */

    return jsonResponse({
      success:
        true,
    });
  }
}


/* =========================================================
   DEFAULT HANDLER
========================================================= */

/*
 * No default handler is required here.
 *
 * Vercel automatically detects the
 * exported GET and POST functions.
 */
