// supabase/functions/sync-fan-subscription/index.ts
import Stripe from "https://esm.sh/stripe@14.25.0?target=deno";
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

type Body = { session_id: string };

function safeStr(v: unknown) {
  const s = (v ?? "").toString().trim();
  return s.length ? s : null;
}

function toIsoFromUnix(sec?: number | null) {
  if (!sec || !Number.isFinite(sec)) return null;
  return new Date(sec * 1000).toISOString();
}

function mapStripeSubStatusToDb(status: string | null) {
  const s = (status ?? "").toLowerCase();
  // Stripe: trialing, active, past_due, canceled, unpaid, incomplete...
  if (s === "trialing" || s === "active") return "active";
  if (s === "past_due") return "past_due";
  if (s === "unpaid") return "unpaid";
  if (s === "canceled") return "canceled";
  if (s === "incomplete") return "incomplete";
  return "incomplete";
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

    const stripe = new Stripe(STRIPE_SECRET_KEY, {
      apiVersion: "2023-10-16",
      httpClient: Stripe.createFetchHttpClient(),
    });

    // auth utente (fan)
    const authHeader = req.headers.get("Authorization") ?? "";
    const supaUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData } = await supaUser.auth.getUser();
    const fanAuthedId = userData?.user?.id ?? null;
    if (!fanAuthedId) return json(401, { error: "Not authenticated" });

    const body = (await req.json().catch(() => ({}))) as Body;
    const session_id = safeStr(body?.session_id);
    if (!session_id) return json(400, { error: "Missing session_id" });

    // Retrieve checkout session (platform call; it contains metadata)
    const session = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ["subscription"],
    });

    const md = (session.metadata || {}) as Record<string, string>;
    const fan_id = safeStr(md.fan_id) || safeStr(session.client_reference_id);
    const creator_id = safeStr(md.creator_id);
    const plan_id = safeStr(md.plan_id);

    if (!fan_id || !creator_id || !plan_id) {
      return json(400, {
        error: "Missing metadata on session",
        needed: ["metadata[fan_id]", "metadata[creator_id]", "metadata[plan_id]"],
        got: { fan_id, creator_id, plan_id },
      });
    }

    // Allow only the same fan to sync its own session
    if (fanAuthedId !== fan_id) return json(403, { error: "Not allowed" });

    // Get subscription object/id
    const subAny = (session.subscription as any) ?? null;
    const subscriptionId: string | null =
      safeStr(subAny?.id) || safeStr(session.subscription as any);

    if (!subscriptionId) {
      // paid, but Stripe didn’t attach subscription yet (rare). mark incomplete and exit.
      return json(409, { error: "SUBSCRIPTION_NOT_READY_YET" });
    }

    // Retrieve subscription fresh (source of truth)
    const sub = await stripe.subscriptions.retrieve(subscriptionId);

    const dbStatus = mapStripeSubStatusToDb(sub.status);
    const provider_customer_id = safeStr(sub.customer as any) || safeStr(session.customer as any);
    const provider_subscription_id = sub.id;

    const cps = toIsoFromUnix(sub.current_period_start as any);
    const cpe = toIsoFromUnix(sub.current_period_end as any);

    const cancel_at_period_end = Boolean((sub as any).cancel_at_period_end);

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    // 1) Try to update latest pending row for this fan/creator/plan
    const { data: pendingRow } = await admin
      .from("fan_subscriptions")
      .select("id")
      .eq("fan_id", fan_id)
      .eq("creator_id", creator_id)
      .eq("plan_id", plan_id)
      .in("status", ["checkout_pending", "incomplete"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (pendingRow?.id) {
      const { error: updErr } = await admin
        .from("fan_subscriptions")
        .update({
          status: dbStatus,
          provider_customer_id,
          provider_subscription_id,
          current_period_start: cps ?? undefined,
          current_period_end: cpe ?? undefined,
          cancel_at_period_end,
          updated_at: new Date().toISOString(),
        })
        .eq("id", pendingRow.id);

      if (updErr) throw updErr;
    } else {
      // 2) Else insert a fresh row (provider_subscription_id is UNIQUE => safe)
      const { error: insErr } = await admin.from("fan_subscriptions").insert({
        fan_id,
        creator_id,
        plan_id,
        status: dbStatus,
        provider_customer_id,
        provider_subscription_id,
        current_period_start: cps ?? new Date().toISOString(),
        current_period_end: cpe ?? null,
        cancel_at_period_end,
        payment_provider: "stripe",
      });

      if (insErr) throw insErr;
    }

    return json(200, {
      ok: true,
      session_id,
      fan_id,
      creator_id,
      plan_id,
      provider_subscription_id,
      status: dbStatus,
      current_period_start: cps,
      current_period_end: cpe,
      cancel_at_period_end,
    });
  } catch (e) {
    console.error(e);
    return json(500, { error: String((e as any)?.message ?? e) });
  }
});