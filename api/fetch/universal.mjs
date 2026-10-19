/* FETCH UNIVERSAL API - V1

POST /api/fetch/universal

End-to-end universal Fetch test endpoint:
  Request -> Fetch V9 -> ATC -> Resource -> Digital Agent -> Result

Physical shopping remains owned by the existing WhatsApp physical order engine.
*/

import { executeUniversalFetchRequest } from "../../lib/fetch-universal-execution.mjs";
import { runIOIShadowEvaluation } from "../../lib/fetch-ioi-shadow.mjs";

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

    const text = typeof body.text === "string" ? body.text.trim() : "";

    if (!text) {
      return res.status(400).json({
        error: "text_required",
        message: "text is required",
      });
    }

    /*
     * Optional direct IoI smoke test, routed through this existing Vercel
     * function to respect the Hobby 12-function deployment limit.
     * The flag is Preview-branch-only; disabled deployments return 404.
     * This path intentionally bypasses Supabase-backed baseline execution.
     */
    if (body.shadow_only === true || body.shadowOnly === true) {
      const enabled =
        typeof process !== "undefined" &&
        String(process.env.FETCH_IOI_SHADOW_MODE || "").toLowerCase() === "true";

      if (!enabled) {
        return res.status(404).json({ error: "not_found" });
      }

      const suppliedContext = body.supplied_context || body.suppliedContext || {};
      const evaluation = await runIOIShadowEvaluation({
        request: {
          text: text.slice(0, 4000),
          channel: "preview_test",
          suppliedContext,
        },
        existingResult: {
          status: "not_run",
          task: { status: "not_run" },
        },
        timeoutMs: 12000,
      });

      if (evaluation.status === "not_applicable") {
        return res.status(400).json({
          success: false,
          status: evaluation.status,
          message: "This test path supports only read-only weather and air-quality capabilities.",
        });
      }

      return res.status(
        evaluation.status === "completed" || evaluation.status === "needs_clarification"
          ? 200
          : 502
      ).json({
        success: evaluation.success === true,
        status: evaluation.status,
        mode: "preview_ioi_direct_test",
        result: evaluation,
      });
    }

    const result = await executeUniversalFetchRequest({
      text,
      customerId: body.customer_id || body.customerId || null,
      conversationId: body.conversation_id || body.conversationId || null,
      channel: body.channel || "api",
      activeTaskId: body.active_task_id || body.activeTaskId || null,
      suppliedIntent: body.supplied_intent || body.suppliedIntent || null,
      suppliedContext: body.supplied_context || body.suppliedContext || {},
    });

    return res.status(200).json(result);
  } catch (error) {
    console.error("FETCH UNIVERSAL API ERROR:", error);

    return res.status(500).json({
      error: "universal_execution_failed",
      message: error?.message || "Universal Fetch execution failed.",
    });
  }
}