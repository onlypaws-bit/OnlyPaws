// supabase/functions/delete-profile/index.ts

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@11.2.0?target=deno";

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

function env(name: string) {
  const v = Deno.env.get(name);
  return v && v.trim().length ? v.trim() : "";
}

function uniq<T>(arr: T[]) {
  return Array.from(new Set(arr));
}

type TombSnapshot = {
  profile: any;
  meta?: Record<string, unknown>;
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "text/plain" },
    });
  }

  if (req.method !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  try {
    const SUPABASE_URL = env("SUPABASE_URL");
    const SUPABASE_ANON_KEY = env("SUPABASE_ANON_KEY");
    const SUPABASE_SERVICE_ROLE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
    const STRIPE_SECRET_KEY = env("STRIPE_SECRET_KEY");

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
      return json(500, { error: "Missing Supabase env vars" });
    }

    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.toLowerCase().startsWith("bearer ")) {
      return json(401, { error: "Missing/invalid Authorization header" });
    }

    const jwt = authHeader.slice(7).trim();
    if (!jwt) return json(401, { error: "Missing JWT" });

    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });

    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) {
      return json(401, { error: "Invalid user session" });
    }

    const userId = userData.user.id;
    const userEmail = userData.user.email ?? null;

    let body: any = null;
    try {
      body = await req.json();
    } catch {
      body = null;
    }

    if (body?.confirm !== true) {
      return json(400, { error: "Missing confirm=true" });
    }

    const reason = (body?.reason ?? "user_request").trim() || "user_request";
    const nowIso = new Date().toISOString();

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // ---- Snapshot profile
    const { data: myProf, error: myProfErr } = await admin
      .from("profiles")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    if (myProfErr) return json(500, { error: myProfErr.message });

    const myConnectedId =
      String((myProf as any)?.stripe_connect_account_id ?? "").trim() || null;

    // ---- Helper snapshot merge
    async function mergeTombstoneMeta(metaPatch: Record<string, unknown>) {
      try {
        const { data: existing } = await admin
          .from("deleted_profiles")
          .select("snapshot")
          .eq("user_id", userId)
          .maybeSingle();

        const existingSnap = (existing as any)?.snapshot ?? {};
        const normalized: TombSnapshot =
          existingSnap &&
          typeof existingSnap === "object" &&
          "profile" in existingSnap
            ? existingSnap
            : { profile: myProf ?? { user_id: userId, email: userEmail }, meta: {} };

        const updated: TombSnapshot = {
          profile: normalized.profile,
          meta: { ...(normalized.meta ?? {}), ...metaPatch },
        };

        await admin
          .from("deleted_profiles")
          .update({ snapshot: updated })
          .eq("user_id", userId);
      } catch {
        // swallow
      }
    }

    // ---- Upsert tombstone
    await admin.from("deleted_profiles").upsert(
      {
        user_id: userId,
        email: userEmail,
        username: (myProf as any)?.username ?? null,
        stripe_connect_account_id: myConnectedId,
        reason,
        snapshot: {
          profile: myProf ?? { user_id: userId, email: userEmail },
          meta: {
            deleted_at: nowIso,
            reason,
            had_connected_account: !!myConnectedId,
          },
        },
      },
      { onConflict: "user_id" },
    );

    // ---- Stripe cancel
    let stripeSkipped = false;
    let canceledOnStripe = 0;

    let stripe: Stripe | null = null;
    if (STRIPE_SECRET_KEY) {
      stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });
    } else {
      stripeSkipped = true;
    }

    if (stripe && myConnectedId) {
      try {
        const subs = await stripe.subscriptions.list(
          { status: "all", limit: 100 },
          { stripeAccount: myConnectedId },
        );

        for (const s of subs.data ?? []) {
          if (s.status !== "canceled") {
            await stripe.subscriptions.cancel(s.id, {
              stripeAccount: myConnectedId,
            });
            canceledOnStripe++;
          }
        }

        await mergeTombstoneMeta({
          stripe_cleanup_canceled_count: canceledOnStripe,
        });
      } catch (e: any) {
        await mergeTombstoneMeta({
          stripe_cleanup_error: e?.message ?? String(e),
        });

        return json(409, {
          error: "Stripe cleanup failed",
          stripe_error: e?.message ?? String(e),
        });
      }
    }

    // ---- Delete profile (cascade)
    const { error: delProfErr } = await admin
      .from("profiles")
      .delete()
      .eq("user_id", userId);

    if (delProfErr) return json(500, { error: delProfErr.message });

    // ---- Delete auth user (non-blocking parsing failures)
    let delAuthWarn: string | null = null;

    try {
      const { error: delAuthErr } = await admin.auth.admin.deleteUser(userId);
      if (delAuthErr) {
        return json(500, { error: delAuthErr.message });
      }
    } catch (e: any) {
      delAuthWarn = e?.message ?? String(e);

      await mergeTombstoneMeta({
        del_auth_warning: delAuthWarn,
      });
    }

    return json(200, {
      ok: true,
      user_id: userId,
      tombstoned: true,
      stripe_skipped: stripeSkipped,
      canceled_subscriptions_on_stripe: canceledOnStripe,
      del_auth_warning: delAuthWarn,
      note:
        "Connected account is NOT deleted here. Close it later when Stripe balance is fully settled.",
    });
  } catch (e: any) {
    return json(500, {
      error: e?.message || String(e),
    });
  }
});