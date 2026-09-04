export default async function handler(req, res) {
  // =========================================================
  // FETCH — WHATSAPP SHOPPING AGENT
  // =========================================================
  // MVP flow:
  // WhatsApp message
  //      ↓
  // Find/create customer
  //      ↓
  // Collect store + items + address
  //      ↓
  // Confirm with customer
  //      ↓
  // Create confirmed order
  // =========================================================

  const SUPABASE_URL =
    process.env.VITE_SUPABASE_URL;

  const SUPABASE_KEY =
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

  const WHATSAPP_ACCESS_TOKEN =
    process.env.WHATSAPP_ACCESS_TOKEN;

  const WHATSAPP_PHONE_NUMBER_ID =
    process.env.WHATSAPP_PHONE_NUMBER_ID;

  // ---------------------------------------------------------
  // Send WhatsApp message
  // ---------------------------------------------------------
  async function sendWhatsAppMessage(to, body) {
    const url =
      `https://graph.facebook.com/v26.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: {
          preview_url: false,
          body
        }
      })
    });

    const result = await response.json();

    console.log(
      "FETCH WHATSAPP API STATUS:",
      response.status
    );

    console.log(
      "FETCH WHATSAPP API RESPONSE:",
      JSON.stringify(result, null, 2)
    );

    return {
      ok: response.ok,
      result
    };
  }

  // ---------------------------------------------------------
  // Supabase request
  // ---------------------------------------------------------
  async function supabaseRequest(path, options = {}) {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/${path}`,
      {
        ...options,
        headers: {
          "apikey": SUPABASE_KEY,
          "Authorization": `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json",
          ...(options.headers || {})
        }
      }
    );

    const text = await response.text();

    let data = null;

    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    if (!response.ok) {
      console.error(
        "FETCH SUPABASE ERROR:",
        response.status,
        JSON.stringify(data)
      );
    }

    return {
      ok: response.ok,
      status: response.status,
      data
    };
  }

  // ---------------------------------------------------------
  // Clean text
  // ---------------------------------------------------------
  function cleanText(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // ---------------------------------------------------------
  // Detect YES / NO
  // ---------------------------------------------------------
  function isYes(text) {
    return /^(yes|y|yeah|yep|correct|confirm|confirmed|ok|okay|sure|go ahead|proceed)$/i.test(
      cleanText(text)
    );
  }

  function isNo(text) {
    return /^(no|n|nope|wrong|change|edit|incorrect)$/i.test(
      cleanText(text)
    );
  }

  // ---------------------------------------------------------
  // Extract store
  // Examples:
  // "from Lulu Hypermarket"
  // "at Lulu"
  // ---------------------------------------------------------
  function extractStore(text) {
    const match = cleanText(text).match(
      /\b(?:from|at|in)\s+(.+?)(?=\s+(?:deliver|delivery|to my|near|with|and)\b|[.!?]|$)/i
    );

    if (!match) {
      return null;
    }

    const store = cleanText(match[1]);

    if (
      !store ||
      store.length < 2 ||
      /^(the|a|an|some|this|that|my)$/i.test(store)
    ) {
      return null;
    }

    return store;
  }

  // ---------------------------------------------------------
  // Extract delivery address
  // ---------------------------------------------------------
  function extractAddress(text) {
    const match = cleanText(text).match(
      /\b(?:deliver(?:y)?(?:\s+address)?|delivery)\s*(?:to|at)?\s*[:\-]?\s*(.+)$/i
    );

    if (!match) {
      return null;
    }

    const address = cleanText(match[1]);

    if (!address || address.length < 3) {
      return null;
    }

    return address;
  }

  // ---------------------------------------------------------
  // Extract shopping items
  // ---------------------------------------------------------
  function extractItems(text) {
    let items = cleanText(text);

    items = items
      .replace(
        /^(hi|hello|hey|hi fetch|hello fetch|hey fetch)[,!\s]*/i,
        ""
      )
      .replace(
        /^(i\s+)?(?:want|need|would like|please get|please buy|can you get|can you buy|help me get)\s*/i,
        ""
      );

    items = items
      .replace(
        /\b(?:from|at|in)\s+(.+?)(?=\s+(?:deliver|delivery|to my|near|with|and)\b|[.!?]|$)/i,
        ""
      )
      .replace(
        /\b(?:deliver(?:y)?(?:\s+address)?|delivery)\s*(?:to|at)?\s*[:\-]?\s*.+$/i,
        ""
      );

    items = cleanText(items)
      .replace(/^[:,-]\s*/, "")
      .replace(/\s+from\s*$/i, "")
      .replace(/\s+at\s*$/i, "");

    if (!items || items.length < 2) {
      return null;
    }

    return items;
  }

  // ---------------------------------------------------------
  // Confirmation message
  // ---------------------------------------------------------
  function confirmationMessage(order) {
    return (
      "Please confirm your Fetch order 🛍️\n\n" +
      `🏪 Store: ${order.store_name}\n\n` +
      `🛒 Items: ${order.items}\n\n` +
      `📍 Delivery: ${order.delivery_address}\n\n` +
      "Reply YES to confirm or NO to change something."
    );
  }

  // ---------------------------------------------------------
  // META WEBHOOK VERIFICATION
  // ---------------------------------------------------------
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    const verifyToken =
      process.env.WHATSAPP_VERIFY_TOKEN;

    if (
      mode === "subscribe" &&
      token &&
      verifyToken &&
      token === verifyToken
    ) {
      console.log("FETCH WEBHOOK VERIFIED");

      return res.status(200).send(challenge);
    }

    console.log("FETCH WEBHOOK VERIFICATION FAILED");

    return res.status(403).send("Forbidden");
  }

  // ---------------------------------------------------------
  // RECEIVE WHATSAPP MESSAGE
  // ---------------------------------------------------------
  if (req.method === "POST") {
    console.log("FETCH WHATSAPP WEBHOOK RECEIVED");

    try {
      const body = req.body;

      console.log(
        "FETCH WEBHOOK PAYLOAD:",
        JSON.stringify(body, null, 2)
      );

      const change = body?.entry?.[0]?.changes?.[0];
      const value = change?.value;
      const message = value?.messages?.[0];

      if (!message) {
        console.log(
          "FETCH: No customer message in this webhook."
        );

        return res.status(200).json({
          success: true,
          message: "Webhook received"
        });
      }

      // -----------------------------------------------------
      // Only text messages for now
      // -----------------------------------------------------
      if (message.type !== "text") {
        console.log(
          `FETCH: Unsupported message type: ${message.type}`
        );

        return res.status(200).json({
          success: true,
          message: "Message received but not a text message"
        });
      }

      const customerPhone = message.from;

      const customerMessage =
        cleanText(message.text?.body);

      console.log(
        "FETCH CUSTOMER PHONE:",
        customerPhone
      );

      console.log(
        "FETCH CUSTOMER MESSAGE:",
        customerMessage
      );

      // -----------------------------------------------------
      // Validate configuration
      // -----------------------------------------------------
      if (!SUPABASE_URL || !SUPABASE_KEY) {
        console.error(
          "FETCH ERROR: Supabase environment variables are missing."
        );

        return res.status(200).json({
          success: false,
          error: "Supabase configuration missing"
        });
      }

      if (
        !WHATSAPP_ACCESS_TOKEN ||
        !WHATSAPP_PHONE_NUMBER_ID
      ) {
        console.error(
          "FETCH ERROR: WhatsApp environment variables are missing."
        );

        return res.status(200).json({
          success: false,
          error: "WhatsApp configuration missing"
        });
      }

      // -----------------------------------------------------
      // Find customer
      // -----------------------------------------------------
      const customerLookup =
        await supabaseRequest(
          `customers?phone=eq.${encodeURIComponent(customerPhone)}&select=*`
        );

      if (!customerLookup.ok) {
        return res.status(200).json({
          success: false,
          error: "Could not look up customer"
        });
      }

      let customer =
        customerLookup.data?.[0] || null;

      // -----------------------------------------------------
      // Create customer if new
      // -----------------------------------------------------
      if (!customer) {
        const customerCreate =
          await supabaseRequest(
            "customers",
            {
              method: "POST",
              headers: {
                "Prefer": "return=representation"
              },
              body: JSON.stringify({
                name: null,
                phone: customerPhone,
                address: null
              })
            }
          );

        if (!customerCreate.ok) {
          return res.status(200).json({
            success: false,
            error: "Could not create customer"
          });
        }

        customer =
          customerCreate.data?.[0] || null;
      }

      if (!customer?.id) {
        console.error(
          "FETCH ERROR: Customer ID missing."
        );

        return res.status(200).json({
          success: false,
          error: "Customer ID missing"
        });
      }

      // -----------------------------------------------------
      // Find active order
      // -----------------------------------------------------
      const activeOrderLookup =
        await supabaseRequest(
          `orders?customer_id=eq.${encodeURIComponent(customer.id)}&status=in.(collecting_details,awaiting_confirmation)&select=*&order=created_at.desc&limit=1`
        );

      if (!activeOrderLookup.ok) {
        return res.status(200).json({
          success: false,
          error: "Could not look up active order"
        });
      }

      let activeOrder =
        activeOrderLookup.data?.[0] || null;

      // -----------------------------------------------------
      // YES = confirm
      // -----------------------------------------------------
      if (activeOrder && isYes(customerMessage)) {
        const updateResult =
          await supabaseRequest(
            `orders?id=eq.${encodeURIComponent(activeOrder.id)}`,
            {
              method: "PATCH",
              headers: {
                "Prefer": "return=representation"
              },
              body: JSON.stringify({
                status: "finding_shopper"
              })
            }
          );

        if (!updateResult.ok) {
          return res.status(200).json({
            success: false,
            error: "Could not confirm order"
          });
        }

        await sendWhatsAppMessage(
          customerPhone,
          "Confirmed! ✅\n\nYour Fetch order is now being sent to available shoppers. 🛍️\n\nI'll update you as soon as a shopper accepts it."
        );

        return res.status(200).json({
          success: true,
          message: "Order confirmed"
        });
      }

      // -----------------------------------------------------
      // NO = edit order
      // -----------------------------------------------------
      if (activeOrder && isNo(customerMessage)) {
        await supabaseRequest(
          `orders?id=eq.${encodeURIComponent(activeOrder.id)}`,
          {
            method: "PATCH",
            headers: {
              "Prefer": "return=representation"
            },
            body: JSON.stringify({
              status: "collecting_details"
            })
          }
        );

        await sendWhatsAppMessage(
          customerPhone,
          "No problem 👍\n\nTell me what you'd like to change. You can send the store, items, and delivery address together."
        );

        return res.status(200).json({
          success: true,
          message: "Waiting for corrected details"
        });
      }

      // -----------------------------------------------------
      // Parse request
      // -----------------------------------------------------
      const detectedStore =
        extractStore(customerMessage);

      const detectedItems =
        extractItems(customerMessage);

      const detectedAddress =
        extractAddress(customerMessage);

      // -----------------------------------------------------
      // Update existing collecting order
      // -----------------------------------------------------
      if (
        activeOrder &&
        activeOrder.status === "collecting_details"
      ) {
        const nextStore =
          detectedStore ||
          (
            activeOrder.store_name !== "Not specified"
              ? activeOrder.store_name
              : null
          );

        const nextItems =
          detectedItems ||
          (
            activeOrder.items !== "Not specified"
              ? activeOrder.items
              : null
          );

        const nextAddress =
          detectedAddress ||
          customer.address ||
          activeOrder.delivery_address ||
          null;

        const missingStore = !nextStore;
        const missingItems = !nextItems;
        const missingAddress = !nextAddress;

        const updateData = {};

        if (nextStore) {
          updateData.store_name = nextStore;
        }

        if (nextItems) {
          updateData.items = nextItems;
        }

        if (nextAddress) {
          updateData.delivery_address = nextAddress;
        }

        if (
          !missingStore &&
          !missingItems &&
          !missingAddress
        ) {
          updateData.status =
            "awaiting_confirmation";
        }

        const updateResult =
          await supabaseRequest(
            `orders?id=eq.${encodeURIComponent(activeOrder.id)}`,
            {
              method: "PATCH",
              headers: {
                "Prefer": "return=representation"
              },
              body: JSON.stringify(updateData)
            }
          );

        if (!updateResult.ok) {
          return res.status(200).json({
            success: false,
            error: "Could not update order"
          });
        }

        const updatedOrder =
          updateResult.data?.[0] || {
            ...activeOrder,
            ...updateData
          };

        if (
          !missingStore &&
          !missingItems &&
          !missingAddress
        ) {
          await sendWhatsAppMessage(
            customerPhone,
            confirmationMessage(updatedOrder)
          );
        } else {
          let reply =
            "Got it 👍 Let's complete your Fetch request.\n\n";

          if (missingStore) {
            reply +=
              "🏪 Which store should I shop from?\n\n";
          }

          if (missingItems) {
            reply +=
              "🛒 What items do you need?\n\n";
          }

          if (missingAddress) {
            reply +=
              "📍 Where should I deliver the order?\n\n";
          }

          reply +=
            "You can send the missing details in one message.";

          await sendWhatsAppMessage(
            customerPhone,
            reply
          );
        }

        return res.status(200).json({
          success: true,
          message: "Order details updated"
        });
      }

      // -----------------------------------------------------
      // Create new order
      // -----------------------------------------------------
      const store =
        detectedStore || "Not specified";

      const items =
        detectedItems || "Not specified";

      const address =
        detectedAddress ||
        customer.address ||
        null;

      const complete =
        detectedStore &&
        detectedItems &&
        address;

      const orderCreate =
        await supabaseRequest(
          "orders",
          {
            method: "POST",
            headers: {
              "Prefer": "return=representation"
            },
            body: JSON.stringify({
              customer_id: customer.id,
              shopper_id: null,
              store_name: store,
              items,
              budget: null,
              delivery_address: address,
              status: complete
                ? "awaiting_confirmation"
                : "collecting_details",
              total_amount: null,
              shopper_fee: null
            })
          }
        );

      if (!orderCreate.ok) {
        return res.status(200).json({
          success: false,
          error: "Could not create order"
        });
      }

      activeOrder =
        orderCreate.data?.[0] || null;

      // -----------------------------------------------------
      // Respond
      // -----------------------------------------------------
      if (complete && activeOrder) {
        await sendWhatsAppMessage(
          customerPhone,
          confirmationMessage(activeOrder)
        );
      } else {
        let reply =
          "Got it 👍 I'll help you with that.\n\n";

        if (!detectedStore) {
          reply +=
            "🏪 Which store should I shop from?\n\n";
        }

        if (!detectedItems) {
          reply +=
            "🛒 What items do you need?\n\n";
        }

        if (!address) {
          reply +=
            "📍 Where should I deliver the order?\n\n";
        }

        reply +=
          "You can send all the missing details together.";

        await sendWhatsAppMessage(
          customerPhone,
          reply
        );
      }

      return res.status(200).json({
        success: true,
        message: "Fetch processed customer request",
        order_id: activeOrder?.id || null
      });

    } catch (error) {
      console.error(
        "FETCH WEBHOOK ERROR:",
        error
      );

      return res.status(200).json({
        success: false,
        error: "Webhook processing error"
      });
    }
  }

  return res.status(405).json({
    error: "Method not allowed"
  });
}
