/* Fetch V9 Workflow API */

import {
  getWorkflow,
  listCustomerWorkflows,
  refreshWorkflowReadiness,
  approveWorkflowStep,
  rejectWorkflowStep,
} from "../../lib/fetch-workflow-v9.mjs";

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const workflowId = req.query?.workflow_id || req.query?.workflowId || null;
      const customerId = req.query?.customer_id || req.query?.customerId || null;

      if (workflowId) {
        const workflow = await getWorkflow(String(workflowId), { includeSteps: true });
        if (!workflow) return res.status(404).json({ error: "workflow_not_found" });
        return res.status(200).json(workflow);
      }

      if (customerId) {
        return res.status(200).json({
          customer_id: String(customerId),
          workflows: await listCustomerWorkflows(String(customerId)),
        });
      }

      return res.status(400).json({ error: "workflow_id or customer_id is required" });
    }

    if (req.method === "POST") {
      const body = req.body || {};
      const workflowId = body.workflow_id || body.workflowId;
      const action = String(body.action || "refresh");

      if (!workflowId) return res.status(400).json({ error: "workflow_id is required" });

      let result;
      if (action === "refresh") result = await refreshWorkflowReadiness(String(workflowId));
      else if (action === "approve_step") result = await approveWorkflowStep(String(body.step_id || body.stepId));
      else if (action === "reject_step") result = await rejectWorkflowStep(String(body.step_id || body.stepId));
      else return res.status(400).json({ error: "unsupported_action" });

      return res.status(200).json(result);
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (error) {
    console.error("FETCH V9 WORKFLOW API ERROR:", error);
    return res.status(500).json({ error: "workflow_operation_failed", message: error?.message || String(error) });
  }
}
