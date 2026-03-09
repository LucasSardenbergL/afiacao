import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const NVOIP_BASE = "https://api.nvoip.com.br/v2";
const OAUTH_BASIC = "Basic TnZvaXBBcGlWMjpUblp2YVhCQmNHbFdNakl3TWpFPQ==";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Auth check
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Não autorizado" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Sessão inválida" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // RBAC: only staff
    const { data: roleData } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .maybeSingle();

    if (!roleData || !["admin", "employee", "master"].includes(roleData.role)) {
      return new Response(JSON.stringify({ error: "Sem permissão" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get Nvoip credentials
    const napikey = Deno.env.get("NVOIP_NAPIKEY");
    const numbersip = Deno.env.get("NVOIP_NUMBERSIP");
    const userToken = Deno.env.get("NVOIP_USER_TOKEN");

    if (!napikey || !numbersip || !userToken) {
      return new Response(
        JSON.stringify({ error: "Credenciais Nvoip não configuradas. Configure NVOIP_NAPIKEY, NVOIP_NUMBERSIP e NVOIP_USER_TOKEN." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const body = await req.json();
    const { action } = body;

    // ─── Get or refresh OAuth token ───
    async function getAccessToken(): Promise<string> {
      // Check if we have a valid cached token in company_config
      const { data: tokenData } = await supabase
        .from("company_config")
        .select("value")
        .eq("key", "nvoip_access_token")
        .maybeSingle();

      const { data: expiresData } = await supabase
        .from("company_config")
        .select("value")
        .eq("key", "nvoip_token_expires_at")
        .maybeSingle();

      const { data: refreshData } = await supabase
        .from("company_config")
        .select("value")
        .eq("key", "nvoip_refresh_token")
        .maybeSingle();

      const now = Date.now();
      const expiresAt = expiresData?.value ? parseInt(expiresData.value) : 0;

      // Token still valid (with 5 min buffer)
      if (tokenData?.value && expiresAt > now + 300000) {
        return tokenData.value;
      }

      // Try refresh token first
      if (refreshData?.value) {
        try {
          const refreshResp = await fetch(`${NVOIP_BASE}/oauth/token`, {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              Authorization: OAUTH_BASIC,
            },
            body: `grant_type=refresh_token&refresh_token=${refreshData.value}`,
          });

          if (refreshResp.ok) {
            const data = await refreshResp.json();
            await saveTokens(supabase, data);
            return data.access_token;
          }
        } catch (e) {
          console.error("Refresh token failed, generating new one:", e);
        }
      }

      // Generate new token
      const resp = await fetch(`${NVOIP_BASE}/oauth/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: OAUTH_BASIC,
        },
        body: `username=${numbersip}&password=${userToken}&grant_type=password`,
      });

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`Falha ao autenticar na Nvoip: ${resp.status} - ${errText}`);
      }

      const data = await resp.json();
      await saveTokens(supabase, data);
      return data.access_token;
    }

    async function saveTokens(sb: any, tokenResp: any) {
      const expiresAt = Date.now() + (tokenResp.expires_in || 86400) * 1000;

      const upsert = async (key: string, value: string) => {
        const { data: existing } = await sb
          .from("company_config")
          .select("id")
          .eq("key", key)
          .maybeSingle();

        if (existing) {
          await sb.from("company_config").update({ value, updated_at: new Date().toISOString() }).eq("key", key);
        } else {
          await sb.from("company_config").insert({ key, value });
        }
      };

      await upsert("nvoip_access_token", tokenResp.access_token);
      await upsert("nvoip_refresh_token", tokenResp.refresh_token || "");
      await upsert("nvoip_token_expires_at", expiresAt.toString());
    }

    // ─── Actions ───

    if (action === "make_call") {
      const { called } = body;
      if (!called) {
        return new Response(JSON.stringify({ error: "Número de destino obrigatório" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Clean phone number - keep only digits
      const cleanPhone = called.replace(/\D/g, "");

      const accessToken = await getAccessToken();
      const resp = await fetch(`${NVOIP_BASE}/calls/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          caller: numbersip,
          called: cleanPhone,
        }),
      });

      const data = await resp.json();
      if (!resp.ok) {
        return new Response(JSON.stringify({ error: "Erro ao realizar chamada", details: data }), {
          status: resp.status,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ success: true, callId: data.callId, state: data.state }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "check_call") {
      const { callId } = body;
      if (!callId) {
        return new Response(JSON.stringify({ error: "callId obrigatório" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const accessToken = await getAccessToken();
      const resp = await fetch(
        `${NVOIP_BASE}/calls?callId=${callId}&napikey=${napikey}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
        }
      );

      const data = await resp.json();
      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "end_call") {
      const { callId } = body;
      if (!callId) {
        return new Response(JSON.stringify({ error: "callId obrigatório" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const accessToken = await getAccessToken();
      const resp = await fetch(
        `${NVOIP_BASE}/endcall?callId=${callId}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
        }
      );

      const data = await resp.json();
      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "call_history") {
      const { type = "", date = "today" } = body;

      const accessToken = await getAccessToken();
      const resp = await fetch(
        `${NVOIP_BASE}/calls/history?type=${type}&date=${date}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
        }
      );

      const data = await resp.json();
      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "check_balance") {
      const resp = await fetch(`${NVOIP_BASE}/system/balance?napikey=${napikey}`);
      const data = await resp.json();
      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: `Ação desconhecida: ${action}` }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("nvoip-calls error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Erro interno" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
