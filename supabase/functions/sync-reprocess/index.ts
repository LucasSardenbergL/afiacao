import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { authorizeCron, corsHeaders } from "../_shared/auth.ts";
import {
  omieEtapaToStatus,
  etapaConhecida,
  statusEhOmie,
  subtotalPedidoComDesconto,
  construirItemsJson,
  diffOrderItens,
  type ItemDesejado,
  type ItemLocal,
} from "../_shared/omie-pedido.ts";
import {
  acumularPosicoesDaPagina,
  avaliarPagina,
  chunked,
  MAX_PAGINAS_POS_ESTOQUE,
  particionarCustos,
  planejarEscritaInventario,
  proximoTotalPaginas,
  type LinhaProdutoLocal,
  type PosicaoEstoque,
} from "./inventory-lote.ts";
import {
  acumularProdutosDaPagina,
  MAX_PAGINAS_PRODUTOS,
  planejarEscritaProdutos,
  type LinhaProdutoCatalogo,
  type ProdutoCadastroOmie,
} from "./products-lote.ts";

const OMIE_API_URL = "https://app.omie.com.br/api/v1";

type Account = "oben" | "colacor";

// ── Omie response shapes ──
interface OmieProdutoItem {
  quantidade?: number;
  valor_unitario?: number;
  desconto?: number;
  descricao?: string;
  codigo_produto?: number | string;
}

interface OmiePedidoItem {
  produto?: OmieProdutoItem;
  observacao?: { obs_item?: string };
  inf_adic?: { dados_adicionais_item?: string };
}

interface OmiePedidoCabecalho {
  codigo_cliente?: number;
  numero_pedido?: string | number;
  codigo_pedido?: string | number;
  etapa?: string;
}

interface OmiePedidoVenda {
  cabecalho?: OmiePedidoCabecalho;
  det?: OmiePedidoItem[];
}

interface OmieListarPedidosResponse {
  total_de_paginas?: number;
  pedido_venda_produto?: OmiePedidoVenda[];
}

// Shape do produto do ListarProdutos: ProdutoCadastroOmie (products-lote.ts, fonte única).
interface OmieListarProdutosResponse {
  total_de_paginas?: number;
  produto_servico_cadastro?: ProdutoCadastroOmie[];
}

interface OmieEstoqueItem {
  nCodProd?: number;
  nSaldo?: number;
  nCMC?: number;
  nPrecoMedio?: number;
}

interface OmieListarPosEstoqueResponse {
  nTotPaginas?: number;
  produtos?: OmieEstoqueItem[];
}

function getVendasCredentials(account: Account) {
  if (account === "colacor") {
    return {
      key: Deno.env.get("OMIE_COLACOR_APP_KEY"),
      secret: Deno.env.get("OMIE_COLACOR_APP_SECRET"),
    };
  }
  return {
    key: Deno.env.get("OMIE_OBEN_APP_KEY"),
    secret: Deno.env.get("OMIE_OBEN_APP_SECRET"),
  };
}

async function callOmie(account: Account, endpoint: string, call: string, params: Record<string, unknown>) {
  const creds = getVendasCredentials(account);
  if (!creds.key || !creds.secret) throw new Error(`Credenciais (${account}) não configuradas`);

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

function formatOmieDate(d: Date): string {
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}

// ======== LOAD CONFIG ========

async function loadReprocessConfig(db: SupabaseClient): Promise<Record<string, number>> {
  const { data } = await db.from("sync_reprocess_config").select("key, value");
  const rows = (data || []) as unknown as Array<{ key: string; value: number }>;
  const cfg: Record<string, number> = {};
  for (const c of rows) cfg[c.key] = c.value;
  return cfg;
}

// ======== LOG HELPERS ========

async function createReprocessLog(
  db: SupabaseClient,
  entityType: string,
  account: string,
  reprocessType: string,
  windowStart: Date,
  windowEnd: Date
): Promise<string> {
  const { data } = await db.from("sync_reprocess_log").insert({
    entity_type: entityType,
    account,
    reprocess_type: reprocessType,
    window_start: windowStart.toISOString(),
    window_end: windowEnd.toISOString(),
    status: "running",
  }).select("id").single();
  return (data as unknown as { id: string }).id;
}

async function completeReprocessLog(
  db: SupabaseClient,
  logId: string,
  stats: {
    upserts_count: number;
    divergences_found: number;
    corrections_applied: number;
    duration_ms: number;
    metadata?: Record<string, unknown>;
    error_message?: string;
    status?: string;
  }
) {
  await db.from("sync_reprocess_log").update({
    status: stats.status || "complete",
    upserts_count: stats.upserts_count,
    divergences_found: stats.divergences_found,
    corrections_applied: stats.corrections_applied,
    duration_ms: stats.duration_ms,
    error_message: stats.error_message || null,
    metadata: stats.metadata || {},
  }).eq("id", logId);
}

// ======== REPROCESS ORDERS ========

async function reprocessOrders(
  db: SupabaseClient,
  account: Account,
  windowDays: number,
  reprocessType: string
) {
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const logId = await createReprocessLog(db, "orders", account, reprocessType, windowStart, windowEnd);
  const startTime = Date.now();

  let upserts = 0;
  let divergences = 0;
  let corrections = 0;
  let falhas = 0;      // pedidos com erro de escrita (não engole — surfaça no log)
  let skuRepetido = 0; // pedidos com SKU repetido (reconcile de itens pulado por ambiguidade)

  try {
    // Preload codigo_produto -> product_id (1x por run; evita N+1 por item, igual ao repararOrfaos).
    const productMap = new Map<number, string>();
    {
      let page = 0; const sz = 1000; let more = true;
      while (more) {
        const { data: batch } = await db
          .from("omie_products").select("id, omie_codigo_produto")
          .eq("account", account).range(page * sz, (page + 1) * sz - 1);
        if (!batch || batch.length === 0) { more = false; }
        else {
          for (const p of batch) productMap.set(Number(p.omie_codigo_produto), p.id as string);
          if (batch.length < sz) more = false;
          page++;
        }
      }
    }

    let pagina = 1;
    let totalPaginas = 1;

    while (pagina <= totalPaginas) {
      const result = (await callOmie(account, "produtos/pedido/", "ListarPedidos", {
        pagina,
        registros_por_pagina: 100,
        filtrar_apenas_inclusao: "N",
        filtrar_por_data_de: formatOmieDate(windowStart),
        filtrar_por_data_ate: formatOmieDate(windowEnd),
      })) as unknown as OmieListarPedidosResponse;

      totalPaginas = result.total_de_paginas || 1;
      const pedidos = result.pedido_venda_produto || [];

      for (const pedido of pedidos) {
        const cab = pedido.cabecalho || {};
        const codigoPedido = cab.codigo_pedido;
        if (!codigoPedido) continue;
        const itens = pedido.det || [];
        const hashPayload = `omie_${account}_${codigoPedido}`;

        // [A4] guard de leitura vazia/malformada: sem item VÁLIDO (codigo_produto) NÃO reconcilia
        //      (mirror do G7 da RPC) — evita zerar total/apagar itens de um pedido real por um
        //      ListarPedidos degenerado.
        const itensValidos = itens.filter((it) => it.produto?.codigo_produto != null);
        if (itensValidos.length === 0) continue;

        // Identidade IMUTÁVEL: acha o pai pelo hash_payload determinístico (único pelo índice
        // parcial uniq_sales_orders_omie_hash). NUNCA por omie_numero_pedido — pegaria a linha
        // errada (push/de-namespaced). Se não existe, quem INSERE é o omie-vendas-sync; o
        // reprocess só RECONCILIA o que já existe (a RPC não reconcilia pedido alterado — Fase 2).
        const { data: order } = await db
          .from("sales_orders")
          .select("id, status, total, customer_user_id")
          .eq("account", account)
          .eq("hash_payload", hashPayload)
          .maybeSingle();
        if (!order) continue;

        // [A1] total/itemsJson pelo canon compartilhado (|| igual ao sync). [A4] status só
        //      reconcilia com etapa CONHECIDA e status local gerido pelo Omie — não rebaixa p/
        //      'importado' em leitura malformada nem clobbera status app-avançado (confirmado/entregue).
        const novoSubtotal = subtotalPedidoComDesconto(itens);
        const itemsJson = construirItemsJson(itens);
        const statusReconcilia = etapaConhecida(cab.etapa) && statusEhOmie(order.status);
        const novoStatus = statusReconcilia ? omieEtapaToStatus(cab.etapa) : (order.status as string);
        const statusMudou = order.status !== novoStatus;
        const totalMudou = Math.abs(Number(order.total ?? 0) - novoSubtotal) > 0.01;

        // ── Itens PRIMEIRO (sem transação: se um write de item falhar, NÃO gravo o cabeçalho com
        //    total/itemsJson que não batem — o próximo ciclo reconcilia, idempotente). [A7] SKU
        //    repetido no pedido é ambíguo (a identidade é por codigo) → pula o reconcile de itens
        //    (não arrisca deletar linha legítima); o cabeçalho ainda reconcilia (total/itemsJson
        //    somam TODAS as linhas, igual ao sync). NUNCA toca hash_payload do pai (causa-raiz #B);
        //    o hash de identidade do ITEM `omie_<acc>_<pid>_<codigo>` é gravado no insert/update. ──
        const codigosValidos = itensValidos.map((it) => Number(it.produto!.codigo_produto));
        const temSkuRepetido = codigosValidos.length !== new Set(codigosValidos).size;
        let itemErro = false;
        let itensMudaram = false;

        if (temSkuRepetido) {
          skuRepetido++;
          console.warn(`[Reprocess][${account}] pedido ${codigoPedido} com SKU repetido — itens não reconciliados`);
        } else {
          const { data: locaisRaw } = await db
            .from("order_items")
            .select("id, omie_codigo_produto, quantity, unit_price, discount, product_id")
            .eq("sales_order_id", order.id);
          const locais: ItemLocal[] = (locaisRaw || []).map((r) => ({
            id: r.id as string,
            omie_codigo_produto: Number(r.omie_codigo_produto),
            quantity: Number(r.quantity ?? 0),
            unit_price: Number(r.unit_price ?? 0),
            discount: Number(r.discount ?? 0),
            product_id: (r.product_id as string | null) ?? null,
          }));

          const desejados: ItemDesejado[] = itensValidos.map((it) => {
            const prod = it.produto!;
            const cod = Number(prod.codigo_produto);
            return {
              omie_codigo_produto: cod,
              quantity: prod.quantidade || 1,
              unit_price: prod.valor_unitario || 0,
              discount: prod.desconto || 0,
              product_id: productMap.get(cod) ?? null,
              hash_payload: `${hashPayload}_${cod}`,
            };
          });
          const diff = diffOrderItens(locais, desejados);

          for (const ins of diff.inserir) {
            const { error } = await db.from("order_items").insert({
              sales_order_id: order.id,
              customer_user_id: order.customer_user_id,
              product_id: ins.product_id,
              omie_codigo_produto: ins.omie_codigo_produto,
              quantity: ins.quantity,
              unit_price: ins.unit_price,
              discount: ins.discount,
              hash_payload: ins.hash_payload,
            });
            if (error) { itemErro = true; console.error(`[Reprocess][${account}] insert item ${ins.omie_codigo_produto} ped ${codigoPedido}: ${error.message}`); }
            else { corrections++; itensMudaram = true; }
          }
          for (const upd of diff.atualizar) {
            const { error } = await db.from("order_items").update({
              quantity: upd.quantity,
              unit_price: upd.unit_price,
              discount: upd.discount,
              product_id: upd.product_id,
              hash_payload: upd.hash_payload,
            }).eq("id", upd.id);
            if (error) { itemErro = true; console.error(`[Reprocess][${account}] update item ${upd.id} ped ${codigoPedido}: ${error.message}`); }
            else { corrections++; itensMudaram = true; }
          }
          if (diff.deletar.length > 0) {
            const { error } = await db.from("order_items").delete().in("id", diff.deletar);
            if (error) { itemErro = true; console.error(`[Reprocess][${account}] delete itens ped ${codigoPedido}: ${error.message}`); }
            else { corrections += diff.deletar.length; itensMudaram = true; }
          }
        }

        // ── Cabeçalho DEPOIS: status/total/itemsJson do Omie ATUAL. Só grava se algo mudou e os
        //    itens não falharam (consistência sem transação). sales_price_history fica a cargo do
        //    sync (writer único, write-once por pedido) — reprocess não grava preço. ──
        if (!itemErro && (statusMudou || totalMudou || itensMudaram)) {
          const { error } = await db.from("sales_orders").update({
            status: novoStatus,
            total: novoSubtotal,
            subtotal: novoSubtotal,
            items: itemsJson,
            updated_at: new Date().toISOString(),
          }).eq("id", order.id);
          if (error) { itemErro = true; console.error(`[Reprocess][${account}] update pedido ${codigoPedido}: ${error.message}`); }
          else if (statusMudou || totalMudou) divergences++;
        }

        if (itemErro) falhas++;
        else if (statusMudou || totalMudou || itensMudaram) upserts++;
      }

      console.log(`[Reprocess][${account}] Orders page ${pagina}/${totalPaginas}`);
      pagina++;
    }

    await completeReprocessLog(db, logId, {
      upserts_count: upserts,
      divergences_found: divergences,
      corrections_applied: corrections,
      duration_ms: Date.now() - startTime,
      metadata: { pages: totalPaginas, window_days: windowDays, falhas, sku_repetido: skuRepetido },
      // Reconcile parcial (erro de escrita) ou SKU repetido (order_items não reconciliado, pode
      // divergir do cabeçalho) NÃO derruba a run (idempotente: próximo ciclo reconcilia), mas NÃO
      // mente 'complete' limpo — surfaça em error_message p/ o watchdog/health (achado Codex).
      ...((falhas > 0 || skuRepetido > 0)
        ? {
          error_message: [
            falhas > 0 ? `${falhas} pedido(s) com erro de escrita (reconcile parcial)` : null,
            skuRepetido > 0 ? `${skuRepetido} pedido(s) com SKU repetido (order_items pode divergir do cabeçalho)` : null,
          ].filter(Boolean).join("; "),
        }
        : {}),
    });

    return { upserts, divergences, corrections, falhas, sku_repetido: skuRepetido, duration_ms: Date.now() - startTime };
  } catch (error) {
    await completeReprocessLog(db, logId, {
      upserts_count: upserts,
      divergences_found: divergences,
      corrections_applied: corrections,
      duration_ms: Date.now() - startTime,
      error_message: error instanceof Error ? error.message : String(error),
      status: "error",
    });
    throw error;
  }
}

// ======== REPROCESS PRODUCTS ========
// Em LOTE por invocação, NÃO N+1: o desenho antigo fazia 2 round-trips PostgREST POR produto
// do ListarProdutos (1 SELECT maybeSingle + 1 upsert) e sob catálogo grande estourava o worker
// budget → HTTP 546 WORKER_RESOURCE_LIMIT no cron strategic (02:30 UTC), morte SEM exceção
// (o catch não roda) e órfã `running` em sync_reprocess_log — 52 órfãs de products/oben desde
// 28/02 (~1 a cada 2,7 dias), mesma assinatura do inventory curada nos PRs #1341/#1344.
// Decisão pura (filtros/dedupe/divergência/row) + testes: ./products-lote.ts.

async function reprocessProducts(
  db: SupabaseClient,
  account: Account,
  reprocessType: string
) {
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - 1 * 24 * 60 * 60 * 1000); // always full scan
  const logId = await createReprocessLog(db, "products", account, reprocessType, windowStart, windowEnd);
  const startTime = Date.now();

  let upserts = 0;
  let divergences = 0;

  try {
    // 1) COLETA todas as páginas do Omie em memória (filtros de exclusão do catálogo por
    //    página + dedupe last-wins por código — duplicata no MESMO statement de upsert daria
    //    21000 "cannot affect row a second time").
    const catalogo = new Map<number, ProdutoCadastroOmie>();
    let vistos = 0;
    let pagina = 1;
    let totalPaginas = 1;

    while (pagina <= totalPaginas) {
      const result = (await callOmie(account, "geral/produtos/", "ListarProdutos", {
        pagina,
        registros_por_pagina: 100,
        apenas_importado_api: "N",
        filtrar_apenas_omiepdv: "N",
      })) as unknown as OmieListarProdutosResponse;

      // Teto anti-runaway fail-FAST sobre o total DECLARADO (lição Codex P1 do #1341) com
      // piso MONOTÔNICO (Codex P1 do #1353): resposta intermediária sem total não pode
      // encolher o teto e completar retrato parcial como 'complete'.
      totalPaginas = proximoTotalPaginas(totalPaginas, result.total_de_paginas, MAX_PAGINAS_PRODUTOS);
      const produtos = result.produto_servico_cadastro || [];
      const veredicto = avaliarPagina(produtos.length, pagina, totalPaginas);
      if (veredicto === "anomalia") {
        // total_de_paginas é PISO (docs/agent/sync.md): página vazia ANTES do fim declarado =
        // fault transiente disfarçado → aborta fail-closed em vez de completar retrato parcial.
        throw new Error(`página ${pagina}/${totalPaginas} do ListarProdutos veio vazia antes do fim declarado — abortando (retrato parcial)`);
      }
      if (veredicto === "fim") break;
      vistos += produtos.length;
      acumularProdutosDaPagina(catalogo, produtos);

      console.log(`[Reprocess][${account}] Products page ${pagina}/${totalPaginas}`);
      pagina++;
    }

    // Catálogo VAZIO é anomalia, não sucesso (lição #1341): oben/colacor têm catálogo real —
    // 0 elegíveis = transitório do Omie mascarado de 200 ou drift de contrato/filtros.
    // Completar 'complete' com 0 mentiria que o reconcile aconteceu. Nada foi escrito;
    // o próximo strategic re-tenta.
    if (catalogo.size === 0) {
      throw new Error(
        `snapshot do ListarProdutos veio VAZIO (0 produtos elegíveis de ${vistos} vistos em ${totalPaginas} página(s) declarada(s)) — fail-closed, nada escrito`,
      );
    }

    // Timestamp único da run, capturado APÓS a coleta Omie (Codex P2 do #1341): encolhe a
    // janela de regressão de updated_at contra writers concorrentes.
    const nowIso = new Date().toISOString();
    let falhasChunk = 0;

    // 2) Espelho local em LOTE (.in() chunked ≤300 fica sob o cap silencioso de 1000 linhas
    //    do PostgREST por construção; `account` é convenção EMPRESA — docs/agent/database.md
    //    §5 — igual ao filtro do N+1). Falha de SELECT → THROW: seguir sem o chunk subcontaria
    //    divergences_found em silêncio — sinal money-path do strategic. Precisão > recall.
    const locais: LinhaProdutoCatalogo[] = [];
    for (const chunk of chunked([...catalogo.keys()], 300)) {
      const { data, error } = await db
        .from("omie_products")
        .select("id, omie_codigo_produto, descricao, valor_unitario")
        .eq("account", account)
        .in("omie_codigo_produto", chunk);
      if (error) throw new Error(`resolve omie_products: ${error.message}`);
      locais.push(...((data ?? []) as unknown as LinhaProdutoCatalogo[]));
    }

    const plano = planejarEscritaProdutos(catalogo, locais, account, nowIso);
    divergences = plano.divergences;

    // 3) omie_products em LOTE (onConflict = UNIQUE(omie_codigo_produto,account); o payload
    //    completo JÁ carrega as NOT NULL sem default codigo/descricao com os fallbacks do
    //    N+1 — sem o 23502 do #1344). Chunk com erro NÃO derruba a run (idempotente — o
    //    próximo ciclo reconcilia), mas upserts_count só soma o que FOI escrito, corrections
    //    só conta divergência de chunk ESCRITO (Codex P2 do #1353: corrections=divergences
    //    afirmaria correção que nunca aconteceu) e o error_message surfaça (padrão
    //    reprocessOrders/reprocessInventory: nunca 'complete' limpo mentindo).
    const divergentes = new Set(plano.codigosDivergentes);
    let corrections = 0;
    for (const chunk of chunked(plano.rows, 500)) {
      const { error } = await db
        .from("omie_products")
        .upsert(chunk, { onConflict: "omie_codigo_produto,account" });
      if (error) {
        falhasChunk++;
        console.error(`[Reprocess][${account}] upsert omie_products: ${error.message}`);
      } else {
        upserts += chunk.length;
        for (const row of chunk) if (divergentes.has(row.omie_codigo_produto)) corrections++;
      }
    }
    // Falha TOTAL ≠ sucesso parcial (lição #1341): se NENHUM chunk escreveu, a infra
    // PostgREST está degradada — status 'error' honesto via catch, não 'complete' com
    // error_message.
    if (plano.rows.length > 0 && upserts === 0) {
      throw new Error(
        `todos os ${chunked(plano.rows, 500).length} chunk(s) de omie_products falharam — nada escrito`,
      );
    }

    await completeReprocessLog(db, logId, {
      upserts_count: upserts,
      divergences_found: divergences,
      corrections_applied: corrections,
      duration_ms: Date.now() - startTime,
      metadata: {
        pages: totalPaginas,
        produtos_vistos: vistos,
        produtos_elegiveis: catalogo.size,
        ...(falhasChunk > 0 ? { falhas_chunk: falhasChunk } : {}),
      },
      ...(falhasChunk > 0
        ? { error_message: `${falhasChunk} chunk(s) com erro de escrita (lote parcial — próximo ciclo reconcilia)` }
        : {}),
    });

    return { upserts, divergences, duration_ms: Date.now() - startTime };
  } catch (error) {
    await completeReprocessLog(db, logId, {
      upserts_count: upserts,
      divergences_found: divergences,
      corrections_applied: 0,
      duration_ms: Date.now() - startTime,
      error_message: error instanceof Error ? error.message : String(error),
      status: "error",
    });
    throw error;
  }
}

// ======== REPROCESS INVENTORY ========
// Em LOTE por invocação, NÃO N+1: o desenho antigo fazia até 5 round-trips PostgREST POR
// produto (~3.000+ requests p/ ~785 produtos OBEN) e estourava o worker budget → HTTP 546
// WORKER_RESOURCE_LIMIT no cron operational, morte SEM exceção (o catch não roda) e órfã
// `running` em sync_reprocess_log. Espelha o syncInventory do omie-analytics-sync (a MESMA
// operação ListarPosEstoque, em lote). Decisão pura + testes: ./inventory-lote.ts.

async function reprocessInventory(
  db: SupabaseClient,
  account: Account,
  reprocessType: string
) {
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - 1 * 24 * 60 * 60 * 1000);
  const logId = await createReprocessLog(db, "inventory", account, reprocessType, windowStart, windowEnd);
  const startTime = Date.now();

  let upserts = 0;
  let divergences = 0;

  try {
    // 1) COLETA todas as páginas do Omie em memória (dedupe last-wins por código — duplicata
    //    no MESMO statement de upsert daria 21000 "cannot affect row a second time").
    const posicoes = new Map<number, PosicaoEstoque>();
    let pagina = 1;
    let totalPaginas = 1;

    while (pagina <= totalPaginas) {
      const result = (await callOmie(account, "estoque/consulta/", "ListarPosEstoque", {
        nPagina: pagina,
        nRegPorPagina: 100,
        dDataPosicao: formatOmieDate(new Date()),
      })) as unknown as OmieListarPosEstoqueResponse;

      // Teto anti-runaway fail-FAST sobre o total DECLARADO (Codex P1): descobrir o runaway
      // só na página 501, após ~90s de chamadas, reproduziria o próprio 546. Piso MONOTÔNICO
      // (Codex P1 do #1353): resposta intermediária sem nTotPaginas degradava o teto p/ 1 e
      // completava retrato parcial como 'complete' — mesmo defeito latente do products.
      totalPaginas = proximoTotalPaginas(totalPaginas, result.nTotPaginas, MAX_PAGINAS_POS_ESTOQUE);
      const produtos = result.produtos || [];
      const veredicto = avaliarPagina(produtos.length, pagina, totalPaginas);
      if (veredicto === "anomalia") {
        // nTotPaginas é PISO (docs/agent/sync.md): página vazia ANTES do fim declarado =
        // fault transiente disfarçado → aborta fail-closed em vez de completar retrato parcial.
        throw new Error(`página ${pagina}/${totalPaginas} do ListarPosEstoque veio vazia antes do fim declarado — abortando (retrato parcial)`);
      }
      if (veredicto === "fim") break;
      acumularPosicoesDaPagina(posicoes, produtos);

      console.log(`[Reprocess][${account}] Inventory page ${pagina}/${totalPaginas}`);
      pagina++;
    }

    // Snapshot VAZIO é anomalia, não sucesso (Codex P1): OBEN/COLACOR têm catálogo real
    // (~785 posições oben) — 0 posições = transitório do Omie mascarado de 200 ou drift de
    // contrato (nCodProd inválido em massa). Completar 'complete' com 0 mentiria que o
    // reconcile aconteceu. Nada foi escrito; o ciclo de 2h re-tenta.
    const codProds = [...posicoes.keys()];
    if (codProds.length === 0) {
      throw new Error(
        `snapshot do ListarPosEstoque veio VAZIO (0 posições válidas em ${totalPaginas} página(s) declarada(s)) — fail-closed, nada escrito`,
      );
    }

    // Timestamp único da run, capturado APÓS a coleta Omie (Codex P2): encolhe a janela de
    // regressão de updated_at contra writers concorrentes (computeCosts/analytics-sync).
    const nowIso = new Date().toISOString();
    let falhasChunk = 0;

    {
      // 2) Resolve omie_products em LOTE (.in() chunked ≤300 fica sob o cap silencioso de
      //    1000 linhas do PostgREST por construção; `account` aqui é convenção EMPRESA —
      //    docs/agent/database.md §5 — igual ao filtro do N+1). Falha de SELECT → THROW:
      //    seguir sem o chunk (como o canônico) faria o upsert de posição CLOBBERar
      //    product_id existente para null. Precisão > recall; o ciclo de 2h re-tenta.
      const locais: LinhaProdutoLocal[] = [];
      for (const chunk of chunked(codProds, 300)) {
        const { data, error } = await db
          .from("omie_products")
          .select("id, omie_codigo_produto, estoque, codigo, descricao")
          .eq("account", account)
          .in("omie_codigo_produto", chunk);
        if (error) throw new Error(`resolve omie_products: ${error.message}`);
        locais.push(...((data ?? []) as unknown as LinhaProdutoLocal[]));
      }

      const plano = planejarEscritaInventario(posicoes, locais, account, nowIso);
      divergences = plano.divergences;

      // 3) inventory_position em LOTE (onConflict = UNIQUE(omie_codigo_produto,account)).
      //    Chunk com erro NÃO derruba a run (idempotente — o próximo ciclo reconcilia), mas
      //    upserts_count só soma o que FOI escrito e o error_message surfaça (padrão do
      //    reprocessOrders: nunca 'complete' limpo mentindo).
      for (const chunk of chunked(plano.invRows, 500)) {
        const { error } = await db
          .from("inventory_position")
          .upsert(chunk, { onConflict: "omie_codigo_produto,account" });
        if (error) {
          falhasChunk++;
          console.error(`[Reprocess][${account}] upsert inventory_position: ${error.message}`);
        } else {
          upserts += chunk.length;
        }
      }
      // Falha TOTAL da tabela primária ≠ sucesso parcial (Codex P2): se NENHUM chunk escreveu,
      // a infra PostgREST está degradada — abortar antes de estoque/custos (status 'error'
      // honesto via catch), em vez de 'complete' com error_message.
      if (plano.invRows.length > 0 && upserts === 0) {
        throw new Error(
          `todos os ${chunked(plano.invRows, 500).length} chunk(s) de inventory_position falharam — abortando antes de estoque/custos`,
        );
      }

      // 4) omie_products.estoque em LOTE por (omie_codigo_produto, account) — o conflito
      //    arbitrado SEMPRE existe (linhas resolvidas) e a PK gerada nunca conflita. O payload
      //    carrega codigo/descricao (NOT NULL sem default) lidos do resolve: a tupla proposta
      //    do INSERT..ON CONFLICT é validada contra NOT NULL ANTES do conflito — payload
      //    mínimo {id, estoque} tomava 23502 e derrubava o chunk (provado em prod 18:15 UTC;
      //    upsert pela PK id com payload completo arriscaria 23505 por conflito DUPLO PK+uniq).
      for (const chunk of chunked(plano.stockRows, 500)) {
        const { error } = await db
          .from("omie_products")
          .upsert(chunk, { onConflict: "omie_codigo_produto,account" });
        if (error) {
          falhasChunk++;
          console.error(`[Reprocess][${account}] upsert estoque omie_products: ${error.message}`);
        }
      }

      // 5) product_costs em LOTE: 1 SELECT .in() por chunk → partição update × insert
      //    (particionarCustos). SELECT falho degrada: os candidatos do chunk caem no insert
      //    e o ignoreDuplicates (ON CONFLICT DO NOTHING) pula os que já existem — custo
      //    stale por 1 ciclo, nunca corrupção/clobber de proveniência.
      if (plano.custoCandidatos.length > 0) {
        const jaTemCusto = new Set<string>();
        for (const chunk of chunked(plano.custoCandidatos.map((c) => c.product_id), 300)) {
          const { data, error } = await db.from("product_costs").select("product_id").in("product_id", chunk);
          if (error) {
            falhasChunk++;
            console.error(`[Reprocess][${account}] resolve product_costs: ${error.message}`);
            continue;
          }
          for (const r of data || []) jaTemCusto.add(r.product_id as string);
        }

        const { atualizar, inserir } = particionarCustos(plano.custoCandidatos, jaTemCusto, nowIso);
        for (const chunk of chunked(atualizar, 500)) {
          const { error } = await db.from("product_costs").upsert(chunk, { onConflict: "product_id" });
          if (error) {
            falhasChunk++;
            console.error(`[Reprocess][${account}] upsert cmc product_costs: ${error.message}`);
          }
        }
        for (const chunk of chunked(inserir, 500)) {
          const { error } = await db
            .from("product_costs")
            .upsert(chunk, { onConflict: "product_id", ignoreDuplicates: true });
          if (error) {
            falhasChunk++;
            console.error(`[Reprocess][${account}] insert product_costs: ${error.message}`);
          }
        }
      }
    }

    await completeReprocessLog(db, logId, {
      upserts_count: upserts,
      divergences_found: divergences,
      corrections_applied: divergences,
      duration_ms: Date.now() - startTime,
      metadata: {
        pages: totalPaginas,
        total_posicoes: codProds.length,
        ...(falhasChunk > 0 ? { falhas_chunk: falhasChunk } : {}),
      },
      ...(falhasChunk > 0
        ? { error_message: `${falhasChunk} chunk(s) com erro de escrita (lote parcial — próximo ciclo reconcilia)` }
        : {}),
    });

    return { upserts, divergences, duration_ms: Date.now() - startTime };
  } catch (error) {
    await completeReprocessLog(db, logId, {
      upserts_count: upserts,
      divergences_found: divergences,
      corrections_applied: 0,
      duration_ms: Date.now() - startTime,
      error_message: error instanceof Error ? error.message : String(error),
      status: "error",
    });
    throw error;
  }
}

// ======== MAIN HANDLER ========

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const auth = authorizeCron(req);
  if (!auth.ok) return auth.response;

  try {
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const body = await req.json();
    const { action, account = "oben" } = body;

    const cfg = await loadReprocessConfig(supabaseAdmin);
    let result: unknown;

    console.log(`[Reprocess] Action: ${action}, Account: ${account}`);

    switch (action) {
      case "reprocess_operational": {
        if (!cfg.operational_enabled) {
          result = { skipped: true, reason: "Operational reprocessing disabled" };
          break;
        }
        const windowDays = cfg.operational_window_days || 7;
        const orders = await reprocessOrders(supabaseAdmin, account as Account, windowDays, "operational");
        const inventory = await reprocessInventory(supabaseAdmin, account as Account, "operational");
        result = { orders, inventory, window_days: windowDays };
        break;
      }

      case "reprocess_strategic": {
        if (!cfg.strategic_enabled) {
          result = { skipped: true, reason: "Strategic reprocessing disabled" };
          break;
        }
        const windowDays = cfg.strategic_window_days || 30;
        const orders = await reprocessOrders(supabaseAdmin, account as Account, windowDays, "strategic");
        const products = await reprocessProducts(supabaseAdmin, account as Account, "strategic");
        const inventory = await reprocessInventory(supabaseAdmin, account as Account, "strategic");
        result = { orders, products, inventory, window_days: windowDays };
        break;
      }

      case "reprocess_orders": {
        const windowDays = body.window_days || cfg.operational_window_days || 7;
        result = await reprocessOrders(supabaseAdmin, account as Account, windowDays, "manual");
        break;
      }

      case "reprocess_products": {
        result = await reprocessProducts(supabaseAdmin, account as Account, "manual");
        break;
      }

      case "reprocess_inventory": {
        result = await reprocessInventory(supabaseAdmin, account as Account, "manual");
        break;
      }

      case "reprocess_all": {
        const windowDays = body.window_days || cfg.strategic_window_days || 30;
        const orders = await reprocessOrders(supabaseAdmin, account as Account, windowDays, "manual");
        const products = await reprocessProducts(supabaseAdmin, account as Account, "manual");
        const inventory = await reprocessInventory(supabaseAdmin, account as Account, "manual");
        result = { orders, products, inventory, window_days: windowDays };
        break;
      }

      case "get_health": {
        // Return sync health data
        const { data: recentLogs } = await supabaseAdmin
          .from("sync_reprocess_log")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(50);

        const { data: config } = await supabaseAdmin
          .from("sync_reprocess_config")
          .select("*");

        // Get last operational and strategic runs
        const { data: lastOp } = await supabaseAdmin
          .from("sync_reprocess_log")
          .select("*")
          .eq("reprocess_type", "operational")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        const { data: lastStrat } = await supabaseAdmin
          .from("sync_reprocess_log")
          .select("*")
          .eq("reprocess_type", "strategic")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        // Get daily divergence summary for last 30 days
        const { data: divergenceLogs } = await supabaseAdmin
          .from("sync_reprocess_log")
          .select("entity_type, account, divergences_found, corrections_applied, window_start, window_end, status, created_at")
          .gte("created_at", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
          .order("created_at", { ascending: false });

        result = {
          recent_logs: recentLogs || [],
          config: config || [],
          last_operational: lastOp,
          last_strategic: lastStrat,
          divergence_summary: divergenceLogs || [],
        };
        break;
      }

      default:
        return new Response(JSON.stringify({ error: "Ação desconhecida" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }

    return new Response(JSON.stringify({ success: true, data: result }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[Reprocess] Erro:", error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : "Erro interno" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
