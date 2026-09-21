/* FETCH UNIVERSAL API — V1

POST /api/fetch/universal

This is the first end-to-end universal Fetch test endpoint:

    Request
      -> Fetch V9
      -> ATC
      -> Resource
      -> Digital Agent
      -> Result

Physical shopping is intentionally not duplicated here. The existing
WhatsApp physical order engine remains authoritative. */

import { executeUniversalFetchRequest, } from
“../../lib/fetch-universal-execution.mjs”;

export default async function handler(req, res) { if (req.method !==
“POST”) { return res.status(405).json({ error: “method_not_allowed”,
message: “POST is required”, }); }

try { let body = req.body || {};

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

    const result =
      await executeUniversalFetchRequest({
        text,
        customerId:
          body.customer_id ||
          body.customerId ||
          null,
        conversationId:
          body.conversation_id ||
          body.conversationId ||
          null,
        channel:
          body.channel ||
          "api",
        activeTaskId:
          body.active_task_id ||
          body.activeTaskId ||
          null,
        suppliedIntent:
          body.supplied_intent ||
          body.suppliedIntent ||
          null,
        suppliedContext:
          body.supplied_context ||
          body.suppliedContext ||
          {},
      });

    return res.status(200).json(result);

} catch (error) { console.error( “FETCH UNIVERSAL API ERROR:”, error );

    return res.status(500).json({
      error: "universal_execution_failed",
      message:
        error?.message ||
        "Universal Fetch execution failed.",
    });

} }
