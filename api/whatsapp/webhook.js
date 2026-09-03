export default async function handler(req, res) {
  // ---------------------------------------------------------
  // FETCH WHATSAPP WEBHOOK
  // ---------------------------------------------------------

  // Meta uses GET to verify that this webhook belongs to Fetch.
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

    if (
      mode === "subscribe" &&
      token &&
      VERIFY_TOKEN &&
      token === VERIFY_TOKEN
    ) {
      console.log("FETCH WEBHOOK VERIFIED");

      return res.status(200).send(challenge);
    }

    console.log("FETCH WEBHOOK VERIFICATION FAILED");

    return res.status(403).send("Forbidden");
  }

  // Meta sends incoming WhatsApp messages using POST.
  if (req.method === "POST") {
    console.log("FETCH WHATSAPP WEBHOOK RECEIVED");

    console.log(JSON.stringify(req.body, null, 2));

    // We acknowledge the message immediately.
    // Later we will process it with AI and create the order.
    return res.status(200).json({
      success: true,
      message: "Fetch webhook received the message"
    });
  }

  return res.status(405).json({
    error: "Method not allowed"
  });
}
