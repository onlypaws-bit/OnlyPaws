// supabase/functions/close-stripe-connected-account/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-admin-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, data: unknown) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function env(...keys: string[]) {
  for (const k of keys) {
    const v = Deno.env.get(k);
    if (v && v.trim().length) return v.trim();
  }
  return "";
}

type Body = {
  user_id?: string;     // uuid
  connect_id?: string;  // acct_...
  confirm?: boolean;    // must be true
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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const SUPABASE_URL = env("SUPABASE_URL");
    const SERVICE_ROLE = env("SUPABASE_SERVICE_ROLE_KEY");
    const STRIPE_SECRET_KEY = env("STRIPE_SECRET_KEY");
    const ADMIN_SECRET = env("ADMIN_SECRET", "OP_ADMIN_SECRET");

    if (!SUPABASE_URL || !SERVICE_ROLE) {
      return json(500, { error: "Missing Supabase env (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY)" });
    }
    if (!STRIPE_SECRET_KEY) {
      return json(500, { error: "Missing STRIPE_SECRET_KEY" });
    }
    if (!ADMIN_SECRET) {
      return json(500, { error: "Missing ADMIN_SECRET/OP_ADMIN_SECRET env" });
    }

    // ---- admin auth: shared secret header
    const provided = (req.headers.get("x-admin-secret") ?? "").trim();
    if (!provided || provided !== ADMIN_SECRET) {
      return json(401, { error: "Unauthorized (missing/invalid x-admin-secret)" });
    }

    let body: Body | null = null;
    try {
      body = await req.json();
    } catch {
      body = null;
    }

    if (body?.confirm !== true) return json(400, { error: "Missing confirm=true" });

    const userId = (body?.user_id ?? "").trim();
    let connectId = (body?.connect_id ?? "").trim();

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
    const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });

    // ---- if connect_id not provided, fetch from deleted_profiles by user_id
    let deletedRow: any = null;

    if (!connectId) {
      if (!userId) return json(400, { error: "Provide user_id or connect_id" });

      const { data, error } = await admin
        .from("deleted_profiles")
        .select("user_id, stripe_connect_account_id, snapshot")
        .eq("user_id", userId)
        .maybeSingle();

      if (error) return json(500, { error: error.message });
      if (!data) return json(404, { error: "deleted_profiles row not found for user_id" });

      deletedRow = data;
      connectId = String(data.stripe_connect_account_id ?? "").trim();
      if (!connectId) return json(400, { error: "No stripe_connect_account_id in deleted_profiles" });
    }

    // ---- 1) Balance check (available + pending must be 0 for ALL currencies)
    const bal = await stripe.balance.retrieve({ stripeAccount: connectId });

    const availableByCcy = sumMoneyByCurrency((bal.available ?? []) as any);
    const pendingByCcy = sumMoneyByCurrency((bal.pending ?? []) as any);

    // ---- 2) Payouts check: no payouts pending/in_transit
    // Use higher limit to reduce false-ok cases.
    const payouts = await stripe.payouts.list(
      { limit: 100 },
      { stripeAccount: connectId },
    );

    const blockingPayouts = (payouts.data ?? []).filter((p: any) =>
      (p?.status === "pending" || p?.status === "in_transit") && (p?.amount ?? 0) !== 0
    );

    const okToClose =
      allZero(availableByCcy) &&
      allZero(pendingByCcy) &&
      blockingPayouts.length === 0;

    if (!okToClose) {
      return json(409, {
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
        note:
          "Close only when ALL available/pending amounts are 0 (per currency) and there are no payouts pending/in_transit.",
      });
    }

    // ---- 3) Delete connected account
    let del: any = null;
    try {
      del = await stripe.accounts.del(connectId);
    } catch (e: any) {
      // Stripe can refuse closure even if our checks pass (rare edge cases).
      return json(409, {
        ok: false,
        error: "Stripe refused to delete the account.",
        connect_id: connectId,
        stripe_error: e?.message ?? String(e),
        note:
          "This can happen due to disputes/negative balances/other restrictions. Check Stripe dashboard for the connected account.",
      });
    }

    // ---- 4) Update deleted_profiles snapshot with closure info (best-effort)
    if (userId) {
      const nowIso = new Date().toISOString();

      try {
        // fetch current snapshot if not already
        if (!deletedRow) {
          const { data } = await admin
            .from("deleted_profiles")
            .select("user_id, snapshot")
            .eq("user_id", userId)
            .maybeSingle();
          deletedRow = data ?? null;
        }

        const snapshot = (deletedRow?.snapshot ?? {}) as Record<string, unknown>;
        const mergedSnapshot = {
          ...snapshot,
          stripe_connect_closed_at: nowIso,
          stripe_connect_close_result: del,
        };

        await admin
          .from("deleted_profiles")
          .update({ snapshot: mergedSnapshot })
          .eq("user_id", userId);
      } catch {
        // do not fail the whole request if DB update fails
      }
    }

    return json(200, {
      ok: true,
      connect_id: connectId,
      stripe_account_deleted: true,
      stripe_delete_result: del,
    });
  } catch (e: any) {
    return json(500, { error: e?.message ?? String(e) });
  }
});