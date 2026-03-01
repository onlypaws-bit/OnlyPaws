import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function env(...keys: string[]) {
  for (const k of keys) {
    const v = Deno.env.get(k);
    if (v && v.trim().length) return v.trim();
  }
  return "";
}

function parseOrigins(s: string) {
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

function corsHeadersFor(req: Request) {
  const allow = parseOrigins(env("ADMIN_ORIGINS"));
  const origin = (req.headers.get("Origin") ?? "").trim();

  let allowOrigin = "null";
  if (!origin) {
    allowOrigin = "null";
  } else if (allow.includes(origin)) {
    allowOrigin = origin;
  } else {
    allowOrigin = "null";
  }

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type, x-admin-secret",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(req: Request, status: number, data: unknown) {
  const cors = corsHeadersFor(req);
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

const isUUID = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(s);

type Body = {
  user_id?: string;
  connect_id?: string;
  confirm?: boolean;
};

type Money = { amount: number; currency: string };

function sumMoneyByCurrency(arr: Money[] = []) {
  const out: Record<string, number> = {};
  for (const x of arr) {
    const c = String(x?.currency ?? "unknown").toLowerCase();
    const a = Number(x?.amount ?? 0);
    out[c] = (out[c] ?? 0) + a;
  }
  return out;
}

function allZero(obj: Record<string, number>) {
  return Object.values(obj).every((v) => (Number(v) || 0) === 0);
}

type TombSnapshot = {
  profile?: unknown;
  meta?: Record<string, unknown>;
  [k: string]: unknown;
};

// ----------------------
// Stripe REST helper
// ----------------------
const STRIPE_API = "https://api.stripe.com/v1";

async function stripeRequest(
  secretKey: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  params?: Record<string, string | number | boolean | undefined | null>,
  stripeAccount?: string,
) {
  const url = new URL(STRIPE_API + path);

  const headers: Record<string, string> = {
    "Authorization": `Bearer ${secretKey}`,
  };
  if (stripeAccount) headers["Stripe-Account"] = stripeAccount;

  let body: string | undefined;

  if (method === "GET") {
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null) continue;
        url.searchParams.set(k, String(v));
      }
    }
  } else {
    // Stripe expects application/x-www-form-urlencoded for POST (and also ok for DELETE usually with no body)
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (params) {
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null) continue;
        form.set(k, String(v));
      }
      body = form.toString();
    }
  }

  const res = await fetch(url.toString(), {
    method,
    headers,
    body: body,
  });

  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!res.ok) {
    const msg = data?.error?.message ?? data?.message ?? text ?? "Stripe error";
    const type = data?.error?.type ?? "stripe_error";
    const code = data?.error?.code ?? undefined;
    const status = res.status;
    const err = new Error(msg) as any;
    err.status = status;
    err.type = type;
    err.code = code;
    err.raw = data;
    throw err;
  }

  return data;
}

async function listAllPayouts(
  secretKey: string,
  stripeAccount: string,
) {
  const all: any[] = [];
  let starting_after: string | undefined = undefined;

  while (true) {
    const page = await stripeRequest(
      secretKey,
      "GET",
      "/payouts",
      { limit: 100, ...(starting_after ? { starting_after } : {}) },
      stripeAccount,
    );

    const data = (page?.data ?? []) as any[];
    all.push(...data);

    if (!page?.has_more) break;
    const last = data?.[data.length - 1]?.id;
    if (!last) break;
    starting_after = last;
  }

  return all;
}

serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    const cors = corsHeadersFor(req);
    return new Response("ok", {
      status: 200,
      headers: { ...cors, "Content-Type": "text/plain" },
    });
  }

  // Optional hardening: block unknown browser origins early
  const origin = (req.headers.get("Origin") ?? "").trim();
  if (origin) {
    const allow = parseOrigins(env("ADMIN_ORIGINS"));
    if (!allow.includes(origin)) {
      return json(req, 403, { error: "CORS: Origin not allowed", origin });
    }
  }

  if (req.method !== "POST") return json(req, 405, { error: "Method not allowed" });

  try {
    const SUPABASE_URL = env("SUPABASE_URL");
    const SERVICE_ROLE = env("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_ROLE_KEY");
    const STRIPE_SECRET_KEY = env("STRIPE_SECRET_KEY");
    const ADMIN_SECRET = env("ADMIN_SECRET", "OP_ADMIN_SECRET");

    if (!SUPABASE_URL || !SERVICE_ROLE) {
      return json(req, 500, { error: "Missing Supabase env (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY)" });
    }
    if (!STRIPE_SECRET_KEY) return json(req, 500, { error: "Missing STRIPE_SECRET_KEY" });
    if (!ADMIN_SECRET) return json(req, 500, { error: "Missing ADMIN_SECRET/OP_ADMIN_SECRET env" });

    // admin auth
    const provided = (req.headers.get("x-admin-secret") ?? "").trim();
    if (!provided || provided !== ADMIN_SECRET) {
      return json(req, 401, { error: "Unauthorized (missing/invalid x-admin-secret)" });
    }

    let body: Body | null = null;
    try { body = await req.json(); } catch { body = null; }
    if (body?.confirm !== true) return json(req, 400, { error: "Missing confirm=true" });

    const userId = (body?.user_id ?? "").trim();
    let connectId = (body?.connect_id ?? "").trim();

    if (userId && !isUUID(userId)) return json(req, 400, { error: "Invalid user_id (uuid)" });

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    // resolve connectId from deleted_profiles if needed
    let deletedRow: any = null;

    if (!connectId) {
      if (!userId) return json(req, 400, { error: "Provide user_id or connect_id" });

      const { data, error } = await admin
        .from("deleted_profiles")
        .select("user_id, stripe_connect_account_id, snapshot")
        .eq("user_id", userId)
        .maybeSingle();

      if (error) return json(req, 500, { error: error.message });
      if (!data) return json(req, 404, { error: "deleted_profiles row not found for user_id" });

      deletedRow = data;
      connectId = String(data.stripe_connect_account_id ?? "").trim();
      if (!connectId) return json(req, 400, { error: "No stripe_connect_account_id in deleted_profiles" });
    } else if (!userId) {
      const { data } = await admin
        .from("deleted_profiles")
        .select("user_id, stripe_connect_account_id, snapshot")
        .eq("stripe_connect_account_id", connectId)
        .maybeSingle();
      if (data) deletedRow = data;
    }

    if (!connectId.startsWith("acct_")) {
      return json(req, 400, { error: "Invalid connect_id (must start with acct_)" });
    }

    // 1) Balance check
    const bal = await stripeRequest(
      STRIPE_SECRET_KEY,
      "GET",
      "/balance",
      undefined,
      connectId,
    );

    const availableByCcy = sumMoneyByCurrency((bal.available ?? []) as any);
    const pendingByCcy = sumMoneyByCurrency((bal.pending ?? []) as any);

    // 2) Payouts check (paginate)
    const payoutsAll = await listAllPayouts(STRIPE_SECRET_KEY, connectId);
    const blockingPayouts = payoutsAll.filter((p: any) =>
      (p?.status === "pending" || p?.status === "in_transit") &&
      (p?.amount ?? 0) !== 0
    );

    const okToClose =
      allZero(availableByCcy) &&
      allZero(pendingByCcy) &&
      blockingPayouts.length === 0;

    if (!okToClose) {
      return json(req, 409, {
        ok: false,
        error: "Stripe account not closable yet (balance/payouts not settled).",
        connect_id: connectId,
        balance: {
          available: bal.available,
          pending: bal.pending,
          available_by_currency: availableByCcy,
          pending_by_currency: pendingByCcy,
        },
        blocking_payouts: blockingPayouts.map((p: any) => ({
          id: p.id,
          status: p.status,
          amount: p.amount,
          currency: p.currency,
          arrival_date: p.arrival_date,
          created: p.created,
        })),
      });
    }

    // 3) Delete account
    let del: any = null;
    try {
      del = await stripeRequest(
        STRIPE_SECRET_KEY,
        "DELETE",
        `/accounts/${encodeURIComponent(connectId)}`,
        undefined,
        undefined, // IMPORTANT: deleting the connected account is done on platform, no Stripe-Account header
      );
    } catch (e: any) {
      return json(req, 409, {
        ok: false,
        error: "Stripe refused to delete the account.",
        connect_id: connectId,
        stripe_error: e?.message ?? String(e),
        stripe_status: e?.status,
        stripe_type: e?.type,
        stripe_code: e?.code,
        stripe_raw: e?.raw,
      });
    }

    // 4) Update tombstone snapshot (best-effort)
    const nowIso = new Date().toISOString();
    const targetUserId = (userId || String(deletedRow?.user_id ?? "").trim()) || "";

    if (targetUserId) {
      try {
        if (!deletedRow) {
          const { data } = await admin
            .from("deleted_profiles")
            .select("user_id, snapshot")
            .eq("user_id", targetUserId)
            .maybeSingle();
          deletedRow = data ?? null;
        }

        const existingSnap = (deletedRow?.snapshot ?? {}) as TombSnapshot;
        const normalized: TombSnapshot =
          typeof existingSnap === "object" && existingSnap !== null ? existingSnap : {};

        const nextSnap: TombSnapshot = {
          ...normalized,
          meta: {
            ...(normalized.meta ?? {}),
            stripe_connect_closed_at: nowIso,
            stripe_connect_deleted: true,
            stripe_connect_close_result: del,
          },
        };

        await admin
          .from("deleted_profiles")
          .update({ snapshot: nextSnap })
          .eq("user_id", targetUserId);
      } catch {
        // ignore
      }
    }

    return json(req, 200, {
      ok: true,
      connect_id: connectId,
      stripe_account_deleted: true,
      stripe_delete_result: del,
      tombstone_updated: !!targetUserId,
    });
  } catch (e: any) {
    return json(req, 500, { error: e?.message ?? String(e) });
  }
});
