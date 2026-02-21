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
      // ✅ create on connected account (DIRECT)
      ...(stripeAccount ? { "Stripe-Account": stripeAccount } : {}),
    },
    body: toForm(params),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`Stripe error on ${path}: ${JSON.stringify(j)}`);
  return j;
}

type Body = { creator_id: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const STRIPE_SECRET =
      Deno.env.get("STRIPE_SECRET_KEY") ||
      Deno.env.get("OP_STRIPE_SECRET_KEY"); // compat col tuo naming

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");

    if (!STRIPE_SECRET || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_ANON_KEY) {
      return json(500, { error: "Missing env vars" });
    }

    // Auth: consenti solo al creator stesso (per sicurezza).
    // (In pratica la chiameremo anche server-side da create-checkout-session col service role)
    const authHeader = req.headers.get("Authorization") ?? "";
    const supaUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData } = await supaUser.auth.getUser();
    const authedUserId = userData?.user?.id ?? null;

    const { creator_id } = (await req.json()) as Body;
    if (!creator_id) return json(400, { error: "Missing creator_id" });

    // Se c'è auth (dal browser), richiedi che sia il creator
    if (authedUserId && authedUserId !== creator_id) {
      return json(403, { error: "Not allowed" });
    }

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // ✅ 0) serve connect account id: i price DEVONO vivere sul connected per DIRECT checkout
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

    // 1) carica i 3 piani monthly/attivi del creator
    const { data: plans, error: plansErr } = await admin
      .from("creator_plans")
      .select(
        "id, creator_id, name, description, price_cents, currency, billing_period, is_active, stripe_price_id, stripe_product_id"
      )
      .eq("creator_id", creator_id)
      .eq("billing_period", "monthly")
      .eq("is_active", true)
      .in("price_cents", [300, 500, 800]);

    if (plansErr) throw plansErr;
    if (!plans || plans.length < 3) {
      return json(400, { error: "Missing one or more creator plans (need 300/500/800 monthly active)" });
    }

    // 2) prendi un product id già esistente se c'è
    let stripeProductId = plans.find((p) => p.stripe_product_id)?.stripe_product_id ?? null;

    // 3) se manca product, crealo (1 per creator) — SUL CONNECTED
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
          description: "Creator memberships on OnlyPaws",
          "metadata[creator_id]": creator_id,
        },
        // idempotency per connected (così non duplichi se retry)
        `op_${connectId}_prod_${creator_id}`,
        connectId
      );

      stripeProductId = product.id;

      // salva product id su TUTTI i piani (stesso product per creator)
      await admin
        .from("creator_plans")
        .update({ stripe_product_id: stripeProductId })
        .eq("creator_id", creator_id)
        .eq("billing_period", "monthly")
        .in("price_cents", [300, 500, 800]);
    }

    // 4) per ogni piano senza stripe_price_id → crea price monthly — SUL CONNECTED
    const created: Array<{ plan_id: string; price_id: string; price_cents: number }> = [];

    for (const p of plans) {
      if (p.stripe_price_id) continue;

      const currency = (p.currency || "eur").toLowerCase();
      const nickname = p.name || `${p.price_cents / 100}€/month`;

      const price = await stripePost(
        "prices",
        STRIPE_SECRET,
        {
          unit_amount: String(p.price_cents),
          currency,
          product: stripeProductId!,
          "recurring[interval]": "month",
          nickname,
          "metadata[creator_id]": creator_id,
          "metadata[plan_id]": p.id,
          "metadata[price_cents]": String(p.price_cents),
        },
        // idempotency per plan sul connected
        `op_${connectId}_price_${creator_id}_${p.id}`,
        connectId
      );

      await admin
        .from("creator_plans")
        .update({ stripe_price_id: price.id, stripe_product_id: stripeProductId })
        .eq("id", p.id);

      created.push({ plan_id: p.id, price_id: price.id, price_cents: p.price_cents });
    }

    // 5) ritorna stato
    const { data: finalPlans } = await admin
      .from("creator_plans")
      .select("id, price_cents, stripe_product_id, stripe_price_id")
      .eq("creator_id", creator_id)
      .eq("billing_period", "monthly")
      .in("price_cents", [300, 500, 800]);

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
