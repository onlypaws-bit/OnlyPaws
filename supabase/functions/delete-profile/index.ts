import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";

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

const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json(401, { error: "Missing Authorization header" });

    const jwt = authHeader.replace("Bearer ", "").trim();

    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: `Bearer ${jwt}` } } }
    );

    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return json(401, { error: "Invalid user session" });

    const userId = userData.user.id;

    let body: any = null;
    try { body = await req.json(); } catch { body = null; }
    if (body?.confirm !== true) return json(400, { error: "Missing confirm=true" });

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // 1) prendi profile per stripe_customer_id (rete di sicurezza)
    const { data: profile, error: profErr } = await admin
      .from("profiles")
      .select("user_id, stripe_customer_id")
      .eq("user_id", userId)
      .maybeSingle();

    if (profErr) return json(500, { error: profErr.message });

    // 2) STOP STRIPE SUBS: tutte quelle collegate all'utente via creator_subscriptions
    const { data: relSubs, error: relSubsErr } = await admin
      .from("creator_subscriptions")
      .select("stripe_subscription_id")
      .or(`fan_id.eq.${userId},creator_id.eq.${userId}`)
      .not("stripe_subscription_id", "is", null);

    if (relSubsErr) return json(500, { error: relSubsErr.message });

    const ids = new Set<string>();
    for (const r of relSubs ?? []) {
      if (r?.stripe_subscription_id) ids.add(r.stripe_subscription_id);
    }

    for (const subId of ids) {
      try {
        await stripe.subscriptions.cancel(subId); // ✅ immediato
      } catch {
        // idempotente
      }
    }

    // 2B) rete di sicurezza: se ha stripe_customer_id, cancella tutte le sub del customer
    if (profile?.stripe_customer_id) {
      const statuses: Stripe.SubscriptionListParams.Status[] = [
        "active",
        "trialing",
        "past_due",
        "unpaid",
      ];

      for (const st of statuses) {
        const subs = await stripe.subscriptions.list({
          customer: profile.stripe_customer_id,
          status: st,
          limit: 100,
        });

        for (const s of subs.data) {
          try { await stripe.subscriptions.cancel(s.id); } catch {}
        }
      }
    }

    // 3) DB delete: basta profiles, i CASCADE fanno il resto
    const { error: delProfErr } = await admin.from("profiles").delete().eq("user_id", userId);
    if (delProfErr) return json(500, { error: delProfErr.message });

    // 4) delete auth user
    const { error: delAuthErr } = await admin.auth.admin.deleteUser(userId);
    if (delAuthErr) return json(500, { error: delAuthErr.message });

    return json(200, { ok: true });
  } catch (e: any) {
    return json(500, { error: e?.message || String(e) });
  }
});
