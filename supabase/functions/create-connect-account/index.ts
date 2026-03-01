// supabase/functions/create-connect-account/index.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14.25.0?target=deno";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, data: unknown) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

type Body = {
  return_path?: string;  // MUST be relative path like "/profile.html"
  refresh_path?: string; // MUST be relative path like "/profile.html"
};

function normalizeSiteUrl(raw: string) {
  return raw.replace(/\/+$/, "");
}

function safePath(p?: string, fallback = "/profile.html") {
  if (!p) return fallback;
  if (!p.startsWith("/")) return fallback;
  if (p.startsWith("//")) return fallback;
  if (p.includes(":")) return fallback; // blocks "https:", "javascript:", etc.
  return p;
}

function buildUrl(siteUrl: string, path: string) {
  return `${siteUrl}${path}`;
}

function stripeErrToString(e: any) {
  const msg = e?.message ?? String(e);
  const type = e?.type ? ` (${e.type})` : "";
  const code = e?.code ? ` code=${e.code}` : "";
  const status = e?.statusCode ? ` status=${e.statusCode}` : "";
  return `${msg}${type}${code}${status}`.trim();
}

// Keep this aligned with stripe.html content
const PLATFORM_PRODUCT_DESCRIPTION =
  "OnlyPaws is a recurring digital subscription platform dedicated exclusively to pet-related content. Creators publish safe-for-work pet photography, pet lifestyle updates, and educational pet-related media. Products are digital subscriptions and tips for pet content. No adult content.";

function platformBusinessUrl(siteUrl: string) {
  // ✅ canonical Stripe business page
  return buildUrl(siteUrl, "/stripe.html");
}

async function applyPlatformPrefill(stripe: Stripe, accountId: string, siteUrl: string) {
  const url = platformBusinessUrl(siteUrl);

  await stripe.accounts.update(accountId, {
    business_profile: {
      url,
      product_description: PLATFORM_PRODUCT_DESCRIPTION,
      mcc: "5968",
    },
    metadata: {
      platform: "OnlyPaws",
      content_category: "pet_sfw",
    },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const STRIPE_SECRET_KEY =
      Deno.env.get("STRIPE_SECRET_KEY") || Deno.env.get("OP_STRIPE_SECRET_KEY");

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    const SITE_URL_RAW = Deno.env.get("SITE_URL") || "http://localhost:3000";
    const SITE_URL = normalizeSiteUrl(SITE_URL_RAW);

    if (!STRIPE_SECRET_KEY) return json(500, { error: "Missing Stripe secret key" });
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
      return json(500, { error: "Missing Supabase env vars" });
    }

    // Body is optional
    const body = (await req.json().catch(() => ({}))) as Body;

    const returnPath = safePath(body.return_path, "/profile.html");
    const refreshPath = safePath(body.refresh_path, "/profile.html");

    const returnUrl = buildUrl(SITE_URL, returnPath);
    const refreshUrl = buildUrl(SITE_URL, refreshPath);

    const authHeader = req.headers.get("Authorization") ?? "";
    const supaUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData, error: userErr } = await supaUser.auth.getUser();
    if (userErr || !userData?.user) return json(401, { error: "Not authenticated" });

    const creatorId = userData.user.id;
    const creatorEmail = userData.user.email ?? undefined;

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: prof, error: profErr } = await admin
      .from("profiles")
      .select("user_id, display_name, username, stripe_connect_account_id")
      .eq("user_id", creatorId)
      .single();

    if (profErr || !prof) return json(400, { error: "Profile not found" });

    const stripe = new Stripe(STRIPE_SECRET_KEY, {
      apiVersion: "2023-10-16",
      httpClient: Stripe.createFetchHttpClient(),
    });

    let acctId = (prof as any).stripe_connect_account_id as string | null;

    // 1) Create Connect account if missing (Express)
    if (!acctId) {
      const pretty =
        (prof as any).display_name ||
        (prof as any).username ||
        `creator ${creatorId.slice(0, 8)}`;

      const acct = await stripe.accounts.create({
        type: "express",
        email: creatorEmail,
        metadata: {
          creator_id: creatorId,
          platform: "OnlyPaws",
          content_category: "pet_sfw",
        },
        business_profile: {
          // Account is the creator’s Stripe account, but we keep the platform business context consistent
          name: pretty,
          product_description: PLATFORM_PRODUCT_DESCRIPTION,
          url: platformBusinessUrl(SITE_URL), // ✅ stripe.html
          mcc: "5968",
        },
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
      });

      acctId = acct.id;

      const { error: upErr } = await admin
        .from("profiles")
        .update({
          stripe_connect_account_id: acctId,
          stripe_onboarding_status: "in_progress",
          charges_enabled: false,
        })
        .eq("user_id", creatorId);

      if (upErr) {
        return json(500, {
          error: "Created Stripe account but failed to store it",
          details: upErr.message,
        });
      }
    }

    // 2) Force platform prefill before generating onboarding link (important)
    await applyPlatformPrefill(stripe, acctId!, SITE_URL);

    // 3) Create Account Link (onboarding)
    const link = await stripe.accountLinks.create({
      account: acctId!,
      type: "account_onboarding",
      return_url: returnUrl,
      refresh_url: refreshUrl,
    });

    return json(200, {
      url: link.url,
      account_id: acctId,
      business_url: platformBusinessUrl(SITE_URL),
      return_url: returnUrl,
      refresh_url: refreshUrl,
    });
  } catch (e: any) {
    console.error(e);
    return json(500, { error: "Server error", details: stripeErrToString(e) });
  }
});