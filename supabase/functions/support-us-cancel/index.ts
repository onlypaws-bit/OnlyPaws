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

function toIsoOrNull(unixSeconds?: number | null) {
  if (!unixSeconds) return null;
  return new Date(unixSeconds * 1000).toISOString();
}

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

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing Authorization header" }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: { Authorization: authHeader },
      },
    });

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

    const {
      data: { user },
      error: userError,
    } = await supabaseUser.auth.getUser();

    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    const { data: support, error: supportError } = await supabaseAdmin
      .from("support_us")
      .select(`
        id,
        user_id,
        stripe_subscription_id,
        status,
        cancel_at_period_end,
        current_period_end
      `)
      .eq("user_id", user.id)
      .maybeSingle();

    if (supportError) {
      console.error("support_us read error:", supportError);
      return new Response(JSON.stringify({ error: "Failed to read support subscription" }), {
        status: 500,
        headers: corsHeaders,
      });
    }

    if (!support) {
      return new Response(JSON.stringify({ error: "Support subscription not found" }), {
        status: 404,
        headers: corsHeaders,
      });
    }

    if (!support.stripe_subscription_id) {
      return new Response(JSON.stringify({ error: "Missing Stripe subscription id" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    if (!["trialing", "active", "past_due", "unpaid"].includes(support.status)) {
      return new Response(JSON.stringify({ error: "Subscription is not cancellable" }), {
        status: 409,
        headers: corsHeaders,
      });
    }

    if (support.cancel_at_period_end === true) {
      return new Response(
        JSON.stringify({
          ok: true,
          alreadyCanceled: true,
          status: support.status,
          cancel_at_period_end: true,
          current_period_end: support.current_period_end,
        }),
        {
          status: 200,
          headers: corsHeaders,
        },
      );
    }

    const subscription = await stripe.subscriptions.update(
      support.stripe_subscription_id,
      {
        cancel_at_period_end: true,
      },
    );

    const firstItem = subscription.items.data[0];

    const { error: updateError } = await supabaseAdmin
      .from("support_us")
      .update({
        status: subscription.status,
        cancel_at_period_end: subscription.cancel_at_period_end,
        current_period_start: toIsoOrNull(firstItem?.current_period_start),
        current_period_end: toIsoOrNull(firstItem?.current_period_end),
        updated_at: new Date().toISOString(),
      })
      .eq("id", support.id);

    if (updateError) {
      console.error("support_us cancel update error:", updateError);
      return new Response(JSON.stringify({ error: "Failed to update support subscription" }), {
        status: 500,
        headers: corsHeaders,
      });
    }

    return new Response(
      JSON.stringify({
        ok: true,
        status: subscription.status,
        cancel_at_period_end: subscription.cancel_at_period_end,
        current_period_end: toIsoOrNull(firstItem?.current_period_end),
      }),
      {
        status: 200,
        headers: corsHeaders,
      },
    );
  } catch (error) {
    console.error("support-us-cancel error:", error);

    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: corsHeaders,
    });
  }
});
