// supabase/functions/stripe-creator-plan-webhook/index.ts

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, stripe-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function env(...keys: string[]) {
  for (const k of keys) {
    const v = Deno.env.get(k);
    if (v && v.trim().length) return v.trim();
  }
  return "";
}

const STRIPE_SECRET_KEY = env("STRIPE_SECRET_KEY", "OP_STRIPE_SECRET_KEY");
const STRIPE_WEBHOOK_SECRET = env(
  "STRIPE_CREATOR_PLAN_WEBHOOK_SECRET",
  "OP_STRIPE_CREATOR_PLAN_WEBHOOK_SECRET",
  "STRIPE_WEBHOOK_SECRET",
  "OP_STRIPE_WEBHOOK_SECRET",
);
const SUPABASE_URL = env("SUPABASE_URL", "OP_SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = env(
  "SUPABASE_SERVICE_ROLE_KEY",
  "OP_SUPABASE_SERVICE_ROLE_KEY",
);

if (!STRIPE_SECRET_KEY) {
  throw new Error("Missing STRIPE_SECRET_KEY / OP_STRIPE_SECRET_KEY");
}
if (!STRIPE_WEBHOOK_SECRET) {
  throw new Error(
    "Missing STRIPE_CREATOR_PLAN_WEBHOOK_SECRET / OP_STRIPE_CREATOR_PLAN_WEBHOOK_SECRET / STRIPE_WEBHOOK_SECRET / OP_STRIPE_WEBHOOK_SECRET",
  );
}
if (!SUPABASE_URL) {
  throw new Error("Missing SUPABASE_URL / OP_SUPABASE_URL");
}
if (!SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY / OP_SUPABASE_SERVICE_ROLE_KEY");
}

// ---------- Helpers: Supabase REST ----------
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
      `Supabase error ${res.status}: ${
        json?.message || json?.error || JSON.stringify(json)
      }`,
    );
  }

  return json;
}

// ---------- Helpers: Stripe REST ----------
async function stripeGET(path: string, stripeAccount?: string | null) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
  };

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
  for (let i = 0; i < a.length; i++) {
    out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
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

function mapCreatorPlanStatusToDb(status: string) {
  const s = (status || "").toLowerCase();

  if (s === "active" || s === "trialing") return "active";
  if (s === "canceled") return "canceled";
  if (s === "incomplete" || s === "incomplete_expired") return "canceled";
  if (s === "past_due" || s === "unpaid") return "canceled";

  return s || "canceled";
}

function describeSubscriptionUpdate(prev: any, curr: any) {
  const prevCancelAtPeriodEnd = prev?.cancel_at_period_end;
  const currCancelAtPeriodEnd = curr?.cancel_at_period_end;

  const prevStatus = safeStr(prev?.status);
  const currStatus = safeStr(curr?.status);

  if (prevCancelAtPeriodEnd === false && currCancelAtPeriodEnd === true) {
    return "cancel_at_period_end_enabled";
  }

  if (prevCancelAtPeriodEnd === true && currCancelAtPeriodEnd === false) {
    return "resumed";
  }

  if (prevStatus && currStatus && prevStatus !== currStatus) {
    return `status_changed:${prevStatus}->${currStatus}`;
  }

  if (prev?.cancel_at && !curr?.cancel_at) {
    return "resumed";
  }

  if (!prev?.cancel_at && curr?.cancel_at && currCancelAtPeriodEnd) {
    return "cancel_at_period_end_enabled";
  }

  return "generic_update";
}

function isCreatorPlanSubscription(sub: any): boolean {
  return safeStr(sub?.metadata?.key) === "creator_plan";
}

// ---------- DB ----------
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

async function syncCreatorPlanFromSubscription(sub: any) {
  const user_id =
    safeStr(sub?.metadata?.user_id) ||
    (safeStr(sub?.id) ? await findUserIdByCreatorPlanSubscriptionId(safeStr(sub.id)) : null);

  if (!user_id) {
    console.log("CREATOR PLAN SKIP: missing user_id", {
      subId: safeStr(sub?.id),
      metadata: sub?.metadata ?? null,
    });
    return;
  }

  const customerId = safeStr(sub?.customer) || safeStr(sub?.customer?.id) || null;
  const stripeStatus = String(sub?.status || "incomplete");
  const statusDb = mapCreatorPlanStatusToDb(stripeStatus);
  const cpe = isoFromUnix((sub?.current_period_end ?? sub?.cancel_at ?? sub?.ended_at) ?? null);

  console.log("CREATOR PLAN UPSERT", {
    user_id,
    subId: safeStr(sub?.id),
    stripeStatus,
    statusDb,
    customerId,
    current_period_end: cpe,
    cancel_at_period_end: Boolean(sub?.cancel_at_period_end),
    metadata: sub?.metadata ?? null,
  });

  await upsertCreatorPlanEntitlement({
    user_id,
    status: statusDb,
    stripe_customer_id: customerId,
    stripe_subscription_id: safeStr(sub?.id) || null,
    current_period_end: cpe,
    cancel_at_period_end: Boolean(sub?.cancel_at_period_end),
  });
}

// ---------- Handler ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: corsHeaders,
    });
  }

  const sig = req.headers.get("stripe-signature") || "";
  const rawBody = await req.text();

  try {
    const ok = await verifyStripeSignature(rawBody, sig, STRIPE_WEBHOOK_SECRET);
    if (!ok) {
      return new Response("Invalid signature", {
        status: 400,
        headers: corsHeaders,
      });
    }

    const event = JSON.parse(rawBody || "{}");
    const type = safeStr(event?.type);
    const obj = event?.data?.object;
    const prev = event?.data?.previous_attributes ?? null;

    const stripeAccountId =
      safeStr(event?.account) || safeStr(req.headers.get("stripe-account")) || null;

    console.log("CREATOR PLAN WEBHOOK META", {
      type,
      eventAccount: safeStr(event?.account),
      headerStripeAccount: safeStr(req.headers.get("stripe-account")),
      stripeAccountId,
    });

    // ---------- checkout.session.completed ----------
    if (type === "checkout.session.completed") {
      const session = obj;
      const mode = safeStr(session?.mode);

      if (mode !== "subscription") {
        return new Response("ok", { status: 200, headers: corsHeaders });
      }

      const subscriptionId = safeStr(session?.subscription);
      if (!subscriptionId) {
        return new Response("ok", { status: 200, headers: corsHeaders });
      }

      const sub = await stripeGET(`subscriptions/${subscriptionId}`, stripeAccountId);

      if (!isCreatorPlanSubscription(sub)) {
        console.log("CREATOR PLAN IGNORE checkout.session.completed: not creator_plan", {
          subscriptionId,
          metadata: sub?.metadata ?? null,
        });
        return new Response("ok", { status: 200, headers: corsHeaders });
      }

      console.log("CREATOR PLAN CHECKOUT COMPLETED", {
        subscriptionId,
        metadata: sub?.metadata ?? null,
      });

      await syncCreatorPlanFromSubscription(sub);
      return new Response("ok", { status: 200, headers: corsHeaders });
    }

    // ---------- customer.subscription.created / updated ----------
    if (type === "customer.subscription.created" || type === "customer.subscription.updated") {
      const subId = safeStr(obj?.id);
      const hasCpe = obj?.current_period_end != null;
      const sub = subId && !hasCpe
        ? await stripeGET(`subscriptions/${subId}`, stripeAccountId)
        : obj;

      if (!isCreatorPlanSubscription(sub)) {
        console.log("CREATOR PLAN IGNORE subscription event: not creator_plan", {
          type,
          subId,
          metadata: sub?.metadata ?? null,
        });
        return new Response("ok", { status: 200, headers: corsHeaders });
      }

      console.log("CREATOR PLAN SUB EVENT", {
        type,
        subId,
        status: safeStr(sub?.status),
        cancel_at_period_end: Boolean(sub?.cancel_at_period_end),
        cancel_at: sub?.cancel_at ?? null,
        canceled_at: sub?.canceled_at ?? null,
        customer: safeStr(sub?.customer) || safeStr(sub?.customer?.id),
        metadata: sub?.metadata ?? null,
        previous_attributes: prev,
        update_kind: type === "customer.subscription.updated"
          ? describeSubscriptionUpdate(prev, sub)
          : "created",
        stripeAccountId,
      });

      await syncCreatorPlanFromSubscription(sub);
      return new Response("ok", { status: 200, headers: corsHeaders });
    }

    // ---------- customer.subscription.deleted ----------
    if (type === "customer.subscription.deleted") {
      const subId = safeStr(obj?.id);

      const isCreator =
        isCreatorPlanSubscription(obj) ||
        !!(subId && await findUserIdByCreatorPlanSubscriptionId(subId));

      if (!isCreator) {
        console.log("CREATOR PLAN IGNORE subscription.deleted: not creator_plan", {
          subId,
          metadata: obj?.metadata ?? null,
        });
        return new Response("ok", { status: 200, headers: corsHeaders });
      }

      const user_id =
        safeStr(obj?.metadata?.user_id) ||
        (subId ? await findUserIdByCreatorPlanSubscriptionId(subId) : null);

      console.log("CREATOR PLAN SUB DELETED", {
        subId,
        user_id,
        status: safeStr(obj?.status),
        cancel_at_period_end: Boolean(obj?.cancel_at_period_end),
        customer: safeStr(obj?.customer) || safeStr(obj?.customer?.id),
        metadata: obj?.metadata ?? null,
      });

      if (!user_id) {
        console.log("CREATOR PLAN DELETE SKIP: missing user_id", {
          subId,
          metadata: obj?.metadata ?? null,
        });
        return new Response("ok", { status: 200, headers: corsHeaders });
      }

      await markCreatorPlanExpired(user_id);
      return new Response("ok", { status: 200, headers: corsHeaders });
    }

    // ---------- invoice events ----------
    if (
      type === "invoice.payment_succeeded" ||
      type === "invoice.payment_failed" ||
      type === "invoice.finalized" ||
      type === "invoice.paid"
    ) {
      console.log("CREATOR PLAN INVOICE EVENT", {
        type,
        invoiceId: safeStr(obj?.id),
        subscription: safeStr(obj?.subscription),
        customer: safeStr(obj?.customer),
      });

      return new Response("ok", { status: 200, headers: corsHeaders });
    }

    console.log("CREATOR PLAN IGNORE EVENT", { type });

    return new Response("ok", { status: 200, headers: corsHeaders });
  } catch (e) {
    console.error("stripe-creator-plan-webhook error:", e);
    return new Response("ok", { status: 200, headers: corsHeaders });
  }
});