// Coortes de recebimento com MATURAÇÃO FIXA (Frente A, item 4 do plano PME/PMR da Oben) — regra pura
// sobre as linhas da RPC `fin_ciclo_empresa_coorte_maturacao()` (view `v_ciclo_empresa_coorte_maturacao`,
// migration 20261101120000). Coorte = mês de VENCIMENTO; cada janela (D+15/30/60 após o vencimento)
// só traz número quando a coorte está MADURA para ela — imatura = null + flag, nunca número parcial.
// Ausente ≠ zero: linha com chave/dinheiro ilegível é DESCARTADA; pct nulo com flag madura vira "—".
import type { Company } from '@/contexts/CompanyContext';
import { num } from '@/lib/financeiro/ciclo-cliente-helpers';

export type JanelaMaturacao = 15 | 30 | 60;
export const JANELAS_MATURACAO: readonly JanelaMaturacao[] = [15, 30, 60];

export type CoorteMaturacao = {
  company: Company;
  /** Mês de vencimento, `YYYY-MM-DD` (1º dia). */
  mes: string;
  titulos: number;
  valorVencido: number;
  valorAntecipado: number;
  valorPagoNoDia: number;
  valorPagoComAtraso: number;
  /** Pago sem data de baixa legível: a janela não sabe onde cai (ausente ≠ zero — nunca somado a D+N). */
  valorPagoSemData: number;
  valorEmAberto: number;
  diasAntecipacaoPond: number | null;
  diasAtrasoPond: number | null;
  /** Fração 0–1 do valor vencido pago até D+N; `null` = coorte imatura para a janela (ou dado ausente). */
  pct: Record<JanelaMaturacao, number | null>;
  maduro: Record<JanelaMaturacao, boolean>;
};

function fracao(x: unknown): number | null {
  const n = num(x);
  return n === null || n < 0 || n > 1 ? null : n;
}

/** Linha da RPC → coorte. `null` quando chave/denominador/massas faltam (linha descartada, nunca default). */
export function normalizarCoorteMaturacao(r: Record<string, unknown>): CoorteMaturacao | null {
  const company = r.company;
  const mes = r.mes_vencimento;
  if (typeof company !== 'string' || typeof mes !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(mes)) return null;
  const titulos = num(r.titulos);
  const valorVencido = num(r.valor_vencido_no_mes);
  const valorAntecipado = num(r.valor_antecipado);
  const valorPagoNoDia = num(r.valor_pago_no_dia);
  const valorPagoComAtraso = num(r.valor_pago_com_atraso);
  const valorPagoSemData = num(r.valor_pago_sem_data);
  const valorEmAberto = num(r.valor_em_aberto);
  if (titulos === null || valorVencido === null || valorVencido <= 0 || valorAntecipado === null || valorPagoNoDia === null
    || valorPagoComAtraso === null || valorPagoSemData === null || valorEmAberto === null) return null;
  const maduro = { 15: r.maduro_d15 === true, 30: r.maduro_d30 === true, 60: r.maduro_d60 === true };
  // Imatura → null mesmo que o banco mande número (defesa em profundidade: a view já manda null).
  const pct = {
    15: maduro[15] ? fracao(r.pct_pago_d15) : null,
    30: maduro[30] ? fracao(r.pct_pago_d30) : null,
    60: maduro[60] ? fracao(r.pct_pago_d60) : null,
  };
  return {
    company: company as Company, mes, titulos, valorVencido, valorAntecipado, valorPagoNoDia, valorPagoComAtraso,
    valorPagoSemData, valorEmAberto,
    diasAntecipacaoPond: num(r.dias_antecipacao_pond), diasAtrasoPond: num(r.dias_atraso_pond), pct, maduro,
  };
}

export type LinhaMaturacao = {
  mes: string;
  /** `YYYY-MM` para a tabela. */
  rotulo: string;
  titulos: number;
  valorVencido: number;
  /** % (0–100, 1 decimal) por janela; `null` = imatura. */
  pct: Record<JanelaMaturacao, number | null>;
  maduro: Record<JanelaMaturacao, boolean>;
  pctAntecipado: number;
  pctEmAberto: number;
  /** % pago sem data de baixa: quando > 0, os D+N são PISO (o sem-data pode ter caído dentro da janela). */
  pctSemData: number;
  diasAtrasoPond: number | null;
  diasAntecipacaoPond: number | null;
};

function pct1(num_: number, den: number): number {
  return Math.round((num_ / den) * 1000) / 10;
}

/** Linhas da tabela de maturação de UMA empresa, do mês mais recente para o mais antigo. */
export function montarLinhasMaturacao(coortes: CoorteMaturacao[], company: Company): LinhaMaturacao[] {
  return coortes
    .filter((c) => c.company === company)
    .sort((a, b) => (a.mes < b.mes ? 1 : a.mes > b.mes ? -1 : 0))
    .map((c) => ({
      mes: c.mes,
      rotulo: c.mes.slice(0, 7),
      titulos: c.titulos,
      valorVencido: c.valorVencido,
      pct: {
        15: c.pct[15] === null ? null : Math.round(c.pct[15] * 1000) / 10,
        30: c.pct[30] === null ? null : Math.round(c.pct[30] * 1000) / 10,
        60: c.pct[60] === null ? null : Math.round(c.pct[60] * 1000) / 10,
      },
      maduro: c.maduro,
      pctAntecipado: pct1(c.valorAntecipado, c.valorVencido),
      pctEmAberto: pct1(c.valorEmAberto, c.valorVencido),
      pctSemData: pct1(c.valorPagoSemData, c.valorVencido),
      diasAtrasoPond: c.diasAtrasoPond,
      diasAntecipacaoPond: c.diasAntecipacaoPond,
    }));
}

/** Texto curto de uma célula D+N: número com 1 decimal, ou "—" (imatura). */
export function celulaMaturacao(pct: number | null): string {
  return pct === null ? '—' : `${pct.toFixed(1)}%`;
}
