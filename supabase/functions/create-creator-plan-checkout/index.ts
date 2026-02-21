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

// ✅ il tuo price
const PRICE_ID = "price_1StS6zLpyDgdWu8HPqemX38v";

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
  // ✅ CORS preflight
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

    const origin =
      req.headers.get("origin") ??
      "https://onlypaws-psi.vercel.app";

    const successUrl = `${origin}/creator-dash.html?success=1&session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${origin}/creator-dash.html?canceled=1`;

    // ✅ Se il trial è già configurato nel price su Stripe, NON serve aggiungerlo qui.
    const session = await stripePOST("checkout/sessions", {
      mode: "subscription",
      "line_items[0][price]": PRICE_ID,
      "line_items[0][quantity]": "1",
      success_url: successUrl,
      cancel_url: cancelUrl,

      // 🔥 fondamentale per sapere a chi assegnare entitlements
      "metadata[user_id]": user.id,

      // ✅ robusto: garantisce metadata anche sulla subscription (customer.subscription.updated ecc.)
      "subscription_data[metadata][user_id]": user.id,
"subscription_data[trial_period_days]": "14",
      customer_email: user.email ?? "",
      // opzionale: se vuoi forzare trial da qui invece che dal price:
      // "subscription_data[trial_period_days]": "14",
    });

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(`Error: ${(e as any)?.message ?? String(e)}`, {
      status: 500,
      headers: corsHeaders,
    });
  }
});
