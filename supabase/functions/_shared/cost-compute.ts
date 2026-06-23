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

/** cost_source da escada + a fonte do decorator de unidade-suspeita (mantém costLadder.ts intacto). */
export type CostSourceComUnidade = CostSource | 'CMC_UNIDADE_SUSPEITA';

// Decorator de unidade-suspeita — unidades geométricas (área/comprimento) cujo custo (cmc) é por
// sub-unidade enquanto o price está noutra unidade. KG/L/G/ML ficam de FORA da 1a versão (falso-
// positivo: líquido custeado E vendido por litro com margem real alta). Spec 2026-06-22.
const UNIDADES_GEOMETRICAS = new Set(['M2', 'M', 'MT', 'CM', 'CM2']);
const DIMENSAO_RE = /([0-9]+) *[Xx] *([0-9]+) *MM/;

/** H1 (unidade geométrica) ∧ H3 (dimensão LxC MM na descrição). Gatilho do decorator (junto de H4). */
function unidadeSuspeita(unidade?: string | null, descricao?: string | null): boolean {
  const u = unidade?.trim().toUpperCase();
  if (!u || !UNIDADES_GEOMETRICAS.has(u)) return false;
  return descricao != null && DIMENSAO_RE.test(descricao);
}

export interface ProdutoCusto {
  id: string;
  valor_unitario: number;
  familia: string | null;
  /** Unidade de medida do Omie (M2/M/UN/KG/L...). Sinal H1 do decorator de unidade-suspeita. */
  unidade?: string | null;
  /** Descrição do produto — fonte do sinal H3 (dimensão LxC MM) do decorator de unidade-suspeita. */
  descricao?: string | null;
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
  cost_source: CostSourceComUnidade;
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

    const base = computeCostLadder({ price, cmc, familyTargetMargin, cfg });
    let costFinal = base.costFinal;
    let costConfidence = base.costConfidence;
    let costPriceToPersist = base.costPriceToPersist;
    let costSource: CostSourceComUnidade = base.costSource;

    // Decorator de unidade-suspeita (money-path): um CMC_MARGEM_ATIPICA cujo "atipismo" vem de
    // DESCASAMENTO DE UNIDADE (cmc por m²/m vs price noutra unidade), não de prejuízo real. Re-chama
    // a escada com cmc=null para herdar o proxy honesto (família/default) e re-rotula a proveniência:
    // cost_final=proxy, cost_price=null (cmc não comparável ao price), confiança do proxy. O cmc cru
    // segue preservado no campo cmc (auditoria). costLadder.ts permanece intacto (decisão do spec).
    if (base.costSource === 'CMC_MARGEM_ATIPICA' && unidadeSuspeita(product.unidade, product.descricao)) {
      const proxy = computeCostLadder({ price, cmc: null, familyTargetMargin, cfg });
      costFinal = proxy.costFinal;
      costConfidence = proxy.costConfidence;
      costPriceToPersist = null;
      costSource = 'CMC_UNIDADE_SUSPEITA';
    }

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
