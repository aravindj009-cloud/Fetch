/* Fetch V9 autonomous workflow decision endpoint
 *
 * Vercel Node serverless function.
 * This endpoint is intentionally thin: all V9 orchestration lives in
 * lib/fetch-v9.mjs.
 */

import { processFetchV9Request } from "../../lib/fetch-v9.mjs";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "method_not_allowed",
      message: "POST is required",
    });
  }

  try {
    let body = req.body || {};

    if (typeof body === "string") {
      try {
        body = body ? JSON.parse(body) : {};
      } catch {
        return res.status(400).json({
          error: "invalid_json",
          message: "Request body must contain valid JSON.",
        });
      }
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return res.status(400).json({
        error: "invalid_body",
        message: "Request body must be a JSON object.",
      });
    }

    const text =
      typeof body.text === "string"
        ? body.text.trim()
        : "";

    if (!text) {
      return res.status(400).json({
        error: "text_required",
        message: "text is required",
      });
    }

    const result = await processFetchV9Request({
      text,
      customerId: body.customer_id || body.customerId || null,
      conversationId:
        body.conversation_id || body.conversationId || null,
      channel: body.channel || "api",
      activeTaskId:
        body.active_task_id || body.activeTaskId || null,
      suppliedIntent:
        body.supplied_intent || body.suppliedIntent || null,
      suppliedContext:
        body.supplied_context || body.suppliedContext || {},
    });

    return res.status(200).json(result);
  } catch (error) {
    console.error("FETCH V9 API ERROR:", error);

    return res.status(500).json({
      error: "v9_workflow_failed",
      message: error?.message || String(error),
    });
  }
}
