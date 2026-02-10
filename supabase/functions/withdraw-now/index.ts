// supabase/functions/withdraw-now/index.ts
import Stripe from "https://esm.sh/stripe@14.21.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status:number, data:unknown){
  return new Response(JSON.stringify(data),{
    status,
    headers:{...corsHeaders,"Content-Type":"application/json"}
  });
}

Deno.serve(async (req)=>{
  if(req.method==="OPTIONS") return new Response("ok",{headers:corsHeaders});
  if(req.method!=="POST") return json(405,{error:"Method not allowed"});

  try{
    const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");

    if(!STRIPE_SECRET_KEY||!SUPABASE_URL||!SERVICE_KEY||!ANON_KEY)
      return json(500,{error:"Missing env vars"});

    const auth = req.headers.get("Authorization") ?? "";
    const supa = createClient(SUPABASE_URL, ANON_KEY,{
      global:{ headers:{Authorization:auth} }
    });

    const { data:user } = await supa.auth.getUser();
    if(!user?.user) return json(401,{error:"Not authenticated"});

    const admin = createClient(SUPABASE_URL, SERVICE_KEY,{auth:{persistSession:false}});
    const { data: prof } = await admin
      .from("profiles")
      .select("stripe_connect_account_id")
      .eq("user_id", user.user.id)
      .single();

    if(!prof?.stripe_connect_account_id)
      return json(400,{error:"Missing connect account"});

    const stripe = new Stripe(STRIPE_SECRET_KEY,{apiVersion:"2023-10-16"});

    const bal = await stripe.balance.retrieve({
      stripeAccount: prof.stripe_connect_account_id
    });

    const available =
      bal.available.find(b=>b.currency==="eur")?.amount ?? 0;

    if(available < 2000)
      return json(400,{error:"Minimum withdrawal is €20.00"});

    const payout = await stripe.payouts.create(
      { amount: available, currency:"eur" },
      { stripeAccount: prof.stripe_connect_account_id }
    );

    return json(200,{ payout_id:payout.id });

  }catch(e){
    return json(500,{error:"Server error",details:String(e)});
  }
});
