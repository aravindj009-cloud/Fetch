/* FETCH TOOL ROUTER
 *
 * Turns a capability decision into a concrete execution tool contract.
 * A tool is not considered executable merely because it is registered:
 * the capability must be active and an adapter must exist.
 */

import { buildCapabilityDecision } from "./fetch-capability-registry.mjs";

const TOOL_DEFINITIONS = {
  digital_agent: {
    tool_key: "digital_agent",
    label: "Fetch Digital Agent",
    execution_mode: "agent",
    handler: "executeDigitalAgent",
    supports: ["research", "web", "digital_task", "shopping_research"],
  },
  physical_network: {
    tool_key: "physical_network",
    label: "Fetch Physical Network",
    execution_mode: "network",
    handler: "existing_physical_order_engine",
    supports: ["shopping", "errands", "physical_delivery"],
  },
  browser_agent: {
    tool_key: "browser_agent",
    label: "Fetch Browser Agent",
    execution_mode: "browser",
    handler: "executeBrowserAgent",
    supports: ["web_research", "website_task"],
  },
  calendar_api: {
    tool_key: "calendar_api",
    label: "Calendar",
    execution_mode: "connector",
    handler: null,
    supports: ["calendar"],
  },
  messaging_api: {
    tool_key: "messaging_api",
    label: "Messaging",
    execution_mode: "connector",
    handler: null,
    supports: ["messaging"],
  },
  phone_agent: {
    tool_key: "phone_agent",
    label: "Phone Agent",
    execution_mode: "voice",
    handler: null,
    supports: ["phone_call"],
  },
  flight_api: {
    tool_key: "flight_api",
    label: "Flight Booking",
    execution_mode: "connector",
    handler: null,
    supports: ["flight", "travel"],
  },
  reservation_api_or_phone: {
    tool_key: "reservation_api_or_phone",
    label: "Restaurant Reservation",
    execution_mode: "connector_or_voice",
    handler: null,
    supports: ["reservation", "restaurant"],
  },
  connected_app: {
    tool_key: "connected_app",
    label: "Connected App",
    execution_mode: "connector",
    handler: null,
    supports: ["connected_app"],
  },
};

export function getToolDefinition(toolKey) {
  const key = String(toolKey || "").trim().toLowerCase();
  return TOOL_DEFINITIONS[key] || null;
}

export function listToolDefinitions() {
  return Object.values(TOOL_DEFINITIONS);
}

export async function resolveExecutionTool(task = {}) {
  const decision = await buildCapabilityDecision(task);

  /*
   * Browser Agent is a built-in ATC resource, not a Supabase capability row.
   * ATC owns its endpoint discovery, so the tool router must recognize it
   * independently of the connector registry.
   */
  const requestedCapability = String(
    task?.capability ||
    task?.resource?.capability_key ||
    task?.resource?.capability ||
    task?.execution_network ||
    task?.resource?.type ||
    ""
  ).trim().toLowerCase();

  if (
    requestedCapability === "browser_agent" ||
    requestedCapability === "web_browser" ||
    requestedCapability === "computer_use"
  ) {
    const tool = getToolDefinition("browser_agent");

    return {
      executable: true,
      status: "ready",
      reason: "built_in_atc_browser_agent",
      capability: {
        capability_key: "browser_agent",
        display_name: "Fetch Browser Agent",
        resource_type: "browser_agent",
        status: "active",
      },
      tool,
    };
  }

  if (!decision.available) {
    return {
      executable: false,
      status: decision.status || "unavailable",
      reason: decision.reason,
      capability: decision.capability || null,
      tool: null,
    };
  }

  const capabilityKey = String(
    decision.capability?.capability_key || ""
  ).trim().toLowerCase();

  const tool = getToolDefinition(capabilityKey);

  if (!tool) {
    return {
      executable: false,
      status: "adapter_missing",
      reason: "no_tool_adapter_registered",
      capability: decision.capability,
      tool: null,
    };
  }

  if (!tool.handler) {
    return {
      executable: false,
      status: "connector_not_implemented",
      reason: "capability_active_but_connector_not_implemented",
      capability: decision.capability,
      tool,
    };
  }

  return {
    executable: true,
    status: "ready",
    reason: "tool_ready",
    capability: decision.capability,
    tool,
  };
}

export function buildToolPlan(task = {}, toolResolution = null) {
  const resolution = toolResolution || {
    executable: false,
    status: "unavailable",
    reason: "tool_resolution_not_run",
  };

  return {
    selected_tool: resolution.tool?.tool_key || null,
    tool_label: resolution.tool?.label || null,
    execution_mode: resolution.tool?.execution_mode || null,
    handler: resolution.tool?.handler || null,
    capability: resolution.capability?.capability_key || task?.capability || null,
    status: resolution.status,
    executable: Boolean(resolution.executable),
    reason: resolution.reason,
  };
}
