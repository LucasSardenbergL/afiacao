// CP vencido FORA da projeção de 13 semanas — só a MEDIDA, nenhum saldo muda (v2.4).
//
// O laço de `gerarSemanas` põe um CP numa semana só se `data_vencimento` ∈ [início, fim] dela, a partir
// da segunda-feira corrente. O CP aberto vencido ANTES dessa segunda não cai em semana nenhuma e sumia
// calado (diagnóstico: docs/historico/cp-atrasado-fora-da-projecao.md — Oben, 14/11/2026: 150 títulos,
// R$ 634.571, quase tudo parcelamento de empréstimo e tributo). Não se sabe pelo banco se é status
// velho no Omie (débito automático sem baixa: incluir contaria a saída duas vezes) ou dívida real.
//
// DECISÃO DO FOUNDER (14/11/2026): só tornar VISÍVEL. Estes títulos NÃO entram em semana nenhuma até a
// conferência título a título decidir. Por isso esta função só MEDE — quem a chama não soma o
// resultado em saída nem em saldo (a identidade COM/SEM vencidos é provada em cp-vencido-fora_test.ts).
//
// O predicado é o COMPLEMENTO EXATO do filtro do laço (mesmos `data_vencimento` não-nulo, `saldo > 0`
// e status aberto), restrito a `data_vencimento < semanaInicio`. `semanaInicio` e `hoje` vêm do
// PRÓPRIO `gerarSemanas` — recalcular aqui abriria corrida na virada de domingo para segunda.

export type CpVencidoForaProjecao = {
  qtd: number;
  total: number;
  /** YYYY-MM-DD do vencimento mais antigo; null quando não há título (qtd = 0). */
  vencimento_mais_antigo: string | null;
  /** R$ por dias de atraso contados até `hoje` (faixas do diagnóstico de 31/10). */
  faixas: { ate_30: number; de_31_a_60: number; de_61_a_180: number; acima_180: number };
};

type CpMinimo = { data_vencimento: string | null; saldo: number; status_titulo: string | null };

const centavos = (v: number) => Math.round(v * 100) / 100;

function diasEntre(a: string, b: string): number {
  return Math.round(
    (new Date(a + "T00:00:00Z").getTime() - new Date(b + "T00:00:00Z").getTime()) / 86400000,
  );
}

/**
 * Ausente ≠ zero: `cps` que não é lista (carga que não aconteceu) devolve `null`, nunca um zero
 * fabricado. Lista vazia é fato e devolve zeros.
 */
export function medirCpVencidoForaProjecao(
  cps: readonly CpMinimo[] | null | undefined,
  semanaInicio: string,
  hoje: string,
  ehAberto: (status: string | null | undefined) => boolean,
): CpVencidoForaProjecao | null {
  if (!Array.isArray(cps)) return null;
  let qtd = 0;
  let total = 0;
  let maisAntigo: string | null = null;
  const faixas = { ate_30: 0, de_31_a_60: 0, de_61_a_180: 0, acima_180: 0 };
  for (const cp of cps) {
    if (!cp.data_vencimento || !(cp.saldo > 0)) continue;
    if (!ehAberto(cp.status_titulo)) continue;
    if (cp.data_vencimento >= semanaInicio) continue;
    qtd += 1;
    total += cp.saldo;
    if (maisAntigo === null || cp.data_vencimento < maisAntigo) maisAntigo = cp.data_vencimento;
    const dias = diasEntre(hoje, cp.data_vencimento);
    if (dias <= 30) faixas.ate_30 += cp.saldo;
    else if (dias <= 60) faixas.de_31_a_60 += cp.saldo;
    else if (dias <= 180) faixas.de_61_a_180 += cp.saldo;
    else faixas.acima_180 += cp.saldo;
  }
  return {
    qtd,
    total: centavos(total),
    vencimento_mais_antigo: maisAntigo,
    faixas: {
      ate_30: centavos(faixas.ate_30),
      de_31_a_60: centavos(faixas.de_31_a_60),
      de_61_a_180: centavos(faixas.de_61_a_180),
      acima_180: centavos(faixas.acima_180),
    },
  };
}

/**
 * Colunas DEDICADAS do `fin_projecao_snapshots` (migration 20261114120000; 1 writer: este cron).
 * Sinal money-path nunca em `premissas` (jsonb multi-chave). `null` → todas NULL (não medido).
 */
export function colunasCpVencidoFora(m: CpVencidoForaProjecao | null) {
  return {
    cp_vencido_fora_qtd: m?.qtd ?? null,
    cp_vencido_fora_total: m?.total ?? null,
    cp_vencido_fora_mais_antigo: m?.vencimento_mais_antigo ?? null,
    cp_vencido_fora_ate_30: m?.faixas.ate_30 ?? null,
    cp_vencido_fora_31_60: m?.faixas.de_31_a_60 ?? null,
    cp_vencido_fora_61_180: m?.faixas.de_61_a_180 ?? null,
    cp_vencido_fora_acima_180: m?.faixas.acima_180 ?? null,
  };
}
