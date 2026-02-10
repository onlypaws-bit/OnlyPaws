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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") || Deno.env.get("OP_STRIPE_SECRET_KEY");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
    if (!STRIPE_SECRET_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_ANON_KEY) {
      return json(500, { error: "Missing env vars" });
    }

    const authHeader = req.headers.get("Authorization") ?? "";
    const supaUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData, error: userErr } = await supaUser.auth.getUser();
    if (userErr || !userData?.user) return json(401, { error: "Not authenticated" });

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

    const { data: prof, error: pe } = await admin
      .from("profiles")
      .select("stripe_connect_account_id")
      .eq("user_id", userData.user.id)
      .single();

    if (pe || !prof?.stripe_connect_account_id) return json(400, { error: "Missing stripe_connect_account_id" });

    const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });

    const bal = await stripe.balance.retrieve({ stripeAccount: prof.stripe_connect_account_id });

    const eurAvail = (bal.available || []).find(x => x.currency === "eur")?.amount ?? 0;
    const eurPend  = (bal.pending  || []).find(x => x.currency === "eur")?.amount ?? 0;

    return json(200, {
      currency: "eur",
      available_cents: eurAvail,
      pending_cents: eurPend,
    });
  } catch (e) {
    return json(500, { error: "Server error", details: String((e as any)?.message ?? e) });
  }
});
