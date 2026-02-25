// supabase/functions/get-creator-plan/index.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

function json(status: number, data: unknown) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function msFromIso(iso?: string | null) {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
}

function computeHasAccess(status: string, current_period_end: string | null) {
  const s = (status || "").toLowerCase();
  const now = Date.now();
  const cpeMs = msFromIso(current_period_end);

  if (["active", "trialing", "past_due"].includes(s)) return true;
  if (s === "canceled" && cpeMs && cpeMs > now) return true;
  return false;
}

Deno.serve(async (req) => {
  // ✅ Preflight must return 2xx with CORS headers
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json(405, { ok: false, error: "Method not allowed" });
  }

  try {
    const auth = req.headers.get("Authorization") || "";

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: auth } },
    });

    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr) throw userErr;

    const user = userData?.user;
    if (!user) return json(401, { ok: false, error: "Unauthorized" });

    const { data, error } = await supabase
      .from("entitlements")
      .select("status, current_period_end, stripe_subscription_id, stripe_customer_id")
      .eq("user_id", user.id)
      .eq("key", "creator_plan")
      .maybeSingle();

    if (error) throw error;

    const status = (data?.status || "none").toLowerCase();
    const current_period_end = data?.current_period_end ?? null;
    const has_access = data ? computeHasAccess(status, current_period_end) : false;

    return json(200, {
      ok: true,
      has_access,
      status: data ? status : "none",
      current_period_end,
      stripe_subscription_id: data?.stripe_subscription_id ?? null,
      stripe_customer_id: data?.stripe_customer_id ?? null,
    });
  } catch (e) {
    return json(500, { ok: false, error: (e as any)?.message ?? String(e) });
  }
});