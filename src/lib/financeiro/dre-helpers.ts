// src/lib/financeiro/dre-helpers.ts
// Onda 3a — DRE v2 estrutural (regime-aware). Módulo puro, espelhado verbatim no
// engine Deno supabase/functions/omie-financeiro/index.ts (calcularDRE).

import { ANEXOS_SIMPLES, type AnexoSimples, type FaixaSimples, FATOR_R_LIMIAR, PRESUMIDO } from './dre-tabelas-tributarias';

export type RegimeTributario = 'simples' | 'presumido';
export type RegimeApuracao = 'caixa' | 'competencia';

export const REGIME_POR_EMPRESA: Record<string, RegimeTributario> = {
  colacor: 'presumido',
  oben: 'presumido',
  colacor_sc: 'simples',
};

// Linhas de imposto regime-aware + linhas estruturais. Deduções (sobre receita) ficam
// acima da receita líquida; das é linha própria (Simples); irpj/csll abaixo (presumido).
export type DreLinha =
  | 'receita_bruta' | 'deducoes' | 'receitas_financeiras' | 'outras_receitas'
  | 'cmv' | 'despesas_operacionais' | 'despesas_administrativas' | 'despesas_comerciais'
  | 'despesas_financeiras' | 'outras_despesas'
  | 'ded_icms' | 'ded_iss' | 'ded_pis' | 'ded_cofins' | 'ded_ipi'
  | 'das' | 'irpj' | 'csll';

const DRE_LINHAS_VALIDAS = new Set<string>([
  'receita_bruta', 'deducoes', 'receitas_financeiras', 'outras_receitas',
  'cmv', 'despesas_operacionais', 'despesas_administrativas', 'despesas_comerciais',
  'despesas_financeiras', 'outras_despesas',
  'ded_icms', 'ded_iss', 'ded_pis', 'ded_cofins', 'ded_ipi', 'das', 'irpj', 'csll',
  // baldes legados aceitos do mapping antigo:
  'impostos',
]);

export type ResultadoClassificacao = {
  linha: DreLinha;
  mapeado: boolean;        // veio do mapping explícito (exato ou prefixo)
  viaFallback: boolean;    // caiu na heurística de keyword
  impostoNaoMapeado: boolean; // imposto detectado só por keyword (sinal de confiança)
};

// Detecta o tipo de imposto pela keyword e devolve a linha regime-aware.
function impostoPorKeyword(upper: string, regime: RegimeTributario): DreLinha | null {
  const tem = (s: string) => upper.includes(s);
  // Simples: tudo é DAS (recolhimento unificado, LC 123) — nunca quebra.
  if (regime === 'simples') {
    if (tem('DAS') || tem('SIMPLES') || tem('IRPJ') || tem('CSLL') || tem('PIS') ||
        tem('COFINS') || tem('ISS') || tem('ICMS') || tem('IPI') || tem('IMPOST') || tem('TRIBUT')) {
      return 'das';
    }
    return null;
  }
  // Presumido: imposto específico.
  if (tem('IRPJ')) return 'irpj';
  if (tem('CSLL')) return 'csll';
  if (tem('COFINS')) return 'ded_cofins';
  if (tem('PIS')) return 'ded_pis';
  if (tem('ISS')) return 'ded_iss';
  if (tem('ICMS')) return 'ded_icms';
  if (tem('IPI')) return 'ded_ipi';
  if (tem('DAS') || tem('SIMPLES') || tem('IMPOST') || tem('TRIBUT')) return 'ded_icms'; // genérico → trata como dedução
  return null;
}

// Mapeia o balde legado 'impostos' para a linha regime-aware.
function normalizarImpostoLegado(linha: string, regime: RegimeTributario): DreLinha {
  if (linha !== 'impostos') return linha as DreLinha;
  return regime === 'simples' ? 'das' : 'ded_icms';
}

export function classificarLinhaDRE(input: {
  categoria_codigo: string;
  categoria_descricao: string;
  isReceita: boolean;
  regime: RegimeTributario;
  mapping: Map<string, string>;
}): ResultadoClassificacao {
  const { categoria_codigo: cod, categoria_descricao: desc, isReceita, regime, mapping } = input;

  // 1. Match exato
  if (cod && mapping.has(cod)) {
    const raw = mapping.get(cod)!;
    const linha = DRE_LINHAS_VALIDAS.has(raw) ? normalizarImpostoLegado(raw, regime) : (isReceita ? 'receita_bruta' : 'despesas_operacionais');
    return { linha, mapeado: true, viaFallback: false, impostoNaoMapeado: false };
  }
  // 2. Prefix match
  if (cod) {
    const parts = cod.split('.');
    for (let i = parts.length - 1; i >= 2; i--) {
      const prefix = parts.slice(0, i).join('.');
      if (mapping.has(prefix)) {
        const raw = mapping.get(prefix)!;
        const linha = DRE_LINHAS_VALIDAS.has(raw) ? normalizarImpostoLegado(raw, regime) : (isReceita ? 'receita_bruta' : 'despesas_operacionais');
        return { linha, mapeado: true, viaFallback: false, impostoNaoMapeado: false };
      }
    }
  }
  // 3. Heurística por descrição (fallback)
  const upper = (desc + ' ' + cod).toUpperCase();
  if (isReceita) {
    if (upper.includes('DEVOL') || upper.includes('CANCEL')) return { linha: 'deducoes', mapeado: false, viaFallback: true, impostoNaoMapeado: false };
    if (upper.includes('FINANC') || upper.includes('REND') || upper.includes('JUROS REC')) return { linha: 'receitas_financeiras', mapeado: false, viaFallback: true, impostoNaoMapeado: false };
    return { linha: 'receita_bruta', mapeado: false, viaFallback: true, impostoNaoMapeado: false };
  }
  // despesa: imposto primeiro (regime-aware)
  const imp = impostoPorKeyword(upper, regime);
  if (imp) return { linha: imp, mapeado: false, viaFallback: true, impostoNaoMapeado: true };
  if (upper.includes('CMV') || upper.includes('CUSTO MERC') || upper.includes('CUSTO PROD') || upper.includes('MATÉRIA') || upper.includes('MATERIA')) return { linha: 'cmv', mapeado: false, viaFallback: true, impostoNaoMapeado: false };
  if (upper.includes('JUROS') || upper.includes('IOF') || upper.includes('TARIFA BANC') || upper.includes('DESC CONCED')) return { linha: 'despesas_financeiras', mapeado: false, viaFallback: true, impostoNaoMapeado: false };
  if (upper.includes('COMISS') || upper.includes('FRETE VEND') || upper.includes('MARKET') || upper.includes('PUBLICID') || upper.includes('PROPAGANDA') || upper.includes('VIAGEM') || upper.includes('REPRESENT')) return { linha: 'despesas_comerciais', mapeado: false, viaFallback: true, impostoNaoMapeado: false };
  if (upper.includes('ALUGUE') || upper.includes('CONDOM') || upper.includes('SALÁR') || upper.includes('FOLHA') || upper.includes('ENCARGO') || upper.includes('FGTS') || upper.includes('INSS PATR') || upper.includes('CONTAB') || upper.includes('CONSULTORI') || upper.includes('SOFTWARE') || upper.includes('TELEFO') || upper.includes('INTERNET') || upper.includes('ENERGIA') || upper.includes('ÁGUA')) return { linha: 'despesas_administrativas', mapeado: false, viaFallback: true, impostoNaoMapeado: false };
  return { linha: 'despesas_operacionais', mapeado: false, viaFallback: true, impostoNaoMapeado: false };
}

export function resolverDataCaixa(input: {
  data_real: string | null;
  data_vencimento: string | null;
}): { data_efetiva: string | null; usou_fallback: boolean } {
  if (input.data_real) return { data_efetiva: input.data_real, usou_fallback: false };
  if (input.data_vencimento) return { data_efetiva: input.data_vencimento, usou_fallback: true };
  return { data_efetiva: null, usou_fallback: false };
}

// Valor de caixa efetivo, robusto a valor_recebido/valor_pago = 0 OU null (#396: liquidado
// tem valor_recebido=0). `0 ?? doc` mantinha 0 → liquidado com baixa real alocaria ZERO no
// DRE-caixa. Usa o valor real se > 0, senão o valor de documento (face). Espelhado no engine.
export function valorCaixaEfetivo(valorReal: number | null | undefined, valorDocumento: number | null | undefined): number {
  const real = Number(valorReal ?? 0);
  if (real > 0) return real;
  return Number(valorDocumento ?? 0);
}

// Merge do load do DRE-caixa: títulos por (vencimento-no-mês) ∪ (baixa-no-mês). Dedupe por
// omie_codigo_lancamento (um título pode aparecer nas duas queries) → evita DOUBLE-COUNT.
// Linha SEM código (null) nunca vem da query-por-código → preservada (só cai no fallback
// por vencimento). Mantém a 1ª ocorrência de cada código. Espelhado no engine.
export function dedupePorCodigo<T extends { omie_codigo_lancamento?: number | null }>(rows: T[]): T[] {
  const byCode = new Map<number, T>();
  const semCodigo: T[] = [];
  for (const r of rows) {
    const c = r.omie_codigo_lancamento;
    if (c == null) semCodigo.push(r);
    else if (!byCode.has(Number(c))) byCode.set(Number(c), r);
  }
  return [...byCode.values(), ...semCodigo];
}

export type TituloCaixa = { valor: number; data_real: string | null; data_vencimento: string | null };

// Bucketiza por data EFETIVA dentro de [inicio, fim) (fim exclusivo, ISO yyyy-mm-dd).
// Mede o % de valor que usou fallback (vencimento) — alimenta a confiança.
export function bucketizarCaixa(
  titulos: TituloCaixa[],
  inicio: string,
  fim: string,
): { total: number; total_fallback: number; fallback_pct: number; itens: Array<{ valor: number; data_efetiva: string; usou_fallback: boolean }> } {
  let total = 0;
  let total_fallback = 0;
  const itens: Array<{ valor: number; data_efetiva: string; usou_fallback: boolean }> = [];
  for (const t of titulos) {
    const { data_efetiva, usou_fallback } = resolverDataCaixa(t);
    if (!data_efetiva) continue;
    if (data_efetiva < inicio || data_efetiva >= fim) continue;
    total += t.valor;
    if (usou_fallback) total_fallback += t.valor;
    itens.push({ valor: t.valor, data_efetiva, usou_fallback });
  }
  const fallback_pct = total > 0 ? total_fallback / total : 0;
  return { total, total_fallback, fallback_pct, itens };
}

export type DRECalculada = {
  receita_bruta: number; deducoes: number; receita_liquida: number;
  cmv: number; lucro_bruto: number;
  despesas_operacionais: number; despesas_administrativas: number; despesas_comerciais: number;
  despesas_financeiras: number; receitas_financeiras: number;
  resultado_operacional: number; outras_receitas: number; outras_despesas: number;
  resultado_antes_impostos: number; impostos: number; resultado_liquido: number;
  detalhamento_impostos: Record<string, number>;
};

export function montarDRE(input: { regime: RegimeTributario; totais: Record<string, number> }): DRECalculada {
  const t = (k: string) => input.totais[k] ?? 0;
  const indiretos = t('ded_icms') + t('ded_iss') + t('ded_pis') + t('ded_cofins') + t('ded_ipi');
  const das = t('das');
  const impostoLucro = input.regime === 'simples' ? 0 : (t('irpj') + t('csll'));

  // Deduções = devoluções/descontos (balde 'deducoes') + indiretos (presumido) + DAS (Simples).
  const deducoes = t('deducoes') + indiretos + das;
  const receita_bruta = t('receita_bruta');
  const receita_liquida = receita_bruta - deducoes;
  const cmv = t('cmv');
  const lucro_bruto = receita_liquida - cmv;
  const despesas_operacionais = t('despesas_operacionais');
  const despesas_administrativas = t('despesas_administrativas');
  const despesas_comerciais = t('despesas_comerciais');
  const despesas_financeiras = t('despesas_financeiras');
  const receitas_financeiras = t('receitas_financeiras');
  const resultado_operacional = lucro_bruto - (despesas_operacionais + despesas_administrativas + despesas_comerciais) + receitas_financeiras - despesas_financeiras;
  const outras_receitas = t('outras_receitas');
  const outras_despesas = t('outras_despesas');
  const resultado_antes_impostos = resultado_operacional + outras_receitas - outras_despesas;
  const resultado_liquido = resultado_antes_impostos - impostoLucro;

  const detalhamento_impostos: Record<string, number> = {};
  for (const k of ['ded_icms', 'ded_iss', 'ded_pis', 'ded_cofins', 'ded_ipi', 'das', 'irpj', 'csll']) {
    if (t(k) !== 0) detalhamento_impostos[k] = t(k);
  }

  return {
    receita_bruta, deducoes, receita_liquida, cmv, lucro_bruto,
    despesas_operacionais, despesas_administrativas, despesas_comerciais,
    despesas_financeiras, receitas_financeiras, resultado_operacional,
    outras_receitas, outras_despesas, resultado_antes_impostos,
    impostos: impostoLucro, resultado_liquido, detalhamento_impostos,
  };
}

export type Confianca = { nivel: 'alta' | 'media' | 'baixa'; motivos: string[]; pct_mapeado_valor: number; fallback_pct: number };

export function scoreConfianca(input: {
  pct_mapeado_valor: number;   // [0,1] receita+despesa mapeada por valor
  fallback_pct: number;        // [0,1] valor do caixa que usou fallback de vencimento
  share_generico: number;      // [0,1] categorias genéricas (outros/diversos/ajuste) por valor
  tem_imposto_nao_mapeado: boolean;
}): Confianca {
  const motivos: string[] = [];
  // 'alta' = 3, 'media' = 2, 'baixa' = 1 — pega o pior sinal.
  let nivel = 3;
  const rebaixar = (para: number, motivo: string) => { if (para < nivel) nivel = para; motivos.push(motivo); };

  if (input.pct_mapeado_valor < 0.8) rebaixar(1, `Só ${(input.pct_mapeado_valor * 100).toFixed(0)}% do valor está mapeado por categoria.`);
  else if (input.pct_mapeado_valor < 0.9) rebaixar(2, `${(input.pct_mapeado_valor * 100).toFixed(0)}% do valor mapeado (ideal ≥90%).`);

  if (input.fallback_pct > 0.2) rebaixar(1, `${(input.fallback_pct * 100).toFixed(0)}% do caixa usou data de vencimento (fallback) — direcional.`);
  else if (input.fallback_pct > 0.1) rebaixar(2, `${(input.fallback_pct * 100).toFixed(0)}% do caixa usou fallback de vencimento.`);

  if (input.share_generico > 0.15) rebaixar(2, `${(input.share_generico * 100).toFixed(0)}% em categorias genéricas (outros/diversos/ajuste).`);

  if (input.tem_imposto_nao_mapeado) rebaixar(2, 'Categoria de imposto classificada por heurística (não mapeada).');

  return {
    nivel: nivel === 3 ? 'alta' : nivel === 2 ? 'media' : 'baixa',
    motivos,
    pct_mapeado_valor: input.pct_mapeado_valor,
    fallback_pct: input.fallback_pct,
  };
}

export type ReceitaMensal = { ano: number; mes: number; receita_bruta: number };

// RBT12 = soma da receita bruta dos 12 meses ANTERIORES ao mês de apuração (exclusivo).
export function calcularRBT12(historico: ReceitaMensal[], ano: number, mes: number): number {
  const idxApuracao = ano * 12 + mes;
  const idxInicio = idxApuracao - 12;
  return historico.reduce((s, h) => {
    const idx = h.ano * 12 + h.mes;
    return (idx >= idxInicio && idx < idxApuracao) ? s + h.receita_bruta : s;
  }, 0);
}

export function faixaPorRBT12(anexo: AnexoSimples, rbt12: number): FaixaSimples {
  const faixas = ANEXOS_SIMPLES[anexo];
  for (const f of faixas) {
    if (rbt12 <= f.ate) return f;
  }
  return faixas[faixas.length - 1];
}

// Alíquota efetiva do Simples: (RBT12 × nominal − parcela a deduzir) / RBT12.
export function aliquotaEfetivaSimples(anexo: AnexoSimples, rbt12: number): number {
  if (rbt12 <= 0) return 0;
  const f = faixaPorRBT12(anexo, rbt12);
  const efetiva = (rbt12 * f.aliquota - f.deduzir) / rbt12;
  return Math.max(0, efetiva);
}

export function anexoPorFatorR(fatorR: number): AnexoSimples {
  return fatorR >= FATOR_R_LIMIAR ? 'III' : 'V';
}

export function impostoTeoricoSimples(input: {
  anexo: AnexoSimples | null;
  rbt12: number;
  receitaMes: number;
}): number | null {
  if (!input.anexo) return null;            // degrade: sem anexo configurado
  const efetiva = aliquotaEfetivaSimples(input.anexo, input.rbt12);
  return efetiva * input.receitaMes;
}

export function impostoTeoricoPresumido(input: {
  receitaTrimestre: number;
  presuncaoIrpj: number;
  presuncaoCsll: number;
}): { irpj: number; csll: number; pis: number; cofins: number; total: number } {
  const baseIrpj = input.receitaTrimestre * input.presuncaoIrpj;
  const irpjBase = baseIrpj * PRESUMIDO.irpj_aliquota;
  const adicional = Math.max(0, baseIrpj - PRESUMIDO.irpj_adicional_limite_trimestral) * PRESUMIDO.irpj_adicional_aliquota;
  const irpj = irpjBase + adicional;
  const csll = input.receitaTrimestre * input.presuncaoCsll * PRESUMIDO.csll_aliquota;
  const pis = input.receitaTrimestre * PRESUMIDO.pis_aliquota;
  const cofins = input.receitaTrimestre * PRESUMIDO.cofins_aliquota;
  return { irpj, csll, pis, cofins, total: irpj + csll + pis + cofins };
}

export type ConfigTributario = {
  regime: RegimeTributario;
  anexo: AnexoSimples | null;       // Simples
  fatorRHabilitado: boolean;        // Simples: alterna III/V por fator-r
  presuncaoIrpj: number;            // presumido
  presuncaoCsll: number;            // presumido
  completa: boolean;                // false → teórico parcial, confiança ≤ media
};

const PRESUNCAO_DEFAULT = { irpj: 0.08, csll: 0.12 }; // comércio/indústria

export function normalizarConfigTributario(
  company: string,
  raw: Record<string, unknown> | null,
): ConfigTributario {
  const regimeDefault = REGIME_POR_EMPRESA[company] ?? 'presumido';
  const regime = ((raw?.regime as RegimeTributario) ?? regimeDefault);
  const anexo = (raw?.anexo as AnexoSimples | undefined) ?? null;
  const presuncaoIrpj = Number(raw?.presuncao_irpj ?? PRESUNCAO_DEFAULT.irpj);
  const presuncaoCsll = Number(raw?.presuncao_csll ?? PRESUNCAO_DEFAULT.csll);
  const fatorRHabilitado = Boolean(raw?.fator_r_habilitado ?? false);
  const completa = regime === 'presumido' ? raw != null : anexo != null;
  return { regime, anexo, fatorRHabilitado, presuncaoIrpj, presuncaoCsll, completa };
}
