// supabase/functions/cancel-subscription/index.ts
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1?target=deno";

type Body = {
  creator_id?: string;
  stripe_subscription_id?: string;
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

function env(...keys: string[]) {
  for (const k of keys) {
    const v = Deno.env.get(k);
    if (v && v.trim().length) return v;
  }
  return "";
}

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const STRIPE_SECRET_KEY = env("STRIPE_SECRET_KEY", "OP_STRIPE_SECRET_KEY");
    const SUPABASE_URL = env("SUPABASE_URL", "OP_SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = env(
      "SUPABASE_SERVICE_ROLE_KEY",
      "OP_SUPABASE_SERVICE_ROLE_KEY",
    );
    const SUPABASE_ANON_KEY = env("SUPABASE_ANON_KEY", "OP_SUPABASE_ANON_KEY");

    if (!STRIPE_SECRET_KEY) return json(500, { error: "Missing STRIPE secret key" });
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_ANON_KEY) {
      return json(500, { error: "Missing Supabase env vars" });
    }

    // ✅ EDGE-SAFE Stripe init (fetch-based HTTP client)
    const stripe = new Stripe(STRIPE_SECRET_KEY, {
      apiVersion: "2024-06-20",
      httpClient: Stripe.createFetchHttpClient(),
    });

    // fan auth
    const authHeader = req.headers.get("Authorization") ?? "";
    const supaUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });

    const { data: userData, error: userErr } = await supaUser.auth.getUser();
    if (userErr || !userData?.user) return json(401, { error: "Not authenticated" });
    const fanId = userData.user.id;

    // body parse (safe)
    let body: Body = {};
    try {
      body = (await req.json()) as Body;
    } catch {
      return json(400, { error: "Invalid JSON body" });
    }

    const creator_id = (body?.creator_id || "").trim();
    const stripeSubId = (body?.stripe_subscription_id || "").trim();

    if (!creator_id && !stripeSubId) {
      return json(400, { error: "Missing creator_id or stripe_subscription_id" });
    }
    if (creator_id && creator_id === fanId) {
      return json(400, { error: "fan_id cannot equal creator_id" });
    }

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    // find subscription row for this fan (prefer by stripe_subscription_id)
    let subQuery = admin
      .from("creator_subscriptions")
      .select(
        "id, fan_id, creator_id, status, is_active, stripe_subscription_id, current_period_end, created_at",
      )
      .eq("fan_id", fanId)
      .order("created_at", { ascending: false })
      .limit(1);

    if (stripeSubId) {
      subQuery = subQuery.eq("stripe_subscription_id", stripeSubId);
    } else {
      subQuery = subQuery
        .eq("creator_id", creator_id)
        .in("status", ["active", "past_due", "canceled"]);
    }

    const { data: sub, error: subErr } = await subQuery.maybeSingle();

    if (subErr) return json(500, { error: "DB error", details: subErr.message });
    if (!sub?.stripe_subscription_id) {
      return json(404, { error: "No Stripe subscription found for this creator" });
    }

    // stripe: idempotent cancellation-at-period-end
    const current = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);

    if (current.cancel_at_period_end) {
      return json(200, {
        ok: true,
        already: true,
        stripe_subscription_id: current.id,
        cancel_at_period_end: true,
        current_period_end: current.current_period_end,
      });
    }

    const updated = await stripe.subscriptions.update(sub.stripe_subscription_id, {
      cancel_at_period_end: true,
    });

    const periodEndIso = updated.current_period_end
      ? new Date(updated.current_period_end * 1000).toISOString()
      : null;

    // IMPORTANT:
    // keep access until period end
    const { error: upErr } = await admin
      .from("creator_subscriptions")
      .update({
        status: "active",
        is_active: true,
        current_period_end: periodEndIso,
        updated_at: new Date().toISOString(),
      })
      .eq("id", sub.id);

    if (upErr) return json(500, { error: "DB update error", details: upErr.message });

    return json(200, {
      ok: true,
      stripe_subscription_id: updated.id,
      cancel_at_period_end: updated.cancel_at_period_end,
      current_period_end: updated.current_period_end,
    });
  } catch (e) {
    console.error(e);
    return json(500, {
      error: "Server error",
      details: String((e as any)?.message ?? e),
    });
  }
});
