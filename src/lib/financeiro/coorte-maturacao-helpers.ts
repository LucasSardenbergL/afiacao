// Coortes de recebimento com MATURAÇÃO FIXA (Frente A, item 4 do plano PME/PMR da Oben) — regra pura
// sobre as linhas da RPC `fin_ciclo_empresa_coorte_maturacao()` (view `v_ciclo_empresa_coorte_maturacao`,
// migration 20261101120000). Coorte = mês de VENCIMENTO; cada janela (D+15/30/60 após o vencimento)
// só traz número quando a coorte está MADURA para ela — imatura = null + flag, nunca número parcial.
// Convenção da fonte: o título conta pelo valor INTEGRAL na data da ÚLTIMA baixa (não é recebimento
// parcial acumulado). Ausente ≠ zero: linha com chave/dinheiro ilegível é DESCARTADA; pct nulo com flag
// madura vira "—"; % exibido é PISO (nunca arredonda para cima — 0,99996 é 99,9 %, não 100 %).
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
  /** SALDO das vencidas abertas (não é partição com as massas pagas: baixa parcial fica fora de todas). */
  valorEmAberto: number;
  diasAntecipacaoPond: number | null;
  diasAtrasoPond: number | null;
  /** Fração 0–1 do valor vencido pago até D+N; `null` = coorte imatura para a janela (ou dado ausente). */
  pct: Record<JanelaMaturacao, number | null>;
  maduro: Record<JanelaMaturacao, boolean>;
  /** Mês CORTADO pela janela de 365 d (o corrente, ou o mais antigo): a coorte é um recorte, não o mês inteiro. */
  mesParcial: boolean;
};

function fracao(x: unknown): number | null {
  const n = num(x);
  return n === null || n < 0 || n > 1 ? null : n;
}

/** Dias ponderados: só fazem sentido ≥ 0 (cada um vive na própria massa); negativo/ilegível = null. */
function diasPond(x: unknown): number | null {
  const n = num(x);
  return n === null || n < 0 ? null : n;
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
  // Massa negativa é dado ilegível, não "zero": descarta a linha (a view só soma valores > 0 e saldos).
  if (valorAntecipado < 0 || valorPagoNoDia < 0 || valorPagoComAtraso < 0 || valorPagoSemData < 0 || valorEmAberto < 0) return null;
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
    diasAntecipacaoPond: diasPond(r.dias_antecipacao_pond), diasAtrasoPond: diasPond(r.dias_atraso_pond), pct, maduro,
    mesParcial: r.mes_parcial === true,
  };
}

export type LinhaMaturacao = {
  mes: string;
  /** `YYYY-MM` para a tabela. */
  rotulo: string;
  titulos: number;
  valorVencido: number;
  /** % (0–100, 1 decimal, PISO) por janela; `null` = imatura. */
  pct: Record<JanelaMaturacao, number | null>;
  maduro: Record<JanelaMaturacao, boolean>;
  pctAntecipado: number;
  pctEmAberto: number;
  /** % pago sem data de baixa (piso de exibição). */
  pctSemData: number;
  /** Há valor pago sem data (pelo valor BRUTO, não pelo % exibido): os D+N são PISO. */
  temSemData: boolean;
  parcial: boolean;
  diasAtrasoPond: number | null;
  diasAntecipacaoPond: number | null;
};

/** Fração → % com 1 decimal por PISO (nunca arredonda para cima); ε cobre o erro binário de `x*1000`. */
export function pisoPct(fracao_: number): number {
  return Math.floor(fracao_ * 1000 + 1e-9) / 10;
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
        15: c.pct[15] === null ? null : pisoPct(c.pct[15]),
        30: c.pct[30] === null ? null : pisoPct(c.pct[30]),
        60: c.pct[60] === null ? null : pisoPct(c.pct[60]),
      },
      maduro: c.maduro,
      pctAntecipado: pisoPct(c.valorAntecipado / c.valorVencido),
      pctEmAberto: pisoPct(c.valorEmAberto / c.valorVencido),
      pctSemData: pisoPct(c.valorPagoSemData / c.valorVencido),
      temSemData: c.valorPagoSemData > 0,
      parcial: c.mesParcial,
      diasAtrasoPond: c.diasAtrasoPond,
      diasAntecipacaoPond: c.diasAntecipacaoPond,
    }));
}

/** Texto curto de uma célula D+N: número com 1 decimal, ou "—" (imatura). */
export function celulaMaturacao(pct: number | null): string {
  return pct === null ? '—' : `${pct.toFixed(1)}%`;
}
