import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const OMIE_API_URL = "https://app.omie.com.br/api/v1";

const TINT_FAMILIES: Record<string, string> = {
  "bases mixmachine": "base",
  "concentrados mixmachine": "concentrado",
};

async function callOmieApi(
  endpoint: string,
  call: string,
  params: Record<string, unknown>,
) {
  const APP_KEY = Deno.env.get("OMIE_VENDAS_APP_KEY");
  const APP_SECRET = Deno.env.get("OMIE_VENDAS_APP_SECRET");
  if (!APP_KEY || !APP_SECRET) throw new Error("Credenciais Oben (vendas) não configuradas");

  const body = {
    call,
    app_key: APP_KEY,
    app_secret: APP_SECRET,
    param: [params],
  };

  console.log(`[tint-omie-sync] Chamando ${endpoint} - ${call}`);

  const maxRetries = 3;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(`${OMIE_API_URL}/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const result = await response.json();

    if (result.faultstring) {
      const fs = String(result.faultstring);
      const isRateLimit =
        fs.includes("Já existe uma requisição desse método") ||
        fs.includes("Consumo redundante") ||
        fs.includes("REDUNDANT") ||
        fs.includes("consumo redundante");
      if (isRateLimit && attempt < maxRetries) {
        const waitMatch = fs.match(/Aguarde (\d+) segundos/);
        const requestedDelay = waitMatch ? parseInt(waitMatch[1]) : (attempt + 1) * 5;
        const delay = Math.min(requestedDelay + 2, 15) * 1000;
        console.log(`[tint-omie-sync] Rate limit, waiting ${delay / 1000}s (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      if (isRateLimit) {
        console.log(`[tint-omie-sync] Rate limit persists after ${maxRetries} retries, returning null`);
        return null;
      }
      throw new Error(`Erro Omie: ${fs}`);
    }

    return result;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const { action } = await req.json();

    if (action !== "sync_tint_products") {
      return new Response(JSON.stringify({ error: "Ação inválida" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let pagina = 1;
    let totalPaginas = 1;
    let totalSynced = 0;
    const maxPages = 20;
    let pagesProcessed = 0;

    while (pagina <= totalPaginas && pagesProcessed < maxPages) {
      const result = (await callOmieApi("geral/produtos/", "ListarProdutos", {
        pagina,
        registros_por_pagina: 100,
        apenas_importado_api: "N",
        filtrar_apenas_omiepdv: "N",
      })) as any;

      if (!result) {
        console.log(`[tint-omie-sync] Sync interrupted by rate limit at page ${pagina}`);
        break;
      }

      totalPaginas = result.total_de_paginas || 1;
      const produtos = result.produto_servico_cadastro || [];

      const rows = produtos
        .filter((prod: any) => {
          if (prod.inativo === "S") return false;
          const familia = (prod.descricao_familia || "").toLowerCase().trim();
          return Object.keys(TINT_FAMILIES).some((f) => familia === f);
        })
        .map((prod: any) => {
          const familia = (prod.descricao_familia || "").toLowerCase().trim();
          const tintType = TINT_FAMILIES[familia] || null;
          return {
            omie_codigo_produto: prod.codigo_produto,
            omie_codigo_produto_integracao: prod.codigo_produto_integracao || null,
            codigo: prod.codigo || `PROD-${prod.codigo_produto}`,
            descricao: prod.descricao || prod.descricao_familia || "Produto sem descrição",
            unidade: prod.unidade || "UN",
            ncm: prod.ncm || null,
            valor_unitario: prod.valor_unitario || 0,
            estoque: prod.quantidade_estoque || 0,
            ativo: true,
            familia: prod.descricao_familia || null,
            imagem_url: prod.imagens?.[0]?.url_imagem || null,
            is_tintometric: true,
            tint_type: tintType,
            metadata: {
              marca: prod.marca,
              modelo: prod.modelo,
              peso_bruto: prod.peso_bruto,
              peso_liq: prod.peso_liq,
              descricao_familia: prod.descricao_familia,
            },
            account: "oben",
            updated_at: new Date().toISOString(),
          };
        });

      if (rows.length > 0) {
        const { error } = await supabase
          .from("omie_products")
          .upsert(rows, { onConflict: "omie_codigo_produto,account" });
        if (error) {
          console.error(`[tint-omie-sync] Erro upsert página ${pagina}:`, error);
        } else {
          totalSynced += rows.length;
        }
      }

      console.log(
        `[tint-omie-sync] Página ${pagina}/${totalPaginas} - ${produtos.length} total, ${rows.length} tintométricos`,
      );
      pagina++;
      pagesProcessed++;
    }

    return new Response(
      JSON.stringify({
        status: "ok",
        total_sincronizado: totalSynced,
        paginas_processadas: pagesProcessed,
        total_paginas: totalPaginas,
        completo: pagina > totalPaginas,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("[tint-omie-sync] Erro:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
