/**
 * Placar da "Visão do CEO" (home do master): derivados PUROS sobre as mesmas leituras do
 * Cockpit financeiro (resumo, DRE, snapshots de projeção), recortados pelo escopo de empresa.
 *
 * Régua (parecer Codex 2026-11-20):
 * - Ausente ≠ zero: qualquer CNPJ do escopo sem o dado → o agregado é `null` ("—"), nunca a
 *   soma de quem respondeu (seria um total menor apresentado como total do grupo).
 * - Margem bruta do ÚLTIMO MÊS FECHADO COMUM a todas as empresas do escopo — o cockpit usa o
 *   último mês de CADA CNPJ e pode misturar meses; aqui o mês é o mesmo e vai visível no tile.
 *   Mês sem receita líquida não conta como "fechado" (DRE vazia não vira margem 0%).
 * - Margem bruta só de quem VENDE MERCADORIA. A Colacor SC só presta serviço (founder,
 *   2026-11-21; DRE de prod: CMV 0 todo mês e o custo inteiro em despesas operacionais), então
 *   `lucro_bruto = receita_liquida − 0` daria 100% sem significado: ela sai da conta e vai
 *   listada em `servicoFora`.
 * - Nas de mercadoria, CMV zerado (ou ausente) com receita > 0 é custo NÃO CLASSIFICADO, não
 *   margem de 100%: a margem do escopo vira `null` com o motivo.
 * - NCG de snapshot sem estoque (`ncg_completa !== true`) vai marcada `completa: false` — o
 *   valor fica (é o mesmo do cockpit, que o mostra como "Parcial"), mas sem leitura de sinal.
 * - Caixa soma saldos entre CNPJs, mas caixa NÃO é fungível entre CNPJs: a lista de empresas
 *   com saldo negativo acompanha o total, para o positivo de uma não esconder o aperto de outra.
 */
import type { Company, CompanySelection } from '@/contexts/CompanyContext';
import { consolidarTitulos, type TotaisTitulos } from '@/lib/financeiro/resumo-titulos';

const EMPRESAS_GRUPO: readonly Company[] = ['oben', 'colacor', 'colacor_sc'];

/** CNPJs que só prestam serviço (sem CMV por natureza) — fora da margem bruta. */
const EMPRESAS_SERVICO: readonly Company[] = ['colacor_sc'];

export function empresasDoEscopo(selection: CompanySelection): Company[] {
  return selection === 'all' ? [...EMPRESAS_GRUPO] : [selection];
}

/** Recorte mínimo do resumo financeiro por CNPJ que o placar usa. */
export type ResumoCnpj = TotaisTitulos & { saldo_total_cc: number | null };

/** Recorte mínimo de uma linha de DRE. */
export interface DreLinha {
  company: string;
  mes: number;
  receita_liquida: number;
  lucro_bruto: number;
  /** Custo da mercadoria vendida (positivo). Zero/ausente com receita = custo não classificado. */
  cmv: number | null;
}

/** Recorte mínimo do consolidado de projeção (NCG por CNPJ). */
export interface NcgFonte {
  ncg_por_empresa: { company: string; ncg: number | null; presente: boolean; completa: boolean }[];
  data_referencia: string | null;
}

export interface Margem {
  /** Fração (0,23 = 23%); `null` sem mês fechado comum ou sem DRE. */
  valor: number | null;
  /** Mês (1-12) usado; `null` quando indisponível. */
  mes: number | null;
  /** Empresas do escopo com CMV zerado/ausente no mês (→ `valor` null). Vazio = margem confiável. */
  semCmv: Company[];
  /** Empresas do escopo que só prestam serviço, deixadas fora da margem bruta. */
  servicoFora: Company[];
}

export interface Caixa {
  saldo: number | null;
  /** A receber − a pagar (títulos abertos). */
  posicaoLiquida: number | null;
  /** CNPJs do escopo com saldo bancário negativo (o total os compensa com o saldo dos outros). */
  empresasNegativas: Company[];
}

export interface Vencidos {
  valor: number | null;
  /** Fração do vencido sobre o total a receber aberto. */
  pct: number | null;
}

export function caixaDoEscopo(resumo: Record<string, ResumoCnpj> | null, empresas: readonly Company[]): Caixa {
  const vazio: Caixa = { saldo: null, posicaoLiquida: null, empresasNegativas: [] };
  if (!resumo || empresas.length === 0) return vazio;
  const linhas = empresas.map((co) => resumo[co]);
  if (linhas.some((l) => l === undefined)) return vazio;
  const saldo = linhas.some((l) => l.saldo_total_cc === null)
    ? null
    : linhas.reduce((s, l) => s + (l.saldo_total_cc as number), 0);
  const empresasNegativas = empresas.filter((co) => {
    const v = resumo[co].saldo_total_cc;
    return v !== null && v < 0;
  });
  return { saldo, posicaoLiquida: consolidarTitulos(linhas).posicao_liquida, empresasNegativas };
}

export function vencidosDoEscopo(resumo: Record<string, ResumoCnpj> | null, empresas: readonly Company[]): Vencidos {
  if (!resumo || empresas.length === 0) return { valor: null, pct: null };
  const linhas = empresas.map((co) => resumo[co]);
  if (linhas.some((l) => l === undefined)) return { valor: null, pct: null };
  const t = consolidarTitulos(linhas);
  if (t.total_vencido_receber === null || t.total_a_receber === null) return { valor: null, pct: null };
  // Carteira aberta zerada é zero LEGÍTIMO (nada a receber, nada vencido).
  const pct = t.total_a_receber > 0 ? t.total_vencido_receber / t.total_a_receber : 0;
  return { valor: t.total_vencido_receber, pct };
}

/**
 * Margem bruta do último mês FECHADO (< mês corrente) presente em TODAS as empresas de
 * mercadoria do escopo, com receita líquida > 0 em cada uma.
 */
export function margemUltimoMesFechado(
  dre: readonly DreLinha[] | null,
  empresas: readonly Company[],
  mesCorrente: number,
): Margem {
  const servicoFora = empresas.filter((co) => EMPRESAS_SERVICO.includes(co));
  const mercadoria = empresas.filter((co) => !EMPRESAS_SERVICO.includes(co));
  const vazio: Margem = { valor: null, mes: null, semCmv: [], servicoFora };
  if (!dre || mercadoria.length === 0) return vazio;
  const mesesPorEmpresa = mercadoria.map(
    (co) => new Set(dre.filter((d) => d.company === co && d.mes < mesCorrente && d.receita_liquida > 0).map((d) => d.mes)),
  );
  const comuns = [...mesesPorEmpresa[0]].filter((m) => mesesPorEmpresa.every((s) => s.has(m)));
  if (comuns.length === 0) return vazio;
  const mes = Math.max(...comuns);
  const doMes = dre.filter((d) => d.mes === mes && mercadoria.includes(d.company as Company));
  // Receita sem custo classificado não é margem de 100%: o grupo inteiro degrada (ausente ≠ zero).
  const semCmv = mercadoria.filter((co) =>
    doMes.some((d) => d.company === co && d.receita_liquida > 0 && !(d.cmv !== null && d.cmv > 0)),
  );
  if (semCmv.length > 0) return { valor: null, mes, semCmv, servicoFora };
  const receita = doMes.reduce((s, d) => s + d.receita_liquida, 0);
  const lucro = doMes.reduce((s, d) => s + d.lucro_bruto, 0);
  return { valor: receita > 0 ? lucro / receita : null, mes, semCmv, servicoFora };
}

export interface Ncg {
  valor: number | null;
  dataReferencia: string | null;
  /** `false` quando algum CNPJ do escopo calculou a NCG sem estoque (valor parcial). */
  completa: boolean;
}

export function ncgDoEscopo(fonte: NcgFonte | null, empresas: readonly Company[]): Ncg {
  if (!fonte || empresas.length === 0) return { valor: null, dataReferencia: null, completa: false };
  let soma = 0;
  let completa = true;
  for (const co of empresas) {
    const linha = fonte.ncg_por_empresa.find((n) => n.company === co);
    if (!linha || !linha.presente || linha.ncg === null) {
      return { valor: null, dataReferencia: fonte.data_referencia, completa: false };
    }
    soma += linha.ncg;
    if (!linha.completa) completa = false;
  }
  return { valor: soma, dataReferencia: fonte.data_referencia, completa };
}

export interface LinhaEmpresa {
  empresa: Company;
  caixa: Caixa;
  vencidos: Vencidos;
  margem: Margem;
  ncg: Ncg;
}

/** Uma linha por CNPJ — o consolidado positivo pode esconder aperto numa empresa só. */
export function linhasPorEmpresa(
  resumo: Record<string, ResumoCnpj> | null,
  dre: readonly DreLinha[] | null,
  ncg: NcgFonte | null,
  empresas: readonly Company[],
  mesCorrente: number,
): LinhaEmpresa[] {
  return empresas.map((empresa) => ({
    empresa,
    caixa: caixaDoEscopo(resumo, [empresa]),
    vencidos: vencidosDoEscopo(resumo, [empresa]),
    margem: margemUltimoMesFechado(dre, [empresa], mesCorrente),
    ncg: ncgDoEscopo(ncg, [empresa]),
  }));
}
