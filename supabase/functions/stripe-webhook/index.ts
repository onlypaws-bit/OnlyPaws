// supabase/functions/stripe-webhook/index.ts
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";

const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;
const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

if (!STRIPE_SECRET_KEY) throw new Error("Missing STRIPE_SECRET_KEY");
if (!STRIPE_WEBHOOK_SECRET) throw new Error("Missing STRIPE_WEBHOOK_SECRET");
if (!SUPABASE_URL) throw new Error("Missing SUPABASE_URL");
if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, stripe-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function sbAdmin(path: string, init: RequestInit) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`SB ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

function isoFromUnix(sec?: number | null) {
  if (!sec) return null;
  return new Date(sec * 1000).toISOString();
}

function safeStr(x: unknown) {
  return (typeof x === "string" ? x : "").trim();
}

function mapStatusToDb(status: string) {
  // il tuo CHECK su subscriptions ammette: active, canceled, expired, past_due
  // stripe può avere: active, trialing, past_due, unpaid, canceled, incomplete, incomplete_expired, paused
  // mappiamo safe:
  const s = (status || "").toLowerCase();
  if (s === "active" || s === "trialing") return "active";
  if (s === "past_due" || s === "unpaid") return "past_due";
  if (s === "canceled") return "canceled";
  if (s === "incomplete_expired" || s === "incomplete") return "expired";
  if (s === "paused") return "past_due";
  return "past_due";
}

async function upsertSubscriptionRow(row: {
  fan_id: string;
  creator_id: string;
  plan_id: string;
  status: string;
  provider_customer_id: string | null;
  provider_subscription_id: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  payment_provider: "stripe";
  current_period_start: string;
  current_period_end: string;
  canceled_at: string | null;
}) {
  // NB: il tuo schema ha both stripe_* e provider_*; valorizziamo entrambi.
  await sbAdmin(`subscriptions`, {
    method: "POST",
    body: JSON.stringify([{
      fan_id: row.fan_id,
      creator_id: row.creator_id,
      plan_id: row.plan_id,
      status: row.status,
      stripe_customer_id: row.stripe_customer_id,
      stripe_subscription_id: row.stripe_subscription_id,
      provider_customer_id: row.provider_customer_id,
      provider_subscription_id: row.provider_subscription_id,
      payment_provider: row.payment_provider,
      current_period_start: row.current_period_start,
      current_period_end: row.current_period_end,
      canceled_at: row.canceled_at,
      updated_at: new Date().toISOString(),
    }]),
    headers: {
      // usa i vincoli unici che hai già (fan_id+creator_id) + provider_subscription_id
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
  });
}

async function cancelSubscriptionByProviderId(providerSubId: string) {
  await sbAdmin(`subscriptions?provider_subscription_id=eq.${providerSubId}`, {
    method: "PATCH",
    body: JSON.stringify({
      status: "canceled",
      canceled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
    headers: { Prefer: "return=minimal" },
  });
}

async function upsertFromStripeSubscription(sub: Stripe.Subscription) {
  const fan_id = safeStr(sub.metadata?.fan_id);
  const creator_id = safeStr(sub.metadata?.creator_id);
  const plan_id = safeStr(sub.metadata?.plan_id);

  if (!fan_id || !creator_id || !plan_id) {
    console.warn("Missing metadata on subscription", sub.id, sub.metadata);
    return;
  }

  const customerId =
    typeof sub.customer === "string" ? sub.customer : sub.customer?.id || null;

  const statusDb = mapStatusToDb(String(sub.status || "past_due"));
  const cps = isoFromUnix(sub.current_period_start)!;
  const cpe = isoFromUnix(sub.current_period_end)!;

  await upsertSubscriptionRow({
    fan_id,
    creator_id,
    plan_id,
    status: statusDb,
    provider_customer_id: customerId,
    provider_subscription_id: sub.id,
    stripe_customer_id: customerId,
    stripe_subscription_id: sub.id,
    payment_provider: "stripe",
    current_period_start: cps,
    current_period_end: cpe,
    canceled_at: isoFromUnix(sub.canceled_at ?? null),
  });
}

async function ensureMetadataOnStripeSubscriptionFromSession(session: Stripe.Checkout.Session) {
  // fallback: se la subscription su Stripe non ha metadata, proviamo a scriverla
  // (non sempre necessario, ma aiuta)
  const fan_id = safeStr(session.metadata?.fan_id);
  const creator_id = safeStr(session.metadata?.creator_id);
  const plan_id = safeStr(session.metadata?.plan_id);

  const subId =
    typeof session.subscription === "string"
      ? session.subscription
      : session.subscription?.id;

  if (!subId) return null;
  if (!fan_id || !creator_id || !plan_id) return await stripe.subscriptions.retrieve(subId);

  // patch metadata su subscription (safe) così poi invoice/sub.updated hanno tutto
  try {
    await stripe.subscriptions.update(subId, {
      metadata: {
        fan_id,
        creator_id,
        plan_id,
      },
    });
  } catch (e) {
    console.warn("Failed to patch subscription metadata", subId, (e as any)?.message || e);
  }

  return await stripe.subscriptions.retrieve(subId);
}

export default async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: corsHeaders });

  try {
    const sig = req.headers.get("stripe-signature");
    if (!sig) return new Response("Missing stripe-signature", { status: 400, headers: corsHeaders });

    // Stripe signature check vuole il raw body: usiamo arrayBuffer per essere robusti
    const raw = await req.arrayBuffer();
    const rawText = new TextDecoder().decode(new Uint8Array(raw));

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(rawText, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      return new Response(`Webhook Error: ${(err as Error).message}`, { status: 400, headers: corsHeaders });
    }

    // =========================
    // CONNECT: account.updated
    // =========================
    if (event.type === "account.updated") {
      const acct = event.data.object as Stripe.Account;

      const acctId = acct.id;
      const chargesEnabled = !!acct.charges_enabled;
      const payoutsEnabled = !!acct.payouts_enabled;
      const onboardingDone = chargesEnabled && payoutsEnabled;

      // prova prima stripe_connect_account_id, poi fallback stripe_account_id
      let profArr = await sbAdmin(
        `profiles?select=user_id&stripe_connect_account_id=eq.${acctId}`,
        { method: "GET" }
      );
      let prof = Array.isArray(profArr) ? profArr[0] : null;

      if (!prof?.user_id) {
        profArr = await sbAdmin(
          `profiles?select=user_id&stripe_account_id=eq.${acctId}`,
          { method: "GET" }
        );
        prof = Array.isArray(profArr) ? profArr[0] : null;
      }

      if (prof?.user_id) {
        const userId = prof.user_id;

        await sbAdmin(`profiles?user_id=eq.${userId}`, {
          method: "PATCH",
          body: JSON.stringify({
            charges_enabled: chargesEnabled,
            payouts_enabled: payoutsEnabled,
            stripe_onboarding_status: onboardingDone ? "completed" : "started",
          }),
          headers: { Prefer: "return=minimal" },
        });

        if (onboardingDone) {
          await sbAdmin(`entitlements`, {
            method: "POST",
            body: JSON.stringify([{
              user_id: userId,
              key: "payouts_enabled",
              status: "active",
              updated_at: new Date().toISOString(),
            }]),
            headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          });
        }
      }

      return new Response("ok", { status: 200, headers: corsHeaders });
    }

    // =========================
    // SUBSCRIPTIONS
    // =========================

    // 1) Checkout completed (fallback + metadata patch)
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode !== "subscription") {
        return new Response("ok", { status: 200, headers: corsHeaders });
      }

      const sub = await ensureMetadataOnStripeSubscriptionFromSession(session);
      if (sub) await upsertFromStripeSubscription(sub);

      return new Response("ok", { status: 200, headers: corsHeaders });
    }

    // 2) Subscription created/updated = fonte di verità
    if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated") {
      const sub = event.data.object as Stripe.Subscription;
      await upsertFromStripeSubscription(sub);
      return new Response("ok", { status: 200, headers: corsHeaders });
    }

    // 3) Invoice paid (rinnovi) — aggiorna period_end ecc
    if (event.type === "invoice.paid") {
      const inv = event.data.object as Stripe.Invoice;
      const subId =
        typeof inv.subscription === "string" ? inv.subscription : inv.subscription?.id;

      if (subId) {
        const sub = await stripe.subscriptions.retrieve(subId);
        await upsertFromStripeSubscription(sub);
      }
      return new Response("ok", { status: 200, headers: corsHeaders });
    }

    // 4) Subscription deleted
    if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object as Stripe.Subscription;
      await cancelSubscriptionByProviderId(sub.id);
      return new Response("ok", { status: 200, headers: corsHeaders });
    }

    // altri eventi ignorati
    return new Response("ok", { status: 200, headers: corsHeaders });
  } catch (e) {
    console.error(e);
    return new Response(`Server Error: ${(e as Error).message}`, { status: 500, headers: corsHeaders });
  }
};