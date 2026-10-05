import { buildInstamartCartPreview, updateCart, getCart, getPaymentOptions, checkout, trackOrder, checkInstamartPayment, confirmInstamartPaymentOrder } from "./swiggy-instamart-mcp.mjs";

function clean(value) {
  return String(value ?? "").trim();
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return "";
}

function normalizeInstamartName(product, variant, requested) {
  return firstText(
    variant?.displayName,
    variant?.productName,
    variant?.title,
    variant?.itemName,
    product?.displayName,
    product?.productName,
    product?.title,
    product?.itemName,
    product?.name,
    requested
  );
}

function normalizeInstamartPack(product, variant) {
  return firstText(
    variant?.packSize,
    variant?.pack_size,
    variant?.size,
    variant?.weight,
    variant?.volume,
    variant?.quantityText,
    product?.packSize,
    product?.pack_size,
    product?.size,
    product?.weight,
    product?.volume,
    variant?.quantity
  );
}

function tokenizeProductText(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function productMatchesRequested(option, requested) {
  const requestTokens = tokenizeProductText(requested);
  const nameTokens = new Set(tokenizeProductText(option?.name));
  if (!requestTokens.length || !nameTokens.size) return false;

  const aliases = {
    "coriander": ["coriander", "cilantro", "dhaniya"],
    "coriander leaves": ["coriander", "cilantro", "dhaniya"],
    "green chilli": ["chilli", "chili", "mirchi", "pepper"],
    "ginger": ["ginger", "inji"],
    "garlic": ["garlic"],
    "curry leaves": ["curry", "leaves", "kariveppila"],
    "tomato": ["tomato"],
    "onion": ["onion"],
    "chicken": ["chicken"],
    "coconut milk": ["coconut", "milk"]
  };

  const requestKey = clean(requested).toLowerCase();
  const accepted = aliases[requestKey] || requestTokens;
  return accepted.some((token) => nameTokens.has(token));
}

function productOptionKey(option) {
  return [
    option.spinId || "",
    option.skuId || "",
    option.name || "",
    option.pack || "",
    option.price ?? ""
  ].join("|").toLowerCase();
}

function normalizeInstamartPrice(value) {
  if (value == null) return null;
  if (typeof value === "number" || typeof value === "string") return value;

  if (typeof value === "object") {
    const candidate =
      value.offerPrice ??
      value.levelPrice ??
      value.sellingPrice ??
      value.salePrice ??
      value.mrp ??
      value.price ??
      null;

    if (candidate != null && (typeof candidate === "number" || typeof candidate === "string")) {
      return candidate;
    }

    // Some provider payloads wrap the actual price one level deeper.
    if (candidate && typeof candidate === "object") {
      return normalizeInstamartPrice(candidate);
    }
  }

  return null;
}

function extractInstamartSearchData(toolResult) {
  const queue = [toolResult];
  const seen = new Set();
  let fallback = {};

  while (queue.length) {
    const current = queue.shift();

    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);

    // Do not stop on an empty wrapper such as products: [].
    // Swiggy MCP can expose the populated payload deeper inside
    // structuredContent/data/content.
    if (
      (Array.isArray(current.products) && current.products.length > 0) ||
      (Array.isArray(current.similarProducts) && current.similarProducts.length > 0)
    ) {
      return current;
    }

    if (
      Array.isArray(current.products) ||
      Array.isArray(current.similarProducts)
    ) {
      fallback = current;
    }

    for (const value of Object.values(current)) {
      if (value && typeof value === "object" && !seen.has(value)) {
        queue.push(value);
      }
    }

    if (Array.isArray(current?.content)) {
      for (const part of current.content) {
        if (part?.type === "text" && typeof part.text === "string") {
          try { queue.push(JSON.parse(part.text)); } catch {}
        }
      }
    }
  }

  return fallback;
}

export async function prepareInstamartOrder({
  accessToken,
  items,
  addressId,
  autoSelect = false
} = {}) {
  if (!clean(accessToken)) {
    return {
      success: false,
      status: "connection_required",
      message: "Connect Swiggy Instamart to Fetch before placing an order."
    };
  }

  const preview = await buildInstamartCartPreview({
    accessToken,
    items,
    addressId
  });

  if (!preview.success) {
    return {
      ...preview,
      stage: preview.stage || "provider"
    };
  }

  if (preview.status === "address_selection_required") {
    return {
      success: true,
      status: "address_selection_required",
      provider: "swiggy_instamart",
      addresses: preview.addresses || [],
      requestedItems: items || [],
      shoppingMode: autoSelect ? "auto" : "manual",
      message: autoSelect
        ? "I found your Instamart connection. Choose your saved delivery address and I’ll handle the shopping."
        : "I found your Instamart connection. Which saved delivery address should I use?"
    };
  }

  /*
   * Product selection is deliberately not automated blindly.
   * Search results can contain variants, pack sizes and substitutions.
   * The next UI step will let the user choose/approve the exact products.
   */
  const productOptions = preview.searches.flatMap((search) => {
    const data = extractInstamartSearchData(search?.result);
    const products = [
      ...(Array.isArray(data?.products) ? data.products : []),
      ...(Array.isArray(data?.similarProducts) ? data.similarProducts : [])
    ];

    return products.flatMap((product) => {
      const variants =
        Array.isArray(product?.variants) ? product.variants :
        Array.isArray(product?.variations) ? product.variations :
        Array.isArray(product?.variant) ? product.variant :
        [];

      // Be tolerant if the provider flattens SKU fields onto the product.
      const normalizedVariants = variants.length
        ? variants
        : (
            product?.spinId ||
            product?.spin_id ||
            product?.skuId ||
            product?.sku_id ||
            product?.id
          )
          ? [product]
          : [];

      return normalizedVariants.map((variant) => ({
        requested: search.requested,
        quantity: search.quantity,
        requestedQuantity: search.quantity,
        requestedUnit: search.unit || null,
        name: normalizeInstamartName(product, variant, search.requested),
        imageUrl: firstText(variant?.imageUrl, variant?.image_url, product?.imageUrl, product?.image_url) || null,
        price: normalizeInstamartPrice(variant?.price ?? variant?.sellingPrice ?? product?.price ?? null),
        pack: normalizeInstamartPack(product, variant),
        spinId: variant?.spinId || variant?.spin_id || variant?.id || product?.spinId || product?.spin_id || null,
        skuId: variant?.skuId || variant?.sku_id || product?.skuId || product?.sku_id || null,
        inStock: variant?.inStock ?? variant?.in_stock ?? product?.inStock ?? product?.in_stock ?? null
      })).filter((item) => item.spinId);
    });
  });

  const uniqueProductOptions = Array.from(
    new Map(productOptions.map((option) => [productOptionKey(option), option])).values()
  )
    .slice(0, 40)
    .map((option) => ({
      ...option,
      quantity: computeCartQuantity(option)
    }));

  if (autoSelect) {
    const selectedItems = [];
    const unresolved = [];

    for (const requestedItem of (items || [])) {
      const candidates = uniqueProductOptions.filter(
        (option) =>
          clean(option.requested).toLowerCase() === clean(requestedItem?.item).toLowerCase() &&
          productMatchesRequested(option, requestedItem?.item)
      );

      const scored = candidates
        .filter((option) => option.inStock !== false && option.spinId)
        .map((option) => {
          const requested = clean(requestedItem?.item).toLowerCase();
          const name = clean(option.name).toLowerCase();
          let score = 0;
          if (name === requested) score += 100;
          if (name.includes(requested)) score += 50;
          if (requested.includes(name)) score += 25;
          if (productMatchesRequested(option, requested)) score += 40;
          if (option.price != null) score += 5;
          if (option.pack) score += 2;
          return { option, score };
        })
        .sort((a, b) => b.score - a.score);

      const selected = scored[0]?.option;
      if (!selected) {
        unresolved.push(requestedItem?.item || "requested item");
        continue;
      }

      selectedItems.push({
        spinId: selected.spinId,
        ...(selected.skuId ? { skuId: selected.skuId } : {}),
        quantity: computeCartQuantity({
          ...selected,
          requestedQuantity: requestedItem?.quantity || 1,
          requestedUnit: requestedItem?.unit || null
        })
      });
    }

    if (unresolved.length) {
      return {
        success: true,
        status: "awaiting_product_selection",
        provider: "swiggy_instamart",
        address: preview.address,
        addressId: preview.addressId,
        searches: preview.searches,
        requestedItems: items || [],
        productOptions: uniqueProductOptions,
        shoppingMode: "auto",
        unresolvedItems: unresolved,
        message:
          "I handled the ingredients I could match confidently. I need one quick choice for: " +
          unresolved.join(", ") +
          ". I won’t substitute an unrelated product without asking you."
      };
    }

    const selection = await applyInstamartSelection({
      accessToken,
      addressId: preview.addressId || addressId,
      items: selectedItems
    });

    if (!selection.success) return selection;

    return {
      ...selection,
      shoppingMode: "auto",
      requestedItems: items || [],
      selectedItems,
      message: "I’ve handled the shopping and prepared the complete Instamart cart. Review everything once before payment."
    };
  }

  const displayProductOptions = uniqueProductOptions.slice(0, 8);

  return {
    success: true,
    status: "awaiting_product_selection",
    provider: "swiggy_instamart",
    address: preview.address,
    addressId: preview.addressId,
    searches: preview.searches,
    requestedItems: items || [],
    productOptions: displayProductOptions,
    message: displayProductOptions.length
      ? "I found the live Instamart matches. Review the products and choose the variants you want."
      : "Instamart returned no usable live product matches for that request. Try a more specific product or another search term.",
    diagnostics: displayProductOptions.length
      ? undefined
      : {
          searchedItems: preview.searches.map((search) => search.requested),
          searchStatuses: preview.searches.map((search) => search.result?.status || "unknown")
        }
  };
}

function parsePackQuantity(pack) {
  const text = clean(pack).toLowerCase();
  const match = text.match(/(\\d+(?:\\.\\d+)?)\\s*(kg|kgs|g|gram|grams|l|ltr|litre|litres|ml)\\b/i);
  if (!match) return null;
  return {
    value: Number(match[1]),
    unit: match[2].toLowerCase()
  };
}

function computeCartQuantity(option) {
  const requestedQuantity = Math.max(1, Number(option?.requestedQuantity || option?.quantity || 1));
  const requestedUnit = clean(option?.requestedUnit).toLowerCase();
  const pack = parsePackQuantity(option?.pack);

  if (!pack || !requestedUnit) return requestedQuantity;

  const normalizeUnit = (unit, value) => {
    const u = String(unit).toLowerCase();
    if (u === "kg" || u === "kgs" || u === "kilogram" || u === "kilograms") return value * 1000;
    if (u === "g" || u === "gram" || u === "grams") return value;
    if (u === "l" || u === "ltr" || u === "litre" || u === "litres") return value * 1000;
    if (u === "ml" || u === "milliliter" || u === "millilitre") return value;
    return null;
  };

  const requestedBase = normalizeUnit(requestedUnit, requestedQuantity);
  const packBase = normalizeUnit(pack.unit, pack.value);

  if (!requestedBase || !packBase || packBase <= 0) return requestedQuantity;

  const exact = requestedBase / packBase;
  return Number.isInteger(exact) && exact > 0 ? exact : requestedQuantity;
}

function extractInstamartCartPayload(value) {
  const queue = [value];
  const seen = new Set();
  const candidates = [];

  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);

    if (
      Array.isArray(current.items) ||
      Array.isArray(current.cartItems) ||
      current.bill ||
      current.pricing ||
      current.item_total != null ||
      current.to_pay != null ||
      Array.isArray(current.allMethods) ||
      Array.isArray(current.availablePaymentMethods)
    ) {
      candidates.push(current);
    }

    for (const valuePart of Object.values(current)) {
      if (valuePart && typeof valuePart === "object" && !seen.has(valuePart)) {
        queue.push(valuePart);
      }
    }

    if (Array.isArray(current.content)) {
      for (const part of current.content) {
        if (part?.type === "text" && typeof part.text === "string") {
          try {
            const parsed = JSON.parse(part.text);
            if (parsed && typeof parsed === "object") queue.push(parsed);
          } catch {}
        }
      }
    }

    for (const [key, valuePart] of Object.entries(current)) {
      if (typeof valuePart === "string") {
        const trimmed = valuePart.trim();
        if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed && typeof parsed === "object") queue.push(parsed);
          } catch {}
        }
      }
    }
  }

  return candidates.sort((a, b) => {
    const score = (v) =>
      (Array.isArray(v.items) ? 5 : 0) +
      (v.bill ? 3 : 0) +
      (v.pricing ? 3 : 0) +
      (v.to_pay != null ? 3 : 0) +
      (Array.isArray(v.allMethods) ? 2 : 0);
    return score(b) - score(a);
  })[0] || {};
}

function normalizeInstamartCart(cart) {
  const raw = extractInstamartCartPayload(cart);
  const rawPricing = raw.pricing || raw.bill || raw;

  const items = (
    Array.isArray(raw.items) ? raw.items :
    Array.isArray(raw.cartItems) ? raw.cartItems :
    Array.isArray(raw.lineItems) ? raw.lineItems :
    []
  ).map((item) => ({
    ...item,
    id: item?.id || item?.itemId || item?.skuId || item?.spinId || null,
    spinId: item?.spinId || item?.spin_id || null,
    skuId: item?.skuId || item?.sku_id || null,
    name: item?.name || item?.displayName || item?.productName || item?.itemName || "Instamart item",
    quantity: Number(item?.quantity ?? item?.qty ?? item?.count ?? 1),
    price: item?.price ?? item?.final_price ?? item?.finalPrice ?? item?.sellingPrice ?? item?.selling_price ?? item?.unitPrice ?? item?.unit_price ?? item?.amount ?? null,
    final_price: item?.final_price ?? item?.finalPrice ?? item?.price ?? item?.sellingPrice ?? item?.selling_price ?? item?.unitPrice ?? item?.unit_price ?? null,
    subtotal: item?.subtotal ?? item?.item_total ?? item?.itemTotal ?? item?.total ?? item?.lineTotal ?? item?.line_total ?? null,
    total: item?.total ?? item?.subtotal ?? item?.item_total ?? item?.itemTotal ?? item?.lineTotal ?? item?.line_total ?? null
  }));

  const pricing = {
    ...(rawPricing && typeof rawPricing === "object" ? rawPricing : {}),
    item_total: rawPricing?.item_total ?? rawPricing?.itemTotal ?? rawPricing?.subtotal ?? rawPricing?.itemsTotal ?? rawPricing?.items_total ?? raw?.item_total ?? raw?.itemTotal ?? null,
    delivery_charge: rawPricing?.delivery_charge ?? rawPricing?.deliveryCharge ?? rawPricing?.deliveryFee ?? rawPricing?.delivery_fee ?? raw?.delivery_charge ?? raw?.deliveryCharge ?? raw?.deliveryFee ?? null,
    taxes_and_charges: rawPricing?.taxes_and_charges ?? rawPricing?.taxesAndCharges ?? rawPricing?.taxes ?? rawPricing?.taxAmount ?? rawPricing?.tax_amount ?? raw?.taxes_and_charges ?? raw?.taxes ?? null,
    to_pay: rawPricing?.to_pay ?? rawPricing?.billToPay ?? rawPricing?.total ?? rawPricing?.totalAmount ?? rawPricing?.grandTotal ?? rawPricing?.payableAmount ?? rawPricing?.payable_amount ?? raw?.to_pay ?? raw?.billToPay ?? raw?.totalAmount ?? null
  };

  const paymentSource = raw.paymentOptions || raw.payment_options || {};
  const paymentMethods =
    Array.isArray(raw.allMethods) ? raw.allMethods :
    Array.isArray(raw.availablePaymentMethods) ? raw.availablePaymentMethods :
    Array.isArray(raw.upiMethods) ? raw.upiMethods :
    Array.isArray(paymentSource?.allMethods) ? paymentSource.allMethods :
    Array.isArray(paymentSource?.availablePaymentMethods) ? paymentSource.availablePaymentMethods :
    Array.isArray(paymentSource?.upiMethods) ? paymentSource.upiMethods :
    Array.isArray(paymentSource?.methods) ? paymentSource.methods :
    [];

  return {
    ...raw,
    items,
    pricing,
    paymentOptions: {
      ...(raw.paymentOptions && typeof raw.paymentOptions === "object" ? raw.paymentOptions : {}),
      allMethods: paymentMethods
    },
    availablePaymentMethods: paymentMethods
  };
}

function extractCartLineItems(cart) {
  const root = cart?.data?.data || cart?.data || cart || {};
  const found = [];
  const seen = new Set();

  function walk(value, depth = 0) {
    if (!value || typeof value !== "object" || depth > 6 || seen.has(value)) return;
    seen.add(value);

    for (const key of ["items", "cartItems", "lineItems", "products"]) {
      if (Array.isArray(value[key])) {
        for (const item of value[key]) {
          if (item && typeof item === "object") found.push(item);
        }
      }
    }

    for (const valuePart of Object.values(value)) {
      if (valuePart && typeof valuePart === "object") walk(valuePart, depth + 1);
    }
  }

  walk(root);
  return Array.from(new Set(found));
}

function verifyInstamartCartSelection(cart, selectedItems) {
  const lines = extractCartLineItems(cart);
  if (!lines.length) {
    return {
      ok: false,
      reason: "Instamart returned an empty cart after the selection."
    };
  }

  const normalizedSelected = selectedItems.map((item) => ({
    id: clean(item?.spinId),
    quantity: Math.max(1, Number(item?.quantity || 1))
  }));

  const mismatches = [];
  for (const selected of normalizedSelected) {
    const line = lines.find((item) => {
      const ids = [
        item?.spinId, item?.spin_id, item?.skuId, item?.sku_id,
        item?.itemId, item?.item_id, item?.id
      ].map(clean).filter(Boolean);
      return selected.id && ids.includes(selected.id);
    });

    if (!line) {
      mismatches.push({ spinId: selected.id, expectedQuantity: selected.quantity, reason: "selected SKU not present in live cart" });
      continue;
    }

    const actualQuantity = Number(line?.quantity ?? line?.qty ?? line?.count ?? 1);
    if (Number.isFinite(actualQuantity) && actualQuantity !== selected.quantity) {
      mismatches.push({
        spinId: selected.id,
        expectedQuantity: selected.quantity,
        actualQuantity,
        reason: "quantity mismatch"
      });
    }
  }

  return {
    ok: mismatches.length === 0,
    mismatches
  };
}

export async function applyInstamartSelection({
  accessToken,
  addressId,
  items
} = {}) {
  const safeItems = (Array.isArray(items) ? items : [])
    .map((item) => ({
      spinId: clean(item?.spinId),
      quantity: Math.max(1, Number(item?.quantity || 1))
    }))
    .filter((item) => item.spinId);

  if (!safeItems.length) {
    return {
      success: false,
      status: "selection_required",
      message: "No valid Instamart product selection was provided."
    };
  }

  const cart = await updateCart({
    accessToken,
    addressId,
    items: safeItems
  });

  if (!cart.success) return cart;

  const liveCart = await getCart({ accessToken });

  if (!liveCart.success) return liveCart;

  const verification = verifyInstamartCartSelection(liveCart, safeItems);
  if (!verification.ok) {
    return {
      success: false,
      status: "cart_verification_failed",
      provider: "swiggy_instamart",
      addressId,
      cart: liveCart.data,
      verification,
      message: "I stopped before payment because the live Instamart cart does not exactly match the product selection. No order was placed."
    };
  }

  const normalizedCart = normalizeInstamartCart(liveCart.data);
  const paymentOptions = await getPaymentOptions(accessToken);
  const paymentRaw = paymentOptions.success ? paymentOptions.data : null;
  const paymentPayload = paymentRaw ? extractInstamartCartPayload(paymentRaw) : {};
  const paymentMethods =
    Array.isArray(paymentPayload?.allMethods) ? paymentPayload.allMethods :
    Array.isArray(paymentPayload?.availablePaymentMethods) ? paymentPayload.availablePaymentMethods :
    Array.isArray(paymentPayload?.methods) ? paymentPayload.methods :
    normalizedCart?.paymentOptions?.allMethods ||
    normalizedCart?.availablePaymentMethods ||
    [];

  const normalizedPaymentOptions = {
    ...(paymentPayload && typeof paymentPayload === "object" ? paymentPayload : {}),
    allMethods: paymentMethods,
    availablePaymentMethods: paymentMethods
  };

  return {
    success: true,
    status: "awaiting_checkout_confirmation",
    provider: "swiggy_instamart",
    addressId,
    cart: normalizedCart,
    paymentOptions: normalizedPaymentOptions,
    paymentOptionsAvailable: Array.isArray(normalizedPaymentOptions?.allMethods)
      ? normalizedPaymentOptions.allMethods.length > 0
      : false,
    paymentOptionsError: paymentOptions.success ? null : (paymentOptions.message || paymentOptions.error || "Payment methods could not be loaded"),
    message: "Your order is ready. Review the items, delivery address and total, then choose how you’d like to pay."
  };
}

export async function confirmInstamartCheckout({
  accessToken,
  addressId,
  paymentMethod,
  intentApp,
  generateUPIQR,
  confirmed
} = {}) {
  if (confirmed !== true) {
    return {
      success: false,
      status: "confirmation_required",
      message: "Customer confirmation is required before checkout."
    };
  }

  if (!paymentMethod) {
    return {
      success: false,
      status: "payment_method_required",
      message: "Choose a payment method before continuing."
    };
  }

  const result = await checkout({
    accessToken,
    addressId,
    paymentMethod,
    intentApp,
    generateUPIQR
  });

  if (!result.success) return result;

  const resultData = result?.data || {};
  const providerStatus = String(
    resultData?.status ||
    resultData?.orderStatus ||
    resultData?.paymentStatus ||
    ""
  ).toUpperCase();

  // Checkout itself is NEVER proof that payment succeeded.
  // Only an explicit provider payment-success/confirmation signal may
  // move Fetch to order_placed. This prevents a false order confirmation.
  const explicitlyPaid =
    resultData?.confirmed === true &&
    ["SUCCESS", "PAID", "PAYMENT_SUCCESS", "CONFIRMED", "ORDER_PLACED"].includes(providerStatus);

  if (explicitlyPaid) {
    return {
      ...result,
      provider: "swiggy_instamart",
      status: "order_placed",
      orderId: resultData?.orderId || result?.orderId || null,
      payment: resultData,
      message: "Payment received. Your Instamart order is confirmed."
    };
  }

  return {
    ...result,
    provider: "swiggy_instamart",
    status: "awaiting_payment",
    payment: resultData,
    orderId: resultData?.orderId || result?.orderId || null,
    message: "Your order is ready for payment. Complete the payment first. Fetch will confirm the order only after payment succeeds."
  };
}

export async function checkInstamartPaymentStatus({ accessToken, paasId, orderId } = {}) {
  if (!clean(paasId)) {
    return {
      success: false,
      status: "payment_reference_missing",
      message: "Payment reference is missing. Start the payment again."
    };
  }

  const result = await checkInstamartPayment({ accessToken, paasId, orderId });
  if (!result.success) return result;

  const data = result?.data || {};
  const providerStatus = String(
    data?.status ||
    data?.paymentStatus ||
    data?.orderStatus ||
    ""
  ).toUpperCase();

  const failed =
    data?.isTerminalFailure === true ||
    ["FAILED", "PAYMENT_FAILED", "CANCELLED", "EXPIRED"].includes(providerStatus);

  if (failed) {
    return {
      ...result,
      status: "payment_failed",
      payment: data,
      message: "The payment did not complete. Your order has not been placed."
    };
  }

  const paid =
    data?.isTerminalSuccess === true ||
    data?.confirmed === true ||
    ["SUCCESS", "PAID", "PAYMENT_SUCCESS", "CONFIRMED"].includes(providerStatus);

  if (!paid) {
    return {
      ...result,
      status: "awaiting_payment",
      payment: data,
      orderId: data?.orderId || orderId || null,
      message: "Payment is still pending. Your order has not been marked placed."
    };
  }

  const confirmed =
    data?.confirmed === true ||
    ["CONFIRMED", "ORDER_PLACED"].includes(providerStatus);

  if (confirmed) {
    return {
      ...result,
      status: "order_placed",
      payment: data,
      orderId: data?.orderId || orderId || null,
      message: "Payment received. Your Instamart order is confirmed."
    };
  }

  const confirmation = await confirmInstamartPaymentOrder({
    accessToken,
    orderId: data?.orderId || orderId,
    paasId: data?.paasId || paasId
  });

  if (!confirmation.success) return confirmation;

  return {
    ...confirmation,
    status: "order_placed",
    payment: data,
    orderId: data?.orderId || orderId || null,
    message: "Payment received. Your Instamart order is confirmed."
  };
}

export async function trackInstamartOrder({
  accessToken,
  orderId
} = {}) {
  return trackOrder({
    accessToken,
    orderId
  });
}
