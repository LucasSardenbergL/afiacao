import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";

const DEEPGRAM_API_BASE = "https://api.deepgram.com";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  try {
    const apiKey = Deno.env.get("DEEPGRAM_API_KEY");
    const projectId = Deno.env.get("DEEPGRAM_PROJECT_ID");

    if (!apiKey || !projectId) {
      return new Response(
        JSON.stringify({
          error:
            "Deepgram não configurado (DEEPGRAM_API_KEY ou DEEPGRAM_PROJECT_ID ausente)",
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Gera key temporária scoped a usage:write, TTL 300s
    const resp = await fetch(
      `${DEEPGRAM_API_BASE}/v1/projects/${projectId}/keys`,
      {
        method: "POST",
        headers: {
          Authorization: `Token ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          comment: `Temp key for staff user ${auth.userId ?? "unknown"} (${new Date().toISOString()})`,
          scopes: ["usage:write"],
          time_to_live_in_seconds: 300,
        }),
      }
    );

    if (!resp.ok) {
      const errText = await resp.text();
      console.error("Deepgram key creation failed:", resp.status, errText);
      return new Response(
        JSON.stringify({
          error: `Deepgram retornou ${resp.status}`,
          details: errText,
        }),
        {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const data = await resp.json();
    // data: { api_key_id, key, comment, scopes, expiration_date, ... }
    return new Response(
      JSON.stringify({
        key: data.key,
        expiresAt: data.expiration_date,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: err instanceof Error ? err.message : "Erro interno",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
