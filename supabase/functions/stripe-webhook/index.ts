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

function getCustomerId(
  value: string | Stripe.Customer | Stripe.DeletedCustomer | null,
): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id ?? null;
}

function getSubscriptionId(
  value:
    | string
    | Stripe.Subscription
    | null,
): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id ?? null;
}

async function findSupportRecord(
  supabaseAdmin: ReturnType<typeof createClient>,
  params: {
    subscriptionId?: string | null;
    customerId?: string | null;
    userId?: string | null;
    email?: string | null;
  },
) {
  const { subscriptionId, customerId, userId, email } = params;

  if (subscriptionId) {
    const res = await supabaseAdmin
      .from("support_us")
      .select("*")
      .eq("stripe_subscription_id", subscriptionId)
      .maybeSingle();

    if (res.error) throw res.error;
    if (res.data) return res.data;
  }

  if (customerId) {
    const res = await supabaseAdmin
      .from("support_us")
      .select("*")
      .eq("stripe_customer_id", customerId)
      .maybeSingle();

    if (res.error) throw res.error;
    if (res.data) return res.data;
  }

  if (userId) {
    const res = await supabaseAdmin
      .from("support_us")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    if (res.error) throw res.error;
    if (res.data) return res.data;
  }

  if (email) {
    const res = await supabaseAdmin
      .from("support_us")
      .select("*")
      .eq("email", email)
      .is("user_id", null)
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (res.error) throw res.error;
    if (res.data) return res.data;
  }

  return null;
}

async function insertSupportRecord(
  supabaseAdmin: ReturnType<typeof createClient>,
  payload: Record<string, unknown>,
) {
  const { error } = await supabaseAdmin.from("support_us").insert(payload);
  if (error) throw error;
}

async function updateSupportRecordById(
  supabaseAdmin: ReturnType<typeof createClient>,
  id: number,
  payload: Record<string, unknown>,
) {
  const { error } = await supabaseAdmin
    .from("support_us")
    .update(payload)
    .eq("id", id);

  if (error) throw error;
}

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const stripeWebhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!stripeWebhookSecret || !supabaseUrl || !supabaseServiceRoleKey) {
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

      if (session.mode !== "subscription") {
        return jsonResponse({ received: true, ignored: true, reason: "not_subscription" });
      }

      const kind = session.metadata?.kind;
      if (kind !== "support_us") {
        return jsonResponse({ received: true, ignored: true, reason: "not_support_us" });
      }

      const userId = session.metadata?.user_id ?? null;
      const subscriptionId = getSubscriptionId(session.subscription);
      const customerId = getCustomerId(session.customer);
      const email =
        session.customer_details?.email?.trim().toLowerCase() ??
        session.customer_email?.trim().toLowerCase() ??
        null;

      const existing = await findSupportRecord(supabaseAdmin, {
        subscriptionId,
        customerId,
        userId,
        email,
      });

      if (existing?.last_event_id === event.id) {
        return jsonResponse({ received: true, duplicate: true });
      }

      const payload = {
        user_id: userId,
        email,
        stripe_customer_id: customerId,
        stripe_subscription_id: subscriptionId,
        stripe_checkout_session_id: session.id,
        status: "incomplete",
        last_event_id: event.id,
        last_event_type: event.type,
        updated_at: new Date().toISOString(),
      };

      if (existing?.id) {
        await updateSupportRecordById(supabaseAdmin, existing.id, payload);
      } else {
        await insertSupportRecord(supabaseAdmin, payload);
      }

      return jsonResponse({ received: true });
    }

    // -------- customer.subscription.created / updated / deleted --------
    if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      const subscription = event.data.object as Stripe.Subscription;

      const kind = subscription.metadata?.kind;
      if (kind !== "support_us") {
        return jsonResponse({ received: true, ignored: true, reason: "not_support_us" });
      }

      const userId = subscription.metadata?.user_id ?? null;
      const customerId = getCustomerId(subscription.customer);
      const subscriptionId = subscription.id;

      const firstItem = subscription.items.data[0];
      const priceId = firstItem?.price?.id ?? null;

      let email: string | null = null;
      if (customerId) {
        try {
          const customer = await stripe.customers.retrieve(customerId);
          if (!("deleted" in customer) || customer.deleted !== true) {
            email = customer.email?.trim().toLowerCase() ?? null;
          }
        } catch (err) {
          console.error("Failed retrieving customer for email:", err);
        }
      }

      const existing = await findSupportRecord(supabaseAdmin, {
        subscriptionId,
        customerId,
        userId,
        email,
      });

      if (existing?.last_event_id === event.id) {
        return jsonResponse({ received: true, duplicate: true });
      }

      const payload = {
        user_id: existing?.user_id ?? userId,
        email: existing?.email ?? email,
        stripe_customer_id: customerId,
        stripe_subscription_id: subscriptionId,
        stripe_price_id: priceId,
        status: subscription.status,
        cancel_at_period_end: subscription.cancel_at_period_end ?? false,
        current_period_start: toIsoOrNull(firstItem?.current_period_start),
        current_period_end: toIsoOrNull(firstItem?.current_period_end),
        last_event_id: event.id,
        last_event_type: event.type,
        updated_at: new Date().toISOString(),
      };

      if (existing?.id) {
        await updateSupportRecordById(supabaseAdmin, existing.id, payload);
      } else {
        await insertSupportRecord(supabaseAdmin, payload);
      }

      return jsonResponse({ received: true });
    }

    // -------- invoice.payment_failed --------
    if (event.type === "invoice.payment_failed") {
      const invoice = event.data.object as Stripe.Invoice;
      const subscriptionId = getSubscriptionId(invoice.subscription);

      if (!subscriptionId) {
        return jsonResponse({ received: true, ignored: true, reason: "no_subscription_id" });
      }

      const existing = await findSupportRecord(supabaseAdmin, {
        subscriptionId,
      });

      if (!existing) {
        return jsonResponse({ received: true, ignored: true, reason: "support_not_found" });
      }

      if (existing.last_event_id === event.id) {
        return jsonResponse({ received: true, duplicate: true });
      }

      await updateSupportRecordById(supabaseAdmin, existing.id, {
        status: "past_due",
        last_event_id: event.id,
        last_event_type: event.type,
        updated_at: new Date().toISOString(),
      });

      return jsonResponse({ received: true });
    }

    // -------- invoice.paid --------
    if (event.type === "invoice.paid") {
      const invoice = event.data.object as Stripe.Invoice;
      const subscriptionId = getSubscriptionId(invoice.subscription);

      if (!subscriptionId) {
        return jsonResponse({ received: true, ignored: true, reason: "no_subscription_id" });
      }

      const existing = await findSupportRecord(supabaseAdmin, {
        subscriptionId,
      });

      if (!existing) {
        return jsonResponse({ received: true, ignored: true, reason: "support_not_found" });
      }

      if (existing.last_event_id === event.id) {
        return jsonResponse({ received: true, duplicate: true });
      }

      await updateSupportRecordById(supabaseAdmin, existing.id, {
        status: "active",
        last_event_id: event.id,
        last_event_type: event.type,
        updated_at: new Date().toISOString(),
      });

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
