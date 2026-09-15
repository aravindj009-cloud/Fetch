/*
  Fetch ATC V1 — orchestration engine.

  Phase:
    ACTIVE RESOURCE MATCHING

  ATC owns:
    - task representation
    - resource representation
    - resource matching decision
    - assignment/event recording

  Existing Fetch order/shopper tables remain the execution system.
  ATC failure must never break the WhatsApp MVP.
*/

const SUPABASE_URL =
  process.env.VITE_SUPABASE_URL ||
  "https://skfxzagxlxputwpwxwbe.supabase.co";

const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;

function headers(extra = {}) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function atcRequest(path, options = {}) {
  if (!SUPABASE_KEY) {
    throw new Error("SUPABASE_SECRET_KEY is missing");
  }

  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/${path}`,
    {
      ...options,
      headers: headers(options.headers || {}),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`ATC Supabase ${response.status}: ${text}`);
  }

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

export function mapOrderStatusToTaskStatus(status) {
  switch (String(status || "").toLowerCase()) {
    case "collecting_details":
    case "awaiting_confirmation":
      return "intake";

    case "finding_shopper":
      return "resource_search";

    case "shopper_assigned":
      return "assigned";

    case "awaiting_customer_price_confirmation":
    case "payment_pending":
    case "customer_reported_paid":
      return "awaiting_input";

    case "shopping":
    case "picked_up":
    case "out_for_delivery":
      return "executing";

    case "delivered":
    case "completed":
      return "completed";

    case "cancelled":
      return "cancelled";

    default:
      return "created";
  }
}

export async function atcCreateTaskForOrder(order) {
  if (!order?.id) return null;

  const task = {
    source_type: "order",
    source_id: String(order.id),
    task_type: "purchase_and_deliver",
    objective: `Purchase and deliver ${order.items || "requested items"}`,
    status: mapOrderStatusToTaskStatus(order.status),
    input: {
      order_id: order.id,
      customer_id: order.customer_id,
      items: order.items || null,
      requested_store: order.store_name || null,
      delivery_address: order.delivery_address || null,
      customer_latitude: order.customer_latitude ?? null,
      customer_longitude: order.customer_longitude ?? null,
    },
  };

  const rows = await atcRequest(
    "atc_tasks?on_conflict=source_type,source_id",
    {
      method: "POST",
      headers: {
        Prefer: "resolution=merge-duplicates,return=representation",
      },
      body: JSON.stringify(task),
    }
  );

  return Array.isArray(rows) ? rows[0] || null : rows;
}

export async function atcSyncTaskFromOrder(order) {
  if (!order?.id) return null;

  const rows = await atcRequest(
    `atc_tasks?source_type=eq.order&source_id=eq.${encodeURIComponent(
      String(order.id)
    )}&select=id,status&limit=1`
  );

  const task = Array.isArray(rows) && rows.length ? rows[0] : null;

  if (!task) {
    return atcCreateTaskForOrder(order);
  }

  const updated = await atcRequest(
    `atc_tasks?id=eq.${encodeURIComponent(task.id)}`,
    {
      method: "PATCH",
      headers: {
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        status: mapOrderStatusToTaskStatus(order.status),
        output: {
          order_status: order.status || null,
          shopper_id: order.shopper_id || null,
          item_total: order.item_total ?? null,
          delivery_fee: order.delivery_fee ?? null,
          total_amount: order.total_amount ?? null,
          payment_status: order.payment_status || null,
        },
      }),
    }
  );

  return Array.isArray(updated) ? updated[0] || null : updated;
}

export async function atcSyncShopperResource(shopper) {
  if (!shopper?.id) return null;

  const status =
    shopper.current_order_id
      ? "busy"
      : shopper.available
        ? "available"
        : "offline";

  const latitude =
    Number.isFinite(Number(shopper.latitude))
      ? Number(shopper.latitude)
      : Number.isFinite(Number(shopper.current_latitude))
        ? Number(shopper.current_latitude)
        : null;

  const longitude =
    Number.isFinite(Number(shopper.longitude))
      ? Number(shopper.longitude)
      : Number.isFinite(Number(shopper.current_longitude))
        ? Number(shopper.current_longitude)
        : null;

  const row = {
    resource_type: "human_shopper",
    external_id: String(shopper.id),
    display_name: shopper.name || null,
    status,
    capabilities: ["purchase", "pickup", "delivery"],
    location: {
      latitude,
      longitude,
    },
    metadata: {
      phone: shopper.phone || null,
      whatsapp_opted_in: Boolean(shopper.whatsapp_opted_in),
      approval_status: shopper.approval_status || null,
      onboarding_step: shopper.onboarding_step || null,
      current_order_id: shopper.current_order_id || null,
      last_seen_at: shopper.last_seen_at || null,
    },
  };

  const rows = await atcRequest(
    "atc_resources?on_conflict=resource_type,external_id",
    {
      method: "POST",
      headers: {
        Prefer: "resolution=merge-duplicates,return=representation",
      },
      body: JSON.stringify(row),
    }
  );

  return Array.isArray(rows) ? rows[0] || null : rows;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const a1 = Number(lat1);
  const o1 = Number(lon1);
  const a2 = Number(lat2);
  const o2 = Number(lon2);

  if (![a1, o1, a2, o2].every(Number.isFinite)) {
    return null;
  }

  const toRad = (value) => (value * Math.PI) / 180;
  const dLat = toRad(a2 - a1);
  const dLon = toRad(o2 - o1);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a1)) *
      Math.cos(toRad(a2)) *
      Math.sin(dLon / 2) ** 2;

  return 6371 * 2 * Math.atan2(
    Math.sqrt(h),
    Math.sqrt(1 - h)
  );
}

/*
  ATC V1 MATCHING POLICY

  Priority:
    1. Resource must be available.
    2. Resource must not already be assigned.
    3. If both task and resource have coordinates, prefer the nearest shopper.
    4. If coordinates are unavailable, use the freshest available resource.

  This is intentionally deterministic and explainable.
  We are NOT introducing AI matching or dynamic pricing yet.
*/
export async function atcSelectResourceForOrder({
  order,
  excludedShopperIds = [],
}) {
  if (!order?.id) return null;

  const excluded = new Set(
    (Array.isArray(excludedShopperIds)
      ? excludedShopperIds
      : []
    ).map(String)
  );

  const resources = await atcRequest(
    "atc_resources?resource_type=eq.human_shopper&status=eq.available&select=*&limit=100"
  );

  if (!Array.isArray(resources) || !resources.length) {
    return null;
  }

  const customerLat = Number(order.customer_latitude);
  const customerLon = Number(order.customer_longitude);

  const candidates = resources
    .filter((resource) => {
      const shopperId = String(resource.external_id || "");
      if (!shopperId || excluded.has(shopperId)) return false;

      const metadata = resource.metadata || {};
      if (metadata.current_order_id) return false;
      if (metadata.approval_status !== "approved") return false;
      if (!metadata.whatsapp_opted_in) return false;

      return true;
    })
    .map((resource) => {
      const location = resource.location || {};
      const distanceKm = haversineKm(
        customerLat,
        customerLon,
        location.latitude,
        location.longitude
      );

      const updatedAt = Date.parse(resource.updated_at || "");
      const freshness = Number.isFinite(updatedAt)
        ? updatedAt
        : 0;

      return {
        resource,
        shopperId: String(resource.external_id),
        distanceKm,
        freshness,
      };
    });

  if (!candidates.length) {
    return null;
  }

  candidates.sort((a, b) => {
    const aHasDistance = Number.isFinite(a.distanceKm);
    const bHasDistance = Number.isFinite(b.distanceKm);

    if (aHasDistance && bHasDistance) {
      return a.distanceKm - b.distanceKm;
    }

    if (aHasDistance) return -1;
    if (bHasDistance) return 1;

    return b.freshness - a.freshness;
  });

  const winner = candidates[0];

  await atcSafe(
    () => atcRecordEvent({
      orderId: order.id,
      eventType: "resource_matched",
      actorType: "atc",
      actorId: winner.shopperId,
      metadata: {
        resource_type: "human_shopper",
        match_reason: Number.isFinite(winner.distanceKm)
          ? "nearest_available_resource"
          : "freshest_available_resource",
        distance_km: Number.isFinite(winner.distanceKm)
          ? Number(winner.distanceKm.toFixed(2))
          : null,
      },
    }),
    "resource_matched_event"
  );

  return {
    shopperId: winner.shopperId,
    resourceId: winner.resource.id,
    distanceKm: Number.isFinite(winner.distanceKm)
      ? Number(winner.distanceKm.toFixed(2))
      : null,
    reason: Number.isFinite(winner.distanceKm)
      ? "nearest_available_resource"
      : "freshest_available_resource",
  };
}

export async function atcRecordAssignment({
  orderId,
  shopperId,
  status = "offered",
  jobId = null,
}) {
  if (!orderId || !shopperId) return null;

  const resourceRows = await atcRequest(
    `atc_resources?resource_type=eq.human_shopper&external_id=eq.${encodeURIComponent(
      String(shopperId)
    )}&select=id&limit=1`
  );

  const resource =
    Array.isArray(resourceRows) && resourceRows.length
      ? resourceRows[0]
      : null;

  if (!resource?.id) return null;

  const payload = {
    task_source_type: "order",
    task_source_id: String(orderId),
    resource_id: resource.id,
    status,
    external_assignment_id: jobId ? String(jobId) : null,
  };

  const rows = await atcRequest(
    "atc_task_assignments",
    {
      method: "POST",
      headers: {
        Prefer: "return=representation",
      },
      body: JSON.stringify(payload),
    }
  );

  return Array.isArray(rows) ? rows[0] || null : rows;
}

export async function atcRecordEvent({
  orderId,
  eventType,
  fromStatus = null,
  toStatus = null,
  actorType = "system",
  actorId = null,
  metadata = {},
}) {
  if (!orderId || !eventType) return null;

  const rows = await atcRequest(
    "atc_task_events",
    {
      method: "POST",
      headers: {
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        task_source_type: "order",
        task_source_id: String(orderId),
        event_type: eventType,
        from_status: fromStatus,
        to_status: toStatus,
        actor_type: actorType,
        actor_id: actorId ? String(actorId) : null,
        metadata,
      }),
    }
  );

  return Array.isArray(rows) ? rows[0] || null : rows;
}

export async function atcSafe(fn, label) {
  try {
    return await fn();
  } catch (error) {
    console.error(`FETCH ATC SHADOW ERROR [${label}]:`, error);
    return null;
  }
}
