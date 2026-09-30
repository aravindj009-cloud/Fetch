import { listCapabilities } from "../../lib/fetch-capability-registry.mjs";

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ success: false, error: "method_not_allowed" });
    }

    const capabilities = await listCapabilities({ force: true });

    return res.status(200).json({
      success: true,
      capabilities,
      active: capabilities.filter((item) => item.status === "active"),
      planned: capabilities.filter((item) => item.status === "planned"),
    });
  } catch (error) {
    console.error("FETCH CAPABILITIES API ERROR:", error);
    return res.status(500).json({
      success: false,
      error: error?.message || String(error),
    });
  }
}
