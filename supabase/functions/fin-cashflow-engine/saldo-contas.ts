// Saldo INICIAL das 13 semanas (e base da NCG/dias de cobertura/tesouraria) a partir das contas
// correntes ativas — ausente ≠ zero, velho ≠ hoje (plano v3, item 2).
//
// Lógica PURA para caber no `--no-remote` do `test:edges` (o instante é injetável). Testes em saldo-contas_test.ts; a
// classificação por conta é espelho verbatim de src/lib/financeiro/saldo-contas.ts (paridade no
// vitest `saldo-contas.test.ts`).
//
// Por que a política da edge difere da tela: aqui não há "—" possível — o saldo é o ponto de
// partida de TODAS as semanas e o cron persiste snapshot + alertas. Então:
//   - conta DESCONHECIDA (saldo_data NULL — `saldo_atual` tem DEFAULT 0, conta cujo 1º extrato
//     falhou nasce "R$ 0" — ou valor ilegível) → LANÇA, como a lista vazia já lançava
//     (`exigirLinhas`): o `Number(c.saldo_atual ?? 0)` somava essa conta como zero.
//   - conta VELHA (extrato falhou e o `omie-financeiro` preservou o saldo anterior) → o valor é
//     real porém datado: entra, com motivo em `motivos_confianca` (exibido nas 13 semanas, NCG e
//     Ciclo) e gravado no `premissas` do snapshot. Lançar derrubaria a projeção inteira — NCG e
//     ciclo, que nem usam o saldo — por UMA conta cujo extrato o Omie não respondeu hoje. Mas só
//     até SALDO_IDADE_MAX_PARCIAL_DIAS: conta parada há mais que isso não é "datada", é morta — LANÇA.

import { diaSP } from "../_shared/hoje-sp.ts";

// MIRROR-START saldo-conta — espelhado verbatim de src/lib/financeiro/saldo-contas.ts
export type EstadoSaldoConta = 'fresca' | 'velha' | 'desconhecida';

/**
 * O sync de base (`fin-sync-base-diario`, 03h SP) é o único que grava o extrato de toda conta todo
 * dia. Da hora 04h SP em diante o saldo tem de ser de HOJE; antes dela, o de ontem é o último possível.
 */
export const HORAS_TOLERANCIA_SYNC_BASE = 4;

const DIA_ISO_SALDO = /^\d{4}-\d{2}-\d{2}$/;

/** Dias de SP (`YYYY-MM-DD`): `hoje` e `minimo` = o dia de SP de (agora − HORAS_TOLERANCIA_SYNC_BASE). */
export type ReferenciaFrescor = { hoje: string; minimo: string };

/** Dado incoerente (data futura, ilegível) é desconhecido. */
export function classificarSaldoConta(
  conta: { saldo_atual?: number | string | null; saldo_data?: string | null },
  ref: ReferenciaFrescor,
): EstadoSaldoConta {
  if (conta.saldo_atual == null || conta.saldo_data == null) return 'desconhecida';
  if (typeof conta.saldo_atual === 'string' && conta.saldo_atual.trim() === '') return 'desconhecida';
  if (!Number.isFinite(Number(conta.saldo_atual))) return 'desconhecida';
  if (![conta.saldo_data, ref.hoje, ref.minimo].every((d) => DIA_ISO_SALDO.test(d))) return 'desconhecida';
  if (conta.saldo_data > ref.hoje) return 'desconhecida';
  return conta.saldo_data >= ref.minimo ? 'fresca' : 'velha';
}
// MIRROR-END

export type ContaComSaldo = { saldo_atual?: number | string | null; saldo_data?: string | null };

/** Conta velha além disto (dias-calendário de SP até hoje) deixa de entrar datada e LANÇA. */
export const SALDO_IDADE_MAX_PARCIAL_DIAS = 7;

/** A referência de frescor de um instante (dias de SP). */
export function referenciaFrescorSaldo(agora: Date): ReferenciaFrescor {
  return { hoje: diaSP(agora), minimo: diaSP(new Date(agora.getTime() - HORAS_TOLERANCIA_SYNC_BASE * 3_600_000)) };
}

/**
 * Soma o saldo inicial. Lista vazia, conta desconhecida ou conta velha há mais de
 * SALDO_IDADE_MAX_PARCIAL_DIAS LANÇAM; conta velha dentro do teto entra com `motivo` (não-null só
 * quando há conta velha). O chamador põe o motivo em `motivos_confianca` e no snapshot.
 */
export function saldoInicialDasContas(
  contas: readonly ContaComSaldo[],
  ref: ReferenciaFrescor,
): { saldo: number; motivo: string | null } {
  if (contas.length === 0) {
    throw new Error('fin_contas_correntes: nenhuma conta ativa — saldo inicial indisponível');
  }
  let saldo = 0;
  let desconhecidas = 0;
  let velhas = 0;
  let maisAntiga: string | null = null;
  for (const c of contas) {
    const estado = classificarSaldoConta(c, ref);
    if (estado === 'desconhecida') {
      desconhecidas++;
      continue;
    }
    if (estado === 'velha') {
      velhas++;
      if (maisAntiga == null || (c.saldo_data as string) < maisAntiga) maisAntiga = c.saldo_data as string;
    }
    saldo += Number(c.saldo_atual);
  }
  if (desconhecidas > 0) {
    throw new Error(
      `fin_contas_correntes: ${desconhecidas} de ${contas.length} conta(s) ativa(s) sem saldo do extrato ` +
        `(saldo_data/saldo_atual nulo ou ilegível) — saldo inicial indisponível, não vira R$ 0`,
    );
  }
  if (maisAntiga != null) {
    const idade = Math.round((Date.parse(`${ref.hoje}T00:00:00Z`) - Date.parse(`${maisAntiga}T00:00:00Z`)) / 86_400_000);
    if (idade > SALDO_IDADE_MAX_PARCIAL_DIAS) {
      throw new Error(
        `fin_contas_correntes: conta(s) com saldo do extrato de ${maisAntiga} (${idade} dias, teto ` +
          `${SALDO_IDADE_MAX_PARCIAL_DIAS}) — saldo inicial indisponível, não entra como datado`,
      );
    }
  }
  const motivo = velhas > 0
    ? `Saldo inicial PARCIAL: ${velhas} de ${contas.length} conta(s) corrente(s) com saldo do extrato de ${maisAntiga} ` +
      `(anterior a ${ref.minimo} — o extrato do sync diário falhou e o saldo anterior foi preservado). ` +
      `As 13 semanas, os dias de cobertura, a liquidez operacional e a tesouraria partem desse saldo datado.`
    : null;
  return { saldo, motivo };
}
