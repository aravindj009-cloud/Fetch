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

const FETCH_FEE = 0;
const MIN_DELIVERY_FEE = 20;
const DELIVERY_RATE_PER_KM = 10;
const DISTANCE_DECIMAL_PLACES = 2;

// Free MVP distance routing. This can be replaced by Google Routes later.
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const OSRM_URL = "https://router.project-osrm.org/route/v1/driving";
const FETCH_DISTANCE_USER_AGENT = "Fetch MVP/1.0";

// OpenAI can temporarily return HTTP 429 when the organization
// or model is rate-limited. Keep retries short and fall back
// locally instead of making WhatsApp feel broken.
const OPENAI_MAX_RETRIES = 1;
const OPENAI_RETRY_DELAY_MS = 1500;

function sleep(ms) {
  return new Promise((resolve) =>
    setTimeout(resolve, ms)
  );
}

/* =========================================================
   HELPERS
========================================================= */

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
   STORES + DELIVERY PRICING
========================================================= */

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

async function getStoreByName(storeName) {
  const requested = normalizeText(storeName);

  if (!requested) {
    return null;
  }

  try {
    const data = await supabaseRequest(
      "stores?active=eq.true&select=*&order=name.asc&limit=100"
    );

    if (!Array.isArray(data)) {
      return null;
    }

    return (
      data.find(
        (store) =>
          normalizeText(store?.name) === requested
      ) || null
    );
  } catch (error) {
    console.error(
      "FETCH STORE LOOKUP ERROR:",
      error
    );
    return null;
  }
}

async function updateStoreLocation(
  storeId,
  latitude,
  longitude
) {
  if (!storeId || latitude == null || longitude == null) {
    return;
  }

  try {
    await supabaseRequest(
      `stores?id=eq.${encodeURIComponent(storeId)}`,
      {
        method: "PATCH",
        headers: {
          Prefer: "return=minimal",
        },
        body: JSON.stringify({
          latitude,
          longitude,
        }),
      }
    );
  } catch (error) {
    console.error(
      "FETCH STORE LOCATION SAVE ERROR:",
      error
    );
  }
}

async function geocodeAddress(address) {
  const query = String(address || "").trim();

  if (!query) {
    throw new Error("Address is missing for geocoding");
  }

  const url =
    `${NOMINATIM_URL}?format=jsonv2&limit=1&countrycodes=in&q=${encodeURIComponent(query)}`;

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": FETCH_DISTANCE_USER_AGENT,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Nominatim ${response.status}`
    );
  }

  const data = await response.json();
  const result = Array.isArray(data) && data.length
    ? data[0]
    : null;

  if (!result?.lat || !result?.lon) {
    throw new Error(
      `Unable to geocode address: ${query}`
    );
  }

  return {
    latitude: Number(result.lat),
    longitude: Number(result.lon),
    displayName: result.display_name || query,
  };
}

async function getCoordinatesForStore(store) {
  if (
    store?.latitude != null &&
    store?.longitude != null
  ) {
    return {
      latitude: Number(store.latitude),
      longitude: Number(store.longitude),
    };
  }

  const coordinates = await geocodeAddress(
    store?.address
  );

  if (store?.id) {
    await updateStoreLocation(
      store.id,
      coordinates.latitude,
      coordinates.longitude
    );
  }

  return coordinates;
}

async function calculateRoadDistanceKmFromCoordinates(
  store,
  destinationLatitude,
  destinationLongitude
) {
  const storeCoordinates =
    await getCoordinatesForStore(store);

  const latitude = Number(destinationLatitude);
  const longitude = Number(destinationLongitude);

  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude)
  ) {
    throw new Error(
      "Destination coordinates are invalid"
    );
  }

  const coordinates =
    `${storeCoordinates.longitude},${storeCoordinates.latitude};` +
    `${longitude},${latitude}`;

  const response = await fetch(
    `${OSRM_URL}/${coordinates}?overview=false&steps=false`,
    {
      headers: {
        Accept: "application/json",
      },
    }
  );

  if (!response.ok) {
    throw new Error(
      `OSRM ${response.status}`
    );
  }

  const data = await response.json();
  const meters =
    data?.routes?.[0]?.distance;

  if (typeof meters !== "number" || !Number.isFinite(meters)) {
    throw new Error(
      "Road distance could not be calculated"
    );
  }

  return Number(
    (meters / 1000).toFixed(
      DISTANCE_DECIMAL_PLACES
    )
  );
}

async function calculateRoadDistanceKm(
  store,
  deliveryAddress
) {
  const destination =
    await geocodeAddress(deliveryAddress);

  return calculateRoadDistanceKmFromCoordinates(
    store,
    destination.latitude,
    destination.longitude
  );
}

function calculateDeliveryFee(distanceKm) {
  const distance = Number(distanceKm);

  if (!Number.isFinite(distance) || distance < 0) {
    throw new Error(
      "A valid delivery distance is required"
    );
  }

  return Math.max(
    MIN_DELIVERY_FEE,
    Number(
      (distance * DELIVERY_RATE_PER_KM).toFixed(2)
    )
  );
}

async function applyDeliveryPricingFromCoordinates(
  order,
  latitude,
  longitude
) {
  if (!order?.id) {
    throw new Error(
      "Order is required for delivery pricing"
    );
  }

  const store =
    await getStoreByName(order.store_name);

  if (!store) {
    throw new Error(
      `Store not found in Fetch stores: ${order.store_name}`
    );
  }

  const distanceKm =
    await calculateRoadDistanceKmFromCoordinates(
      store,
      latitude,
      longitude
    );

  const deliveryFee =
    calculateDeliveryFee(distanceKm);

  const updated =
    await updateOrder(
      order.id,
      {
        store_id: store.id,
        item_total: Number(order.item_total || 0),
        fetch_fee: FETCH_FEE,
        delivery_rate_per_km:
          DELIVERY_RATE_PER_KM,
        distance_km: distanceKm,
        delivery_fee: deliveryFee,
        total_amount:
          Number(order.item_total || 0) +
          FETCH_FEE +
          deliveryFee,
        delivery_pricing_status:
          "calculated",
        delivery_pricing_source:
          "whatsapp_location_osrm_mvp",
        payment_status:
          order.payment_status ||
          "pending",
        priced_at:
          new Date().toISOString(),
        status:
          "awaiting_confirmation",
      }
    );

  if (!updated) {
    throw new Error(
      "Order pricing update returned no order"
    );
  }

  return updated;
}

async function applyDeliveryPricing(order) {
  if (!order?.id) {
    throw new Error(
      "Order is required for delivery pricing"
    );
  }

  const store =
    await getStoreByName(order.store_name);

  if (!store) {
    throw new Error(
      `Store not found in Fetch stores: ${order.store_name}`
    );
  }

  const distanceKm =
    await calculateRoadDistanceKm(
      store,
      order.delivery_address
    );

  const deliveryFee =
    calculateDeliveryFee(distanceKm);

  const updated =
    await updateOrder(
      order.id,
      {
        store_id: store.id,
        item_total: Number(order.item_total || 0),
        fetch_fee: FETCH_FEE,
        delivery_rate_per_km:
          DELIVERY_RATE_PER_KM,
        distance_km: distanceKm,
        delivery_fee: deliveryFee,
        total_amount:
          Number(order.item_total || 0) +
          FETCH_FEE +
          deliveryFee,
        delivery_pricing_status:
          "calculated",
        delivery_pricing_source:
          "osm_osrm_mvp",
        payment_status:
          order.payment_status ||
          "pending",
        priced_at:
          new Date().toISOString(),
        status:
          "awaiting_confirmation",
      }
    );

  if (!updated) {
    throw new Error(
      "Order pricing update returned no order"
    );
  }

  return updated;
}

function formatRupees(amount) {
  const value = Number(amount || 0);
  return value.toFixed(2).replace(/\.00$/, "");
}

function buildPricingConfirmationMessage(order) {
  const distance = Number(order.distance_km || 0);
  const deliveryFee = Number(order.delivery_fee || 0);

  const budgetLine =
    order.budget != null
      ? `\n💰 Item budget: ₹${formatRupees(order.budget)}`
      : "";

  return (
    `Sure 👍 Here's your Fetch order:\n\n` +
    `🏪 Store: ${order.store_name}\n` +
    `🛒 Items: ${order.items}\n` +
    `📍 Deliver to: ${order.delivery_address}${budgetLine}\n\n` +
    `📏 Delivery distance: ${distance.toFixed(2)} km\n` +
    `🚚 Delivery charge: ₹${formatRupees(deliveryFee)}\n` +
    `💼 Fetch fee: ₹0\n\n` +
    `Shall I confirm this order?`
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

          item_total: 0,

          fetch_fee: FETCH_FEE,

          delivery_fee: 0,

          total_amount: 0,

          shopper_earnings: 0,

          payment_status: "pending",

          delivery_pricing_status: "pending",

          delivery_rate_per_km:
            DELIVERY_RATE_PER_KM,
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
   MESSAGE MEMORY
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
  try {
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
  } catch (error) {
    console.error(
      "FETCH SUBSTITUTION LOOKUP ERROR:",
      error
    );

    return null;
  }
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

  if (
    regex.test(currentItems)
  ) {
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
10. The "items" field must contain ONLY products explicitly requested in the latest customer message.
11. Never copy old customer messages, assistant replies, confirmations, cancellations, store names, pricing text, or conversation history into "items".
12. For a clearly new shopping request, treat the latest message as a new order rather than modifying an older order.
13. For an item addition, add only the item explicitly mentioned in the latest message.
14. Return only the JSON requested.
11. The items field must contain ONLY actual products the customer wants Fetch to buy. NEVER copy greetings, confirmations, cancellations, questions, store names, addresses, or previous conversation messages into the items field.
12. When an active order exists, treat active_order.items as the source of truth. Only change the item list when the CURRENT customer message clearly adds, removes, or replaces products.
13. Do not use old conversation history to invent or append products. The current customer message is the authority for the requested change.
14. If the current message is a confirmation such as YES, keep the items field exactly equal to the active order items.
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
      history
        .filter(
          (message) =>
            message?.role === "assistant"
        )
        .slice(-3),

    current_message:
      userMessage,
  };

  let response = null;
  let data = null;

  for (
    let attempt = 0;
    attempt <= OPENAI_MAX_RETRIES;
    attempt += 1
  ) {
    response =
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

    data =
      await response.json();

    if (response.ok) {
      break;
    }

    if (
      response.status === 429 &&
      attempt < OPENAI_MAX_RETRIES
    ) {
      console.warn(
        "FETCH OPENAI RATE LIMITED; RETRYING ONCE..."
      );

      await sleep(
        OPENAI_RETRY_DELAY_MS
      );

      continue;
    }

    if (response.status === 429) {
      throw new Error(
        "OPENAI_RATE_LIMITED: The OpenAI API is temporarily rate-limited."
      );
    }

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

  const greeting =
    /^(hi|hello|hey|helo|hii|hiii|namaste|namaskaram|good morning|good afternoon|good evening)$/i.test(
      text
    );

  if (greeting) {
    return {
      intent:
        "greeting",

      store_name:
        "",

      items:
        "",

      delivery_address:
        "",

      budget:
        null,

      reply:
        "Hi 👋 I’m Fetch. Tell me what you’d like me to fetch, which store, and where to deliver it." ,
    };
  }

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

  if (
    activeOrder &&
    /^(add|also|include|and)\s+/i.test(
      text
    )
  ) {
    const additionalItems =
      text.replace(
        /^(add|also|include|and)\s+/i,
        ""
      ).trim();

    if (additionalItems) {
      return {
        intent:
          "update_order",

        store_name:
          activeOrder.store_name,

        items:
          `${activeOrder.items}; ${additionalItems}`,

        delivery_address:
          activeOrder.delivery_address ||
          customer?.address ||
          "",

        budget:
          activeOrder.budget ??
          null,

        reply:
          `Added ${additionalItems}. I’ll recalculate the delivery charge before confirmation.`,
      };
    }
  }

    // Deterministic item-only new orders are handled before the
  // short-message "add to active order" fallback.
  if (
    isExplicitNewOrderRequest(text)
  ) {
    const deterministicParts =
      extractDeterministicShoppingRequest(
        text
      );

    if (
      deterministicParts
    ) {
      return {
        intent:
          "shopping_request",

        store_name:
          deterministicParts.store,

        items:
          deterministicParts.items,

        delivery_address:
          deterministicParts.address,

        budget:
          null,

        reply:
          `Got it — ${deterministicParts.items}.`,
      };
    }
  }

  // Common natural shopping-request shapes. This is only a
  // temporary fallback for OpenAI rate-limit periods.
  const shoppingPatterns = [
    /^(?:i\s+want|i\s+need|fetch|get|buy|please\s+get|can\s+you\s+get)\s+(.+?)\s+(?:from|at)\s+(.+?)\s+(?:deliver(?:\s+it)?\s+to|delivery\s+to|to)\s+(.+)$/i,
    /^(.+?)\s+(?:from|at)\s+(.+?)\s+(?:deliver(?:\s+it)?\s+to|delivery\s+to|to)\s+(.+)$/i,
  ];

  for (
    const pattern of shoppingPatterns
  ) {
    const match =
      text.match(pattern);

    if (match) {
      return {
        intent:
          "shopping_request",

        store_name:
          match[2].trim(),

        items:
          match[1].trim(),

        delivery_address:
          match[3].trim(),

        budget:
          null,

        reply:
          `Got it — ${match[1].trim()} from ${match[2].trim()}.`,
      };
    }
  }

  // Only treat a short message as an addition when it is not an explicit new-order request.
  if (
    activeOrder &&
    !isExplicitNewOrderRequest(text) &&
    text.length >= 2 &&
    text.length <= 80 &&
    !/[?]$/.test(text) &&
    !/^(new order|cancel|status|track|help)$/i.test(text)
  ) {
    return {
      intent:
        "update_order",

      store_name:
        activeOrder.store_name,

      items:
        `${activeOrder.items}; ${text}`,

      delivery_address:
        activeOrder.delivery_address ||
        customer?.address ||
        "",

      budget:
        activeOrder.budget ??
        null,

      reply:
        `Added ${text}. I’ll recalculate the delivery charge before confirmation.`,
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
   CUSTOMER COMMAND / ITEM SAFETY
========================================================= */

function normalizeCustomerText(text) {
  return String(text || '')
    .trim()
    .replace(/\s+/g, ' ');
}

function extractDeterministicShoppingRequest(text) {
  const value = normalizeCustomerText(text);
  if (!value) return null;

  // Full request with store and optional delivery location.
  const explicitPattern =
    /^(?:i\s+want|i\s+need|i'd\s+like|i\s+would\s+like|please\s+get|please\s+fetch|can\s+you\s+get|can\s+you\s+fetch|get\s+me|fetch\s+me|buy\s+me|order)\s+(.+?)\s+(?:from|at)\s+(.+?)(?:\s*,?\s*(?:deliver(?:\s+it)?\s+to|delivery\s+to|to)\s+(.+))?$/i;

  const match =
    value.match(explicitPattern);

  if (match) {
    return {
      items:
        cleanNewOrderItems(
          match[1]
        ),
      store:
        match[2].trim(),
      address:
        match[3]?.trim() || "",
    };
  }

  // Item-only request. This MUST still count as a fresh order.
  // The store and location will be collected next without
  // borrowing them from the previous order.
  const itemOnlyPattern =
    /^(?:i\s+want|i\s+need|i'd\s+like|i\s+would\s+like|please\s+get|please\s+fetch|get\s+me|fetch\s+me|buy\s+me|order)\s+(.+)$/i;

  const itemOnlyMatch =
    value.match(
      itemOnlyPattern
    );

  if (
    itemOnlyMatch &&
    itemOnlyMatch[1]?.trim()
  ) {
    const items =
      cleanNewOrderItems(
        itemOnlyMatch[1]
      );

    if (items) {
      return {
        items,
        store: "",
        address: "",
      };
    }
  }

  return null;
}

function cleanNewOrderItems(items) {
  return String(items || "")
    .trim()
    .replace(/\b(?:yes|yeah|yep|ya|okay|ok|sure)\b/gi, " ")
    .replace(/\b(?:please\s+confirm(?:\s+my\s+order)?|confirm(?:\s+my\s+order)?)\b/gi, " ")
    .replace(/\b(?:cancel(?:\s+the|\s+my)?\s+order)\b/gi, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/^[,;.\s]+|[,;.\s]+$/g, "")
    .trim();
}

function looksLikeNearbyStoreRequest(text) {
  const value = normalizeCustomerText(text).toLowerCase();
  return (
    /\b(?:any|some|any\s+local|local|nearby|nearest|closest)\b/.test(value) &&
    /\b(?:shop|shops|store|stores)\b/.test(value)
  );
}

function isPendingStoreName(storeName) {
  return /^pending\s+(?:store|nearby\s+store)$/i.test(
    String(storeName || "").trim()
  );
}

function isExplicitNewOrderRequest(text) {
  const value = normalizeCustomerText(text).toLowerCase();
  if (!value) return false;

  return (
    /^(?:i\s+want|i\s+need|i'd\s+like|i\s+would\s+like|please\s+get|please\s+fetch|can\s+you\s+get|can\s+you\s+fetch|get\s+me|fetch\s+me|buy\s+me|order)\b/i.test(value) ||
    /^(?:enikku|ente|enikk)\b.*\b(?:venam|venda|tharanam)\b/i.test(value) ||
    /^(?:mujhe|mere\s+liye)\b.*\b(?:chahiye|chaahiye|lene|lao)\b/i.test(value) ||
    /^(?:enakku)\b.*\b(?:venum|vendum)\b/i.test(value) ||
    /^(?:naaku)\b.*\b(?:kavali|kaavali)\b/i.test(value) ||
    /^(?:nanage)\b.*\b(?:beku)\b/i.test(value)
  );
}

function isSimpleConfirmation(text) {
  const value = normalizeCustomerText(text)
    .toLowerCase()
    .replace(/[.!?]+$/g, '');

  return /^(yes|y|yeah|yep|ya|ok|okay|sure|go ahead|confirm|confirmed|please confirm|please confirm my order)$/.test(value);
}

function isSimpleRejection(text) {
  const value = normalizeCustomerText(text)
    .toLowerCase()
    .replace(/[.!?]+$/g, '');

  return /^(no|n|nope|reject|rejected|no thanks|not now)$/.test(value);
}

function isPureConversationControl(text) {
  const value = normalizeCustomerText(text)
    .toLowerCase()
    .replace(/[.!?]+$/g, '');

  return (
    isSimpleConfirmation(value) ||
    isSimpleRejection(value) ||
    isCancellationRequest(value) ||
    /^(hi|hello|hey|helo|hii|hiii|thanks|thank you|shukriya)$/.test(value) ||
    /^(where is my order|order status|track my order|track order)$/.test(value)
  );
}

function isCancellationRequest(text) {
  const value = String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ");

  if (!value) return false;

  const directPatterns = [
    /^cancel$/i,
    /^cancel it$/i,
    /^cancel this$/i,
    /^cancel the order$/i,
    /^cancel my order$/i,
    /^cancel this order$/i,
    /^please cancel (?:it|this|the order|my order)$/i,
    /^i (?:want|need) to cancel (?:it|this|the order|my order)$/i,
    /^i want (?:to )?cancel (?:it|this|the order|my order)$/i,
    /^don'?t want (?:this|the) order$/i,
    /^i don'?t want (?:this|the) order$/i,
  ];

  if (
    directPatterns.some(
      (pattern) => pattern.test(value)
    )
  ) {
    return true;
  }

  return (
    /\bcancel\b/i.test(value) &&
    /\border\b|\bit\b|\bthis\b|\bmy\b/i.test(value)
  );
}

function extractAdditionalItemsFromMessage(text) {
  let value = String(text || "").trim();

  value = value.replace(
    /^(?:add|also add|include|also include|plus|and)\s+/i,
    ""
  ).trim();

  value = value.replace(
    /\s+(?:from|at)\s+.+?(?=\s+(?:deliver(?:ed)?|delivery|to)\s+|$)/i,
    ""
  ).trim();

  value = value.replace(
    /\s+(?:deliver(?:ed)?|delivery)\s+to\s+.+$/i,
    ""
  ).trim();

  value = value.replace(
    /\s+to\s+.+$/i,
    ""
  ).trim();

  return value;
}

function extractItemsFromShoppingMessage(text) {
  const value = String(text || "").trim();

  const patterns = [
    /^(?:i\s+want|i\s+need|fetch|get|buy|order|please\s+get|can\s+you\s+get)\s+(.+?)\s+(?:from|at)\s+.+?(?:\s+(?:deliver(?:\s+it)?\s+to|delivery\s+to|to)\s+.+)?$/i,
    /^(.+?)\s+(?:from|at)\s+.+?(?:\s+(?:deliver(?:\s+it)?\s+to|delivery\s+to|to)\s+.+)$/i,
  ];

  for (const pattern of patterns) {
    const match = value.match(pattern);

    if (match?.[1]?.trim()) {
      return match[1].trim();
    }
  }

  return "";
}

function looksLikeContaminatedItems(items) {
  const value = String(items || "").trim();

  if (!value) return true;

  const lower = value.toLowerCase();

  const badSignals = [
    /\bplease\s+confirm\b/i,
    /\bconfirm\s+(?:my|the)\s+order\b/i,
    /\bcancel\s+(?:the|my|this)\s+order\b/i,
    /\bwhere\s+is\s+(?:my|the)\s+order\b/i,
    /\bdelivery\s+charges?\b/i,
    /\bdelivery\s+distance\b/i,
    /\bfetch\s+fee\b/i,
    /\bshall\s+i\s+confirm\b/i,
    /\bupdated\s*[👍]?\b/i,
    /\bconfirmed\s*[👍]?\b/i,
    /\byes\b/i,
    /\bno\b/i,
    /\bcancel\b/i,
    /\bplease\b.*\bconfirm\b/i,
  ];

  if (
    badSignals.some(
      (pattern) => pattern.test(value)
    )
  ) {
    return true;
  }

  // Conversation pollution in the previous bug commonly appeared
  // as multiple semicolon-separated sentences. A legitimate short
  // item list can still contain semicolons, so only flag it when
  // several segments look conversational.
  const segments = value
    .split(";")
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments.length >= 3) {
    const conversationalSegments = segments.filter(
      (segment) =>
        /\b(yes|okay|ok|confirm|confirmed|cancel|please|order|updated|shall|where)\b/i.test(
          segment
        )
    );

    if (conversationalSegments.length >= 1) {
      return true;
    }
  }

  return false;
}

async function cancelOrderAndReleaseShopper(order) {
  if (!order?.id) return;

  const jobs =
    await supabaseRequest(
      `shopper_jobs?order_id=eq.${encodeURIComponent(
        order.id
      )}&status=in.(offered,accepted)&select=*&limit=100`
    );

  const jobList = Array.isArray(jobs)
    ? jobs
    : [];

  for (const job of jobList) {
    await updateShopperJob(
      job.id,
      {
        status: "cancelled",
      }
    );

    if (job.shopper_id) {
      const shoppers =
        await supabaseRequest(
          `shoppers?id=eq.${encodeURIComponent(
            job.shopper_id
          )}&select=*&limit=1`
        );

      const shopper =
        Array.isArray(shoppers) &&
        shoppers.length
          ? shoppers[0]
          : null;

      if (shopper) {
        const shopperUpdates = {
          last_seen_at:
            new Date().toISOString(),
        };

        if (
          shopper.current_order_id ===
          order.id
        ) {
          shopperUpdates.available = true;
          shopperUpdates.current_order_id = null;
        }

        await updateShopper(
          shopper.id,
          shopperUpdates
        );

        if (
          job.status === "accepted" &&
          shopper.phone
        ) {
          await sendWhatsAppMessage(
            shopper.phone,
            `❌ This Fetch order has been cancelled by the customer. You no longer need to fulfil it.`
          );
        }
      }
    }
  }

  await updateOrder(
    order.id,
    {
      status: "cancelled",
      shopper_id: null,
    }
  );
}

/* =========================================================
   CUSTOMER ENGINE
========================================================= */

async function handleCustomerMessage({
  phone,
  userMessage,
  location = null,
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

  /* -----------------------------------------
     DETERMINISTIC NEW ORDER ISOLATION
  ----------------------------------------- */

  const deterministicRequest =
    extractDeterministicShoppingRequest(
      userMessage
    );

  if (
    deterministicRequest &&
    isExplicitNewOrderRequest(
      userMessage
    )
  ) {
    const cleanItems =
      cleanNewOrderItems(
        deterministicRequest.items
      );

    if (!cleanItems) {
      await sendWhatsAppMessage(
        normalizedPhone,
        "Tell me what you’d like me to fetch."
      );
      return;
    }

    /*
      CRITICAL:
      Every explicit "I want / I need / get me / order"
      request starts a NEW order.

      We NEVER merge it into activeOrder and we NEVER
      inherit activeOrder.items.

      This is the primary protection against the
      repeated-order contamination bug.
    */

    const requestedStore =
      String(
        deterministicRequest.store ||
        ""
      ).trim();

    const nearbyRequest =
      looksLikeNearbyStoreRequest(
        requestedStore
      ) ||
      /\b(?:any|local|nearby|nearest|closest)\b[\s\S]*\b(?:shop|store)s?\b/i.test(
        userMessage
      );

    /*
      -------------------------------------------------------
      NEW ORDER WITHOUT A SPECIFIC STORE
      -------------------------------------------------------
    */

    if (
      !requestedStore ||
      nearbyRequest
    ) {
      /*
        We still create the new order immediately so the
        exact requested items have their own order_id.

        A temporary store label is used only while details
        are being collected. It can NEVER be priced or
        dispatched to a shopper.
      */

      const pendingStore =
        nearbyRequest
          ? "Pending nearby store"
          : "Pending store";

      const newOrder =
        await createOrder({
          customerId:
            customer.id,

          storeName:
            pendingStore,

          items:
            cleanItems,

          budget:
            null,

          // Do NOT inherit the old saved address on a
          // brand-new order. Ask for a fresh address/pin.
          deliveryAddress:
            "",

          status:
            "collecting_details",
        });

      if (!newOrder) {
        throw new Error(
          "Could not create new Fetch order"
        );
      }

      await saveMessage({
        customerId:
          customer.id,

        orderId:
          newOrder.id,

        phone:
          normalizedPhone,

        role:
          "assistant",

        message:
          `New order created: ${cleanItems}`,
      });

      if (nearbyRequest) {
        await sendWhatsAppMessage(
          normalizedPhone,

          `Got it 👍\n\n🛒 Items: ${cleanItems}\n🏪 Store: nearest available local shop\n\nThis new order is separate from your previous order. Please send your WhatsApp location pin 📍. I’ll need to select an available nearby store before I can calculate the delivery distance and charge.`
        );
      } else {
        await sendWhatsAppMessage(
          normalizedPhone,

          `Got it 👍\n\n🛒 Items: ${cleanItems}\n\nThis is a new order. Which store should I use?\n\nYou can also send the delivery location pin 📍.`
        );
      }

      return;
    }

    /*
      -------------------------------------------------------
      NEW ORDER WITH A SPECIFIC STORE
      -------------------------------------------------------
    */

    const storeRecord =
      await getStoreByName(
        requestedStore
      );

    if (!storeRecord) {
      /*
        Keep the new order isolated even when the store is
        not yet registered. Do not touch or reuse the old
        order.
      */

      const newOrder =
        await createOrder({
          customerId:
            customer.id,

          storeName:
            requestedStore,

          items:
            cleanItems,

          budget:
            null,

          deliveryAddress:
            "",

          status:
            "collecting_details",
        });

      await sendWhatsAppMessage(
        normalizedPhone,

        `Got it 👍\n\n🛒 Items: ${cleanItems}\n🏪 Store: ${requestedStore}\n\nI don’t have this store in the Fetch store list yet. Please send the store address, or choose one of the Fetch stores already available.`
      );

      return;
    }

    const deliveryAddress =
      deterministicRequest.address ||
      "";

    const newOrder =
      await createOrder({
        customerId:
          customer.id,

        storeName:
          storeRecord.name,

        items:
          cleanItems,

        budget:
          null,

        deliveryAddress:
          deliveryAddress,

        status:
          "collecting_details",
      });

    if (!deliveryAddress) {
      await sendWhatsAppMessage(
        normalizedPhone,

        `Got it 👍\n\n🏪 Store: ${storeRecord.name}\n🛒 Items: ${cleanItems}\n\nPlease send the delivery address or WhatsApp location pin 📍.`
      );

      return;
    }

    try {
      const pricedOrder =
        await applyDeliveryPricing(
          newOrder
        );

      const reply =
        buildPricingConfirmationMessage(
          pricedOrder
        );

      await saveMessage({
        customerId:
          customer.id,

        orderId:
          pricedOrder.id,

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
    } catch (pricingError) {
      console.error(
        "FETCH DETERMINISTIC NEW ORDER PRICING ERROR:",
        pricingError
      );

      await sendWhatsAppMessage(
        normalizedPhone,

        `Got it 👍\n\n🏪 Store: ${storeRecord.name}\n🛒 Items: ${cleanItems}\n📍 Deliver to: ${deliveryAddress}\n\n🚚 Delivery charges: Minimum ₹20. After that, ₹10 per km based on the delivery distance.\n\nPlease share your WhatsApp location pin 📍 so I can calculate the exact delivery charge.`
      );
    }

    return;
  }

  /* -----------------------------------------
     DETERMINISTIC CANCELLATION
  ----------------------------------------- */

  if (isCancellationRequest(userMessage)) {
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

    if (!activeOrder) {
      const reply =
        "There isn’t an active order to cancel.";

      await saveMessage({
        customerId:
          customer.id,

        orderId:
          latestOrder?.id ||
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

    await cancelOrderAndReleaseShopper(
      activeOrder
    );

    const reply =
      "Done — I’ve cancelled your order.";

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

    return;
  }

  /* -----------------------------------------
     WHATSAPP LOCATION
  ----------------------------------------- */

  if (
    location &&
    Number.isFinite(Number(location.latitude)) &&
    Number.isFinite(Number(location.longitude))
  ) {
    const locationLabel =
      [
        location.name,
        location.address,
      ]
        .map((value) => String(value || "").trim())
        .filter(Boolean)
        .join(", ");

    if (
      !activeOrder ||
      ![
        "collecting_details",
        "awaiting_confirmation",
      ].includes(activeOrder.status)
    ) {
      await saveMessage({
        customerId: customer.id,
        orderId: latestOrder?.id || null,
        phone: normalizedPhone,
        role: "user",
        message: "WhatsApp location pin shared",
      });

      await sendWhatsAppMessage(
        normalizedPhone,
        "I received your location 📍. Tell me what you’d like to fetch and which store."
      );

      return;
    }

    const deliveryAddress =
      locationLabel ||
      activeOrder.delivery_address ||
      "WhatsApp location";

    await saveMessage({
      customerId: customer.id,
      orderId: activeOrder.id,
      phone: normalizedPhone,
      role: "user",
      message: "WhatsApp location pin shared",
    });

    const updatedOrder =
      await updateOrder(
        activeOrder.id,
        {
          delivery_address: deliveryAddress,
          distance_km: null,
          delivery_fee: 0,
          total_amount: 0,
          delivery_pricing_status: "pending",
          delivery_pricing_source: null,
          priced_at: null,
          status: "collecting_details",
        }
      );

    if (!updatedOrder) {
      await sendWhatsAppMessage(
        normalizedPhone,
        "I received your location, but I couldn’t update the order. Please send the location again."
      );
      return;
    }

    if (
      isPendingStoreName(
        updatedOrder.store_name
      )
    ) {
      await sendWhatsAppMessage(
        normalizedPhone,

        "Location received 📍. Your new order is saved separately. Please tell me the specific store to use so I can calculate the exact road distance and delivery charge."
      );

      return;
    }

    try {
      const pricedOrder =
        await applyDeliveryPricingFromCoordinates(
          updatedOrder,
          Number(location.latitude),
          Number(location.longitude)
        );

      const reply =
        buildPricingConfirmationMessage(
          pricedOrder
        );

      await saveMessage({
        customerId: customer.id,
        orderId: pricedOrder.id,
        phone: normalizedPhone,
        role: "assistant",
        message: reply,
      });

      await sendWhatsAppMessage(
        normalizedPhone,
        reply
      );
    } catch (error) {
      console.error(
        "FETCH WHATSAPP LOCATION PRICING ERROR:",
        error
      );

      await sendWhatsAppMessage(
        normalizedPhone,
        "I received your exact location 📍, but I couldn’t calculate the road distance right now. Please send the location pin once more in a moment."
      );
    }

    return;
  }

  /* -----------------------------------------
     PENDING SUBSTITUTION
  ----------------------------------------- */

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

  /* -----------------------------------------
     DETERMINISTIC CONFIRM / REJECT
  ----------------------------------------- */

  if (
    activeOrder &&
    activeOrder.status ===
      "awaiting_confirmation" &&
    isSimpleConfirmation(userMessage)
  ) {
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
    activeOrder &&
    activeOrder.status ===
      "awaiting_confirmation" &&
    isSimpleRejection(userMessage)
  ) {
    await updateOrder(
      activeOrder.id,
      {
        status:
          "cancelled",
        shopper_id:
          null,
      }
    );

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

    await sendWhatsAppMessage(
      normalizedPhone,
      "Okay 👍 I won’t place that order."
    );

    return;
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

  /* -----------------------------------------
     SAFETY NORMALIZATION OF AI ORDER FIELDS
  ----------------------------------------- */

  if (
    activeOrder &&
    decision.intent === "update_order"
  ) {
    const currentItems =
      String(
        activeOrder.items ||
        ""
      ).trim();

    if (
      isPureConversationControl(
        userMessage
      )
    ) {
      decision.items =
        currentItems;
    } else if (
      looksLikeContaminatedItems(
        decision.items
      )
    ) {
      const additionalItems =
        extractAdditionalItemsFromMessage(
          userMessage
        );

      if (
        additionalItems &&
        !looksLikeContaminatedItems(
          additionalItems
        )
      ) {
        decision.items =
          currentItems
            ? `${currentItems}; ${additionalItems}`
            : additionalItems;
      } else {
        decision.items =
          currentItems;
      }
    }
  }

  if (
    decision.intent === "shopping_request"
  ) {
    const deterministicParts =
      extractDeterministicShoppingRequest(
        userMessage
      );

    const extractedItems =
      deterministicParts?.items ||
      extractItemsFromShoppingMessage(
        userMessage
      );

    if (extractedItems) {
      decision.items =
        cleanNewOrderItems(
          extractedItems
        );
    } else if (
      looksLikeContaminatedItems(
        decision.items
      )
    ) {
      decision.items = "";
    }
  }

  /*
    If a clear new-order message somehow reaches OpenAI
    and gets classified as update_order, force it back
    to shopping_request. The latest customer message is
    the source of truth for a new order.
  */
  if (
    isExplicitNewOrderRequest(
      userMessage
    ) &&
    decision.intent ===
      "update_order"
  ) {
    decision.intent =
      "shopping_request";

    const deterministicParts =
      extractDeterministicShoppingRequest(
        userMessage
      );

    if (
      deterministicParts
    ) {
      decision.items =
        deterministicParts.items;

      decision.store_name =
        deterministicParts.store;

      decision.delivery_address =
        deterministicParts.address;
    }
  }

  /* STATUS */

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

  /* CANCEL */

  if (
    decision.intent ===
    "cancel"
  ) {
    if (!activeOrder) {
      await sendWhatsAppMessage(
        normalizedPhone,

        "There isn’t an active order to cancel."
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

  /* REJECT */

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

  /* CONFIRM */

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

    if (
      activeOrder.delivery_pricing_status !==
        "calculated" ||
      activeOrder.distance_km == null ||
      activeOrder.delivery_fee == null
    ) {
      await sendWhatsAppMessage(
        normalizedPhone,

        "I’m still calculating the delivery distance and charge. Please wait for my delivery-price message before confirming."
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

  /* SHOPPING REQUEST */

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

    // A known store is required for the MVP distance calculation.
    const storeRecord =
      await getStoreByName(store);

    if (!storeRecord) {
      await sendWhatsAppMessage(
        normalizedPhone,

        `I can take this order, but I don’t yet have ${store} in my Fetch store list. Please send the store address so I can calculate the delivery distance and charge.`
      );

      return;
    }

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

            store_id:
              storeRecord.id,

            items,

            budget:
              decision.budget ??
              activeOrder.budget ??
              null,

            delivery_address:
              address,

            item_total: 0,

            fetch_fee: FETCH_FEE,

            delivery_fee: 0,

            total_amount: 0,

            delivery_pricing_status:
              "pending",

            delivery_pricing_source:
              null,

            priced_at: null,

            status:
              "collecting_details",
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
            "collecting_details",
        });
    }

    if (!order) {
      throw new Error(
        "Could not create or update Fetch order"
      );
    }

    let pricedOrder;

    try {
      pricedOrder =
        await applyDeliveryPricing(
          order
        );
    } catch (pricingError) {
      console.error(
        "FETCH DELIVERY PRICING ERROR:",
        pricingError
      );

      await sendWhatsAppMessage(
        normalizedPhone,

        `I have your order details 👍\n\n🏪 Store: ${store}\n🛒 Items: ${items}\n📍 Deliver to: ${address}\n\n🚚 Delivery charges: Minimum ₹20. After that, ₹10 per km based on the delivery distance.\n\nI couldn’t calculate the exact road distance right now, so I’m not asking you to confirm yet.`
      );

      return;
    }

    const reply =
      buildPricingConfirmationMessage(
        pricedOrder
      );

    await saveMessage({
      customerId:
        customer.id,

      orderId:
        pricedOrder.id,

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

  /* UPDATE ORDER */

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
      decision.items?.trim() &&
      !isPureConversationControl(
        userMessage
      ) &&
      !looksLikeContaminatedItems(
        decision.items
      )
    ) {
      updates.items =
        decision.items.trim();
    } else if (
      isPureConversationControl(
        userMessage
      )
    ) {
      updates.items =
        activeOrder.items;
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

    // Any order change invalidates the old distance/price.
    updates.item_total = 0;
    updates.fetch_fee = FETCH_FEE;
    updates.delivery_fee = 0;
    updates.total_amount = 0;
    updates.distance_km = null;
    updates.delivery_pricing_status =
      "pending";
    updates.delivery_pricing_source =
      null;
    updates.priced_at = null;
    updates.status =
      "collecting_details";

    const changedOrder =
      await updateOrder(
        activeOrder.id,
        updates
      );

    if (!changedOrder) {
      throw new Error(
        "Could not update active Fetch order"
      );
    }

    try {
      const pricedOrder =
        await applyDeliveryPricing(
          changedOrder
        );

      const reply =
        buildPricingConfirmationMessage(
          pricedOrder
        );

      await saveMessage({
        customerId:
          customer.id,

        orderId:
          pricedOrder.id,

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
    } catch (pricingError) {
      console.error(
        "FETCH DELIVERY REPRICING ERROR:",
        pricingError
      );

      await sendWhatsAppMessage(
        normalizedPhone,

        "Updated 👍\n\n🚚 Delivery charges: Minimum ₹20. After that, ₹10 per km based on the delivery distance.\n\nI couldn’t calculate the exact road distance right now, so please wait for my pricing message before confirming."
      );
    }

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

  /*
    IMPORTANT:
    This function is ONLY called for a number
    already registered in the shoppers table.
  */

  const shopper =
    await getShopperByPhone(
      normalizedPhone
    );

  if (!shopper) {
    /*
      Extra safety layer.
      Even if this function is accidentally
      called somewhere else, an unknown number
      can NEVER become a shopper.
    */

    await sendWhatsAppMessage(
      normalizedPhone,

      "You’re not registered as a Fetch shopper. Please contact Fetch to become a shopper."
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

  /* START */

  if (
    command === "START" ||
    command === "JOIN"
  ) {
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

    await sendWhatsAppMessage(
      normalizedPhone,

      `Welcome back to Fetch Shopper 🛍️\n\nYou’re now active. I’ll send you Fetch jobs here.\n\nCommands:\nACCEPT\nDECLINE\nSHOPPING\nSUBSTITUTE: old item -> new item\nPICKED UP\nOUT FOR DELIVERY\nDELIVERED\nSTATUS`
    );

    return;
  }

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

      "You don’t have an accepted Fetch job right now."
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

  const location =
    message?.location ||
    null;

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

    location:
      location
        ? {
            latitude:
              location.latitude,

            longitude:
              location.longitude,

            name:
              location.name ||
              "",

            address:
              location.address ||
              "",
          }
        : null,
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
      (!incoming.text && !incoming.location)
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
      location,
    } = incoming;

    console.log(
      "FETCH INCOMING:",
      JSON.stringify({
        from,
        text,
      })
    );

    /*
      =======================================================
      CRITICAL FETCH ROUTING

      We ONLY check whether the number already exists
      in the shoppers table.

      If YES:
          shopper flow

      If NO:
          customer flow

      There is NO automatic shopper creation here.

      Therefore:

      START from unknown number
          -> CUSTOMER

      SUBSTITUTE from unknown number
          -> CUSTOMER

      ACCEPT from unknown number
          -> CUSTOMER

      SHOPPING from unknown number
          -> CUSTOMER

      Only a number manually registered in shoppers
      can ever act as a shopper.
      =======================================================
    */

    const shopper =
      await getShopperByPhone(
        from
      );

    if (shopper) {
      await handleShopperMessage({
        phone:
          from,

        text:
          text ||
          "LOCATION",
      });
    } else {
      await handleCustomerMessage({
        phone:
          from,

        userMessage:
          text ||
          "Shared a WhatsApp location pin",

        location,
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
      Always return 200 to Meta so WhatsApp
      does not repeatedly retry the event.
    */

    return res
      .status(200)
      .json({
        success:
          false,
      });
  }
}
