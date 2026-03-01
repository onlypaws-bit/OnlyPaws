import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14.25.0?target=deno";

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

type Body = {
  return_path?: string;  // where to come back after onboarding
  refresh_path?: string; // where to retry onboarding if user quits
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const STRIPE_SECRET_KEY =
      Deno.env.get("STRIPE_SECRET_KEY") || Deno.env.get("OP_STRIPE_SECRET_KEY");

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    // IMPORTANT: set this to your vercel domain for correct redirects
    const SITE_URL = Deno.env.get("SITE_URL") || "http://localhost:3000";

    if (!STRIPE_SECRET_KEY) return json(500, { error: "Missing Stripe secret key" });
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
      return json(500, { error: "Missing Supabase env vars" });
    }

    const authHeader = req.headers.get("Authorization") ?? "";
    const supaUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData, error: userErr } = await supaUser.auth.getUser();
    if (userErr || !userData?.user) return json(401, { error: "Not authenticated" });

    const creatorId = userData.user.id;
    const creatorEmail = userData.user.email ?? undefined;

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: prof, error: profErr } = await admin
      .from("profiles")
      .select("user_id, display_name, username, stripe_connect_account_id")
      .eq("user_id", creatorId)
      .single();

    if (profErr || !prof) return json(400, { error: "Profile not found" });

    const stripe = new Stripe(STRIPE_SECRET_KEY, {
      apiVersion: "2023-10-16",
      httpClient: Stripe.createFetchHttpClient(),
    });

    let acctId = (prof as any).stripe_connect_account_id as string | null;

    // 1) Create Connect account if missing (Express)
    if (!acctId) {
      const pretty =
        (prof as any).display_name ||
        (prof as any).username ||
        `creator ${creatorId.slice(0, 8)}`;

      // 🔒 Preimpostazione “pet-safe” (uniforme per tutti)
      const productDescription =
  "Creator account on OnlyPaws, a subscription platform dedicated to pet-related digital content. The creator shares safe-for-work pet photography, lifestyle updates, and educational content about animals. All products are digital subscriptions for pet content.";
      // Idealmente una landing pubblica (anche semplice) che spiega che è pet-only/SFW.
      // Se non ce l’hai ancora, meglio SITE_URL che niente.
      const businessUrl = Deno.env.get("BUSINESS_URL") || SITE_URL;

      const acct = await stripe.accounts.create({
        type: "express",

        // Aiuta tantissimo nelle review
        email: creatorEmail,

        metadata: {
          creator_id: creatorId,
          platform: "OnlyPaws",
          content_category: "pet_sfw",
        },

        business_profile: {
          name: pretty,
          product_description: productDescription,
          url: businessUrl,

          // MCC tipico per subscription/continuity. Riduce ambiguità.
          // (se mai ti desse noia, lo togliamo, ma in genere aiuta)
          mcc: "5968",
        },

        // Se non richiedi transfers/card_payments altrove, è ok chiederli qui.
        // (lasciare così non rompe nulla e accelera i requisiti dell’onboarding)
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
      });

      acctId = acct.id;

      await admin
        .from("profiles")
        .update({
          stripe_connect_account_id: acctId,
          stripe_onboarding_status: "in_progress",
          charges_enabled: false,
        })
        .eq("user_id", creatorId);
    }

    // 2) Create Account Link (onboarding)
    const body = (await req.json().catch(() => ({}))) as Body;

    const returnUrl = SITE_URL + (body.return_path ?? "/profile.html");
    const refreshUrl = SITE_URL + (body.refresh_path ?? "/profile.html");

    const link = await stripe.accountLinks.create({
      account: acctId,
      type: "account_onboarding",
      return_url: returnUrl,
      refresh_url: refreshUrl,
    });

    return json(200, { url: link.url, account_id: acctId });
  } catch (e) {
    console.error(e);
    return json(500, { error: "Server error", details: String(e?.message ?? e) });
  }
});