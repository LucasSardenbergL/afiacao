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
 */
import type { Company, CompanySelection } from '@/contexts/CompanyContext';
import { consolidarTitulos, type TotaisTitulos } from '@/lib/financeiro/resumo-titulos';

const BRL_COMPACTO = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  notation: 'compact',
  maximumFractionDigits: 1,
});

/** "R$ 1,2 mi" — o CEO lê ordem de grandeza; o valor exato vai no `title` do tile. */
export function formatarBRLCompacto(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return BRL_COMPACTO.format(v);
}

const EMPRESAS_GRUPO: readonly Company[] = ['oben', 'colacor', 'colacor_sc'];

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
}

/** Recorte mínimo do consolidado de projeção (NCG por CNPJ). */
export interface NcgFonte {
  ncg_por_empresa: { company: string; ncg: number | null; presente: boolean }[];
  data_referencia: string | null;
}

export interface Margem {
  /** Fração (0,23 = 23%); `null` sem mês fechado comum ou sem DRE. */
  valor: number | null;
  /** Mês (1-12) usado; `null` quando indisponível. */
  mes: number | null;
}

export interface Caixa {
  saldo: number | null;
  /** A receber − a pagar (títulos abertos). */
  posicaoLiquida: number | null;
}

export interface Vencidos {
  valor: number | null;
  /** Fração do vencido sobre o total a receber aberto. */
  pct: number | null;
}

export function caixaDoEscopo(resumo: Record<string, ResumoCnpj> | null, empresas: readonly Company[]): Caixa {
  if (!resumo || empresas.length === 0) return { saldo: null, posicaoLiquida: null };
  const linhas = empresas.map((co) => resumo[co]);
  if (linhas.some((l) => l === undefined)) return { saldo: null, posicaoLiquida: null };
  const saldo = linhas.some((l) => l.saldo_total_cc === null)
    ? null
    : linhas.reduce((s, l) => s + (l.saldo_total_cc as number), 0);
  return { saldo, posicaoLiquida: consolidarTitulos(linhas).posicao_liquida };
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
 * Margem bruta do último mês FECHADO (< mês corrente) presente em TODAS as empresas do escopo,
 * com receita líquida > 0 em cada uma.
 */
export function margemUltimoMesFechado(
  dre: readonly DreLinha[] | null,
  empresas: readonly Company[],
  mesCorrente: number,
): Margem {
  if (!dre || empresas.length === 0) return { valor: null, mes: null };
  const mesesPorEmpresa = empresas.map(
    (co) => new Set(dre.filter((d) => d.company === co && d.mes < mesCorrente && d.receita_liquida > 0).map((d) => d.mes)),
  );
  const comuns = [...mesesPorEmpresa[0]].filter((m) => mesesPorEmpresa.every((s) => s.has(m)));
  if (comuns.length === 0) return { valor: null, mes: null };
  const mes = Math.max(...comuns);
  const doMes = dre.filter((d) => d.mes === mes && empresas.includes(d.company as Company));
  const receita = doMes.reduce((s, d) => s + d.receita_liquida, 0);
  const lucro = doMes.reduce((s, d) => s + d.lucro_bruto, 0);
  return { valor: receita > 0 ? lucro / receita : null, mes };
}

export interface Ncg {
  valor: number | null;
  dataReferencia: string | null;
}

export function ncgDoEscopo(fonte: NcgFonte | null, empresas: readonly Company[]): Ncg {
  if (!fonte || empresas.length === 0) return { valor: null, dataReferencia: null };
  let soma = 0;
  for (const co of empresas) {
    const linha = fonte.ncg_por_empresa.find((n) => n.company === co);
    if (!linha || !linha.presente || linha.ncg === null) return { valor: null, dataReferencia: fonte.data_referencia };
    soma += linha.ncg;
  }
  return { valor: soma, dataReferencia: fonte.data_referencia };
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
