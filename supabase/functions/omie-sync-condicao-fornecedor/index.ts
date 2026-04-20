// Edge function: omie-sync-condicao-fornecedor
// Para cada fornecedor habilitado, busca o último pedido de compra no Omie
// e popula fornecedor_condicao_pagamento_padrao com a condição usada.
// Manual: POST {"empresa": "OBEN", "fornecedor_nome": "..." opcional}
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const OMIE_PEDIDO_COMPRA_URL = "https://app.omie.com.br/api/v1/produtos/pedidocompra/";

function getOmieCreds(empresa: string): { app_key: string; app_secret: string } {
  const up = empresa.toUpperCase();
  const app_key = Deno.env.get(`OMIE_${up}_APP_KEY`);
  const app_secret = Deno.env.get(`OMIE_${up}_APP_SECRET`);
  if (!app_key || !app_secret) {
    throw new Error(`Credenciais Omie ausentes para empresa ${empresa}`);
  }
  return { app_key, app_secret };
}

async function omieCall(
  call: string,
  param: unknown,
  creds: { app_key: string; app_secret: string },
): Promise<any> {
  const r = await fetch(OMIE_PEDIDO_COMPRA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ call, app_key: creds.app_key, app_secret: creds.app_secret, param: [param] }),
  });
  const text = await r.text();
  let json: any;
  try { json = JSON.parse(text); } catch { throw new Error(`Omie ${call}: não-JSON: ${text.slice(0,300)}`); }
  if (!r.ok || json?.faultstring) {
    throw new Error(`Omie ${call} [${r.status}]: ${json?.faultstring ?? text.slice(0,300)}`);
  }
  return json;
}

async function ultimaCondicaoFornecedor(
  nCodFor: number,
  creds: { app_key: string; app_secret: string },
): Promise<{ codigo: string; pedido_id: string } | null> {
  // ListarPedidosCompra com filtro por fornecedor, ordenado desc
  try {
    const resp = await omieCall(
      "ListarPedidosCompra",
      {
        nPagina: 1,
        nRegPorPagina: 5,
        cOrdenarPor: "DATA_DESC",
        filtrar_por_fornecedor: nCodFor,
      },
      creds,
    );
    const lista: any[] = resp?.pedido_compra_produto ?? resp?.cadastros ?? resp?.lista_pedidos ?? [];
    for (const p of lista) {
      const cab = p?.cabecalho ?? p;
      const cod = cab?.nCodCondPagto ?? cab?.codigo_condicao_pagamento ?? cab?.cCodCondPagto;
      const pid = String(cab?.nCodPed ?? cab?.codigo_pedido ?? cab?.cCodIntPed ?? "");
      if (cod !== undefined && cod !== null && String(cod).length > 0) {
        return { codigo: String(cod), pedido_id: pid };
      }
    }
    return null;
  } catch (e) {
    console.error(`[cond-forn] erro fornecedor ${nCodFor}:`, e instanceof Error ? e.message : String(e));
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const startedAt = Date.now();
  let empresa = "OBEN";
  let fornecedorFiltro: string | null = null;

  try {
    if (req.method === "POST") {
      try {
        const body = await req.json();
        if (body?.empresa) empresa = String(body.empresa).toUpperCase();
        if (body?.fornecedor_nome) fornecedorFiltro = String(body.fornecedor_nome);
      } catch { /* default */ }
    }

    const db = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const creds = getOmieCreds(empresa);

    // 1. Buscar fornecedores habilitados (ou um específico)
    let q = db
      .from("fornecedor_habilitado_reposicao")
      .select("fornecedor_nome")
      .eq("empresa", empresa);
    if (fornecedorFiltro) q = q.eq("fornecedor_nome", fornecedorFiltro);
    const { data: fornecedores, error: fErr } = await q;
    if (fErr) throw new Error(`fornecedores: ${fErr.message}`);

    if (!fornecedores || fornecedores.length === 0) {
      return new Response(JSON.stringify({ ok: true, empresa, processados: 0, msg: "Sem fornecedores" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let upserts = 0;
    let semCondicao = 0;
    let semCodOmie = 0;
    const detalhes: Record<string, string> = {};

    for (const f of fornecedores) {
      const { data: cache } = await db
        .from("fornecedor_omie_cache")
        .select("omie_codigo_cliente_fornecedor")
        .eq("empresa", empresa)
        .eq("fornecedor_nome", f.fornecedor_nome)
        .maybeSingle();

      const nCodFor = Number(cache?.omie_codigo_cliente_fornecedor ?? 0);
      if (!nCodFor) {
        semCodOmie++;
        detalhes[f.fornecedor_nome] = "sem_cache_omie";
        continue;
      }

      const cond = await ultimaCondicaoFornecedor(nCodFor, creds);
      if (!cond) {
        semCondicao++;
        detalhes[f.fornecedor_nome] = "sem_pedido_anterior";
        continue;
      }

      // Buscar dados da condição no catálogo
      const { data: catalogo } = await db
        .from("omie_condicao_pagamento_catalogo")
        .select("descricao, num_parcelas, dias_parcelas")
        .eq("empresa", empresa)
        .eq("codigo", cond.codigo)
        .maybeSingle();

      const { error: upErr } = await db
        .from("fornecedor_condicao_pagamento_padrao")
        .upsert({
          empresa,
          fornecedor_nome: f.fornecedor_nome,
          ultima_condicao_codigo: cond.codigo,
          ultima_condicao_descricao: catalogo?.descricao ?? cond.codigo,
          ultimo_num_parcelas: catalogo?.num_parcelas ?? null,
          ultimos_dias_parcelas: catalogo?.dias_parcelas ?? null,
          fonte_omie_pedido_id: cond.pedido_id,
          ultima_atualizacao: new Date().toISOString(),
        }, { onConflict: "empresa,fornecedor_nome" });

      if (upErr) {
        detalhes[f.fornecedor_nome] = `erro_upsert: ${upErr.message}`;
      } else {
        upserts++;
        detalhes[f.fornecedor_nome] = `ok cod=${cond.codigo}`;
      }
    }

    const duration = Date.now() - startedAt;
    await db.from("sync_reprocess_log").insert({
      entity_type: "fornecedor_condicao_padrao",
      account: empresa,
      reprocess_type: "sync_full",
      window_start: new Date(startedAt).toISOString(),
      window_end: new Date().toISOString(),
      status: "ok",
      upserts_count: upserts,
      duration_ms: duration,
      metadata: { fornecedores: fornecedores.length, sem_condicao: semCondicao, sem_cod_omie: semCodOmie, detalhes },
    });

    return new Response(JSON.stringify({
      ok: true,
      empresa,
      fornecedores_total: fornecedores.length,
      upserts,
      sem_condicao: semCondicao,
      sem_cod_omie: semCodOmie,
      detalhes,
      duration_ms: duration,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[cond-forn] ERRO FATAL:", msg);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
