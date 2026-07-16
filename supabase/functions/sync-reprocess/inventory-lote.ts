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
import { buildProductIdMap } from "../_shared/product-idmap.ts";

export interface PosicaoEstoque {
  saldo: number;
  cmc: number;
  precoMedio: number;
}

export interface ItemPosEstoqueOmie {
  nCodProd?: number | string;
  nSaldo?: number;
  nCMC?: number;
  nPrecoMedio?: number;
}

export interface LinhaProdutoLocal {
  id: string | null;
  omie_codigo_produto: number | string | null;
  estoque: unknown;
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
  stockRows: Array<{ id: string; estoque: number; updated_at: string }>;
  custoCandidatos: Array<{ product_id: string; cmc: number }>;
  divergences: number;
}

// Guard anti-runaway: nTotPaginas lixo/gigante não pode girar a edge por horas.
// 500 páginas × 100 = 50k posições ≈ 60× o catálogo OBEN atual (~785).
export const MAX_PAGINAS_POS_ESTOQUE = 500;

// Normaliza e acumula uma página do ListarPosEstoque no Map (dedupe last-wins por código —
// código repetido no MESMO statement de upsert daria 21000 "cannot affect row a second time").
// ⚠️ Os `?? 0` são fabricação CONSCIENTE preservada do N+1: a posição VEIO na resposta do
// Omie; campo ausente = posição zerada, não "dado indisponível". O gate money-path real é o
// cmc>0 em planejarEscritaInventario (custo zero nunca vira product_costs).
export function acumularPosicoesDaPagina(
  posicoes: Map<number, PosicaoEstoque>,
  produtos: ItemPosEstoqueOmie[],
): number {
  let validos = 0;
  for (const prod of produtos) {
    const codProd = Number(prod.nCodProd); // Omie pode devolver string; chave do Map é number
    if (!Number.isSafeInteger(codProd) || codProd <= 0) continue;
    const saldo = Number(prod.nSaldo ?? 0);
    const cmc = Number(prod.nCMC ?? 0);
    const precoMedio = Number(prod.nPrecoMedio ?? 0);
    // Drift de contrato (NaN/±Inf/lixo) descarta o ITEM, não o lote: em chunk de 500 um único
    // valor malformado derrubaria o statement inteiro no Postgres (no N+1 o dano era 1 produto).
    // Nunca clampa lixo para 0 — seria fabricação.
    if (!Number.isFinite(saldo) || !Number.isFinite(cmc) || !Number.isFinite(precoMedio)) continue;
    posicoes.set(codProd, { saldo, cmc, precoMedio });
    validos++;
  }
  return validos;
}

// Valida o nTotPaginas DECLARADO na resposta — fail-FAST (Codex P1): um nTotPaginas lixo
// gigante (ex.: 100000) não pode ser descoberto só na página maxPaginas+1, depois de ~90s de
// chamadas Omie — isso reproduziria o próprio 546. Lixo não-inteiro/0/negativo degrada para 1
// (fiel ao `|| 1` histórico: processa a página que JÁ veio e para).
export function validarTotalPaginas(nTot: number | undefined, maxPaginas: number): number {
  const total = Number(nTot ?? 1);
  if (!Number.isSafeInteger(total) || total < 1) return 1;
  if (total > maxPaginas) {
    throw new Error(
      `nTotPaginas=${total} acima do teto anti-runaway (${maxPaginas}) — abortando fail-fast antes de paginar`,
    );
  }
  return total;
}

export type VeredictoPagina = "processar" | "fim" | "anomalia";

// nTotPaginas do Omie é PISO, não verdade (docs/agent/sync.md): página vazia ANTES do fim
// declarado = fault transiente/rate-limit disfarçado — completar aqui deixaria a cauda stale
// com 'complete' mentindo → anomalia (o caller aborta fail-closed; o próximo ciclo tenta).
// Vazia NA última declarada (ou além) = fim normal.
export function avaliarPagina(nItens: number, pagina: number, totalPaginas: number): VeredictoPagina {
  if (nItens > 0) return "processar";
  return pagina < totalPaginas ? "anomalia" : "fim";
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
      plano.stockRows.push({ id, estoque: p.saldo, updated_at: nowIso });
      if (p.cmc > 0) plano.custoCandidatos.push({ product_id: id, cmc: p.cmc });
    }
  }
  return plano;
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
