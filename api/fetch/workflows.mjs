import { getWorkflow } from "../../lib/fetch-workflow-runtime.mjs";

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ success: false, error: "method_not_allowed" });
    }

    const workflowId =
      req.query?.workflow_id ||
      req.query?.workflowId;

    if (!workflowId) {
      return res.status(400).json({
        success: false,
        error: "workflow_id_required",
      });
    }

    const workflow = await getWorkflow(workflowId, {
      includeSteps: true,
      includeEvents: true,
    });

    if (!workflow) {
      return res.status(404).json({
        success: false,
        error: "workflow_not_found",
      });
    }

    return res.status(200).json({
      success: true,
      workflow,
    });
  } catch (error) {
    console.error("FETCH WORKFLOW API ERROR:", error);
    return res.status(500).json({
      success: false,
      error: error?.message || String(error),
    });
  }
}
