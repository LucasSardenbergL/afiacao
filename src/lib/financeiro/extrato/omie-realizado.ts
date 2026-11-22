/**
 * Lado Omie do resumo diário do extrato (F1 Task 9): movimento REALIZADO por dia, pela regra `v1` da RPC
 * `banco_extrato_omie_dia` (regra e calibração: apêndice "Task 9, Step 1" do plano
 * `docs/superpowers/plans/2026-11-20-f1-extrato-bancario-itau.md`).
 *
 * Gate FAIL-CLOSED, por lado e por DIA (créditos e débitos são calibrados separadamente, e a calibração só vale
 * para os dias do período que mediu):
 * - o servidor já devolve `NULL` no lado/dia não calibrado; aqui o gate é repetido (defesa em profundidade): um
 *   número que chegue com o flag do dia `false` é DESCARTADO, nunca exibido;
 * - flag ausente (`null`) = não calibrado; versões de regra misturadas na resposta = tudo fechado;
 * - sentido sem linha Omie no dia = `null` (ausente ≠ zero), mesmo calibrado.
 */

export interface LinhaOmieDiaRpc {
  data: string;
  creditos_centavos: number | string | null;
  debitos_centavos: number | string | null;
  regra_versao: string | null;
  creditos_calibrado: boolean | null;
  debitos_calibrado: boolean | null;
}

export interface MovimentoOmieDia {
  creditos: number | null;
  debitos: number | null;
  creditosCalibrado: boolean;
  debitosCalibrado: boolean;
}

export interface MovimentoOmie {
  regraVersao: string | null;
  /** Algum dia da resposta tem o lado calibrado (para o rótulo da coluna). */
  creditosCalibrado: boolean;
  debitosCalibrado: boolean;
  /** Por data 'YYYY-MM-DD'. Lado não calibrado no dia → sempre `null`. Dia ausente = não calibrado. */
  porDia: Record<string, MovimentoOmieDia>;
}

export const MOVIMENTO_OMIE_FECHADO: MovimentoOmie = {
  regraVersao: null,
  creditosCalibrado: false,
  debitosCalibrado: false,
  porDia: {},
};

/** bigint do PostgREST (number ou string de dígitos) → centavos. Qualquer outra coisa (inclusive '   ') → null. */
function centavosOuNull(v: unknown): number | null {
  if (typeof v === 'number') return Number.isSafeInteger(v) ? v : null;
  if (typeof v !== 'string' || !/^-?\d+$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

export function montarMovimentoOmie(linhas: readonly LinhaOmieDiaRpc[] | null | undefined): MovimentoOmie {
  if (!linhas || linhas.length === 0) return MOVIMENTO_OMIE_FECHADO;
  const versoes = new Set(linhas.map((l) => l.regra_versao));
  const regraVersao = versoes.size === 1 ? [...versoes][0] ?? null : null;
  // versões misturadas na mesma resposta: não há regra única para atestar — fecha tudo.
  const versaoUnica = regraVersao !== null;
  const porDia: Record<string, MovimentoOmieDia> = {};
  let algumC = false;
  let algumD = false;
  for (const l of linhas) {
    const calC = versaoUnica && l.creditos_calibrado === true;
    const calD = versaoUnica && l.debitos_calibrado === true;
    algumC ||= calC;
    algumD ||= calD;
    porDia[l.data] = {
      creditos: calC ? centavosOuNull(l.creditos_centavos) : null,
      debitos: calD ? centavosOuNull(l.debitos_centavos) : null,
      creditosCalibrado: calC,
      debitosCalibrado: calD,
    };
  }
  return { regraVersao, creditosCalibrado: algumC, debitosCalibrado: algumD, porDia };
}
