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
  "OP_SUPABASE_SERVICE_ROLE_KEY",
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

  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path.replace(/^\//, "")}`, {
    ...init,
    headers,
  });

  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (!res.ok) {
    throw new Error(
      `Supabase error ${res.status}: ${json?.message || json?.error || JSON.stringify(json)}`,
    );
  }
  return json;
}

// ---------- Helpers: Stripe REST (supports Connect) ----------
function toFormBody(params: Record<string, string>) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) body.append(k, v);
  return body;
}

async function stripeGET(path: string, stripeAccount?: string | null) {
  const headers: Record<string, string> = { Authorization: `Bearer ${STRIPE_SECRET_KEY}` };
  if (stripeAccount) headers["Stripe-Account"] = stripeAccount;

  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "GET",
    headers,
  });

  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error?.message ?? JSON.stringify(j));
  return j;
}

async function stripePOST(path: string, params: Record<string, string>, stripeAccount?: string | null) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (stripeAccount) headers["Stripe-Account"] = stripeAccount;

  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers,
    body: toFormBody(params),
  });

  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error?.message ?? JSON.stringify(j));
  return j;
}

// ---------- Stripe signature verification (HMAC SHA256) ----------
function parseStripeSigHeader(sigHeader: string) {
  const parts = (sigHeader || "").split(",").map((s) => s.trim());
  const t = parts.find((p) => p.startsWith("t="))?.split("=")[1]?.trim();
  const v1s = parts
    .filter((p) => p.startsWith("v1="))
    .map((p) => p.split("=")[1]?.trim())
    .filter(Boolean) as string[];
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
    ["sign"],
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
  if (s === "past_due") return "past_due";
  if (s === "unpaid") return "unpaid";
  if (s === "canceled") return "canceled";
  if (s === "incomplete" || s === "incomplete_expired") return "incomplete";
  return s || "unknown";
}

function mapCreatorPlanStatusToDb(status: string) {
  const s = (status || "").toLowerCase();
  if (s === "active" || s === "trialing") return "active";
  if (s === "canceled") return "canceled";
  if (s === "incomplete" || s === "incomplete_expired") return "canceled";
  if (s === "past_due" || s === "unpaid") return "canceled";
  return s || "canceled";
}

function hasActiveAccess(status: string, currentPeriodEndIso: string | null) {
  const st = (status || "").toLowerCase();
  if (st === "active") return true;
  if (st !== "canceled") return false;
  if (!currentPeriodEndIso) return false;
  return new Date(currentPeriodEndIso).getTime() > Date.now();
}

// ---------- DB upserts (IMPORTANT: now also updates fan_subscriptions) ----------
async function upsertCreatorSubscriptionRow(row: {
  fan_id: string;
  creator_id: string;
  status: string;
  is_active: boolean;
  cancel_at_period_end: boolean;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_end: string | null;
  creator_plan_id?: string | null;
}) {
  await sbAdmin(`creator_subscriptions?on_conflict=fan_id,creator_id`, {
    method: "POST",
    body: JSON.stringify([
      {
        fan_id: row.fan_id,
        creator_id: row.creator_id,
        status: row.status,
        is_active: row.is_active,
        cancel_at_period_end: row.cancel_at_period_end,
        stripe_customer_id: row.stripe_customer_id,
        stripe_subscription_id: row.stripe_subscription_id,
        current_period_end: row.current_period_end,
        creator_plan_id: row.creator_plan_id ?? null,
        updated_at: new Date().toISOString(),
      },
    ]),
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
  });
}

async function deleteCreatorSubscriptionByStripeSubId(subId: string) {
  await sbAdmin(`creator_subscriptions?stripe_subscription_id=eq.${subId}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  });
}

async function upsertFanSubscriptionRow(row: {
  fan_id: string;
  creator_id: string;
  plan_id: string | null;
  status: string;
  cancel_at_period_end: boolean;
  provider_customer_id: string | null;
  provider_subscription_id: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  canceled_at?: string | null;
}) {
  await sbAdmin(`fan_subscriptions?on_conflict=fan_id,creator_id`, {
    method: "POST",
    body: JSON.stringify([
      {
        fan_id: row.fan_id,
        creator_id: row.creator_id,
        plan_id: row.plan_id,
        status: row.status,
        cancel_at_period_end: row.cancel_at_period_end,
        payment_provider: "stripe",
        provider_customer_id: row.provider_customer_id,
        provider_subscription_id: row.provider_subscription_id,
        current_period_start: row.current_period_start,
        current_period_end: row.current_period_end,
        canceled_at: row.canceled_at ?? null,
        updated_at: new Date().toISOString(),
      },
    ]),
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
  });
}

async function deleteFanSubscriptionByStripeSubId(subId: string) {
  await sbAdmin(`fan_subscriptions?provider_subscription_id=eq.${subId}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  });
}

async function upsertEntitlement(row: {
  user_id: string;
  key: string;
  status: string;
  creator_id?: string | null;
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
  current_period_end?: string | null;
}) {
  await sbAdmin(`entitlements?on_conflict=user_id,key,creator_id`, {
    method: "POST",
    body: JSON.stringify([
      {
        user_id: row.user_id,
        key: row.key,
        status: row.status,
        creator_id: row.creator_id ?? null,
        stripe_customer_id: row.stripe_customer_id ?? null,
        stripe_subscription_id: row.stripe_subscription_id ?? null,
        current_period_end: row.current_period_end ?? null,
        updated_at: new Date().toISOString(),
      },
    ]),
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
  });
}

async function deleteEntitlementByStripeSubId(subId: string) {
  await sbAdmin(`entitlements?stripe_subscription_id=eq.${subId}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  });
}

// ---- DIRECT: creator id lookup by price must use mapping table ----
async function findCreatorIdByPriceId(priceId: string, stripeAccountId: string | null): Promise<string | null> {
  if (!stripeAccountId) return null;
  try {
    const rows = await sbAdmin(
      `creator_plan_stripe_prices?select=creator_id&stripe_account_id=eq.${encodeURIComponent(
        stripeAccountId,
      )}&stripe_price_id=eq.${encodeURIComponent(priceId)}&limit=1`,
      { method: "GET" },
    );
    const r = Array.isArray(rows) ? rows[0] : null;
    return safeStr(r?.creator_id) || null;
  } catch {
    return null;
  }
}

async function findCreatorIdBySubscription(sub: any, stripeAccountId: string | null): Promise<string | null> {
  // prefer metadata creator_id
  const metaCreatorId = safeStr(sub?.metadata?.creator_id);
  if (metaCreatorId) return metaCreatorId;

  // fallback to mapping by price id (DIRECT)
  const item0 = sub?.items?.data?.[0];
  const priceId = safeStr(item0?.price?.id) || safeStr(item0?.price);
  if (priceId) return await findCreatorIdByPriceId(priceId, stripeAccountId);

  return null;
}

async function findFanIdByCustomerId(customerId: string): Promise<string | null> {
  try {
    const rows = await sbAdmin(
      `profiles?select=user_id&stripe_customer_id=eq.${encodeURIComponent(customerId)}&limit=1`,
      { method: "GET" },
    );
    const r = Array.isArray(rows) ? rows[0] : null;
    return safeStr(r?.user_id) || null;
  } catch {
    return null;
  }
}

async function upsertFromStripeSubscription(sub: any, stripeAccountId: string | null) {
  // sometimes event.data.object is partial
  let s = sub;

  const customerId = safeStr(s?.customer) || safeStr(s?.customer?.id) || null;
  const stripeSubId = safeStr(s?.id) || null;

  const missingCpe =
    stripeSubId &&
    s?.current_period_end == null &&
    s?.cancel_at == null &&
    s?.ended_at == null;

  if (missingCpe && stripeSubId) {
    s = await stripeGET(`subscriptions/${stripeSubId}`, stripeAccountId);
  }

  const creatorId = await findCreatorIdBySubscription(s, stripeAccountId);
  if (!creatorId) return;

  let fanId = safeStr(s?.metadata?.fan_id);
  if (!fanId && customerId) fanId = (await findFanIdByCustomerId(customerId)) || "";
  if (!fanId) return;

  const planId = safeStr(s?.metadata?.plan_id) || null;

  const stripeStatus = String(s?.status || "incomplete");
  let statusDb = mapStatusToDb(stripeStatus);

  const cancelAtPeriodEnd = Boolean(s?.cancel_at_period_end);

  const cps = isoFromUnix((s?.current_period_start ?? null) ?? null);
  const cpe = isoFromUnix((s?.current_period_end ?? s?.cancel_at ?? s?.ended_at) ?? null);

  // normalize
  const cpeMs = cpe ? new Date(cpe).getTime() : 0;
  const hasAccessUntilEnd = !!cpeMs && cpeMs > Date.now();
  if (hasAccessUntilEnd && statusDb === "canceled") statusDb = "active";

  const isActive = hasAccessUntilEnd || hasActiveAccess(statusDb, cpe);

  // ✅ update BOTH tables
  await upsertCreatorSubscriptionRow({
    fan_id: fanId,
    creator_id: creatorId,
    status: statusDb,
    is_active: isActive,
    cancel_at_period_end: cancelAtPeriodEnd,
    stripe_customer_id: customerId,
    stripe_subscription_id: stripeSubId,
    current_period_end: cpe,
  });

  await upsertFanSubscriptionRow({
    fan_id: fanId,
    creator_id: creatorId,
    plan_id: planId,
    status: statusDb,
    cancel_at_period_end: cancelAtPeriodEnd,
    provider_customer_id: customerId,
    provider_subscription_id: stripeSubId,
    current_period_start: cps,
    current_period_end: cpe,
    canceled_at: statusDb === "canceled" ? new Date().toISOString() : null,
  });

  await upsertEntitlement({
    user_id: fanId,
    key: "subscription",
    status: statusDb,
    creator_id: creatorId,
    stripe_customer_id: customerId,
    stripe_subscription_id: stripeSubId,
    current_period_end: cpe,
  });
}

async function deleteFromStripeSubscription(sub: any) {
  const stripeSubId = safeStr(sub?.id);
  if (!stripeSubId) return;

  await deleteCreatorSubscriptionByStripeSubId(stripeSubId);
  await deleteFanSubscriptionByStripeSubId(stripeSubId);
  await deleteEntitlementByStripeSubId(stripeSubId);
}

async function markCreatorPlanExpired(user_id: string) {
  await sbAdmin(`entitlements?user_id=eq.${user_id}&key=eq.creator_plan`, {
    method: "PATCH",
    body: JSON.stringify({
      status: "expired",
      current_period_end: null,
      cancel_at_period_end: false,
      updated_at: new Date().toISOString(),
    }),
    headers: { Prefer: "return=minimal" },
  });
}

async function upsertCreatorPlanEntitlement(row: {
  user_id: string;
  status: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
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
        cancel_at_period_end: row.cancel_at_period_end,
        updated_at: new Date().toISOString(),
      },
    ]),
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
  });
}

async function findUserIdByCreatorPlanSubscriptionId(subId: string): Promise<string | null> {
  try {
    const rows = await sbAdmin(
      `entitlements?select=user_id&key=eq.creator_plan&stripe_subscription_id=eq.${subId}&limit=1`,
      { method: "GET" },
    );
    const r = Array.isArray(rows) ? rows[0] : null;
    return safeStr(r?.user_id) || null;
  } catch {
    return null;
  }
}

// ---------- Handler ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });

  const sig = req.headers.get("stripe-signature") || "";
  const rawBody = await req.text();

  try {
    const ok = await verifyStripeSignature(rawBody, sig, STRIPE_WEBHOOK_SECRET);
    if (!ok) return new Response("Invalid signature", { status: 400, headers: corsHeaders });

    const event = JSON.parse(rawBody || "{}");
    const type = safeStr(event?.type);
    const obj = event?.data?.object;

    // ✅ CONNECT: which connected account emitted this event
    const stripeAccountId =
      safeStr(event?.account) || safeStr(req.headers.get("stripe-account")) || null;

    // checkout.session.completed (subscription purchase)
    if (type === "checkout.session.completed") {
      const session = obj;
      const mode = safeStr(session?.mode);
      if (mode !== "subscription") return new Response("ok", { status: 200, headers: corsHeaders });

      const subscriptionId = safeStr(session?.subscription);
      if (!subscriptionId) return new Response("ok", { status: 200, headers: corsHeaders });

      // fetch subscription ON CONNECTED
      const sub = await stripeGET(`subscriptions/${subscriptionId}`, stripeAccountId);

      // creator plan flow (metadata.user_id present)
      const user_id = safeStr(sub?.metadata?.user_id);
      const isCreatorPlan = !!user_id && safeStr(sub?.metadata?.key) === "creator_plan";

      if (isCreatorPlan) {
        const customerId = safeStr(sub?.customer) || safeStr(sub?.customer?.id) || null;
        const stripeStatus = String(sub?.status || "incomplete");
        const statusDb = mapCreatorPlanStatusToDb(stripeStatus);
        const cpe = isoFromUnix((sub?.current_period_end ?? sub?.cancel_at ?? sub?.ended_at) ?? null);

        await upsertCreatorPlanEntitlement({
          user_id,
          status: statusDb,
          stripe_customer_id: customerId,
          stripe_subscription_id: safeStr(sub?.id) || null,
          current_period_end: cpe,
          cancel_at_period_end: Boolean(sub?.cancel_at_period_end),
        });

        return new Response("ok", { status: 200, headers: corsHeaders });
      }

      // fan subscribes to creator
      await upsertFromStripeSubscription(sub, stripeAccountId);
      return new Response("ok", { status: 200, headers: corsHeaders });
    }

    // customer.subscription.created / updated
    if (type === "customer.subscription.created" || type === "customer.subscription.updated") {
      const subId = safeStr(obj?.id);
      const hasCpe = obj?.current_period_end != null;
      const sub = subId && !hasCpe ? await stripeGET(`subscriptions/${subId}`, stripeAccountId) : obj;

      const user_id =
        safeStr(sub?.metadata?.user_id) || (subId ? await findUserIdByCreatorPlanSubscriptionId(subId) : null);

      if (user_id) {
        const customerId = safeStr(sub?.customer) || safeStr(sub?.customer?.id) || null;
        const stripeStatus = String(sub?.status || "incomplete");
        const statusDb = mapCreatorPlanStatusToDb(stripeStatus);
        const cpe = isoFromUnix((sub?.current_period_end ?? sub?.cancel_at ?? sub?.ended_at) ?? null);

        await upsertCreatorPlanEntitlement({
          user_id,
          status: statusDb,
          stripe_customer_id: customerId,
          stripe_subscription_id: safeStr(sub?.id) || null,
          current_period_end: cpe,
          cancel_at_period_end: Boolean(sub?.cancel_at_period_end),
        });

        return new Response("ok", { status: 200, headers: corsHeaders });
      }

      await upsertFromStripeSubscription(sub, stripeAccountId);
      return new Response("ok", { status: 200, headers: corsHeaders });
    }

    // invoice events (ignored for now)
    if (
      type === "invoice.payment_succeeded" ||
      type === "invoice.payment_failed" ||
      type === "invoice.finalized" ||
      type === "invoice.paid"
    ) {
      return new Response("ok", { status: 200, headers: corsHeaders });
    }

    // customer.subscription.deleted
    if (type === "customer.subscription.deleted") {
      const subId = safeStr(obj?.id);
      const user_id =
        safeStr(obj?.metadata?.user_id) || (subId ? await findUserIdByCreatorPlanSubscriptionId(subId) : null);

      if (user_id) {
        await markCreatorPlanExpired(user_id);
        return new Response("ok", { status: 200, headers: corsHeaders });
      }

      await deleteFromStripeSubscription(obj);
      return new Response("ok", { status: 200, headers: corsHeaders });
    }

    return new Response("ok", { status: 200, headers: corsHeaders });
  } catch (e) {
    console.error("stripe-webhook error:", e);
    return new Response(String((e as any)?.message || e), { status: 500, headers: corsHeaders });
  }
});