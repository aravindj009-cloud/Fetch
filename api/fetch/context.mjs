/* V8 Context-aware decision endpoint */
import { processFetchV8Request } from "../../lib/fetch-v8.mjs";
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const body = req.body || {};
    if (!body.text || typeof body.text !== "string") return res.status(400).json({ error: "text is required" });
    const result = await processFetchV8Request({ text: body.text, customerId: body.customer_id || null, conversationId: body.conversation_id || null, channel: body.channel || "api", activeTaskId: body.active_task_id || null, suppliedIntent: body.intent || null, suppliedContext: body.context || {} });
    return res.status(200).json(result);
  } catch (error) {
    console.error("FETCH V8 CONTEXT ERROR:", error);
    return res.status(500).json({ error: "context_decision_failed", message: error?.message || String(error) });
  }
}
