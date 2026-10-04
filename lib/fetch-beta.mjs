import crypto from "node:crypto";

const SUPABASE_URL =
  process.env.VITE_SUPABASE_URL ||
  "https://skfxzagxlxputwpwxwbe.supabase.co";

const SUPABASE_KEY =
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE;

function normalizePhone(phone) {
  return String(phone || "").replace(/\D/g, "");
}

function hashInviteToken(token) {
  const secret =
    String(process.env.FETCH_BETA_INVITE_SECRET || "").trim() ||
    String(SUPABASE_KEY || "").trim();

  if (!secret) throw new Error("Fetch beta invite secret is not configured.");

  return crypto
    .createHmac("sha256", secret)
    .update(String(token || ""))
    .digest("hex");
}

async function supabaseRequest(path, options = {}) {
  if (!SUPABASE_KEY) {
    throw new Error("Supabase server key is not configured.");
  }

  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Supabase ${response.status}: ${body}`);
  }

  return body ? JSON.parse(body) : null;
}

export function createBetaInviteToken() {
  return crypto.randomBytes(24).toString("base64url");
}

export async function createBetaInvite({
  inviterName = "Fetch",
  maxUses = 1,
  expiresInDays = 14,
} = {}) {
  const token = createBetaInviteToken();
  const tokenHash = hashInviteToken(token);
  const safeDays = Math.max(1, Math.min(90, Number(expiresInDays) || 14));
  const safeUses = Math.max(1, Math.min(20, Number(maxUses) || 1));

  const rows = await supabaseRequest("fetch_beta_invites", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      token_hash: tokenHash,
      inviter_name: String(inviterName || "Fetch").slice(0, 120),
      max_uses: safeUses,
      expires_at: new Date(Date.now() + safeDays * 86400000).toISOString(),
    }),
  });

  const row = Array.isArray(rows) ? rows[0] : rows;
  return {
    token,
    id: row?.id || null,
    expiresAt: row?.expires_at || null,
    url: `https://tryfetch.in/invite/${encodeURIComponent(token)}`,
  };
}

const PUBLIC_BETA_TOKEN = String(
  process.env.FETCH_BETA_PUBLIC_INVITE_TOKEN || "fetch-beta-2026-beta"
).trim();

export async function getBetaInvite(token) {
  if (String(token || "").trim() === PUBLIC_BETA_TOKEN) {
    return {
      id: null,
      inviter_name: "Fetch",
      max_uses: null,
      use_count: 0,
      expires_at: null,
      claimed_at: null,
      claimed_phone: null,
      created_at: null,
      expired: false,
      exhausted: false,
      available: true,
      public: true,
    };
  }

  const tokenHash = hashInviteToken(token);
  const rows = await supabaseRequest(
    `fetch_beta_invites?token_hash=eq.${encodeURIComponent(tokenHash)}&select=id,inviter_name,max_uses,use_count,expires_at,claimed_at,claimed_phone,created_at&limit=1`
  );

  if (!Array.isArray(rows) || !rows.length) return null;

  const row = rows[0];
  const expired = row.expires_at && new Date(row.expires_at).getTime() < Date.now();
  const exhausted = Number(row.use_count || 0) >= Number(row.max_uses || 1);

  return {
    ...row,
    expired: Boolean(expired),
    exhausted: Boolean(exhausted),
    available: !expired && !exhausted,
  };
}

export async function claimBetaInvite({ token, phone }) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) throw new Error("A WhatsApp phone number is required.");

  if (String(token || "").trim() === PUBLIC_BETA_TOKEN) {
    return {
      success: true,
      alreadyClaimed: false,
      invite: {
        id: null,
        inviter_name: "Fetch",
        public: true,
      },
    };
  }

  const invite = await getBetaInvite(token);
  if (!invite) return { success: false, reason: "invalid_invite" };
  if (invite.expired) return { success: false, reason: "expired_invite" };

  if (invite.claimed_phone) {
    if (normalizePhone(invite.claimed_phone) !== normalizedPhone) {
      return { success: false, reason: "invite_already_used" };
    }

    return { success: true, alreadyClaimed: true, invite };
  }

  if (!invite.available) return { success: false, reason: "invite_already_used" };

  const tokenHash = hashInviteToken(token);
  const updated = await supabaseRequest(
    `fetch_beta_invites?token_hash=eq.${encodeURIComponent(tokenHash)}&use_count=eq.${encodeURIComponent(String(invite.use_count || 0))}&claimed_phone=is.null`,
    {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        use_count: Number(invite.use_count || 0) + 1,
        claimed_at: new Date().toISOString(),
        claimed_phone: normalizedPhone,
      }),
    }
  );

  if (!Array.isArray(updated) || !updated.length) {
    const retry = await getBetaInvite(token);
    if (
      retry &&
      normalizePhone(retry.claimed_phone) === normalizedPhone
    ) {
      return { success: true, alreadyClaimed: true, invite: retry };
    }
    return { success: false, reason: "invite_already_used" };
  }

  return { success: true, alreadyClaimed: false, invite: updated[0] };
}

export async function activateCustomerBeta({
  phone,
  inviteId = null,
}) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return null;

  const rows = await supabaseRequest(
    `customers?phone=eq.${encodeURIComponent(normalizedPhone)}&select=id,name,beta_access,beta_invite_id,beta_activated_at&limit=1`
  );

  if (!Array.isArray(rows) || !rows.length) return null;

  const customer = rows[0];

  if (!customer.beta_access || (inviteId && !customer.beta_invite_id)) {
    const updated = await supabaseRequest(
      `customers?id=eq.${encodeURIComponent(customer.id)}`,
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          beta_access: true,
          beta_invite_id: inviteId || customer.beta_invite_id || null,
          beta_activated_at: customer.beta_activated_at || new Date().toISOString(),
        }),
      }
    );

    return Array.isArray(updated) && updated.length ? updated[0] : customer;
  }

  return customer;
}
