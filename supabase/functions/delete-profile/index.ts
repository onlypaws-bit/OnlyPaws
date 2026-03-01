// supabase/functions/delete-profile/index.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";

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
  confirm?: boolean;
  reason?: string;
};

function uniq<T>(arr: T[]) {
  return Array.from(new Set(arr));
}

function env(name: string) {
  const v = Deno.env.get(name);
  return v && v.trim().length ? v.trim() : "";
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
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const SUPABASE_URL = env("SUPABASE_URL");
    const SUPABASE_ANON_KEY = env("SUPABASE_ANON_KEY");
    const SUPABASE_SERVICE_ROLE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
    const STRIPE_SECRET_KEY = env("STRIPE_SECRET_KEY");

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
      return json(500, {
        error: "Missing Supabase env (SUPABASE_URL/ANON_KEY/SERVICE_ROLE_KEY)",
      });
    }

    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.toLowerCase().startsWith("bearer ")) {
      return json(401, { error: "Missing/invalid Authorization header" });
    }
    const jwt = authHeader.slice(7).trim();
    if (!jwt) return json(401, { error: "Missing JWT" });

    // User-scoped client to validate session
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });

    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return json(401, { error: "Invalid user session" });

    const userId = userData.user.id;
    const userEmail = userData.user.email ?? null;

    let body: Body | null = null;
    try {
      body = await req.json();
    } catch {
      body = null;
    }
    if (body?.confirm !== true) return json(400, { error: "Missing confirm=true" });

    const reason = (body?.reason ?? "user_request").trim() || "user_request";
    const nowIso = new Date().toISOString();

    // Admin client (service role)
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // ---- 0) Fetch full profile snapshot
    const { data: myProf, error: myProfErr } = await admin
      .from("profiles")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    if (myProfErr) return json(500, { error: myProfErr.message });

    const myConnectedId =
      String((myProf as any)?.stripe_connect_account_id ?? "").trim() || null;

    // ---- helper: merge snapshot meta without losing existing snapshot
    async function mergeTombstoneMeta(metaPatch: Record<string, unknown>) {
      const { data: existing, error: exErr } = await admin
        .from("deleted_profiles")
        .select("snapshot")
        .eq("user_id", userId)
        .maybeSingle();

      if (exErr) return; // best-effort, non blocca

      const existingSnap = (existing as any)?.snapshot ?? {};
      const nextSnap: TombSnapshot =
        typeof existingSnap === "object" && existingSnap !== null
          ? existingSnap
          : { profile: myProf ?? { user_id: userId, email: userEmail } };

      // normalizza a forma {profile, meta}
      const normalized: TombSnapshot =
        "profile" in nextSnap
          ? nextSnap
          : { profile: nextSnap, meta: {} };

      const updated: TombSnapshot = {
        profile: normalized.profile ?? (myProf ?? { user_id: userId, email: userEmail }),
        meta: { ...(normalized.meta ?? {}), ...metaPatch },
      };

      await admin.from("deleted_profiles").update({ snapshot: updated }).eq("user_id", userId);
    }

    // ---- 1) Gather fan_subscriptions where user is FAN
    const { data: fanSubs, error: fanSubsErr } = await admin
      .from("fan_subscriptions")
      .select("id,creator_id,provider_subscription_id,status")
      .eq("fan_id", userId)
      .not("provider_subscription_id", "is", null);

    if (fanSubsErr) return json(500, { error: fanSubsErr.message });

    const creatorIds = uniq((fanSubs ?? []).map((r: any) => r.creator_id).filter(Boolean));

    // creator_id -> connectedId map
    const creatorConnectedMap = new Map<string, string>();

    if (creatorIds.length) {
      const { data: creatorsProf, error: creatorsProfErr } = await admin
        .from("profiles")
        .select("user_id,stripe_connect_account_id")
        .in("user_id", creatorIds);

      if (creatorsProfErr) return json(500, { error: creatorsProfErr.message });

      for (const p of creatorsProf ?? []) {
        const cid = String((p as any).stripe_connect_account_id ?? "").trim();
        if (cid) creatorConnectedMap.set(String((p as any).user_id), cid);
      }
    }

    // ---- 2) Gather fan_subscriptions where user is CREATOR
    const { data: creatorSubs, error: creatorSubsErr } = await admin
      .from("fan_subscriptions")
      .select("id,provider_subscription_id,status")
      .eq("creator_id", userId)
      .not("provider_subscription_id", "is", null);

    if (creatorSubsErr) return json(500, { error: creatorSubsErr.message });

    // Se sei creator e hai subs ma non hai connected => stato corrotto, non procedo
    if ((creatorSubs ?? []).length && !myConnectedId) {
      const tombstonePayload = {
        user_id: userId,
        email: (myProf as any)?.email ?? userEmail,
        username: (myProf as any)?.username ?? null,
        stripe_connect_account_id: null,
        reason: `${reason} (blocked_no_connected)`,
        snapshot: {
          profile: myProf ?? { user_id: userId, email: userEmail },
          meta: {
            deleted_attempt_at: nowIso,
            reason,
            blocked: "creator_has_subscriptions_but_no_connected_account",
            creator_subscriptions_count: (creatorSubs ?? []).length,
          },
        },
      };

      await admin.from("deleted_profiles").upsert(tombstonePayload, { onConflict: "user_id" });

      return json(409, {
        error: "Creator has active subscriptions but no connected account id. Delete blocked.",
        creator_subscriptions_count: (creatorSubs ?? []).length,
      });
    }

    // ---- 0b) Tombstone upsert (include meta)
    const tombstonePayload = {
      user_id: userId,
      email: (myProf as any)?.email ?? userEmail,
      username: (myProf as any)?.username ?? null,
      stripe_connect_account_id: myConnectedId,
      reason,
      snapshot: {
        profile: myProf ?? { user_id: userId, email: userEmail },
        meta: {
          deleted_at: nowIso,
          reason,
          had_connected_account: !!myConnectedId,
          fan_subscriptions_count: (fanSubs ?? []).length,
          creator_subscriptions_count: (creatorSubs ?? []).length,
        },
      },
    };

    const { error: tombErr } = await admin
      .from("deleted_profiles")
      .upsert(tombstonePayload, { onConflict: "user_id" });

    if (tombErr) return json(500, { error: tombErr.message });

    // ---- 3) Cancel Stripe subscriptions (best-effort, but track success)
    let stripeSkipped = false;
    let canceledOnStripe = 0;
    const cancelErrors: Array<{ subId: string; connectedId: string | null; err: string }> = [];
    const canceledDbIds = new Set<string>(); // fan_subscriptions.id to mark canceled only if Stripe succeeded

    let stripe: Stripe | null = null;
    if (STRIPE_SECRET_KEY) {
      stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });
    } else {
      stripeSkipped = true;
    }

    if (stripe) {
      // 3a) user is FAN (on each creator connected)
      for (const r of fanSubs ?? []) {
        const rowId = String((r as any).id ?? "").trim();
        const subId = String((r as any).provider_subscription_id ?? "").trim();
        const creatorId = String((r as any).creator_id ?? "").trim();
        if (!rowId || !subId || !creatorId) continue;

        const connectedId = creatorConnectedMap.get(creatorId) ?? null;
        if (!connectedId) {
          cancelErrors.push({
            subId,
            connectedId: null,
            err: "Missing creator connected account id",
          });
          continue;
        }

        try {
          await stripe.subscriptions.cancel(subId, { stripeAccount: connectedId });
          canceledOnStripe++;
          canceledDbIds.add(rowId);
        } catch (e: any) {
          cancelErrors.push({ subId, connectedId, err: e?.message ?? String(e) });
        }
      }

      // 3b) user is CREATOR (on user's connected)
      if (myConnectedId) {
        for (const r of creatorSubs ?? []) {
          const rowId = String((r as any).id ?? "").trim();
          const subId = String((r as any).provider_subscription_id ?? "").trim();
          if (!rowId || !subId) continue;

          try {
            await stripe.subscriptions.cancel(subId, { stripeAccount: myConnectedId });
            canceledOnStripe++;
            canceledDbIds.add(rowId);
          } catch (e: any) {
            cancelErrors.push({ subId, connectedId: myConnectedId, err: e?.message ?? String(e) });
          }
        }
      }
    }

    // ---- 4) Mark DB subs canceled ONLY for Stripe-success rows (best-effort)
    const dbUpdateErrors: string[] = [];
    const idsToUpdate = Array.from(canceledDbIds);

    if (idsToUpdate.length) {
      const { error } = await admin
        .from("fan_subscriptions")
        .update({
          status: "canceled",
          cancel_at_period_end: false,
          canceled_at: nowIso,
          updated_at: nowIso,
        })
        .in("id", idsToUpdate);

      if (error) dbUpdateErrors.push(`fan_subscriptions update failed: ${error.message}`);
    }

    // ---- 4b) Persist Stripe/DB results in tombstone snapshot (best-effort)
    await mergeTombstoneMeta({
      stripe_skipped: stripeSkipped,
      canceled_on_stripe: canceledOnStripe,
      canceled_in_db: idsToUpdate.length,
      cancel_errors: cancelErrors.slice(0, 50),
      db_update_errors: dbUpdateErrors,
    });

    // ---- 5) Delete profile (CASCADE should clean related rows)
    const { error: delProfErr } = await admin
      .from("profiles")
      .delete()
      .eq("user_id", userId);

    if (delProfErr) return json(500, { error: delProfErr.message });

    // ---- 6) Delete auth user
    const { error: delAuthErr } = await admin.auth.admin.deleteUser(userId);
    if (delAuthErr) return json(500, { error: delAuthErr.message });

    return json(200, {
      ok: true,
      user_id: userId,
      tombstoned: true,
      had_connected_account: !!myConnectedId,
      stripe_skipped: stripeSkipped,
      canceled_subscriptions_on_stripe: canceledOnStripe,
      canceled_subscriptions_in_db: idsToUpdate.length,
      cancel_errors_count: cancelErrors.length,
      cancel_errors: cancelErrors.slice(0, 25),
      db_update_errors,
      note:
        "Connected account is NOT deleted here. Close it later only when Stripe balance/payouts are fully settled (balance=0).",
    });
  } catch (e: any) {
    return json(500, { error: e?.message || String(e) });
  }
});