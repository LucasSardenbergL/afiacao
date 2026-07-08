// F4 — Antecipação de recebíveis. Helper PURO (vitest). Sem I/O.
// Spec: docs/superpowers/specs/2026-07-07-antecipacao-recebiveis-design.md
// Precisão > recall: degrada por motivo (nunca fabrica R$). Datas ISO puras (UTC-midnight).
import type { Antecipacao, CustoOperacao } from './antecipacao-types';

const MS_DIA = 86_400_000;
/** Dias corridos entre duas datas ISO puras, ancoradas em UTC-midnight (sem drift de fuso). */
export function diasEntre(operISO: string, vencISO: string): number {
  const a = Date.parse(operISO + 'T00:00:00Z');
  const b = Date.parse(vencISO + 'T00:00:00Z');
  return Math.round((b - a) / MS_DIA);
}

type OpCusto = Pick<
  Antecipacao,
  'valor_bruto' | 'custos_avulsos' | 'valor_liquido' | 'data_operacao' | 'data_vencimento'
>;

const INVALIDO: CustoOperacao = {
  motivo: 'dados_invalidos',
  custo: null,
  dias: null,
  taxa_periodo: null,
  taxa_efetiva_aa: null,
};

/** Custo e taxas de UMA operação. Blinda os invariantes (o CHECK barra no banco; aqui defende o agregado). */
export function custoOperacao(op: OpCusto): CustoOperacao {
  const bruto = Number(op.valor_bruto);
  const avulsos = Number(op.custos_avulsos);
  const liquido = Number(op.valor_liquido);
  if (![bruto, avulsos, liquido].every(Number.isFinite)) return INVALIDO;
  if (!(bruto > 0) || !(liquido > 0) || avulsos < 0) return INVALIDO; // P1-1: valores positivos
  const base = bruto + avulsos;
  if (liquido > base) return INVALIDO; // P1-1: inválido SÓ se líquido > base
  const dias = diasEntre(op.data_operacao, op.data_vencimento);
  if (!(dias > 0)) return INVALIDO; // prazo positivo
  const custo = base - liquido; // P1-4: avulsos entram
  const taxa_periodo = base / liquido - 1;
  const taxa_efetiva_aa = Math.pow(1 + taxa_periodo, 365 / dias) - 1; // normalização (nunca métrica única, §3)
  return { motivo: 'ok', custo, dias, taxa_periodo, taxa_efetiva_aa };
}
