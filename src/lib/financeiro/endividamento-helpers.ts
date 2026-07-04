// F1 Módulo de Endividamento — helper puro (testado em vitest).
// Spec: docs/superpowers/specs/2026-07-04-endividamento-dscr-design.md
// Princípios money-path: ausente ≠ zero (degrada para null + motivo, nunca fabrica
// número); o DSCR só publica com gate de completude + inclusão-no-CP conhecida.
// Datas ISO YYYY-MM-DD comparadas lexicograficamente (datas puras, sem TZ).

import type {
  Divida,
  Parcela,
  ServicoDivida,
  DscrResult,
  IndicadorEbitda,
} from './endividamento-types';

/**
 * Serviço da dívida no horizonte [hoje, fim], em dois buckets.
 * Exclui antecipacao_recorrente (natureza rolling — entra à parte, nunca no DSCR).
 * `dividas` é o SUBCONJUNTO a somar (total das ativas, ou add-back só das 'sim').
 */
export function servicoDivida(
  dividas: Pick<Divida, 'id' | 'tipo'>[],
  parcelas: Parcela[],
  hojeISO: string,
  fimISO: string,
): ServicoDivida {
  const ids = new Set(
    dividas.filter((d) => d.tipo !== 'antecipacao_recorrente').map((d) => d.id),
  );
  let vencido = 0;
  let aVencer = 0;
  for (const p of parcelas) {
    if (p.pago || !ids.has(p.divida_id)) continue;
    if (!Number.isFinite(p.valor_total)) continue;
    if (p.data_vencimento < hojeISO) vencido += p.valor_total;
    else if (p.data_vencimento <= fimISO) aVencer += p.valor_total;
  }
  return { vencido, aVencer, total: vencido + aVencer };
}

/**
 * DSCR-caixa. Publica SÓ com gate de completude e nenhuma dívida ativa 'nao_sei'
 * (denominador incompleto vira índice falso — Codex P1). Add-back: as dívidas com
 * cp_inclusion_status='sim' já foram descontadas pelo A1; devolvê-las ao numerador
 * dá o "cash available for debt service" limpo. Dívidas 'nao' não entram no add-back
 * (o A1 não as descontou).
 */
export function dscrCaixa(params: {
  geracaoOperacionalA1: number | null;
  dividas: Divida[];
  parcelas: Parcela[];
  hojeISO: string;
  fimISO: string;
  completo: boolean;
}): DscrResult {
  const { geracaoOperacionalA1, dividas, parcelas, hojeISO, fimISO, completo } = params;
  const ativas = dividas.filter((d) => d.ativo);
  const temNaoSei = ativas.some((d) => d.cp_inclusion_status === 'nao_sei');
  if (!completo || temNaoSei) return { valor: null, motivo: 'inconclusivo' };

  const servicoTotal = servicoDivida(ativas, parcelas, hojeISO, fimISO).total;
  if (!(servicoTotal > 0)) return { valor: null, motivo: 'sem_divida' };
  if (geracaoOperacionalA1 == null || !Number.isFinite(geracaoOperacionalA1)) {
    return { valor: null, motivo: 'sem_geracao' };
  }
  const dividasSim = ativas.filter((d) => d.cp_inclusion_status === 'sim');
  const addBack = servicoDivida(dividasSim, parcelas, hojeISO, fimISO).total;
  return { valor: (geracaoOperacionalA1 + addBack) / servicoTotal, motivo: 'ok' };
}

/** Saldo devedor em aberto: informado quando presente, senão derivado da amortização não paga. */
export function saldoDevedorEmAberto(divida: Divida, parcelas: Parcela[]): number {
  const inf = divida.saldo_devedor_informado;
  if (inf != null && Number.isFinite(inf)) return inf;
  return parcelas
    .filter((p) => p.divida_id === divida.id && !p.pago && Number.isFinite(p.valor_amortizacao))
    .reduce((s, p) => s + p.valor_amortizacao, 0);
}

/**
 * % de curto prazo = amortização vencida + a vencer em ≤12m ÷ saldo devedor em aberto.
 * `ate12mISO` (hoje + 12 meses) já cobre o vencido (vencimento < hoje < ate12m), então
 * não recebe `hoje` separado — curto prazo inclui todo não-pago com vencimento ≤ 12m.
 */
export function pctCurtoPrazo(
  dividas: Divida[],
  parcelas: Parcela[],
  ate12mISO: string,
): number | null {
  const ativas = dividas.filter((d) => d.ativo);
  const ids = new Set(ativas.map((d) => d.id));
  const saldoTotal = ativas.reduce((s, d) => s + saldoDevedorEmAberto(d, parcelas), 0);
  if (!(saldoTotal > 0)) return null;
  let curto = 0;
  for (const p of parcelas) {
    if (p.pago || !ids.has(p.divida_id)) continue;
    if (!Number.isFinite(p.valor_amortizacao)) continue;
    if (p.data_vencimento <= ate12mISO) curto += p.valor_amortizacao; // ≤12m já cobre vencido
  }
  return curto / saldoTotal;
}

/** DSCR-EBITDA (LTM). EBITDA ausente → null + motivo, nunca 0 (ausente ≠ zero). */
export function dscrEbitda(ebitda: number | null, servicoDividaLTM: number): IndicadorEbitda {
  if (ebitda == null || !Number.isFinite(ebitda)) return { valor: null, motivo: 'falta_ebitda' };
  if (!(servicoDividaLTM > 0)) return { valor: null, motivo: 'sem_divida' };
  return { valor: ebitda / servicoDividaLTM, motivo: 'ok' };
}

/** Dívida líquida / EBITDA — indicador de triagem. EBITDA ausente/zero → null (não fabrica ∞). */
export function dividaLiquidaEbitda(
  dividaBruta: number,
  caixa: number,
  ebitda: number | null,
): IndicadorEbitda {
  if (ebitda == null || !Number.isFinite(ebitda) || ebitda === 0) {
    return { valor: null, motivo: 'falta_ebitda' };
  }
  return { valor: (dividaBruta - caixa) / ebitda, motivo: 'ok' };
}
