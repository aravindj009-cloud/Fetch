/* Fetch V8 Customer Memory API */

import {
  listCustomerMemory,
  upsertCustomerMemory,
  deleteCustomerMemory,
} from "../../lib/fetch-memory-v8.mjs";

export default async function handler(req, res) {
  try {
    /*
      GET
      Read durable memory for one customer.

      Example:
      GET /api/fetch/memory?customer_id=customer-123
    */
    if (req.method === "GET") {
      const customerId =
        req.query?.customer_id ||
        req.query?.customerId ||
        null;

      if (!customerId) {
        return res.status(400).json({
          error: "customer_id is required",
        });
      }

      const memory = await listCustomerMemory(String(customerId));

      return res.status(200).json({
        customer_id: String(customerId),
        memory,
      });
    }

    /*
      POST
      Store an explicit or system-confirmed memory.

      Example body:
      {
        "customer_id": "customer-123",
        "memory_key": "preferred_language",
        "memory_value": "English",
        "memory_type": "preference",
        "source": "user_explicit",
        "confidence": 1,
        "explicit": true
      }
    */
    if (req.method === "POST") {
      const body = req.body || {};

      if (!body.customer_id) {
        return res.status(400).json({
          error: "customer_id is required",
        });
      }

      if (!body.memory_key) {
        return res.status(400).json({
          error: "memory_key is required",
        });
      }

      if (body.memory_value === undefined) {
        return res.status(400).json({
          error: "memory_value is required",
        });
      }

      const result = await upsertCustomerMemory({
        customerId: body.customer_id,
        memoryKey: body.memory_key,
        memoryValue: body.memory_value,
        memoryType: body.memory_type || "fact",
        source: body.source || "user_explicit",
        confidence:
          body.confidence === undefined
            ? 1
            : Number(body.confidence),
        explicit:
          body.explicit === undefined
            ? true
            : Boolean(body.explicit),
        expiresAt: body.expires_at || null,
      });

      return res.status(200).json({
        success: true,
        memory: result,
      });
    }

    /*
      DELETE
      Remove one memory key for one customer.

      Example:
      DELETE /api/fetch/memory?customer_id=customer-123&memory_key=preferred_language
    */
    if (req.method === "DELETE") {
      const customerId =
        req.query?.customer_id ||
        req.query?.customerId ||
        null;

      const memoryKey =
        req.query?.memory_key ||
        req.query?.memoryKey ||
        null;

      if (!customerId) {
        return res.status(400).json({
          error: "customer_id is required",
        });
      }

      if (!memoryKey) {
        return res.status(400).json({
          error: "memory_key is required",
        });
      }

      const result = await deleteCustomerMemory({
        customerId: String(customerId),
        memoryKey: String(memoryKey),
      });

      return res.status(200).json(result);
    }

    return res.status(405).json({
      error: "Method not allowed",
    });
  } catch (error) {
    console.error("FETCH V8 MEMORY API ERROR:", error);

    return res.status(500).json({
      error: "memory_operation_failed",
      message: error?.message || String(error),
    });
  }
}
