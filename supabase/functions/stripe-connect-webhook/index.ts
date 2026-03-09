// supabase/functions/stripe-connect-webhook/index.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2?target=deno";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, stripe-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function env(...keys: string[]) {
  for (const k of keys) {
    const v = Deno.env.get(k);
    if (v && v.trim().length) return v.trim();
  }
  return "";
}

function safeStr(x: unknown) {
  return (typeof x === "string" ? x : "").trim();
}

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  try {
    const STRIPE_CONNECT_WEBHOOK_SECRET = env(
      "STRIPE_CONNECT_WEBHOOK_SECRET",
      "OP_STRIPE_CONNECT_WEBHOOK_SECRET",
    );
    const SUPABASE_URL = env("SUPABASE_URL", "OP_SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = env(
      "SUPABASE_SERVICE_ROLE_KEY",
      "OP_SUPABASE_SERVICE_ROLE_KEY",
    );

    if (!STRIPE_CONNECT_WEBHOOK_SECRET || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return json(500, {
        error: "Missing env",
        debug: {
          hasConnectWebhookSecret: !!STRIPE_CONNECT_WEBHOOK_SECRET,
          hasSupabaseUrl: !!SUPABASE_URL,
          hasServiceRoleKey: !!SUPABASE_SERVICE_ROLE_KEY,
        },
      });
    }

    const sig = req.headers.get("stripe-signature") || "";
    const rawBody = await req.text();

    const ok = await verifyStripeSignature(
      rawBody,
      sig,
      STRIPE_CONNECT_WEBHOOK_SECRET,
    );

    if (!ok) {
      return json(400, { error: "Invalid signature" });
    }

    const event = JSON.parse(rawBody || "{}");
    const type = safeStr(event?.type);
    const obj = event?.data?.object;

    console.log("stripe-connect-webhook", {
      type,
      account: safeStr(event?.account),
    });

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    if (type === "account.updated") {
      const accountId = safeStr(obj?.id);
      const creatorId = safeStr(obj?.metadata?.creator_id);

      if (accountId) {
        const onboardingStatus =
          obj?.details_submitted ? "complete" : "in_progress";

        const stripeOnboarded =
          !!obj?.details_submitted &&
          !!obj?.charges_enabled &&
          !!obj?.payouts_enabled;

        let updated = false;

        if (creatorId) {
          const { error } = await admin
            .from("profiles")
            .update({
              stripe_onboarding_status: onboardingStatus,
              charges_enabled: !!obj?.charges_enabled,
              payouts_enabled: !!obj?.payouts_enabled,
              stripe_onboarded: stripeOnboarded,
              updated_at: new Date().toISOString(),
            })
            .eq("user_id", creatorId);

          if (error) {
            return json(500, {
              error: "DB update error",
              details: error.message,
            });
          }

          updated = true;
        }

        if (!updated) {
          const { error } = await admin
            .from("profiles")
            .update({
              stripe_onboarding_status: onboardingStatus,
              charges_enabled: !!obj?.charges_enabled,
              payouts_enabled: !!obj?.payouts_enabled,
              stripe_onboarded: stripeOnboarded,
              updated_at: new Date().toISOString(),
            })
            .eq("stripe_connect_account_id", accountId);

          if (error) {
            return json(500, {
              error: "DB update error",
              details: error.message,
            });
          }
        }
      }

      return json(200, { received: true });
    }

    if (type === "v2.core.account.created" || type === "v2.core.account.closed") {
      return json(200, { received: true, ignored: true });
    }

    return json(200, { received: true, ignored: true });
  } catch (e) {
    console.error("stripe-connect-webhook error:", e);
    return json(200, { received: true });
  }
});