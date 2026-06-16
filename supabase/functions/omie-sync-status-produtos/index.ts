// Edge Function: omie-sync-status-produtos
// Sincroniza status (ativo/inativo) e parâmetros atuais de estoque do Omie
// para a tabela sku_status_omie. Usa ListarProdutos paginado (500 por página).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { authorizeCronOrStaff } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

const OMIE_URL = "https://app.omie.com.br/api/v1/geral/produtos/";
const PAGE_SIZE = 500; // Limite máximo do Omie ListarProdutos
const MAX_RETRIES = 3;
const DELAY_BETWEEN_PAGES_MS = 700; // ~85 req/min, dentro do rate limit
const FLUSH_THRESHOLD = 100; // commit incremental a cada 100 SKUs

interface OmieProduto {
  codigo_produto?: number;
  codigo?: string;
  descricao?: string;
  inativo?: string; // "S" | "N"
  estoque_minimo?: number;
  estoque_maximo?: number; // No Omie, "estoque_maximo" da listagem é normalmente o ponto de pedido
  dadosArmazenamento?: {
    estoque_minimo?: number;
    estoque_maximo?: number;
  };
}

async function omieCall(
  appKey: string,
  appSecret: string,
  call: string,
  param: Record<string, unknown>,
  attempt = 1
): Promise<Record<string, unknown>> {
  try {
    const res = await fetch(OMIE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        call,
        app_key: appKey,
        app_secret: appSecret,
        param: [param],
      }),
    });

    if (res.status === 401 || res.status === 403) {
      throw new Error(`AUTH_ERROR: Omie retornou ${res.status} (verifique secrets)`);
    }

    if (!res.ok) {
      const text = await res.text();
      // 404/425 etc — produto inexistente em ConsultarProduto
      if (res.status === 500 && text.includes("SOAP-ENV:Client")) {
        return { __not_found: true, raw: text };
      }
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    return await res.json();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("AUTH_ERROR")) throw err;
    if (attempt >= MAX_RETRIES) throw err;
    const backoff = 500 * Math.pow(2, attempt);
    await new Promise((r) => setTimeout(r, backoff));
    return omieCall(appKey, appSecret, call, param, attempt + 1);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  const startedAt = Date.now();
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  let empresa = "OBEN";
  try {
    const url = new URL(req.url);
    const qEmp = url.searchParams.get("empresa");
    if (qEmp) empresa = qEmp.toUpperCase();
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      if (body?.empresa) empresa = String(body.empresa).toUpperCase();
    }
  } catch (_) { /* parse de body opcional */ }

  const empresasPermitidas = new Set(["OBEN", "COLACOR"]);
  if (!empresasPermitidas.has(empresa)) {
    return new Response(JSON.stringify({ error: `Empresa inválida: ${empresa}` }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Inicia log
  const { data: logRow } = await supabase
    .from("sync_reprocess_log")
    .insert({
      entity_type: "sku_status_omie",
      account: empresa.toLowerCase(),
      reprocess_type: "status_produtos",
      window_start: new Date().toISOString(),
      window_end: new Date().toISOString(),
      status: "running",
      metadata: { empresa },
    })
    .select("id")
    .single();
  const logId = logRow?.id as string | undefined;

  const appKey = Deno.env.get(`OMIE_${empresa}_APP_KEY`);
  const appSecret = Deno.env.get(`OMIE_${empresa}_APP_SECRET`);
  if (!appKey || !appSecret) {
    const msg = `Secrets OMIE_${empresa}_APP_KEY/SECRET não configurados`;
    if (logId) {
      await supabase
        .from("sync_reprocess_log")
        .update({ status: "failed", error_message: msg, duration_ms: Date.now() - startedAt })
        .eq("id", logId);
    }
    return new Response(JSON.stringify({ error: msg }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    // 1) Lista de SKUs alvo: aqueles cujo fornecedor está habilitado para essa empresa
    const { data: fornecedoresHab, error: fhErr } = await supabase
      .from("fornecedor_habilitado_reposicao")
      .select("fornecedor_nome")
      .eq("empresa", empresa)
      .eq("habilitado", true);
    if (fhErr) throw fhErr;
    const fornecNomes = (fornecedoresHab ?? []).map((r) => r.fornecedor_nome);

    let skusQuery = supabase
      .from("sku_parametros")
      .select("sku_codigo_omie, sku_descricao, fornecedor_nome")
      .eq("empresa", empresa);
    if (fornecNomes.length > 0) {
      skusQuery = skusQuery.in("fornecedor_nome", fornecNomes);
    }
    const { data: skus, error: skuErr } = await skusQuery;
    if (skuErr) throw skuErr;

    const alvoSet = new Set<string>((skus ?? []).map((s) => String(s.sku_codigo_omie)));
    const totalAlvo = alvoSet.size;

    if (totalAlvo === 0) {
      if (logId) {
        await supabase
          .from("sync_reprocess_log")
          .update({
            status: "complete",
            duration_ms: Date.now() - startedAt,
            metadata: { empresa, total_alvo: 0, mensagem: "Nenhum SKU com fornecedor habilitado" },
          })
          .eq("id", logId);
      }
      return new Response(
        JSON.stringify({ ok: true, empresa, total: 0, mensagem: "Nenhum SKU alvo" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 2) Paginação Omie ListarProdutos
    let page = 1;
    let totalPages = 1;
    let sucessos = 0;
    let falhas = 0;
    let encontradosNaListagem = 0;
    const encontrados = new Set<string>();
    const upserts: Record<string, unknown>[] = [];

    do {
      const resp = await omieCall(appKey, appSecret, "ListarProdutos", {
        pagina: page,
        registros_por_pagina: PAGE_SIZE,
        apenas_importado_api: "N",
        filtrar_apenas_omiepdv: "N",
      });

      totalPages = resp?.total_de_paginas ?? 1;
      const produtos: OmieProduto[] = (resp as { produto_servico_cadastro?: OmieProduto[] })?.produto_servico_cadastro ?? [];

      for (const p of produtos) {
        const codStr = String(p.codigo_produto ?? "");
        if (!codStr || !alvoSet.has(codStr)) continue;
        encontrados.add(codStr);
        encontradosNaListagem++;

        const inativo = (p.inativo ?? "N").toUpperCase() === "S";
        const estMin =
          p.estoque_minimo ?? p.dadosArmazenamento?.estoque_minimo ?? null;
        // No Omie, "estoque_maximo" do cadastro funciona como ponto de pedido
        const pontoPed =
          p.estoque_maximo ?? p.dadosArmazenamento?.estoque_maximo ?? null;

        upserts.push({
          empresa,
          sku_codigo_omie: codStr,
          sku_descricao: p.descricao ?? null,
          ativo_no_omie: !inativo,
          data_inativacao: inativo ? new Date().toISOString() : null,
          estoque_minimo_omie: estMin,
          ponto_pedido_omie: pontoPed,
          estoque_maximo_omie: null, // Omie não distingue máximo separado
          ultima_sincronizacao: new Date().toISOString(),
          fonte_sincronizacao: "ListarProdutos",
        });
      }

      // Flush em lotes (commit incremental p/ não perder progresso em timeout)
      if (upserts.length >= FLUSH_THRESHOLD) {
        const { error: upErr } = await supabase
          .from("sku_status_omie")
          .upsert(upserts, { onConflict: "empresa,sku_codigo_omie" });
        if (upErr) {
          falhas += upserts.length;
          console.error("Upsert lote falhou:", upErr.message);
        } else {
          sucessos += upserts.length;
        }
        upserts.length = 0;
      }

      page++;
      // Rate limit Omie: ~120 req/min em ListarProdutos. 700ms é seguro.
      if (page <= totalPages) await new Promise((r) => setTimeout(r, DELAY_BETWEEN_PAGES_MS));
    } while (page <= totalPages);

    // Flush final
    if (upserts.length > 0) {
      const { error: upErr } = await supabase
        .from("sku_status_omie")
        .upsert(upserts, { onConflict: "empresa,sku_codigo_omie" });
      if (upErr) {
        falhas += upserts.length;
        console.error("Upsert final falhou:", upErr.message);
      } else {
        sucessos += upserts.length;
      }
    }

    // 2.5) Espelhar status ativo/inativo na tabela omie_products (catálogo).
    // Várias funções/RPCs (ex.: gerar_pedidos_sugeridos_ciclo) consultam omie_products.ativo,
    // então mantemos os dois em sincronia para evitar SKUs inativos entrando em pedidos.
    try {
      const account = empresa.toLowerCase();
      const { data: encontradosStatus } = await supabase
        .from("sku_status_omie")
        .select("sku_codigo_omie, ativo_no_omie")
        .eq("empresa", empresa)
        .in("fonte_sincronizacao", ["ListarProdutos"])
        .not("ativo_no_omie", "is", null);

      const inativos = (encontradosStatus ?? [])
        .filter((r) => r.ativo_no_omie === false)
        .map((r) => Number(r.sku_codigo_omie))
        .filter((n) => Number.isFinite(n));
      const ativos = (encontradosStatus ?? [])
        .filter((r) => r.ativo_no_omie === true)
        .map((r) => Number(r.sku_codigo_omie))
        .filter((n) => Number.isFinite(n));

      if (inativos.length > 0) {
        const { error: opErr } = await supabase
          .from("omie_products")
          .update({ ativo: false })
          .eq("account", account)
          .in("omie_codigo_produto", inativos);
        if (opErr) console.error("Espelhar inativos em omie_products falhou:", opErr.message);
      }
      if (ativos.length > 0) {
        // Reativa apenas os que estão marcados ativos no Omie (em lotes para não estourar payload)
        const CHUNK = 500;
        for (let i = 0; i < ativos.length; i += CHUNK) {
          const slice = ativos.slice(i, i + CHUNK);
          const { error: opErr2 } = await supabase
            .from("omie_products")
            .update({ ativo: true })
            .eq("account", account)
            .in("omie_codigo_produto", slice);
          if (opErr2) console.error("Reativar em omie_products falhou:", opErr2.message);
        }
      }
    } catch (e) {
      console.error(
        "[omie-sync-status-produtos] espelhamento omie_products falhou:",
        e instanceof Error ? e.message : String(e),
      );
    }

    // 3) SKUs alvo que NÃO foram encontrados na listagem → marcar como nao_existe_omie
    const naoEncontrados: string[] = [];
    for (const cod of alvoSet) {
      if (!encontrados.has(cod)) naoEncontrados.push(cod);
    }

    if (naoEncontrados.length > 0) {
      const upsertsNE = naoEncontrados.map((cod) => ({
        empresa,
        sku_codigo_omie: cod,
        ativo_no_omie: null,
        data_inativacao: null,
        estoque_minimo_omie: null,
        ponto_pedido_omie: null,
        estoque_maximo_omie: null,
        ultima_sincronizacao: new Date().toISOString(),
        fonte_sincronizacao: "nao_existe_omie",
      }));
      const { error: neErr } = await supabase
        .from("sku_status_omie")
        .upsert(upsertsNE, { onConflict: "empresa,sku_codigo_omie" });
      if (neErr) {
        falhas += naoEncontrados.length;
        console.error("Upsert nao_existe_omie falhou:", neErr.message);
      }
    }

    // 4) Auto-resolver alertas de SKU inativado quando o SKU voltou a ficar ativo no Omie.
    // Critério: para todos os SKUs desta empresa que aparecem ativos em sku_status_omie,
    // marca como 'resolvido_auto' qualquer evento_outlier pendente de tipo 'sku_inativado_omie'.
    let alertasResolvidosAuto = 0;
    try {
      const { data: ativosAtuais } = await supabase
        .from("sku_status_omie")
        .select("sku_codigo_omie")
        .eq("empresa", empresa)
        .eq("ativo_no_omie", true);

      const ativosSet = new Set(
        (ativosAtuais ?? []).map((r) => String(r.sku_codigo_omie)),
      );

      if (ativosSet.size > 0) {
        const { data: pendentes } = await supabase
          .from("eventos_outlier")
          .select("id, sku_codigo_omie")
          .eq("empresa", empresa)
          .eq("tipo", "sku_inativado_omie")
          .eq("status", "pendente");

        const idsParaFechar = (pendentes ?? [])
          .filter((e) => ativosSet.has(String(e.sku_codigo_omie)))
          .map((e) => e.id);

        if (idsParaFechar.length > 0) {
          const { error: resErr } = await supabase
            .from("eventos_outlier")
            .update({
              status: "resolvido_auto",
              decidido_em: new Date().toISOString(),
              decidido_por: "omie-sync-status-produtos",
              justificativa_decisao:
                "SKU voltou a ficar ativo no Omie — alerta resolvido automaticamente.",
            })
            .in("id", idsParaFechar);
          if (resErr) {
            console.error(
              `[omie-sync-status-produtos] erro resolvendo alertas: ${resErr.message}`,
            );
          } else {
            alertasResolvidosAuto = idsParaFechar.length;
          }
        }
      }
    } catch (e) {
      console.error(
        "[omie-sync-status-produtos] auto-resolução de alertas falhou:",
        e instanceof Error ? e.message : String(e),
      );
    }

    const duration = Date.now() - startedAt;
    const summary = {
      empresa,
      total_alvo: totalAlvo,
      encontrados_na_listagem: encontradosNaListagem,
      nao_encontrados: naoEncontrados.length,
      sucessos,
      falhas,
      alertas_resolvidos_auto: alertasResolvidosAuto,
      paginas_processadas: page - 1,
      duration_ms: duration,
    };

    if (logId) {
      await supabase
        .from("sync_reprocess_log")
        .update({
          status: "complete",
          upserts_count: sucessos,
          duration_ms: duration,
          metadata: {
            ...summary,
            nao_encontrados_lista: naoEncontrados.slice(0, 100),
          },
        })
        .eq("id", logId);
    }

    return new Response(JSON.stringify({ ok: true, ...summary }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("omie-sync-status-produtos falhou:", msg);
    if (logId) {
      await supabase
        .from("sync_reprocess_log")
        .update({
          status: "failed",
          error_message: msg.slice(0, 1000),
          duration_ms: Date.now() - startedAt,
        })
        .eq("id", logId);
    }
    return new Response(JSON.stringify({ error: msg }), {
      status: msg.startsWith("AUTH_ERROR") ? 401 : 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
