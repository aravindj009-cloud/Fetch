/*
 * Fetch specialist collaboration v1.
 *
 * First concrete agent workflow: Patch coordinates a local-service discovery
 * result and explicitly asks Scout to classify the supplied listing evidence.
 * Scout only assesses allowlisted source/verification metadata; it does not
 * browse, contact providers, or upgrade a provider to independently verified.
 *
 * This is used by the IoI Preview/shadow path only. The existing Fetch response
 * remains authoritative until this capability is deliberately promoted.
 */
import { createFetchAgentMessenger } from "./fetch-agent-messaging.mjs";

const clean = (value, max = 220) => String(value ?? "").trim().replace(/\s+/g, " ").slice(0, max);
const obj = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};

function safeListing(provider) {
  const p = obj(provider);
  return {
    id: clean(p.id || "", 120) || null,
    business_name: clean(p.business_name || p.name || "", 180) || null,
    service_type: clean(p.service_type || p.category || "", 100) || null,
    service_area: clean(p.service_area || "", 220) || null,
    address: clean(p.address || "", 220) || null,
    distance_km: p.distance_km == null || p.distance_km === "" ? null :
      (Number.isFinite(Number(p.distance_km)) ? Number(p.distance_km) : null),
    source_name: clean(p.source_name || "", 120) || null,
    trust_level: clean(p.trust_level || "", 100) || null,
    independently_verified: p.independently_verified === true,
    verification_status: clean(p.verification_status || "", 80) || null,
    listing_uri: clean(p.listing_uri || p.profile_url || p.website || "", 1000) || null,
  };
}

function assessListing(provider) {
  const listing = safeListing(provider);
  const hasHttpsSource = /^https:\/\//i.test(listing.listing_uri || "");
  const saysIndependentlyVerified = listing.independently_verified === true;
  return {
    provider_id: listing.id,
    evidence_status: hasHttpsSource ? "source_reference_present" : "source_reference_missing",
    verification_status: saysIndependentlyVerified ? "source_marks_independently_verified" : "not_independently_verified",
    source_name: listing.source_name,
    trust_level: listing.trust_level,
    note: saysIndependentlyVerified
      ? "The supplied source marks this listing as independently verified; Fetch has not independently re-verified that claim."
      : hasHttpsSource
        ? "A source reference is present, but this workflow has not independently verified the provider."
        : "No public source reference was supplied; provider details remain unverified.",
  };
}

export function createFetchServiceDiscoveryCollaboration({
  timeoutMs = 3500,
  maxMessages = 3,
} = {}) {
  const handlers = {
    local_helper: {
      coordinate_discovery_result: {
        sideEffectClass: "read_only",
        async execute({ message, delegate }) {
          const payload = obj(message.payload);
          const providers = (Array.isArray(payload.providers) ? payload.providers : [])
            .slice(0, 5)
            .map(safeListing);
          const scoutReply = await delegate({
            toAgent: "scout",
            capability: "assess_listing_evidence",
            payload: {
              requested_service: clean(payload.requested_service || "", 120),
              source_registry: clean(payload.source_registry || "", 100),
              providers,
            },
          });
          const assessments = Array.isArray(scoutReply.result?.assessments)
            ? scoutReply.result.assessments
            : [];
          const assessmentById = new Map(assessments.map((item) => [item.provider_id, item]));
          return {
            coordinator_agent: "local_helper",
            specialist_handoff: {
              to_agent: "scout",
              capability: "assess_listing_evidence",
              status: scoutReply.status,
              trace_message_id: scoutReply.message?.message_id || null,
            },
            requested_service: clean(payload.requested_service || "", 120) || null,
            source_registry: clean(payload.source_registry || "", 100) || null,
            provider_count: providers.length,
            providers: providers.map((provider) => ({
              ...provider,
              source_assessment: assessmentById.get(provider.id) || {
                provider_id: provider.id,
                evidence_status: "assessment_unavailable",
                verification_status: "not_independently_verified",
                note: "Scout's evidence assessment was unavailable.",
              },
            })),
            safety: {
              read_only: true,
              providers_contacted: false,
              appointments_booked: false,
              independently_verified_by_scout: false,
            },
          };
        },
      },
    },
    scout: {
      assess_listing_evidence: {
        sideEffectClass: "read_only",
        async execute({ message }) {
          const payload = obj(message.payload);
          const providers = (Array.isArray(payload.providers) ? payload.providers : []).slice(0, 5);
          return {
            assessing_agent: "scout",
            assessment_scope: "source_and_verification_metadata_only",
            independently_verified_by_scout: false,
            assessments: providers.map(assessListing),
            note: "Scout classified only the supplied listing metadata. No external source was fetched and no provider was contacted.",
          };
        },
      },
    },
  };

  const messenger = createFetchAgentMessenger({
    handlers,
    timeoutMs,
    maxMessages,
    maxDepth: 1,
    maxPayloadBytes: 12000,
  });

  async function run({ taskId, traceId = null, discovery = {} } = {}) {
    const result = obj(discovery);
    const rawProviders = Array.isArray(result.providers) ? result.providers.slice(0, 5) : [];
    const payload = {
      requested_service: clean(result.requested_service || "", 120),
      source_registry: clean(result.source_registry || "", 100),
      location: (() => {
        const loc = obj(result.location);
        return { city: clean(loc.city || "", 120) || null };
      })(),
      provider_count: rawProviders.length,
      providers: rawProviders.map(safeListing),
      directory_outcome: clean(result.outcome || "", 80) || null,
    };
    return messenger.run({
      taskId: clean(taskId || "", 180) || "local-service-discovery",
      traceId: clean(traceId || "", 180) || undefined,
      toAgent: "local_helper",
      capability: "coordinate_discovery_result",
      payload,
    });
  }

  return Object.freeze({ run });
}
