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

interface OmieProdutoImagem {
  url_imagem?: string;
}

interface OmieProdutoCadastro {
  codigo_produto?: number | string;
  codigo_produto_integracao?: string | null;
  codigo?: string;
  descricao?: string;
  unidade?: string;
  ncm?: string | null;
  valor_unitario?: number;
  quantidade_estoque?: number;
  descricao_familia?: string;
  inativo?: string;
  tipo?: string;
  imagens?: OmieProdutoImagem[];
  marca?: string;
  modelo?: string;
  peso_bruto?: number;
  peso_liq?: number;
  cfop?: string;
}

interface OmieListarProdutosResponse {
  total_de_paginas?: number;
  produto_servico_cadastro?: OmieProdutoCadastro[];
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
    const EXCLUDED_FAMILIES = ['imobilizado', 'uso e consumo', 'matérias primas para conversão de cintas', 'jumbos de lixa para discos', 'material para tingimix'];
    let pagina = 1;
    let totalPaginas = 1;

    while (pagina <= totalPaginas) {
      const result = (await callOmie(account, "geral/produtos/", "ListarProdutos", {
        pagina,
        registros_por_pagina: 100,
        apenas_importado_api: "N",
        filtrar_apenas_omiepdv: "N",
      })) as unknown as OmieListarProdutosResponse;

      totalPaginas = result.total_de_paginas || 1;
      const produtos = result.produto_servico_cadastro || [];

      for (const prod of produtos) {
        if (prod.inativo === "S") continue;
        if (prod.tipo && prod.tipo.toUpperCase() === "K") continue;
        const familia = (prod.descricao_familia || '').toLowerCase().trim();
        if (EXCLUDED_FAMILIES.some(ex => familia.includes(ex)) || familia.startsWith('jumbo')) continue;
        const descLower = (prod.descricao || '').toLowerCase();
        if (descLower.includes('810ml') || descLower.includes('810 ml')) continue;

        // Check existing
        const { data: existing } = await db
          .from("omie_products")
          .select("id, descricao, valor_unitario")
          .eq("omie_codigo_produto", prod.codigo_produto)
          .eq("account", account)
          .maybeSingle();

        if (existing) {
          // Detect divergence
          if (existing.descricao !== (prod.descricao || "") ||
              existing.valor_unitario !== (prod.valor_unitario || 0)) {
            divergences++;
          }
        }

        const row = {
          omie_codigo_produto: prod.codigo_produto,
          omie_codigo_produto_integracao: prod.codigo_produto_integracao || null,
          codigo: prod.codigo || `PROD-${prod.codigo_produto}`,
          descricao: prod.descricao || "Sem descrição",
          unidade: prod.unidade || "UN",
          ncm: prod.ncm || null,
          valor_unitario: prod.valor_unitario || 0,
          estoque: prod.quantidade_estoque || 0,
          ativo: true,
          familia: prod.descricao_familia || null,
          imagem_url: prod.imagens?.[0]?.url_imagem || null,
          metadata: {
            marca: prod.marca,
            modelo: prod.modelo,
            peso_bruto: prod.peso_bruto,
            peso_liq: prod.peso_liq,
            descricao_familia: prod.descricao_familia,
            cfop: prod.cfop,
          },
          account,
          updated_at: new Date().toISOString(),
        };

        const { error } = await db.from("omie_products").upsert(row, { onConflict: "omie_codigo_produto,account" });
        if (!error) upserts++;
      }

      console.log(`[Reprocess][${account}] Products page ${pagina}/${totalPaginas}`);
      pagina++;
    }

    // Inactivate products no longer in Omie
    // (handled by comparing existing products not updated in this run)

    await completeReprocessLog(db, logId, {
      upserts_count: upserts,
      divergences_found: divergences,
      corrections_applied: divergences,
      duration_ms: Date.now() - startTime,
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
    let pagina = 1;
    let totalPaginas = 1;

    while (pagina <= totalPaginas) {
      const result = (await callOmie(account, "estoque/consulta/", "ListarPosEstoque", {
        nPagina: pagina,
        nRegPorPagina: 100,
        dDataPosicao: formatOmieDate(new Date()),
      })) as unknown as OmieListarPosEstoqueResponse;

      totalPaginas = result.nTotPaginas || 1;
      const produtos = result.produtos || [];

      for (const prod of produtos) {
        const codProd = prod.nCodProd;
        if (!codProd) continue;

        const saldo = prod.nSaldo ?? 0;
        const cmc = prod.nCMC ?? 0;
        const precoMedio = prod.nPrecoMedio ?? 0;

        // Check divergence with local
        const { data: existing } = await db
          .from("omie_products")
          .select("id, estoque")
          .eq("omie_codigo_produto", codProd)
          .eq("account", account)
          .maybeSingle();

        if (existing && existing.estoque !== saldo) {
          divergences++;
        }

        // Upsert inventory_position
        await db.from("inventory_position").upsert({
          omie_codigo_produto: codProd,
          product_id: existing?.id || null,
          saldo,
          cmc,
          preco_medio: precoMedio,
          account,
          synced_at: new Date().toISOString(),
        }, { onConflict: "omie_codigo_produto,account" });

        // Update omie_products stock
        if (existing?.id) {
          await db.from("omie_products")
            .update({ estoque: saldo, updated_at: new Date().toISOString() })
            .eq("id", existing.id);
        }

        // Update product_costs CMC
        if (existing?.id && cmc > 0) {
          const { data: costRow } = await db
            .from("product_costs")
            .select("id")
            .eq("product_id", existing.id)
            .maybeSingle();

          if (costRow) {
            await db.from("product_costs")
              .update({ cmc, updated_at: new Date().toISOString() })
              .eq("id", costRow.id);
          } else {
            await db.from("product_costs").insert({
              product_id: existing.id,
              cost_price: cmc,
              cmc,
              cost_source: "CMC",
              cost_confidence: 0.7,
            });
          }
        }

        upserts++;
      }

      console.log(`[Reprocess][${account}] Inventory page ${pagina}/${totalPaginas}`);
      pagina++;
    }

    await completeReprocessLog(db, logId, {
      upserts_count: upserts,
      divergences_found: divergences,
      corrections_applied: divergences,
      duration_ms: Date.now() - startTime,
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
