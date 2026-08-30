import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { authorizeCron, corsHeaders } from "../_shared/auth.ts";
import {
  omieEtapaToStatus,
  etapaConhecida,
  subtotalPedidoComDesconto,
  construirItemsJson,
  STATUS_GERIDO_OMIE,
  type ItemReconciliar,
  type PedidoReconciliar,
} from "../_shared/omie-pedido.ts";
import {
  avaliarPagina,
  MAX_PAGINAS_POS_ESTOQUE,
  proximoTotalPaginas,
} from "../_shared/omie-paginacao.ts";
import { acumularPosicoesDaPagina, type PosicaoEstoque } from "../_shared/pos-estoque.ts";
import { carregarProductMap } from "../_shared/mapas-paginados.ts";
import type { BancoPostgrest } from "../_shared/paginate.ts";
import { classificarSonda, EFEITO, erroSondaAmbigua, respostaSonda, VERSAO } from "./versao.ts";
import {
  chunked,
  particionarCustos,
  planejarEscritaInventario,
  type LinhaProdutoLocal,
} from "./inventory-lote.ts";
import {
  acumularProdutosDaPagina,
  MAX_PAGINAS_PRODUTOS,
  planejarEscritaProdutos,
  type LinhaProdutoCatalogo,
  type ProdutoCadastroOmie,
} from "./products-lote.ts";

const OMIE_API_URL = "https://app.omie.com.br/api/v1";

// Teto anti-runaway do ListarPedidos (reprocessOrders): 500 × 100 = 50k pedidos numa janela >> real.
const MAX_PAGINAS_PEDIDOS = 500;

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
  // HTTP não-2xx LANÇA antes de o corpo virar payload. Sem isto, um 429/5xx cujo corpo parseia
  // SEM `faultstring` (o `{}` de proxy/gateway) devolvia um objeto sem total e sem lista — e os
  // três laços deste arquivo leem isso como página vazia no fim declarado, isto é, EOF. Os guards
  // de _shared/omie-paginacao.ts não alcançam o que o wrapper já entregou como resposta boa:
  // a classe entra uma camada ACIMA da que eles fecham.
  if (!res.ok) {
    throw new Error(`Omie (${account}) HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
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
  let skuRepetido = 0; // SKU repetido no payload do Omie
  let ambiguos = 0;    // pedidos NÃO tocados por duplicidade (payload OU banco) — sem identidade de linha
  let stale = 0;       // pedidos pulados pelo compare-and-set (leitura mais velha que a publicada)

  try {
    // Preload codigo_produto -> product_id (1x por run; evita N+1 por item, igual ao repararOrfaos).
    // Leitura COMPLETA e fail-closed (`_shared/mapas-paginados.ts`): o laço aqui descartava `error`,
    // então página que falhava virava "acabou" e todo produto da cauda resolvia `product_id: null`
    // no item — null GRAVADO, perda de vínculo persistida. A exceção sobe pro catch da run, que já
    // registra em `error_message` do log de reprocess (docs/agent/money-path.md §6).
    const productMap = await carregarProductMap(db as unknown as BancoPostgrest, account);

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

      // Mesmos guards dos irmãos products/inventory abaixo (piso monotônico + teto fail-fast):
      // o `|| 1` por resposta encolhia o teto e o reconcile completava retrato PARCIAL.
      totalPaginas = proximoTotalPaginas(totalPaginas, result.total_de_paginas, MAX_PAGINAS_PEDIDOS);
      const pedidos = result.pedido_venda_produto || [];
      const veredicto = avaliarPagina(pedidos.length, pagina, totalPaginas);
      if (veredicto === "anomalia") {
        throw new Error(`página ${pagina}/${totalPaginas} do ListarPedidos veio vazia antes do fim declarado — abortando (retrato parcial)`);
      }
      if (veredicto === "fim") break;

      // ── Monta o payload DECLARATIVO de cada pedido. Nenhuma escrita acontece aqui: a página
      //    inteira vai numa chamada à RPC `reconciliar_pedidos_omie`, que reconcilia CADA pedido
      //    numa transação própria (subtransação por pedido). ──
      // Carimbo de frescor desta página: o instante em que o Omie RESPONDEU. Vai à RPC, que o usa
      // como compare-and-set — uma leitura mais velha que a já publicada não sobrescreve. É por
      // página e não por run: uma run longa não pode fazer a última página parecer tão fresca
      // quanto a primeira.
      const lidoEm = new Date().toISOString();
      const pedidosRpc: PedidoReconciliar[] = [];
      for (const pedido of pedidos) {
        const cab = pedido.cabecalho || {};
        const codigoPedido = cab.codigo_pedido;
        if (!codigoPedido) continue;
        const itens = pedido.det || [];
        const hashPayload = `omie_${account}_${codigoPedido}`;

        // [A4] guard de leitura vazia/malformada: sem item VÁLIDO (codigo_produto) NÃO reconcilia
        //      — evita zerar total/apagar itens de um pedido real por um ListarPedidos degenerado.
        //      A RPC repete o guard (é ela quem tem de ser fail-closed, não quem a chama); aqui o
        //      filtro só evita mandar payload que já se sabe inútil.
        const itensValidos = itens.filter((it) => it.produto?.codigo_produto != null);
        if (itensValidos.length === 0) continue;

        const itensRpc: ItemReconciliar[] = itensValidos.map((it) => {
          const prod = it.produto!;
          const cod = Number(prod.codigo_produto);
          return {
            omie_codigo_produto: cod,
            quantity: prod.quantidade || 1,
            unit_price: prod.valor_unitario || 0,
            discount: prod.desconto || 0,
            product_id: productMap.get(cod) ?? null,
            // hash de IDENTIDADE do item, nunca de conteúdo (causa-raiz #B no nível item)
            hash_payload: `${hashPayload}_${cod}`,
          };
        });

        pedidosRpc.push({
          account,
          // Identidade IMUTÁVEL: a RPC acha o pai por (account, hash_payload) — NUNCA por
          // omie_numero_pedido, que pegaria a linha errada (causa-raiz #B). Ela também NUNCA
          // reescreve o hash_payload do pai.
          hash_payload: hashPayload,
          omie_pedido_id: codigoPedido,
          // [A4] só reconcilia status com etapa CONHECIDA. `null` = "não sei", e a RPC mantém o
          // status atual. Quem decide se o status LOCAL ainda é gerido pelo Omie é a RPC, dentro
          // da transação: decidir isso aqui exigiria ler o status antes de escrever, e é
          // exatamente esse intervalo entre ler e escrever que esta entrega existe para fechar.
          status_omie: etapaConhecida(cab.etapa) ? omieEtapaToStatus(cab.etapa) : null,
          // [A1] total/itemsJson pelo canon compartilhado (mesma fórmula do sync).
          total: subtotalPedidoComDesconto(itens),
          items: construirItemsJson(itens),
          itens: itensRpc,
        });
      }

      // ── Escrita ATÔMICA por pedido via RPC. Substitui as N+M+2 escritas PostgREST soltas
      //    (insert por item, update por item, delete dos removidos, update do cabeçalho), entre as
      //    quais existia um instante REAL e COMMITADO com itens da revisão velha convivendo com os
      //    da nova — visível para `omie-analytics-sync` (regra de associação publicada) e
      //    `fin-valor-cockpit` (margem/EVP). Ver migration 20260830190000 +
      //    db/test-reconciliar-pedidos-omie.sh (T1 prova; F1 mostra o writer antigo rasgando). ──
      if (pedidosRpc.length > 0) {
        const { data: rpcRes, error: rpcErr } = await db.rpc("reconciliar_pedidos_omie", {
          p_pedidos: pedidosRpc,
          p_status_gerido_omie: STATUS_GERIDO_OMIE,
          p_lido_em: lidoEm,
        });
        if (rpcErr) {
          // Money-path: a RPC é o ÚNICO caminho de escrita agora. Se ela falha (migration não
          // aplicada, grant, lista de status divergente da canônica), LANÇAR — senão a run fica
          // verde sem reconciliar nada e o log marca 'complete' mascarando perda total. Mesma
          // decisão que o `criar_pedidos_com_itens` do omie-vendas-sync tomou (achado /codex).
          throw new Error(`[Reprocess][${account}] RPC reconciliar_pedidos_omie falhou pág ${pagina}: ${rpcErr.message}`);
        }
        const r = (rpcRes ?? {}) as {
          upserts?: number; divergences?: number; corrections?: number;
          sku_repetido?: number; ambiguo?: number; stale?: number;
          sem_item?: number; sem_pai?: number;
          falhas?: Array<Record<string, unknown>>;
        };
        upserts += r.upserts || 0;
        divergences += r.divergences || 0;
        corrections += r.corrections || 0;
        skuRepetido += r.sku_repetido || 0;
        const fails = r.falhas || [];
        falhas += fails.length;
        if (fails.length > 0) {
          console.error(`[Reprocess][${account}] ${fails.length} pedido(s) FALHARAM na RPC pág ${pagina}:`, JSON.stringify(fails.slice(0, 5)));
        }
        ambiguos += r.ambiguo || 0;
        stale += r.stale || 0;
        if (r.ambiguo) {
          console.warn(`[Reprocess][${account}] ${r.ambiguo} pedido(s) NÃO reconciliados por SKU duplicado (${r.sku_repetido || 0} no payload do Omie, o resto já duplicado no banco) — seguem na revisão anterior COMPLETA`);
        }
        if (r.stale) {
          console.warn(`[Reprocess][${account}] ${r.stale} pedido(s) pulados por leitura mais VELHA que a já publicada (compare-and-set)`);
        }
        // [P1-4] Se a página INTEIRA falhou, isto não é "alguns pedidos ruins" — é sinal de que
        // algo sistêmico passou pela allowlist da RPC. Lançar, em vez de somar e seguir para a
        // página seguinte acumulando o mesmo erro 100 vezes.
        if (fails.length > 0 && fails.length === pedidosRpc.length) {
          throw new Error(`[Reprocess][${account}] TODOS os ${fails.length} pedidos da pág ${pagina} falharam na RPC — falha sistêmica, não dado sujo: ${JSON.stringify(fails[0])}`);
        }
        console.log(`[Reprocess][${account}] RPC pág ${pagina}: upserts=${r.upserts || 0} corrections=${r.corrections || 0} divergences=${r.divergences || 0} sem_pai=${r.sem_pai || 0} sem_item=${r.sem_item || 0}`);
      }

      console.log(`[Reprocess][${account}] Orders page ${pagina}/${totalPaginas}`);
      pagina++;
    }

    await completeReprocessLog(db, logId, {
      upserts_count: upserts,
      divergences_found: divergences,
      corrections_applied: corrections,
      duration_ms: Date.now() - startTime,
      metadata: { pages: totalPaginas, window_days: windowDays, falhas, sku_repetido: skuRepetido, ambiguos, stale },
      // Pedido que falhou na RPC ou SKU repetido (itens não reconciliados por ambiguidade) NÃO
      // derruba a run (idempotente: próximo ciclo reconcilia), mas NÃO mente 'complete' limpo —
      // surfaça em error_message p/ o watchdog/health (achado Codex).
      // ⚠️ "reconcile PARCIAL" saiu do vocabulário aqui de propósito: com a RPC, o pedido que
      // falha é desfeito INTEIRO pela subtransação. O que sobra é um pedido na revisão ANTIGA
      // completa — não um meio-pedido. A frase antiga descrevia o writer que esta entrega matou.
      ...((falhas > 0 || ambiguos > 0)
        ? {
          error_message: [
            falhas > 0 ? `${falhas} pedido(s) falharam na RPC (revertidos inteiros, seguem na revisão anterior)` : null,
            // ⚠️ A frase mudou junto com o comportamento. O pedido ambíguo agora NÃO é tocado —
            // nem itens nem cabeçalho — então ele NÃO diverge: fica na revisão anterior completa.
            // O que ele acumula é ATRASO, e é isso que precisa aparecer, porque um pedido que
            // nunca reconcilia é invisível de outro jeito.
            ambiguos > 0 ? `${ambiguos} pedido(s) NÃO reconciliados por SKU duplicado sem identidade de linha (${skuRepetido} vindos do Omie) — congelados na revisão anterior` : null,
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const auth = authorizeCron(req);
  if (!auth.ok) return auth.response;

  try {
    // Sonda de versão ({"probe":true}) — ANTES do createClient, para seguir sendo o único caminho
    // sem custo. Ver `versao.ts` (que documenta o custo do bundle VELHO: aqui ele é BAIXO, porque
    // um corpo sem `action` conhecida cai no `default` 400 lá embaixo) e `_shared/sonda-versao.ts`.
    // O `authorizeCron` acima aceita exatamente o `x-cron-secret` do SQL Editor ⇒ sem gate próprio.
    //
    // ⚠️ O corpo de um Request só se lê UMA vez, e o parse teve de SUBIR para cá. O erro de JSON
    // inválido é guardado e RELANÇADO no ponto antigo (abaixo), para que a resposta continue sendo
    // o 500 do catch geral: trocá-lo por um corpo vazio faria um JSON quebrado responder
    // "Ação desconhecida", mandando o chamador consertar a coisa errada.
    let corpoBruto: { action?: string; account?: Account; window_days?: number } = {};
    let erroParseCorpo: unknown = null;
    try {
      corpoBruto = await req.json();
    } catch (e) {
      erroParseCorpo = e;
    }

    const decisaoSonda = classificarSonda(corpoBruto);
    if (decisaoSonda.tipo === "sonda") {
      return new Response(JSON.stringify(respostaSonda(VERSAO)), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (decisaoSonda.tipo === "ambiguo") {
      return new Response(
        JSON.stringify({ error: erroSondaAmbigua(decisaoSonda.valor, EFEITO) }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    if (erroParseCorpo) throw erroParseCorpo;
    const body = corpoBruto;
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
