import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import Stripe from "https://esm.sh/stripe@14.25.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
});

const cryptoProvider = Stripe.createSubtleCryptoProvider();

function toIsoOrNull(unixSeconds?: number | null): string | null {
  if (!unixSeconds) return null;
  return new Date(unixSeconds * 1000).toISOString();
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const stripeSecretKey = Deno.env.get("STRIPE_SECRET_KEY");
    const stripeWebhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (
      !stripeSecretKey ||
      !stripeWebhookSecret ||
      !supabaseUrl ||
      !supabaseServiceRoleKey
    ) {
      console.error("Missing required environment variables");
      return new Response("Server misconfigured", { status: 500 });
    }

    const signature = req.headers.get("stripe-signature");
    if (!signature) {
      return new Response("Missing stripe-signature header", { status: 400 });
    }

    const rawBody = await req.text();

    let event: Stripe.Event;
    try {
      event = await stripe.webhooks.constructEventAsync(
        rawBody,
        signature,
        stripeWebhookSecret,
        undefined,
        cryptoProvider,
      );
    } catch (err) {
      console.error("Webhook signature verification failed:", err);
      return new Response("Invalid signature", { status: 400 });
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey);

    // -------- checkout.session.completed --------
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;

      if (session.mode === "subscription") {
        const userId = session.metadata?.user_id;
        const kind = session.metadata?.kind;

        if (userId && kind === "support_us") {
          const existing = await supabaseAdmin
            .from("support_us")
            .select("last_event_id")
            .eq("user_id", userId)
            .maybeSingle();

          if (existing.error) {
            console.error("Error reading support_us for dedupe:", existing.error);
            return new Response("DB read error", { status: 500 });
          }

          if (existing.data?.last_event_id === event.id) {
            return jsonResponse({ received: true, duplicate: true });
          }

          const subscriptionId =
            typeof session.subscription === "string"
              ? session.subscription
              : session.subscription?.id ?? null;

          const customerId =
            typeof session.customer === "string"
              ? session.customer
              : session.customer?.id ?? null;

          const { error } = await supabaseAdmin
            .from("support_us")
            .upsert(
              {
                user_id: userId,
                stripe_customer_id: customerId,
                stripe_subscription_id: subscriptionId,
                stripe_checkout_session_id: session.id,
                status: "incomplete",
                last_event_id: event.id,
                last_event_type: event.type,
              },
              { onConflict: "user_id" },
            );

          if (error) {
            console.error("checkout.session.completed upsert error:", error);
            return new Response("DB write error", { status: 500 });
          }
        }
      }

      return jsonResponse({ received: true });
    }

    // -------- customer.subscription.* --------
    if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      const subscription = event.data.object as Stripe.Subscription;

      const userId = subscription.metadata?.user_id;
      const kind = subscription.metadata?.kind;

      if (userId && kind === "support_us") {
        const existing = await supabaseAdmin
          .from("support_us")
          .select("last_event_id")
          .eq("user_id", userId)
          .maybeSingle();

        if (existing.error) {
          console.error("Error reading support_us for dedupe:", existing.error);
          return new Response("DB read error", { status: 500 });
        }

        if (existing.data?.last_event_id === event.id) {
          return jsonResponse({ received: true, duplicate: true });
        }

        const firstItem = subscription.items.data[0];
        const priceId = firstItem?.price?.id ?? null;

        const payload = {
          user_id: userId,
          stripe_customer_id:
            typeof subscription.customer === "string"
              ? subscription.customer
              : subscription.customer?.id ?? null,
          stripe_subscription_id: subscription.id,
          stripe_price_id: priceId,
          status: subscription.status,
          cancel_at_period_end: subscription.cancel_at_period_end ?? false,
          current_period_start: toIsoOrNull(firstItem?.current_period_start),
          current_period_end: toIsoOrNull(firstItem?.current_period_end),
          last_event_id: event.id,
          last_event_type: event.type,
        };

        const { error } = await supabaseAdmin
          .from("support_us")
          .upsert(payload, { onConflict: "user_id" });

        if (error) {
          console.error("customer.subscription upsert error:", error);
          return new Response("DB write error", { status: 500 });
        }
      }

      return jsonResponse({ received: true });
    }

    // -------- invoice.payment_failed (optional but useful) --------
    if (event.type === "invoice.payment_failed") {
      const invoice = event.data.object as Stripe.Invoice;
      const subscriptionId =
        typeof invoice.subscription === "string"
          ? invoice.subscription
          : invoice.subscription?.id ?? null;

      if (subscriptionId) {
        const { data: support, error: findError } = await supabaseAdmin
          .from("support_us")
          .select("user_id, last_event_id")
          .eq("stripe_subscription_id", subscriptionId)
          .maybeSingle();

        if (findError) {
          console.error("invoice.payment_failed read error:", findError);
          return new Response("DB read error", { status: 500 });
        }

        if (support?.last_event_id === event.id) {
          return jsonResponse({ received: true, duplicate: true });
        }

        if (support?.user_id) {
          const { error } = await supabaseAdmin
            .from("support_us")
            .update({
              status: "past_due",
              last_event_id: event.id,
              last_event_type: event.type,
            })
            .eq("user_id", support.user_id);

          if (error) {
            console.error("invoice.payment_failed update error:", error);
            return new Response("DB write error", { status: 500 });
          }
        }
      }

      return jsonResponse({ received: true });
    }

    // -------- invoice.paid (optional but useful) --------
    if (event.type === "invoice.paid") {
      const invoice = event.data.object as Stripe.Invoice;
      const subscriptionId =
        typeof invoice.subscription === "string"
          ? invoice.subscription
          : invoice.subscription?.id ?? null;

      if (subscriptionId) {
        const { data: support, error: findError } = await supabaseAdmin
          .from("support_us")
          .select("user_id, last_event_id")
          .eq("stripe_subscription_id", subscriptionId)
          .maybeSingle();

        if (findError) {
          console.error("invoice.paid read error:", findError);
          return new Response("DB read error", { status: 500 });
        }

        if (support?.last_event_id === event.id) {
          return jsonResponse({ received: true, duplicate: true });
        }

        if (support?.user_id) {
          const { error } = await supabaseAdmin
            .from("support_us")
            .update({
              status: "active",
              last_event_id: event.id,
              last_event_type: event.type,
            })
            .eq("user_id", support.user_id);

          if (error) {
            console.error("invoice.paid update error:", error);
            return new Response("DB write error", { status: 500 });
          }
        }
      }

      return jsonResponse({ received: true });
    }

    return jsonResponse({
      received: true,
      ignored: true,
      event_type: event.type,
    });
  } catch (error) {
    console.error("stripe-webhook fatal error:", error);
    return new Response("Webhook error", { status: 400 });
  }
});