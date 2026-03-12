import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@14.25.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
});

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: corsHeaders,
    });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supportPriceId = Deno.env.get("STRIPE_SUPPORT_US_PRICE_ID")!;
    const siteUrl = Deno.env.get("SITE_URL")!;

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

    const body = await req.json().catch(() => ({}));
    const successPath =
      typeof body?.successPath === "string" ? body.successPath : "/thank-you";
    const cancelPath =
      typeof body?.cancelPath === "string" ? body.cancelPath : "/";

    const authHeader = req.headers.get("Authorization");

    let user: { id: string; email?: string | null } | null = null;
    let email: string | null = null;
    let stripeCustomerId: string | null = null;

    if (authHeader) {
      const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
        global: {
          headers: { Authorization: authHeader },
        },
      });

      const {
        data: { user: authUser },
      } = await supabaseUser.auth.getUser();

      if (authUser) {
        user = {
          id: authUser.id,
          email: authUser.email ?? null,
        };

        const { data: profile } = await supabaseAdmin
          .from("profiles")
          .select("email")
          .eq("user_id", user.id)
          .maybeSingle();

        email = profile?.email ?? user.email ?? null;

        const { data: existingSupport, error: existingError } = await supabaseAdmin
          .from("support_us")
          .select(`
            id,
            stripe_customer_id,
            status,
            cancel_at_period_end
          `)
          .eq("user_id", user.id)
          .maybeSingle();

        if (existingError) {
          console.error("support_us read error:", existingError);
          return new Response(
            JSON.stringify({ error: "Failed to read support subscription" }),
            { status: 500, headers: corsHeaders },
          );
        }

        if (
          existingSupport &&
          ["trialing", "active", "past_due", "unpaid"].includes(existingSupport.status) &&
          existingSupport.cancel_at_period_end === false
        ) {
          return new Response(
            JSON.stringify({
              error: "Support subscription already active",
              code: "SUPPORT_ALREADY_ACTIVE",
            }),
            { status: 409, headers: corsHeaders },
          );
        }

        stripeCustomerId = existingSupport?.stripe_customer_id ?? null;
      }
    }

    if (!email && typeof body?.email === "string" && body.email.trim()) {
      email = body.email.trim().toLowerCase();
    }

    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: email ?? undefined,
        metadata: {
          kind: "support_us",
          ...(user ? { user_id: user.id } : {}),
        },
      });

      stripeCustomerId = customer.id;
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: stripeCustomerId,
      line_items: [
        {
          price: supportPriceId,
          quantity: 1,
        },
      ],
      success_url: `${siteUrl}${successPath}?support=success`,
      cancel_url: `${siteUrl}${cancelPath}?support=cancelled`,
      allow_promotion_codes: true,
      metadata: {
        kind: "support_us",
        ...(user ? { user_id: user.id } : {}),
      },
      subscription_data: {
        metadata: {
          kind: "support_us",
          ...(user ? { user_id: user.id } : {}),
        },
      },
    });

    const payload = {
      user_id: user?.id ?? null,
      email,
      stripe_customer_id: stripeCustomerId,
      stripe_checkout_session_id: session.id,
      stripe_price_id: supportPriceId,
      status: "incomplete",
      updated_at: new Date().toISOString(),
    };

    if (user) {
      const { error: upsertError } = await supabaseAdmin
        .from("support_us")
        .upsert(payload, { onConflict: "user_id" });

      if (upsertError) {
        console.error("support_us upsert error:", upsertError);
        return new Response(JSON.stringify({ error: "Failed to save checkout session" }), {
          status: 500,
          headers: corsHeaders,
        });
      }
    } else {
      const { error: insertError } = await supabaseAdmin
        .from("support_us")
        .insert(payload);

      if (insertError) {
        console.error("support_us insert error:", insertError);
        return new Response(JSON.stringify({ error: "Failed to save checkout session" }), {
          status: 500,
          headers: corsHeaders,
        });
      }
    }

    return new Response(
      JSON.stringify({
        url: session.url,
        sessionId: session.id,
        anonymous: !user,
      }),
      {
        status: 200,
        headers: corsHeaders,
      },
    );
  } catch (error) {
    console.error("support-us-checkout error:", error);

    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: corsHeaders,
    });
  }
});});
