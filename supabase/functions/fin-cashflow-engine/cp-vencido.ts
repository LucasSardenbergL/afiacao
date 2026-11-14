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
  // Soma em CENTAVOS inteiros (cada saldo arredondado uma vez): Σ faixas = total, exato — somar
  // float e arredondar cada agregado à parte deixava as faixas a 1 centavo do total.
  let qtd = 0;
  let maisAntigo: string | null = null;
  const c = { ate_30: 0, de_31_a_60: 0, de_61_a_180: 0, acima_180: 0 };
  for (const cp of cps) {
    // `!(saldo > 0)` ≡ o `saldo <= 0` do laço para saldo finito (o `numeric` do banco nunca é NaN).
    if (!cp.data_vencimento || !(cp.saldo > 0)) continue;
    if (!ehAberto(cp.status_titulo)) continue;
    if (cp.data_vencimento >= semanaInicio) continue;
    qtd += 1;
    if (maisAntigo === null || cp.data_vencimento < maisAntigo) maisAntigo = cp.data_vencimento;
    const v = Math.round(cp.saldo * 100);
    const dias = diasEntre(hoje, cp.data_vencimento);
    if (dias <= 30) c.ate_30 += v;
    else if (dias <= 60) c.de_31_a_60 += v;
    else if (dias <= 180) c.de_61_a_180 += v;
    else c.acima_180 += v;
  }
  return {
    qtd,
    total: (c.ate_30 + c.de_31_a_60 + c.de_61_a_180 + c.acima_180) / 100,
    vencimento_mais_antigo: maisAntigo,
    faixas: {
      ate_30: c.ate_30 / 100,
      de_31_a_60: c.de_31_a_60 / 100,
      de_61_a_180: c.de_61_a_180 / 100,
      acima_180: c.acima_180 / 100,
    },
  };
}

/**
 * Colunas DEDICADAS do `fin_projecao_snapshots` (db/2026-11-14-fin-projecao-snapshots-cp-vencido.sql; 1 writer: este cron).
 * Sinal money-path nunca em `premissas` (jsonb multi-chave). `null` → todas NULL (não medido).
 */
export function colunasCpVencidoFora(medida: CpVencidoForaProjecao | null) {
  // Espelho dos CHECKs da tabela: medida incoerente vira AUSÊNCIA antes do INSERT — o CHECK nunca derruba
  // o snapshot (mesmo padrão de `colunasSerieEstoque`). Pelo helper acima ela é sempre coerente.
  const m = medida && medidaCoerente(medida) ? medida : null;
  if (medida && !m) console.error("[fin-cashflow] cp_vencido_fora incoerente — gravado como não medido");
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

function medidaCoerente(m: CpVencidoForaProjecao): boolean {
  const f = m.faixas;
  const valores = [m.total, f.ate_30, f.de_31_a_60, f.de_61_a_180, f.acima_180];
  if (!Number.isInteger(m.qtd) || m.qtd < 0 || m.qtd >= 1_000_000) return false;
  if (!valores.every((v) => Number.isFinite(v) && v >= 0) || m.total >= 1e10) return false;
  const cent = (v: number) => Math.round(v * 100);
  if (cent(f.ate_30) + cent(f.de_31_a_60) + cent(f.de_61_a_180) + cent(f.acima_180) !== cent(m.total)) return false;
  return m.qtd === 0
    ? m.total === 0 && m.vencimento_mais_antigo === null
    : m.total > 0 && m.vencimento_mais_antigo !== null;
}
