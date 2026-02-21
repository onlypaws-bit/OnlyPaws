// supabase/functions/create-checkout-session/index.ts
import Stripe from "https://esm.sh/stripe@14.21.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

type Body = {
  creator_id: string;
  plan_id: string;
  // opzionale: se il frontend lo passa (meglio), usiamo questo per redirect
  creator_username?: string;
  success_path?: string;
  cancel_path?: string;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
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

function safeStr(v: unknown) {
  const s = (v ?? "").toString().trim();
  return s.length ? s : null;
}

function isNoSuchPriceError(err: unknown) {
  const msg = String((err as any)?.message ?? err ?? "");
  // Stripe tipicamente: "No such price: 'price_...'"
  return msg.toLowerCase().includes("no such price") || msg.toLowerCase().includes("resource_missing");
}

async function stripeCreateCheckoutSessionDirect(
  stripeSecret: string,
  stripeAccount: string,
  params: Record<string, string>
) {
  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${stripeSecret}`,
      "Content-Type": "application/x-www-form-urlencoded",
      // ✅ DIRECT: crea la session sul connected account
      "Stripe-Account": stripeAccount,
    },
    body: toForm(params),
  });

  const j = await res.json();
  if (!res.ok) throw new Error((j?.error?.message ?? JSON.stringify(j)));
  return j;
}

async function callEnsureCreatorPrices(
  supabaseUrl: string,
  serviceRoleKey: string,
  creator_id: string
) {
  const res = await fetch(`${supabaseUrl}/functions/v1/ensure-creator-prices`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${serviceRoleKey}`,
    },
    body: JSON.stringify({ creator_id }),
  });

  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`ensure-creator-prices failed: ${JSON.stringify(j)}`);
  return j;
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

    if (!STRIPE_SECRET_KEY) return json(500, { error: "Missing STRIPE secret key" });
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_ANON_KEY) {
      return json(500, { error: "Missing Supabase env vars" });
    }

    const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });

    // --- auth utente (fan) ---
    const authHeader = req.headers.get("Authorization") ?? "";
    const supaUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData, error: userErr } = await supaUser.auth.getUser();
    if (userErr || !userData?.user) return json(401, { error: "Not authenticated" });

    const fanId = userData.user.id;

    const body = (await req.json()) as Body;

    const creator_id = safeStr(body?.creator_id);
    const plan_id = safeStr(body?.plan_id);
    const creator_username_from_body = safeStr(body?.creator_username);

    if (!creator_id || !plan_id) return json(400, { error: "Missing creator_id or plan_id" });
    if (creator_id === fanId) return json(400, { error: "fan_id cannot equal creator_id" });

    const origin = req.headers.get("Origin") ?? "http://localhost:3000";

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    // ✅ 0.5) VIEWER ROLE GATE: creators cannot subscribe (for now)
    const { data: viewerProf, error: viewerErr } = await admin
      .from("profiles")
      .select("role")
      .eq("user_id", fanId)
      .maybeSingle();

    if (viewerErr) {
      return json(500, { error: "Failed to load viewer profile", details: viewerErr.message });
    }

    const viewerRole = (viewerProf?.role ?? "").toString();
    if (viewerRole === "creator") {
      return json(403, { error: "CREATOR_CANNOT_SUBSCRIBE_YET" });
    }

    // 0) creator username fallback (se non passato dal frontend)
    let creator_username: string | null = creator_username_from_body;
    if (!creator_username) {
      const { data: cprof } = await admin
        .from("profiles")
        .select("username")
        .eq("user_id", creator_id)
        .maybeSingle();
      creator_username = safeStr(cprof?.username);
    }

    // ✅ redirect target: prefer username
    const uParam = encodeURIComponent(creator_username ?? creator_id);

    // default success/cancel
    const successDefault =
      `/creator-profile.html?u=${uParam}&success=1&session_id={CHECKOUT_SESSION_ID}`;
    const cancelDefault = `/subscriptions.html?creator=${encodeURIComponent(creator_id)}`;

    const successUrl = origin + (body.success_path ?? successDefault);
    const cancelUrl = origin + (body.cancel_path ?? cancelDefault);

    // 1) plan (prima lettura)
    const planRes1 = await admin
      .from("creator_plans")
      .select("id, creator_id, is_active, billing_period, stripe_price_id")
      .eq("id", plan_id)
      .eq("creator_id", creator_id)
      .eq("is_active", true)
      .eq("billing_period", "monthly")
      .single();

    if (planRes1.error || !planRes1.data) {
      return json(400, { error: "Plan not found / inactive / not monthly" });
    }

    let stripe_price_id: string | null = planRes1.data.stripe_price_id ?? null;

    // 3) creator connect account id
    const creatorRes = await admin
      .from("profiles")
      .select("user_id, stripe_connect_account_id")
      .eq("user_id", creator_id)
      .single();

    if (creatorRes.error || !creatorRes.data) {
      return json(400, { error: "Creator profile not found" });
    }

    const connectId = (creatorRes.data as any).stripe_connect_account_id as string | null;
    if (!connectId) {
      return json(409, { error: "CREATOR_NOT_READY", reason: "missing_stripe_connect_account_id" });
    }

    // 4) ✅ verifica stato reale su Stripe
    const acc = await stripe.accounts.retrieve(connectId);

    const ready =
      Boolean(acc.details_submitted) &&
      Boolean(acc.charges_enabled) &&
      Boolean(acc.payouts_enabled);

    if (!ready) {
      return json(409, {
        error: "CREATOR_NOT_READY",
        reason: "stripe_account_not_ready",
        connect: {
          id: acc.id,
          details_submitted: acc.details_submitted,
          charges_enabled: acc.charges_enabled,
          payouts_enabled: acc.payouts_enabled,
          disabled_reason: acc.requirements?.disabled_reason ?? null,
          currently_due: acc.requirements?.currently_due ?? [],
          past_due: acc.requirements?.past_due ?? [],
          eventually_due: acc.requirements?.eventually_due ?? [],
        },
      });
    }

    // 6) params checkout subscription DIRECT
    const buildParams = (priceId: string) =>
      ({
        mode: "subscription",
        success_url: successUrl,
        cancel_url: cancelUrl,

        "payment_method_types[0]": "card",

        "line_items[0][price]": priceId,
        "line_items[0][quantity]": "1",

        allow_promotion_codes: "true",

        client_reference_id: fanId,

        "metadata[fan_id]": fanId,
        "metadata[creator_id]": creator_id,
        "metadata[plan_id]": plan_id,

        "subscription_data[metadata][fan_id]": fanId,
        "subscription_data[metadata][creator_id]": creator_id,
        "subscription_data[metadata][plan_id]": plan_id,

        // ✅ OP fee 35% (creator vede netto e basta)
        "subscription_data[application_fee_percent]": "35",
      }) as Record<string, string>;

    // Se price manca già in DB, prova subito ensure (evitiamo roundtrip)
    if (!stripe_price_id) {
      await callEnsureCreatorPrices(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, creator_id);

      const planReload = await admin
        .from("creator_plans")
        .select("stripe_price_id")
        .eq("id", plan_id)
        .single();

      stripe_price_id = planReload.data?.stripe_price_id ?? null;

      if (!stripe_price_id) {
        return json(400, { error: "Stripe price still missing after auto-setup" });
      }
    }

    // ✅ TRY 1
    try {
      const session1 = await stripeCreateCheckoutSessionDirect(
        STRIPE_SECRET_KEY,
        connectId,
        buildParams(stripe_price_id)
      );
      return json(200, { url: session1.url, id: session1.id });
    } catch (e) {
      // fallback solo se è "no such price"
      if (!isNoSuchPriceError(e)) throw e;

      // ✅ ensure prices on connected + reload plan + retry once
      await callEnsureCreatorPrices(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, creator_id);

      const planReload2 = await admin
        .from("creator_plans")
        .select("stripe_price_id")
        .eq("id", plan_id)
        .single();

      const newPriceId = planReload2.data?.stripe_price_id ?? null;
      if (!newPriceId) {
        return json(400, { error: "Stripe price missing after fallback ensure" });
      }

      const session2 = await stripeCreateCheckoutSessionDirect(
        STRIPE_SECRET_KEY,
        connectId,
        buildParams(newPriceId)
      );

      return json(200, { url: session2.url, id: session2.id });
    }
  } catch (e) {
    console.error(e);
    return json(500, { error: "Server error", details: String((e as any)?.message ?? e) });
  }
});
