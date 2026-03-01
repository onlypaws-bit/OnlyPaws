// supabase/functions/update-connect-account/index.ts
import Stripe from "https://esm.sh/stripe@14.25.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

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

function getBearerToken(req: Request) {
  const auth = req.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  return auth.slice("Bearer ".length).trim();
}

function normalizeSiteUrl(raw: string) {
  return raw.replace(/\/+$/, "");
}

function safePath(p?: string, fallback = "/payouts-setup.html") {
  if (!p) return fallback;
  if (!p.startsWith("/")) return fallback;
  if (p.startsWith("//")) return fallback;
  if (p.includes(":")) return fallback;
  return p;
}

function buildUrl(siteUrl: string, path: string) {
  return `${siteUrl}${path}`;
}

// keep aligned with stripe.html
const PLATFORM_PRODUCT_DESCRIPTION =
  "OnlyPaws is a recurring digital subscription platform dedicated exclusively to pet-related content. Creators publish safe-for-work pet photography, pet lifestyle updates, and educational pet-related media. Products are digital subscriptions and tips for pet content. No adult content.";

function platformBusinessUrl(siteUrl: string) {
  return buildUrl(siteUrl, "/stripe.html");
}

async function applyPlatformPrefill(stripe: Stripe, accountId: string, siteUrl: string, userId: string) {
  await stripe.accounts.update(accountId, {
    business_profile: {
      url: platformBusinessUrl(siteUrl),
      product_description: PLATFORM_PRODUCT_DESCRIPTION,
      mcc: "5968",
    },
    metadata: {
      platform: "OnlyPaws",
      content_category: "pet_sfw",
      user_id: userId,
    },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const STRIPE_SECRET_KEY =
      Deno.env.get("STRIPE_SECRET_KEY") || Deno.env.get("OP_STRIPE_SECRET_KEY");

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    const SITE_URL_RAW = Deno.env.get("SITE_URL") || "https://onlypaws-psi.vercel.app";
    const SITE_URL = normalizeSiteUrl(SITE_URL_RAW);

    if (!STRIPE_SECRET_KEY) return json(500, { error: "Missing Stripe secret key" });
    if (!SUPABASE_URL) return json(500, { error: "Missing SUPABASE_URL" });
    if (!SUPABASE_SERVICE_ROLE_KEY) return json(500, { error: "Missing SUPABASE_SERVICE_ROLE_KEY" });

    const token = getBearerToken(req);
    if (!token) return json(401, { error: "Missing Authorization header" });

    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    // ✅ validate token + user
    const { data: userRes, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userRes?.user) return json(401, { error: "Invalid session" });

    const user = userRes.user;
    const userId = user.id;
    const userEmail = user.email ?? undefined;

    const stripe = new Stripe(STRIPE_SECRET_KEY, {
      apiVersion: "2023-10-16",
      httpClient: Stripe.createFetchHttpClient(),
    });

    const body = await req.json().catch(() => ({}));

    // ✅ only allow relative paths; always build from SITE_URL
    const returnPath =
      safePath(typeof body?.return_path === "string" ? body.return_path : undefined, "/payouts-setup.html?done=1");
    const refreshPath =
      safePath(typeof body?.refresh_path === "string" ? body.refresh_path : undefined, "/payouts-setup.html?retry=1");

    const return_url = buildUrl(SITE_URL, returnPath);
    const refresh_url = buildUrl(SITE_URL, refreshPath);

    // 1) read profile
    const { data: profile, error: pErr } = await supabaseAdmin
      .from("profiles")
      .select("user_id, role, username, stripe_connect_account_id")
      .eq("user_id", userId)
      .maybeSingle();

    if (pErr) return json(500, { error: pErr.message });
    if (!profile) return json(404, { error: "Profile not found for user" });

    let accountId: string | null = profile.stripe_connect_account_id ?? null;

    async function saveConnectAccount(newId: string) {
      const { error: upErr } = await supabaseAdmin
        .from("profiles")
        .update({
          stripe_connect_account_id: newId,
          stripe_onboarding_status: "in_progress",
          charges_enabled: false,
          payouts_enabled: false,
          stripe_onboarded: false,
        })
        .eq("user_id", userId);

      if (upErr) throw new Error("Failed to update profile: " + upErr.message);
    }

    async function accountExists(id: string) {
      try {
        await stripe.accounts.retrieve(id);
        return true;
      } catch (e: any) {
        const code = e?.code ?? "";
        const status = e?.statusCode ?? 0;
        if (code === "resource_missing" || status === 404) return false;
        throw e;
      }
    }

    // 2) create account if missing (or if invalid)
    if (!accountId || !(await accountExists(accountId))) {
      const acct = await stripe.accounts.create({
        type: "express",
        email: userEmail,
        metadata: { user_id: userId, platform: "OnlyPaws", content_category: "pet_sfw" },
        // leaving capabilities requested is fine; direct charges logic lives elsewhere
        capabilities: {
          transfers: { requested: true },
          card_payments: { requested: true },
        },
        business_profile: {
          url: platformBusinessUrl(SITE_URL),
          product_description: PLATFORM_PRODUCT_DESCRIPTION,
          mcc: "5968",
        },
      });

      accountId = acct.id;
      await saveConnectAccount(accountId);
    } else {
      // ensure UI stays consistent but don't blindly overwrite verified states
      await supabaseAdmin
        .from("profiles")
        .update({ stripe_onboarding_status: "in_progress" })
        .eq("user_id", userId);
    }

    // 3) force platform prefill before onboarding link
    await applyPlatformPrefill(stripe, accountId!, SITE_URL, userId);

    // 4) create onboarding link
    const link = await stripe.accountLinks.create({
      account: accountId!,
      type: "account_onboarding",
      return_url,
      refresh_url,
    });

    return json(200, {
      url: link.url,
      type: "account_onboarding",
      stripe_connect_account_id: accountId,
      return_url,
      refresh_url,
      business_url: platformBusinessUrl(SITE_URL),
    });
  } catch (e: any) {
    console.error("CONNECT UPDATE ERROR:", e);
    const msg = e?.raw?.message || e?.message || String(e);
    return json(500, { error: msg });
  }
});