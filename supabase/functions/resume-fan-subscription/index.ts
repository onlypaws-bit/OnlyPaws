// supabase/functions/resume-fan-subscription/index.ts
import { createClient } from "jsr:@supabase/supabase-js@2.49.1";

type Body = {
  creator_id: string;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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
    if (v && v.trim().length) return v.trim();
  }
  return "";
}

function getBearerToken(req: Request) {
  const auth = req.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  return auth.slice("Bearer ".length).trim();
}

function parseJsonSafe(text: string) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { raw: text };
  }
}

async function stripeRetrieveSubscription(opts: {
  secretKey: string;
  subscriptionId: string;
  stripeAccountId?: string | null;
}) {
  const url = `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(
    opts.subscriptionId,
  )}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.secretKey}`,
  };

  if (opts.stripeAccountId) {
    headers["Stripe-Account"] = opts.stripeAccountId;
  }

  const res = await fetch(url, { method: "GET", headers });
  const text = await res.text();
  const data = parseJsonSafe(text);

  if (!res.ok) {
    return { ok: false as const, status: res.status, error: data };
  }

  return { ok: true as const, data };
}

async function stripeResumeSubscription(opts: {
  secretKey: string;
  subscriptionId: string;
  stripeAccountId?: string | null;
}) {
  const url = `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(
    opts.subscriptionId,
  )}`;

  const body = new URLSearchParams();
  body.set("cancel_at_period_end", "false");

  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.secretKey}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };

  if (opts.stripeAccountId) {
    headers["Stripe-Account"] = opts.stripeAccountId;
  }

  const res = await fetch(url, { method: "POST", headers, body });
  const text = await res.text();
  const data = parseJsonSafe(text);

  if (!res.ok) {
    return { ok: false as const, status: res.status, error: data };
  }

  return { ok: true as const, data };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  try {
    const STRIPE_SECRET_KEY = env("STRIPE_SECRET_KEY", "OP_STRIPE_SECRET_KEY");
    const SUPABASE_URL = env("SUPABASE_URL");
    const SUPABASE_ANON_KEY = env(
      "SUPABASE_ANON_KEY",
      "SUPABASE_ANON_PUBLIC_KEY",
    );
    const SUPABASE_SERVICE_ROLE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");

    if (
      !STRIPE_SECRET_KEY ||
      !SUPABASE_URL ||
      !SUPABASE_ANON_KEY ||
      !SUPABASE_SERVICE_ROLE_KEY
    ) {
      return json(500, {
        error: "Missing env",
        debug: {
          hasStripeKey: !!STRIPE_SECRET_KEY,
          stripeKeyPrefix: STRIPE_SECRET_KEY
            ? STRIPE_SECRET_KEY.slice(0, 7)
            : null,
          hasSupabaseUrl: !!SUPABASE_URL,
          hasSupabaseAnonKey: !!SUPABASE_ANON_KEY,
          hasServiceRoleKey: !!SUPABASE_SERVICE_ROLE_KEY,
        },
      });
    }

    const token = getBearerToken(req);
    if (!token) {
      return json(401, { error: "Missing Bearer token" });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    const supabaseAdmin = createClient(
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY,
    );

    const { data: authData, error: authErr } = await supabase.auth.getUser();
    if (authErr || !authData?.user) {
      return json(401, {
        error: "Unauthorized",
        details: authErr?.message ?? null,
      });
    }

    const fanId = authData.user.id;

    const parsed: Body = await req.json().catch(() => ({ creator_id: "" }));
    const creator_id = String(parsed?.creator_id || "").trim();

    if (!creator_id) {
      return json(400, { error: "Missing creator_id" });
    }

    const { data: row, error: selErr } = await supabaseAdmin
      .from("fan_subscriptions")
      .select("*")
      .eq("fan_id", fanId)
      .eq("creator_id", creator_id)
      .maybeSingle();

    if (selErr) {
      return json(500, { error: "DB error", details: selErr.message });
    }

    if (!row?.provider_subscription_id) {
      return json(400, { error: "No subscription found" });
    }

    const { data: creatorProfile, error: profileErr } = await supabaseAdmin
      .from("profiles")
      .select("stripe_connect_account_id")
      .eq("user_id", creator_id)
      .maybeSingle();

    if (profileErr) {
      return json(500, {
        error: "Profile lookup error",
        details: profileErr.message,
      });
    }

    const subscriptionId = String(row.provider_subscription_id || "").trim();
    const stripeAccountId = String(
      creatorProfile?.stripe_connect_account_id || "",
    ).trim() || null;

    console.log(
      JSON.stringify(
        {
          event: "resume-fan-subscription:start",
          fanId,
          creator_id,
          subscriptionId,
          stripeAccountId,
          stripeKeyPrefix: STRIPE_SECRET_KEY.slice(0, 7),
        },
        null,
        2,
      ),
    );

    const retrieveRes = await stripeRetrieveSubscription({
      secretKey: STRIPE_SECRET_KEY,
      subscriptionId,
      stripeAccountId,
    });

    console.log(
      JSON.stringify(
        {
          event: "resume-fan-subscription:retrieve",
          ok: retrieveRes.ok,
          status: retrieveRes.ok ? 200 : retrieveRes.status,
          subscriptionId,
          stripeAccountId,
          error: retrieveRes.ok ? null : retrieveRes.error,
        },
        null,
        2,
      ),
    );

    if (!retrieveRes.ok) {
      return json(502, {
        error: "Stripe retrieve error",
        stripe_status: retrieveRes.status,
        debug: {
          subscription_id: subscriptionId,
          stripe_account_id: stripeAccountId,
          stripe_key_prefix: STRIPE_SECRET_KEY.slice(0, 7),
        },
        details: retrieveRes.error,
      });
    }

    const stripeRes = await stripeResumeSubscription({
      secretKey: STRIPE_SECRET_KEY,
      subscriptionId,
      stripeAccountId,
    });

    console.log(
      JSON.stringify(
        {
          event: "resume-fan-subscription:resume",
          ok: stripeRes.ok,
          status: stripeRes.ok ? 200 : stripeRes.status,
          subscriptionId,
          stripeAccountId,
          error: stripeRes.ok ? null : stripeRes.error,
        },
        null,
        2,
      ),
    );

    if (!stripeRes.ok) {
      return json(502, {
        error: "Stripe resume error",
        stripe_status: stripeRes.status,
        debug: {
          subscription_id: subscriptionId,
          stripe_account_id: stripeAccountId,
          stripe_key_prefix: STRIPE_SECRET_KEY.slice(0, 7),
        },
        details: stripeRes.error,
      });
    }

    const updated = stripeRes.data;
    const currentPeriodEndIso =
      typeof updated?.current_period_end === "number"
        ? new Date(updated.current_period_end * 1000).toISOString()
        : row.current_period_end ?? null;

    const { error: updErr } = await supabaseAdmin
      .from("fan_subscriptions")
      .update({
        cancel_at_period_end: updated?.cancel_at_period_end ?? false,
        current_period_end: currentPeriodEndIso,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);

    if (updErr) {
      return json(500, {
        error: "DB update error",
        details: updErr.message,
      });
    }

    return json(200, {
      success: true,
      data: {
        subscription_id: subscriptionId,
        stripe_account_id: stripeAccountId,
        cancel_at_period_end: updated?.cancel_at_period_end ?? false,
        current_period_end: currentPeriodEndIso,
        status: row.status,
      },
    });
  } catch (e) {
    console.error("resume-fan-subscription fatal", e);

    return json(500, {
      error: "Internal error",
      details: e instanceof Error ? e.message : String(e),
    });
  }
});