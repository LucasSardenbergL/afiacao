import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getOmieCredentials(account: string) {
  const map: Record<string, { key: string; secret: string }> = {
    oben: {
      key: Deno.env.get("OMIE_VENDAS_APP_KEY") || "",
      secret: Deno.env.get("OMIE_VENDAS_APP_SECRET") || "",
    },
    colacor: {
      key: Deno.env.get("OMIE_APP_KEY") || "",
      secret: Deno.env.get("OMIE_APP_SECRET") || "",
    },
    colacor_vendas: {
      key: Deno.env.get("OMIE_COLACOR_VENDAS_APP_KEY") || "",
      secret: Deno.env.get("OMIE_COLACOR_VENDAS_APP_SECRET") || "",
    },
  };
  return map[account] || map["colacor"];
}

async function callOmieWithRetry(
  appKey: string,
  appSecret: string,
  codigoProduto: number,
  maxRetries = 3
) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const resp = await fetch(
        "https://app.omie.com.br/api/v1/produtos/produtoslote/",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            call: "ConsultarLote",
            app_key: appKey,
            app_secret: appSecret,
            param: [{ nCodProd: codigoProduto }],
          }),
        }
      );
      if (!resp.ok) {
        const txt = await resp.text();
        console.error(`Omie HTTP ${resp.status}: ${txt}`);
        if (attempt < maxRetries - 1) {
          await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
          continue;
        }
        throw new Error(`Omie API error: ${resp.status}`);
      }
      return await resp.json();
    } catch (err) {
      if (attempt < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
        continue;
      }
      throw err;
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { produto_omie_id, account = "colacor" } = await req.json();

    if (!produto_omie_id) {
      return new Response(
        JSON.stringify({ error: "produto_omie_id é obrigatório" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const cacheKey = `lotes_${account}_${produto_omie_id}`;

    // Check cache
    const { data: cached } = await supabase
      .from("cache_lotes")
      .select("data, expires_at")
      .eq("cache_key", cacheKey)
      .single();

    if (cached && new Date(cached.expires_at) > new Date()) {
      console.log(`Cache hit for ${cacheKey}`);
      return new Response(JSON.stringify(cached.data), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Call Omie
    const creds = getOmieCredentials(account);
    if (!creds.key || !creds.secret) {
      return new Response(
        JSON.stringify({ error: `Credenciais não configuradas para account: ${account}` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Querying Omie lots for product ${produto_omie_id}, account ${account}`);
    const omieResult = await callOmieWithRetry(creds.key, creds.secret, produto_omie_id);

    // Parse lots: Omie returns lotes array or error
    let lotes: any[] = [];
    let temControleLote = false;

    if (omieResult?.lotes && Array.isArray(omieResult.lotes)) {
      temControleLote = true;
      lotes = omieResult.lotes
        .filter((l: any) => l.nQuantidade > 0)
        .map((l: any) => ({
          numero_lote: l.cLote || l.cNumeroLote || "",
          data_fabricacao: l.dFabricacao || null,
          data_validade: l.dValidade || null,
          quantidade: l.nQuantidade || 0,
          localizacao: l.cLocalEstoque || null,
        }))
        .sort((a: any, b: any) => {
          if (!a.data_validade) return 1;
          if (!b.data_validade) return -1;
          return new Date(a.data_validade).getTime() - new Date(b.data_validade).getTime();
        });
    } else if (omieResult?.faultstring?.includes("não possui controle de lote")) {
      temControleLote = false;
    }

    const result = { temControleLote, lotes, produto_omie_id, account };

    // Upsert cache
    const expiresAt = new Date(Date.now() + CACHE_TTL_MS).toISOString();
    await supabase.from("cache_lotes").upsert(
      { cache_key: cacheKey, data: result, expires_at: expiresAt },
      { onConflict: "cache_key" }
    );

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("Error:", err);
    return new Response(
      JSON.stringify({ error: err.message || "Erro interno" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
