// supabase/functions/create-fan-subscription/index.ts
type Body = {
  creator_id: string;
  success_url: string;
  cancel_url: string;
  price_id?: string; // ignored on purpose
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

function env(...keys: string[]) {
  for (const k of keys) {
    const v = Deno.env.get(k);
    if (v && v.trim().length) return v;
  }
  return "";
}

function getBearerToken(req: Request) {
  const auth = req.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  return auth.slice("Bearer ".length).trim();
}

function toMinorUnit(price_cents: number) {
  const n = Number(price_cents);
  if (!Number.isFinite(n) || n < 0) throw new Error("Invalid price_cents");
  return Math.trunc(n);
}

function intervalFromBillingPeriod(bp: string) {
  const x = (bp || "").toLowerCase();
  if (x === "yearly" || x === "year")
    return { interval: "year" as const, interval_count: 1 };
  return { interval: "month" as const, interval_count: 1 };
}

function parseFeePercent(raw: string) {
  const n = Number(String(raw ?? "").trim());
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(100, n);
}

type PlanRow = {
  id: string;
  creator_id: string;
  name: string;
  description: string | null;
  price_cents: number;
  currency: string;
  billing_period: string;
  stripe_product_id: string | null; // legacy (ignored)
  stripe_price_id: string | null;   // legacy (ignored)
  is_active: boolean;
  created_at?: string;
};

type PriceMapRow = {
  id: string;
  plan_id: string;
  creator_id: string;
  stripe_account_id: string;
  stripe_product_id: string;
  stripe_price_id: string;
};

// ---------------- Stripe REST (DIRECT via Stripe-Account) ----------------

const STRIPE_API = "https://api.stripe.com";
const STRIPE_VERSION = "2023-10-16";

function appendParams(out: URLSearchParams, key: string, value: unknown) {
  if (value === undefined || value === null) return;

  if (Array.isArray(value)) {
    value.forEach((v, i) => appendParams(out, `${key}[${i}]`, v));
    return;
  }

  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      appendParams(out, `${key}[${k}]`, v);
    }
    return;
  }

  out.append(key, String(value));
}

async function stripeRequest(
  secretKey: string,
  stripeAccount: string, // ✅ ALWAYS connected (DIRECT)
  method: "GET" | "POST",
  path: string,
  params?: Record<string, unknown>,
  idempotencyKey?: string,
) {
  const url = new URL(`${STRIPE_API}${path}`);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${secretKey}`,
    "Stripe-Version": STRIPE_VERSION,
    "Stripe-Account": stripeAccount, // ✅ DIRECT: everything happens on connected
  };

  let body: string | undefined;

  if (method === "GET") {
    if (params) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) appendParams(qs, k, v);
      qs.forEach((v, k) => url.searchParams.append(k, v));
    }
  } else {
    headers["content-type"] = "application/x-www-form-urlencoded";
    const form = new URLSearchParams();
    if (params) for (const [k, v] of Object.entries(params)) appendParams(form, k, v);
    body = form.toString();
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  }

  const res = await fetch(url.toString(), { method, headers, body });
  const text = await res.text();

  let data: any;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const msg = data?.error?.message || data?.message || `Stripe error (${res.status})`;
    const err: any = new Error(msg);
    err.status = res.status;
    err.stripe = data;
    throw err;
  }

  return data;
}

const stripeGet = (key: string, acct: string, path: string, params?: Record<string, unknown>) =>
  stripeRequest(key, acct, "GET", path, params);

const stripePost = (
  key: string,
  acct: string,
  path: string,
  params?: Record<string, unknown>,
  idem?: string,
) => stripeRequest(key, acct, "POST", path, params, idem);

// ---------------- Supabase REST (NO supabase-js) ----------------

async function sbAuthGetUser(supabaseUrl: string, anonKey: string, userJwt: string) {
  const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
    method: "GET",
    headers: { apikey: anonKey, Authorization: `Bearer ${userJwt}` },
  });

  const text = await res.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const err: any = new Error(data?.msg || data?.error_description || data?.error || "Unauthorized");
    err.status = res.status;
    err.sb = data;
    throw err;
  }

  if (!data?.id) throw new Error("Unauthorized");
  return data;
}

async function sbRest(
  supabaseUrl: string,
  serviceRoleKey: string,
  pathAndQuery: string,
  init?: RequestInit,
) {
  const res = await fetch(`${supabaseUrl}/rest/v1${pathAndQuery}`, {
    ...init,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      ...(init?.headers || {}),
    },
  });

  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok) {
    const err: any = new Error(
      (data && (data.message || data.error || data.details)) || `DB error (${res.status})`,
    );
    err.status = res.status;
    err.sb = data;
    throw err;
  }

  return data;
}

function enc(v: string) {
  return encodeURIComponent(v);
}

async function getActiveCreatorPlanREST(
  supabaseUrl: string,
  serviceRoleKey: string,
  creatorId: string,
): Promise<PlanRow> {
  const q =
    `/creator_plans?select=` +
    enc(
      "id,creator_id,name,description,price_cents,currency,billing_period,stripe_product_id,stripe_price_id,is_active,created_at",
    ) +
    `&creator_id=eq.${enc(creatorId)}` +
    `&is_active=eq.true` +
    `&order=created_at.desc` +
    `&limit=1`;

  const rows = await sbRest(supabaseUrl, serviceRoleKey, q, { method: "GET" });
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row?.id) throw new Error("No active creator plan found.");
  return row as PlanRow;
}

async function getPlanPriceForConnected(
  supabaseUrl: string,
  serviceRoleKey: string,
  planId: string,
  stripeAccountId: string,
): Promise<PriceMapRow | null> {
  const q =
    `/creator_plan_stripe_prices?select=` +
    enc("id,plan_id,creator_id,stripe_account_id,stripe_product_id,stripe_price_id") +
    `&plan_id=eq.${enc(planId)}` +
    `&stripe_account_id=eq.${enc(stripeAccountId)}` +
    `&limit=1`;

  const rows = await sbRest(supabaseUrl, serviceRoleKey, q, { method: "GET" });
  const row = Array.isArray(rows) ? rows[0] : null;
  return row?.id ? (row as PriceMapRow) : null;
}

async function upsertPlanPriceForConnected(
  supabaseUrl: string,
  serviceRoleKey: string,
  payload: {
    plan_id: string;
    creator_id: string;
    stripe_account_id: string;
    stripe_product_id: string;
    stripe_price_id: string;
  },
) {
  await sbRest(supabaseUrl, serviceRoleKey, `/creator_plan_stripe_prices`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(payload),
  });
}

async function ensureStripeProductAndPriceOnConnected(
  stripeKey: string,
  connectedId: string,
  plan: PlanRow,
) {
  const product = await stripePost(
    stripeKey,
    connectedId,
    "/v1/products",
    {
      name: plan.name,
      description: plan.description || undefined,
      metadata: { kind: "creator_plan", plan_id: plan.id, creator_id: plan.creator_id },
    },
    `op_prod_${connectedId}_${plan.id}`,
  );

  const unit_amount = toMinorUnit(plan.price_cents);
  const { interval, interval_count } = intervalFromBillingPeriod(plan.billing_period);

  const price = await stripePost(
    stripeKey,
    connectedId,
    "/v1/prices",
    {
      product: product.id,
      currency: (plan.currency || "eur").toLowerCase(),
      unit_amount,
      recurring: { interval, interval_count },
      nickname: `${plan.name} (${plan.billing_period})`,
      metadata: { kind: "creator_plan", plan_id: plan.id, creator_id: plan.creator_id },
    },
    `op_price_${connectedId}_${plan.id}_${unit_amount}_${interval}_${interval_count}`,
  );

  return { productId: product.id, priceId: price.id };
}

// ---------------- Handler ----------------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const STRIPE_SECRET_KEY = env("STRIPE_SECRET_KEY", "OP_STRIPE_SECRET_KEY");
    const SUPABASE_URL = env("SUPABASE_URL");
    const SUPABASE_ANON_KEY = env("SUPABASE_ANON_KEY", "SUPABASE_ANON_PUBLIC_KEY");
    const SUPABASE_SERVICE_ROLE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");

    if (!STRIPE_SECRET_KEY || !SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
      return json(500, {
        error:
          "Missing env (need STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY)",
      });
    }

    const token = getBearerToken(req);
    if (!token) return json(401, { error: "Missing Bearer token" });

    const authUser = await sbAuthGetUser(SUPABASE_URL, SUPABASE_ANON_KEY, token);
    const fanId = authUser.id as string;
    const body: Body = await req.json();

    if (!body?.creator_id || !body?.success_url || !body?.cancel_url) {
      return json(400, { error: "Missing required fields (creator_id, success_url, cancel_url)" });
    }
    if (body.creator_id === fanId) return json(400, { error: "You cannot subscribe to yourself" });

    // connected id
    const profRows = await sbRest(
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY,
      `/profiles?select=stripe_connect_account_id&user_id=eq.${enc(body.creator_id)}&limit=1`,
      { method: "GET" },
    );
    const connectedId = String(
      Array.isArray(profRows) ? (profRows[0]?.stripe_connect_account_id ?? "") : "",
    ).trim();

    if (!connectedId) {
      return json(400, { error: "Creator has no connect account. Complete onboarding first." });
    }

    const feePercent = parseFeePercent(env("OP_PLATFORM_FEE_PERCENT", "PLATFORM_FEE_PERCENT"));

    // existing fan_subscriptions row
    const subRows = await sbRest(
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY,
      `/fan_subscriptions?select=*&fan_id=eq.${enc(fanId)}&creator_id=eq.${enc(body.creator_id)}&order=updated_at.desc&limit=1`,
      { method: "GET" },
    );
    const row = Array.isArray(subRows) ? subRows[0] : null;

    // If subscription exists, retrieve it ON CONNECTED
    if (row?.provider_subscription_id) {
      const s = await stripeGet(
        STRIPE_SECRET_KEY,
        connectedId,
        `/v1/subscriptions/${encodeURIComponent(row.provider_subscription_id)}`,
      );

      if (s.status !== "canceled") {
        if (s.cancel_at_period_end) {
          const resumed = await stripePost(
            STRIPE_SECRET_KEY,
            connectedId,
            `/v1/subscriptions/${encodeURIComponent(s.id)}`,
            { cancel_at_period_end: false },
          );

          await sbRest(
            SUPABASE_URL,
            SUPABASE_SERVICE_ROLE_KEY,
            `/fan_subscriptions?id=eq.${enc(row.id)}`,
            {
              method: "PATCH",
              headers: { "content-type": "application/json", Prefer: "return=minimal" },
              body: JSON.stringify({
                status: resumed.status,
                cancel_at_period_end: resumed.cancel_at_period_end,
                current_period_start: resumed.current_period_start
                  ? new Date(resumed.current_period_start * 1000).toISOString()
                  : null,
                current_period_end: resumed.current_period_end
                  ? new Date(resumed.current_period_end * 1000).toISOString()
                  : null,
                payment_provider: "stripe",
                provider_customer_id: String(resumed.customer),
                provider_subscription_id: resumed.id,
                updated_at: new Date().toISOString(),
              }),
            },
          );

          return json(200, { action: "resumed", provider_subscription_id: resumed.id });
        }

        return json(200, {
          action: "already_exists",
          provider_subscription_id: s.id,
          status: s.status,
          cancel_at_period_end: s.cancel_at_period_end,
        });
      }
    }

    // plan
    const plan = await getActiveCreatorPlanREST(
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY,
      body.creator_id,
    );

    // mapping for this connected
    let mapping = await getPlanPriceForConnected(
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY,
      plan.id,
      connectedId,
    );

    let priceId: string | null = null;

    // validate mapped price exists on connected
    if (mapping?.stripe_price_id) {
      try {
        await stripeGet(
          STRIPE_SECRET_KEY,
          connectedId,
          `/v1/prices/${encodeURIComponent(mapping.stripe_price_id)}`,
        );
        priceId = mapping.stripe_price_id;
      } catch {
        mapping = null;
      }
    }

    // create + save mapping if missing/invalid
    if (!priceId) {
      const ensured = await ensureStripeProductAndPriceOnConnected(
        STRIPE_SECRET_KEY,
        connectedId,
        plan,
      );

      await upsertPlanPriceForConnected(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        plan_id: plan.id,
        creator_id: plan.creator_id,
        stripe_account_id: connectedId,
        stripe_product_id: ensured.productId,
        stripe_price_id: ensured.priceId,
      });

      priceId = ensured.priceId;
    }

    const customerId = row?.provider_customer_id ?? null;

    // ✅ DIRECT checkout session created ON CONNECTED
    const subscription_data: Record<string, unknown> = {
      metadata: {
        kind: "fan_creator",
        fan_id: fanId,
        creator_id: body.creator_id,
        plan_id: plan.id,
      },
    };
    if (feePercent !== null) subscription_data.application_fee_percent = feePercent;

    const session = await stripePost(
      STRIPE_SECRET_KEY,
      connectedId,
      "/v1/checkout/sessions",
      {
        mode: "subscription",
        success_url: body.success_url,
        cancel_url: body.cancel_url,
        "line_items[0][price]": priceId,
        "line_items[0][quantity]": 1,
        customer: customerId ?? undefined,
        customer_email: customerId ? undefined : (authUser.email ?? undefined),
        allow_promotion_codes: true,
        metadata: {
          kind: "fan_creator",
          fan_id: fanId,
          creator_id: body.creator_id,
          plan_id: plan.id,
        },
        subscription_data,
      },
      `op_fc_direct_${connectedId}_${fanId}_${body.creator_id}_${plan.id}`,
    );

    // Save pending row (same as before)
    const nowIso = new Date().toISOString();
    const pending = {
      fan_id: fanId,
      creator_id: body.creator_id,
      plan_id: plan.id,
      status: "checkout_pending",
      cancel_at_period_end: false,
      payment_provider: "stripe",
      provider_customer_id: customerId,
      provider_subscription_id: null,
      current_period_start: null,
      current_period_end: null,
      updated_at: nowIso,
      canceled_at: null,
    };

    if (row?.id) {
      await sbRest(
        SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY,
        `/fan_subscriptions?id=eq.${enc(row.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify(pending),
        },
      );
    } else {
      await sbRest(
        SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY,
        `/fan_subscriptions`,
        {
          method: "POST",
          headers: { "content-type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify(pending),
        },
      );
    }

    return json(200, { action: "checkout", url: session.url, session_id: session.id });
  } catch (e) {
    const err = e as any;
    console.error("create-fan-subscription (DIRECT) error:", err?.stack ?? err);
    return json(500, {
      error: "Internal error",
      details: String(err?.message ?? err),
      status: err?.status ?? null,
      stripe: err?.stripe ?? null,
      sb: err?.sb ?? null,
    });
  }
});
