// supabase/functions/cancel-fan-subscription/index.ts
import Stripe from "https://esm.sh/stripe@14.21.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1?target=deno";

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
                                  if (v && v.trim().length) return v;
                                    }
                                      return "";
                                      }

                                      function getBearerToken(req: Request) {
                                        const auth = req.headers.get("Authorization") || "";
                                          if (!auth.startsWith("Bearer ")) return null;
                                            return auth.slice("Bearer ".length).trim();
                                            }

                                            Deno.serve(async (req) => {
                                              if (req.method === "OPTIONS")
                                                  return new Response("ok", { status: 200, headers: corsHeaders });
                                                    if (req.method !== "POST") return json(405, { error: "Method not allowed" });

                                                      try {
                                                          const STRIPE_SECRET_KEY = env("STRIPE_SECRET_KEY", "OP_STRIPE_SECRET_KEY");
                                                              const SUPABASE_URL = env("SUPABASE_URL");
                                                                  const SUPABASE_ANON_KEY = env("SUPABASE_ANON_KEY", "SUPABASE_ANON_PUBLIC_KEY");

                                                                      if (!STRIPE_SECRET_KEY || !SUPABASE_URL || !SUPABASE_ANON_KEY)
                                                                            return json(500, { error: "Missing env" });

                                                                                const token = getBearerToken(req);
                                                                                    if (!token) return json(401, { error: "Missing Bearer token" });

                                                                                        const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
                                                                                              global: { headers: { Authorization: `Bearer ${token}` } },
                                                                                                  });

                                                                                                      const { data: authData } = await supabase.auth.getUser();
                                                                                                          if (!authData?.user) return json(401, { error: "Unauthorized" });

                                                                                                              const fanId = authData.user.id;
                                                                                                                  const { creator_id }: Body = await req.json();
                                                                                                                      if (!creator_id) return json(400, { error: "Missing creator_id" });

                                                                                                                          const { data: row } = await supabase
                                                                                                                                .from("fan_subscriptions")
                                                                                                                                      .select("*")
                                                                                                                                            .eq("fan_id", fanId)
                                                                                                                                                  .eq("creator_id", creator_id)
                                                                                                                                                        .maybeSingle();

                                                                                                                                                            if (!row?.provider_subscription_id)
                                                                                                                                                                  return json(400, { error: "No active subscription found" });

                                                                                                                                                                      const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });

                                                                                                                                                                          const updated = await stripe.subscriptions.update(
                                                                                                                                                                                row.provider_subscription_id,
                                                                                                                                                                                      { cancel_at_period_end: true }
                                                                                                                                                                                          );

                                                                                                                                                                                              await supabase
                                                                                                                                                                                                    .from("fan_subscriptions")
                                                                                                                                                                                                          .update({
                                                                                                                                                                                                                  status: updated.status,
                                                                                                                                                                                                                          cancel_at_period_end: updated.cancel_at_period_end,
                                                                                                                                                                                                                                  current_period_end: updated.current_period_end
                                                                                                                                                                                                                                            ? new Date(updated.current_period_end * 1000).toISOString()
                                                                                                                                                                                                                                                      : null,
                                                                                                                                                                                                                                                              updated_at: new Date().toISOString(),
                                                                                                                                                                                                                                                                    })
                                                                                                                                                                                                                                                                          .eq("id", row.id);

                                                                                                                                                                                                                                                                              return json(200, { success: true });
                                                                                                                                                                                                                                                                                } catch (e) {
                                                                                                                                                                                                                                                                                    return json(500, { error: "Internal error", details: String(e) });
                                                                                                                                                                                                                                                                                      }
                                                                                                                                                                                                                                                                                      });