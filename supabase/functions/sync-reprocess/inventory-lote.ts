// Lógica PURA do reprocessInventory em LOTE (decisão isolada do I/O — testada em
// inventory-lote_test.ts, padrão paginacao.ts do omie-sync-status-produtos).
//
// Por quê (2026-07-16): o reprocessInventory N+1 fazia até 5 round-trips PostgREST POR
// produto (~3.000+ requests p/ ~785 produtos OBEN) → HTTP 546 WORKER_RESOURCE_LIMIT em
// ~86-100% dos ciclos do cron sync-reprocess-operational, morte SEM exceção (o catch não
// roda), órfã `running` em sync_reprocess_log e cauda do catálogo stale. O lote espelha o
// syncInventory do omie-analytics-sync (a MESMA operação ListarPosEstoque, em lote em prod).
//
// Money-path (inventory_position oben → fin-valor-cockpit; product_costs.cmc → EOQ):
// - divergência = comparação ESTRITA local.estoque !== saldo (null incluso), fiel ao N+1;
// - código ambíguo degrada p/ product_id null e NÃO escreve estoque/custo (precisão>recall);
// - custo só com product_id resolvido E cmc > 0 (nunca fabrica custo zero);
// - update de custo com payload MÍNIMO (proveniência cost_price/source/confidence é do
//   computeCosts — este writer nunca promove).
import { buildProductIdMap, montarCatalogoPorCod } from "../_shared/product-idmap.ts";
import type { PosicaoEstoque } from "../_shared/pos-estoque.ts";

export interface LinhaProdutoLocal {
  id: string | null;
  omie_codigo_produto: number | string | null;
  estoque: unknown;
  codigo?: string | null;
  descricao?: string | null;
}

export interface PlanoEscritaInventario {
  invRows: Array<{
    omie_codigo_produto: number;
    product_id: string | null;
    saldo: number;
    cmc: number;
    preco_medio: number;
    account: string;
    synced_at: string;
  }>;
  stockRows: Array<{
    omie_codigo_produto: number;
    account: string;
    codigo: string;
    descricao: string;
    estoque: number;
    updated_at: string;
  }>;
  custoCandidatos: Array<{ product_id: string; cmc: number }>;
  divergences: number;
}

export function chunked<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Divergências + linhas de escrita por tabela, a partir das posições Omie e das linhas locais
// de omie_products (id, omie_codigo_produto, estoque). Semântica fiel ao N+1:
// - divergência: linha local ÚNICA com estoque !== saldo (estrito; null diverge de 0);
// - ambíguo (2+ ids p/ o código — buildProductIdMap → null): espelha o maybeSingle antigo
//   (PGRST116 → existing null): posição escrita com product_id null, SEM stock/custo/divergência;
// - stockRows espelha omie_products.estoque INCONDICIONALMENTE quando resolvido (como o N+1);
// - custoCandidatos: product_id resolvido E cmc > 0.
export function planejarEscritaInventario(
  posicoes: Map<number, PosicaoEstoque>,
  locais: LinhaProdutoLocal[],
  account: string,
  nowIso: string,
): PlanoEscritaInventario {
  const idByCod = buildProductIdMap(locais);
  const estoquePorCod = new Map<number, unknown>();
  for (const l of locais) {
    if (l.omie_codigo_produto == null || l.id == null) continue;
    const cod = Number(l.omie_codigo_produto);
    if (idByCod.get(cod) === String(l.id)) estoquePorCod.set(cod, l.estoque);
  }

  // Colunas NOT NULL sem default de omie_products, por código resolvido: o upsert de estoque
  // conflita por (omie_codigo_produto, account) e a tupla proposta do INSERT..ON CONFLICT é
  // validada contra NOT NULL ANTES de o conflito ser arbitrado — payload sem codigo/descricao
  // derruba o chunk inteiro com 23502 (provado em prod no ciclo 2026-07-16 18:15 UTC).
  // Extraído p/ _shared/product-idmap.ts: o syncInventory canônico (omie-analytics-sync)
  // tomava o MESMO 23502 e agora compartilha esta resolução.
  const catalogoPorCod = montarCatalogoPorCod(locais, idByCod);

  const plano: PlanoEscritaInventario = { invRows: [], stockRows: [], custoCandidatos: [], divergences: 0 };
  for (const [cod, p] of posicoes) {
    const id = idByCod.get(cod) ?? null;
    if (estoquePorCod.has(cod) && estoquePorCod.get(cod) !== p.saldo) plano.divergences++;
    plano.invRows.push({
      omie_codigo_produto: cod,
      product_id: id,
      saldo: p.saldo,
      cmc: p.cmc,
      preco_medio: p.precoMedio,
      account,
      synced_at: nowIso,
    });
    if (id) {
      const cat = catalogoPorCod.get(cod);
      if (cat) {
        // Sem codigo/descricao (impossível pelo schema NOT NULL, mas fail-closed): pula o item
        // do espelho de estoque — nunca propõe NULL/placeholder; posição e custos seguem.
        plano.stockRows.push({
          omie_codigo_produto: cod,
          account,
          codigo: cat.codigo,
          descricao: cat.descricao,
          estoque: p.saldo,
          updated_at: nowIso,
        });
      }
      if (p.cmc > 0) plano.custoCandidatos.push({ product_id: id, cmc: p.cmc });
    }
  }
  return plano;
}

// ════════ Zeramento de quem SAIU da lista (2026-10-01) ════════
// A lista padrão do ListarPosEstoque (cExibeTodos "N", "sem movimento" fica de fora) traz quem
// tem saldo ≠ 0 — medido: 405/405 SKUs com leitura fresca do modo "S" batem (311 com físico ≠ 0,
// todos na lista; 94 com físico 0, todos fora). Quem esgota SAI da lista e nenhum writer de
// posição grava o zero; até aqui quem zerava era o `quantidade_estoque || 0` do passo de
// produtos (77 das 78 posições fora da lista estavam zeradas só por ele). O zero agora é do
// dono, e só com listagem COMPLETA: ausência numa listagem parcial não prova nada.

/** Teto de raio: acima de max(MIN, FRACAO × posições) a zerar, nada é zerado (fail-closed). */
export const TETO_ZERAMENTO_MIN = 20;
export const TETO_ZERAMENTO_FRACAO = 0.05;

export type CompletudeListagem = { completa: true } | { completa: false; motivo: string };

// `tamanhos` = itens CRUS de cada página não-vazia, na ordem. Página intermediária curta é buraco;
// última página CHEIA é evidência de continuação (o total declarado pode ter subestimado).
// `itensIlegiveis` = itens que o parser recusou: podem ser produtos COM saldo, e a ausência deles
// no snapshot não prova zero.
export function avaliarCompletudeListagem(
  tamanhos: number[],
  porPagina: number,
  itensIlegiveis = 0,
): CompletudeListagem {
  if (tamanhos.length === 0) return { completa: false, motivo: "nenhuma página lida" };
  if (itensIlegiveis > 0) {
    return { completa: false, motivo: `${itensIlegiveis} item(ns) ilegível(is) na listagem — a ausência deles não prova saldo 0` };
  }
  for (let i = 0; i < tamanhos.length - 1; i++) {
    if (tamanhos[i] < porPagina) {
      return { completa: false, motivo: `página ${i + 1} veio com ${tamanhos[i]} de ${porPagina} antes da última` };
    }
  }
  if (tamanhos[tamanhos.length - 1] >= porPagina) {
    return { completa: false, motivo: `última página cheia (${porPagina}) — pode haver continuação` };
  }
  return { completa: true };
}

// Linhas de estoque 0 (mesma forma das stockRows — vão no mesmo upsert) para quem tem estoque
// local ≠ 0, está resolvido sem ambiguidade e NÃO veio na listagem. Pulado inteiro (rows vazias +
// motivo) se a listagem não é completa, se o snapshot veio vazio ou se o raio passa do teto.
export function planejarZeramentoForaDaLista(
  posicoes: Map<number, PosicaoEstoque>,
  locaisComEstoque: LinhaProdutoLocal[],
  completude: CompletudeListagem,
  account: string,
  nowIso: string,
): { rows: PlanoEscritaInventario["stockRows"]; candidatos: number; pulado: string | null } {
  const idByCod = buildProductIdMap(locaisComEstoque);
  const catalogoPorCod = montarCatalogoPorCod(locaisComEstoque, idByCod);
  const rows: PlanoEscritaInventario["stockRows"] = [];
  const vistos = new Set<number>(); // duplicata no mesmo upsert = 21000 no chunk inteiro
  for (const l of locaisComEstoque) {
    if (l.omie_codigo_produto == null || l.id == null || l.estoque == null) continue;
    const cod = Number(l.omie_codigo_produto);
    if (idByCod.get(cod) !== String(l.id)) continue; // ambíguo (null) ou linha não-vencedora
    if (Number(l.estoque) === 0 || posicoes.has(cod) || vistos.has(cod)) continue;
    vistos.add(cod);
    const cat = catalogoPorCod.get(cod);
    if (!cat) continue; // sem codigo/descricao: nunca propõe NULL em NOT NULL
    rows.push({ omie_codigo_produto: cod, account, codigo: cat.codigo, descricao: cat.descricao, estoque: 0, updated_at: nowIso });
  }

  const candidatos = rows.length;
  if (posicoes.size === 0) {
    return { rows: [], candidatos, pulado: "snapshot de posição vazio — ausência de tudo não é zero de tudo" };
  }
  if (!completude.completa) return { rows: [], candidatos, pulado: `listagem incompleta: ${completude.motivo}` };
  const teto = Math.max(TETO_ZERAMENTO_MIN, Math.ceil(posicoes.size * TETO_ZERAMENTO_FRACAO));
  if (candidatos > teto) {
    return { rows: [], candidatos, pulado: `${candidatos} a zerar passa do teto de ${teto} — nada zerado` };
  }
  return { rows, candidatos, pulado: null };
}

// Partição dos candidatos a product_costs contra o conjunto que JÁ tem linha:
// - existente → UPDATE de payload MÍNIMO {product_id, cmc, updated_at} (upsert onConflict
//   product_id) — NUNCA carrega cost_price/cost_source/cost_confidence (não promove proveniência);
// - novo → INSERT completo (cost_price=cmc, cost_source CMC, cost_confidence 0.7), igual ao N+1.
export function particionarCustos(
  candidatos: Array<{ product_id: string; cmc: number }>,
  jaTemCusto: Set<string>,
  nowIso: string,
): {
  atualizar: Array<{ product_id: string; cmc: number; updated_at: string }>;
  inserir: Array<{ product_id: string; cost_price: number; cmc: number; cost_source: string; cost_confidence: number }>;
} {
  const atualizar: Array<{ product_id: string; cmc: number; updated_at: string }> = [];
  const inserir: Array<{ product_id: string; cost_price: number; cmc: number; cost_source: string; cost_confidence: number }> = [];
  for (const c of candidatos) {
    if (jaTemCusto.has(c.product_id)) {
      atualizar.push({ product_id: c.product_id, cmc: c.cmc, updated_at: nowIso });
    } else {
      inserir.push({ product_id: c.product_id, cost_price: c.cmc, cmc: c.cmc, cost_source: "CMC", cost_confidence: 0.7 });
    }
  }
  return { atualizar, inserir };
}
