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
  "awaiting_customer_price_confirmation",
  "payment_pending",
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


async function getCustomerOrders(
  customerId,
  limit = 10
) {
  const safeLimit =
    Math.max(
      1,
      Math.min(
        Number(limit) || 10,
        20
      )
    );

  const data =
    await supabaseRequest(
      `orders?customer_id=eq.${encodeURIComponent(
        customerId
      )}&select=id,store_name,items,delivery_address,status,item_total,delivery_fee,total_amount,payment_status,created_at&order=created_at.desc&limit=${safeLimit}`
    );

  return Array.isArray(data)
    ? data
    : [];
}

function shortOrderReference(id) {
  return String(id || "")
    .replace(/-/g, "")
    .slice(0, 6)
    .toUpperCase();
}

function formatOrderHistoryStatus(
  status
) {
  switch (status) {
    case "collecting_details":
      return "collecting details";

    case "finding_shopper":
      return "finding shopper";

    case "shopper_assigned":
      return "shopper accepted";

    case "awaiting_customer_price_confirmation":
      return "waiting for your approval";

    case "payment_pending":
      return "waiting for payment";

    case "shopping":
      return "shopping";

    case "picked_up":
      return "picked up";

    case "out_for_delivery":
      return "out for delivery";

    case "delivered":
      return "delivered";

    case "cancelled":
      return "cancelled";

    default:
      return status || "unknown";
  }
}

function buildCustomerOrderHistoryMessage(
  orders
) {
  if (!orders.length) {
    return (
      "You don’t have any Fetch orders yet."
    );
  }

  const lines =
    orders.map(
      (order) => {
        const reference =
          shortOrderReference(
            order.id
          );

        const itemText =
          String(
            order.items ||
              "Items"
          )
            .replace(
              /\s+/g,
              " "
            )
            .trim();

        const storeText =
          String(
            order.store_name ||
              "Any available local store"
          )
            .trim();

        const status =
          formatOrderHistoryStatus(
            order.status
          );

        return (
          `• #${reference} — ${itemText}\n` +
          `  ${storeText} — ${status}`
        );
      }
    );

  return (
    `📦 Your recent Fetch orders\n\n` +
    lines.join("\n\n") +
    `\n\nReply STATUS to check your latest active order.`
  );
}

function buildSingleOrderSummary(
  order
) {
  if (!order) {
    return (
      "I don’t see a Fetch order yet. Tell me what you’d like to fetch."
    );
  }

  const total =
    Number(
      order.total_amount || 0
    );

  return (
    `📦 Order #${shortOrderReference(
      order.id
    )}\n\n` +
    `🛒 Items: ${order.items || "Items"}\n` +
    `🏪 Store: ${order.store_name || "Any available local store"}\n` +
    `📍 Deliver to: ${order.delivery_address || "Delivery location not set"}\n\n` +
    `Status: ${formatOrderHistoryStatus(
      order.status
    )}\n` +
    (
      total > 0
        ? `💰 Total: ₹${formatRupees(total)}\n`
        : ""
    )
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
  excludedIds = [],
  preferredShopperId = null
) {
  let shoppers =
    await getAvailableShoppers(
      excludedIds
    );

  if (
    preferredShopperId
  ) {
    shoppers =
      shoppers.filter(
        (shopper) =>
          shopper.id ===
          preferredShopperId
      );
  }

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

      const hasCustomerCoordinates =
        Number.isFinite(
          Number(order.customer_latitude)
        ) &&
        Number.isFinite(
          Number(order.customer_longitude)
        );

      const storeName =
        String(
          order.store_name || ""
        ).trim();

      const isFlexibleStore =
        !storeName ||
        /^any available local store$/i.test(
          storeName
        ) ||
        /^pending(?: nearby)? store$/i.test(
          storeName
        );

      const destinationLine =
        order.delivery_address
          ? `📍 Deliver to: ${order.delivery_address}\n`
          : "📍 Delivery location: customer will share location\n";

      const locationPinLine =
        hasCustomerCoordinates
          ? `🗺️ Customer location: https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
              `${Number(order.customer_latitude)},${Number(
                order.customer_longitude
              )}`
            )}\n`
          : "";

      const storeInstruction =
        isFlexibleStore
          ? "🏪 Store: Any suitable nearby/local shop\n"
          : `🏪 Store: ${storeName}\n`;

      const shopperInstruction =
        isFlexibleStore
          ? "Please find the requested item at a suitable nearby shop, check the product price, and decide the delivery fee."
          : "Please check the product price at the requested store and decide the delivery fee.";

      const message =
        `🛍️ *New Fetch Job*\n\n` +
        storeInstruction +
        `🛒 Items: ${order.items}\n` +
        destinationLine +
        locationPinLine +
        `\n${shopperInstruction}\n` +
        `Delivery fee: minimum ₹20 per order and may increase based on the KM.\n\n` +
        `Reply *ACCEPT* to take this job.\n` +
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
      return "Your order is waiting for confirmation.";

    case "awaiting_customer_price_confirmation":
      return "Your shopper has checked the product price and your order is waiting for your approval.";

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
      return "Your order has been delivered. 🎉 I’ve also sent you the receipt. You can rate the experience from 1 to 5.";

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
15. If payment_pending, never tell the shopper to purchase before payment is confirmed.
16. A customer may specify ANY store, even if it is not in Fetch's store database. Never reject a request because the store is not registered.
17. Store is optional. If no store is specified, use "Any available local store" and let the shopper find the item.
18. A WhatsApp location pin is delivery-location information, not a product request.
16. After an order is delivered, a message containing a rating from 1 to 5 is customer feedback, not a new product order.
17. "thank you", "thanks", ETA/status questions, and rating messages are conversational and must not be added to items.
18. A WhatsApp location pin is delivery-location information, not a product request and must never be turned into items.
19. "my orders", "order history", and "show my orders" mean show the customer’s recent Fetch orders; they are not new shopping requests.
20. When a shopper becomes available, Fetch should automatically offer the oldest waiting order first. The customer should not have to resubmit the order.
20. If the customer mentions an order reference such as #ABC123 or identifies an order by item/store, use that order for status or cancellation; never guess when more than one order matches.
21. "cancel order #ABC123" must cancel only that exact customer order if it is still active.
22. When Fetch asks which order the customer means, a reply containing only that order number inherits the action from Fetch’s immediately preceding question. Never treat a bare order number as a new shopping request.
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

  if (
    isPaymentCommand(
      text
    ) &&
    activeOrder?.status ===
      "payment_pending"
  ) {
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
        "Payment received ✅ I’ve told the shopper to continue shopping.",
    };
  }

  if (
    isNewOrderPrompt(
      text
    )
  ) {
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
        buildHumanNewOrderReply(),
    };
  }

  if (
    isThankYouMessage(
      text
    )
  ) {
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
        "You’re welcome 😊",
    };
  }

  if (
    isEtaQuestion(
      text
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
        buildHumanEtaReply(
          activeOrder ||
          null
        ),
    };
  }

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
        buildSingleOrderSummary(activeOrder || null),
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

function cleanRequestedStoreName(storeName) {
  let value =
    String(storeName || "")
      .replace(/\s+/g, " ")
      .trim();

  if (!value) {
    return "";
  }

  /*
    Remove only clear delivery clauses accidentally captured
    as part of the store name.
  */
  value =
    value.replace(
      /\s*,?\s*(?:and\s+)?(?:deliver(?:ed)?|delivery)\s+(?:it\s+)?(?:to|at)\s+.*$/i,
      ""
    );

  value =
    value.replace(
      /\s*,?\s*(?:and\s+)?to\s+my\s+address.*$/i,
      ""
    );

  return value
    .replace(/^[,;.\s]+|[,;.\s]+$/g, "")
    .trim();
}


function normalizeCustomerText(text) {
  return String(text || '')
    .trim()
    .replace(/\s+/g, ' ');
}

function extractFlexibleShoppingRequest(text) {
  const value =
    normalizeCustomerText(text);

  if (!value) {
    return null;
  }

  /*
    Fetch should understand natural customer language.

    Examples:
      I need 3 kitkat from xyz store
      I need 3 kitkat from xyz store, delivered to ABRA 200
      I need 10 super glue
      I need 1 lays to my address
      enik 5 munch venam from Ganapathy bakery, delivery location Annoor
  */

  const prefix =
    "(?:i\\s+want|i\\s+need|i'd\\s+like|i\\s+would\\s+like|please\\s+get|please\\s+fetch|can\\s+you\\s+get|can\\s+you\\s+fetch|get\\s+me|fetch\\s+me|buy\\s+me|order|enikku|enik|enikk|mujhe|mere\\s+liye|enakku|naaku|nanage)";

  const deliveryMarker =
    "(?:deliver(?:ed|\\s+it)?\\s+to|delivery\\s+(?:location|to)?|delivery\\s+address|deliver\\s+at|delivered\\s+at|to\\s+my\\s+address|to\\s+me|at\\s+my\\s+address|delivery)";

  /*
    FIRST: request with an explicit store and a delivery marker.
    This captures the store only until the delivery marker.
  */
  const withStoreAndDelivery =
    new RegExp(
      `^${prefix}\\s+(.+?)\\s+(?:from|at)\\s+(.+?)\\s*,?\\s*${deliveryMarker}\\s+(.+)$`,
      "i"
    );

  let match =
    value.match(
      withStoreAndDelivery
    );

  if (match) {
    return {
      items:
        cleanNewOrderItems(
          match[1]
        ),

      store:
        cleanRequestedStoreName(
          match[2]
        ),

      address:
        match[3].trim(),
    };
  }

  /*
    SECOND: request with explicit store but no delivery marker.
  */
  const withStore =
    new RegExp(
      `^${prefix}\\s+(.+?)\\s+(?:from|at)\\s+(.+)$`,
      "i"
    );

  match =
    value.match(
      withStore
    );

  if (match) {
    const rawStoreAndMaybeAddress =
      match[2].trim();

    /*
      If a delivery phrase is buried in the tail, split it out here.
      This is deliberately done after the first regex so store names
      containing ordinary words such as "delivery" are not touched
      unless a real delivery marker is present.
    */
    const tail =
      rawStoreAndMaybeAddress.match(
        new RegExp(
          `^(.+?)\\s*,?\\s*${deliveryMarker}\\s+(.+)$`,
          "i"
        )
      );

    if (tail) {
      return {
        items:
          cleanNewOrderItems(
            match[1]
          ),

        store:
          cleanRequestedStoreName(
            tail[1]
          ),

        address:
          tail[2].trim(),
      };
    }

    return {
      items:
        cleanNewOrderItems(
          match[1]
        ),

      store:
        cleanRequestedStoreName(
          rawStoreAndMaybeAddress
        ),

      address:
        "",
    };
  }

  /*
    THIRD: item + delivery address, with no store specified.
  */
  const deliveryOnly =
    new RegExp(
      `^${prefix}\\s+(.+?)\\s+${deliveryMarker}\\s+(.+)$`,
      "i"
    );

  match =
    value.match(
      deliveryOnly
    );

  if (match) {
    return {
      items:
        cleanNewOrderItems(
          match[1]
        ),

      store:
        "",

      address:
        match[2].trim(),
    };
  }

  /*
    FOURTH: a plain item-only request.
  */
  const itemOnly =
    new RegExp(
      `^${prefix}\\s+(.+)$`,
      "i"
    );

  match =
    value.match(
      itemOnly
    );

  if (
    match &&
    match[1]?.trim()
  ) {
    return {
      items:
        cleanNewOrderItems(
          match[1]
        ),

      store:
        "",

      address:
        "",
    };
  }

  return null;
}


function extractDeterministicShoppingRequest(text) {
  const value =
    normalizeCustomerText(
      text
    );

  if (!value) {
    return null;
  }

  const prefix =
    "(?:i\\s+want|i\\s+need|i'd\\s+like|i\\s+would\\s+like|please\\s+get|please\\s+fetch|can\\s+you\\s+get|can\\s+you\\s+fetch|get\\s+me|fetch\\s+me|buy\\s+me|order|enikku|enik|enikk|mujhe|mere\\s+liye|enakku|naaku|nanage)";

  const deliveryMarker =
    "(?:deliver(?:ed|\\s+it)?\\s+to|delivery\\s+(?:location|to)?|delivery\\s+address|deliver\\s+at|delivered\\s+at|to\\s+my\\s+address|to\\s+me|at\\s+my\\s+address|delivery)";

  const explicitPattern =
    new RegExp(
      `^${prefix}\\s+(.+?)\\s+(?:from|at)\\s+(.+?)\\s*,?\\s*${deliveryMarker}\\s+(.+)$`,
      "i"
    );

  let match =
    value.match(
      explicitPattern
    );

  if (match) {
    return {
      items:
        cleanNewOrderItems(
          match[1]
        ),
      store:
        cleanRequestedStoreName(
          match[2]
        ),
      address:
        match[3].trim(),
    };
  }

  const simpleStorePattern =
    new RegExp(
      `^${prefix}\\s+(.+?)\\s+(?:from|at)\\s+(.+)$`,
      "i"
    );

  match =
    value.match(
      simpleStorePattern
    );

  if (match) {
    return {
      items:
        cleanNewOrderItems(
          match[1]
        ),
      store:
        cleanRequestedStoreName(
          match[2]
        ),
      address:
        "",
    };
  }

  const deliveryOnlyPattern =
    new RegExp(
      `^${prefix}\\s+(.+?)\\s+${deliveryMarker}\\s+(.+)$`,
      "i"
    );

  match =
    value.match(
      deliveryOnlyPattern
    );

  if (match) {
    return {
      items:
        cleanNewOrderItems(
          match[1]
        ),
      store:
        "",
      address:
        match[2].trim(),
    };
  }

  const itemOnlyPattern =
    new RegExp(
      `^${prefix}\\s+(.+)$`,
      "i"
    );

  match =
    value.match(
      itemOnlyPattern
    );

  if (
    match &&
    match[1]?.trim()
  ) {
    return {
      items:
        cleanNewOrderItems(
          match[1]
        ),
      store:
        "",
      address:
        "",
    };
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


function cleanConversationText(text) {
  return String(text || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/g, "")
    .trim();
}



function parseShopperUpiId(text) {
  const raw =
    String(text || "")
      .trim()
      .replace(/\s+/g, " ");

  if (!raw) {
    return null;
  }

  /*
    Fetch accepts several natural formats from shoppers:

    UPI ID: name@bank
    UPI: name@bank
    my UPI is name@bank
    upi is name@bank
    Phone: 9876543210
    Mobile: 9876543210
    9876543210

    We store the value in the existing upi_id field.
    For a mobile number, the customer can use that number
    in their UPI app.
  */

  const labeled =
    raw.match(
      /^(?:upi(?:\s+id)?|upi\s+address|payment\s+upi|phone|mobile|mobile\s+number|phone\s+number)\s*(?:is|=|:|-)?\s*(.+)$/i
    );

  let destination =
    labeled
      ? labeled[1].trim()
      : raw;

  destination =
    destination
      .replace(
        /^(?:my\s+upi(?:\s+id)?|my\s+upi|upi\s+id\s+is|upi\s+is|my\s+phone\s+number|my\s+mobile\s+number|my\s+phone|my\s+mobile)\s*(?:is|=|:|-)?\s*/i,
        ""
      )
      .trim();

  // Remove a trailing sentence/punctuation commonly added by the shopper.
  destination =
    destination
      .replace(
        /[.!?]+$/g,
        ""
      )
      .trim();

  if (!destination) {
    return null;
  }

  // Standard UPI handle.
  if (
    /^[A-Za-z0-9][A-Za-z0-9._-]{1,120}@[A-Za-z0-9._-]{2,80}$/.test(
      destination
    )
  ) {
    return destination;
  }

  // Indian UPI-enabled mobile number:
  // 10 digits beginning 6-9, or 91 + 10 digits.
  if (
    /^(?:[6-9]\d{9}|91[6-9]\d{9})$/.test(
      destination
    )
  ) {
    return destination;
  }

  // Also allow a phone number with spaces, +91 or separators.
  const digits =
    destination.replace(
      /[^\d]/g,
      ""
    );

  if (
    /^(?:[6-9]\d{9}|91[6-9]\d{9})$/.test(
      digits
    )
  ) {
    return digits;
  }

  return null;
}


function isShopperAvailabilityMessage(text) {
  const value =
    cleanConversationText(
      text
    ).toLowerCase();

  return /^(?:available|available for next job|available for next order|ready for next job|ready for next order|ready for a job|i'?m ready|im ready|ready|make me available|set me available|free now|i'?m free|im free|i'?m available|im available)$/.test(
    value
  );
}

function isShopperNotReceivedMessage(text) {
  const value =
    cleanConversationText(text).toLowerCase();

  return /^(not received|not received it|didn't receive|did not receive|payment not received|money not received|haven't received|have not received|not got|didn't get the payment|did not get the payment)$/.test(
    value
  );
}

function isCustomerPaidMessage(text) {
  const value =
    cleanConversationText(text).toLowerCase();

  return /^(paid|payment done|i'?ve paid|i have paid|payment completed|payment sent|sent the payment|done with payment)$/.test(
    value
  );
}

function isShopperPaymentReceivedMessage(text) {
  const value =
    cleanConversationText(text).toLowerCase();

  return /^(received|payment received|got it|got the payment|yes received|yes i received|yes received it|money received|received the payment)$/.test(
    value
  );
}

function buildShopperPaymentMessage(order, upiId) {
  const total =
    Number(order?.total_amount || 0);

  const isPhone =
    /^(?:[6-9]\d{9}|91[6-9]\d{9})$/.test(
      String(upiId || "")
    );

  const label =
    isPhone
      ? "UPI mobile number"
      : "UPI ID";

  return (
    `💳 Please pay ₹${formatRupees(total)} directly to the shopper.\\n\\n` +
    `${label}: ${upiId}\\n\\n` +
    `After payment, reply PAID here.`
  );
}

function isPaymentCommand(text) {
  const value =
    cleanConversationText(text).toLowerCase();

  return /^(pay|payment done|paid|i've paid|i have paid|payment completed|complete payment|make payment)$/.test(
    value
  );
}

function isNewOrderPrompt(text) {
  const value =
    cleanConversationText(text).toLowerCase();

  return /^(new order|new fetch order|start new order|start a new order|place a new order|another order|i want a new order|i need a new order)$/.test(
    value
  );
}

function isThankYouMessage(text) {
  const value =
    cleanConversationText(text).toLowerCase();

  return /^(thanks|thank you|thankyou|thanks a lot|thank you so much|thx|ty|great thanks|ok thanks|okay thanks|many thanks|shukriya|nanni)$/.test(
    value
  );
}

function isEtaQuestion(text) {
  const value =
    cleanConversationText(text).toLowerCase();

  return (
    /^(eta|what is the eta|whats the eta|what's the eta|when will it arrive|when will my order arrive|how long will it take|how much longer|where is my order|what is my order status|what's my order status|any update|any updates|update me|order update)$/.test(
      value
    ) ||
    /\b(?:eta|arrival|arrive|how long|when will.*arrive)\b/.test(
      value
    ) &&
    /\b(?:order|delivery|deliver|arrive)\b/.test(
      value
    )
  );
}

function buildHumanEtaReply(order) {
  if (!order) {
    return "I don’t have an active order right now.";
  }

  switch (order.status) {
    case "finding_shopper":
      return "I’m still finding a shopper for your order. I’ll update you as soon as someone accepts it.";

    case "shopper_assigned":
      return "Your shopper has accepted the order and will start shopping soon.";

    case "shopping":
      return "Your shopper is shopping for your order now. I’ll update you once the items are picked up.";

    case "picked_up":
      return "Your shopper has picked up the order. It’s getting ready for delivery.";

    case "out_for_delivery":
      return "Your order is on the way 🚴 I’ll let you know when it’s delivered.";

    case "awaiting_customer_price_confirmation":
      return "The shopper has sent the product and delivery price. I’m waiting for your approval.";

    case "payment_pending":
      return "Your order is waiting for payment. Once payment is received, I’ll tell the shopper to continue.";

    case "awaiting_confirmation":
      return "Your order is waiting for confirmation from you.";

    case "collecting_details":
      return "I’m still collecting the details for your order.";

    case "delivered":
      return "Your order has already been delivered 🎉";

    case "cancelled":
      return "That order has been cancelled.";

    default:
      return "I’m checking the latest status of your order.";
  }
}

function buildHumanNewOrderReply() {
  return "Absolutely 👍 Let’s start a new order. What would you like me to fetch?";
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



function isCancelDisambiguationMessage(message) {
  return /which one would you like to cancel|which order would you like to cancel/i.test(
    String(message?.message || "")
  );
}

function isStatusDisambiguationMessage(message) {
  return /which one would you like to check|which order would you like to check/i.test(
    String(message?.message || "")
  );
}

async function getPendingOrderActionFromConversation(
  customerId,
  currentMessage
) {
  const history =
    await getRecentMessages(
      customerId
    );

  const current =
    cleanConversationText(
      currentMessage
    );

  const currentReference =
    extractOrderReference(
      currentMessage
    );

  if (
    currentReference &&
    /^#?[A-F0-9]{6,32}$/i.test(
      current
    )
  ) {
    for (
      let index = history.length - 1;
      index >= 0;
      index -= 1
    ) {
      const message =
        history[index];

      if (
        message?.role !==
        "assistant"
      ) {
        continue;
      }

      if (
        isCancelDisambiguationMessage(
          message
        )
      ) {
        return {
          action: "cancel",
          reference: currentReference,
        };
      }

      if (
        isStatusDisambiguationMessage(
          message
        )
      ) {
        return {
          action: "status",
          reference: currentReference,
        };
      }
    }
  }

  if (
    isCancellationRequest(
      currentMessage
    ) &&
    !currentReference
  ) {
    for (
      let index = history.length - 1;
      index >= 0;
      index -= 1
    ) {
      const message =
        history[index];

      if (
        message?.role !==
        "user"
      ) {
        continue;
      }

      const reference =
        extractOrderReference(
          message.message
        );

      if (
        reference
      ) {
        return {
          action: "cancel",
          reference,
        };
      }
    }
  }

  return null;
}


/* =========================================================
   CUSTOMER ORDER MODIFICATIONS
========================================================= */

function parseOrderModifications(text) {
  const raw =
    cleanConversationText(
      text
    );

  if (!raw) {
    return [];
  }

  const modifications = [];
  let remaining = raw;

  /*
    Delivery-address changes are extracted first. This prevents
    "delivered to ..." from ever becoming part of the item/store.
  */
  const addressMatch =
    raw.match(
      /(?:^|[;,]|\balso\b)\s*(?:change\s+(?:the\s+)?delivery\s+(?:address|location)|delivery\s+address|deliver\s+to)\s*:?\s*(.+)$/i
    );

  if (addressMatch) {
    modifications.push({
      type:
        "address",
      value:
        addressMatch[1].trim(),
    });

    remaining =
      raw
        .slice(
          0,
          addressMatch.index
        )
        .replace(
          /[;,]\s*$/,
          ""
        )
        .replace(
          /\s+also\s*$/i,
          ""
        )
        .trim();
  }

  const clauses =
    remaining
      .split(
        /\s*(?:,|;|\balso\b|\band\b(?=\s*(?:add|include|remove|delete|take\s+out|change|replace)\b))\s*/i
      )
      .map(
        (value) =>
          value.trim()
      )
      .filter(Boolean);

  for (const clause of clauses) {
    let match =
      clause.match(
        /^(?:add|include|also\s+add)\s+(.+)$/i
      );

    if (match) {
      modifications.push({
        type:
          "add",
        value:
          match[1].trim(),
      });
      continue;
    }

    match =
      clause.match(
        /^(?:remove|delete|take\s+out)\s+(.+)$/i
      );

    if (match) {
      modifications.push({
        type:
          "remove",
        value:
          match[1].trim(),
      });
      continue;
    }

    match =
      clause.match(
        /^(?:change|replace)\s+(.+?)\s+(?:to|with)\s+(.+)$/i
      );

    if (match) {
      modifications.push({
        type:
          "replace",
        from:
          match[1].trim(),
        to:
          match[2].trim(),
      });
    }
  }

  return modifications;
}

function parseOrderModification(text) {
  const modifications =
    parseOrderModifications(
      text
    );

  return modifications.length
    ? modifications[0]
    : null;
}


function canModifyOrder(order) {
  return Boolean(
    order &&
    [
      "collecting_details",
      "awaiting_confirmation",
      "awaiting_customer_price_confirmation",
      "payment_pending",
      "finding_shopper",
      "shopper_assigned",
      "shopping",
    ].includes(
      order.status
    )
  );
}

function applyOrderItemModification(
  currentItems,
  modification
) {
  const items =
    String(
      currentItems || ""
    ).trim();

  if (
    !items ||
    !modification
  ) {
    return null;
  }

  if (
    modification.type ===
      "add"
  ) {
    return `${items}; ${modification.value}`;
  }

  if (
    modification.type ===
      "remove"
  ) {
    const target =
      modification.value;

    const escaped =
      target.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&"
      );

    const regex =
      new RegExp(
        `(?:^|;\\s*)${escaped}(?:\\s*;|\\s*$)`,
        "i"
      );

    let updated =
      items.replace(
        regex,
        ""
      );

    if (
      updated === items
    ) {
      updated =
        items.replace(
          new RegExp(
            escaped,
            "i"
          ),
          ""
        );
    }

    updated =
      updated
        .replace(
          /;\s*;/g,
          ";"
        )
        .replace(
          /^\s*;\s*|\s*;\s*$/g,
          ""
        )
        .replace(
          /\s{2,}/g,
          " "
        )
        .trim();

    return updated;
  }

  if (
    modification.type ===
      "replace"
  ) {
    const escaped =
      modification.from.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&"
      );

    const regex =
      new RegExp(
        escaped,
        "i"
      );

    return regex.test(
      items
    )
      ? items.replace(
          regex,
          modification.to
        )
      : null;
  }

  return null;
}

function buildOrderModificationMessage(
  order,
  modification
) {
  const verb =
    modification.type === "add"
      ? `added ${modification.value}`
      : modification.type === "remove"
        ? `removed ${modification.value}`
        : modification.type === "replace"
          ? `changed ${modification.from} to ${modification.to}`
          : `updated your delivery address to ${modification.value}`;

  return (
    `Updated 👍 I’ve ${verb}.\n\n` +
    `🛒 Items: ${order.items}\n` +
    `🏪 Store: ${order.store_name}\n` +
    `📍 Deliver to: ${order.delivery_address || "location to be confirmed"}`
  );
}

/* =========================================================
   ORDER-SPECIFIC CUSTOMER ACTIONS
========================================================= */

function extractOrderReference(text) {
  const value =
    cleanConversationText(
      text
    );

  const match =
    value.match(
      /#?([A-F0-9]{6,32})\b/i
    );

  return match
    ? match[1].toUpperCase()
    : null;
}

function extractOrderAction(text) {
  const value =
    cleanConversationText(
      text
    ).toLowerCase();

  const hasStatus =
    /\b(?:status|where\s+is|where'?s|track|tracking|update|eta|when\s+will)\b/.test(
      value
    );

  const hasCancel =
    /\bcancel\b/.test(
      value
    );

  if (hasCancel) {
    return "cancel";
  }

  if (hasStatus) {
    return "status";
  }

  if (
    /^#?[a-f0-9]{6,32}$/i.test(
      value
    )
  ) {
    return "reference";
  }

  return null;
}

function extractOrderSearchPhrase(text) {
  let value =
    cleanConversationText(
      text
    ).toLowerCase();

  value =
    value
      .replace(
        /\b(?:status|where\s+is|where'?s|track|tracking|update|eta|when\s+will)\b/g,
        " "
      )
      .replace(
        /\bcancel\b/g,
        " "
      )
      .replace(
        /\b(?:my|the|an|a|order|orders|delivery|deliver|please|can|you|tell|me|what|is|of|for|about|on)\b/g,
        " "
      )
      .replace(
        /#?[a-f0-9]{6,32}\b/gi,
        " "
      )
      .replace(
        /\s+/g,
        " "
      )
      .trim();

  return value;
}

async function resolveCustomerOrder(
  customerId,
  text
) {
  const orders =
    await getCustomerOrders(
      customerId,
      20
    );

  if (!orders.length) {
    return {
      order: null,
      matches: [],
      reason: "none",
    };
  }

  const reference =
    extractOrderReference(
      text
    );

  if (reference) {
    const exact =
      orders.filter(
        (order) =>
          String(
            order?.id || ""
          )
            .replace(
              /-/g,
              ""
            )
            .toUpperCase()
            .startsWith(
              reference
            )
      );

    if (
      exact.length === 1
    ) {
      return {
        order:
          exact[0],
        matches:
          exact,
        reason:
          "reference",
      };
    }

    if (
      exact.length > 1
    ) {
      return {
        order: null,
        matches: exact,
        reason:
          "ambiguous_reference",
      };
    }

    return {
      order: null,
      matches: [],
      reason:
        "reference_not_found",
    };
  }

  const phrase =
    extractOrderSearchPhrase(
      text
    );

  if (!phrase) {
    return {
      order: null,
      matches: [],
      reason:
        "no_search_phrase",
    };
  }

  const terms =
    phrase
      .split(" ")
      .filter(
        (term) =>
          term.length >= 2
      );

  const matches =
    orders.filter(
      (order) => {
        const haystack =
          [
            order?.items,
            order?.store_name,
          ]
            .join(" ")
            .toLowerCase();

        return (
          terms.length > 0 &&
          terms.every(
            (term) =>
              haystack.includes(
                term
              )
          )
        );
      }
    );

  if (
    matches.length === 1
  ) {
    return {
      order:
        matches[0],
      matches,
      reason:
        "phrase",
    };
  }

  if (
    matches.length > 1
  ) {
    return {
      order: null,
      matches,
      reason:
        "ambiguous_phrase",
    };
  }

  return {
    order: null,
    matches: [],
    reason:
      "not_found",
  };
}

function buildOrderChoiceMessage(
  matches,
  action
) {
  const verb =
    action === "cancel"
      ? "cancel"
      : "check";

  const lines =
    matches.map(
      (order) =>
        `• #${shortOrderReference(
          order.id
        )} — ${order.items || "Items"} — ${formatOrderHistoryStatus(
          order.status
        )}`
    );

  return (
    `I found more than one order. Which one would you like to ${verb}?\n\n` +
    lines.join("\n") +
    `\n\nReply with the order number, for example #${shortOrderReference(
      matches[0].id
    )}.`
  );
}

function canCustomerCancelOrder(
  order
) {
  return Boolean(
    order &&
    ACTIVE_ORDER_STATUSES.includes(
      order.status
    )
  );
}


function isCustomerOrderDetailsQuestion(text) {
  const value =
    cleanConversationText(
      text
    ).toLowerCase();

  return (
    /^(?:details|order details|my order details|show details|show my order details)$/i.test(
      value
    ) ||
    /^(?:show|share|send|give)\s+(?:me\s+)?(?:the\s+)?(?:order|latest order)\s+details$/i.test(
      value
    )
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

  /*
    -------------------------------------------------------
    CUSTOMER RATING
    -------------------------------------------------------
    Ratings are accepted only for the latest delivered order
    that has not already been rated.
  */

  const latestDeliveredOrder =
    latestOrder &&
    latestOrder.status ===
      "delivered" &&
    latestOrder.customer_rating == null
      ? latestOrder
      : null;

  const customerRating =
    parseCustomerRating(
      userMessage
    );

  if (
    latestDeliveredOrder &&
    customerRating !== null
  ) {
    const ratedAt =
      new Date().toISOString();

    const ratedOrder =
      await updateOrder(
        latestDeliveredOrder.id,
        {
          customer_rating:
            customerRating,

          rated_at:
            ratedAt,
        }
      );

    if (!ratedOrder) {
      throw new Error(
        "Could not save customer rating"
      );
    }

    await saveMessage({
      customerId:
        customer.id,

      orderId:
        latestDeliveredOrder.id,

      phone:
        normalizedPhone,

      role:
        "user",

      message:
        userMessage,
    });

    const thanks =
      buildCustomerRatingThanks(
        customerRating
      );

    await saveMessage({
      customerId:
        customer.id,

      orderId:
        latestDeliveredOrder.id,

      phone:
        normalizedPhone,

      role:
        "assistant",

      message:
        thanks,
    });

    await sendWhatsAppMessage(
      normalizedPhone,
      thanks
    );

    return;
  }

  if (
    latestDeliveredOrder &&
    /^[0-9]+(?:\s*(?:stars?|\/\s*5))?$/i.test(
      cleanConversationText(
        userMessage
      )
    ) &&
    customerRating === null
  ) {
    await sendWhatsAppMessage(
      normalizedPhone,
      "Please send a rating from 1 to 5 ⭐"
    );
    return;
  }

  if (
    latestDeliveredOrder &&
    /^(?:rate|rating|review|feedback)$/i.test(
      cleanConversationText(
        userMessage
      )
    )
  ) {
    await sendWhatsAppMessage(
      normalizedPhone,
      buildCustomerRatingRequest()
    );

    return;
  }


  /*
    -------------------------------------------------------
    HUMAN CONVERSATION GATE

    These messages are handled without OpenAI so a normal
    conversation can never accidentally become an order
    update or an item list.
    -------------------------------------------------------
  */

  if (
    isNewOrderPrompt(
      userMessage
    )
  ) {
    await saveMessage({
      customerId:
        customer.id,

      orderId:
        null,

      phone:
        normalizedPhone,

      role:
        "user",

      message:
        userMessage,
    });

    const reply =
      buildHumanNewOrderReply();

    await saveMessage({
      customerId:
        customer.id,

      orderId:
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
    isThankYouMessage(
      userMessage
    )
  ) {
    const orderId =
      activeOrder?.id ||
      latestOrder?.id ||
      null;

    const reply =
      "You’re welcome 😊";

    await saveMessage({
      customerId:
        customer.id,

      orderId,
      phone:
        normalizedPhone,

      role:
        "user",

      message:
        userMessage,
    });

    await saveMessage({
      customerId:
        customer.id,

      orderId,
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
    isEtaQuestion(
      userMessage
    )
  ) {
    const order =
      activeOrder ||
      latestOrder;

    const reply =
      buildHumanEtaReply(
        order
      );

    await saveMessage({
      customerId:
        customer.id,

      orderId:
        order?.id || null,

      phone:
        normalizedPhone,

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
     SIMPLE MVP: NEW ORDER -> SHOPPER
  ----------------------------------------- */

  const simpleOrderParts =
    extractDeterministicShoppingRequest(
      userMessage
    );

  const hasSimpleNewOrder =
    isExplicitNewOrderRequest(
      userMessage
    ) &&
    simpleOrderParts?.items &&
    simpleOrderParts?.store;

  if (hasSimpleNewOrder) {
    const cleanItems =
      cleanNewOrderItems(
        simpleOrderParts.items
      );

    const requestedStore =
      String(
        simpleOrderParts.store
      ).trim();

    if (
      cleanItems &&
      requestedStore
    ) {
      const deliveryAddress =
        String(
          simpleOrderParts.address ||
          ""
        ).trim();

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
            deliveryAddress,

          status:
            "finding_shopper",
        });

      if (!newOrder) {
        throw new Error(
          "Could not create Fetch order"
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
          "user",

        message:
          userMessage,
      });

      // Register the store when possible, but NEVER block
      // the shopper dispatch on store registration.
      await ensureStoreForOrder(
        newOrder
      );

      const dispatch =
        await offerOrderToShopper(
          newOrder
        );

      if (
        dispatch.success
      ) {
        await sendWhatsAppMessage(
          normalizedPhone,

          `Got it 👍\n\n🛒 Items: ${cleanItems}\n🏪 Store: ${requestedStore}\n` +
          (
            deliveryAddress
              ? `📍 Deliver to: ${deliveryAddress}\n`
              : ""
          ) +
          `\nI’ve sent the order to an available shopper. They’ll check the product price and send it to you for approval.`
        );
      } else {
        await sendWhatsAppMessage(
          normalizedPhone,

          `Got it 👍 I have your order for ${cleanItems} from ${requestedStore}, but there isn’t an available shopper right now.`
        );
      }

      return;
    }
  }

  /* -----------------------------------------
     FLEXIBLE NEW ORDER INTAKE
  ----------------------------------------- */

  const flexibleRequest =
    extractFlexibleShoppingRequest(
      userMessage
    );

  if (
    flexibleRequest &&
    flexibleRequest.items
  ) {
    const items =
      cleanNewOrderItems(
        flexibleRequest.items
      );

    if (!items) {
      await sendWhatsAppMessage(
        normalizedPhone,
        "Tell me what you’d like me to fetch."
      );
      return;
    }

    const requestedStore =
      cleanRequestedStoreName(
        String(
          flexibleRequest.store ||
          ""
        ).trim()
      );

    const storeName =
      requestedStore &&
      !looksLikeNearbyStoreRequest(
        requestedStore
      )
        ? requestedStore
        : "Any available local store";

    const address =
      String(
        flexibleRequest.address ||
        customer.address ||
        ""
      ).trim();

    const order =
      await createOrder({
        customerId:
          customer.id,

        storeName,

        items,

        budget:
          null,

        deliveryAddress:
          address,

        status:
          address
            ? "finding_shopper"
            : "collecting_details",
      });

    if (!order) {
      throw new Error(
        "Could not create new Fetch order"
      );
    }

    await saveMessage({
      customerId:
        customer.id,

      orderId:
        order.id,

      phone:
        normalizedPhone,

      role:
        "user",

      message:
        userMessage,
    });

    if (!address) {
      await sendWhatsAppMessage(
        normalizedPhone,
        `Got it 👍\n\n🛒 ${items}\n🏪 ${storeName}\n\nWhere should I deliver it? Send your address or WhatsApp location pin 📍.`
      );
      return;
    }

    if (customer.address !== address) {
      await updateCustomerAddress(
        customer.id,
        address
      );
    }

    const dispatch =
      await offerOrderToShopper(
        order
      );

    if (dispatch.success) {
      await sendWhatsAppMessage(
        normalizedPhone,
        `Got it 👍\n\n🛒 ${items}\n🏪 ${storeName}\n📍 Deliver to: ${address}\n\nI’ve sent the order to an available shopper. They’ll check the product price and delivery fee and send the details to you for approval.`
      );
    } else {
      await sendWhatsAppMessage(
        normalizedPhone,
        `Got it 👍 I have your order for ${items}` +
        (
          requestedStore
            ? ` from ${requestedStore}`
            : ""
        ) +
        `. There isn’t an available shopper right now, but your order is saved.`
      );
    }

    return;
  }

  /* -----------------------------------------
     CUSTOMER ORDER HISTORY
  ----------------------------------------- */

  const customerCommand =
    cleanConversationText(
      userMessage
    ).toLowerCase();

  if (
    /^(my orders|my order|order history|orders|show my orders)$/.test(
      customerCommand
    )
  ) {
    const orders =
      await getCustomerOrders(
        customer.id,
        10
      );

    const reply =
      buildCustomerOrderHistoryMessage(
        orders
      );

    await saveMessage({
      customerId:
        customer.id,

      orderId:
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

  /* -----------------------------------------
     ORDER-SPECIFIC STATUS / CANCEL
  ----------------------------------------- */

  let explicitOrderAction =
    extractOrderAction(
      userMessage
    );

  const hasExplicitOrderReference =
    Boolean(
      extractOrderReference(
        userMessage
      )
    );

  const pendingOrderAction =
    await getPendingOrderActionFromConversation(
      customer.id,
      userMessage
    );

  let orderActionForResolution =
    explicitOrderAction;

  if (
    orderActionForResolution ===
      "reference" &&
    pendingOrderAction
  ) {
    orderActionForResolution =
      pendingOrderAction.action;
  }

  const looksLikeOrderAction =
    Boolean(
      orderActionForResolution
    ) &&
    (
      hasExplicitOrderReference ||
      /\b(?:my|the|this|that)\s+order\b/i.test(
        userMessage
      ) ||
      /\b(?:status|where(?:'s| is)?|track|tracking|cancel)\b[\s\S]*\b(?:order|delivery)\b/i.test(
        userMessage
      ) ||
      Boolean(
        pendingOrderAction
      )
    );

  let orderResolutionMessage =
    userMessage;

  if (
    pendingOrderAction?.reference
  ) {
    orderResolutionMessage =
      pendingOrderAction.reference;
  }

  if (
    looksLikeOrderAction
  ) {
    const resolved =
      await resolveCustomerOrder(
        customer.id,
        orderResolutionMessage
      );

    if (
      resolved.order
    ) {
      if (
        orderActionForResolution ===
        "status"
      ) {
        const reply =
          buildSingleOrderSummary(
            resolved.order
          );

        await saveMessage({
          customerId:
            customer.id,

          orderId:
            resolved.order.id,

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
        orderActionForResolution ===
        "cancel"
      ) {
        if (
          !canCustomerCancelOrder(
            resolved.order
          )
        ) {
          await sendWhatsAppMessage(
            normalizedPhone,
            `Order #${shortOrderReference(
              resolved.order.id
            )} is already ${formatOrderHistoryStatus(
              resolved.order.status
            )} and can’t be cancelled.`
          );

          return;
        }

        await cancelOrderAndReleaseShopper(
          resolved.order
        );

        await saveMessage({
          customerId:
            customer.id,

          orderId:
            resolved.order.id,

          phone:
            normalizedPhone,

          role:
            "assistant",

          message:
            `Cancelled order #${shortOrderReference(
              resolved.order.id
            )}.`,
        });

        await sendWhatsAppMessage(
          normalizedPhone,
          `Done 👍 I’ve cancelled order #${shortOrderReference(
            resolved.order.id
          )}.`
        );

        return;
      }
    }

    if (
      resolved.matches.length > 1
    ) {
      const reply =
        buildOrderChoiceMessage(
          resolved.matches,
          explicitOrderAction
        );

      await sendWhatsAppMessage(
        normalizedPhone,
        reply
      );

      return;
    }

    if (
      resolved.reason ===
        "reference_not_found"
    ) {
      await sendWhatsAppMessage(
        normalizedPhone,
        `I couldn’t find order #${extractOrderReference(
          userMessage
        )}. Try "MY ORDERS" to see your recent orders.`
      );

      return;
    }

    if (
      resolved.reason ===
        "not_found"
    ) {
      await sendWhatsAppMessage(
        normalizedPhone,
        "I couldn’t match that to one of your recent orders. Try MY ORDERS and send me the order number."
      );

      return;
    }
  }

  /* -----------------------------------------
     SIMPLE MVP: CUSTOMER PAYMENT TO SHOPPER
  ----------------------------------------- */

  if (
    activeOrder &&
    activeOrder.status ===
      "payment_pending"
  ) {
    if (
      isCustomerPaidMessage(
        userMessage
      ) ||
      isPaymentCommand(
        userMessage
      )
    ) {
      await updateOrder(
        activeOrder.id,
        {
          payment_status:
            "customer_reported_paid",
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

      if (
        activeOrder.shopper_id
      ) {
        const shoppers =
          await supabaseRequest(
            `shoppers?id=eq.${encodeURIComponent(
              activeOrder.shopper_id
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

            `💳 The customer says they have paid ₹${formatRupees(
              activeOrder.total_amount
            )} to your UPI.\\n\\nPlease check your payment and reply RECEIVED once you see it.`
          );
        }
      }

      await sendWhatsAppMessage(
        normalizedPhone,
        "Thanks 👍 I’ve asked the shopper to verify the payment. Once they confirm it, I’ll tell them to purchase your items."
      );

      return;
    }

    if (
      isThankYouMessage(
        userMessage
      )
    ) {
      await sendWhatsAppMessage(
        normalizedPhone,
        "You’re welcome 😊"
      );
      return;
    }
  }

  /* -----------------------------------------
     SIMPLE MVP: CUSTOMER PRICE APPROVAL
  ----------------------------------------- */

  if (
    activeOrder &&
    activeOrder.status ===
      "awaiting_customer_price_confirmation"
  ) {
    if (
      isSimpleConfirmation(
        userMessage
      )
    ) {
      if (
        activeOrder.delivery_pricing_status !==
        "calculated"
      ) {
        await sendWhatsAppMessage(
          normalizedPhone,
          "The shopper will provide the delivery fee. Minimum is ₹20 per order and it may increase based on the KM."
        );
        return;
      }

      const approvedOrder =
        await updateOrder(
          activeOrder.id,
          {
            status:
              "payment_pending",

            payment_status:
              "pending",
          }
        );

      if (!approvedOrder) {
        throw new Error(
          "Could not move order to payment_pending"
        );
      }

      let shopper = null;

      if (
        approvedOrder?.shopper_id
      ) {
        const shoppers =
          await supabaseRequest(
            `shoppers?id=eq.${encodeURIComponent(
              approvedOrder.shopper_id
            )}&select=*&limit=1`
          );

        shopper =
          Array.isArray(
            shoppers
          ) &&
          shoppers.length
            ? shoppers[0]
            : null;
      }

      if (
        !shopper?.upi_id
      ) {
        await sendWhatsAppMessage(
          normalizedPhone,
          `Approved 👍\n\n💰 Total: ₹${formatRupees(
            approvedOrder.total_amount
          )}\n\nThe shopper hasn’t added a UPI ID yet. I’ve asked them to add it so you can pay directly.`
        );

        if (
          shopper?.phone
        ) {
          await sendWhatsAppMessage(
            shopper.phone,
            "Send your UPI ID or your UPI-linked mobile number in any simple format.\n\nExamples:\nUPI ID: yourname@bank\nUPI: yourname@bank\n9876543210\nPhone: 9876543210\n\nThe customer will use it to pay you directly."
          );
        }

        return;
      }

      await sendWhatsAppMessage(
        normalizedPhone,
        `Approved 👍\n\n${buildShopperPaymentMessage(
          approvedOrder,
          shopper.upi_id
        )}\n\nDelivery price is decided by the shopper; prices may vary.`
      );

      if (
        shopper?.phone
      ) {
        await sendWhatsAppMessage(
          shopper.phone,
          "✅ Customer approved the price.\n\nWait for the customer’s payment. I’ll tell you when the payment is verified."
        );
      }

      return;
    }

    if (
      isSimpleRejection(
        userMessage
      )
    ) {
      await cancelOrderAndReleaseShopper(
        activeOrder
      );

      await sendWhatsAppMessage(
        normalizedPhone,
        "Okay 👍 The order is cancelled. I’ve informed the shopper."
      );

      return;
    }
  }

  /* -----------------------------------------
     DETERMINISTIC CANCELLATION
  -----------------------------------------

  if (
    isCancellationRequest(userMessage) &&
    !extractOrderReference(userMessage) &&
    !/\b(?:my|the|this|that)\s+order\b/i.test(userMessage)
  ) {
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
        "There isn’t an active order to cancel. Try MY ORDERS to see your recent orders.";

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
     SIMPLE MVP: LOCATION AFTER PRODUCT PRICE
  ----------------------------------------- */

  if (
    activeOrder &&
    activeOrder.status ===
      "awaiting_customer_price_confirmation" &&
    location &&
    Number.isFinite(
      Number(location.latitude)
    ) &&
    Number.isFinite(
      Number(location.longitude)
    )
  ) {
    const locationLabel =
      [
        location.name,
        location.address,
      ]
        .map(
          (value) =>
            String(value || "").trim()
        )
        .filter(Boolean)
        .join(", ");

    const updatedOrder =
      await updateOrder(
        activeOrder.id,
        {
          delivery_address:
            locationLabel ||
            activeOrder.delivery_address ||
            "WhatsApp location",
        }
      );

    if (!updatedOrder) {
      await sendWhatsAppMessage(
        normalizedPhone,
        "I received your location, but I couldn’t update the order. Please send it again."
      );
      return;
    }

    await sendWhatsAppMessage(
      normalizedPhone,
      "Location saved 📍. The shopper decides the delivery fee, and I’ll use the fee they provided."
    );

    return;
  }


  function buildCustomerMapsLink(latitude, longitude) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
      `${latitude},${longitude}`
    )}`;
  }

  async function notifyAssignedShopperOfCustomerLocation(
    order,
    latitude,
    longitude
  ) {
    if (!order?.shopper_id) {
      return;
    }

    const shoppers =
      await supabaseRequest(
        `shoppers?id=eq.${encodeURIComponent(
          order.shopper_id
        )}&select=*&limit=1`
      );

    const shopper =
      Array.isArray(shoppers) &&
      shoppers.length
        ? shoppers[0]
        : null;

    if (!shopper?.phone) {
      return;
    }

    const mapsLink =
      buildCustomerMapsLink(
        latitude,
        longitude
      );

    await sendWhatsAppMessage(
      shopper.phone,
      `📍 The customer has shared their delivery location.\n\n${mapsLink}\n\nUse this location for the delivery.`
    );
  }

  /* -----------------------------------------
     WHATSAPP LOCATION
  ----------------------------------------- */

  if (
    location &&
    Number.isFinite(Number(location.latitude)) &&
    Number.isFinite(Number(location.longitude))
  ) {
    const latitude =
      Number(location.latitude);

    const longitude =
      Number(location.longitude);

    const locationLabel =
      [
        location.name,
        location.address,
      ]
        .map(
          (value) =>
            String(value || "").trim()
        )
        .filter(Boolean)
        .join(", ");

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
        "WhatsApp location pin shared",
    });

    if (!activeOrder) {
      await sendWhatsAppMessage(
        normalizedPhone,
        "I received your location 📍. Tell me what you’d like me to fetch and which store."
      );

      return;
    }

    const address =
      locationLabel ||
      activeOrder.delivery_address ||
      "WhatsApp location";

    const updates = {
      delivery_address:
        address,

      customer_latitude:
        latitude,

      customer_longitude:
        longitude,

      customer_location_shared_at:
        new Date().toISOString(),
    };

    /*
      Location is for delivery coordination.
      The shopper still decides the delivery fee in the MVP.
      Do NOT reset the shopper's product price or delivery fee.
    */

    const updatedOrder =
      await updateOrder(
        activeOrder.id,
        updates
      );

    if (!updatedOrder) {
      await sendWhatsAppMessage(
        normalizedPhone,
        "I received your location, but I couldn’t save it. Please send the location again."
      );

      return;
    }

    /*
      If the order was still collecting details, the customer's
      location completes the order details and we can dispatch it.
    */
    if (
      updatedOrder.status ===
        "collecting_details"
    ) {
      const hasItems =
        Boolean(
          String(
            updatedOrder.items || ""
          ).trim()
        );

      const hasStore =
        Boolean(
          String(
            updatedOrder.store_name || ""
          ).trim()
        );

      if (
        hasItems &&
        hasStore
      ) {
        const findingShopper =
          await updateOrder(
            updatedOrder.id,
            {
              status:
                "finding_shopper",
            }
          );

        const dispatch =
          await offerOrderToShopper(
            findingShopper ||
              updatedOrder
          );

        if (
          dispatch.success
        ) {
          await sendWhatsAppMessage(
            normalizedPhone,
            `Location saved 📍\n\nI’ve sent your order to an available shopper. They’ll check the product price and delivery fee and send the details to you for approval.`
          );
        } else {
          await sendWhatsAppMessage(
            normalizedPhone,
            "Location saved 📍. Your order is ready, but there isn’t an available shopper right now."
          );
        }

        return;
      }
    }

    /*
      If a shopper has already accepted the order, immediately pass
      the new location to them.
    */
    if (
      updatedOrder.shopper_id
    ) {
      await notifyAssignedShopperOfCustomerLocation(
        updatedOrder,
        latitude,
        longitude
      );
    }

    await sendWhatsAppMessage(
      normalizedPhone,
      "Location saved 📍. I’ve shared it with your shopper."
    );

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

  /*
    -------------------------------------------------------
    DETERMINISTIC ACTIVE-ORDER MODIFICATIONS
    -------------------------------------------------------
    Handle simple customer changes before OpenAI. This prevents
    messages like "add 2 eggs" or "change delivery address to..."
    from entering the old pricing/update branch.
  */

  const directModifications =
    parseOrderModifications(
      userMessage
    );

  if (
    activeOrder &&
    directModifications.length
  ) {
    if (
      !canModifyOrder(
        activeOrder
      )
    ) {
      await sendWhatsAppMessage(
        normalizedPhone,
        `I can’t change order #${shortOrderReference(
          activeOrder.id
        )} because it is already ${formatOrderHistoryStatus(
          activeOrder.status
        )}.`
      );

      return;
    }

    let updatedItems =
      String(
        activeOrder.items ||
        ""
      ).trim();

    let updatedAddress =
      String(
        activeOrder.delivery_address ||
        customer.address ||
        ""
      ).trim();

    let itemChanged =
      false;

    let addressChanged =
      false;

    const appliedChanges =
      [];

    for (
      const modification of
        directModifications
    ) {
      if (
        modification.type ===
        "address"
      ) {
        updatedAddress =
          modification.value;

        addressChanged =
          true;

        appliedChanges.push(
          `changed the delivery address to ${updatedAddress}`
        );

        continue;
      }

      const nextItems =
        applyOrderItemModification(
          updatedItems,
          modification
        );

      if (!nextItems) {
        await sendWhatsAppMessage(
          normalizedPhone,
          `I couldn’t apply "${modification.value || modification.from}". Tell me exactly what you want changed.`
        );

        return;
      }

      updatedItems =
        nextItems;

      itemChanged =
        true;

      if (
        modification.type ===
        "add"
      ) {
        appliedChanges.push(
          `added ${modification.value}`
        );
      } else if (
        modification.type ===
        "remove"
      ) {
        appliedChanges.push(
          `removed ${modification.value}`
        );
      } else if (
        modification.type ===
        "replace"
      ) {
        appliedChanges.push(
          `changed ${modification.from} to ${modification.to}`
        );
      }
    }

    const updates = {
      items:
        updatedItems,

      delivery_address:
        updatedAddress,
    };

    /*
      Any customer change invalidates the old shopper quote.
      The shopper must quote the revised order again.
    */
    if (
      itemChanged ||
      addressChanged
    ) {
      updates.item_total =
        0;

      updates.fetch_fee =
        FETCH_FEE;

      updates.delivery_fee =
        0;

      updates.total_amount =
        0;

      updates.distance_km =
        null;

      updates.delivery_pricing_status =
        "pending";

      updates.delivery_pricing_source =
        null;

      updates.priced_at =
        null;

      updates.payment_status =
        "pending";
    }

    /*
      Keep the existing shopper attached while they re-check
      the modified order. If there is no shopper, send it to one.
    */
    updates.status =
      activeOrder.shopper_id
        ? "shopper_assigned"
        : "finding_shopper";

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

    if (
      addressChanged
    ) {
      await updateCustomerAddress(
        customer.id,
        updatedAddress
      );
    }

    if (
      changedOrder.shopper_id
    ) {
      const shoppers =
        await supabaseRequest(
          `shoppers?id=eq.${encodeURIComponent(
            changedOrder.shopper_id
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
        const details =
          [
            itemChanged
              ? `🛒 Updated items: ${changedOrder.items}`
              : "",
            `🏪 Store: ${changedOrder.store_name}`,
            `📍 Deliver to: ${changedOrder.delivery_address || "customer location"}`,
          ]
            .filter(Boolean)
            .join("\n");

        await sendWhatsAppMessage(
          shopper.phone,
          `🔄 The customer updated the order.\n\n${details}\n\nPlease re-check the product price and delivery fee and reply:\nPRICE: product price DELIVERY FEE: delivery fee`
        );
      }
    } else {
      const dispatch =
        await offerOrderToShopper(
          changedOrder
        );

      if (
        !dispatch.success
      ) {
        await sendWhatsAppMessage(
          normalizedPhone,
          "I’ve updated the order, but there isn’t an available shopper right now."
        );

        return;
      }
    }

    const summary =
      appliedChanges.length
        ? `Updated 👍 I’ve ${appliedChanges.join(" and ")}.`
        : "Updated 👍 I’ve updated your order.";

    await sendWhatsAppMessage(
      normalizedPhone,
      `${summary}\n\nI’ve asked the shopper to re-check the product price and delivery fee before we continue.`
    );

    return;
  }

  /* -----------------------------------------
     CUSTOMER ORDER DETAILS
  ----------------------------------------- */

  if (
    isCustomerOrderDetailsQuestion(
      userMessage
    )
  ) {
    const order =
      activeOrder ||
      latestOrder;

    if (!order) {
      await sendWhatsAppMessage(
        normalizedPhone,
        "I don’t have a Fetch order for you yet. Tell me what you’d like me to fetch."
      );
      return;
    }

    const reply =
      buildSingleOrderSummary(
        order
      );

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
        ? buildSingleOrderSummary(
            order
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
    const items =
      cleanNewOrderItems(
        decision.items?.trim() || ""
      );

    const requestedStore =
      cleanRequestedStoreName(
        String(
          decision.store_name ||
          ""
        ).trim()
      );

    const storeName =
      requestedStore &&
      !looksLikeNearbyStoreRequest(
        requestedStore
      )
        ? requestedStore
        : "Any available local store";

    const address =
      (
        decision.delivery_address ||
        customer.address ||
        ""
      ).trim();

    if (!items) {
      await sendWhatsAppMessage(
        normalizedPhone,
        decision.reply ||
          "Sure. What would you like me to fetch?"
      );
      return;
    }

    const order =
      await createOrder({
        customerId:
          customer.id,

        storeName,

        items,

        budget:
          decision.budget ??
          null,

        deliveryAddress:
          address,

        status:
          address
            ? "finding_shopper"
            : "collecting_details",
      });

    if (!order) {
      throw new Error(
        "Could not create Fetch order"
      );
    }

    await saveMessage({
      customerId:
        customer.id,

      orderId:
        order.id,

      phone:
        normalizedPhone,

      role:
        "user",

      message:
        userMessage,
    });

    if (!address) {
      await sendWhatsAppMessage(
        normalizedPhone,
        `Got it 👍\n\n🛒 ${items}\n🏪 ${storeName}\n\nWhere should I deliver it? Send your address or WhatsApp location pin 📍.`
      );
      return;
    }

    await updateCustomerAddress(
      customer.id,
      address
    );

    const dispatch =
      await offerOrderToShopper(
        order
      );

    if (dispatch.success) {
      await sendWhatsAppMessage(
        normalizedPhone,
        `Got it 👍\n\n🛒 ${items}\n🏪 ${storeName}\n📍 Deliver to: ${address}\n\nI’ve sent the order to an available shopper. They’ll check the product price and delivery fee and send the details to you for approval.`
      );
    } else {
      await sendWhatsAppMessage(
        normalizedPhone,
        `Got it 👍 I have your order for ${items}. There isn’t an available shopper right now, but your order is saved.`
      );
    }

    return;
  }

  /* UPDATE ORDER */

  if (
    decision.intent ===
      "update_order" &&
    activeOrder &&
    !isThankYouMessage(
      userMessage
    ) &&
    !isEtaQuestion(
      userMessage
    ) &&
    !isNewOrderPrompt(
      userMessage
    )
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
   SIMPLE MVP PRICE FLOW
========================================================= */

function parseShopperPriceAndDelivery(text) {
  const value =
    String(text || "")
      .trim()
      .replace(/,/g, "")
      .replace(/\s+/g, " ");

  const match =
    value.match(
      /^price\s*:?\s*₹?\s*(\d+(?:\.\d{1,2})?)\s+delivery(?:\s+fee)?\s*:?\s*₹?\s*(\d+(?:\.\d{1,2})?)(?:\s*(?:rs|inr|rupees))?$/i
    );

  if (!match) {
    return null;
  }

  const itemTotal =
    Number(match[1]);

  const deliveryFee =
    Number(match[2]);

  if (
    !Number.isFinite(itemTotal) ||
    itemTotal < 0 ||
    !Number.isFinite(deliveryFee) ||
    deliveryFee < 20
  ) {
    return null;
  }

  return {
    itemTotal,
    deliveryFee,
  };
}

function buildCustomerPriceApprovalMessage(order) {
  const itemTotal =
    Number(order.item_total || 0);

  const deliveryFee =
    Number(order.delivery_fee || 0);

  const total =
    itemTotal +
    deliveryFee +
    Number(order.fetch_fee || 0);

  return (
    `🧾 Product price: ₹${formatRupees(
      itemTotal
    )}\n` +
    `🚚 Delivery fee: ₹${formatRupees(
      deliveryFee
    )}\n` +
    `💼 Fetch fee: ₹0\n` +
    `💰 Total: ₹${formatRupees(
      total
    )}\n\n` +
    `Delivery price is decided by the shopper; prices may vary.\n` +
    `Minimum is ₹20 per order and may increase based on the KM.\n\n` +
    `Is that okay? Reply YES or NO.`
  );
}

async function ensureStoreForOrder(order) {
  if (!order?.store_name) {
    return null;
  }

  const existing =
    await getStoreByName(
      order.store_name
    );

  if (existing) {
    return existing;
  }

  const raw =
    String(
      order.store_name
    ).trim();

  const pieces =
    raw
      .split(",")
      .map(
        (piece) =>
          piece.trim()
      )
      .filter(Boolean);

  const name =
    pieces.length >= 2
      ? pieces[0]
      : raw;

  const address =
    pieces.length >= 2
      ? pieces.slice(1).join(", ")
      : raw;

  try {
    const data =
      await supabaseRequest(
        "stores",
        {
          method:
            "POST",

          headers: {
            Prefer:
              "return=representation",
          },

          body:
            JSON.stringify({
              name,
              address,
              active:
                true,
            }),
        }
      );

    const store =
      Array.isArray(data)
        ? data[0]
        : data;

    if (
      store?.id
    ) {
      await updateOrder(
        order.id,
        {
          store_id:
            store.id,

          store_name:
            store.name,
        }
      );
    }

    return store;
  } catch (error) {
    console.error(
      "FETCH ENSURE STORE ERROR:",
      error
    );

    return null;
  }
}


/* =========================================================
   ORDER RECEIPTS
========================================================= */

function buildCustomerReceiptMessage(order) {
  const productPrice =
    Number(order?.item_total || 0);

  const deliveryFee =
    Number(order?.delivery_fee || 0);

  const fetchFee =
    Number(order?.fetch_fee || 0);

  const total =
    Number(
      order?.total_amount ??
      productPrice +
      deliveryFee +
      fetchFee
    );

  const paymentLine =
    order?.payment_method === "shopper_upi"
      ? "💳 Payment: Paid directly to shopper via UPI"
      : order?.payment_status === "paid"
        ? "💳 Payment: Paid"
        : "💳 Payment: Payment details recorded";

  return (
    `🎉 Order delivered!\n\n` +
    `🏪 Store: ${order?.store_name || "Store"}\n` +
    `🛒 Items: ${order?.items || "Your items"}\n\n` +
    `🧾 Product price: ₹${formatRupees(productPrice)}\n` +
    `🚚 Delivery fee: ₹${formatRupees(deliveryFee)}\n` +
    `💼 Fetch fee: ₹${formatRupees(fetchFee)}\n` +
    `💰 Total: ₹${formatRupees(total)}\n\n` +
    `${paymentLine}\n\n` +
    `Thanks for using Fetch ❤️`
  );
}

function buildShopperCompletionMessage(order) {
  const deliveryFee =
    Number(order?.delivery_fee || 0);

  return (
    `Order completed ✅\n\n` +
    `💰 Delivery earnings: ₹${formatRupees(deliveryFee)}\n\n` +
    `Thanks for completing the Fetch order. You’re available for the next job.`
  );
}


/* =========================================================
   CUSTOMER RATINGS
========================================================= */

function parseCustomerRating(text) {
  const raw =
    String(text || "")
      .trim()
      .toLowerCase();

  const match =
    raw.match(
      /(?:^|\b)([1-5])(?:\s*(?:stars?|\/\s*5))?(?:\b|$)/
    );

  if (!match) {
    return null;
  }

  const rating =
    Number(match[1]);

  return Number.isInteger(rating) &&
    rating >= 1 &&
    rating <= 5
    ? rating
    : null;
}

function buildCustomerRatingRequest() {
  return (
    `⭐ How was your Fetch experience?\n\n` +
    `Reply with a rating from 1 to 5.`
  );
}

function buildCustomerRatingThanks(rating) {
  const stars =
    "⭐".repeat(
      Math.max(
        1,
        Math.min(5, Number(rating))
      )
    );

  return `Thanks! ${stars}\nYour feedback helps Fetch improve.`;
}


/* =========================================================
   SHOPPER EARNINGS
========================================================= */

async function getShopperEarningsSummary(shopperId) {
  const data =
    await supabaseRequest(
      `orders?shopper_id=eq.${encodeURIComponent(
        shopperId
      )}&status=eq.delivered&select=id,items,store_name,shopper_delivery_earnings,shopper_earnings_paid,created_at&order=created_at.desc&limit=200`
    );

  const orders =
    Array.isArray(data)
      ? data
      : [];

  const todayKey =
    new Intl.DateTimeFormat(
      "en-CA",
      {
        timeZone:
          "Asia/Kolkata",
        year:
          "numeric",
        month:
          "2-digit",
        day:
          "2-digit",
      }
    ).format(
      new Date()
    );

  let todayEarnings = 0;
  let totalEarnings = 0;
  let availableEarnings = 0;
  let paidOut = 0;
  let completedOrders = 0;

  const recentEarningOrders = [];

  for (const order of orders) {
    const amount =
      Number(
        order?.shopper_delivery_earnings ??
        0
      );

    const safeAmount =
      Number.isFinite(amount)
        ? amount
        : 0;

    completedOrders += 1;
    totalEarnings += safeAmount;

    const paid =
      order?.shopper_earnings_paid ===
      true;

    if (paid) {
      paidOut += safeAmount;
    } else {
      availableEarnings +=
        safeAmount;
    }

    const created =
      String(
        order?.created_at || ""
      );

    const createdKey =
      created
        ? new Intl.DateTimeFormat(
            "en-CA",
            {
              timeZone:
                "Asia/Kolkata",
              year:
                "numeric",
              month:
                "2-digit",
              day:
                "2-digit",
            }
          ).format(
            new Date(
              created
            )
          )
        : "";

    if (
      createdKey ===
        todayKey
    ) {
      todayEarnings +=
        safeAmount;
    }

    if (
      safeAmount > 0 &&
      recentEarningOrders.length <
        5
    ) {
      recentEarningOrders.push({
        id:
          order.id,

        store:
          order.store_name ||
          "Store",

        items:
          order.items ||
          "Items",

        amount:
          safeAmount,

        paid:
          paid,

        created_at:
          order.created_at,
      });
    }
  }

  return {
    todayEarnings,
    totalEarnings,
    availableEarnings,
    paidOut,
    completedOrders,
    recentEarningOrders,
  };
}

function shortOrderId(id) {
  return String(id || "")
    .replace(/-/g, "")
    .slice(0, 8)
    .toUpperCase();
}

function buildShopperEarningsMessage(
  summary
) {
  const recent =
    Array.isArray(
      summary.recentEarningOrders
    ) &&
    summary.recentEarningOrders.length
      ? `\n\nRecent earnings:\n` +
        summary.recentEarningOrders
          .map(
            (order) =>
              `• #${shortOrderId(
                order.id
              )} — ₹${formatRupees(
                order.amount
              )} — ${order.store}`
          )
          .join("\n")
      : "\n\nNo earning orders yet.";

  return (
    `💰 Your Fetch earnings\n\n` +
    `Today: ₹${formatRupees(
      summary.todayEarnings
    )}\n` +
    `Completed orders: ${summary.completedOrders}\n` +
    `Total earnings: ₹${formatRupees(
      summary.totalEarnings
    )}\n` +
    `Available: ₹${formatRupees(
      summary.availableEarnings
    )}\n` +
    `Paid out: ₹${formatRupees(
      summary.paidOut
    )}` +
    recent
  );
}

function buildShopperPayoutMessage(
  summary
) {
  return (
    `💰 Fetch payout status\n\n` +
    `Available: ₹${formatRupees(
      summary.availableEarnings
    )}\n` +
    `Paid out: ₹${formatRupees(
      summary.paidOut
    )}\n\n` +
    `Payouts are handled manually during the Fetch MVP.`
  );
}



async function getShopperLastOrder(shopperId) {
  const data =
    await supabaseRequest(
      `orders?shopper_id=eq.${encodeURIComponent(
        shopperId
      )}&select=*&order=created_at.desc&limit=1`
    );

  return Array.isArray(data) &&
    data.length
    ? data[0]
    : null;
}

function isShopperLastOrderQuestion(text) {
  const value =
    cleanConversationText(
      text
    ).toLowerCase();

  return (
    /(?:last|latest|recent)\s+(?:order|job)/.test(
      value
    ) ||
    /order\s+details/.test(
      value
    ) ||
    /details\s+(?:of|for)\s+(?:the\s+)?(?:last|latest|recent)\s+order/.test(
      value
    ) ||
    /can\s+you\s+(?:share|show|send)\s+(?:me\s+)?(?:the\s+)?(?:order|job)\s+details/.test(
      value
    ) ||
    /what\s+(?:was|is)\s+(?:my\s+)?(?:last|latest)\s+order/.test(
      value
    )
  );
}

function buildShopperLastOrderMessage(order) {
  if (!order) {
    return (
      "I don’t have a previous Fetch order for you yet."
    );
  }

  const status =
    formatOrderHistoryStatus(
      order.status
    );

  const productPrice =
    Number(
      order.item_total || 0
    );

  const deliveryFee =
    Number(
      order.delivery_fee || 0
    );

  const total =
    Number(
      order.total_amount || 0
    );

  return (
    `📦 Your latest Fetch order\n\n` +
    `#${shortOrderReference(
      order.id
    )}\n` +
    `🛒 Items: ${order.items || "Items"}\n` +
    `🏪 Store: ${order.store_name || "Store"}\n` +
    `📍 Deliver to: ${order.delivery_address || "Customer location"}\n` +
    `📌 Status: ${status}\n\n` +
    `🧾 Product price: ₹${formatRupees(productPrice)}\n` +
    `🚚 Delivery fee: ₹${formatRupees(deliveryFee)}\n` +
    `💰 Total: ₹${formatRupees(total)}\n` +
    `💵 Your delivery earnings: ₹${formatRupees(
      order.shopper_delivery_earnings ||
      order.delivery_fee ||
      0
    )}`
  );
}


function isShopperCurrentDetailsQuestion(text) {
  const value =
    cleanConversationText(
      text
    ).toLowerCase();

  return /^(?:details|order details|job details|current order|current job|show details|show my order details|show my job details)$/i.test(
    value
  );
}


/* =========================================================
   QUEUED ORDER DISPATCH
========================================================= */

async function getQueuedOrders(
  limit = 20
) {
  const safeLimit =
    Math.max(
      1,
      Math.min(
        Number(limit) || 20,
        50
      )
    );

  const data =
    await supabaseRequest(
      `orders?status=eq.finding_shopper&shopper_id=is.null&select=*&order=created_at.asc&limit=${safeLimit}`
    );

  return Array.isArray(data)
    ? data
    : [];
}

async function dispatchNextQueuedOrder(
  shopperId
) {
  if (!shopperId) {
    return {
      success: false,
      reason: "missing_shopper",
      order: null,
      shopper: null,
      job: null,
    };
  }

  const shoppers =
    await supabaseRequest(
      `shoppers?id=eq.${encodeURIComponent(
        shopperId
      )}&available=eq.true&whatsapp_opted_in=eq.true&select=*&limit=1`
    );

  const shopper =
    Array.isArray(shoppers) &&
    shoppers.length
      ? shoppers[0]
      : null;

  if (!shopper) {
    return {
      success: false,
      reason: "shopper_not_available",
      order: null,
      shopper: null,
      job: null,
    };
  }

  const queuedOrders =
    await getQueuedOrders(
      20
    );

  for (
    const queuedOrder of
      queuedOrders
  ) {
    try {
      const dispatch =
        await offerOrderToShopper(
          queuedOrder,
          [],
          shopper.id
        );

      if (
        dispatch?.success
      ) {
        return {
          ...dispatch,
          order:
            queuedOrder,
        };
      }
    } catch (error) {
      console.error(
        "FETCH QUEUED ORDER DISPATCH ERROR:",
        error
      );
    }
  }

  return {
    success: false,
    reason: "no_queued_order",
    order: null,
    shopper: null,
    job: null,
  };
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

  /* AVAILABLE / READY */

  if (
    isShopperAvailabilityMessage(
      rawText
    )
  ) {
    if (
      shopper.current_order_id
    ) {
      await sendWhatsAppMessage(
        normalizedPhone,
        "You’re still assigned to an active Fetch order. Finish that order first; once you send DELIVERED, you can say AVAILABLE FOR NEXT JOB."
      );
      return;
    }

    const updatedShopper =
      await updateShopper(
        shopper.id,
        {
          available:
            true,

          last_seen_at:
            new Date().toISOString(),
        }
      );

    if (!updatedShopper) {
      await sendWhatsAppMessage(
        normalizedPhone,
        "I couldn’t update your availability right now. Please try again."
      );
      return;
    }

    const queuedDispatch =
      await dispatchNextQueuedOrder(
        shopper.id
      );

    if (
      queuedDispatch.success
    ) {
      await sendWhatsAppMessage(
        normalizedPhone,
        `You’re available ✅ I found a waiting Fetch order for you.`
      );

      return;
    }

    await sendWhatsAppMessage(
      normalizedPhone,
      "You’re available ✅ I’ll send you the next Fetch job when one is available."
    );

    return;
  }

  /* UPI ID */

  const shopperUpiId =
    parseShopperUpiId(
      rawText
    );

  if (
    shopperUpiId
  ) {
    const savedShopper =
      await updateShopper(
        shopper.id,
        {
          upi_id:
            shopperUpiId,

          last_seen_at:
            new Date().toISOString(),
        }
      );

    if (!savedShopper) {
      await sendWhatsAppMessage(
        normalizedPhone,
        "I couldn’t recognise those payment details. Send your UPI ID or UPI-linked mobile number, for example: 9876543210 or name@bank."
      );
      return;
    }

    await sendWhatsAppMessage(
      normalizedPhone,
      `Payment details saved ✅\n\n${shopperUpiId}\n\nThe customer can now pay you directly using these details.`
    );

    return;
  }

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

      "Accepted ✅\n\nPlease check the product price and decide the delivery fee. Reply like this:\nPRICE: 35 DELIVERY FEE: 20\n\nDelivery price is decided by the shopper; prices may vary. Minimum is ₹20 per order and may increase based on the KM."
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

    const nextDispatch =
      await dispatchNextQueuedOrder(
        shopper.id
      );

    if (
      nextDispatch.success
    ) {
      await sendWhatsAppMessage(
        normalizedPhone,
        "I’ve sent you the next waiting Fetch job."
      );
    }

    return;
  }

  /* EARNINGS */

  if (
    command === "EARNINGS" ||
    command === "EARNING" ||
    command === "MY EARNINGS"
  ) {
    try {
      const summary =
        await getShopperEarningsSummary(
          shopper.id
        );

      await sendWhatsAppMessage(
        normalizedPhone,
        buildShopperEarningsMessage(
          summary
        )
      );
    } catch (error) {
      console.error(
        "FETCH SHOPPER EARNINGS ERROR:",
        error
      );

      await sendWhatsAppMessage(
        normalizedPhone,
        "I couldn’t load your earnings right now. Please try again."
      );
    }

    return;
  }

  /* PAYOUT */

  if (
    command === "PAYOUT" ||
    command === "PAYOUTS"
  ) {
    try {
      const summary =
        await getShopperEarningsSummary(
          shopper.id
        );

      await sendWhatsAppMessage(
        normalizedPhone,
        buildShopperPayoutMessage(
          summary
        )
      );
    } catch (error) {
      console.error(
        "FETCH SHOPPER PAYOUT STATUS ERROR:",
        error
      );

      await sendWhatsAppMessage(
        normalizedPhone,
        "I couldn’t load your payout status right now. Please try again."
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

  /* CURRENT ORDER / JOB DETAILS */

  if (
    isShopperCurrentDetailsQuestion(
      rawText
    )
  ) {
    const acceptedJob =
      await getAcceptedShopperJob(
        shopper.id
      );

    if (
      acceptedJob
    ) {
      const currentOrder =
        await getOrderById(
          acceptedJob.order_id
        );

      if (
        currentOrder
      ) {
        await sendWhatsAppMessage(
          normalizedPhone,
          buildShopperLastOrderMessage(
            currentOrder
          )
        );

        return;
      }
    }

    const latestOrder =
      await getShopperLastOrder(
        shopper.id
      );

    await sendWhatsAppMessage(
      normalizedPhone,
      buildShopperLastOrderMessage(
        latestOrder
      )
    );

    return;
  }

  /* LAST ORDER / ORDER DETAILS */

  if (
    isShopperLastOrderQuestion(
      rawText
    )
  ) {
    try {
      const lastOrder =
        await getShopperLastOrder(
          shopper.id
        );

      await sendWhatsAppMessage(
        normalizedPhone,
        buildShopperLastOrderMessage(
          lastOrder
        )
      );
    } catch (error) {
      console.error(
        "FETCH SHOPPER LAST ORDER ERROR:",
        error
      );

      await sendWhatsAppMessage(
        normalizedPhone,
        "I couldn’t load your last order details right now. Please try again."
      );
    }

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

  /* CUSTOMER PAYMENT NOT RECEIVED */

  if (
    isShopperNotReceivedMessage(
      rawText
    )
  ) {
    const openAcceptedJob =
      await getAcceptedShopperJob(
        shopper.id
      );

    if (!openAcceptedJob) {
      await sendWhatsAppMessage(
        normalizedPhone,
        "I don’t have an active Fetch payment waiting for confirmation."
      );
      return;
    }

    const paymentOrder =
      await getOrderById(
        openAcceptedJob.order_id
      );

    if (!paymentOrder) {
      await sendWhatsAppMessage(
        normalizedPhone,
        "I couldn’t find the order linked to this payment."
      );
      return;
    }

    if (
      paymentOrder.status !==
        "payment_pending" ||
      paymentOrder.payment_status !==
        "customer_reported_paid"
    ) {
      await sendWhatsAppMessage(
        normalizedPhone,
        "There isn’t a customer payment waiting for your confirmation right now."
      );
      return;
    }

    await updateOrder(
      paymentOrder.id,
      {
        payment_status:
          "pending",
      }
    );

    await sendWhatsAppMessage(
      normalizedPhone,
      "Okay. I haven’t verified the payment. Please wait for the customer to pay and check your UPI again."
    );

    await notifyCustomerForOrder(
      paymentOrder.id,
      "The shopper hasn’t received the payment yet. Please check your payment and send it again if needed."
    );

    return;
  }

  /* CUSTOMER PAYMENT RECEIVED BY SHOPPER */

  if (
    isShopperPaymentReceivedMessage(
      rawText
    )
  ) {
    const openAcceptedJob =
      await getAcceptedShopperJob(
        shopper.id
      );

    if (!openAcceptedJob) {
      await sendWhatsAppMessage(
        normalizedPhone,
        "I don’t have an active Fetch payment waiting for confirmation."
      );
      return;
    }

    const paymentOrder =
      await getOrderById(
        openAcceptedJob.order_id
      );

    if (!paymentOrder) {
      await sendWhatsAppMessage(
        normalizedPhone,
        "I couldn’t find the order linked to this payment."
      );
      return;
    }

    if (
      paymentOrder.status !==
        "payment_pending" ||
      paymentOrder.payment_status !==
        "customer_reported_paid"
    ) {
      await sendWhatsAppMessage(
        normalizedPhone,
        "There isn’t a customer payment waiting for your confirmation right now."
      );
      return;
    }

    const paidOrder =
      await updateOrder(
        paymentOrder.id,
        {
          payment_status:
            "paid",

          payment_method:
            "shopper_upi",

          status:
            "shopping",
        }
      );

    if (!paidOrder) {
      throw new Error(
        "Could not confirm shopper payment"
      );
    }

    await sendWhatsAppMessage(
      normalizedPhone,
      "Payment verified ✅ You can purchase the items and continue shopping.\n\nReply SHOPPING when you start shopping."
    );

    await notifyCustomerForOrder(
      paidOrder.id,
      "💳 Payment confirmed by your shopper ✅ They can now purchase your items and continue shopping."
    );

    return;
  }

  /* PRODUCT PRICE + DELIVERY FEE */

  const shopperPrice =
    parseShopperPriceAndDelivery(
      rawText
    );

  if (
    shopperPrice
  ) {
    const total =
      shopperPrice.itemTotal +
      shopperPrice.deliveryFee +
      FETCH_FEE;

    const updatedOrder =
      await updateOrder(
        order.id,
        {
          item_total:
            shopperPrice.itemTotal,

          fetch_fee:
            FETCH_FEE,

          delivery_fee:
            shopperPrice.deliveryFee,

          total_amount:
            total,

          delivery_pricing_status:
            "calculated",

          delivery_pricing_source:
            "shopper_entered",

          priced_at:
            new Date().toISOString(),

          status:
            "awaiting_customer_price_confirmation",
        }
      );

    if (!updatedOrder) {
      await sendWhatsAppMessage(
        normalizedPhone,
        "I couldn’t save the price. Please use: PRICE: 35 DELIVERY FEE: 20"
      );
      return;
    }

    await sendWhatsAppMessage(
      normalizedPhone,
      `Price saved ✅\n\nProduct price: ₹${formatRupees(
        shopperPrice.itemTotal
      )}\nDelivery fee: ₹${formatRupees(
        shopperPrice.deliveryFee
      )}\nTotal: ₹${formatRupees(
        total
      )}\n\nI’ve sent it to the customer for approval.`
    );

    await notifyCustomerForOrder(
      order.id,
      buildCustomerPriceApprovalMessage(
        updatedOrder
      )
    );

    return;
  }

  if (
    /^price\b/i.test(
      rawText
    )
  ) {
    await sendWhatsAppMessage(
      normalizedPhone,
      "Please include both values like this:\nPRICE: 35 DELIVERY FEE: 20\n\nDelivery price is decided by the shopper; prices may vary. Minimum is ₹20 per order and may increase based on the KM."
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
    if (
      order.status !==
        "out_for_delivery"
    ) {
      await sendWhatsAppMessage(
        normalizedPhone,
        shopperStateMessage(
          order.status
        )
      );
      return;
    }

    const completedAt =
      new Date().toISOString();

    const receiptOrder =
      await updateOrder(
        order.id,
        {
          status:
            "delivered",

          receipt_sent_at:
            completedAt,

          shopper_delivery_earnings:
            Number(
              order.delivery_fee || 0
            ),

          customer_rating:
            null,

          rated_at:
            null,
        }
      );

    if (!receiptOrder) {
      throw new Error(
        "Could not complete Fetch order"
      );
    }

    await updateShopperJob(
      job.id,
      {
        status:
          "completed",

        completed_at:
          completedAt,
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
          completedAt,
      }
    );

    const nextDispatch =
      await dispatchNextQueuedOrder(
        shopper.id
      );

    await sendWhatsAppMessage(
      normalizedPhone,
      buildShopperCompletionMessage(
        receiptOrder
      )
    );

    if (
      nextDispatch.success
    ) {
      await sendWhatsAppMessage(
        normalizedPhone,
        "I’ve also sent you the next waiting Fetch job."
      );
    }

    await notifyCustomerForOrder(
      order.id,
      buildCustomerReceiptMessage(
        receiptOrder
      )
    );

    await notifyCustomerForOrder(
      order.id,
      buildCustomerRatingRequest()
    );

    return;
  }

  await sendWhatsAppMessage(
    normalizedPhone,

    "I didn’t recognise that command. You can send UPI/payment details, ACCEPT, PRICE + DELIVERY FEE, RECEIVED, NOT RECEIVED, SHOPPING, SUBSTITUTE, PICKED UP, OUT FOR DELIVERY, DELIVERED, AVAILABLE, EARNINGS, PAYOUT, LAST ORDER or STATUS."
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
