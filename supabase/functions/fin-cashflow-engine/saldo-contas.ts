// Saldo INICIAL das 13 semanas (e base da NCG/dias de cobertura/tesouraria) a partir das contas
// correntes ativas — ausente ≠ zero, velho ≠ hoje (plano v3, item 2).
//
// Lógica PURA para caber no `--no-remote` do `test:edges`. Testes em saldo-contas_test.ts; a
// classificação por conta é espelho verbatim de src/lib/financeiro/saldo-contas.ts (paridade no
// vitest `saldo-contas.test.ts`).
//
// Por que a política da edge difere da tela: aqui não há "—" possível — o saldo é o ponto de
// partida de TODAS as semanas e o cron persiste snapshot + alertas. Então:
//   - conta DESCONHECIDA (saldo_data NULL — `saldo_atual` tem DEFAULT 0, conta cujo 1º extrato
//     falhou nasce "R$ 0" — ou valor ilegível) → LANÇA, como a lista vazia já lançava
//     (`exigirLinhas`): o `Number(c.saldo_atual ?? 0)` somava essa conta como zero.
//   - conta VELHA (extrato falhou e o `omie-financeiro` preservou o saldo de dias atrás) → o valor
//     é real porém datado: entra, e o motivo vai para `motivos_confianca` (a tela da NCG e do Ciclo
//     já os exibe). Lançar aqui derrubaria a projeção inteira por UMA conta cujo extrato o Omie
//     parou de responder — e o snapshot anterior ficaria no lugar sem aviso nenhum.

// MIRROR-START saldo-conta — espelhado verbatim de src/lib/financeiro/saldo-contas.ts
export type EstadoSaldoConta = 'fresca' | 'velha' | 'desconhecida';

/** Idade máxima (dias-calendário de SP) de um saldo de extrato para valer como saldo de hoje. */
export const SALDO_IDADE_MAX_DIAS = 1;

const DIA_ISO_SALDO = /^\d{4}-\d{2}-\d{2}$/;

/** `hoje` = dia de negócio de SP (`YYYY-MM-DD`). Dado incoerente (data futura, ilegível) é desconhecido. */
export function classificarSaldoConta(
  conta: { saldo_atual?: number | string | null; saldo_data?: string | null },
  hoje: string,
): EstadoSaldoConta {
  if (conta.saldo_atual == null || conta.saldo_data == null) return 'desconhecida';
  if (typeof conta.saldo_atual === 'string' && conta.saldo_atual.trim() === '') return 'desconhecida';
  if (!Number.isFinite(Number(conta.saldo_atual))) return 'desconhecida';
  if (!DIA_ISO_SALDO.test(conta.saldo_data) || !DIA_ISO_SALDO.test(hoje)) return 'desconhecida';
  const idade = Math.round((Date.parse(`${hoje}T00:00:00Z`) - Date.parse(`${conta.saldo_data}T00:00:00Z`)) / 86_400_000);
  if (!Number.isFinite(idade) || idade < 0) return 'desconhecida';
  return idade <= SALDO_IDADE_MAX_DIAS ? 'fresca' : 'velha';
}
// MIRROR-END

export type ContaComSaldo = { saldo_atual?: number | string | null; saldo_data?: string | null };

/**
 * Soma o saldo inicial. Lista vazia ou conta desconhecida LANÇA; conta velha entra com `motivo`
 * (não-null só quando há conta velha). O chamador põe o motivo em `motivos_confianca`.
 */
export function saldoInicialDasContas(
  contas: readonly ContaComSaldo[],
  hoje: string,
): { saldo: number; motivo: string | null } {
  if (contas.length === 0) {
    throw new Error('fin_contas_correntes: nenhuma conta ativa — saldo inicial indisponível');
  }
  let saldo = 0;
  let desconhecidas = 0;
  let velhas = 0;
  let maisAntiga: string | null = null;
  for (const c of contas) {
    const estado = classificarSaldoConta(c, hoje);
    if (estado === 'desconhecida') {
      desconhecidas++;
      continue;
    }
    if (estado === 'velha' && (maisAntiga == null || (c.saldo_data as string) < maisAntiga)) {
      maisAntiga = c.saldo_data as string;
    }
    if (estado === 'velha') velhas++;
    saldo += Number(c.saldo_atual);
  }
  if (desconhecidas > 0) {
    throw new Error(
      `fin_contas_correntes: ${desconhecidas} de ${contas.length} conta(s) ativa(s) sem saldo do extrato ` +
        `(saldo_data/saldo_atual nulo ou ilegível) — saldo inicial indisponível, não vira R$ 0`,
    );
  }
  const motivo = velhas > 0
    ? `Saldo inicial PARCIAL: ${velhas} de ${contas.length} conta(s) corrente(s) com saldo do extrato de ${maisAntiga} ` +
      `(mais velho que ontem — o extrato do Omie falhou e o saldo anterior foi preservado). ` +
      `As 13 semanas, a NCG, os dias de cobertura e a tesouraria partem desse saldo datado.`
    : null;
  return { saldo, motivo };
}
