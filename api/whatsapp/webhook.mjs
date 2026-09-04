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
   STATUS LISTS
========================================================= */

const ACTIVE_ORDER_STATUSES = [
  "collecting_details",
  "awaiting_confirmation",
  "finding_shopper",
  "shopper_assigned",
  "shopping",
  "out_for_delivery",
];

const PROCESSING_ORDER_STATUSES = [
  "finding_shopper",
  "shopper_assigned",
  "shopping",
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
        "Content-Type":
          "application/json",
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
    apikey:
      SUPABASE_KEY,

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
      data =
        JSON.parse(text);
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
        method:
          "POST",

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

          to:
            normalizedTo,

          type:
            "text",

          text: {
            preview_url:
              false,

            body:
              message,
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

async function getCustomer(
  phone
) {
  const encodedPhone =
    encodeURIComponent(
      phone
    );

  const data =
    await supabaseRequest(
      `customers?phone=eq.${encodedPhone}&select=*&limit=1`
    );

  return Array.isArray(data) &&
    data.length > 0
    ? data[0]
    : null;
}

async function createCustomer(
  phone
) {
  const data =
    await supabaseRequest(
      "customers",
      {
        method:
          "POST",

        headers: {
          Prefer:
            "return=representation",
        },

        body: JSON.stringify({
          phone,
        }),
      }
    );

  return Array.isArray(data)
    ? data[0]
    : data;
}

async function getOrCreateCustomer(
  phone
) {
  let customer =
    await getCustomer(
      phone
    );

  if (customer) {
    return customer;
  }

  try {
    return await createCustomer(
      phone
    );
  } catch (error) {
    customer =
      await getCustomer(
        phone
      );

    if (customer) {
      return customer;
    }

    throw error;
  }
}


/* =========================================================
   SHOPPERS
========================================================= */

async function getShopperByPhone(
  phone
) {
  const normalizedPhone =
    normalizePhone(
      phone
    );

  console.log(
    "FETCH SHOPPER LOOKUP:",
    normalizedPhone
  );

  /*
   * First try exact database match.
   */
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
    console.log(
      "FETCH SHOPPER FOUND EXACT:",
      JSON.stringify(
        exact[0]
      )
    );

    return exact[0];
  }

  /*
   * Then normalize all shopper phone numbers.
   */
  const shoppers =
    await supabaseRequest(
      "shoppers?select=*&limit=100"
    );

  if (!Array.isArray(shoppers)) {
    return null;
  }

  const match =
    shoppers.find(
      (shopper) =>
        normalizePhone(
          shopper.phone
        ) ===
        normalizedPhone
    );

  if (match) {
    console.log(
      "FETCH SHOPPER FOUND NORMALIZED:",
      JSON.stringify(match)
    );
  }

  return match || null;
}

async function createShopper(
  phone
) {
  const normalizedPhone =
    normalizePhone(
      phone
    );

  const data =
    await supabaseRequest(
      "shoppers",
      {
        method:
          "POST",

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
        method:
          "PATCH",

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

async function activateShopper(
  shopper
) {
  return await updateShopper(
    shopper.id,
    {
      available:
        true,

      whatsapp_opted_in:
        true,

      current_order_id:
        null,

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
  /*
   * Use a clean PostgREST IN query.
   */
  const statuses =
    ACTIVE_ORDER_STATUSES
      .join(",");

  const data =
    await supabaseRequest(
      `orders?customer_id=eq.${encodeURIComponent(
        customerId
      )}&status=in.(${encodeURIComponent(
        statuses
      )})&select=*&order=created_at.desc&limit=1`
    );

  const order =
    Array.isArray(data) &&
    data.length > 0
      ? data[0]
      : null;

  console.log(
    "FETCH ACTIVE ORDER:",
    JSON.stringify(order)
  );

  return order;
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
        method:
          "POST",

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
    JSON.stringify(
      order
    )
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
        method:
          "PATCH",

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

  const order =
    Array.isArray(data) &&
    data.length > 0
      ? data[0]
      : null;

  console.log(
    "FETCH ORDER UPDATED:",
    JSON.stringify(
      order
    )
  );

  return order;
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
        method:
          "POST",

        headers: {
          Prefer:
            "return=minimal",
        },

        body: JSON.stringify({
          customer_id:
            customerId,

          order_id:
            orderId ||
            null,

          phone,

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

async function updateCustomerAddress(
  customerId,
  address
) {
  if (!address) {
    return;
  }

  try {
    await supabaseRequest(
      `customers?id=eq.${encodeURIComponent(
        customerId
      )}`,
      {
        method:
          "PATCH",

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
   SHOPPER JOBS
========================================================= */

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

async function createShopperJob({
  orderId,
  shopperId,
}) {
  console.log(
    "FETCH CREATING SHOPPER JOB:",
    JSON.stringify({
      orderId,
      shopperId,
    })
  );

  const data =
    await supabaseRequest(
      "shopper_jobs",
      {
        method:
          "POST",

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

  const job =
    Array.isArray(data)
      ? data[0]
      : data;

  console.log(
    "FETCH SHOPPER JOB CREATED:",
    JSON.stringify(
      job
    )
  );

  return job;
}

async function updateShopperJob(
  jobId,
  updates
) {
  console.log(
    "FETCH SHOPPER JOB UPDATE:",
    JSON.stringify({
      jobId,
      updates,
    })
  );

  const data =
    await supabaseRequest(
      `shopper_jobs?id=eq.${encodeURIComponent(
        jobId
      )}`,
      {
        method:
          "PATCH",

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

  const available =
    data.filter(
      (shopper) =>
        !excludedShopperIds.includes(
          shopper.id
        ) &&
        !shopper.current_order_id
    );

  console.log(
    "FETCH AVAILABLE SHOPPERS:",
    JSON.stringify(
      available
    )
  );

  return available;
}


/* =========================================================
   OFFER ORDER TO SHOPPER
========================================================= */

async function offerOrderToShopper(
  order,
  excludedShopperIds = []
) {
  console.log(
    "FETCH DISPATCH START:",
    JSON.stringify({
      orderId:
        order?.id,

      store:
        order?.store_name,

      items:
        order?.items,

      status:
        order?.status,

      excludedShopperIds,
    })
  );

  if (!order?.id) {
    console.error(
      "FETCH DISPATCH FAILED: NO ORDER"
    );

    return {
      success:
        false,

      shopper:
        null,

      job:
        null,
    };
  }

  const shoppers =
    await getAvailableShoppers(
      excludedShopperIds
    );

  console.log(
    "FETCH DISPATCH SHOPPER COUNT:",
    shoppers.length
  );

  if (
    shoppers.length === 0
  ) {
    console.log(
      "FETCH DISPATCH: NO AVAILABLE SHOPPER"
    );

    return {
      success:
        false,

      shopper:
        null,

      job:
        null,
    };
  }

  for (
    const shopper of shoppers
  ) {
    let job =
      null;

    try {
      /*
       * Check whether this shopper
       * already has an open offer for
       * this exact order.
       */
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
        existingJobs.length > 0
      ) {
        console.log(
          "FETCH DISPATCH: EXISTING OPEN JOB",
          JSON.stringify(
            existingJobs[0]
          )
        );

        /*
         * Try sending the existing job again.
         */
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
          order.budget !==
            null &&
          order.budget !==
            undefined
            ? `💰 Budget: ₹${order.budget}\n`
            : ""
        }\n` +
        `\nReply *ACCEPT* to take this job.\n` +
        `Reply *DECLINE* to skip it.`;

      console.log(
        "FETCH DISPATCH SENDING JOB TO:",
        normalizePhone(
          shopper.phone
        )
      );

      await sendWhatsAppMessage(
        shopper.phone,
        shopperMessage
      );

      await updateOrder(
        order.id,
        {
          shopper_id:
            null,

          status:
            "finding_shopper",
        }
      );

      console.log(
        "FETCH DISPATCH SUCCESS:",
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
        success:
          true,

        shopper,

        job,
      };
    } catch (error) {
      console.error(
        "FETCH SHOPPER OFFER ERROR:",
        error
      );

      if (job?.id) {
        try {
          await updateShopperJob(
            job.id,
            {
              status:
                "declined",
            }
          );
        } catch (
          cleanupError
        ) {
          console.error(
            "FETCH JOB CLEANUP ERROR:",
            cleanupError
          );
        }
      }

      /*
       * Try next shopper.
       */
      continue;
    }
  }

  console.error(
    "FETCH DISPATCH FAILED: ALL SHOPPERS FAILED"
  );

  return {
    success:
      false,

    shopper:
      null,

    job:
      null,
  };
}


/* =========================================================
   DISPATCH ORDER
========================================================= */

async function dispatchOrder(
  order
) {
  console.log(
    "FETCH DISPATCH ORDER:",
    JSON.stringify(
      order
    )
  );

  if (!order?.id) {
    return {
      success:
        false,
    };
  }

  /*
   * If already accepted/active, don't
   * create another assignment.
   */
  if (
    order.shopper_id &&
    [
      "shopper_assigned",
      "shopping",
      "out_for_delivery",
    ].includes(
      order.status
    )
  ) {
    console.log(
      "FETCH DISPATCH: ALREADY ASSIGNED"
    );

    return {
      success:
        true,

      alreadyAssigned:
        true,
    };
  }

  /*
   * Find shoppers who have already
   * completed/declined this order.
   */
  let existingJobs =
    [];

  try {
    existingJobs =
      await getShopperJobsForOrder(
        order.id
      );
  } catch (error) {
    console.error(
      "FETCH GET ORDER JOBS ERROR:",
      error
    );
  }

  const excludedShopperIds =
    Array.isArray(
      existingJobs
    )
      ? existingJobs
          .filter(
            (job) =>
              [
                "declined",
                "accepted",
                "completed",
              ].includes(
                job.status
              )
          )
          .map(
            (job) =>
              job.shopper_id
          )
      : [];

  console.log(
    "FETCH DISPATCH EXCLUDED SHOPPERS:",
    JSON.stringify(
      excludedShopperIds
    )
  );

  return await offerOrderToShopper(
    order,
    excludedShopperIds
  );
}


/* =========================================================
   SHOPPER COMMANDS
========================================================= */

function isShopperStart(
  message
) {
  const text =
    String(message || "")
      .trim()
      .toLowerCase();

  return [
    "start",
    "join",
    "start shopper",
    "join shopper",
    "become shopper",
    "shopper",
  ].includes(
    text
  );
}

function isShopperAccept(
  message
) {
  const text =
    String(message || "")
      .trim()
      .toLowerCase();

  return [
    "accept",
    "accepted",
    "yes",
    "y",
    "take it",
    "take job",
    "ok",
    "okay",
    "haan",
    "ശരി",
    "അതെ",
  ].includes(
    text
  );
}

function isShopperDecline(
  message
) {
  const text =
    String(message || "")
      .trim()
      .toLowerCase();

  return [
    "decline",
    "declined",
    "no",
    "n",
    "skip",
    "not interested",
    "no thanks",
    "vendam",
    "വേണ്ട",
  ].includes(
    text
  );
}

function isShoppingCommand(
  message
) {
  const text =
    String(message || "")
      .trim()
      .toLowerCase();

  return [
    "shopping",
    "shop",
    "started shopping",
    "shopping started",
    "start shopping",
  ].includes(
    text
  );
}

function isPickedUpCommand(
  message
) {
  const text =
    String(message || "")
      .trim()
      .toLowerCase();

  return [
    "picked up",
    "picked",
    "pickup",
    "pickedup",
    "items picked up",
  ].includes(
    text
  );
}

function isOutForDeliveryCommand(
  message
) {
  const text =
    String(message || "")
      .trim()
      .toLowerCase();

  return [
    "out for delivery",
    "out delivery",
    "on the way",
    "delivering",
  ].includes(
    text
  );
}

function isDeliveredCommand(
  message
) {
  const text =
    String(message || "")
      .trim()
      .toLowerCase();

  return [
    "delivered",
    "delivery done",
    "delivered successfully",
    "done",
  ].includes(
    text
  );
}


/* =========================================================
   SHOPPER MESSAGE HANDLER
========================================================= */

async function handleShopperMessage({
  shopper,
  userMessage,
}) {
  const phone =
    normalizePhone(
      shopper.phone
    );

  console.log(
    `FETCH SHOPPER MESSAGE FROM ${phone}: ${userMessage}`
  );

  await updateShopper(
    shopper.id,
    {
      last_seen_at:
        new Date().toISOString(),

      whatsapp_opted_in:
        true,
    }
  );


  /* START */

  if (
    isShopperStart(
      userMessage
    )
  ) {
    const updatedShopper =
      await activateShopper(
        shopper
      );

    await sendWhatsAppMessage(
      phone,
      `🛍️ *Welcome to Fetch Shopper!*\n\n` +
        `You're now marked as *available* to receive shopping jobs.\n\n` +
        `When a customer needs something, Fetch will send you the store, items and delivery details.\n\n` +
        `Reply *ACCEPT* to take a job.\n` +
        `Reply *DECLINE* to skip it.`
    );

    return {
      shopper:
        updatedShopper ||
        shopper,
    };
  }


  /* ACCEPT */

  if (
    isShopperAccept(
      userMessage
    )
  ) {
    const offeredJob =
      await getOpenShopperJob(
        shopper.id
      );

    if (!offeredJob) {
      await sendWhatsAppMessage(
        phone,
        `I don't see an open Fetch job for you right now. 👍`
      );

      return {
        shopper,
      };
    }

    const order =
      await getOrderById(
        offeredJob.order_id
      );

    if (!order) {
      await updateShopperJob(
        offeredJob.id,
        {
          status:
            "declined",
        }
      );

      await sendWhatsAppMessage(
        phone,
        `This job is no longer available.`
      );

      return {
        shopper,
      };
    }

    await updateShopperJob(
      offeredJob.id,
      {
        status:
          "accepted",

        accepted_at:
          new Date().toISOString(),
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
      `✅ *Job accepted!*\n\n` +
        `🏪 ${order.store_name}\n` +
        `🛒 ${order.items}\n` +
        `📍 ${order.delivery_address}\n\n` +
        `When you start shopping, reply *SHOPPING*.`
    );

    try {
      const customer =
        await getCustomer(
          order.customer_id
        );

      if (
        customer?.phone
      ) {
        await sendWhatsAppMessage(
          customer.phone,
          `✅ Good news! I've found a shopper for your order.\n\n` +
            `🏪 ${order.store_name}\n` +
            `🛒 ${order.items}\n\n` +
            `Your shopper is now getting ready to shop for you.`
        );
      }
    } catch (error) {
      console.error(
        "FETCH CUSTOMER ACCEPT NOTIFICATION ERROR:",
        error
      );
    }

    return {
      shopper,

      order:
        updatedOrder ||
        order,
    };
  }


  /* DECLINE */

  if (
    isShopperDecline(
      userMessage
    )
  ) {
    const offeredJob =
      await getOpenShopperJob(
        shopper.id
      );

    if (!offeredJob) {
      await sendWhatsAppMessage(
        phone,
        `There isn't an open job for you right now. 👍`
      );

      return {
        shopper,
      };
    }

    await updateShopperJob(
      offeredJob.id,
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

    const order =
      await getOrderById(
        offeredJob.order_id
      );

    if (order) {
      const dispatchResult =
        await offerOrderToShopper(
          order,
          [shopper.id]
        );

      if (
        dispatchResult.success
      ) {
        await sendWhatsAppMessage(
          phone,
          `👍 No problem. I've skipped that job.\n\nI'll keep you available for the next one.`
        );
      } else {
        await sendWhatsAppMessage(
          phone,
          `👍 No problem. You're still marked as available for the next job.`
        );
      }
    } else {
      await sendWhatsAppMessage(
        phone,
        `👍 No problem. You're still marked as available for the next job.`
      );
    }

    return {
      shopper,
    };
  }


  /* SHOPPING */

  if (
    isShoppingCommand(
      userMessage
    )
  ) {
    const job =
      await getAcceptedShopperJob(
        shopper.id
      );

    if (!job) {
      await sendWhatsAppMessage(
        phone,
        `I don't see an accepted Fetch job for you.`
      );

      return {
        shopper,
      };
    }

    const order =
      await updateOrder(
        job.order_id,
        {
          status:
            "shopping",
        }
      );

    await sendWhatsAppMessage(
      phone,
      `🛒 Great — shopping started.\n\nWhen you've collected the items, reply *PICKED UP*.`
    );

    try {
      const customer =
        await getCustomer(
          order?.customer_id
        );

      if (
        customer?.phone
      ) {
        await sendWhatsAppMessage(
          customer.phone,
          `🛒 Your shopper has started shopping for your order.`
        );
      }
    } catch (error) {
      console.error(
        "FETCH SHOPPING CUSTOMER NOTIFICATION ERROR:",
        error
      );
    }

    return {
      shopper,
      order,
    };
  }


  /* PICKED UP */

  if (
    isPickedUpCommand(
      userMessage
    )
  ) {
    const job =
      await getAcceptedShopperJob(
        shopper.id
      );

    if (!job) {
      await sendWhatsAppMessage(
        phone,
        `I don't see an active Fetch job for you.`
      );

      return {
        shopper,
      };
    }

    const order =
      await updateOrder(
        job.order_id,
        {
          status:
            "shopping",
        }
      );

    await sendWhatsAppMessage(
      phone,
      `📦 Got it. Items picked up.\n\nWhen you're heading to the customer, reply *OUT FOR DELIVERY*.`
    );

    return {
      shopper,
      order,
    };
  }


  /* OUT FOR DELIVERY */

  if (
    isOutForDeliveryCommand(
      userMessage
    )
  ) {
    const job =
      await getAcceptedShopperJob(
        shopper.id
      );

    if (!job) {
      await sendWhatsAppMessage(
        phone,
        `I don't see an active Fetch job for you.`
      );

      return {
        shopper,
      };
    }

    const order =
      await updateOrder(
        job.order_id,
        {
          status:
            "out_for_delivery",
        }
      );

    await sendWhatsAppMessage(
      phone,
      `🚴 You're now marked as *out for delivery*.\n\nReply *DELIVERED* once the customer receives the order.`
    );

    try {
      const customer =
        await getCustomer(
          order?.customer_id
        );

      if (
        customer?.phone
      ) {
        await sendWhatsAppMessage(
          customer.phone,
          `🚴 Your Fetch order is now out for delivery.`
        );
      }
    } catch (error) {
      console.error(
        "FETCH DELIVERY CUSTOMER NOTIFICATION ERROR:",
        error
      );
    }

    return {
      shopper,
      order,
    };
  }


  /* DELIVERED */

  if (
    isDeliveredCommand(
      userMessage
    )
  ) {
    const job =
      await getAcceptedShopperJob(
        shopper.id
      );

    if (!job) {
      await sendWhatsAppMessage(
        phone,
        `I don't see an active Fetch job for you.`
      );

      return {
        shopper,
      };
    }

    const order =
      await updateOrder(
        job.order_id,
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
      `🎉 Delivery completed!\n\nYou're now available for the next Fetch job.`
    );

    try {
      const customer =
        await getCustomer(
          order?.customer_id
        );

      if (
        customer?.phone
      ) {
        await sendWhatsAppMessage(
          customer.phone,
          `🎉 Your Fetch order has been delivered successfully.`
        );
      }
    } catch (error) {
      console.error(
        "FETCH DELIVERED CUSTOMER NOTIFICATION ERROR:",
        error
      );
    }

    return {
      shopper,
      order,
    };
  }


  /* HELP */

  await sendWhatsAppMessage(
    phone,
    `Hi 👋 You're registered as a Fetch shopper.\n\n` +
      `• Reply *START* to become available\n` +
      `• Reply *ACCEPT* to accept a job\n` +
      `• Reply *DECLINE* to skip a job\n` +
      `• Reply *SHOPPING* when you start shopping\n` +
      `• Reply *PICKED UP* when you have the items\n` +
      `• Reply *OUT FOR DELIVERY* when you're on the way\n` +
      `• Reply *DELIVERED* when the customer receives it`
  );

  return {
    shopper,
  };
}


/* =========================================================
   ORDER STATUS
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
      return `Your order status is ${
        status ||
        "unknown"
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
   CONFIRMATION
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
  ].includes(
    text
  );
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
  ].includes(
    text
  );
}

function missingRequiredFields(
  order
) {
  const missing = [];

  if (
    !order?.store_name ||
    order.store_name ===
      "Not specified"
  ) {
    missing.push(
      "store"
    );
  }

  if (
    !order?.items ||
    order.items ===
      "Not specified"
  ) {
    missing.push(
      "items"
    );
  }

  if (
    !order?.delivery_address
  ) {
    missing.push(
      "delivery address"
    );
  }

  return missing;
}


/* =========================================================
   OPENAI
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

  let collected =
    "";

  for (
    const item of output
  ) {
    if (
      item?.type ===
        "message" &&
      Array.isArray(
        item.content
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

  if (
    collected.trim()
  ) {
    return collected.trim();
  }

  return "";
}

function cleanAIText(
  text
) {
  if (!text) {
    return "";
  }

  return String(text)
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
  conversationHistory,
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
You are Fetch, a friendly AI shopping assistant operating through WhatsApp.

Fetch helps people request products from stores and coordinates human shoppers.

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

Understand the conversation using previous messages.

Examples:

"vere nthoke und?"
"ethokke und?"
"enthokke und?"
"add 10 eggs"
"10 eggs koodi venam"
"remove bread"
"bread venda"
"change the store"
"where is my order?"
"order evide?"
"cancel it"
"cancel cheyy"
"yes"
"no"

Do not create a duplicate order just because the customer sent another message.

If an active order exists, continue working with it unless the customer clearly asks for a separate new order.

Required order information:

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
- Product availability

If the customer provides new information about an existing order, extract it.

If the customer says "add", interpret it as an addition to existing items.

If the customer says "remove", interpret it as removing an item.

If the customer says "change", interpret it as modifying the existing request.

When all required information is available, summarize the order and ask the customer to confirm.

If the customer says YES or another confirmation, classify it as "confirm".

If the customer asks for status, use the database status supplied in the input.

Keep WhatsApp responses natural and reasonably short.

Return ONLY JSON matching the required schema.
`;

  const inputPayload = {
    customer: {
      id:
        customer?.id ||
        null,

      name:
        customer?.name ||
        null,

      phone:
        customer?.phone ||
        null,

      address:
        customer?.address ||
        null,
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
        (item) => ({
          role:
            item.role,

          message:
            item.message,
        })
      ),

    latest_customer_message:
      userMessage,
  };

  console.log(
    "FETCH SENDING TO OPENAI:",
    JSON.stringify(
      inputPayload
    )
  );

  const response =
    await fetch(
      "https://api.openai.com/v1/responses",
      {
        method:
          "POST",

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

  console.log(
    "FETCH OPENAI HTTP STATUS:",
    response.status
  );

  if (!response.ok) {
    console.error(
      "FETCH OPENAI RAW ERROR:",
      raw
    );

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

  console.log(
    "FETCH OPENAI RESPONSE:",
    JSON.stringify(
      data
    )
  );

  const outputText =
    extractOpenAIText(
      data
    );

  if (!outputText) {
    throw new Error(
      "OpenAI returned no usable text. Full response: " +
        JSON.stringify(
          data
        )
    );
  }

  const cleaned =
    cleanAIText(
      outputText
    );

  let decision;

  try {
    decision =
      JSON.parse(
        cleaned
      );
  } catch {
    throw new Error(
      `OpenAI JSON parsing failed: ${cleaned}`
    );
  }

  return decision;
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
    text ===
      "status" ||
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
    return "Confirmed 👍 I'm finding a shopper for your order now.";
  }

  if (
    isRejection(
      userMessage
    )
  ) {
    return "No problem 👍 Tell me what you'd like to change.";
  }

  if (
    text === "hi" ||
    text === "hello" ||
    text === "hey"
  ) {
    return "Hi 👋 I'm Fetch. Tell me what you need and which store you want it from.";
  }

  return "I'm Fetch 👋 Tell me what you'd like to buy, which store it's from, and where you'd like it delivered.";
}


/* =========================================================
   CUSTOMER PROCESSING
========================================================= */

async function processMessage({
  customer,
  userMessage,
}) {
  const conversationHistory =
    await getRecentMessages(
      customer.id
    );

  const activeOrder =
    await getActiveOrder(
      customer.id
    );

  const latestOrder =
    await getLatestOrder(
      customer.id
    );

  const decision =
    await callFetchAI({
      userMessage,

      conversationHistory,

      activeOrder,

      latestOrder,

      customer,
    });

  console.log(
    "FETCH AI DECISION:",
    JSON.stringify(
      decision,
      null,
      2
    )
  );


  let order =
    activeOrder;


  /* =======================================================
     STATUS
  ======================================================= */

  if (
    decision.intent ===
    "status"
  ) {
    const statusOrder =
      activeOrder ||
      latestOrder;

    if (!statusOrder) {
      return {
        reply:
          decision.reply ||
          "I don't see an order for you yet. Tell me what you'd like to buy.",

        order:
          null,

        shouldDispatch:
          false,
      };
    }

    return {
      reply:
        decision.reply ||
        getOrderStatusText(
          statusOrder.status
        ),

      order:
        statusOrder,

      shouldDispatch:
        false,
    };
  }


  /* =======================================================
     CANCEL
  ======================================================= */

  if (
    decision.intent ===
    "cancel"
  ) {
    if (!activeOrder) {
      return {
        reply:
          decision.reply ||
          "I don't see an active order to cancel.",

        order:
          null,

        shouldDispatch:
          false,
      };
    }

    if (
      PROCESSING_ORDER_STATUSES.includes(
        activeOrder.status
      ) &&
      activeOrder.status !==
        "finding_shopper"
    ) {
      return {
        reply:
          decision.reply ||
          "Your order is already being processed, so I can't cancel it automatically right now.",

        order:
          activeOrder,

        shouldDispatch:
          false,
      };
    }

    order =
      await updateOrder(
        activeOrder.id,
        {
          status:
            "cancelled",

          shopper_id:
            null,
        }
      );

    return {
      reply:
        decision.reply ||
        "Done. I've cancelled the order.",

      order,

      shouldDispatch:
        false,
    };
  }


  /* =======================================================
     REJECT
  ======================================================= */

  if (
    decision.intent ===
      "reject" ||
    isRejection(
      userMessage
    )
  ) {
    if (
      activeOrder?.status ===
      "awaiting_confirmation"
    ) {
      order =
        await updateOrder(
          activeOrder.id,
          {
            status:
              "collecting_details",
          }
        );
    }

    return {
      reply:
        decision.reply ||
        "No problem 👍 Tell me what you'd like to change.",

      order,

      shouldDispatch:
        false,
    };
  }


  /* =======================================================
     CONFIRM
     
     IMPORTANT FIX:
     
     A confirmed order can be:
     
     awaiting_confirmation
     OR
     finding_shopper with no shopper
     
     The latter was the bug in your previous test.
  ======================================================= */

  if (
    decision.intent ===
      "confirm" ||
    isConfirmation(
      userMessage
    )
  ) {
    console.log(
      "FETCH CONFIRMATION HANDLER:",
      JSON.stringify({
        activeOrderId:
          activeOrder?.id,

        activeOrderStatus:
          activeOrder?.status,

        activeShopperId:
          activeOrder?.shopper_id,
      })
    );


    /*
     * Normal confirmation.
     */
    if (
      activeOrder?.status ===
      "awaiting_confirmation"
    ) {
      order =
        await updateOrder(
          activeOrder.id,
          {
            status:
              "finding_shopper",

            shopper_id:
              null,
          }
        );

      console.log(
        "FETCH CONFIRMATION: ORDER MOVED TO FINDING SHOPPER"
      );

      return {
        reply:
          `Confirmed 👍 I'm finding a shopper for your order now.`,

        order,

        shouldDispatch:
          true,
      };
    }


    /*
     * IMPORTANT:
     *
     * If the order is already finding_shopper
     * and has no shopper, dispatch it again.
     */
    if (
      activeOrder?.status ===
        "finding_shopper" &&
      !activeOrder.shopper_id
    ) {
      console.log(
        "FETCH CONFIRMATION: EXISTING FINDING_SHOPPER ORDER HAS NO SHOPPER — DISPATCHING NOW"
      );

      return {
        reply:
          `Confirmed 👍 I'm finding a shopper for your order now.`,

        order:
          activeOrder,

        shouldDispatch:
          true,
      };
    }


    /*
     * If shopper is already assigned,
     * don't duplicate dispatch.
     */
    if (
      activeOrder?.shopper_id &&
      [
        "shopper_assigned",
        "shopping",
        "out_for_delivery",
      ].includes(
        activeOrder.status
      )
    ) {
      return {
        reply:
          `Your order is already being handled by a shopper. 👍`,

        order:
          activeOrder,

        shouldDispatch:
          false,
      };
    }


    /*
     * Other active order.
     */
    if (activeOrder) {
      return {
        reply:
          decision.reply ||
          "Your current order is already being processed.",

        order:
          activeOrder,

        shouldDispatch:
          false,
      };
    }


    /*
     * No order.
     */
    return {
      reply:
        decision.reply ||
        "Sure 👍 Tell me what you'd like to order.",

      order:
        null,

      shouldDispatch:
        false,
    };
  }


  /* =======================================================
     SHOPPING REQUEST / ORDER UPDATE
  ======================================================= */

  if (
    decision.intent ===
      "shopping_request" ||
    decision.intent ===
      "update_order"
  ) {
    /*
     * Existing processing order.
     */
    if (
      activeOrder &&
      PROCESSING_ORDER_STATUSES.includes(
        activeOrder.status
      )
    ) {
      return {
        reply:
          decision.reply ||
          "Your current order is already being processed. If you want a separate order, tell me it's a new order.",

        order:
          activeOrder,

        shouldDispatch:
          false,
      };
    }


    /*
     * Existing draft.
     */
    if (
      activeOrder &&
      [
        "collecting_details",
        "awaiting_confirmation",
      ].includes(
        activeOrder.status
      )
    ) {
      const updates =
        {};

      if (
        decision.store
      ) {
        updates.store_name =
          decision.store;
      }

      if (
        decision.items
      ) {
        updates.items =
          decision.items;
      }

      if (
        decision.budget !==
          null &&
        decision.budget !==
          undefined
      ) {
        updates.budget =
          decision.budget;
      }

      if (
        decision.delivery_address
      ) {
        updates.delivery_address =
          decision.delivery_address;

        await updateCustomerAddress(
          customer.id,

          decision.delivery_address
        );
      }

      const mergedOrder =
        {
          ...activeOrder,
          ...updates,
        };

      const missing =
        missingRequiredFields(
          mergedOrder
        );

      if (
        missing.length ===
        0
      ) {
        updates.status =
          "awaiting_confirmation";
      } else {
        updates.status =
          "collecting_details";
      }

      order =
        await updateOrder(
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

        shouldDispatch:
          false,
      };
    }


    /*
     * New order.
     */

    const store =
      decision.store ||
      null;

    const items =
      decision.items ||
      null;

    const deliveryAddress =
      decision.delivery_address ||
      customer.address ||
      null;

    const budget =
      decision.budget !==
        null &&
      decision.budget !==
        undefined
        ? decision.budget
        : null;

    const missing =
      [];

    if (!store) {
      missing.push(
        "store"
      );
    }

    if (!items) {
      missing.push(
        "items"
      );
    }

    if (!deliveryAddress) {
      missing.push(
        "delivery address"
      );
    }


    if (
      missing.length > 0
    ) {
      order =
        await createOrder({
          customerId:
            customer.id,

          storeName:
            store ||
            "Not specified",

          items:
            items ||
            "Not specified",

          budget,

          deliveryAddress,

          status:
            "collecting_details",
        });

      if (
        deliveryAddress
      ) {
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

        shouldDispatch:
          false,
      };
    }


    /*
     * Complete order waiting for confirmation.
     */

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

      shouldDispatch:
        false,
    };
  }


  /* =======================================================
     GENERAL CONVERSATION
  ======================================================= */

  return {
    reply:
      decision.reply ||
      "I'm Fetch 👋 How can I help?",

    order:
      activeOrder ||
      null,

    shouldDispatch:
      false,
  };
}


/* =========================================================
   CUSTOMER MESSAGE
========================================================= */

async function handleCustomerMessage({
  phone,
  userMessage,
}) {
  const customer =
    await getOrCreateCustomer(
      phone
    );

  const activeOrderBefore =
    await getActiveOrder(
      customer.id
    );

  await saveMessage({
    customerId:
      customer.id,

    orderId:
      activeOrderBefore?.id ||
      null,

    phone,

    role:
      "user",

    message:
      userMessage,
  });


  let result;

  try {
    result =
      await processMessage({
        customer,

        userMessage,
      });
  } catch (error) {
    console.error(
      "FETCH AI PROCESSING ERROR:",
      error
    );

    let latestOrder =
      null;

    try {
      latestOrder =
        await getLatestOrder(
          customer.id
        );
    } catch {}

    result = {
      reply:
        buildFallbackReply({
          userMessage,

          activeOrder:
            activeOrderBefore,

          latestOrder,
        }),

      order:
        activeOrderBefore,

      shouldDispatch:
        false,
    };
  }


  const reply =
    result.reply?.trim();

  if (reply) {
    await saveMessage({
      customerId:
        customer.id,

      orderId:
        result.order?.id ||
        activeOrderBefore?.id ||
        null,

      phone,

      role:
        "assistant",

      message:
        reply,
    });
  }


  /*
   * Send the confirmation/customer response.
   */
  if (reply) {
    await sendWhatsAppMessage(
      phone,
      reply
    );
  }


  /* =======================================================
     SHOPPER DISPATCH
  ======================================================= */

  if (
    result.shouldDispatch &&
    result.order
  ) {
    console.log(
      "FETCH DISPATCH TRIGGERED FROM CUSTOMER CONFIRMATION:",
      JSON.stringify({
        orderId:
          result.order.id,

        status:
          result.order.status,

        shopperId:
          result.order.shopper_id,
      })
    );

    const dispatchResult =
      await dispatchOrder(
        result.order
      );

    console.log(
      "FETCH DISPATCH RESULT:",
      JSON.stringify(
        dispatchResult
      )
    );


    if (
      dispatchResult.success
    ) {
      const dispatchReply =
        `🛍️ I've sent your order to an available shopper.\n\n` +
        `I'll let you know as soon as someone accepts it.`;

      await saveMessage({
        customerId:
          customer.id,

        orderId:
          result.order.id,

        phone,

        role:
          "assistant",

        message:
          dispatchReply,
      });

      await sendWhatsAppMessage(
        phone,
        dispatchReply
      );
    } else {
      const noShopperReply =
        `I've confirmed your order 👍\n\n` +
        `I'm still looking for an available shopper. Your order remains open.`;

      await saveMessage({
        customerId:
          customer.id,

        orderId:
          result.order.id,

        phone,

        role:
          "assistant",

        message:
          noShopperReply,
      });

      await sendWhatsAppMessage(
        phone,
        noShopperReply
      );
    }
  }
}


/* =========================================================
   MAIN MESSAGE ROUTER
========================================================= */

async function handleIncomingMessage(
  message
) {
  if (!message) {
    return;
  }

  if (
    message.type !==
    "text"
  ) {
    console.log(
      "FETCH NON-TEXT MESSAGE IGNORED"
    );

    return;
  }

  const phone =
    normalizePhone(
      message.from
    );

  const userMessage =
    message.text?.body?.trim();

  if (
    !phone ||
    !userMessage
  ) {
    return;
  }

  console.log(
    `FETCH INCOMING MESSAGE FROM ${phone}: ${userMessage}`
  );


  /*
   * FIRST:
   * determine whether this number is
   * a shopper.
   */
  let shopper =
    null;

  try {
    shopper =
      await getShopperByPhone(
        phone
      );
  } catch (error) {
    console.error(
      "FETCH SHOPPER LOOKUP ERROR:",
      error
    );
  }


  /*
   * Existing shopper OR START/JOIN.
   */
  if (
    shopper ||
    isShopperStart(
      userMessage
    )
  ) {
    if (!shopper) {
      try {
        shopper =
          await getOrCreateShopper(
            phone
          );
      } catch (error) {
        console.error(
          "FETCH SHOPPER CREATION ERROR:",
          error
        );

        await sendWhatsAppMessage(
          phone,
          `Sorry — I couldn't register you as a Fetch shopper right now. Please try START again.`
        );

        return;
      }
    }

    await handleShopperMessage({
      shopper,

      userMessage,
    });

    return;
  }


  /*
   * Otherwise:
   * customer.
   */
  await handleCustomerMessage({
    phone,

    userMessage,
  });
}


/* =========================================================
   WEBHOOK VERIFICATION
========================================================= */

export async function GET(
  request
) {
  const url =
    new URL(
      request.url
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
    mode ===
      "subscribe" &&
    token ===
      WHATSAPP_VERIFY_TOKEN
  ) {
    return textResponse(
      challenge ||
        "",
      200
    );
  }

  return textResponse(
    "Forbidden",
    403
  );
}


/* =========================================================
   WEBHOOK POST
========================================================= */

export async function POST(
  request
) {
  try {
    const rawBody =
      await request.text();

    let body;

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

    console.log(
      "FETCH WEBHOOK RECEIVED:",
      JSON.stringify(
        body,
        null,
        2
      )
    );

    const entries =
      Array.isArray(
        body.entry
      )
        ? body.entry
        : [];

    for (
      const entry of
        entries
    ) {
      const changes =
        Array.isArray(
          entry.changes
        )
          ? entry.changes
          : [];

      for (
        const change of
          changes
      ) {
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

        for (
          const message of
            messages
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
      "FETCH WEBHOOK ERROR:",
      error
    );

    return jsonResponse({
      success:
        false,
    });
  }
}
