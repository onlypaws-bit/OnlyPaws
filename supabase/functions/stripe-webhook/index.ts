// supabase/functions/stripe-webhook/index.ts

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, stripe-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function env(...keys: string[]) {
  for (const k of keys) {
    const v = Deno.env.get(k);
    if (v && v.trim().length) return v;
  }
  return "";
}

const STRIPE_SECRET_KEY = env("STRIPE_SECRET_KEY", "OP_STRIPE_SECRET_KEY");
const STRIPE_WEBHOOK_SECRET = env("STRIPE_WEBHOOK_SECRET", "OP_STRIPE_WEBHOOK_SECRET");
const SUPABASE_URL = env("SUPABASE_URL", "OP_SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = env(
  "SUPABASE_SERVICE_ROLE_KEY",
  "OP_SUPABASE_SERVICE_ROLE_KEY"
);

if (!STRIPE_SECRET_KEY) throw new Error("Missing STRIPE_SECRET_KEY / OP_STRIPE_SECRET_KEY");
if (!STRIPE_WEBHOOK_SECRET)
  throw new Error("Missing STRIPE_WEBHOOK_SECRET / OP_STRIPE_WEBHOOK_SECRET");
if (!SUPABASE_URL) throw new Error("Missing SUPABASE_URL / OP_SUPABASE_URL");
if (!SUPABASE_SERVICE_ROLE_KEY)
  throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY / OP_SUPABASE_SERVICE_ROLE_KEY");

// ---------- Helpers: Supabase REST (service role) ----------
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

// ---------- Helpers: Stripe API via fetch ----------
function toForm(params: Record<string, string>) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) body.append(k, v);
  return body;
}

async function stripeGET(path: string) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` },
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error?.message ?? JSON.stringify(j));
  return j;
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

// ---------- Helpers: Stripe signature verification (Web Crypto) ----------
function parseStripeSigHeader(sig: string) {
  // format: t=timestamp,v1=signature[,v1=...]
  const parts = sig.split(",").map((s) => s.trim());
  const t = parts.find((p) => p.startsWith("t="))?.slice(2) ?? "";
  const v1s = parts.filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  return { t, v1s };
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

async function hmacSHA256Hex(secret: string, message: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  const bytes = new Uint8Array(sig);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function verifyStripeSignature(rawBody: string, sigHeader: string, secret: string) {
  const { t, v1s } = parseStripeSigHeader(sigHeader);
  if (!t || !v1s.length) return false;
  const signedPayload = `${t}.${rawBody}`;
  const expected = await hmacSHA256Hex(secret, signedPayload);
  return v1s.some((v1) => timingSafeEqual(v1, expected));
}

// ---------- Domain helpers ----------
function safeStr(x: unknown) {
  return (typeof x === "string" ? x : "").trim();
}

function isoFromUnix(sec?: number | null) {
  if (!sec) return null;
  return new Date(sec * 1000).toISOString();
}

function mapStatusToDb(status: string) {
  const s = (status || "").toLowerCase();
  if (s === "active" || s === "trialing") return "active";
  if (s === "past_due" || s === "unpaid") return "past_due";
  if (s === "canceled") return "canceled";
  if (s === "incomplete_expired" || s === "incomplete") return "expired";
  if (s === "paused") return "past_due";
  return "past_due";
}

async function upsertCreatorSubscriptionRow(row: {
  fan_id: string;
  creator_id: string;
  status: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_end: string | null;
}) {
  await sbAdmin(`creator_subscriptions`, {
    method: "POST",
    body: JSON.stringify([
      {
        fan_id: row.fan_id,
        creator_id: row.creator_id,
        status: row.status,
        is_active: row.status === "active",
        current_period_end: row.current_period_end,
        stripe_customer_id: row.stripe_customer_id,
        stripe_subscription_id: row.stripe_subscription_id,
        updated_at: new Date().toISOString(),
      },
    ]),
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
  });
}

async function cancelByStripeSubscriptionId(stripeSubId: string) {
  await sbAdmin(`creator_subscriptions?stripe_subscription_id=eq.${stripeSubId}`, {
    method: "PATCH",
    body: JSON.stringify({
      status: "canceled",
      is_active: false,
      updated_at: new Date().toISOString(),
    }),
    headers: { Prefer: "return=minimal" },
  });
}

async function upsertFromStripeSubscription(sub: any) {
  const fan_id = safeStr(sub?.metadata?.fan_id);
  const creator_id = safeStr(sub?.metadata?.creator_id);

  if (!fan_id || !creator_id) {
    console.warn("Missing metadata on subscription", sub?.id, sub?.metadata);
    return;
  }

  const customerId = safeStr(sub?.customer) || safeStr(sub?.customer?.id) || null;
  const statusDb = mapStatusToDb(String(sub?.status || "past_due"));
  const cpe = isoFromUnix(sub?.current_period_end ?? null);

  await upsertCreatorSubscriptionRow({
    fan_id,
    creator_id,
    status: statusDb,
    stripe_customer_id: customerId,
    stripe_subscription_id: safeStr(sub?.id) || null,
    current_period_end: cpe,
  });
}

async function patchSubscriptionMetadata(subId: string, fan_id: string, creator_id: string) {
  // Stripe: POST /v1/subscriptions/{id} with metadata[fan_id], metadata[creator_id]
  await stripePOST(`subscriptions/${subId}`, {
    "metadata[fan_id]": fan_id,
    "metadata[creator_id]": creator_id,
  });
}

// ---------- Handler ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });

  try {
    const sig = req.headers.get("stripe-signature");
    if (!sig) return new Response("Missing stripe-signature", { status: 400, headers: corsHeaders });

    // MUST be raw body
    const rawBody = await req.text();

    const ok = await verifyStripeSignature(rawBody, sig, STRIPE_WEBHOOK_SECRET);
    if (!ok) {
      return new Response("Webhook Error: invalid signature", { status: 400, headers: corsHeaders });
    }

    const event = JSON.parse(rawBody);
    const type = safeStr(event?.type);
    const obj = event?.data?.object;

    // ---- CONNECT: account.updated ----
    if (type === "account.updated") {
      const acctId = safeStr(obj?.id);
      const chargesEnabled = !!obj?.charges_enabled;
      const payoutsEnabled = !!obj?.payouts_enabled;
      const onboardingDone = chargesEnabled && payoutsEnabled;

      if (acctId) {
        let profArr = await sbAdmin(
          `profiles?select=user_id&stripe_connect_account_id=eq.${acctId}`,
          { method: "GET" }
        );
        let prof = Array.isArray(profArr) ? profArr[0] : null;

        if (!prof?.user_id) {
          profArr = await sbAdmin(`profiles?select=user_id&stripe_account_id=eq.${acctId}`, {
            method: "GET",
          });
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
              body: JSON.stringify([
                {
                  user_id: userId,
                  key: "payouts_enabled",
                  status: "active",
                  updated_at: new Date().toISOString(),
                },
              ]),
              headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
            });
          }
        }
      }

      return new Response("ok", { status: 200, headers: corsHeaders });
    }

    // ---- SUBSCRIPTIONS ----

    // checkout.session.completed
    if (type === "checkout.session.completed") {
      const mode = safeStr(obj?.mode);
      if (mode !== "subscription") return new Response("ok", { status: 200, headers: corsHeaders });

      const subId = safeStr(obj?.subscription);
      if (!subId) return new Response("ok", { status: 200, headers: corsHeaders });

      const fan_id = safeStr(obj?.metadata?.fan_id);
      const creator_id = safeStr(obj?.metadata?.creator_id);

      // If we have metadata on session, patch it onto subscription
      if (fan_id && creator_id) {
        try {
          await patchSubscriptionMetadata(subId, fan_id, creator_id);
        } catch (e) {
          console.warn("Failed to patch sub metadata", subId, String((e as any)?.message ?? e));
        }
      }

      const sub = await stripeGET(`subscriptions/${subId}`);
      await upsertFromStripeSubscription(sub);

      return new Response("ok", { status: 200, headers: corsHeaders });
    }

    // customer.subscription.created / updated
    if (type === "customer.subscription.created" || type === "customer.subscription.updated") {
      await upsertFromStripeSubscription(obj);
      return new Response("ok", { status: 200, headers: corsHeaders });
    }

    // invoice events (your Stripe UI)
    if (type === "invoice_payment.paid" || type === "invoice.payment_succeeded") {
      const subId = safeStr(obj?.subscription);
      if (subId) {
        const sub = await stripeGET(`subscriptions/${subId}`);
        await upsertFromStripeSubscription(sub);
      }
      return new Response("ok", { status: 200, headers: corsHeaders });
    }

    // customer.subscription.deleted
    if (type === "customer.subscription.deleted") {
      const subId = safeStr(obj?.id);
      if (subId) await cancelByStripeSubscriptionId(subId);
      return new Response("ok", { status: 200, headers: corsHeaders });
    }

    // ignore others
    return new Response("ok", { status: 200, headers: corsHeaders });
  } catch (e) {
    console.error(e);
    return new Response(`Server Error: ${(e as any)?.message ?? String(e)}`, {
      status: 500,
      headers: corsHeaders,
    });
  }
});
