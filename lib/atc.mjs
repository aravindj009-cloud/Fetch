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

    case "finding_partner":
      return "resource_search";

    case "partner_offered":
      return "awaiting_input";

    case "partner_accepted":
      return "resource_search";

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

  const existingRows = await atcRequest(
    `atc_resources?resource_type=eq.human_shopper&external_id=eq.${encodeURIComponent(
      String(shopper.id)
    )}&select=location&limit=1`
  );

  const existingLocation =
    Array.isArray(existingRows) && existingRows.length
      ? existingRows[0]?.location || {}
      : {};

  const incomingLatitude = Number(shopper.latitude);
  const incomingLongitude = Number(shopper.longitude);

  const incomingLocationIsValid =
    Number.isFinite(incomingLatitude) &&
    Number.isFinite(incomingLongitude) &&
    incomingLatitude >= -90 &&
    incomingLatitude <= 90 &&
    incomingLongitude >= -180 &&
    incomingLongitude <= 180 &&
    !(incomingLatitude === 0 && incomingLongitude === 0);

  const existingLatitude = Number(existingLocation.latitude);
  const existingLongitude = Number(existingLocation.longitude);

  const existingLocationIsValid =
    Number.isFinite(existingLatitude) &&
    Number.isFinite(existingLongitude) &&
    existingLatitude >= -90 &&
    existingLatitude <= 90 &&
    existingLongitude >= -180 &&
    existingLongitude <= 180 &&
    !(existingLatitude === 0 && existingLongitude === 0);

  const latitude = incomingLocationIsValid
    ? incomingLatitude
    : existingLocationIsValid
      ? existingLatitude
      : null;

  const longitude = incomingLocationIsValid
    ? incomingLongitude
    : existingLocationIsValid
      ? existingLongitude
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

export async function atcUpdateShopperLocation({
  shopper,
  latitude,
  longitude,
  source = "whatsapp_location",
}) {
  if (!shopper?.id) return null;

  const lat = Number(latitude);
  const lon = Number(longitude);

  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    lat < -90 ||
    lat > 90 ||
    lon < -180 ||
    lon > 180 ||
    (lat === 0 && lon === 0)
  ) {
    return null;
  }

  return atcSyncShopperResource({
    ...shopper,
    latitude: lat,
    longitude: lon,
    metadata: {
      ...(shopper.metadata || {}),
      last_location_source: source,
      last_location_at: new Date().toISOString(),
    },
  });
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
    (Array.isArray(excludedShopperIds) ? excludedShopperIds : []).map(String)
  );

  const resources = await atcRequest(
    "atc_resources?resource_type=eq.human_shopper&status=eq.available&select=*&limit=100"
  );

  if (!Array.isArray(resources) || !resources.length) return null;

  const customerLat = Number(order.customer_latitude);
  const customerLon = Number(order.customer_longitude);

  const customerHasValidLocation =
    Number.isFinite(customerLat) &&
    Number.isFinite(customerLon) &&
    customerLat >= -90 &&
    customerLat <= 90 &&
    customerLon >= -180 &&
    customerLon <= 180 &&
    !(customerLat === 0 && customerLon === 0);

  // V1.3 capability requirements for the current Fetch MVP.
  // Future task types can define different capability sets here.
  const requiredCapabilities = ["purchase", "pickup", "delivery"];

  const candidates = resources
    .filter((resource) => {
      const shopperId = String(resource.external_id || "");
      if (!shopperId || excluded.has(shopperId)) return false;

      const metadata = resource.metadata || {};
      const capabilities = Array.isArray(resource.capabilities)
        ? resource.capabilities.map((value) => String(value).toLowerCase())
        : [];

      // Availability is enforced by the query, but we keep the check explicit.
      if (String(resource.status || "").toLowerCase() !== "available") return false;

      // Workload guard: an occupied shopper is never eligible for a new task.
      if (metadata.current_order_id) return false;

      if (String(metadata.approval_status || "").toLowerCase() !== "approved") {
        return false;
      }

      if (!metadata.whatsapp_opted_in) return false;

      // Capability guard: the resource must support every capability required
      // by this purchase-and-deliver task.
      if (!requiredCapabilities.every((capability) => capabilities.includes(capability))) {
        return false;
      }

      return true;
    })
    .map((resource) => {
      const location = resource.location || {};
      const resourceLat = Number(location.latitude);
      const resourceLon = Number(location.longitude);

      const resourceHasValidLocation =
        Number.isFinite(resourceLat) &&
        Number.isFinite(resourceLon) &&
        resourceLat >= -90 &&
        resourceLat <= 90 &&
        resourceLon >= -180 &&
        resourceLon <= 180 &&
        !(resourceLat === 0 && resourceLon === 0);

      const distanceKm =
        customerHasValidLocation && resourceHasValidLocation
          ? haversineKm(customerLat, customerLon, resourceLat, resourceLon)
          : null;

      const updatedAt = Date.parse(resource.updated_at || "");
      const freshness = Number.isFinite(updatedAt) ? updatedAt : 0;

      // V1.3 scoring is deterministic and explainable.
      // Lower distance is better. The other factors are eligibility gates
      // represented explicitly in the score for observability.
      const distanceScore = Number.isFinite(distanceKm)
        ? 100 / (1 + distanceKm)
        : 0;
      const availabilityScore = 100; // already filtered to available
      const workloadScore = resource.metadata?.current_order_id ? 0 : 100;
      const capabilityScore = requiredCapabilities.every((capability) =>
        (Array.isArray(resource.capabilities) ? resource.capabilities : [])
          .map((value) => String(value).toLowerCase())
          .includes(capability)
      )
        ? 100
        : 0;

      // Proximity is the primary differentiator in V1.3.
      // Availability, workload and capability are hard eligibility gates.
      const totalScore =
        distanceScore * 0.70 +
        availabilityScore * 0.10 +
        workloadScore * 0.10 +
        capabilityScore * 0.10;

      return {
        resource,
        shopperId: String(resource.external_id),
        distanceKm,
        freshness,
        distanceScore,
        availabilityScore,
        workloadScore,
        capabilityScore,
        totalScore,
      };
    });

  if (!candidates.length) return null;

  candidates.sort((a, b) => {
    if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;

    // Deterministic tie-breaker when scores are identical.
    if (Number.isFinite(a.distanceKm) && Number.isFinite(b.distanceKm)) {
      if (a.distanceKm !== b.distanceKm) return a.distanceKm - b.distanceKm;
    }

    return b.freshness - a.freshness;
  });

  const winner = candidates[0];

  const matchReason = Number.isFinite(winner.distanceKm)
    ? "multi_factor_nearest_eligible_resource"
    : "multi_factor_freshest_eligible_resource";

  await atcSafe(
    () => atcRecordEvent({
      orderId: order.id,
      eventType: "resource_matched",
      actorType: "atc",
      actorId: winner.shopperId,
      metadata: {
        resource_type: "human_shopper",
        match_reason: matchReason,
        distance_km: Number.isFinite(winner.distanceKm)
          ? Number(winner.distanceKm.toFixed(2))
          : null,
        score: Number(winner.totalScore.toFixed(2)),
        score_breakdown: {
          distance: Number(winner.distanceScore.toFixed(2)),
          availability: winner.availabilityScore,
          workload: winner.workloadScore,
          capability: winner.capabilityScore,
        },
        required_capabilities: requiredCapabilities,
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
    score: Number(winner.totalScore.toFixed(2)),
    reason: matchReason,
    scoreBreakdown: {
      distance: Number(winner.distanceScore.toFixed(2)),
      availability: winner.availabilityScore,
      workload: winner.workloadScore,
      capability: winner.capabilityScore,
    },
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

export async function atcUpdateAssignmentStatus({
  orderId,
  shopperId,
  jobId = null,
  status,
}) {
  if (!orderId || !status) return null;

  const normalizedStatus = String(status).toLowerCase();
  const allowedStatuses = new Set([
    "offered",
    "accepted",
    "started",
    "completed",
    "declined",
    "expired",
    "cancelled",
  ]);

  if (!allowedStatuses.has(normalizedStatus)) {
    throw new Error(`ATC_INVALID_ASSIGNMENT_STATUS: ${status}`);
  }

  let assignment = null;

  if (jobId) {
    const byJob = await atcRequest(
      `atc_task_assignments?external_assignment_id=eq.${encodeURIComponent(
        String(jobId)
      )}&select=*&limit=1`
    );
    assignment = Array.isArray(byJob) && byJob.length ? byJob[0] : null;
  }

  if (!assignment && shopperId) {
    const resourceRows = await atcRequest(
      `atc_resources?resource_type=eq.human_shopper&external_id=eq.${encodeURIComponent(
        String(shopperId)
      )}&select=id&limit=1`
    );

    const resourceId =
      Array.isArray(resourceRows) && resourceRows.length
        ? resourceRows[0]?.id
        : null;

    if (resourceId) {
      const byResource = await atcRequest(
        `atc_task_assignments?task_source_type=eq.order&task_source_id=eq.${encodeURIComponent(
          String(orderId)
        )}&resource_id=eq.${encodeURIComponent(
          String(resourceId)
        )}&select=*&order=created_at.desc&limit=1`
      );
      assignment =
        Array.isArray(byResource) && byResource.length
          ? byResource[0]
          : null;
    }
  }

  if (!assignment?.id) {
    return null;
  }

  const now = new Date().toISOString();
  const updates = { status: normalizedStatus };

  if (normalizedStatus === "accepted") {
    updates.accepted_at = assignment.accepted_at || now;
  }

  if (normalizedStatus === "started") {
    updates.started_at = assignment.started_at || now;
  }

  if (["completed", "declined", "expired", "cancelled"].includes(normalizedStatus)) {
    updates.ended_at = assignment.ended_at || now;
  }

  const rows = await atcRequest(
    `atc_task_assignments?id=eq.${encodeURIComponent(assignment.id)}`,
    {
      method: "PATCH",
      headers: {
        Prefer: "return=representation",
      },
      body: JSON.stringify(updates),
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

/* =========================================================
   ATC V2 — PARTNER STORE RESOURCES
   Partner stores are procurement resources.
   They are tried before the human shopper fallback.
========================================================= */

function validCoordinates(latitude, longitude) {
  const lat = Number(latitude);
  const lon = Number(longitude);

  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180 &&
    !(lat === 0 && lon === 0)
  );
}

function normalizeCatalogText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractRequestedItemTerms(items) {
  const raw = String(items || "").trim();

  if (!raw) return [];

  return raw
    .split(/\s*(?:,|\band\b|\+|&)\s*/i)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) =>
      part
        .replace(/^\d+\s*(?:x|×)?\s*/i, "")
        .replace(/\s*x\s*\d+\s*$/i, "")
        .trim()
    )
    .filter(Boolean);
}

function catalogItemMatchesTerm(term, catalogItem) {
  const normalizedTerm = normalizeCatalogText(term);

  if (!normalizedTerm) return false;

  const names = [
    catalogItem?.item_name,
    catalogItem?.normalized_name,
    ...(Array.isArray(catalogItem?.aliases)
      ? catalogItem.aliases
      : []),
  ]
    .filter(Boolean)
    .map(normalizeCatalogText)
    .filter(Boolean);

  return names.some((name) => {
    if (!name) return false;

    return (
      normalizedTerm === name ||
      normalizedTerm.includes(name) ||
      name.includes(normalizedTerm)
    );
  });
}

function catalogMatchesAllRequestedItems(items, catalogRows) {
  const requestedTerms = extractRequestedItemTerms(items);

  if (!requestedTerms.length) {
    return {
      matched: false,
      requestedTerms: [],
      matchedRows: [],
      unmatchedTerms: [],
    };
  }

  const matchedRows = [];
  const unmatchedTerms = [];

  for (const term of requestedTerms) {
    const matches = catalogRows.filter((row) =>
      catalogItemMatchesTerm(term, row)
    );

    if (!matches.length) {
      unmatchedTerms.push(term);
      continue;
    }

    matchedRows.push({
      requestedTerm: term,
      catalogItems: matches,
    });
  }

  return {
    matched: unmatchedTerms.length === 0,
    requestedTerms,
    matchedRows,
    unmatchedTerms,
  };
}

export async function atcSelectPartnerStoreForOrder({
  order,
  excludedPartnerStoreIds = [],
}) {
  if (!order?.id) return null;

  const excluded = new Set(
    (Array.isArray(excludedPartnerStoreIds)
      ? excludedPartnerStoreIds
      : []
    ).map(String)
  );

  const customerLat = Number(order.customer_latitude);
  const customerLon = Number(order.customer_longitude);

  if (!validCoordinates(customerLat, customerLon)) {
    await atcSafe(
      () =>
        atcRecordEvent({
          orderId: order.id,
          eventType: "partner_store_match_failed",
          actorType: "atc",
          metadata: {
            reason: "customer_location_missing",
          },
        }),
      "partner_store_match_location_event"
    );

    return null;
  }

  // The catalog is the source of truth for whether a partner store
  // can potentially fulfil the requested item(s).
  const catalogRows = await atcRequest(
    "partner_store_catalog?available=eq.true&select=*&limit=1000"
  );

  if (!Array.isArray(catalogRows) || !catalogRows.length) {
    await atcSafe(
      () =>
        atcRecordEvent({
          orderId: order.id,
          eventType: "partner_catalog_miss",
          actorType: "atc",
          metadata: {
            reason: "catalog_empty",
            items: order.items || null,
          },
        }),
      "partner_catalog_empty_event"
    );

    return null;
  }

  const catalogResult =
    catalogMatchesAllRequestedItems(
      order.items,
      catalogRows
    );

  if (!catalogResult.matched) {
    await atcSafe(
      () =>
        atcRecordEvent({
          orderId: order.id,
          eventType: "partner_catalog_miss",
          actorType: "atc",
          metadata: {
            reason: "requested_item_not_found_in_partner_catalog",
            items: order.items || null,
            requested_terms:
              catalogResult.requestedTerms,
            unmatched_terms:
              catalogResult.unmatchedTerms,
          },
        }),
      "partner_catalog_miss_event"
    );

    return null;
  }

  /*
    Build the set of stores that can fulfil ALL requested terms.

    A store is only a candidate when every requested item can be
    matched to an available catalog row belonging to that store.
  */
  const storeIds = [
    ...new Set(
      catalogRows
        .map((row) =>
          row?.partner_store_id
            ? String(row.partner_store_id)
            : null
        )
        .filter(Boolean)
    ),
  ].filter(
    (storeId) => !excluded.has(storeId)
  );

  const storesThatCanFulfilAll = storeIds.filter(
    (storeId) =>
      catalogResult.matchedRows.every(
        ({ catalogItems }) =>
          catalogItems.some(
            (item) =>
              String(item.partner_store_id) ===
              storeId
          )
      )
  );

  if (!storesThatCanFulfilAll.length) {
    await atcSafe(
      () =>
        atcRecordEvent({
          orderId: order.id,
          eventType: "partner_catalog_miss",
          actorType: "atc",
          metadata: {
            reason: "no_single_store_can_fulfil_all_items",
            items: order.items || null,
            requested_terms:
              catalogResult.requestedTerms,
          },
        }),
      "partner_catalog_partial_match_event"
    );

    return null;
  }

  const resources = await atcRequest(
    "atc_partner_store_resources?status=eq.available&select=*&limit=100"
  );

  if (!Array.isArray(resources) || !resources.length) {
    return null;
  }

  const requiredCapabilities = [
    "inventory_check",
    "price_quote",
    "order_fulfillment",
  ];

  const candidates = resources
    .filter((resource) => {
      const partnerStoreId = String(
        resource.partner_store_id || ""
      );

      if (
        !partnerStoreId ||
        excluded.has(partnerStoreId)
      ) {
        return false;
      }

      if (
        !storesThatCanFulfilAll.includes(
          partnerStoreId
        )
      ) {
        return false;
      }

      if (
        String(resource.status || "").toLowerCase() !==
        "available"
      ) {
        return false;
      }

      const capabilities = Array.isArray(
        resource.capabilities
      )
        ? resource.capabilities.map((value) =>
            String(value).toLowerCase()
          )
        : [];

      if (
        !requiredCapabilities.every((capability) =>
          capabilities.includes(capability)
        )
      ) {
        return false;
      }

      const location = resource.location || {};

      return validCoordinates(
        location.latitude,
        location.longitude
      );
    })
    .map((resource) => {
      const location = resource.location || {};

      const distanceKm = haversineKm(
        customerLat,
        customerLon,
        Number(location.latitude),
        Number(location.longitude)
      );

      return {
        resource,
        partnerStoreId: String(
          resource.partner_store_id
        ),
        resourceId: resource.id,
        distanceKm,
      };
    })
    .filter((candidate) =>
      Number.isFinite(candidate.distanceKm)
    );

  if (!candidates.length) return null;

  candidates.sort(
    (a, b) => a.distanceKm - b.distanceKm
  );

  const winner = candidates[0];

  const matchedCatalog = [];

  for (const row of catalogResult.matchedRows) {
    const storeItem = row.catalogItems.find(
      (item) =>
        String(item.partner_store_id) ===
        winner.partnerStoreId
    );

    if (storeItem) {
      matchedCatalog.push({
        requested_term: row.requestedTerm,
        catalog_id: storeItem.id,
        item_name: storeItem.item_name,
        normalized_name:
          storeItem.normalized_name,
        price: storeItem.price,
        partner_store_id:
          storeItem.partner_store_id,
      });
    }
  }

  await atcSafe(
    () =>
      atcRecordEvent({
        orderId: order.id,
        eventType: "partner_store_matched",
        actorType: "atc",
        actorId: winner.partnerStoreId,
        metadata: {
          resource_type: "partner_store",
          resource_id: winner.resourceId,
          partner_store_id:
            winner.partnerStoreId,
          distance_km: Number(
            winner.distanceKm.toFixed(2)
          ),
          match_reason:
            "catalog_match_all_items_plus_nearest_store",
          requested_terms:
            catalogResult.requestedTerms,
          catalog_items: matchedCatalog,
          required_capabilities:
            requiredCapabilities,
        },
      }),
    "partner_store_matched_event"
  );

  return {
    partnerStoreId:
      winner.partnerStoreId,
    resourceId:
      winner.resourceId,
    distanceKm: Number(
      winner.distanceKm.toFixed(2)
    ),
    resource: winner.resource,
    reason:
      "catalog_match_all_items_plus_nearest_store",
    requestedTerms:
      catalogResult.requestedTerms,
    catalogMatches:
      matchedCatalog,
  };
}


export async function atcSafe(fn, label) {
  try {
    return await fn();
  } catch (error) {
    console.error(`FETCH ATC ERROR [${label}]:`, error);
    return null;
  }
}
