import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  try {
    const wsUri = Deno.env.get("NVOIP_SIP_WSS");
    const sipDomain = Deno.env.get("NVOIP_SIP_DOMAIN");
    const username = Deno.env.get("NVOIP_SIP_USER");
    const password = Deno.env.get("NVOIP_SIP_PASS");

    if (!wsUri || !sipDomain || !username || !password) {
      return new Response(
        JSON.stringify({ error: "Credenciais SIP não configuradas no servidor" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ wsUri, sipDomain, username, password }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Erro interno" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
