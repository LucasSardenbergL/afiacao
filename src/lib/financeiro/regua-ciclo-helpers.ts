import { addDias } from '@/lib/time/sp-day';

// Régua honesta do ciclo (Frente A do plano PME/PMR 2026-10-31, itens 2 e 3) — regra PURA do card da empresa.
// Ausente ≠ zero em tudo: insumo faltante → null + motivo, nunca número fabricado.
//
// Convenções que o card escreve no tooltip (decisão Codex de desenho, não re-litigar):
//   • PMR (motor) = média ponderada por R$ baixado só de títulos PAGOS. Vencido NÃO se soma ao PMR.
//   • DSO = carteira ABERTA toda (a vencer + vencido) ÷ receita de competência TTM × 365 — base distinta.
//   • PME = estoque de giro ÷ CMV TTM × 365; 1 dia de PME = CMV TTM ÷ 365 (não receita).
//   • Ciclo = PME + PMR − PMP soma bases distintas (foto de estoque, pagos, CP total) — rotulado como tal.

/** Σ CMV dos 12 meses FECHADOS anteriores ao mês corrente de SP — espelho de
 *  `supabase/functions/fin-cashflow-engine/estoque-pme.ts#cmvTtmFechado` (a Deno não importa de src/).
 *  Exige os 12 meses, distintos, 1 linha por mês, não-nulos, finitos, Σ > 0. */
export function cmvTtmFechado(
  linhas: Array<{ ano: number; mes: number; cmv?: number | null }>,
  hojeSp: string,
): { valor: number | null; meses: number; motivo: string | null } {
  const [ano, mes] = hojeSp.split('-').map(Number);
  const atual = ano * 12 + (mes - 1);
  const porMes = new Map<number, Array<number | null>>();
  let ultimo = -1;
  for (const l of linhas) {
    const idx = l.ano * 12 + (l.mes - 1);
    if (idx > ultimo && idx < atual) ultimo = idx;
    if (idx < atual - 12 || idx >= atual) continue;
    porMes.set(idx, [...(porMes.get(idx) ?? []), l.cmv == null ? null : Number(l.cmv)]);
  }
  let presentes = 0;
  let soma = 0;
  for (let idx = atual - 12; idx < atual; idx++) {
    const vs = porMes.get(idx);
    if (!vs || vs.length !== 1 || vs[0] == null || !Number.isFinite(vs[0])) continue;
    presentes++;
    soma += vs[0];
  }
  if (presentes < 12) {
    const ult = ultimo < 0 ? 'nenhum' : `${Math.floor(ultimo / 12)}-${String((ultimo % 12) + 1).padStart(2, '0')}`;
    return { valor: null, meses: presentes, motivo: `CMV do DRE cobre ${presentes}/12 meses fechados (último: ${ult})` };
  }
  if (soma <= 0) return { valor: null, meses: presentes, motivo: 'CMV do DRE zerado nos 12 meses fechados' };
  return { valor: soma, meses: presentes, motivo: null };
}

/** Teto de plausibilidade do DSO (mesmo do `dso-dpo-helpers.ts`): acima de 2 anos de receita parada em
 *  carteira o número é quase certo incoerente — vira null com motivo, não "1327 dias". */
export const DSO_TETO_DIAS = 730;

/** DSO point-in-time = CR aberto (a vencer + vencido, saldo) ÷ receita por dia (TTM/365).
 *  CR aberto 0 com receita > 0 é 0 d (fato); receita ausente/≤ 0 ou CR ausente → null + motivo. */
export function dsoPontual(
  crAberto: number | null,
  receitaDia: number | null,
  receitaMeses?: number,
): { dias: number | null; motivo: string | null } {
  if (crAberto === null || !Number.isFinite(crAberto)) return { dias: null, motivo: 'carteira aberta indisponível' };
  if (receitaDia === null || !Number.isFinite(receitaDia) || receitaDia <= 0) return { dias: null, motivo: 'sem receita TTM' };
  // Receita de 6 meses ÷ 365 publicaria um DSO dobrado (Codex, 2026-10-31): o denominador tem de ser o TTM inteiro.
  if (receitaMeses !== undefined && receitaMeses < 12) return { dias: null, motivo: `receita TTM parcial (${receitaMeses} de 12 meses)` };
  if (crAberto < 0) return { dias: null, motivo: 'carteira aberta negativa (dado incoerente)' };
  const dias = crAberto / receitaDia;
  if (dias > DSO_TETO_DIAS) return { dias: null, motivo: `DSO acima do teto de plausibilidade (${DSO_TETO_DIAS} d)` };
  return { dias, motivo: null };
}

export type PontoEstoque = { dia: string; valor: number; coberturaOk: boolean };

/** Dias cobertos pela série dos últimos 90 d (1 ponto por dia, o mais recente vence). */
const JANELA_DIAS = 90;
/** Abaixo disto a média não representa a janela — PME médio indisponível, com motivo. */
export const DIAS_MINIMOS_SERIE = 60;
/** Teto de plausibilidade do PME médio (como o DSO): acima vira null + motivo, nunca "1.460.000.000 d". */
export const PME_TETO_DIAS = 730;

/** Dia civil de São Paulo de um instante ISO (timestamptz do snapshot/sync) — a série é por DIA de SP. */
export function diaSp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(d);
}

/** Soma dias a 'YYYY-MM-DD' por calendário (sem relógio, sem fuso) — delega ao helper canônico. */
export function somarDias(iso: string, dias: number): string {
  return addDias(iso, dias);
}

/** PME pelo estoque MÉDIO dos últimos 90 d: média dos pontos diários (1 por dia, cobertura de custo ok em
 *  todos) ÷ CMV TTM × 365. Série curta ou com subtotal → null + motivo que diz desde quando ela existe. */
export function pmeEstoqueMedio(
  serie: PontoEstoque[],
  cmvTtm: number | null,
  hojeSp: string,
): { pme: number | null; estoqueMedio: number | null; diasCobertos: number; desde: string | null; motivo: string | null } {
  const inicio = somarDias(hojeSp, -(JANELA_DIAS - 1)); // exatamente 90 datas, hoje inclusive
  const porDia = new Map<string, PontoEstoque>();
  for (const p of serie) {
    if (p.dia < inicio || p.dia > hojeSp || !Number.isFinite(p.valor) || p.valor < 0) continue;
    porDia.set(p.dia, p); // ordem de chegada: o chamador manda ascendente, o último do dia vence
  }
  const dias = [...porDia.keys()].sort();
  const diasCobertos = dias.length;
  const desde = diasCobertos > 0 ? dias[0] : null;
  if (diasCobertos === 0) return { pme: null, estoqueMedio: null, diasCobertos, desde, motivo: 'série de estoque ainda sem ponto (nasce no próximo snapshot diário)' };
  if (diasCobertos < DIAS_MINIMOS_SERIE) {
    return { pme: null, estoqueMedio: null, diasCobertos, desde, motivo: `série de estoque cobre ${diasCobertos}/${JANELA_DIAS} dias (desde ${desde}) — PME médio só com ≥ ${DIAS_MINIMOS_SERIE}` };
  }
  const semCobertura = dias.filter((d) => !(porDia.get(d) as PontoEstoque).coberturaOk).length;
  if (semCobertura > 0) {
    return { pme: null, estoqueMedio: null, diasCobertos, desde, motivo: `${semCobertura} dia(s) da série com custo incompleto (subtotal) — PME médio indisponível` };
  }
  const estoqueMedio = dias.reduce((s, d) => s + (porDia.get(d) as PontoEstoque).valor, 0) / diasCobertos;
  if (cmvTtm === null || !Number.isFinite(cmvTtm) || cmvTtm <= 0) {
    return { pme: null, estoqueMedio, diasCobertos, desde, motivo: 'sem CMV TTM' };
  }
  const pme = (estoqueMedio / cmvTtm) * 365;
  if (!Number.isFinite(pme) || pme > PME_TETO_DIAS) {
    return { pme: null, estoqueMedio, diasCobertos, desde, motivo: `PME médio acima do teto de plausibilidade (${PME_TETO_DIAS} d)` };
  }
  return { pme, estoqueMedio, diasCobertos, desde, motivo: null };
}

/** Conta de estoque/CMC por empresa — espelho de `public._fin_estoque_account` (3 grafias: financeiro.md). */
export const ESTOQUE_ACCOUNT: Record<'oben' | 'colacor' | 'colacor_sc', 'vendas' | 'colacor_vendas' | 'servicos'> = {
  oben: 'vendas', colacor: 'colacor_vendas', colacor_sc: 'servicos',
};
