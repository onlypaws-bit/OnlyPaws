// supabase/functions/backfill-wallet/index.ts
// PATCHED: best-effort enrichment to recover fan_id + creator_plan_id from Stripe balance transactions
// - Looks up Charge -> Invoice -> Subscription -> Price
// - Maps Stripe customer -> fan_id using fan_customer_map
// - Maps Stripe price -> creator_plan_id using creator_plans
// - Upserts creator_subscriptions.creator_plan_id when found

import Stripe from "https://esm.sh/stripe@14.21.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, data: unknown) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

type Body = {
  limit?: number; // max balance txns da leggere (default 100)
  days?: number; // lookback giorni (default 365)
  enrich?: boolean; // default true: prova a ricostruire fan/plan
};

function clampInt(n: unknown, def: number, min: number, max: number) {
  const x = Number(n);
  if (!Number.isFinite(x)) return def;
  const i = Math.trunc(x);
  return Math.max(min, Math.min(max, i));
}

async function listBalanceTransactions(params: {
  stripe: Stripe;
  stripeAccount: string;
  limitTotal: number;
  createdGteUnix: number;
}) {
  const out: Stripe.BalanceTransaction[] = [];
  let startingAfter: string | undefined = undefined;

  while (out.length < params.limitTotal) {
    const pageLimit = Math.min(100, params.limitTotal - out.length);
    const page = await params.stripe.balanceTransactions.list(
      {
        limit: pageLimit,
        starting_after: startingAfter,
        created: { gte: params.createdGteUnix },
      },
      { stripeAccount: params.stripeAccount }
    );

    out.push(...(page.data || []));
    if (!page.has_more || !page.data?.length) break;
    startingAfter = page.data[page.data.length - 1].id;
  }

  return out;
}

async function sumAllCreatorEarnings(admin: any, creatorId: string) {
  let from = 0;
  const step = 1000;
  let total = 0;

  while (true) {
    const to = from + step - 1;
    const { data, error } = await admin
      .from("wallet_transactions")
      .select("amount_cents,type,status")
      .eq("creator_id", creatorId)
      .eq("status", "paid")
      .range(from, to);

    if (error) throw error;

    const rows = data || [];
    for (const r of rows) {
      if (String(r.type || "") === "payout") continue;
      total += Number(r.amount_cents || 0);
    }

    if (rows.length < step) break;
    from += step;
  }

  return total;
}

function safeStr(x: unknown) {
  return typeof x === "string" ? x : "";
}

async function getFanIdFromCustomer(params: {
  admin: any;
  creatorId: string;
  stripeCustomerId: string;
  cache: Map<string, string | null>;
}) {
  const key = params.stripeCustomerId;
  if (params.cache.has(key)) return params.cache.get(key) ?? null;

  // fan_customer_map is assumed: (creator_id, fan_id, stripe_customer_id)
  const { data, error } = await params.admin
    .from("fan_customer_map")
    .select("fan_id")
    .eq("creator_id", params.creatorId)
    .eq("stripe_customer_id", params.stripeCustomerId)
    .maybeSingle();

  if (error) {
    // don't hard-fail enrichment for missing table/rls; just treat as unknown
    params.cache.set(key, null);
    return null;
  }

  const fanId = data?.fan_id ? String(data.fan_id) : null;
  params.cache.set(key, fanId);
  return fanId;
}

async function getPlanIdFromPrice(params: {
  admin: any;
  creatorId: string;
  stripePriceId: string;
  cache: Map<string, string | null>;
}) {
  const key = params.stripePriceId;
  if (params.cache.has(key)) return params.cache.get(key) ?? null;

  const { data, error } = await params.admin
    .from("creator_plans")
    .select("id")
    .eq("creator_id", params.creatorId)
    .eq("stripe_price_id", params.stripePriceId)
    .limit(1);

  if (error) {
    params.cache.set(key, null);
    return null;
  }

  const planId = Array.isArray(data) && data[0]?.id ? String(data[0].id) : null;
  params.cache.set(key, planId);
  return planId;
}

async function upsertCreatorSubscriptionPlan(params: {
  admin: any;
  creatorId: string;
  fanId: string;
  creatorPlanId: string;
}) {
  // Best-effort: update existing row or create if your schema allows it.
  // Requires creator_subscriptions to have unique (creator_id, fan_id) or similar.
  const { error } = await params.admin
    .from("creator_subscriptions")
    .upsert(
      {
        creator_id: params.creatorId,
        fan_id: params.fanId,
        creator_plan_id: params.creatorPlanId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "creator_id,fan_id" }
    );

  // If there's no such constraint, we don't want to kill backfill; log and continue.
  if (error) console.warn("upsertCreatorSubscriptionPlan error:", error);
}

async function enrichFromBalanceTxn(params: {
  stripe: Stripe;
  stripeAccount: string;
  admin: any;
  creatorId: string;
  bt: Stripe.BalanceTransaction;
  fanCache: Map<string, string | null>;
  planCache: Map<string, string | null>;
}) {
  const source = (params.bt as any)?.source;
  const sourceId = typeof source === "string" ? source : safeStr(source?.id);
  if (!sourceId) return { fan_id: null as string | null, creator_plan_id: null as string | null };

  // Usually net>0 balance txns for subscriptions are linked to a Charge.
  // Try Charge -> Invoice -> Subscription -> Price.
  try {
    const charge = await params.stripe.charges.retrieve(
      sourceId,
      { expand: ["invoice", "invoice.lines.data.price", "invoice.subscription"] },
      { stripeAccount: params.stripeAccount }
    );

    const customerId = safeStr((charge as any)?.customer);
    const invoiceObj = (charge as any)?.invoice;

    let stripeCustomerId = customerId;
    let stripePriceId = "";

    if (invoiceObj && typeof invoiceObj === "object") {
      stripeCustomerId = stripeCustomerId || safeStr(invoiceObj.customer);

      // price from invoice line (most reliable)
      const line0 = invoiceObj?.lines?.data?.[0];
      stripePriceId = safeStr(line0?.price?.id);

      // fallback: subscription items
      if (!stripePriceId) {
        const subObj = invoiceObj?.subscription;
        if (subObj && typeof subObj === "object") {
          stripePriceId = safeStr(subObj?.items?.data?.[0]?.price?.id);
        }
      }
    }

    const fan_id = stripeCustomerId
      ? await getFanIdFromCustomer({
          admin: params.admin,
          creatorId: params.creatorId,
          stripeCustomerId,
          cache: params.fanCache,
        })
      : null;

    const creator_plan_id = stripePriceId
      ? await getPlanIdFromPrice({
          admin: params.admin,
          creatorId: params.creatorId,
          stripePriceId,
          cache: params.planCache,
        })
      : null;

    if (fan_id && creator_plan_id) {
      await upsertCreatorSubscriptionPlan({
        admin: params.admin,
        creatorId: params.creatorId,
        fanId: fan_id,
        creatorPlanId: creator_plan_id,
      });
    }

    return { fan_id, creator_plan_id };
  } catch (_e) {
    // Not a charge / not retrievable / missing permissions
    return { fan_id: null as string | null, creator_plan_id: null as string | null };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const STRIPE_SECRET_KEY =
      Deno.env.get("STRIPE_SECRET_KEY") || Deno.env.get("OP_STRIPE_SECRET_KEY");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");

    if (!STRIPE_SECRET_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_ANON_KEY) {
      return json(500, { error: "Missing env vars" });
    }

    const body = (await req.json().catch(() => ({}))) as Body;
    const limitTotal = clampInt(body?.limit, 100, 1, 500);
    const days = clampInt(body?.days, 365, 1, 3650);
    const enrich = body?.enrich !== false;

    // Auth user
    const authHeader = req.headers.get("Authorization") ?? "";
    const supaUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData, error: userErr } = await supaUser.auth.getUser();
    if (userErr || !userData?.user) return json(401, { error: "Not authenticated" });

    const creatorId = userData.user.id;

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    // Get connect id
    const { data: prof, error: pe } = await admin
      .from("profiles")
      .select("stripe_connect_account_id")
      .eq("user_id", creatorId)
      .single();

    if (pe || !prof?.stripe_connect_account_id) {
      return json(400, { error: "Missing stripe_connect_account_id" });
    }

    const connectId = prof.stripe_connect_account_id as string;

    const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });

    const createdGteUnix = Math.floor((Date.now() - days * 24 * 60 * 60 * 1000) / 1000);

    // 1) list stripe balance txns on CONNECTED
    const btx = await listBalanceTransactions({
      stripe,
      stripeAccount: connectId,
      limitTotal,
      createdGteUnix,
    });

    // 2) keep only positive NET eur earnings
    const earnings = (btx || []).filter((t) => {
      const cur = String(t.currency || "").toLowerCase();
      const net = Number(t.net || 0);
      return cur === "eur" && net > 0;
    });

    if (earnings.length === 0) {
      const total = await sumAllCreatorEarnings(admin, creatorId);

      await admin
        .from("wallets")
        .upsert(
          {
            profile_id: creatorId,
            currency: "EUR",
            lifetime_earned_cents: total,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "profile_id" }
        );

      return json(200, {
        ok: true,
        creator_id: creatorId,
        stripe_connect_account_id: connectId,
        scanned: btx.length,
        eligible: 0,
        inserted: 0,
        lifetime_earned_cents: total,
        note: "No eligible Stripe balance transactions found (net>0, eur).",
      });
    }

    // 3) idempotency: check what we already inserted
    const backfillEventIds = earnings.map((t) => `backfill_${t.id}`);

    const { data: existing, error: exErr } = await admin
      .from("wallet_transactions")
      .select("stripe_event_id")
      .in("stripe_event_id", backfillEventIds);

    if (exErr) throw exErr;

    const existingSet = new Set((existing || []).map((r: any) => r.stripe_event_id).filter(Boolean));

    const fanCache = new Map<string, string | null>();
    const planCache = new Map<string, string | null>();

    let enrichedCount = 0;
    let enrichedWithPlanCount = 0;

    const toInsert: any[] = [];

    for (const t of earnings) {
      const stripe_event_id = `backfill_${t.id}`;
      if (existingSet.has(stripe_event_id)) continue;

      let fan_id: string | null = null;
      let creator_plan_id: string | null = null;

      if (enrich) {
        const enr = await enrichFromBalanceTxn({
          stripe,
          stripeAccount: connectId,
          admin,
          creatorId,
          bt: t,
          fanCache,
          planCache,
        });

        fan_id = enr.fan_id;
        creator_plan_id = enr.creator_plan_id;

        if (fan_id) enrichedCount++;
        if (fan_id && creator_plan_id) enrichedWithPlanCount++;
      }

      toInsert.push({
        creator_id: creatorId,
        fan_id, // ✅ proviamo a ricostruirlo
        type: "subscription", // fallback
        amount_cents: Number(t.net || 0),
        currency: "EUR",
        status: "paid",
        stripe_event_id,
        stripe_object_id: t.id, // balance_transaction id
        // NOTE: non scriviamo creator_plan_id qui perché non sappiamo la tua schema wallet_transactions.
        // Il nome piano nel Creator Dash viene da creator_subscriptions.creator_plan_id.
      });
    }

    if (toInsert.length) {
      const ins = await admin.from("wallet_transactions").insert(toInsert);
      if (ins.error) throw ins.error;
    }

    // 4) recompute wallet lifetime earned from DB
    const total = await sumAllCreatorEarnings(admin, creatorId);

    const up = await admin
      .from("wallets")
      .upsert(
        {
          profile_id: creatorId,
          currency: "EUR",
          lifetime_earned_cents: total,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "profile_id" }
      );

    if (up.error) throw up.error;

    return json(200, {
      ok: true,
      creator_id: creatorId,
      stripe_connect_account_id: connectId,
      scanned: btx.length,
      eligible: earnings.length,
      inserted: toInsert.length,
      lifetime_earned_cents: total,
      enrich,
      enriched_fan_ids: enrichedCount,
      enriched_with_plan: enrichedWithPlanCount,
      note:
        enrich
          ? "Enrichment is best-effort: requires Charge->Invoice and fan_customer_map mapping."
          : "Enrichment disabled.",
    });
  } catch (e) {
    console.error(e);
    return json(500, { error: "Server error", details: String((e as any)?.message ?? e) });
  }
});
