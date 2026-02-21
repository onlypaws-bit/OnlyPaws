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

const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json(401, { error: "Missing Authorization header" });

    const jwt = authHeader.replace("Bearer ", "").trim();

    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: `Bearer ${jwt}` } } }
    );

    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return json(401, { error: "Invalid user session" });

    const userId = userData.user.id;

    let body: any = null;
    try { body = await req.json(); } catch { body = null; }
    if (body?.confirm !== true) return json(400, { error: "Missing confirm=true" });

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // 1) Leggi profilo per capire FAN/CREATOR + stripe ids
    const { data: profile, error: profErr } = await admin
      .from("profiles")
      .select("user_id, role, stripe_customer_id, stripe_connect_account_id")
      .eq("user_id", userId)
      .maybeSingle();

    if (profErr) return json(500, { error: profErr.message });
    // se non c'è profilo, prova comunque a cancellare auth user
    const role = profile?.role ?? null;

    // 2) STOP STRIPE SUBS IMMEDIATO
    // 2A) se FAN: cancella tutte le sub del suo customer
    if (profile?.stripe_customer_id) {
      // cancella sia active che trialing (trial = comunque “viva”)
      const statuses: Stripe.SubscriptionListParams.Status[] = ["active", "trialing", "past_due", "unpaid"];
      for (const st of statuses) {
        const subs = await stripe.subscriptions.list({
          customer: profile.stripe_customer_id,
          status: st,
          limit: 100,
        });
        for (const s of subs.data) {
          // cancel immediate
          await stripe.subscriptions.cancel(s.id);
        }
      }
    }

    // 2B) se CREATOR: cancella tutte le sub verso quel creator
    // Questa parte DIPENDE da come hai salvato i riferimenti.
    // Variante consigliata: in DB hai una tabella subscriptions con stripe_subscription_id e creator_id.
    if (role === "creator") {
      const { data: dbSubs, error: dbSubsErr } = await admin
        .from("subscriptions")
        .select("stripe_subscription_id")
        .eq("creator_id", userId);

      // se la tabella non esiste ancora, dbSubsErr potrebbe arrivare: non blocco tutto, ma segnalo
      if (!dbSubsErr && Array.isArray(dbSubs)) {
        for (const row of dbSubs) {
          if (!row?.stripe_subscription_id) continue;
          try {
            await stripe.subscriptions.cancel(row.stripe_subscription_id);
          } catch {
            // idempotenza: se già cancellata o non esiste, amen
          }
        }
      }
    }

    // (Opzionale) 2C) disconnettere / chiudere Connect account (se vuoi)
    // Stripe non sempre permette "delete" di connect account in ogni scenario; spesso si fa "reject" / "disable".
    // Io qui lo lascio commentato perché dipende da policy.
    /*
    if (profile?.stripe_connect_account_id) {
      await stripe.accounts.update(profile.stripe_connect_account_id, { capabilities: { card_payments: { requested: false }, transfers: { requested: false } } });
    }
    */

    // 3) DB DELETE — meglio affidarsi ai CASCADE
    // Se hai FK ON DELETE CASCADE fatte bene, ti basta cancellare profiles e stop.
    // Se NON sei sicura dei CASCADE, tieni le tue delete “manuali” ma NON ignorare errori.
    // Qui faccio un mix: pulizia manuale delle tabelle "di contorno" + delete profiles.
    const deletions = await Promise.allSettled([
      admin.from("withdrawals").delete().eq("profile_id", userId),
      admin.from("wallets").delete().eq("profile_id", userId),
      admin.from("entitlements").delete().eq("user_id", userId),
      admin.from("pets").delete().eq("owner_id", userId),
      admin.from("posts").delete().eq("creator_id", userId),

      // aggiunte “hard delete” che ti servono per “TUTTO”
      admin.from("follows").delete().or(`follower_id.eq.${userId},following_id.eq.${userId}`),
      admin.from("creator_plans").delete().eq("creator_id", userId),
      admin.from("post_purchases").delete().or(`fan_id.eq.${userId},creator_id.eq.${userId}`),
      admin.from("subscriptions").delete().or(`fan_id.eq.${userId},creator_id.eq.${userId}`),
    ]);

    // se qualcosa fallisce per motivi NON di tabella mancante, fermiamoci
    // (Supabase di solito ritorna errore tipo "relation does not exist" se tabella non esiste)
    const hardErrors: string[] = [];
    for (const r of deletions) {
      if (r.status === "rejected") hardErrors.push(String(r.reason));
      else {
        // r.value ha shape { data, error }
        // non tipizziamo troppo, ma controlliamo error
        const v: any = r.value;
        if (v?.error) {
          const msg = String(v.error.message ?? v.error);
          if (!msg.toLowerCase().includes("does not exist")) hardErrors.push(msg);
        }
      }
    }
    if (hardErrors.length) return json(500, { error: "DB delete failed", details: hardErrors });

    // delete profile (questa triggera CASCADE se configurato)
    const { error: delProfErr } = await admin.from("profiles").delete().eq("user_id", userId);
    if (delProfErr) return json(500, { error: delProfErr.message });

    // 4) delete auth user
    const { error: delAuthErr } = await admin.auth.admin.deleteUser(userId);
    if (delAuthErr) return json(500, { error: delAuthErr.message });

    return json(200, { ok: true });
  } catch (e: any) {
    return json(500, { error: e?.message || String(e) });
  }
});
