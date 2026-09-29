/* FETCH AGENT TASK API
 *
 * GET:
 *   /api/fetch/tasks?task_id=<uuid>
 *   /api/fetch/tasks?customer_id=<uuid>
 *   /api/fetch/tasks?conversation_id=<id>&channel=web
 *
 * POST:
 *   action=approve|reject|cancel|retry
 *
 * This is the durable task/status surface for the Fetch personal agent.
 */

import {
  getAgentTask,
  listAgentTasks,
  updateAgentTask,
  addAgentEvent,
} from "../../lib/fetch-agent-runtime.mjs";

function cleanText(value) {
  return value == null ? "" : String(value).trim();
}

function json(res, status, body) {
  return res.status(status).json(body);
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "")
  );
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const taskId =
        req.query?.task_id ||
        req.query?.taskId ||
        null;

      if (taskId) {
        if (!isUuid(taskId)) {
          return json(res, 400, {
            success: false,
            error: "invalid_task_id",
          });
        }

        const task = await getAgentTask(taskId, {
          includeSteps: true,
          includeEvents: true,
        });

        if (!task) {
          return json(res, 404, {
            success: false,
            error: "task_not_found",
          });
        }

        return json(res, 200, {
          success: true,
          task,
        });
      }

      const tasks = await listAgentTasks({
        customerId:
          req.query?.customer_id ||
          req.query?.customerId ||
          null,
        channel: req.query?.channel || null,
        conversationId:
          req.query?.conversation_id ||
          req.query?.conversationId ||
          null,
        status: req.query?.status || null,
        limit: req.query?.limit || 20,
      });

      return json(res, 200, {
        success: true,
        tasks,
      });
    }

    if (req.method === "POST") {
      const body = req.body || {};
      const taskId = body.task_id || body.taskId;
      const action = cleanText(body.action).toLowerCase();

      if (!isUuid(taskId)) {
        return json(res, 400, {
          success: false,
          error: "valid task_id is required",
        });
      }

      const task = await getAgentTask(taskId, {
        includeSteps: false,
        includeEvents: false,
      });

      if (!task) {
        return json(res, 404, {
          success: false,
          error: "task_not_found",
        });
      }

      if (action === "approve") {
        const updated = await updateAgentTask(taskId, {
          confirmation_status: "approved",
          status: "running",
        });

        await addAgentEvent({
          taskId,
          customerId: task.customer_id,
          eventType: "customer_approved",
          status: "running",
          actorType: "customer",
          payload: { source: "task_api" },
        });

        return json(res, 200, {
          success: true,
          task: updated,
        });
      }

      if (action === "reject") {
        const updated = await updateAgentTask(taskId, {
          confirmation_status: "rejected",
          status: "cancelled",
          completed_at: new Date().toISOString(),
        });

        await addAgentEvent({
          taskId,
          customerId: task.customer_id,
          eventType: "customer_rejected",
          status: "cancelled",
          actorType: "customer",
          payload: { source: "task_api" },
        });

        return json(res, 200, {
          success: true,
          task: updated,
        });
      }

      if (action === "cancel") {
        const updated = await updateAgentTask(taskId, {
          status: "cancelled",
          completed_at: new Date().toISOString(),
        });

        await addAgentEvent({
          taskId,
          customerId: task.customer_id,
          eventType: "task_cancelled",
          status: "cancelled",
          actorType: "customer",
          payload: { source: "task_api" },
        });

        return json(res, 200, {
          success: true,
          task: updated,
        });
      }

      if (action === "retry") {
        const updated = await updateAgentTask(taskId, {
          status: "running",
          error: null,
        });

        await addAgentEvent({
          taskId,
          customerId: task.customer_id,
          eventType: "task_retry_requested",
          status: "running",
          actorType: "customer",
          payload: { source: "task_api" },
        });

        return json(res, 200, {
          success: true,
          task: updated,
        });
      }

      return json(res, 400, {
        success: false,
        error: "unsupported_action",
      });
    }

    res.setHeader("Allow", "GET, POST");
    return json(res, 405, {
      success: false,
      error: "method_not_allowed",
    });
  } catch (error) {
    console.error("FETCH TASK API ERROR:", error);
    return json(res, 500, {
      success: false,
      error: error?.message || String(error),
    });
  }
}
