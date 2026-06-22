// Montagem dos upserts de custo (camada de orquestração do fallback engine de custo).
//
// ESPELHADO VERBATIM em supabase/functions/_shared/cost-compute.ts (Deno não importa
// de src/). A paridade é provada por costCompute.parity.test.ts — divergência = CI
// vermelho. A ÚNICA diferença permitida entre os dois arquivos é a linha de import do
// helper de escada (`./costLadder` no src, `./cost-ladder.ts` no edge); o parity test
// normaliza essa linha antes de comparar.
//
// Por que existe: o edge `omie-analytics-sync/computeCosts` carrega o catálogo inteiro
// (paginado via fetchAll — o PostgREST capa em 1000 silencioso) e DEPOIS monta os
// upserts. Esta função é a parte PURA dessa montagem (sem I/O), testável com vitest:
// dado o conjunto COMPLETO, prova que a cauda > 1000 é processada e que CMC real não
// é rebaixado a proxy (money-path: ausente ≠ zero, nunca fabricar custo).
import {
  computeCostLadder,
  cmcPreferido,
  type CostLadderConfig,
  type CostSource,
} from './cost-ladder.ts';

export interface ProdutoCusto {
  id: string;
  valor_unitario: number;
  familia: string | null;
}

/** Só `cmc` importa do product_costs persistido (pós-#977 o cost_price legado não é mais lido). */
export interface CustoPersistidoCmc {
  cmc?: number | null;
}

/** Só `cmc` importa da posição de inventário para a escada de custo. */
export interface PosicaoCmc {
  cmc?: number | null;
}

export interface UpsertCusto {
  product_id: string;
  cost_price: number | null;
  cmc: number;
  cost_final: number;
  cost_source: CostSource;
  cost_confidence: number;
  family_category: string | null;
  updated_at: string;
}

export function montarUpsertsDeCusto(
  produtos: ProdutoCusto[],
  costMap: Record<string, CustoPersistidoCmc>,
  invMap: Record<string, PosicaoCmc>,
  cfg: CostLadderConfig,
  nowIso: string,
): { rows: UpsertCusto[]; updated: number } {
  // Margem média por família — calculada SÓ de custos REAIS (CMC do inventory). Usar
  // cost_price/proxy aqui reinjetava proxy lavado na média e tornava o motor
  // autorreferencial (proxy gerava proxy). Achado Codex 2026-06-19.
  const familyMargins: Record<string, { totalMargin: number; count: number }> = {};
  for (const p of produtos) {
    if (!(p.valor_unitario > 0)) continue;
    const fam = p.familia || 'default';
    const cmcReal = invMap[p.id]?.cmc ?? 0;
    if (cmcReal > 0) {
      const margin = 1 - cmcReal / p.valor_unitario;
      if (margin > cfg.margemMin && margin < cfg.margemMax) {
        if (!familyMargins[fam]) familyMargins[fam] = { totalMargin: 0, count: 0 };
        familyMargins[fam].totalMargin += margin;
        familyMargins[fam].count++;
      }
    }
  }

  const rows: UpsertCusto[] = [];
  for (const product of produtos) {
    const price = product.valor_unitario;
    if (!price || price <= 0) continue;

    const existing = costMap[product.id];
    const inv = invMap[product.id];
    // CMC a usar: atual do inventory se >0; senão o último persistido. 0 do inventory =
    // "esta posição não traz custo", não "custo é zero" — preservar o CMC real persistido
    // (não rebaixar custo real a proxy). Ver cmcPreferido (Codex review P1).
    const cmc = cmcPreferido(inv?.cmc, existing?.cmc);

    const fam = product.familia || 'default';
    const famData = familyMargins[fam];
    const familyTargetMargin =
      famData && famData.count >= 3 ? famData.totalMargin / famData.count : null;

    const { costFinal, costSource, costConfidence, costPriceToPersist } = computeCostLadder({
      price,
      cmc,
      familyTargetMargin,
      cfg,
    });

    // cost_price guarda SÓ custo real: o CMC quando há, senão null (NUNCA proxy — era a
    // causa da lavagem de proveniência). PRODUCT_COST saiu da escada; o motor não o emite.
    // cmc é PERSISTIDO de propósito: além do fallback de cmcPreferido, a view v_caca_compradores
    // lê product_costs.cmc p/ o lucro da Caça, e este é o único writer que copia o cmc do
    // catálogo inteiro (syncInventoryFull não toca product_costs). Há uma race conhecida com o
    // syncInventory neste campo (2 writers) — pré-existente, tratada na eleição do PR irmão.
    rows.push({
      product_id: product.id,
      cost_price: costPriceToPersist,
      cmc: cmc ?? 0,
      cost_final: costFinal,
      cost_source: costSource,
      cost_confidence: costConfidence,
      family_category: product.familia || null,
      updated_at: nowIso,
    });
  }

  return { rows, updated: rows.length };
}
