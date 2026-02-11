// supabase/functions/cancel-subscription/index.ts
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

type Body = {
  // uno dei due:
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

function safeStr(v: unknown) {
  const s = (v ?? "").toString().trim();
  return s.length ? s : null;
}

function env(...keys: string[]) {
  for (const k of keys) {
    const v = Deno.env.get(k);
    if (v && v.trim().length) return v;
  }
  return "";
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

    const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

    // --- fan auth ---
    const authHeader = req.headers.get("Authorization") ?? "";
    const supaUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData, error: userErr } = await supaUser.auth.getUser();
    if (userErr || !userData?.user) return json(401, { error: "Not authenticated" });

    const fanId = userData.user.id;

    const body = (await req.json().catch(() => ({}))) as Body;

    const creator_id = safeStr(body?.creator_id);
    const stripe_subscription_id_from_body = safeStr(body?.stripe_subscription_id);

    if (!creator_id && !stripe_subscription_id_from_body) {
      return json(400, { error: "Missing creator_id or stripe_subscription_id" });
    }
    if (creator_id && creator_id === fanId) {
      return json(400, { error: "fan_id cannot equal creator_id" });
    }

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    // --- trova subscription row (tabella GIUSTA) ---
    let row:
      | {
          id: string;
          fan_id: string;
          creator_id: string;
          status: string;
          is_active: boolean;
          stripe_subscription_id: string | null;
        }
      | null = null;

    if (stripe_subscription_id_from_body) {
      const { data, error } = await admin
        .from("creator_subscriptions")
        .select("id, fan_id, creator_id, status, is_active, stripe_subscription_id")
        .eq("stripe_subscription_id", stripe_subscription_id_from_body)
        .maybeSingle();

      if (error) return json(500, { error: "DB error", details: error.message });
      row = data ?? null;
    } else if (creator_id) {
      const { data, error } = await admin
        .from("creator_subscriptions")
        .select("id, fan_id, creator_id, status, is_active, stripe_subscription_id")
        .eq("fan_id", fanId)
        .eq("creator_id", creator_id)
        // consideriamo active/past_due (canceled non serve per cancellare)
        .in("status", ["active", "past_due"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) return json(500, { error: "DB error", details: error.message });
      row = data ?? null;
    }

    if (!row) {
      return json(404, { error: "No subscription found" });
    }

    // sicurezza: deve appartenere al fan loggato
    if (row.fan_id !== fanId) return json(403, { error: "Forbidden" });

    if (!row.stripe_subscription_id) {
      return json(404, { error: "No stripe_subscription_id on DB row" });
    }

    // --- Stripe: set cancel_at_period_end ---
    const current = await stripe.subscriptions.retrieve(row.stripe_subscription_id);

    // idempotente
    if (current.cancel_at_period_end) {
      return json(200, {
        ok: true,
        already: true,
        stripe_subscription_id: current.id,
        cancel_at_period_end: true,
        current_period_end: current.current_period_end,
      });
    }

    const updated = await stripe.subscriptions.update(row.stripe_subscription_id, {
      cancel_at_period_end: true,
    });

    // aggiorna SOLO period_end (non cambiamo status: resta active finché non scade)
    const periodEndIso = new Date(updated.current_period_end * 1000).toISOString();

    const { error: updErr } = await admin
      .from("creator_subscriptions")
      .update({
        current_period_end: periodEndIso,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);

    if (updErr) return json(500, { error: "DB update failed", details: updErr.message });

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
