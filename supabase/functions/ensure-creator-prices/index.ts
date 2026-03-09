// supabase/functions/ensure-creator-prices/index.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

function toForm(params: Record<string, string>) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) body.append(k, v);
  return body;
}

async function stripePost(
  path: string,
  secret: string,
  params: Record<string, string>,
  idemKey?: string,
  stripeAccount?: string | null
) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/x-www-form-urlencoded",
      ...(idemKey ? { "Idempotency-Key": idemKey } : {}),
      ...(stripeAccount ? { "Stripe-Account": stripeAccount } : {}),
    },
    body: toForm(params),
  });

  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Stripe error on ${path}: ${JSON.stringify(j)}`);
  return j;
}

async function stripeGet(path: string, secret: string, stripeAccount?: string | null) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${secret}`,
      ...(stripeAccount ? { "Stripe-Account": stripeAccount } : {}),
    },
  });

  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Stripe error on GET ${path}: ${JSON.stringify(j)}`);
  return j;
}

function normalizeCurrency(v: unknown) {
  const c = String(v ?? "eur").trim().toLowerCase();
  if (!/^[a-z]{3}$/.test(c)) return "eur";
  return c;
}

function assertPriceCents(v: unknown) {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error("Invalid price_cents on plan");
  }
  // opzionale: Stripe min varies by currency; keep it simple:
  if (n < 50) throw new Error("price_cents too low");
  return n;
}

type Body = { creator_id: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const STRIPE_SECRET =
      Deno.env.get("STRIPE_SECRET_KEY") || Deno.env.get("OP_STRIPE_SECRET_KEY");

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");

    if (!STRIPE_SECRET || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_ANON_KEY) {
      return json(500, { error: "Missing env vars" });
    }

    // If called from browser, only allow the creator itself.
    // If called server-to-server with service role, authedUserId will be null and we allow it.
    const authHeader = req.headers.get("Authorization") ?? "";
    const supaUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData } = await supaUser.auth.getUser();
    const authedUserId = userData?.user?.id ?? null;

    const { creator_id } = (await req.json().catch(() => ({}))) as Body;
    if (!creator_id) return json(400, { error: "Missing creator_id" });

    if (authedUserId && authedUserId !== creator_id) {
      return json(403, { error: "Not allowed" });
    }

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // connect id required (prices live on connected for DIRECT flow)
    const { data: creatorProf, error: creatorProfErr } = await admin
      .from("profiles")
      .select("user_id, stripe_connect_account_id, username, display_name")
      .eq("user_id", creator_id)
      .maybeSingle();

    if (creatorProfErr) throw creatorProfErr;

    const connectId = (creatorProf as any)?.stripe_connect_account_id as string | null;
    if (!connectId) {
      return json(409, { error: "CREATOR_NOT_READY", reason: "missing_stripe_connect_account_id" });
    }

    // Load ALL active plans (monthly + yearly)
    const { data: plans, error: plansErr } = await admin
      .from("creator_plans")
      .select(
        "id, creator_id, name, description, price_cents, currency, billing_period, is_active, stripe_price_id, stripe_product_id"
      )
      .eq("creator_id", creator_id)
      .eq("is_active", true)
      .in("billing_period", ["monthly", "yearly"]);

    if (plansErr) throw plansErr;
    if (!plans || plans.length === 0) {
      return json(400, { error: "No active creator plans found" });
    }

    // pick existing product if any
    let stripeProductId = plans.find((p) => p.stripe_product_id)?.stripe_product_id ?? null;

    // create product (one per creator) on CONNECTED
    if (!stripeProductId) {
      const pretty =
        (creatorProf as any)?.display_name ||
        (creatorProf as any)?.username ||
        `creator ${creator_id.slice(0, 8)}`;

      const product = await stripePost(
        "products",
        STRIPE_SECRET,
        {
          name: `OnlyPaws Membership • ${pretty}`,
          description: "Creator memberships on OnlyPaws (digital subscriptions, pet-only, safe-for-work).",
          "metadata[creator_id]": creator_id,
          "metadata[platform]": "OnlyPaws",
          "metadata[content_category]": "pet_sfw",
        },
        `op_${connectId}_prod_${creator_id}`,
        connectId
      );

      stripeProductId = product.id;

      // save product id on active plans that are missing it
      await admin
        .from("creator_plans")
        .update({ stripe_product_id: stripeProductId })
        .eq("creator_id", creator_id)
        .eq("is_active", true)
        .is("stripe_product_id", null);
    }

    // create OR fix prices per plan (monthly + yearly)
    const created: Array<{
      plan_id: string;
      price_id: string;
      price_cents: number;
      billing_period: string;
      replaced?: boolean;
    }> = [];

    for (const p of plans) {
      const priceCents = assertPriceCents(p.price_cents);
      const currency = normalizeCurrency(p.currency);
      const interval = p.billing_period === "yearly" ? "year" : "month";
      const nickname = p.name || `${priceCents / 100} ${currency.toUpperCase()}/${p.billing_period}`;

      let needsNew = !p.stripe_price_id;

      // If a price exists, verify it matches the plan (amount/currency/interval)
      if (p.stripe_price_id) {
        try {
          const sp = await stripeGet(
            `prices/${encodeURIComponent(p.stripe_price_id)}`,
            STRIPE_SECRET,
            connectId
          );

          const okAmount = Number(sp?.unit_amount) === Number(priceCents);
          const okCurrency = String(sp?.currency || "").toLowerCase() === currency;

          const okRecurring =
            sp?.type === "recurring" &&
            String(sp?.recurring?.interval || "").toLowerCase() === interval &&
            Number(sp?.recurring?.interval_count || 1) === 1;

          if (!(okAmount && okCurrency && okRecurring)) {
            needsNew = true;
          }
        } catch {
          // price missing/deleted/inaccessible => recreate
          needsNew = true;
        }
      }

      if (!needsNew) continue;

      const price = await stripePost(
        "prices",
        STRIPE_SECRET,
        {
          unit_amount: String(priceCents),
          currency,
          product: stripeProductId!,
          "recurring[interval]": interval,
          nickname,
          "metadata[creator_id]": creator_id,
          "metadata[plan_id]": p.id,
          "metadata[price_cents]": String(priceCents),
          "metadata[billing_period]": String(p.billing_period),
          "metadata[platform]": "OnlyPaws",
          "metadata[content_category]": "pet_sfw",
        },
        // idempotency key should change when amount/interval/currency changes
        `op_${connectId}_price_${creator_id}_${p.id}_${priceCents}_${interval}_${currency}`,
        connectId
      );

      await admin
        .from("creator_plans")
        .update({ stripe_price_id: price.id, stripe_product_id: stripeProductId })
        .eq("id", p.id);

      created.push({
        plan_id: p.id,
        price_id: price.id,
        price_cents: priceCents,
        billing_period: p.billing_period,
        replaced: !!p.stripe_price_id,
      });
    }

    const { data: finalPlans } = await admin
      .from("creator_plans")
      .select("id, price_cents, billing_period, stripe_product_id, stripe_price_id, is_active")
      .eq("creator_id", creator_id)
      .eq("is_active", true);

    return json(200, {
      ok: true,
      creator_id,
      stripe_connect_account_id: connectId,
      stripe_product_id: stripeProductId,
      created_prices: created,
      plans: finalPlans ?? [],
    });
  } catch (e) {
    console.error(e);
    return json(500, { error: String((e as any)?.message ?? e) });
  }
});