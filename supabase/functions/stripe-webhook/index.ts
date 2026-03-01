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

// Optional but strongly recommended (set in Supabase function env): a public landing URL
const BUSINESS_URL = env("BUSINESS_URL", "SITE_URL");

const STANDARD_PRODUCT_DESCRIPTION =
  "Creator account on OnlyPaws, a subscription platform dedicated to pet-related digital content. The creator shares safe-for-work pet photography, lifestyle updates, and educational content about animals. All products are digital subscriptions for pet content.";
const STANDARD_MCC = "5968"; // Direct Marketing - Continuity/Subscription Merchants

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

  const cleanPath = path.replace(/^\//, "");
  const res = await fetch(`https://api.stripe.com/v1/${cleanPath}`, {
    method: "GET",
    headers,
  });

  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error?.message ?? JSON.stringify(j));
  return j;
}

async function stripePOST(
  path: string,
  params: Record<string, string>,
  stripeAccount?: string | null,
) {
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

// ---------- Connect hardening ----------
async function ensureStandardBusinessProfile(accountObj: any) {
  const accountId = safeStr(accountObj?.id);
  if (!accountId) return;

  const currentDesc = safeStr(accountObj?.business_profile?.product_description);
  const currentUrl = safeStr(accountObj?.business_profile?.url);
  const currentMcc = safeStr(accountObj?.business_profile?.mcc);

  const targetUrl = (BUSINESS_URL || currentUrl || "").trim();

  const needsFix =
    currentDesc !== STANDARD_PRODUCT_DESCRIPTION ||
    (targetUrl && currentUrl !== targetUrl) ||
    currentMcc !== STANDARD_MCC;

  if (!needsFix) return;

  const params: Record<string, string> = {
    "business_profile[product_description]": STANDARD_PRODUCT_DESCRIPTION,
    "business_profile[mcc]": STANDARD_MCC,
  };
  if (targetUrl) params["business_profile[url]"] = targetUrl;

  await stripePOST(`accounts/${accountId}`, params);
}

// ---------- Stripe signature verification ----------
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

function isoFromUnix(sec?: any) {
  if (sec == null) return null;
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
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

// ---------- DB upserts (FAN ONLY) ----------
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
  // FAN ONLY: upsert by Stripe subscription id
  await sbAdmin(`fan_subscriptions?on_conflict=provider_subscription_id`, {
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
  // NOTE: some DBs don't have entitlements.creator_id (older schema).
  // We upsert only by user_id+key to stay compatible.
  await sbAdmin(`entitlements?on_conflict=user_id,key`, {
    method: "POST",
    body: JSON.stringify([
      {
        user_id: row.user_id,
        key: row.key,
        status: row.status,
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
async function findCreatorIdByPriceId(
  priceId: string,
  stripeAccountId: string | null,
): Promise<string | null> {
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

function normalizePeriod(
  cps: string | null,
  cpe: string | null,
): { cps: string | null; cpe: string | null } {
  // If end exists but start missing: set start to end - 60s so (end > start) passes.
  if (!cps && cpe) {
    const endMs = new Date(cpe).getTime();
    if (Number.isFinite(endMs) && endMs > 0) {
      return { cps: new Date(endMs - 60_000).toISOString(), cpe };
    }
  }

  if (cps && cpe) {
    const startMs = new Date(cps).getTime();
    const endMs = new Date(cpe).getTime();
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs <= startMs) {
      return { cps: new Date(endMs - 60_000).toISOString(), cpe };
    }
  }

  return { cps, cpe };
}

// --- Fallback helpers: derive current_period_end when Stripe doesn't send it ---
function addInterval(startIso: string, interval: string, count: number) {
  const d = new Date(startIso);
  const n = Math.max(1, Number(count) || 1);

  if (interval === "day") d.setUTCDate(d.getUTCDate() + n);
  else if (interval === "week") d.setUTCDate(d.getUTCDate() + 7 * n);
  else if (interval === "month") d.setUTCMonth(d.getUTCMonth() + n);
  else if (interval === "year") d.setUTCFullYear(d.getUTCFullYear() + n);
  else return null;

  const ms = d.getTime();
  return Number.isFinite(ms) ? d.toISOString() : null;
}

function deriveCpeFromRecurring(sub: any, cpsIso: string | null) {
  if (!cpsIso) return null;
  const item0 = sub?.items?.data?.[0];
  const recurring = item0?.price?.recurring;
  const interval = safeStr(recurring?.interval);
  const intervalCount = Number(recurring?.interval_count ?? 1);
  if (!interval) return null;
  return addInterval(cpsIso, interval, intervalCount);
}

// ✅ NEW: derive current_period_end from latest_invoice line periods
function deriveCpeFromLatestInvoice(sub: any) {
  const lines = sub?.latest_invoice?.lines?.data;
  if (!Array.isArray(lines) || !lines.length) return null;

  const ends = lines
    .map((l: any) => l?.period?.end)
    .filter((x: any) => typeof x === "number" && x > 0);

  if (!ends.length) return null;
  const maxEnd = Math.max(...ends);
  return isoFromUnix(maxEnd);
}

async function upsertFromStripeSubscription(sub: any, stripeAccountId: string | null) {
  // sometimes event.data.object is partial
  let s = sub;

  const customerId = safeStr(s?.customer) || safeStr(s?.customer?.id) || null;
  const stripeSubId = safeStr(s?.id) || null;

  // can't upsert without a stable key
  if (!stripeSubId) return;

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

  let cps = isoFromUnix((s?.current_period_start ?? null) ?? null);
  let cpe = isoFromUnix((s?.current_period_end ?? s?.cancel_at ?? s?.ended_at) ?? null);

  // normalize cps/cpe so DB constraint end > start never fails (when end exists)
  ({ cps, cpe } = normalizePeriod(cps, cpe));

  // ✅ IMPORTANT: DB constraint
  // (status in ['checkout_pending','incomplete'] => current_period_end MUST be NULL)
  if (statusDb === "incomplete" || statusDb === "checkout_pending") {
    cpe = null;
  } else {
    if (!cpe) {
      // last attempt: refetch full sub (sometimes object is partial)
      console.log("REFETCH sub", { stripeSubId, stripeAccountId });

      // ✅ Expand latest_invoice + lines so we can derive period end if Stripe omits it
      const full = await stripeGET(
        `subscriptions/${stripeSubId}?expand[]=latest_invoice&expand[]=latest_invoice.lines`,
        stripeAccountId,
      );

      const cpe2 = isoFromUnix((full?.current_period_end ?? full?.cancel_at ?? full?.ended_at) ?? null);
      const cps2 = isoFromUnix((full?.current_period_start ?? null) ?? null);

      if (!cps && cps2) cps = cps2;
      cpe = cpe2;

      ({ cps, cpe } = normalizePeriod(cps, cpe));

      // ✅ invoice fallback
      if (!cpe) {
        const fromInv = deriveCpeFromLatestInvoice(full);
        if (fromInv) {
          cpe = fromInv;
          ({ cps, cpe } = normalizePeriod(cps, cpe));
        }
      }

      // fallback: derive end from recurring price
      if (!cpe) {
        const derived = deriveCpeFromRecurring(full, cps);
        if (derived) {
          cpe = derived;
          ({ cps, cpe } = normalizePeriod(cps, cpe));
        }
      }
    }

    // still missing? bail out safely
    if (!cpe) {
      console.error("Missing current_period_end for non-incomplete status", {
        stripeSubId,
        statusDb,
        stripeStatus,
        stripeAccountId,
      });
      return;
    }
  }

  // normalize: if canceled but still access until cpe, treat as active for app access
  const cpeMs = cpe ? new Date(cpe).getTime() : 0;
  const hasAccessUntilEnd = !!cpeMs && cpeMs > Date.now();
  if (hasAccessUntilEnd && statusDb === "canceled") statusDb = "active";

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
}

async function deleteFromStripeSubscription(sub: any) {
  const stripeSubId = safeStr(sub?.id);
  if (!stripeSubId) return;

  await deleteFanSubscriptionByStripeSubId(stripeSubId);
  await deleteEntitlementByStripeSubId(stripeSubId);
}

// ---------- creator plan entitlement (kept, separate flow) ----------
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

    const stripeAccountId =
      safeStr(event?.account) || safeStr(req.headers.get("stripe-account")) || null;

    console.log("WEBHOOK META", {
      type,
      eventAccount: safeStr(event?.account),
      headerStripeAccount: safeStr(req.headers.get("stripe-account")),
      stripeAccountId,
    });

    if (type === "checkout.session.completed") {
      const session = obj;
      const mode = safeStr(session?.mode);
      if (mode !== "subscription") return new Response("ok", { status: 200, headers: corsHeaders });

      const subscriptionId = safeStr(session?.subscription);
      if (!subscriptionId) return new Response("ok", { status: 200, headers: corsHeaders });

      const sub = await stripeGET(`subscriptions/${subscriptionId}`, stripeAccountId);

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

      await upsertFromStripeSubscription(sub, stripeAccountId);
      return new Response("ok", { status: 200, headers: corsHeaders });
    }

    if (type === "customer.subscription.created" || type === "customer.subscription.updated") {
      const subId = safeStr(obj?.id);
      const hasCpe = obj?.current_period_end != null;
      const sub = subId && !hasCpe ? await stripeGET(`subscriptions/${subId}`, stripeAccountId) : obj;

      const user_id =
        safeStr(sub?.metadata?.user_id) ||
        (subId ? await findUserIdByCreatorPlanSubscriptionId(subId) : null);

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

    if (
      type === "invoice.payment_succeeded" ||
      type === "invoice.payment_failed" ||
      type === "invoice.finalized" ||
      type === "invoice.paid"
    ) {
      return new Response("ok", { status: 200, headers: corsHeaders });
    }

    if (type === "customer.subscription.deleted") {
      const subId = safeStr(obj?.id);
      const user_id =
        safeStr(obj?.metadata?.user_id) ||
        (subId ? await findUserIdByCreatorPlanSubscriptionId(subId) : null);

      if (user_id) {
        await markCreatorPlanExpired(user_id);
        return new Response("ok", { status: 200, headers: corsHeaders });
      }

      await deleteFromStripeSubscription(obj);
      return new Response("ok", { status: 200, headers: corsHeaders });
    }

    if (type === "account.updated") {
      await ensureStandardBusinessProfile(obj);
      return new Response("ok", { status: 200, headers: corsHeaders });
    }

    return new Response("ok", { status: 200, headers: corsHeaders });
  } catch (e) {
    console.error("stripe-webhook error:", e);
    // IMPORTANT: do not return 500 or Stripe will retry forever
    return new Response("ok", { status: 200, headers: corsHeaders });
  }
});