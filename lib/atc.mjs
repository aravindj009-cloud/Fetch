/*
  Fetch ATC V1 — orchestration shadow layer.

  IMPORTANT:
  This module is intentionally additive. It records the generic
  Task / Resource / Assignment model alongside the proven MVP flow.
  It does NOT replace shopper_jobs or the existing order state machine yet.

  Required server environment:
  SUPABASE_SECRET_KEY
  VITE_SUPABASE_URL
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

  const row = {
    resource_type: "human_shopper",
    external_id: String(shopper.id),
    display_name: shopper.name || null,
    status,
    capabilities: ["purchase", "pickup", "delivery"],
    location: {
      latitude: shopper.latitude ?? null,
      longitude: shopper.longitude ?? null,
    },
    metadata: {
      phone: shopper.phone || null,
      whatsapp_opted_in: Boolean(shopper.whatsapp_opted_in),
      approval_status: shopper.approval_status || null,
      onboarding_step: shopper.onboarding_step || null,
      current_order_id: shopper.current_order_id || null,
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

/*
  Safe wrapper used by the existing MVP.
  ATC failures are logged but NEVER break WhatsApp ordering.
*/
export async function atcSafe(fn, label) {
  try {
    return await fn();
  } catch (error) {
    console.error(`FETCH ATC SHADOW ERROR [${label}]:`, error);
    return null;
  }
}
