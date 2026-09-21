/* Fetch V9 autonomous workflow decision endpoint */

import { processFetchV9Request } from "../../lib/fetch-v9.mjs";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body = req.body || {};
    if (!body.text || typeof body.text !== "string") {
      return res.status(400).json({ error: "text is required" });
    }

    const result = await processFetchV9Request({
      text: body.text,
      customerId: body.customer_id || null,
      conversationId: body.conversation_id || null,
      channel: body.channel || "api",
      activeTaskId: body.active_task_id || null,
      suppliedIntent: body.supplied_intent || null,
      suppliedContext: body.supplied_context || {},
    });

    return res.status(200).json(result);
  } catch (error) {
    console.error("FETCH V9 API ERROR:", error);
    return res.status(500).json({ error: "v9_workflow_failed", message: error?.message || String(error) });
  }
}
