// Custo Marginal de Funding — helper puro. Espelhado VERBATIM na edge function Deno
// supabase/functions/fin-funding/index.ts. Toda a metodologia: spec 2026-05-25-financeiro-funding-divida.
// Princípio: tudo em R$ no horizonte; taxa anualizada só pra exibir. Pré-imposto (sem tax-shield).

export type TipoFonte = 'caixa_proprio' | 'antecipacao' | 'capital_giro' | 'cheque_especial';

// IOF de operação de crédito PJ: 0,38% fixo + 0,0082%/dia (parcela diária limitada a 365 dias).
export function iofCredito(valor: number, dias: number): number {
  if (valor <= 0) return 0;
  const diasCap = Math.min(Math.max(dias, 0), 365);
  return valor * (0.000082 * diasCap + 0.0038);
}

// Custo em R$ de prover M reais por D dias a uma taxa anual efetiva (fração).
export function custoEmReais(M: number, dias: number, taxaAnual: number): number {
  if (M <= 0 || dias <= 0 || taxaAnual <= 0) return 0;
  return M * (Math.pow(1 + taxaAnual, dias / 365) - 1);
}

export type AntecipacaoResult = {
  desagio: number; iof: number; tarifa: number; v_liq: number;
  custo_rs: number; taxa_efetiva_aa: number | null;
};

// Antecipação/desconto de um título (face V, vence em N dias). Deságio comercial "por fora".
export function custoAntecipacao(input: {
  valor: number; dias: number; taxa_desconto_mensal: number; // fração a.m.
  tipo: 'desconto' | 'factoring'; tarifa_fixa?: number;
}): AntecipacaoResult {
  const { valor, dias } = input;
  const desagio = valor * input.taxa_desconto_mensal * (dias / 30);
  const iof = input.tipo === 'desconto' ? iofCredito(valor, dias) : 0;
  const tarifa = input.tarifa_fixa ?? 0;
  const v_liq = valor - desagio - iof - tarifa;
  const custo_rs = valor - v_liq;
  const taxa_efetiva_aa = v_liq > 0 && dias > 0 ? Math.pow(valor / v_liq, 365 / dias) - 1 : null;
  return { desagio, iof, tarifa, v_liq, custo_rs, taxa_efetiva_aa };
}

// Custo de oportunidade do caixa próprio (fração a.a.), sensível à alocação A4.
export function custoOportunidadeCaixa(input: {
  cm_anual: number;
  retorno_marginal_a4: number | null;
  ha_fila_a4_positiva: boolean;
  caixa_suficiente: boolean;
}): number {
  if (input.ha_fila_a4_positiva && !input.caixa_suficiente && input.retorno_marginal_a4 != null) {
    return Math.max(input.cm_anual, input.retorno_marginal_a4);
  }
  return input.cm_anual;
}

export type Semana = {
  inicio: string; fim: string; saldo_final: number; total_saidas: number;
  entradas: { id_origem: string; data: string; valor: number }[];
};

export type Contexto = 'gap' | 'sobra' | 'indefinido';

export function classificarContexto(input: {
  tem_projecao: boolean; menor_saldo_ate_n: number | null; reserva_rs: number;
}): Contexto {
  if (!input.tem_projecao || input.menor_saldo_ate_n == null) return 'indefinido';
  return input.menor_saldo_ate_n < input.reserva_rs ? 'gap' : 'sobra';
}

// Simulação de 2 cenários: antecipar adiciona v_liq hoje e remove o recebimento (id_origem) na semana k.
// Delta sobre saldo_final: +v_liq em todas; -valorEntrada de k em diante. Vale criado se algum saldo
// de k em diante cai < reserva no alternativo mas estava >= reserva no base.
export function checaValeEmT(input: {
  semanas: Semana[]; titulo_id: string; v_liq: number; reserva_rs: number;
}): boolean {
  const { semanas, titulo_id, v_liq, reserva_rs } = input;
  const k = semanas.findIndex((s) => s.entradas.some((e) => e.id_origem === titulo_id));
  if (k < 0) return false;
  const valorEntrada = semanas[k].entradas
    .filter((e) => e.id_origem === titulo_id)
    .reduce((acc, e) => acc + e.valor, 0);
  for (let i = k; i < semanas.length; i++) {
    const base = semanas[i].saldo_final;
    const alt = base + v_liq - valorEntrada;
    if (alt < reserva_rs && base >= reserva_rs) return true;
  }
  return false;
}

export function classificarEstrutural(input: {
  semanas: Semana[]; reserva_rs: number; limiar_semanas: number;
}): boolean {
  const comGap = input.semanas.filter((s) => s.saldo_final < input.reserva_rs).length;
  return comGap >= input.limiar_semanas;
}
