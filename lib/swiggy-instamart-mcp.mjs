/* FETCH — SWIGGY INSTAMART MCP CLIENT
 *
 * Production client for Swiggy Builders Club streamable HTTP.
 * - OAuth bearer token supplied server-side only
 * - MCP initialize handshake + session header
 * - JSON and SSE response parsing
 * - Explicit 401/429 handling for re-auth / retry
 */

const MCP_URL = "https://mcp.swiggy.com/im";
const SCENES_URL = "https://mcp.swiggy.com/scenes";
const MCP_PROTOCOL_VERSION = "2025-06-18";

function clean(value) {
  return String(value ?? "").trim();
}

function extractText(result) {
  const parts = Array.isArray(result?.content) ? result.content : [];
  return parts
    .filter((part) => part?.type === "text")
    .map((part) => clean(part.text))
    .filter(Boolean)
    .join("\n");
}

function parseResponse(raw, contentType = "") {
  const text = clean(raw);
  if (!text) return null;

  if (contentType.includes("text/event-stream")) {
    const dataLines = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);

    for (let i = dataLines.length - 1; i >= 0; i -= 1) {
      try {
        return JSON.parse(dataLines[i]);
      } catch {
        // Continue until the final valid JSON event.
      }
    }
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function getSessionId(response) {
  return (
    response.headers.get("mcp-session-id") ||
    response.headers.get("Mcp-Session-Id") ||
    response.headers.get("MCP-Session-Id") ||
    null
  );
}

async function readMcpResponse(response) {
  const contentType = response.headers.get("content-type") || "";

  // Normal JSON responses can be consumed normally.
  if (!contentType.includes("text/event-stream")) {
    return {
      raw: await response.text(),
      contentType
    };
  }

  // Streamable HTTP/SSE may keep the connection open after the JSON-RPC
  // response has already arrived. Do not wait for the stream to close.
  const reader = response.body?.getReader?.();
  if (!reader) {
    return {
      raw: await response.text(),
      contentType
    };
  }

  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + 30000;

  try {
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("SWIGGY_MCP_RESPONSE_TIMEOUT")), remaining)
      );

      const { value, done } = await Promise.race([reader.read(), timeout]);

      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data:")) continue;

        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data);

          // Return immediately once the JSON-RPC response arrives.
          if (
            parsed?.id !== undefined ||
            parsed?.result !== undefined ||
            parsed?.error !== undefined
          ) {
            try { await reader.cancel(); } catch {}
            return {
              raw: data,
              contentType
            };
          }
        } catch {
          // Ignore non-JSON SSE events.
        }
      }
    }

    throw new Error("SWIGGY_MCP_RESPONSE_TIMEOUT");
  } finally {
    try { await reader.cancel(); } catch {}
  }
}

async function mcpRequest({ accessToken, method, params = {}, sessionId = null, id = 1 }) {
  const token = clean(accessToken);

  if (!token) {
    return {
      success: false,
      status: "connection_required",
      error: "SWIGGY_ACCESS_TOKEN_REQUIRED"
    };
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": MCP_PROTOCOL_VERSION
  };

  if (sessionId) {
    headers["Mcp-Session-Id"] = sessionId;
  }

  let response;
  try {
    response = await fetch(MCP_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params
      }),
      signal: AbortSignal.timeout(35000)
    });
  } catch (error) {
    return {
      success: false,
      status: error?.name === "TimeoutError" || error?.message === "SWIGGY_MCP_RESPONSE_TIMEOUT"
        ? "provider_timeout"
        : "mcp_network_error",
      error: error?.message || "Swiggy MCP request failed"
    };
  }

  let raw;
  let contentType = response.headers.get("content-type") || "";

  try {
    const streamed = await readMcpResponse(response);
    raw = streamed.raw;
    contentType = streamed.contentType || contentType;
  } catch (error) {
    return {
      success: false,
      status: "provider_timeout",
      http_status: response.status,
      error: error?.message || "Swiggy MCP response timed out"
    };
  }

  const payload = parseResponse(raw, contentType);

  if (!response.ok) {
    return {
      success: false,
      status:
        response.status === 401
          ? "reauthorization_required"
          : response.status === 429
            ? "rate_limited"
            : "mcp_error",
      http_status: response.status,
      retry_after: response.headers.get("retry-after") || null,
      error:
        payload?.error?.message ||
        payload?.message ||
        (typeof payload?.raw === "string" ? payload.raw : raw)
    };
  }

  if (payload?.error) {
    return {
      success: false,
      status:
        payload.error?.code === -32001
          ? "reauthorization_required"
          : "mcp_error",
      error: payload.error.message || "Swiggy MCP error",
      code: payload.error.code ?? null
    };
  }

  return {
    success: true,
    status: "completed",
    data: payload?.result || payload?.data || payload,
    text: extractText(payload?.result || payload?.data || payload),
    sessionId: getSessionId(response) || sessionId
  };
}

async function initializeSession(accessToken) {
  const result = await mcpRequest({
    accessToken,
    method: "initialize",
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: "Fetch",
        version: "1.0.0"
      }
    },
    id: 1
  });

  if (!result.success) return result;

  return {
    ...result,
    sessionId: result.sessionId || null
  };
}

async function createSession(accessToken) {
  const initialized = await initializeSession(accessToken);
  if (!initialized.success) return initialized;

  const sessionId = initialized.sessionId;

  if (sessionId) {
    // MCP lifecycle requires the client to announce readiness after initialize.
    const ready = await mcpRequest({
      accessToken,
      method: "notifications/initialized",
      params: {},
      sessionId,
      id: 2
    });

    if (!ready.success && ready.http_status !== 202) {
      return ready;
    }
  }

  return {
    success: true,
    status: "connected",
    sessionId
  };
}

async function callTool({ accessToken, name, arguments: args = {}, sessionId = null, id = 3 }) {
  const result = await mcpRequest({
    accessToken,
    method: "tools/call",
    params: {
      name,
      arguments: args
    },
    sessionId,
    id
  });

  return result;
}

async function callWithSession(accessToken, fn) {
  const session = await createSession(accessToken);
  if (!session.success) return session;
  return fn(session.sessionId);
}

export async function checkInstamartPayment({ accessToken, paasId, orderId } = {}) {
  return callWithSession(accessToken, (sessionId) =>
    callTool({
      accessToken,
      name: "check_payment_status",
      arguments: {
        paasId: clean(paasId),
        ...(clean(orderId) ? { orderId: clean(orderId) } : {})
      },
      sessionId,
      id: 3
    })
  );
}

export async function confirmInstamartPaymentOrder({ accessToken, orderId, paasId } = {}) {
  return callWithSession(accessToken, (sessionId) =>
    callTool({
      accessToken,
      name: "confirm_order",
      arguments: {
        orderId: clean(orderId),
        paasId: clean(paasId)
      },
      sessionId,
      id: 3
    })
  );
}

export async function getAddresses(accessToken) {
  return callWithSession(accessToken, (sessionId) =>
    callTool({
      accessToken,
      name: "get_addresses",
      sessionId,
      id: 3
    })
  );
}

export async function searchProducts({ accessToken, addressId, query }) {
  return callWithSession(accessToken, (sessionId) =>
    callTool({
      accessToken,
      name: "search_products",
      arguments: { addressId, query },
      sessionId,
      id: 3
    })
  );
}

export async function updateCart({ accessToken, addressId, items }) {
  return callWithSession(accessToken, (sessionId) =>
    callTool({
      accessToken,
      name: "update_cart",
      arguments: {
        selectedAddressId: clean(addressId),
        items
      },
      sessionId,
      id: 3
    })
  );
}

export async function getCart({ accessToken } = {}) {
  return callWithSession(accessToken, (sessionId) =>
    callTool({
      accessToken,
      name: "get_cart",
      sessionId,
      id: 3
    })
  );
}

export async function getPaymentOptions(accessToken) {
  return callWithSession(accessToken, (sessionId) =>
    callTool({
      accessToken,
      name: "get_payment_options",
      sessionId,
      id: 3
    })
  );
}

export async function checkout({ accessToken, addressId, paymentMethod, intentApp, generateUPIQR }) {
  return callWithSession(accessToken, (sessionId) =>
    callTool({
      accessToken,
      name: "checkout",
      arguments: {
        addressId,
        ...(paymentMethod ? { paymentMethod } : {}),
        ...(intentApp ? { intentApp } : {}),
        ...(generateUPIQR ? { generateUPIQR: true } : {})
      },
      sessionId,
      id: 3
    })
  );
}

export async function getOrders({ accessToken, count = 10, activeOnly = false }) {
  return callWithSession(accessToken, (sessionId) =>
    callTool({
      accessToken,
      name: "get_orders",
      arguments: { count, orderType: "INSTAMART", activeOnly },
      sessionId,
      id: 3
    })
  );
}

export async function trackOrder({ accessToken, orderId }) {
  return callWithSession(accessToken, (sessionId) =>
    callTool({
      accessToken,
      name: "track_order",
      arguments: { orderId },
      sessionId,
      id: 3
    })
  );
}

export async function getOrderDetails({ accessToken, orderId }) {
  return callWithSession(accessToken, (sessionId) =>
    callTool({
      accessToken,
      name: "get_order_details",
      arguments: { orderId },
      sessionId,
      id: 3
    })
  );
}

function unwrapMcpToolPayload(value) {
  let current = value;
  const seen = new Set();

  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);

    if (Array.isArray(current)) return current;

    if (current?.addresses && Array.isArray(current.addresses)) {
      return current;
    }

    const next =
      current?.structuredContent ??
      current?.data ??
      current?.result ??
      current?.output ??
      null;

    if (!next || next === current) break;
    current = next;
  }

  return current;
}

function parseJsonText(value) {
  const text = clean(value);
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    // Some MCP text responses wrap JSON in markdown fences.
    const fenced = text.match(/\\`\\`\\`(?:json)?\\s*([\\s\\S]*?)\\s*\\`\\`\\`/i);
    if (!fenced) return null;

    try {
      return JSON.parse(fenced[1]);
    } catch {
      return null;
    }
  }
}

function normalizeSavedAddress(address, index = 0) {
  const id = clean(address?.id || address?.addressId || address?.address_id);
  const label = clean(
    address?.label ||
    address?.name ||
    address?.tag ||
    address?.displayName ||
    address?.title ||
    `Saved address ${index + 1}`
  );

  const formattedAddress = clean(
    address?.formattedAddress ||
    address?.fullAddress ||
    address?.address ||
    address?.addressLine ||
    address?.addressLine1 ||
    [
      address?.addressLine1,
      address?.addressLine2,
      address?.landmark,
      address?.city,
      address?.state,
      address?.pincode
    ].filter(Boolean).join(", ")
  );

  return {
    ...address,
    id: id || `address-${index + 1}`,
    addressId: id || `address-${index + 1}`,
    label,
    address: formattedAddress
  };
}

function extractAddressPayload(toolResult) {
  const candidates = [
    toolResult?.data,
    toolResult?.data?.structuredContent,
    toolResult?.data?.structuredContent?.data,
    toolResult?.data?.data,
    toolResult?.data?.result,
    toolResult?.data?.output,
    toolResult
  ];

  for (const candidate of candidates) {
    const unwrapped = unwrapMcpToolPayload(candidate);

    if (Array.isArray(unwrapped)) {
      return { addresses: unwrapped, pagination: null };
    }

    if (unwrapped?.addresses && Array.isArray(unwrapped.addresses)) {
      return {
        addresses: unwrapped.addresses,
        pagination: unwrapped.pagination || null
      };
    }

    if (unwrapped?.data?.addresses && Array.isArray(unwrapped.data.addresses)) {
      return {
        addresses: unwrapped.data.addresses,
        pagination: unwrapped.data.pagination || null
      };
    }
  }

  const textCandidates = [
    toolResult?.text,
    toolResult?.data?.text,
    ...(Array.isArray(toolResult?.data?.content)
      ? toolResult.data.content.map((part) => part?.text)
      : [])
  ];

  for (const textValue of textCandidates) {
    const parsed = parseJsonText(textValue);
    if (!parsed) continue;

    const extracted = extractAddressPayload({
      data: parsed,
      text: ""
    });

    if (extracted.addresses.length) return extracted;
  }

  return { addresses: [], pagination: null };
}

export async function buildInstamartCartPreview({ accessToken, items, addressId: selectedAddressId }) {
  const session = await createSession(accessToken);
  if (!session.success) return session;

  const sessionId = session.sessionId;

  // Swiggy explicitly requires get_addresses before product search and says
  // the client should stop and let the user choose a saved address.
  // Keep the entire address discovery inside one MCP session and follow the
  // documented pagination contract so Fetch does not silently drop options.
  const addressPages = [];
  let page = 1;
  let hasMore = true;
  let firstAddressResponse = null;

  while (hasMore && page <= 10) {
    const response = await callTool({
      accessToken,
      name: "get_addresses",
      arguments: page === 1 ? {} : { page, pageSize: 10 },
      sessionId,
      id: 3 + page
    });

    if (!response.success) {
      return {
        stage: "get_addresses",
        ...response
      };
    }

    if (!firstAddressResponse) firstAddressResponse = response;

    const extracted = extractAddressPayload(response);
    addressPages.push(...extracted.addresses);

    hasMore = extracted.pagination?.hasMore === true;
    page += 1;

    if (!extracted.pagination) break;
  }

  // De-duplicate in case the provider repeats an address across pages/wrappers.
  const addressList = Array.from(
    new Map(
      addressPages
        .filter((address) => address && typeof address === "object")
        .map((address, index) => {
          const normalized = normalizeSavedAddress(address, index);
          return [
            clean(normalized?.id) || `index-${index}`,
            normalized
          ];
        })
    ).values()
  );

  if (!clean(selectedAddressId)) {
    return {
      success: true,
      status: "address_selection_required",
      stage: "get_addresses",
      addresses: addressList,
      addressCount: addressList.length,
      message: addressList.length
        ? "I found your saved Instamart addresses. Which one should I use for delivery?"
        : "No saved Instamart addresses were returned. Please add an address in Swiggy and try again.",
      providerResponse: firstAddressResponse?.data?.message || firstAddressResponse?.text || null
    };
  }

  const addressId = clean(selectedAddressId);
  const address = addressList.find(
    (item) => clean(item?.id || item?.addressId) === addressId
  );

  if (!address) {
    return {
      success: false,
      status: "address_required",
      stage: "get_addresses",
      addresses: addressList,
      error: "The selected saved address was not found in the current Instamart address list."
    };
  }

  const searches = [];

  for (const item of Array.isArray(items) ? items : []) {
    const query = clean(item?.item || item?.name);
    if (!query) continue;

    const searchAliases = {
      "green chilli": "fresh green chilli",
      "coriander leaves": "fresh coriander leaves",
      "ginger": "fresh ginger",
      "garlic": "fresh garlic",
      "curry leaves": "fresh curry leaves",
      "tomato": "fresh tomato",
      "onion": "fresh onion",
      "chicken": "chicken",
      "coconut milk": "coconut milk"
    };
    const searchQuery = searchAliases[query.toLowerCase()] || query;

    const result = await callTool({
      accessToken,
      name: "search_products",
      arguments: { addressId, query: searchQuery },
      sessionId,
      id: 10 + searches.length
    });

    searches.push({
      requested: query,
      quantity: Math.max(1, Number(item?.quantity || 1)),
      unit: clean(item?.unit),
      result
    });

    if (!result.success) {
      return {
        success: false,
        status: result.status,
        stage: "search_products",
        searches,
        error: result.error,
        code: result.code
      };
    }
  }

  return {
    success: true,
    status: "products_found",
    address,
    addressId,
    searches
  };
}
