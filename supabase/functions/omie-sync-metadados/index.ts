import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const OMIE_API_URL = "https://app.omie.com.br/api/v1";
const PAGE_SIZE = 100;

type OmieAccount = "vendas" | "colacor_vendas";

function getCredentials(account: OmieAccount) {
  if (account === "vendas") {
    return {
      key: Deno.env.get("OMIE_OBEN_APP_KEY"),
      secret: Deno.env.get("OMIE_OBEN_APP_SECRET"),
      label: "oben",
    };
  }
  return {
    key: Deno.env.get("OMIE_COLACOR_APP_KEY"),
    secret: Deno.env.get("OMIE_COLACOR_APP_SECRET"),
    label: "colacor",
  };
}

async function callOmie(
  account: OmieAccount,
  endpoint: string,
  call: string,
  params: Record<string, unknown>,
) {
  const creds = getCredentials(account);
  if (!creds.key || !creds.secret) {
    throw new Error(`Credenciais Omie (${account}) não configuradas`);
  }
  const body = { call, app_key: creds.key, app_secret: creds.secret, param: [params] };
  const res = await fetch(`${OMIE_API_URL}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await res.json();
  if (result.faultstring) throw new Error(`Omie (${account}): ${result.faultstring}`);
  return result;
}

async function syncMetadadosAccount(
  db: any,
  account: OmieAccount,
) {
  const acctValue = getCredentials(account).label;
  let pagina = 1;
  let totalPaginas = 1;
  let totalUpserted = 0;
  let totalInativos = 0;
  const t0 = Date.now();

  while (pagina <= totalPaginas) {
    const result = await callOmie(account, "geral/produtos/", "ListarProdutos", {
      pagina,
      registros_por_pagina: PAGE_SIZE,
      apenas_importado_api: "N",
      filtrar_apenas_omiepdv: "N",
    }) as Record<string, unknown> & {
      total_de_paginas?: number;
      produto_servico_cadastro?: Array<Record<string, unknown>>;
    };

    totalPaginas = result.total_de_paginas || 1;
    const produtos = result.produto_servico_cadastro || [];

    const rows = produtos.map((p: Record<string, unknown> & { imagens?: Array<{ url_imagem?: string }> }) => {
      const inativoFlag = p.inativo === "S";
      if (inativoFlag) totalInativos++;
      return {
        omie_codigo_produto: p.codigo_produto,
        omie_codigo_produto_integracao: p.codigo_produto_integracao || null,
        codigo: p.codigo || `PROD-${p.codigo_produto}`,
        descricao: p.descricao || "Sem descrição",
        unidade: p.unidade || "UN",
        ncm: p.ncm || null,
        valor_unitario: p.valor_unitario || 0,
        estoque: p.quantidade_estoque || 0,
        ativo: !inativoFlag,
        account: acctValue,
        imagem_url: p.imagens?.[0]?.url_imagem || null,
        familia: p.descricao_familia || null,
        subfamilia: p.descricao_subfamilia || null,
        metadata: {
          marca: p.marca,
          modelo: p.modelo,
          peso_bruto: p.peso_bruto,
          peso_liq: p.peso_liq,
          descricao_familia: p.descricao_familia,
          cfop: p.cfop,
          inativo_omie: p.inativo,
        },
        updated_at: new Date().toISOString(),
      };
    });

    if (rows.length > 0) {
      const { error } = await db
        .from("omie_products")
        .upsert(rows, { onConflict: "omie_codigo_produto,account" });
      if (error) {
        console.error(`[metadados ${account}] erro upsert p${pagina}:`, error);
      } else {
        totalUpserted += rows.length;
      }
    }

    console.log(`[metadados ${account}] página ${pagina}/${totalPaginas} (${rows.length} itens)`);
    pagina++;
  }

  await db.from("sync_state").upsert(
    {
      entity_type: "products_metadados",
      account: acctValue,
      status: "complete",
      total_synced: totalUpserted,
      last_sync_at: new Date().toISOString(),
      last_page: totalPaginas,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "entity_type,account" },
  );

  return {
    account: acctValue,
    paginas: totalPaginas,
    upserted: totalUpserted,
    inativos: totalInativos,
    tempo_ms: Date.now() - t0,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    let body: { accounts?: OmieAccount[] } = {};
    try {
      body = await req.json();
    } catch (_e) {
      // body opcional
    }
    const accounts: OmieAccount[] = body.accounts && body.accounts.length > 0
      ? body.accounts
      : ["vendas", "colacor_vendas"];

    const results = [];
    for (const acct of accounts) {
      try {
        results.push(await syncMetadadosAccount(supabaseAdmin, acct));
      } catch (err) {
        console.error(`[metadados] falhou para ${acct}:`, err);
        results.push({ account: acct, error: String(err) });
      }
    }

    return new Response(
      JSON.stringify({ success: true, results }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("[omie-sync-metadados] erro fatal:", error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
