// Fetch Admin Control Tower API
// Save as: api/admin/dashboard.mjs
//
// Required Vercel environment variables:
// - VITE_SUPABASE_URL
// - VITE_SUPABASE_PUBLISHABLE_KEY
// - SUPABASE_SECRET_KEY
// - ADMIN_EMAILS   (comma-separated admin emails; do not expose this value in frontend)
//
// This endpoint validates the Supabase access token, checks the admin allowlist,
// then reads private operational data with the server-side secret key.

const SUPABASE_URL =
  process.env.VITE_SUPABASE_URL ||
  process.env.SUPABASE_URL;

const SUPABASE_PUBLISHABLE_KEY =
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  process.env.SUPABASE_PUBLISHABLE_KEY;

const SUPABASE_SECRET_KEY =
  process.env.SUPABASE_SECRET_KEY;

const ADMIN_EMAILS = String(process.env.ADMIN_EMAILS || "")
  .split(",")
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);

function json(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function getBearerToken(req) {
  const header = String(req.headers.authorization || "");
  if (!header.toLowerCase().startsWith("bearer ")) return "";
  return header.slice(7).trim();
}

async function verifyAdmin(req) {
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY || !SUPABASE_SECRET_KEY) {
    throw new Error("Admin API environment variables are incomplete.");
  }

  if (!ADMIN_EMAILS.length) {
    throw new Error("ADMIN_EMAILS is not configured.");
  }

  const accessToken = getBearerToken(req);
  if (!accessToken) {
    const error = new Error("Authentication required.");
    error.status = 401;
    throw error;
  }

  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const error = new Error("Invalid or expired admin session.");
    error.status = 401;
    throw error;
  }

  const user = await response.json();
  const email = String(user?.email || "").trim().toLowerCase();

  if (!email || !ADMIN_EMAILS.includes(email)) {
    const error = new Error("You are not authorized to access the Fetch Control Tower.");
    error.status = 403;
    throw error;
  }

  return { user, email };
}

async function db(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status}: ${text}`);
  }

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

export default async function handler(req, res) {
  try {
    const { email } = await verifyAdmin(req);

    if (req.method === "GET") {
      const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
      const orderId = url.searchParams.get("orderId");

      if (orderId) {
        const encodedId = encodeURIComponent(orderId);

        const [orders, jobs, substitutions, messages] = await Promise.all([
          db(`orders?id=eq.${encodedId}&select=*&limit=1`),
          db(`shopper_jobs?order_id=eq.${encodedId}&select=*&order=offered_at.asc&limit=100`),
          db(`substitution_requests?order_id=eq.${encodedId}&select=*&order=created_at.asc&limit=100`),
          db(`messages?order_id=eq.${encodedId}&select=*&order=created_at.asc&limit=200`),
        ]);

        return json(res, 200, {
          ok: true,
          admin: email,
          order: Array.isArray(orders) ? orders[0] || null : null,
          jobs: Array.isArray(jobs) ? jobs : [],
          substitutions: Array.isArray(substitutions) ? substitutions : [],
          messages: Array.isArray(messages) ? messages : [],
        });
      }

      const [orders, shoppers, customers, pendingShoppers, substitutions] =
        await Promise.all([
          db("orders?select=*&order=created_at.desc&limit=200"),
          db("shoppers?select=*&order=name.asc&limit=100"),
          db("customers?select=*&order=created_at.desc&limit=200"),
          db("shoppers?approval_status=eq.pending&select=*&order=created_at.asc&limit=100"),
          db("substitution_requests?status=eq.pending&select=id&limit=100"),
        ]);

      return json(res, 200, {
        ok: true,
        admin: email,
        orders: Array.isArray(orders) ? orders : [],
        shoppers: Array.isArray(shoppers) ? shoppers : [],
        customers: Array.isArray(customers) ? customers : [],
        pendingShoppers: Array.isArray(pendingShoppers) ? pendingShoppers : [],
        pendingSubstitutions: Array.isArray(substitutions) ? substitutions.length : 0,
      });
    }

    if (req.method === "POST") {
      const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
      const action = url.searchParams.get("action");

      if (action !== "shopper-approval") {
        return json(res, 400, { ok: false, error: "Unsupported admin action." });
      }

      let body = {};
      try {
        body = typeof req.body === "object" && req.body
          ? req.body
          : JSON.parse(req.body || "{}");
      } catch {
        return json(res, 400, { ok: false, error: "Invalid JSON body." });
      }

      const shopperId = String(body.shopperId || "").trim();
      const decision = String(body.decision || "").trim().toLowerCase();

      if (!shopperId || !["approved", "rejected"].includes(decision)) {
        return json(res, 400, { ok: false, error: "Invalid shopper approval request." });
      }

      const update =
        decision === "approved"
          ? {
              approval_status: "approved",
              onboarding_step: "active",
              available: false,
            }
          : {
              approval_status: "rejected",
              onboarding_step: "inactive",
              available: false,
            };

      const updated = await db(
        `shoppers?id=eq.${encodeURIComponent(shopperId)}`,
        {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify(update),
        }
      );

      return json(res, 200, {
        ok: true,
        decision,
        shopper: Array.isArray(updated) ? updated[0] || null : updated,
      });
    }

    return json(res, 405, { ok: false, error: "Method not allowed." });
  } catch (error) {
    console.error("FETCH ADMIN API ERROR:", error);
    const status = Number(error?.status) || 500;
    return json(res, status, {
      ok: false,
      error: error?.message || "Admin API error.",
    });
  }
}
