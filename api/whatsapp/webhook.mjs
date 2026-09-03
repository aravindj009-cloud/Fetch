export default async function handler(req, res) {
  // =========================================================
  // FETCH WHATSAPP WEBHOOK
  // =========================================================

  // ---------------------------------------------------------
  // 1. META WEBHOOK VERIFICATION
  // ---------------------------------------------------------
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;

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
  // 2. RECEIVE WHATSAPP MESSAGE
  // ---------------------------------------------------------
  if (req.method === "POST") {
    console.log("FETCH WHATSAPP WEBHOOK RECEIVED");

    try {
      const body = req.body;

      console.log(JSON.stringify(body, null, 2));

      // -----------------------------------------------------
      // Find the incoming WhatsApp message
      // -----------------------------------------------------
      const change = body?.entry?.[0]?.changes?.[0];
      const value = change?.value;
      const message = value?.messages?.[0];

      // Sometimes Meta sends webhook events that aren't
      // actual customer messages.
      if (!message) {
        console.log("FETCH: No customer message in this webhook.");

        return res.status(200).json({
          success: true,
          message: "Webhook received"
        });
      }

      // -----------------------------------------------------
      // Customer information
      // -----------------------------------------------------
      const customerPhone = message.from;

      // -----------------------------------------------------
      // Only process text messages for now
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

      const customerMessage = message.text?.body || "";

      console.log("FETCH CUSTOMER PHONE:", customerPhone);
      console.log("FETCH CUSTOMER MESSAGE:", customerMessage);

      // -----------------------------------------------------
      // 3. WHATSAPP CONFIGURATION
      // -----------------------------------------------------
      const accessToken =
        process.env.WHATSAPP_ACCESS_TOKEN;

      const phoneNumberId =
        process.env.WHATSAPP_PHONE_NUMBER_ID;

      if (!accessToken) {
        console.error(
          "FETCH ERROR: WHATSAPP_ACCESS_TOKEN is missing."
        );

        return res.status(200).json({
          success: false,
          error: "WhatsApp access token is missing"
        });
      }

      if (!phoneNumberId) {
        console.error(
          "FETCH ERROR: WHATSAPP_PHONE_NUMBER_ID is missing."
        );

        return res.status(200).json({
          success: false,
          error: "WhatsApp phone number ID is missing"
        });
      }

      // -----------------------------------------------------
      // 4. CREATE INITIAL FETCH RESPONSE
      // -----------------------------------------------------
      const reply =
        "Hi! 👋 I'm Fetch.\n\n" +
        "I received your request:\n\n" +
        `"${customerMessage}"\n\n` +
        "I'm processing your shopping request now. 🛍️\n\n" +
        "I'll confirm the details with you before we send a shopper.";

      // -----------------------------------------------------
      // 5. SEND REPLY THROUGH WHATSAPP CLOUD API
      // -----------------------------------------------------
      const whatsappUrl =
        `https://graph.facebook.com/v26.0/${phoneNumberId}/messages`;

      const whatsappResponse = await fetch(
        whatsappUrl,
        {
          method: "POST",

          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json"
          },

          body: JSON.stringify({
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: customerPhone,
            type: "text",
            text: {
              preview_url: false,
              body: reply
            }
          })
        }
      );

      const whatsappResult =
        await whatsappResponse.json();

      console.log(
        "FETCH WHATSAPP API STATUS:",
        whatsappResponse.status
      );

      console.log(
        "FETCH WHATSAPP API RESPONSE:",
        JSON.stringify(
          whatsappResult,
          null,
          2
        )
      );

      // -----------------------------------------------------
      // 6. HANDLE WHATSAPP API ERROR
      // -----------------------------------------------------
      if (!whatsappResponse.ok) {
        console.error(
          "FETCH ERROR: WhatsApp message failed."
        );

        return res.status(200).json({
          success: false,
          error: "WhatsApp API message failed"
        });
      }

      // -----------------------------------------------------
      // 7. SUCCESS
      // -----------------------------------------------------
      console.log(
        "FETCH: Customer reply sent successfully."
      );

      return res.status(200).json({
        success: true,
        message: "Fetch replied to customer"
      });

    } catch (error) {
      console.error(
        "FETCH WEBHOOK ERROR:",
        error
      );

      // Always return 200 to Meta so it doesn't repeatedly
      // retry the same webhook event.
      return res.status(200).json({
        success: false,
        error: "Webhook processing error"
      });
    }
  }

  // ---------------------------------------------------------
  // 8. OTHER HTTP METHODS
  // ---------------------------------------------------------
  return res.status(405).json({
    error: "Method not allowed"
  });
}
