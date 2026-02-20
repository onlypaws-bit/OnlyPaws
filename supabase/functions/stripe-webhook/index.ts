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
  const inHeaders = (init.headers || {}) as Record<string, string>;
  const headers: Record<string, string> = { ...inHeaders };

  if (!headers["Prefer"]) headers["Prefer"] = "return=representation";
  if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";

  headers["apikey"] = SUPABASE_SERVICE_ROLE_KEY;
  headers["Authorization"] = `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`;

  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers,
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

// ✅ (NEW) creator plan entitlement status mapper (keeps trialing)
function mapCreatorPlanStatusToDb(status: string) {
  const s = (status || "").toLowerCase();
  if (s === "active" || s === "trialing") return s; // keep trialing
  if (s === "canceled") return "canceled";
  if (s === "incomplete_expired" || s === "incomplete") return "expired";
  // default conservative: no access
  return "expired";
}

// ✅ (NEW) upsert entitlement helper (creator_plan only)
async function upsertCreatorPlanEntitlement(row: {
  user_id: string;
  status: string; // active | trialing | canceled | expired
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_end: string | null;
}) {
  await sbAdmin(`entitlements?on_conflict=user_id,key`, {
    method: "POST",
    body: JSON.stringify([
      {
        user_id: row.user_id,
        key: "creator_plan",
        status: row.status,
        stripe_customer_id: row.stripe_customer_id,
        stripe_subscription_id: row.stripe_subscription_id,
        current_period_end: row.current_period_end,
        updated_at: new Date().toISOString(),
      },
    ]),
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
  });
}

// ✅ (NEW) fetch user_id from entitlements by stripe_subscription_id (for subscription.updated/deleted)
async function findUserIdByCreatorPlanSubscriptionId(subId: string): Promise<string | null> {
  try {
    const rows = await sbAdmin(
      `entitlements?select=user_id&key=eq.creator_plan&stripe_subscription_id=eq.${subId}&limit=1`,
      { method: "GET" }
    );
    const r = Array.isArray(rows) ? rows[0] : null;
    return safeStr(r?.user_id) || null;
  } catch (_e) {
    return null;
  }
}

function isAccessActive(currentPeriodEndIso: string | null) {
  if (!currentPeriodEndIso) return true; // fallback (ma idealmente non succede)
  return new Date(currentPeriodEndIso).getTime() > Date.now();
}

async function upsertCreatorSubscriptionRow(row: {
  fan_id: string;
  creator_id: string;
  status: string;
  is_active: boolean;
  cancel_at_period_end: boolean;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_end: string | null;
}) {
  await sbAdmin(`creator_subscriptions?on_conflict=creator_id,fan_id`, {
    method: "POST",
    body: JSON.stringify([
      {
        fan_id: row.fan_id,
        creator_id: row.creator_id,
        status: row.status,
        is_active: row.is_active,
        cancel_at_period_end: row.cancel_at_period_end, // ✅ WRITE IT!
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
  // NOTE: deleted means ended now. We can also set current_period_end=now()
  await sbAdmin(`creator_subscriptions?stripe_subscription_id=eq.${stripeSubId}`, {
    method: "PATCH",
    body: JSON.stringify({
      status: "canceled",
      is_active: false,
      cancel_at_period_end: false,
      current_period_end: new Date().toISOString(),
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
  const stripeStatus = String(sub?.status || "past_due");

  const statusDb = mapStatusToDb(stripeStatus);

  // Always capture these
  const cancelAtPeriodEnd = !!sub?.cancel_at_period_end;
  const cpe = isoFromUnix(sub?.current_period_end ?? null);

  // Access rule: active until period end (and status not expired)
  // If Stripe doesn't send current_period_end (rare), this returns true, but we try to avoid null by fetching full sub where needed.
  const access = isAccessActive(cpe);

  // is_active means "user has access now"
  const isActiveNow =
    statusDb !== "expired" && (access || statusDb === "active" || statusDb === "past_due");

  await upsertCreatorSubscriptionRow({
    fan_id,
    creator_id,
    status: statusDb, // ✅ DO NOT turn scheduled cancel into status=canceled
    is_active: isActiveNow,
    cancel_at_period_end: cancelAtPeriodEnd, // ✅ real flag in DB
    stripe_customer_id: customerId,
    stripe_subscription_id: safeStr(sub?.id) || null,
    current_period_end: cpe,
  });
}

async function patchSubscriptionMetadata(subId: string, fan_id: string, creator_id: string) {
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

      // ✅ (NEW) creator plan checkout: metadata.user_id
      const user_id = safeStr(obj?.metadata?.user_id);

      // Keep your existing behavior for fan/creator metadata patch
      if (fan_id && creator_id) {
        try {
          await patchSubscriptionMetadata(subId, fan_id, creator_id);
        } catch (e) {
          console.warn("Failed to patch sub metadata", subId, String((e as any)?.message ?? e));
        }
      }

      const sub = await stripeGET(`subscriptions/${subId}`);

      // ✅ (NEW) If this checkout is for creator plan, write entitlement and exit.
      // (Does NOT affect your existing creator_subscriptions logic.)
      if (user_id) {
        const customerId = safeStr(sub?.customer) || safeStr(sub?.customer?.id) || null;
        const stripeStatus = String(sub?.status || "incomplete");
        const statusDb = mapCreatorPlanStatusToDb(stripeStatus);
        const cpe = isoFromUnix(sub?.current_period_end ?? null);

        await upsertCreatorPlanEntitlement({
          user_id,
          status: statusDb,
          stripe_customer_id: customerId,
          stripe_subscription_id: safeStr(sub?.id) || null,
          current_period_end: cpe,
        });

        return new Response("ok", { status: 200, headers: corsHeaders });
      }

      // Existing behavior: fan subscribes to creator
      await upsertFromStripeSubscription(sub);

      return new Response("ok", { status: 200, headers: corsHeaders });
    }

    // customer.subscription.created / updated
    if (type === "customer.subscription.created" || type === "customer.subscription.updated") {
      // sometimes obj is partial; if current_period_end missing, fetch full sub
      const subId = safeStr(obj?.id);
      const hasCpe = obj?.current_period_end != null;
      const sub = (subId && !hasCpe) ? await stripeGET(`subscriptions/${subId}`) : obj;

      // ✅ (NEW) If this is a creator plan subscription, update entitlement (keeps everything in sync)
      const user_id = safeStr(sub?.metadata?.user_id) || (subId ? await findUserIdByCreatorPlanSubscriptionId(subId) : null);
      if (user_id) {
        const customerId = safeStr(sub?.customer) || safeStr(sub?.customer?.id) || null;
        const stripeStatus = String(sub?.status || "incomplete");
        const statusDb = mapCreatorPlanStatusToDb(stripeStatus);
        const cpe = isoFromUnix(sub?.current_period_end ?? null);

        await upsertCreatorPlanEntitlement({
          user_id,
          status: statusDb,
          stripe_customer_id: customerId,
          stripe_subscription_id: safeStr(sub?.id) || null,
          current_period_end: cpe,
        });

        return new Response("ok", { status: 200, headers: corsHeaders });
      }

      // Existing behavior: fan subscribes to creator
      await upsertFromStripeSubscription(sub);
      return new Response("ok", { status: 200, headers: corsHeaders });
    }

    // invoice events
    if (
      type === "invoice_payment.paid" ||
      type === "invoice.payment_succeeded" ||
      type === "invoice.paid"
    ) {
      const subId = safeStr(obj?.subscription);
      if (subId) {
        const sub = await stripeGET(`subscriptions/${subId}`);

        // ✅ (NEW) If creator plan subscription, sync entitlement too
        const user_id = safeStr(sub?.metadata?.user_id) || await findUserIdByCreatorPlanSubscriptionId(subId);
        if (user_id) {
          const customerId = safeStr(sub?.customer) || safeStr(sub?.customer?.id) || null;
          const stripeStatus = String(sub?.status || "incomplete");
          const statusDb = mapCreatorPlanStatusToDb(stripeStatus);
          const cpe = isoFromUnix(sub?.current_period_end ?? null);

          await upsertCreatorPlanEntitlement({
            user_id,
            status: statusDb,
            stripe_customer_id: customerId,
            stripe_subscription_id: safeStr(sub?.id) || null,
            current_period_end: cpe,
          });

          return new Response("ok", { status: 200, headers: corsHeaders });
        }

        // Existing behavior: fan subscribes to creator
        await upsertFromStripeSubscription(sub);
      }
      return new Response("ok", { status: 200, headers: corsHeaders });
    }

    // customer.subscription.deleted
    if (type === "customer.subscription.deleted") {
      const subId = safeStr(obj?.id);
      if (subId) {
        // ✅ (NEW) If creator plan sub is deleted, mark entitlement canceled/expired
        const user_id = safeStr(obj?.metadata?.user_id) || await findUserIdByCreatorPlanSubscriptionId(subId);
        if (user_id) {
          const cpe = isoFromUnix(obj?.current_period_end ?? null) || new Date().toISOString();
          await upsertCreatorPlanEntitlement({
            user_id,
            status: "canceled",
            stripe_customer_id: safeStr(obj?.customer) || safeStr(obj?.customer?.id) || null,
            stripe_subscription_id: subId,
            current_period_end: cpe,
          });
          return new Response("ok", { status: 200, headers: corsHeaders });
        }

        // Existing behavior: fan subscribes to creator
        await cancelByStripeSubscriptionId(subId);
      }
      return new Response("ok", { status: 200, headers: corsHeaders });
    }

    return new Response("ok", { status: 200, headers: corsHeaders });
  } catch (e) {
    console.error(e);
    return new Response(`Server Error: ${(e as any)?.message ?? String(e)}`, {
      status: 500,
      headers: corsHeaders,
    });
  }
});
