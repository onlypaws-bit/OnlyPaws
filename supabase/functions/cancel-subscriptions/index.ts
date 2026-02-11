// supabase/functions/cancel-subscription/index.ts
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";
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

function env(...keys: string[]) {
  for (const k of keys) {
    const v = Deno.env.get(k);
    if (v && v.trim().length) return v;
  }
  return "";
}

function safeStr(v: unknown) {
  const s = (v ?? "").toString().trim();
  return s.length ? s : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const STRIPE_SECRET_KEY = env("STRIPE_SECRET_KEY", "OP_STRIPE_SECRET_KEY");
    const SUPABASE_URL = env("SUPABASE_URL", "OP_SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = env(
      "SUPABASE_SERVICE_ROLE_KEY",
      "OP_SUPABASE_SERVICE_ROLE_KEY"
    );
    const SUPABASE_ANON_KEY = env("SUPABASE_ANON_KEY", "OP_SUPABASE_ANON_KEY");

    if (!STRIPE_SECRET_KEY) return json(500, { error: "Missing STRIPE secret key" });
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_ANON_KEY) {
      return json(500, { error: "Missing Supabase env vars" });
    }

    const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });

    // --- auth fan ---
    const authHeader = req.headers.get("Authorization") ?? "";
    const supaUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData, error: userErr } = await supaUser.auth.getUser();
    if (userErr || !userData?.user) return json(401, { error: "Not authenticated" });
    const fanId = userData.user.id;

    const body = (await req.json()) as Body;
    const creator_id = safeStr(body?.creator_id);
    if (!creator_id) return json(400, { error: "Missing creator_id" });
    if (creator_id === fanId) return json(400, { error: "fan_id cannot equal creator_id" });

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    // ✅ tabella GIUSTA: creator_subscriptions
    const { data: row, error: rowErr } = await admin
      .from("creator_subscriptions")
      .select("id, status, stripe_subscription_id, current_period_end, created_at")
      .eq("fan_id", fanId)
      .eq("creator_id", creator_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (rowErr) return json(500, { error: "DB error", details: rowErr.message });
    if (!row?.stripe_subscription_id) {
      return json(404, { error: "No Stripe subscription found for this creator" });
    }

    // Retrieve from Stripe
    const current = await stripe.subscriptions.retrieve(row.stripe_subscription_id);

    // Idempotente: se già a fine periodo
    if (current.cancel_at_period_end) {
      const periodEndIso = current.current_period_end
        ? new Date(current.current_period_end * 1000).toISOString()
        : null;

      await admin
        .from("creator_subscriptions")
        .update({
          status: "canceled",
          is_active: false,
          current_period_end: periodEndIso,
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);

      return json(200, {
        ok: true,
        already: true,
        stripe_subscription_id: current.id,
        cancel_at_period_end: true,
        current_period_end: current.current_period_end ?? null,
      });
    }

    // Set cancel at period end
    const updated = await stripe.subscriptions.update(row.stripe_subscription_id, {
      cancel_at_period_end: true,
    });

    const periodEndIso = updated.current_period_end
      ? new Date(updated.current_period_end * 1000).toISOString()
      : null;

    await admin
      .from("creator_subscriptions")
      .update({
        status: "canceled",
        is_active: false,
        current_period_end: periodEndIso,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);

    return json(200, {
      ok: true,
      stripe_subscription_id: updated.id,
      cancel_at_period_end: updated.cancel_at_period_end,
      current_period_end: updated.current_period_end ?? null,
    });
  } catch (e) {
    console.error(e);
    return json(500, {
      error: "Server error",
      details: String((e as any)?.message ?? e),
    });
  }
});
