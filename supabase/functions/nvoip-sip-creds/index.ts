import { createClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  try {
    // Lookup por user_id (vendor_sip_credentials) — preferência sobre env vars
    if (auth.userId) {
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );

      const { data: vendorCred, error: lookupErr } = await supabase
        .from("vendor_sip_credentials")
        .select("sip_user, sip_pass, sip_caller_id")
        .eq("user_id", auth.userId)
        .maybeSingle();

      if (lookupErr) {
        console.error("vendor_sip_credentials lookup error:", lookupErr);
      }

      if (vendorCred) {
        const wsUri = Deno.env.get("NVOIP_SIP_WSS");
        const sipDomain = Deno.env.get("NVOIP_SIP_DOMAIN");
        if (!wsUri || !sipDomain) {
          return new Response(
            JSON.stringify({
              error: "NVOIP_SIP_WSS ou NVOIP_SIP_DOMAIN não configurados",
            }),
            {
              status: 500,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }
        // Caller-ID único de empresa: lê company_config; cai no valor por vendedor se ausente.
        const { data: cfg } = await supabase
          .from("company_config").select("value").eq("key", "nvoip_outbound_caller_id").maybeSingle();
        const companyCallerId = cfg?.value ?? null;
        return new Response(
          JSON.stringify({
            wsUri,
            sipDomain,
            username: vendorCred.sip_user,
            password: vendorCred.sip_pass,
            callerId: companyCallerId ?? vendorCred.sip_caller_id ?? null,
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    // Fallback: env vars (master ramal compartilhado — PR1 behavior)
    const wsUri = Deno.env.get("NVOIP_SIP_WSS");
    const sipDomain = Deno.env.get("NVOIP_SIP_DOMAIN");
    const username = Deno.env.get("NVOIP_SIP_USER");
    const password = Deno.env.get("NVOIP_SIP_PASS");

    if (!wsUri || !sipDomain || !username || !password) {
      return new Response(
        JSON.stringify({
          error: "Credenciais SIP não configuradas no servidor",
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    return new Response(
      JSON.stringify({ wsUri, sipDomain, username, password, callerId: null }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: err instanceof Error ? err.message : "Erro interno",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
