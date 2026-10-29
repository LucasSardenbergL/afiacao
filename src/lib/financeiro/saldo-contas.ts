// Saldo bancário de uma empresa a partir das contas correntes ATIVAS — ausente OU velho ≠ número.
//
// Por que existe (plano v3, item 2): o `omie-financeiro` PRESERVA o saldo anterior quando o extrato
// de uma conta falha (não mexe em `saldo_atual` nem em `saldo_data`), e nenhum leitor olhava
// `saldo_data` — um saldo de dias atrás entrava no caixa com cara de hoje. E `saldo_atual` tem
// DEFAULT 0: conta nova cujo 1º extrato falha nasce com saldo 0 e `saldo_data` NULL, então
// `saldo_atual == null` sozinho nunca dispara — o sinal confiável de ausência é `saldo_data` NULL
// (o writer só grava os dois JUNTOS, no extrato que respondeu). money-path §2: ausente ≠ zero.
//
// Eixo de "velho": `saldo_data` é DATE (o dia de SP em que o extrato respondeu) e o sync de base
// (`fin-sync-base-diario`, jobid 75) roda todo dia às 03h SP. "Hoje ou ontem" deixava passar o caso
// mais comum — UM sync perdido — por ~21h do dia (a engine de caixa roda às 07h SP: ontem ainda
// valia). Então: das 04h SP em diante só o saldo de HOJE é fresco; antes das 04h, o de ontem.
// Medido em 2026-10-26: 40 contas ativas, todas com saldo_data de hoje.

import { spBusinessDate } from '@/lib/time/sp-day';

// MIRROR-START saldo-conta — espelhado verbatim em supabase/functions/fin-cashflow-engine/saldo-contas.ts
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

/** A referência de frescor de um instante (dias de SP). */
export function referenciaFrescorSaldo(agora: Date): ReferenciaFrescor {
  return {
    hoje: spBusinessDate(agora),
    minimo: spBusinessDate(new Date(agora.getTime() - HORAS_TOLERANCIA_SYNC_BASE * 3_600_000)),
  };
}

/**
 * O saldo de UMA conta como a lista por conta o exibe: o número só quando fresco. Sem saldo do
 * extrato (inclui o DEFAULT 0 com `saldo_data` NULL) ou com saldo velho → `saldo: null` + motivo.
 * A lista não pode mostrar "R$ 0,00" nem esconder a conta entre as "zeradas".
 */
export function saldoExibivelDaConta(
  conta: ContaComSaldo,
  ref: ReferenciaFrescor,
): { saldo: number | null; motivo: string | null } {
  const estado = classificarSaldoConta(conta, ref);
  if (estado === 'fresca') return { saldo: Number(conta.saldo_atual), motivo: null };
  if (estado === 'velha') {
    const [ano, mes, dia] = (conta.saldo_data as string).split('-');
    return { saldo: null, motivo: `Saldo de ${dia}/${mes}/${ano}: o extrato não atualizou` };
  }
  return { saldo: null, motivo: 'Sem saldo do extrato' };
}

/**
 * Soma o saldo das contas ativas SÓ quando todas são frescas. Lista vazia, conta sem saldo de
 * extrato ou conta com saldo velho → `total: null` + motivo (a tela mostra "—", nunca R$ 0 nem
 * uma soma parcial com cara de completa).
 */
export function resumirSaldoContas(
  contas: readonly ContaComSaldo[],
  ref: ReferenciaFrescor,
): { total: number | null; motivo: string | null } {
  if (contas.length === 0) {
    return { total: null, motivo: 'Nenhuma conta corrente ativa — saldo bancário indisponível.' };
  }
  let total = 0;
  let desconhecidas = 0;
  let velhas = 0;
  let maisAntiga: string | null = null;
  for (const c of contas) {
    const estado = classificarSaldoConta(c, ref);
    if (estado === 'desconhecida') desconhecidas++;
    else if (estado === 'velha') {
      velhas++;
      if (maisAntiga == null || (c.saldo_data as string) < maisAntiga) maisAntiga = c.saldo_data as string;
    } else total += Number(c.saldo_atual);
  }
  const partes: string[] = [];
  if (desconhecidas > 0) partes.push(`${desconhecidas} de ${contas.length} conta(s) sem saldo do extrato`);
  if (velhas > 0) partes.push(`${velhas} de ${contas.length} conta(s) com saldo de ${maisAntiga} (anterior a ${ref.minimo}: o extrato do sync diário não atualizou)`);
  if (partes.length > 0) {
    return { total: null, motivo: `Saldo bancário indisponível: ${partes.join('; ')}.` };
  }
  return { total, motivo: null };
}
