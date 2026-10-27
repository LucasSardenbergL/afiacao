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
// (`fin-sync-base-diario`) roda todo dia às 03h SP — hoje ou ontem é fresco; anteontem ou antes
// significa ≥1 sync diário perdido. Medido em 2026-10-26: 40 contas ativas, todas de hoje.

// MIRROR-START saldo-conta — espelhado verbatim em supabase/functions/fin-cashflow-engine/saldo-contas.ts
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
 * Soma o saldo das contas ativas SÓ quando todas são frescas. Lista vazia, conta sem saldo de
 * extrato ou conta com saldo velho → `total: null` + motivo (a tela mostra "—", nunca R$ 0 nem
 * uma soma parcial com cara de completa).
 */
export function resumirSaldoContas(
  contas: readonly ContaComSaldo[],
  hoje: string,
): { total: number | null; motivo: string | null } {
  if (contas.length === 0) {
    return { total: null, motivo: 'Nenhuma conta corrente ativa — saldo bancário indisponível.' };
  }
  let total = 0;
  let desconhecidas = 0;
  let velhas = 0;
  let maisAntiga: string | null = null;
  for (const c of contas) {
    const estado = classificarSaldoConta(c, hoje);
    if (estado === 'desconhecida') desconhecidas++;
    else if (estado === 'velha') {
      velhas++;
      if (maisAntiga == null || (c.saldo_data as string) < maisAntiga) maisAntiga = c.saldo_data as string;
    } else total += Number(c.saldo_atual);
  }
  const partes: string[] = [];
  if (desconhecidas > 0) partes.push(`${desconhecidas} de ${contas.length} conta(s) sem saldo do extrato`);
  if (velhas > 0) partes.push(`${velhas} de ${contas.length} conta(s) com saldo de ${maisAntiga} (mais velho que ontem)`);
  if (partes.length > 0) {
    return { total: null, motivo: `Saldo bancário indisponível: ${partes.join('; ')}.` };
  }
  return { total, motivo: null };
}
