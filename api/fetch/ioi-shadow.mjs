/*
 * Preview-only direct IoI capability test endpoint.
 *
 * This bypasses the database-backed Fetch conversation engine and invokes
 * only the built-in read-only weather/AQI adapters. It is intentionally
 * hidden unless the branch-specific shadow feature flag is enabled.
 */

import { runIOIShadowEvaluation } from "../../lib/fetch-ioi-shadow.mjs";

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

export default async function handler(req, res) {
  const enabled =
    typeof process !== "undefined" &&
    String(process.env.FETCH_IOI_SHADOW_MODE || "").toLowerCase() === "true";

  // Fail closed in Production and in any deployment without the explicit
  // Preview flag. Do not reveal the existence of this route when disabled.
  if (!enabled) {
    return res.status(404).json({ error: "not_found" });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
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

    if (!asObject(body)) {
      return res.status(400).json({
        error: "invalid_body",
        message: "Request body must be a JSON object.",
      });
    }

    const text = typeof body.text === "string" ? body.text.trim().slice(0, 4000) : "";
    if (!text) {
      return res.status(400).json({
        error: "text_required",
        message: "Provide a weather or AQI request in the text field.",
      });
    }

    const suppliedContext = asObject(body.supplied_context || body.suppliedContext) || {};
    const evaluation = await runIOIShadowEvaluation({
      request: {
        text,
        channel: "preview_test",
        suppliedContext,
      },
      // No baseline is run here: this endpoint isolates the IoI adapter from
      // Fetch chat persistence/configuration. The normal product endpoint
      // remains the place to compare shadow versus baseline.
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
        message: "This preview endpoint tests only read-only weather and air-quality capabilities.",
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
  } catch (error) {
    console.error("FETCH IOI PREVIEW TEST ERROR:", error?.message || error);
    return res.status(502).json({
      success: false,
      status: "shadow_execution_error",
      message: "The read-only provider test could not be completed.",
    });
  }
}
