// @ts-nocheck
import { supabase } from "@/integrations/supabase/client";
import type { Company } from "@/contexts/CompanyContext";

// ═══════════════ TYPES ═══════════════

export interface FinResumo {
  contas_correntes: { descricao: string; saldo_atual: number; banco: string }[];
  saldo_total_cc: number;
  total_a_receber: number;
  total_a_pagar: number;
  total_vencido_receber: number;
  total_vencido_pagar: number;
  posicao_liquida: number;
}

export interface FinContaPagar {
  id: string;
  company: string;
  omie_codigo_lancamento: number;
  nome_fornecedor: string;
  cnpj_cpf: string;
  numero_documento: string;
  data_emissao: string | null;
  data_vencimento: string | null;
  data_pagamento: string | null;
  valor_documento: number;
  valor_pago: number;
  saldo: number;
  status_titulo: string;
  categoria_codigo: string;
  categoria_descricao: string;
  tipo_documento: string | null;
  observacao: string | null;
}

export interface FinContaReceber {
  id: string;
  company: string;
  omie_codigo_lancamento: number;
  nome_cliente: string;
  cnpj_cpf: string;
  numero_documento: string;
  numero_pedido: string | null;
  data_emissao: string | null;
  data_vencimento: string | null;
  data_recebimento: string | null;
  valor_documento: number;
  valor_recebido: number;
  saldo: number;
  status_titulo: string;
  categoria_codigo: string;
  categoria_descricao: string;
  vendedor_id: number | null;
}

export interface FinDRE {
  company: string;
  ano: number;
  mes: number;
  receita_bruta: number;
  deducoes: number;
  receita_liquida: number;
  cmv: number;
  lucro_bruto: number;
  despesas_operacionais: number;
  despesas_administrativas: number;
  despesas_comerciais: number;
  despesas_financeiras: number;
  receitas_financeiras: number;
  resultado_operacional: number;
  outras_receitas: number;
  outras_despesas: number;
  resultado_antes_impostos: number;
  impostos: number;
  resultado_liquido: number;
  detalhamento: {
    receitas: Record<string, number>;
    despesas: Record<string, number>;
  };
}

export interface AgingData {
  a_vencer_qtd: number;
  a_vencer_valor: number;
  vencido_1_30_qtd: number;
  vencido_1_30_valor: number;
  vencido_31_60_qtd: number;
  vencido_31_60_valor: number;
  vencido_61_90_qtd: number;
  vencido_61_90_valor: number;
  vencido_90_plus_qtd: number;
  vencido_90_plus_valor: number;
}

export interface FluxoCaixaDiario {
  data: string;
  entradas_previstas: number;
  entradas_realizadas: number;
  saidas_previstas: number;
  saidas_realizadas: number;
  saldo_previsto: number;
  saldo_realizado: number;
}

// ═══════════════ SYNC ACTIONS ═══════════════

export async function triggerFinanceiroSync(
  action: string,
  companies?: Company[],
  options?: Record<string, unknown>
) {
  const { data, error } = await supabase.functions.invoke("omie-financeiro", {
    body: {
      action,
      companies: companies || ["oben", "colacor", "colacor_sc"],
      ...options,
    },
  });

  if (error) throw new Error(error.message);
  return data;
}

// ═══════════════ QUERIES LOCAIS ═══════════════

export async function getResumoFinanceiro(companies: Company[]): Promise<Record<string, FinResumo>> {
  const resumo: Record<string, FinResumo> = {};

  for (const company of companies) {
    // Saldos CC
    const { data: contas } = await supabase
      .from("fin_contas_correntes")
      .select("descricao, saldo_atual, banco")
      .eq("company", company)
      .eq("ativo", true) as any;

    // Totais a receber aberto (Omie uses: A VENCER, ATRASADO, VENCE HOJE)
    const { data: crAberto } = await supabase
      .from("fin_contas_receber")
      .select("valor_documento, valor_recebido")
      .eq("company", company)
      .in("status_titulo", ["A VENCER", "ATRASADO", "VENCE HOJE"]) as any;

    // Totais a pagar aberto
    const { data: cpAberto } = await supabase
      .from("fin_contas_pagar")
      .select("valor_documento, valor_pago")
      .eq("company", company)
      .in("status_titulo", ["A VENCER", "ATRASADO", "VENCE HOJE"]) as any;

    // Vencidos (ATRASADO in Omie)
    const { data: crVencido } = await supabase
      .from("fin_contas_receber")
      .select("valor_documento, valor_recebido")
      .eq("company", company)
      .eq("status_titulo", "ATRASADO") as any;

    const { data: cpVencido } = await supabase
      .from("fin_contas_pagar")
      .select("valor_documento, valor_pago")
      .eq("company", company)
      .eq("status_titulo", "ATRASADO") as any;

    const sumCR = (arr: any[] | null) =>
      (arr || []).reduce((s: number, r: any) => s + ((r.valor_documento || 0) - (r.valor_recebido || 0)), 0);
    const sumCP = (arr: any[] | null) =>
      (arr || []).reduce((s: number, r: any) => s + ((r.valor_documento || 0) - (r.valor_pago || 0)), 0);

    resumo[company] = {
      contas_correntes: contas || [],
      saldo_total_cc: (contas || []).reduce((s: number, c: any) => s + (c.saldo_atual || 0), 0),
      total_a_receber: sumCR(crAberto),
      total_a_pagar: sumCP(cpAberto),
      total_vencido_receber: sumCR(crVencido),
      total_vencido_pagar: sumCP(cpVencido),
      posicao_liquida: sumCR(crAberto) - sumCP(cpAberto),
    };
  }

  return resumo;
}

export async function getContasPagar(
  company: Company | 'all',
  filtros?: { status?: string; dataInicio?: string; dataFim?: string; limit?: number }
): Promise<FinContaPagar[]> {
  let query = supabase
    .from("fin_contas_pagar")
    .select("*")
    .order("data_vencimento", { ascending: true }) as any;

  if (company !== 'all') query = query.eq("company", company);
  if (filtros?.status) query = query.eq("status_titulo", filtros.status);
  if (filtros?.dataInicio) query = query.gte("data_vencimento", filtros.dataInicio);
  if (filtros?.dataFim) query = query.lte("data_vencimento", filtros.dataFim);
  if (filtros?.limit) query = query.limit(filtros.limit);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function getContasReceber(
  company: Company | 'all',
  filtros?: { status?: string; dataInicio?: string; dataFim?: string; limit?: number }
): Promise<FinContaReceber[]> {
  let query = supabase
    .from("fin_contas_receber")
    .select("*")
    .order("data_vencimento", { ascending: true }) as any;

  if (company !== 'all') query = query.eq("company", company);
  if (filtros?.status) query = query.eq("status_titulo", filtros.status);
  if (filtros?.dataInicio) query = query.gte("data_vencimento", filtros.dataInicio);
  if (filtros?.dataFim) query = query.lte("data_vencimento", filtros.dataFim);
  if (filtros?.limit) query = query.limit(filtros.limit);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function getAgingReceber(company: Company | 'all'): Promise<AgingData> {
  const { data, error } = await supabase
    .from("fin_aging_receber" as any)
    .select("*")
    .then(({ data, error }: any) => {
      if (error) return { data: null, error };
      if (company === 'all') {
        // Consolidar todas as empresas
        const consolidated: AgingData = {
          a_vencer_qtd: 0, a_vencer_valor: 0,
          vencido_1_30_qtd: 0, vencido_1_30_valor: 0,
          vencido_31_60_qtd: 0, vencido_31_60_valor: 0,
          vencido_61_90_qtd: 0, vencido_61_90_valor: 0,
          vencido_90_plus_qtd: 0, vencido_90_plus_valor: 0,
        };
        for (const row of (data || [])) {
          for (const key of Object.keys(consolidated) as (keyof AgingData)[]) {
            consolidated[key] += row[key] || 0;
          }
        }
        return { data: consolidated, error: null };
      }
      const row = (data || []).find((r: any) => r.company === company);
      return { data: row || null, error: null };
    });

  return data || {
    a_vencer_qtd: 0, a_vencer_valor: 0,
    vencido_1_30_qtd: 0, vencido_1_30_valor: 0,
    vencido_31_60_qtd: 0, vencido_31_60_valor: 0,
    vencido_61_90_qtd: 0, vencido_61_90_valor: 0,
    vencido_90_plus_qtd: 0, vencido_90_plus_valor: 0,
  };
}

export async function getAgingPagar(company: Company | 'all'): Promise<AgingData> {
  const { data, error } = await supabase
    .from("fin_aging_pagar" as any)
    .select("*")
    .then(({ data, error }: any) => {
      if (error) return { data: null, error };
      if (company === 'all') {
        const consolidated: AgingData = {
          a_vencer_qtd: 0, a_vencer_valor: 0,
          vencido_1_30_qtd: 0, vencido_1_30_valor: 0,
          vencido_31_60_qtd: 0, vencido_31_60_valor: 0,
          vencido_61_90_qtd: 0, vencido_61_90_valor: 0,
          vencido_90_plus_qtd: 0, vencido_90_plus_valor: 0,
        };
        for (const row of (data || [])) {
          for (const key of Object.keys(consolidated) as (keyof AgingData)[]) {
            consolidated[key] += row[key] || 0;
          }
        }
        return { data: consolidated, error: null };
      }
      const row = (data || []).find((r: any) => r.company === company);
      return { data: row || null, error: null };
    });

  return data || {
    a_vencer_qtd: 0, a_vencer_valor: 0,
    vencido_1_30_qtd: 0, vencido_1_30_valor: 0,
    vencido_31_60_qtd: 0, vencido_31_60_valor: 0,
    vencido_61_90_qtd: 0, vencido_61_90_valor: 0,
    vencido_90_plus_qtd: 0, vencido_90_plus_valor: 0,
  };
}

export async function getDRE(
  company: Company,
  ano: number,
  meses?: number[]
): Promise<FinDRE[]> {
  let query = supabase
    .from("fin_dre_snapshots")
    .select("*")
    .eq("company", company)
    .eq("ano", ano)
    .order("mes", { ascending: true }) as any;

  if (meses && meses.length > 0) {
    query = query.in("mes", meses);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function getDREConsolidado(
  companies: Company[],
  ano: number,
  meses?: number[]
): Promise<Record<string, FinDRE[]>> {
  const result: Record<string, FinDRE[]> = {};
  for (const co of companies) {
    result[co] = await getDRE(co, ano, meses);
  }
  return result;
}

export async function getFluxoCaixa(
  company: Company | 'all',
  dataInicio: string,
  dataFim: string
): Promise<FluxoCaixaDiario[]> {
  // Buscar CR e CP para projetar fluxo
  const crQuery = supabase
    .from("fin_contas_receber")
    .select("data_vencimento, data_recebimento, valor_documento, valor_recebido, status_titulo")
    .gte("data_vencimento", dataInicio)
    .lte("data_vencimento", dataFim) as any;
  
  const cpQuery = supabase
    .from("fin_contas_pagar")
    .select("data_vencimento, data_pagamento, valor_documento, valor_pago, status_titulo")
    .gte("data_vencimento", dataInicio)
    .lte("data_vencimento", dataFim) as any;

  if (company !== 'all') {
    crQuery.eq("company", company);
    cpQuery.eq("company", company);
  }

  const [{ data: crData }, { data: cpData }] = await Promise.all([crQuery, cpQuery]);

  // Agrupar por dia
  const fluxoMap = new Map<string, FluxoCaixaDiario>();
  
  const ensureDay = (d: string): FluxoCaixaDiario => {
    if (!fluxoMap.has(d)) {
      fluxoMap.set(d, {
        data: d,
        entradas_previstas: 0,
        entradas_realizadas: 0,
        saidas_previstas: 0,
        saidas_realizadas: 0,
        saldo_previsto: 0,
        saldo_realizado: 0,
      });
    }
    return fluxoMap.get(d)!;
  };

  for (const cr of crData || []) {
    if (cr.data_vencimento) {
      const day = ensureDay(cr.data_vencimento);
      if (['A VENCER', 'ATRASADO', 'VENCE HOJE'].includes(cr.status_titulo)) {
        day.entradas_previstas += cr.valor_documento || 0;
      }
    }
    if (cr.data_recebimento) {
      const day = ensureDay(cr.data_recebimento);
      day.entradas_realizadas += cr.valor_recebido || 0;
    }
  }

  for (const cp of cpData || []) {
    if (cp.data_vencimento) {
      const day = ensureDay(cp.data_vencimento);
      if (['A VENCER', 'ATRASADO', 'VENCE HOJE'].includes(cp.status_titulo)) {
        day.saidas_previstas += cp.valor_documento || 0;
      }
    }
    if (cp.data_pagamento) {
      const day = ensureDay(cp.data_pagamento);
      day.saidas_realizadas += cp.valor_pago || 0;
    }
  }

  // Calcular saldos
  const result = Array.from(fluxoMap.values()).sort((a, b) =>
    a.data.localeCompare(b.data)
  );

  let acumPrevisto = 0;
  let acumRealizado = 0;
  for (const day of result) {
    acumPrevisto += day.entradas_previstas - day.saidas_previstas;
    acumRealizado += day.entradas_realizadas - day.saidas_realizadas;
    day.saldo_previsto = acumPrevisto;
    day.saldo_realizado = acumRealizado;
  }

  return result;
}

// ═══════════════ TOP INADIMPLENTES ═══════════════

export async function getTopInadimplentes(
  company: Company | 'all',
  limit = 10
): Promise<{ nome: string; cnpj: string; total_vencido: number; qtd_titulos: number }[]> {
  let query = supabase
    .from("fin_contas_receber")
    .select("nome_cliente, cnpj_cpf, valor_documento, valor_recebido")
    .eq("status_titulo", "ATRASADO") as any;

  if (company !== 'all') query = query.eq("company", company);

  const { data, error } = await query;
  if (error) return [];

  // Agrupar por cliente
  const map = new Map<string, { nome: string; cnpj: string; total: number; qtd: number }>();
  for (const r of data || []) {
    const key = r.cnpj_cpf || r.nome_cliente || 'Desconhecido';
    const saldo = (r.valor_documento || 0) - (r.valor_recebido || 0);
    const existing = map.get(key) || { nome: r.nome_cliente, cnpj: r.cnpj_cpf, total: 0, qtd: 0 };
    existing.total += saldo;
    existing.qtd += 1;
    map.set(key, existing);
  }

  return Array.from(map.values())
    .sort((a, b) => b.total - a.total)
    .slice(0, limit)
    .map(({ nome, cnpj, total, qtd }) => ({
      nome: nome || 'Desconhecido',
      cnpj: cnpj || '',
      total_vencido: total,
      qtd_titulos: qtd,
    }));
}

// ═══════════════ CAPITAL DE GIRO / WORKING CAPITAL ═══════════════

export interface CapitalDeGiro {
  company: string;
  // Posição
  total_cr_aberto: number;      // Contas a Receber em aberto
  total_cp_aberto: number;      // Contas a Pagar em aberto
  saldo_cc: number;             // Saldo bancário
  capital_giro: number;         // CR - CP
  capital_giro_liquido: number; // CR + CC - CP
  // Prazos médios (dias)
  pmr: number;                  // Prazo Médio de Recebimento
  pmp: number;                  // Prazo Médio de Pagamento
  ciclo_financeiro: number;     // PMR - PMP (positivo = necessidade de capital)
  // Concentração
  top5_cr_pct: number;          // % do CR nos 5 maiores clientes
  top5_cp_pct: number;          // % do CP nos 5 maiores fornecedores
  // Projeção 30 dias
  entradas_30d: number;
  saidas_30d: number;
  saldo_projetado_30d: number;
}

export async function getCapitalDeGiro(company: Company | 'all'): Promise<CapitalDeGiro[]> {
  const companies: Company[] = company === 'all'
    ? ['oben', 'colacor', 'colacor_sc']
    : [company];

  const results: CapitalDeGiro[] = [];
  const today = new Date().toISOString().slice(0, 10);
  const d30 = new Date();
  d30.setDate(d30.getDate() + 30);
  const in30 = d30.toISOString().slice(0, 10);

  for (const co of companies) {
    // CR aberto
    const { data: crAberto } = await supabase
      .from("fin_contas_receber")
      .select("valor_documento, valor_recebido, data_emissao, data_vencimento, nome_cliente")
      .eq("company", co)
      .in("status_titulo", ["A VENCER", "ATRASADO", "VENCE HOJE"]) as any;

    // CP aberto
    const { data: cpAberto } = await supabase
      .from("fin_contas_pagar")
      .select("valor_documento, valor_pago, data_emissao, data_vencimento, nome_fornecedor")
      .eq("company", co)
      .in("status_titulo", ["A VENCER", "ATRASADO", "VENCE HOJE"]) as any;

    // Saldo CC
    const { data: ccs } = await supabase
      .from("fin_contas_correntes")
      .select("saldo_atual")
      .eq("company", co)
      .eq("ativo", true) as any;

    // CR recebidos últimos 90 dias (para calcular PMR)
    const d90ago = new Date();
    d90ago.setDate(d90ago.getDate() - 90);
    const { data: crRecebidos } = await supabase
      .from("fin_contas_receber")
      .select("data_emissao, data_recebimento, valor_recebido")
      .eq("company", co)
      .in("status_titulo", ["RECEBIDO", "LIQUIDADO"])
      .gte("data_recebimento", d90ago.toISOString().slice(0, 10)) as any;

    // CP pagos últimos 90 dias (para calcular PMP)
    const { data: cpPagos } = await supabase
      .from("fin_contas_pagar")
      .select("data_emissao, data_pagamento, valor_pago")
      .eq("company", co)
      .in("status_titulo", ["PAGO", "LIQUIDADO"])
      .gte("data_pagamento", d90ago.toISOString().slice(0, 10)) as any;

    const calcSaldoCR = (arr: any[]) => (arr || []).reduce((s: number, r: any) => s + ((r.valor_documento || 0) - (r.valor_recebido || 0)), 0);
    const calcSaldoCP = (arr: any[]) => (arr || []).reduce((s: number, r: any) => s + ((r.valor_documento || 0) - (r.valor_pago || 0)), 0);
    const totalCR = calcSaldoCR(crAberto);
    const totalCP = calcSaldoCP(cpAberto);
    const totalCC = (ccs || []).reduce((s: number, c: any) => s + (c.saldo_atual || 0), 0);

    // PMR: média ponderada de dias entre emissão e recebimento
    let pmrNumerator = 0, pmrDenominator = 0;
    for (const r of crRecebidos || []) {
      if (r.data_emissao && r.data_recebimento && r.valor_recebido > 0) {
        const dias = Math.max(0, (new Date(r.data_recebimento).getTime() - new Date(r.data_emissao).getTime()) / 86400000);
        pmrNumerator += dias * r.valor_recebido;
        pmrDenominator += r.valor_recebido;
      }
    }
    const pmr = pmrDenominator > 0 ? Math.round(pmrNumerator / pmrDenominator) : 0;

    // PMP: média ponderada de dias entre emissão e pagamento
    let pmpNumerator = 0, pmpDenominator = 0;
    for (const p of cpPagos || []) {
      if (p.data_emissao && p.data_pagamento && p.valor_pago > 0) {
        const dias = Math.max(0, (new Date(p.data_pagamento).getTime() - new Date(p.data_emissao).getTime()) / 86400000);
        pmpNumerator += dias * p.valor_pago;
        pmpDenominator += p.valor_pago;
      }
    }
    const pmp = pmpDenominator > 0 ? Math.round(pmpNumerator / pmpDenominator) : 0;

    // Concentração top 5
    const crByClient = new Map<string, number>();
    for (const r of crAberto || []) {
      const key = r.nome_cliente || 'Outros';
      crByClient.set(key, (crByClient.get(key) || 0) + ((r.valor_documento || 0) - (r.valor_recebido || 0)));
    }
    const top5CR = Array.from(crByClient.values()).sort((a, b) => b - a).slice(0, 5);
    const top5CRSum = top5CR.reduce((s, v) => s + v, 0);

    const cpByFornecedor = new Map<string, number>();
    for (const p of cpAberto || []) {
      const key = p.nome_fornecedor || 'Outros';
      cpByFornecedor.set(key, (cpByFornecedor.get(key) || 0) + ((p.valor_documento || 0) - (p.valor_pago || 0)));
    }
    const top5CP = Array.from(cpByFornecedor.values()).sort((a, b) => b - a).slice(0, 5);
    const top5CPSum = top5CP.reduce((s, v) => s + v, 0);

    // Projeção 30 dias: CR vencendo nos próx 30d + CP vencendo nos próx 30d
    const entradas30 = (crAberto || [])
      .filter((r: any) => r.data_vencimento >= today && r.data_vencimento <= in30)
      .reduce((s: number, r: any) => s + ((r.valor_documento || 0) - (r.valor_recebido || 0)), 0);
    const saidas30 = (cpAberto || [])
      .filter((p: any) => p.data_vencimento >= today && p.data_vencimento <= in30)
      .reduce((s: number, p: any) => s + ((p.valor_documento || 0) - (p.valor_pago || 0)), 0);

    results.push({
      company: co,
      total_cr_aberto: totalCR,
      total_cp_aberto: totalCP,
      saldo_cc: totalCC,
      capital_giro: totalCR - totalCP,
      capital_giro_liquido: totalCR + totalCC - totalCP,
      pmr,
      pmp,
      ciclo_financeiro: pmr - pmp,
      top5_cr_pct: totalCR > 0 ? (top5CRSum / totalCR) * 100 : 0,
      top5_cp_pct: totalCP > 0 ? (top5CPSum / totalCP) * 100 : 0,
      entradas_30d: entradas30,
      saidas_30d: saidas30,
      saldo_projetado_30d: totalCC + entradas30 - saidas30,
    });
  }

  return results;
}

// ═══════════════ CATEGORY MAPPING ═══════════════

export interface FinCategoriaDREMapping {
  id: string;
  company: string;
  omie_codigo: string;
  dre_linha: string;
  notas: string | null;
}

export const DRE_LINHAS = [
  { value: 'receita_bruta', label: 'Receita Bruta', tipo: 'R' },
  { value: 'deducoes', label: '(-) Deduções', tipo: 'R' },
  { value: 'cmv', label: 'CMV', tipo: 'D' },
  { value: 'despesas_operacionais', label: 'Desp. Operacionais', tipo: 'D' },
  { value: 'despesas_administrativas', label: 'Desp. Administrativas', tipo: 'D' },
  { value: 'despesas_comerciais', label: 'Desp. Comerciais', tipo: 'D' },
  { value: 'despesas_financeiras', label: 'Desp. Financeiras', tipo: 'D' },
  { value: 'receitas_financeiras', label: 'Rec. Financeiras', tipo: 'R' },
  { value: 'outras_receitas', label: 'Outras Receitas', tipo: 'R' },
  { value: 'outras_despesas', label: 'Outras Despesas', tipo: 'D' },
  { value: 'impostos', label: 'Impostos', tipo: 'D' },
] as const;

export async function getCategoryMappings(
  company: Company | '_default'
): Promise<FinCategoriaDREMapping[]> {
  const { data, error } = await supabase
    .from("fin_categoria_dre_mapping" as any)
    .select("*")
    .in("company", company === '_default' ? ['_default'] : [company, '_default'])
    .order("omie_codigo", { ascending: true });

  if (error) throw error;
  return data || [];
}

export async function upsertCategoryMapping(
  mapping: Omit<FinCategoriaDREMapping, 'id'>
): Promise<void> {
  const { error } = await supabase
    .from("fin_categoria_dre_mapping" as any)
    .upsert(
      { ...mapping, updated_at: new Date().toISOString() },
      { onConflict: "company,omie_codigo" }
    );
  if (error) throw error;
}

export async function deleteCategoryMapping(id: string): Promise<void> {
  const { error } = await supabase
    .from("fin_categoria_dre_mapping" as any)
    .delete()
    .eq("id", id);
  if (error) throw error;
}

export async function getCategoriasOmie(company: Company): Promise<{
  omie_codigo: string;
  descricao: string;
  tipo: string;
}[]> {
  const { data, error } = await supabase
    .from("fin_categorias")
    .select("omie_codigo, descricao, tipo")
    .eq("company", company)
    .eq("ativo", true)
    .order("omie_codigo", { ascending: true }) as any;

  if (error) throw error;
  return data || [];
}

// ═══════════════ EXPORT CSV ═══════════════

function toCsvRow(values: (string | number)[]): string {
  return values
    .map(v => {
      const s = String(v ?? '');
      if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    })
    .join(',');
}

export function exportContasPagarCSV(data: FinContaPagar[]): string {
  const header = [
    'Empresa', 'Fornecedor', 'CNPJ/CPF', 'Documento', 'Emissão',
    'Vencimento', 'Pagamento', 'Valor', 'Pago', 'Saldo', 'Status', 'Categoria'
  ];
  const rows = data.map(cp => [
    cp.company, cp.nome_fornecedor, cp.cnpj_cpf, cp.numero_documento,
    cp.data_emissao || '', cp.data_vencimento || '', cp.data_pagamento || '',
    cp.valor_documento, cp.valor_pago, cp.saldo, cp.status_titulo,
    cp.categoria_descricao || cp.categoria_codigo
  ]);
  return [toCsvRow(header), ...rows.map(toCsvRow)].join('\n');
}

export function exportContasReceberCSV(data: FinContaReceber[]): string {
  const header = [
    'Empresa', 'Cliente', 'CNPJ/CPF', 'Documento', 'Pedido', 'Emissão',
    'Vencimento', 'Recebimento', 'Valor', 'Recebido', 'Saldo', 'Status', 'Categoria'
  ];
  const rows = data.map(cr => [
    cr.company, cr.nome_cliente, cr.cnpj_cpf, cr.numero_documento,
    cr.numero_pedido || '', cr.data_emissao || '', cr.data_vencimento || '',
    cr.data_recebimento || '', cr.valor_documento, cr.valor_recebido,
    cr.saldo, cr.status_titulo, cr.categoria_descricao || cr.categoria_codigo
  ]);
  return [toCsvRow(header), ...rows.map(toCsvRow)].join('\n');
}

export function exportDRECSV(data: FinDRE[]): string {
  const meses = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  const lines = [
    'receita_bruta', 'deducoes', 'receita_liquida', 'cmv', 'lucro_bruto',
    'despesas_operacionais', 'despesas_administrativas', 'despesas_comerciais',
    'despesas_financeiras', 'receitas_financeiras', 'resultado_operacional',
    'impostos', 'resultado_liquido'
  ];
  const header = ['Linha', ...data.map(d => `${meses[d.mes - 1]}/${d.ano}`)];
  const rows = lines.map(field => [
    field,
    ...data.map(d => (d as any)[field] || 0)
  ]);
  return [toCsvRow(header), ...rows.map(toCsvRow)].join('\n');
}

export function downloadCSV(content: string, filename: string): void {
  // BOM for Excel UTF-8
  const bom = '\uFEFF';
  const blob = new Blob([bom + content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ═══════════════ LAST SYNC ═══════════════

export async function getLastSyncTime(): Promise<string | null> {
  // Check most recent updated_at across financial tables
  const tables = ['fin_contas_receber', 'fin_contas_pagar', 'fin_movimentacoes'] as const;
  let latest: string | null = null;

  for (const table of tables) {
    const { data } = await supabase
      .from(table as any)
      .select('updated_at')
      .order('updated_at', { ascending: false })
      .limit(1);

    if (data?.[0]?.updated_at) {
      if (!latest || data[0].updated_at > latest) {
        latest = data[0].updated_at;
      }
    }
  }

  return latest;
}
