// supabase/functions/backfill-wallet/index.ts
import Stripe from "https://esm.sh/stripe@14.21.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, data: unknown) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

type Body = {
  // opzionali (se non passi nulla va benissimo)
  limit?: number; // max balance txns da leggere (default 100)
  days?: number;  // lookback giorni (default 365)
};

function clampInt(n: unknown, def: number, min: number, max: number) {
  const x = Number(n);
  if (!Number.isFinite(x)) return def;
  const i = Math.trunc(x);
  return Math.max(min, Math.min(max, i));
}

async function listBalanceTransactions(params: {
  stripe: Stripe;
  stripeAccount: string;
  limitTotal: number;
  createdGteUnix: number;
}) {
  const out: Stripe.BalanceTransaction[] = [];
  let startingAfter: string | undefined = undefined;

  while (out.length < params.limitTotal) {
    const pageLimit = Math.min(100, params.limitTotal - out.length);
    const page = await params.stripe.balanceTransactions.list(
      {
        limit: pageLimit,
        starting_after: startingAfter,
        created: { gte: params.createdGteUnix },
      },
      { stripeAccount: params.stripeAccount }
    );

    out.push(...(page.data || []));
    if (!page.has_more || !page.data?.length) break;
    startingAfter = page.data[page.data.length - 1].id;
  }

  return out;
}

async function sumAllCreatorEarnings(admin: any, creatorId: string) {
  // Sommiamo tutte le transazioni paid NON payout (netto già “come vuole OP”)
  let from = 0;
  const step = 1000;
  let total = 0;

  while (true) {
    const to = from + step - 1;
    const { data, error } = await admin
      .from("wallet_transactions")
      .select("amount_cents,type,status")
      .eq("creator_id", creatorId)
      .eq("status", "paid")
      .range(from, to);

    if (error) throw error;

    const rows = data || [];
    for (const r of rows) {
      if (String(r.type || "") === "payout") continue;
      total += Number(r.amount_cents || 0);
    }

    if (rows.length < step) break;
    from += step;
  }

  return total;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") || Deno.env.get("OP_STRIPE_SECRET_KEY");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");

    if (!STRIPE_SECRET_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_ANON_KEY) {
      return json(500, { error: "Missing env vars" });
    }

    const body = (await req.json().catch(() => ({}))) as Body;
    const limitTotal = clampInt(body?.limit, 100, 1, 500);
    const days = clampInt(body?.days, 365, 1, 3650);

    // Auth user
    const authHeader = req.headers.get("Authorization") ?? "";
    const supaUser = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData, error: userErr } = await supaUser.auth.getUser();
    if (userErr || !userData?.user) return json(401, { error: "Not authenticated" });

    const creatorId = userData.user.id;

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    // Get connect id
    const { data: prof, error: pe } = await admin
      .from("profiles")
      .select("stripe_connect_account_id")
      .eq("user_id", creatorId)
      .single();

    if (pe || !prof?.stripe_connect_account_id) {
      return json(400, { error: "Missing stripe_connect_account_id" });
    }

    const connectId = prof.stripe_connect_account_id as string;

    const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });

    const createdGteUnix = Math.floor((Date.now() - days * 24 * 60 * 60 * 1000) / 1000);

    // 1) list stripe balance txns on CONNECTED
    const btx = await listBalanceTransactions({
      stripe,
      stripeAccount: connectId,
      limitTotal,
      createdGteUnix,
    });

    // 2) keep only positive NET eur earnings
    const earnings = (btx || []).filter((t) => {
      const cur = String(t.currency || "").toLowerCase();
      const net = Number(t.net || 0);
      // net > 0 = entrata netta (quello che vuoi mostrare)
      return cur === "eur" && net > 0;
    });

    if (earnings.length === 0) {
      // riallineo comunque lifetime_earned al DB
      const total = await sumAllCreatorEarnings(admin, creatorId);

      await admin
        .from("wallets")
        .upsert(
          {
            profile_id: creatorId,
            currency: "EUR",
            lifetime_earned_cents: total,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "profile_id" }
        );

      return json(200, {
        ok: true,
        creator_id: creatorId,
        stripe_connect_account_id: connectId,
        scanned: btx.length,
        eligible: 0,
        inserted: 0,
        lifetime_earned_cents: total,
        note: "No eligible Stripe balance transactions found (net>0, eur).",
      });
    }

    // 3) idempotency: check what we already inserted
    const backfillEventIds = earnings.map((t) => `backfill_${t.id}`);

    // Supabase "in" limits are ok for <= 500
    const { data: existing, error: exErr } = await admin
      .from("wallet_transactions")
      .select("stripe_event_id")
      .in("stripe_event_id", backfillEventIds);

    if (exErr) throw exErr;

    const existingSet = new Set((existing || []).map((r: any) => r.stripe_event_id).filter(Boolean));

    const toInsert = earnings
      .filter((t) => !existingSet.has(`backfill_${t.id}`))
      .map((t) => ({
        creator_id: creatorId,
        fan_id: null, // backfill storico: fan potrebbe non essere ricostruibile senza metadata vecchi
        type: "subscription", // fallback neutro (se vuoi: "payment")
        amount_cents: Number(t.net || 0), // ✅ NETTO
        currency: "EUR",
        status: "paid",
        stripe_event_id: `backfill_${t.id}`, // idempotency
        stripe_object_id: t.id, // balance_transaction id
        // lasciamo created_at default now() (coerente per UI). Se vuoi forzarlo: serve colonna created_at override con insert.
      }));

    if (toInsert.length) {
      const ins = await admin.from("wallet_transactions").insert(toInsert);
      if (ins.error) throw ins.error;
    }

    // 4) recompute wallet lifetime earned from DB (verità DB)
    const total = await sumAllCreatorEarnings(admin, creatorId);

    // ensure wallet row exists + set totals
    const up = await admin
      .from("wallets")
      .upsert(
        {
          profile_id: creatorId,
          currency: "EUR",
          lifetime_earned_cents: total,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "profile_id" }
      );

    if (up.error) throw up.error;

    return json(200, {
      ok: true,
      creator_id: creatorId,
      stripe_connect_account_id: connectId,
      scanned: btx.length,
      eligible: earnings.length,
      inserted: toInsert.length,
      lifetime_earned_cents: total,
    });
  } catch (e) {
    console.error(e);
    return json(500, { error: "Server error", details: String((e as any)?.message ?? e) });
  }
});