// Confiança do CMV da DRE (edge v1.14, entrega 3 do Placar do CEO — diário: docs/historico/ceo-placar-honesto.md).
//
// `cmv_heuristica` = R$ do CMV do mês que entrou pela heurística de descrição (`viaFallback`: sem mapeamento
// explícito, mapeamento inválido ou lançamento sem código de categoria). `cmv_heuristica_pct` = essa parcela
// sobre o CMV total (0..1). É o que o CEO precisa para saber se a margem bruta é medida ou adivinhada —
// `qtd_categorias_sem_mapeamento` conta a DRE inteira e não responde isso.
//
// ESPELHA os CHECKs de `db/2026-11-22-fin-dre-snapshots-cmv-heuristica.sql`, e o CHECK nunca pode derrubar
// o upsert da DRE: tudo que o banco recusaria vira NULL AQUI, validado DEPOIS do arredondamento (lição do
// Codex P1 no #4132). Ausente ≠ zero: sem CMV (≤ 0) o percentual é NULL ("sem base"), nunca 0%.
//
// Coerência: o banco aceita |pct − valor/cmv| ≤ 0,0001. O pct sai de `round4(valor / cmv)` sobre os MESMOS
// números que vão ao banco, então o erro é ≤ 0,00005 por construção — metade da folga do CHECK, sem checagem
// extra (uma checagem que nunca dispara seria camada falsa: sabotada, o teste continuaria verde).

/** Teto de magnitude do valor (mesmo da composição da NCG): acima disso é dado corrompido, não CMV. */
const TETO_VALOR_CMV_HEURISTICA = 10_000_000_000;

export interface ColunasCmvHeuristica {
  cmv_heuristica: number | null;
  cmv_heuristica_pct: number | null;
}

const arred = (x: number, casas: number) => {
  const f = 10 ** casas;
  return Math.round(x * f) / f;
};

/**
 * `cmvTotal` = o `cmv` que o snapshot grava (sem arredondar, como hoje); `cmvHeuristica` = soma dos `val`
 * com `linha === 'cmv' && viaFallback`. Devolve as duas colunas já dentro do que o banco aceita.
 */
export function colunasCmvHeuristica(input: { cmvTotal: number; cmvHeuristica: number }): ColunasCmvHeuristica {
  const nulo: ColunasCmvHeuristica = { cmv_heuristica: null, cmv_heuristica_pct: null };
  const { cmvTotal, cmvHeuristica } = input;
  if (!Number.isFinite(cmvHeuristica)) return nulo;
  const valor = arred(cmvHeuristica, 2);
  // Faixa do valor validada DEPOIS do arredondamento (o que vai ao banco é `valor`).
  if (!Number.isFinite(valor) || Math.abs(valor) >= TETO_VALOR_CMV_HEURISTICA) return nulo;
  // Sem CMV positivo não há base para a fração: valor medido, percentual "sem base" (NULL ≠ 0%).
  // (CMV e heurística negativos dariam razão "válida" — o CHECK recusa, então aqui também.)
  if (!Number.isFinite(cmvTotal) || cmvTotal <= 0) return { cmv_heuristica: valor, cmv_heuristica_pct: null };
  const pct = arred(valor / cmvTotal, 4);
  // Faixa validada no número ARREDONDADO, exatamente como o CHECK o verá (1,00004 → 1 é aceito).
  if (!Number.isFinite(pct) || pct < 0 || pct > 1) return { cmv_heuristica: valor, cmv_heuristica_pct: null };
  return { cmv_heuristica: valor, cmv_heuristica_pct: pct };
}
