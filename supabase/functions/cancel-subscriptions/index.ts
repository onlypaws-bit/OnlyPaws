// supabase/functions/cancel-subscription/index.ts
import Stripe from "https://esm.sh/stripe@14.21.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

type Body = { creator_id: string };

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

    // fan auth
    const authHeader = req.headers.get("Authorization") ?? "";
    const supaUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData, error: userErr } = await supaUser.auth.getUser();
    if (userErr || !userData?.user) return json(401, { error: "Not authenticated" });
    const fanId = userData.user.id;

    const body = (await req.json()) as Body;
    const creator_id = body?.creator_id;
    if (!creator_id) return json(400, { error: "Missing creator_id" });
    if (creator_id === fanId) return json(400, { error: "fan_id cannot equal creator_id" });

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    // trova sub attiva (o cancellata ma ancora valida) per pair
    const { data: sub, error: subErr } = await admin
      .from("subscriptions")
      .select("id, status, stripe_subscription_id, current_period_end, canceled_at")
      .eq("fan_id", fanId)
      .eq("creator_id", creator_id)
      .in("status", ["active", "past_due", "canceled"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (subErr) return json(500, { error: "DB error", details: subErr.message });
    if (!sub?.stripe_subscription_id) {
      return json(404, { error: "No Stripe subscription found for this creator" });
    }

    // se già cancellata a fine periodo, return ok idempotente
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

    // aggiorna DB (mantieni current_period_end come da Stripe)
    const periodEndIso = new Date(updated.current_period_end * 1000).toISOString();

    await admin
      .from("subscriptions")
      .update({
        status: "canceled",
        canceled_at: new Date().toISOString(),
        current_period_end: periodEndIso,
        provider_subscription_id: updated.id,
        payment_provider: "stripe",
      })
      .eq("id", sub.id);

    return json(200, {
      ok: true,
      stripe_subscription_id: updated.id,
      cancel_at_period_end: updated.cancel_at_period_end,
      current_period_end: updated.current_period_end,
    });
  } catch (e) {
    console.error(e);
    return json(500, { error: "Server error", details: String((e as any)?.message ?? e) });
  }
});