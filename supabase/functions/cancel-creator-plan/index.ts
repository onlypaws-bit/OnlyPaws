import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

function toForm(params: Record<string, string>) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) body.append(k, v);
  return body;
}

async function stripePOST(path: string, params: Record<string, string>) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: toForm(params),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error?.message ?? JSON.stringify(j));
  return j;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });

  try {
    const auth = req.headers.get("Authorization") || "";

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: auth } },
    });

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return new Response("Unauthorized", { status: 401, headers: corsHeaders });

    // find current creator_plan subscription id
    const { data: ent, error: e1 } = await supabase
      .from("entitlements")
      .select("stripe_subscription_id")
      .eq("user_id", user.id)
      .eq("key", "creator_plan")
      .maybeSingle();

    if (e1) throw e1;

    const subId = (ent?.stripe_subscription_id || "").trim();
    if (!subId) {
      return new Response(JSON.stringify({ ok: true, message: "No subscription to cancel" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ✅ cancel at period end
    const sub = await stripePOST(`subscriptions/${subId}`, {
      cancel_at_period_end: "true",
    });

    // optional: store current_period_end (webhook will sync too)
    const cpeIso =
      sub?.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null;

    await supabase
      .from("entitlements")
      .update({
        current_period_end: cpeIso,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", user.id)
      .eq("key", "creator_plan");

    return new Response(JSON.stringify({ ok: true, current_period_end: cpeIso }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(`Error: ${(e as any)?.message ?? String(e)}`, {
      status: 500,
      headers: corsHeaders,
    });
  }
});