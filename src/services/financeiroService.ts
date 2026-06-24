import { supabase } from "@/integrations/supabase/client";
import type { Company } from "@/contexts/CompanyContext";
import { agregarRealizadoPorDia } from "@/lib/financeiro/fluxo-realizado-helpers";
import { janelaTTM, calcularDsoDpo, type DsoDpoResult } from "@/lib/financeiro/dso-dpo-helpers";
import { OPEN_TITLE_STATUSES } from "@/lib/financeiro/titulo-status";
import { spBusinessDate } from "@/lib/time/sp-day";
import type {
  FinAgingPagarView,
  FinAgingReceberView,
} from "./financeiroTypes";

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
  regime: 'caixa' | 'competencia';
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
    categorias_nao_mapeadas?: string[];
    // Onda 3a — sub-linhas de imposto regime-aware + confiança + flag de caixa estimado
    impostos?: Partial<Record<'ded_icms' | 'ded_iss' | 'ded_pis' | 'ded_cofins' | 'ded_ipi' | 'das' | 'irpj' | 'csll', number>>;
    regime_tributario?: 'simples' | 'presumido';
    caixa_estimado?: boolean;
    confianca?: { nivel: 'alta' | 'media' | 'baixa'; motivos: string[]; pct_mapeado_valor: number; fallback_pct: number };
    imposto_teorico?: Record<string, number | null> | null;
    delta_imposto_pct?: number | null;
    config_tributaria_completa?: boolean;
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

const EMPTY_AGING: AgingData = {
  a_vencer_qtd: 0,
  a_vencer_valor: 0,
  vencido_1_30_qtd: 0,
  vencido_1_30_valor: 0,
  vencido_31_60_qtd: 0,
  vencido_31_60_valor: 0,
  vencido_61_90_qtd: 0,
  vencido_61_90_valor: 0,
  vencido_90_plus_qtd: 0,
  vencido_90_plus_valor: 0,
};

const AGING_KEYS = Object.keys(EMPTY_AGING) as (keyof AgingData)[];

type AgingViewRow = FinAgingPagarView | FinAgingReceberView;

// Both aging views share the same numeric columns; this helper consolidates
// nullable view rows into the strict AgingData shape.
function consolidateAging(rows: AgingViewRow[]): AgingData {
  const out: AgingData = { ...EMPTY_AGING };
  for (const row of rows) {
    for (const key of AGING_KEYS) {
      out[key] += row[key] ?? 0;
    }
  }
  return out;
}

function pickAgingForCompany(rows: AgingViewRow[], company: Company): AgingData {
  const row = rows.find((r) => r.company === company);
  if (!row) return { ...EMPTY_AGING };
  const out: AgingData = { ...EMPTY_AGING };
  for (const key of AGING_KEYS) {
    out[key] = row[key] ?? 0;
  }
  return out;
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

// Vencidos = só 'ATRASADO' (vocabulário nativo do Omie; subconjunto de OPEN_TITLE_STATUSES).
const VENCIDO_TITLE_STATUSES = ['ATRASADO'] as const;

type PaginaResult<T> = { data: T[] | null; error: { message: string } | null };

/**
 * Busca TODAS as linhas de uma query paginando em janelas de 1000 — sem
 * `.range()` o PostgREST capa em 1000 linhas e tudo que deriva delas sai
 * truncado silenciosamente (bug #719/#720; a oben tem ~11k títulos de CR
 * aberto). Para somas puras use somarSaldoPorStatus; este helper é pra quando
 * as LINHAS individuais importam (vencimento pra projeção, nome pra ranking).
 * O callback DEVE aplicar `.order()` estável (id) + `.range(from, to)`: offset
 * sem ORDER BY pula/duplica linha entre páginas (o sync de CR/CP grava a cada
 * 10min). Erro de qualquer página LANÇA Error real — nunca lista parcial.
 * ⚠️ Limitação conhecida (codex, pós-#722): a leitura paginada NÃO é snapshot —
 * se o sync gravar ENTRE as páginas de uma mesma leitura, uma linha pode ser
 * pulada/duplicada (distorção transitória de 1 refresh; autocorrige no load
 * seguinte). Aceito: a janela é de segundos a cada load vs sync a cada ~10min,
 * e o erro residual é ínfimo perto do truncamento de 90% que este helper
 * corrige. Consolidação atômica = RPC SQL agregada (evolução, se virar dor).
 */
async function buscarTodasPaginas<T>(
  contexto: string,
  fetchPage: (from: number, to: number) => PromiseLike<PaginaResult<T>>,
): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await fetchPage(from, from + PAGE - 1);
    if (error) throw new Error(`Falha ao carregar ${contexto}: ${error.message}`);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

export async function getResumoFinanceiro(companies: Company[]): Promise<Record<string, FinResumo>> {
  const resumo: Record<string, FinResumo> = {};

  for (const company of companies) {
    // Saldos CC — erro LANÇA: caixa R$0 falso engana tanto quanto total truncado
    const { data: contas, error: ccError } = await supabase
      .from("fin_contas_correntes")
      .select("descricao, saldo_atual, banco")
      .eq("company", company)
      .eq("ativo", true);
    if (ccError) throw new Error(`Falha ao carregar contas correntes (${company}): ${ccError.message}`);

    // Abertos + vencidos: soma paginada do `saldo` — o reduce client-side sem
    // .range() somava só a 1ª página de 1000 do PostgREST (oben tem ~11k títulos
    // de CR aberto → totais truncados; mesmo bug do KPI de /financeiro/gestao, #719).
    const [totalAReceber, totalAPagar, vencidoReceber, vencidoPagar] = await Promise.all([
      somarSaldoAberto("fin_contas_receber", company),
      somarSaldoAberto("fin_contas_pagar", company),
      somarSaldoPorStatus("fin_contas_receber", company, VENCIDO_TITLE_STATUSES),
      somarSaldoPorStatus("fin_contas_pagar", company, VENCIDO_TITLE_STATUSES),
    ]);

    const contasNorm = (contas || []).map((c) => ({
      descricao: c.descricao ?? "",
      saldo_atual: c.saldo_atual ?? 0,
      banco: c.banco ?? "",
    }));

    resumo[company] = {
      contas_correntes: contasNorm,
      saldo_total_cc: contasNorm.reduce((s, c) => s + c.saldo_atual, 0),
      total_a_receber: totalAReceber,
      total_a_pagar: totalAPagar,
      total_vencido_receber: vencidoReceber,
      total_vencido_pagar: vencidoPagar,
      posicao_liquida: totalAReceber - totalAPagar,
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
    .order("data_vencimento", { ascending: true });

  if (company !== 'all') query = query.eq("company", company);
  if (filtros?.status) query = query.eq("status_titulo", filtros.status);
  if (filtros?.dataInicio) query = query.gte("data_vencimento", filtros.dataInicio);
  if (filtros?.dataFim) query = query.lte("data_vencimento", filtros.dataFim);
  if (filtros?.limit) query = query.limit(filtros.limit);

  const { data, error } = await query;
  if (error) throw error;
  return (data || []) as unknown as FinContaPagar[];
}

export async function getContasReceber(
  company: Company | 'all',
  filtros?: { status?: string; dataInicio?: string; dataFim?: string; limit?: number }
): Promise<FinContaReceber[]> {
  let query = supabase
    .from("fin_contas_receber")
    .select("*")
    .order("data_vencimento", { ascending: true });

  if (company !== 'all') query = query.eq("company", company);
  if (filtros?.status) query = query.eq("status_titulo", filtros.status);
  if (filtros?.dataInicio) query = query.gte("data_vencimento", filtros.dataInicio);
  if (filtros?.dataFim) query = query.lte("data_vencimento", filtros.dataFim);
  if (filtros?.limit) query = query.limit(filtros.limit);

  const { data, error } = await query;
  if (error) throw error;
  return (data || []) as unknown as FinContaReceber[];
}

export async function getAgingReceber(company: Company | 'all'): Promise<AgingData> {
  const { data, error } = await supabase
    .from("fin_aging_receber")
    .select("*");

  if (error || !data) return { ...EMPTY_AGING };
  if (company === 'all') return consolidateAging(data);
  return pickAgingForCompany(data, company);
}

export async function getAgingPagar(company: Company | 'all'): Promise<AgingData> {
  const { data, error } = await supabase
    .from("fin_aging_pagar")
    .select("*");

  if (error || !data) return { ...EMPTY_AGING };
  if (company === 'all') return consolidateAging(data);
  return pickAgingForCompany(data, company);
}

export async function getDRE(
  company: Company,
  ano: number,
  meses?: number[],
  regime: 'caixa' | 'competencia' = 'competencia'
): Promise<FinDRE[]> {
  let query = supabase
    .from("fin_dre_snapshots")
    .select("*")
    .eq("company", company)
    .eq("ano", ano)
    .eq("regime", regime)
    .order("mes", { ascending: true });

  if (meses && meses.length > 0) {
    query = query.in("mes", meses);
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data || []) as unknown as FinDRE[];
}

export async function getDREConsolidado(
  companies: Company[],
  ano: number,
  meses?: number[],
  regime: 'caixa' | 'competencia' = 'competencia'
): Promise<Record<string, FinDRE[]>> {
  const result: Record<string, FinDRE[]> = {};
  for (const co of companies) {
    result[co] = await getDRE(co, ano, meses, regime);
  }
  return result;
}

export async function getFluxoCaixa(
  company: Company | 'all',
  dataInicio: string,
  dataFim: string
): Promise<FluxoCaixaDiario[]> {
  // Buscar CR e CP para projetar fluxo
  let crQuery = supabase
    .from("fin_contas_receber")
    .select("data_vencimento, data_recebimento, valor_documento, valor_recebido, status_titulo")
    .gte("data_vencimento", dataInicio)
    .lte("data_vencimento", dataFim);

  let cpQuery = supabase
    .from("fin_contas_pagar")
    .select("data_vencimento, data_pagamento, valor_documento, valor_pago, status_titulo")
    .gte("data_vencimento", dataInicio)
    .lte("data_vencimento", dataFim);

  if (company !== 'all') {
    crQuery = crQuery.eq("company", company);
    cpQuery = cpQuery.eq("company", company);
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
      if (cr.status_titulo && ['A VENCER', 'ATRASADO', 'VENCE HOJE'].includes(cr.status_titulo)) {
        day.entradas_previstas += cr.valor_documento || 0;
      }
    }
  }

  for (const cp of cpData || []) {
    if (cp.data_vencimento) {
      const day = ensureDay(cp.data_vencimento);
      if (cp.status_titulo && ['A VENCER', 'ATRASADO', 'VENCE HOJE'].includes(cp.status_titulo)) {
        day.saidas_previstas += cp.valor_documento || 0;
      }
    }
  }

  // Realizado: caixa que de fato entrou/saiu por dia (fin_movimentacoes).
  // A baixa-do-título (data_recebimento/data_pagamento) está sempre NULL — o
  // Omie não manda no endpoint LIST. Paginação manual: PostgREST capa em 1000
  // linhas e a janela pode passar disso.
  const movimentos: Array<{ data_movimento: string; tipo: string | null; valor: number; omie_codigo_lancamento: number | null }> = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let movQuery = supabase
      .from('fin_movimentacoes')
      .select('data_movimento, tipo, valor, omie_codigo_lancamento')
      .gte('data_movimento', dataInicio)
      .lte('data_movimento', dataFim)
      .order('data_movimento', { ascending: true })
      .range(from, from + PAGE - 1);
    if (company !== 'all') movQuery = movQuery.eq('company', company);
    const { data: page } = await movQuery;
    if (!page || page.length === 0) break;
    movimentos.push(...page);
    if (page.length < PAGE) break;
  }

  const realizadoPorDia = agregarRealizadoPorDia(movimentos);
  for (const [dia, r] of realizadoPorDia) {
    const day = ensureDay(dia);
    day.entradas_realizadas += r.entradas;
    day.saidas_realizadas += r.saidas;
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
  // Linhas individuais (o ranking precisa de nome/cnpj por título), paginadas:
  // truncado em 1000 pelo PostgREST, um devedor grande "depois" da 1ª página
  // sumia do top. Erro LANÇA (era [] silencioso = falso "ninguém inadimplente").
  const data = await buscarTodasPaginas(`inadimplentes (${company})`, (from, to) => {
    let query = supabase
      .from("fin_contas_receber")
      .select("nome_cliente, cnpj_cpf, saldo")
      .in("status_titulo", [...VENCIDO_TITLE_STATUSES]);
    if (company !== 'all') query = query.eq("company", company);
    return query.order("id").range(from, to);
  });

  // Agrupar por cliente (nome_cliente como chave primária; cnpj_cpf como fallback)
  const map = new Map<string, { nome: string; cnpj: string; total: number; qtd: number }>();
  for (const r of data) {
    const nomeRaw = (r.nome_cliente ?? '').trim();
    const cnpjRaw = (r.cnpj_cpf ?? '').trim();
    const key = nomeRaw || cnpjRaw || '__unknown__';
    const displayNome = nomeRaw
      || (cnpjRaw ? `CNPJ: ${cnpjRaw}` : 'Cliente não identificado');
    // `saldo` é coluna gerada (documento − recebido) — mesma fonte do resumo (#720).
    const saldo = r.saldo ?? 0;
    const existing = map.get(key) || {
      nome: displayNome,
      cnpj: cnpjRaw,
      total: 0,
      qtd: 0,
    };
    existing.total += saldo;
    existing.qtd += 1;
    map.set(key, existing);
  }

  return Array.from(map.values())
    .sort((a, b) => b.total - a.total)
    .slice(0, limit)
    .map(({ nome, cnpj, total, qtd }) => ({
      nome: nome || 'Cliente não identificado',
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
  // Prazos médios (dias). NULL = sem dado de baixa (data_recebimento/pagamento NULL no
  // sync → não dá pra calcular). Antes era 0, que parecia "conversão instantânea" e
  // enganava o CFO. UI mostra "—/sem dados" quando null. Ver §10 (auditoria 2026-05-27).
  pmr: number | null;           // Prazo Médio de Recebimento
  pmp: number | null;           // Prazo Médio de Pagamento
  ciclo_financeiro: number | null; // PMR - PMP (positivo = necessidade de capital)
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
  // Janela no dia de SÃO PAULO, não UTC (codex, pós-#722): com toISOString(),
  // das ~21h às 24h locais o "hoje" já era amanhã → a projeção 30d excluía os
  // vencimentos de HOJE e incluía um 31º dia. Mesmo bug de fuso do #550;
  // data_vencimento é DATE de negócio → compara com a data-calendário de SP.
  const today = spBusinessDate(new Date());
  const in30 = spBusinessDate(new Date(Date.now() + 30 * 86400000));

  for (const co of companies) {
    // CR/CP abertos: linhas individuais (vencimento pra projeção 30d + nome pro
    // top-5 — soma pura seria somarSaldoPorStatus) paginadas: sem .range() o
    // PostgREST capa em 1000 e totais/concentração/projeção saíam truncados
    // (irmão do #719/#720). `saldo` é coluna gerada (documento − recebido/pago)
    // — mesma fonte do resumo, então total_cr/cp_aberto bate com o cockpit.
    const [crAberto, cpAberto] = await Promise.all([
      buscarTodasPaginas(`CR aberto (${co})`, (from, to) =>
        supabase
          .from("fin_contas_receber")
          .select("saldo, data_vencimento, nome_cliente")
          .eq("company", co)
          .in("status_titulo", [...OPEN_TITLE_STATUSES])
          .order("id")
          .range(from, to),
      ),
      buscarTodasPaginas(`CP aberto (${co})`, (from, to) =>
        supabase
          .from("fin_contas_pagar")
          .select("saldo, data_vencimento, nome_fornecedor")
          .eq("company", co)
          .in("status_titulo", [...OPEN_TITLE_STATUSES])
          .order("id")
          .range(from, to),
      ),
    ]);

    // Saldo CC — erro LANÇA: caixa R$0 falso engana tanto quanto total truncado
    const { data: ccs, error: ccError } = await supabase
      .from("fin_contas_correntes")
      .select("saldo_atual")
      .eq("company", co)
      .eq("ativo", true);
    if (ccError) throw new Error(`Falha ao carregar contas correntes (${co}): ${ccError.message}`);

    // PMR/PMP: baixa derivada das movimentações (view v_capital_giro_prazos), porque
    // o Omie NÃO traz data de baixa no LIST de títulos (data_recebimento/pagamento
    // sempre NULL — ver v_titulo_baixas). A view agrega PMR/PMP ponderado por valor +
    // a cobertura (fração dos liquidados com baixa derivável) por empresa.
    const COBERTURA_MIN = 0.4;
    // view nova ainda não nos tipos gerados → `as never` (padrão do repo p/ views).
    // Erro aqui NÃO lança (≠ CR/CP/CC): prazo é acessório e null = "—" na UI,
    // que é degradação honesta — não fabrica número.
    const { data: prazos } = await supabase
      .from("v_capital_giro_prazos" as never)
      .select("pmr, pmp, pmr_cobertura, pmp_cobertura")
      .eq("company", co)
      .maybeSingle();

    const totalCR = crAberto.reduce((s, r) => s + (r.saldo ?? 0), 0);
    const totalCP = cpAberto.reduce((s, r) => s + (r.saldo ?? 0), 0);
    const totalCC = (ccs || []).reduce((s, c) => s + (c.saldo_atual || 0), 0);

    // Gate de confiança por empresa: prazo só quando a cobertura é suficiente.
    // Cobertura baixa → NULL (= "—", degradação honesta) pra não mostrar o prazo de
    // uma amostra não-representativa (ex: colacor ~9% — liquida sem movimento `mf`).
    // oben/sc têm ~100% → mostram PMR/PMP reais. NULL (não 0) evita o falso
    // "recebimento instantâneo".
    const p = (prazos ?? {}) as { pmr?: number | null; pmp?: number | null; pmr_cobertura?: number | null; pmp_cobertura?: number | null };
    const pmr = Number(p.pmr_cobertura ?? 0) >= COBERTURA_MIN && p.pmr != null ? Number(p.pmr) : null;
    const pmp = Number(p.pmp_cobertura ?? 0) >= COBERTURA_MIN && p.pmp != null ? Number(p.pmp) : null;

    // Concentração top 5
    const crByClient = new Map<string, number>();
    for (const r of crAberto) {
      const key = r.nome_cliente || 'Outros';
      crByClient.set(key, (crByClient.get(key) || 0) + (r.saldo ?? 0));
    }
    const top5CR = Array.from(crByClient.values()).sort((a, b) => b - a).slice(0, 5);
    const top5CRSum = top5CR.reduce((s, v) => s + v, 0);

    const cpByFornecedor = new Map<string, number>();
    for (const p of cpAberto) {
      const key = p.nome_fornecedor || 'Outros';
      cpByFornecedor.set(key, (cpByFornecedor.get(key) || 0) + (p.saldo ?? 0));
    }
    const top5CP = Array.from(cpByFornecedor.values()).sort((a, b) => b - a).slice(0, 5);
    const top5CPSum = top5CP.reduce((s, v) => s + v, 0);

    // Projeção 30 dias: CR vencendo nos próx 30d + CP vencendo nos próx 30d
    const entradas30 = crAberto
      .filter((r) => r.data_vencimento && r.data_vencimento >= today && r.data_vencimento <= in30)
      .reduce((s, r) => s + (r.saldo ?? 0), 0);
    const saidas30 = cpAberto
      .filter((p) => p.data_vencimento && p.data_vencimento >= today && p.data_vencimento <= in30)
      .reduce((s, p) => s + (p.saldo ?? 0), 0);

    results.push({
      company: co,
      total_cr_aberto: totalCR,
      total_cp_aberto: totalCP,
      saldo_cc: totalCC,
      capital_giro: totalCR - totalCP,
      capital_giro_liquido: totalCR + totalCC - totalCP,
      pmr,
      pmp,
      ciclo_financeiro: pmr !== null && pmp !== null ? pmr - pmp : null,
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
    .from("fin_categoria_dre_mapping")
    .select("*")
    .in("company", company === '_default' ? ['_default'] : [company, '_default'])
    .order("omie_codigo", { ascending: true });

  if (error) throw error;
  return (data || []).map((row) => ({
    id: row.id,
    company: row.company,
    omie_codigo: row.omie_codigo,
    dre_linha: row.dre_linha,
    notas: row.notas,
  }));
}

export async function upsertCategoryMapping(
  mapping: Omit<FinCategoriaDREMapping, 'id'>
): Promise<void> {
  const { error } = await supabase
    .from("fin_categoria_dre_mapping")
    .upsert(
      { ...mapping, updated_at: new Date().toISOString() },
      { onConflict: "company,omie_codigo" }
    );
  if (error) throw error;
}

export async function deleteCategoryMapping(id: string): Promise<void> {
  const { error } = await supabase
    .from("fin_categoria_dre_mapping")
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
    .order("omie_codigo", { ascending: true });

  if (error) throw error;
  return (data || []).map((c) => ({
    omie_codigo: c.omie_codigo,
    descricao: c.descricao,
    tipo: c.tipo ?? '',
  }));
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
  const lines: (keyof FinDRE)[] = [
    'receita_bruta', 'deducoes', 'receita_liquida', 'cmv', 'lucro_bruto',
    'despesas_operacionais', 'despesas_administrativas', 'despesas_comerciais',
    'despesas_financeiras', 'receitas_financeiras', 'resultado_operacional',
    'impostos', 'resultado_liquido'
  ];
  const header = ['Linha', ...data.map(d => `${meses[d.mes - 1]}/${d.ano}`)];
  const rows = lines.map(field => [
    field as string,
    ...data.map(d => {
      const v = d[field];
      return typeof v === 'number' ? v : 0;
    })
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
      .from(table)
      .select('updated_at')
      .order('updated_at', { ascending: false })
      .limit(1);

    const updatedAt = data?.[0]?.updated_at;
    if (updatedAt) {
      if (!latest || updatedAt > latest) {
        latest = updatedAt;
      }
    }
  }

  return latest;
}

// ═══════════════ Lente contábil agregada — DSO/DPO (colacor) ═══════════════

/**
 * Soma paginada do `saldo` dos títulos da empresa nos `statuses` pedidos
 * (robusto vs cap 1000 do PostgREST). `saldo` é coluna GERADA
 * (valor_documento − COALESCE(valor_recebido/pago, 0)) — equivalente à
 * subtração client-side, sem depender de baixar as duas colunas.
 * Pagina ORDENADO por id: offset sem ORDER BY não é estável entre páginas
 * (o sync de CR/CP grava a cada 10min → linha pulada/duplicada silenciosa).
 * Erro de qualquer página LANÇA Error real — nunca soma parcial silenciosa,
 * e os consumidores exibem `e.message` (objeto cru viraria "[object Object]").
 * Contrato travado em src/services/__tests__/somarSaldoAberto.test.ts.
 */
export async function somarSaldoPorStatus(
  tabela: 'fin_contas_receber' | 'fin_contas_pagar',
  company: Company,
  statuses: readonly string[],
): Promise<number> {
  const PAGE = 1000;
  let from = 0;
  let total = 0;
  for (;;) {
    const { data, error } = await supabase
      .from(tabela)
      .select('saldo')
      .eq('company', company)
      .in('status_titulo', [...statuses])
      .order('id')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Falha ao somar saldo (${tabela}/${company}): ${error.message}`);
    const rows = (data ?? []) as Array<{ saldo: number | null }>;
    for (const r of rows) total += r.saldo ?? 0;
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return total;
}

/**
 * Soma paginada do `saldo` dos títulos EM ABERTO (OPEN_TITLE_STATUSES). Fonte
 * canônica de "total a receber/pagar aberto": consumida pelo DSO
 * (getDsoDpoColacor), pelos KPIs de /financeiro/gestao e pelo getResumoFinanceiro.
 */
export async function somarSaldoAberto(
  tabela: 'fin_contas_receber' | 'fin_contas_pagar',
  company: Company,
): Promise<number> {
  return somarSaldoPorStatus(tabela, company, OPEN_TITLE_STATUSES);
}

/**
 * DSO/DPO contábil agregado (point-in-time) do colacor — alternativa honesta ao
 * PMR/PMP title-based (que fica em "—" pro colacor: liquida em lote, cobertura de
 * baixa ~10%). NÃO usa data de baixa: saldo aberto de hoje ÷ fluxo do DRE TTM.
 * Metodologia/degradação no helper. Client-side (sem edge/migration). Colacor-only (v1).
 */
export async function getDsoDpoColacor(hoje: Date = new Date()): Promise<DsoDpoResult> {
  const company: Company = 'colacor';
  const { pares, diasPeriodo, periodoLabel } = janelaTTM(hoje);

  // DRE competência TTM: getDRE recebe 1 ano por chamada → agrupa os pares por ano.
  const anos = Array.from(new Set(pares.map((p) => p.ano)));
  let receitaBrutaTTM = 0;
  let cmvTTM = 0;
  let mesesFechados = 0;
  for (const ano of anos) {
    const meses = pares.filter((p) => p.ano === ano).map((p) => p.mes);
    const dre = await getDRE(company, ano, meses, 'competencia');
    for (const row of dre) {
      receitaBrutaTTM += row.receita_bruta ?? 0;
      cmvTTM += row.cmv ?? 0;
      mesesFechados += 1;
    }
  }

  const [arAberto, apAberto] = await Promise.all([
    somarSaldoAberto('fin_contas_receber', company),
    somarSaldoAberto('fin_contas_pagar', company),
  ]);

  return calcularDsoDpo({
    arAberto,
    apAberto,
    receitaBrutaTTM,
    cmvTTM,
    mesesFechados,
    diasPeriodo,
    periodoLabel,
  });
}

// ═══════════════ A2 — Retorno & Valor (contrato com fin-valor-engine) ═══════════════

export interface ValorKeDecomposto {
  ancora: number;
  premio_risco_equity: number;
  premio_tamanho_private: number;
  premio_iliquidez_controle: number;
}

export interface ValorInputs {
  ativo_fixo?: { valor: number; data_ref: string | null; fonte: 'book' | 'avaliacao' | 'reposicao' | 'seguro' | null; base: 'reposicao' | 'book' | null; operacional: boolean } | null;
  ajustes?: number;
  divida?: number | null;
  equity?: number | null;
  kd?: number | null;
  ke?: { conservador?: ValorKeDecomposto; base?: ValorKeDecomposto; agressivo?: ValorKeDecomposto };
  prolabore_real_mensal?: number | null;
  prolabore_mercado_mensal?: number | null;
  aluguel_mercado_mensal?: number | null;
  intercompany_giro?: number | null;
}

export interface ValorEmpresaResult {
  company: string;
  regime: 'simples' | 'presumido';
  ttm: { ano_mes_fim: string; meses: number; tem_anterior: boolean };
  reportado: {
    ebit: number; nopat: number; imposto_operacional_nopat: number; carga_tributaria_regime_total: number;
    margem_operacional_pre_imposto: number; receita_liquida_ttm: number;
    capital_investido: number | null; capital_giro: number | null; ativo_fixo: number; ajustes: number; capital_parcial: boolean;
    giro_indisponivel: boolean; giro_snapshot_at: string | null; giro_dias: number | null;
    roic: number | null; wacc: number | null; spread: number | null; eva: number | null;
    roic_incremental: number | null;
    incremental: { delta_nopat: number | null; delta_capital: number | null; aviso: string | null };
    wacc_cenarios: { conservador: number | null; base: number | null; agressivo: number | null };
    peso_divida: number | null; peso_equity: number | null;
  };
  normalizado: {
    ebit: number; nopat: number; capital_investido: number | null;
    roic: number | null; spread: number | null; eva: number | null;
    ajuste_prolabore: number; ajuste_aluguel: number; ajuste_intercompany_capital: number; aplicado: boolean;
    nopat_aproximado: boolean;
  };
  confianca: { nivel: 'alta' | 'media' | 'baixa'; motivos: string[]; roic_disponivel: boolean; wacc_disponivel: boolean; eva_disponivel: boolean; normalizado_disponivel: boolean };
  motivos: string[];
  valor_inputs: ValorInputs;
}

// ═══════════════ A3 — Cockpit de Valor (contrato com fin-valor-cockpit) ═══════════════
export interface CockpitConfig {
  margem_minima_pct: number;
  desconto_max_pct: number;
  prazo_alvo_dias: number;
  dias_estoque_max: number;
  sample_min_receita: number;
}
export interface CockpitRecomendacao {
  acao: string;
  motivo: string;
  impacto_rs: number | null;
}
// evp = número AFIRMÁVEL (real + teto≤0 mantido; exclui teto>0 omitido). evp_teto = upper bound (todos os
// tetos). evp_incompleto = grupo tem fatia de EVP omitida por capital parcial (otimista) → o evp pode ser maior.
export interface CockpitRollupCliente {
  cliente: string;
  receita: number;
  cm: number | null;
  encargo: number | null;
  encargo_total: number | null;
  evp: number | null;
  evp_teto: number | null;
  evp_incompleto: boolean;
  perda_garantida: boolean;
  cm_incompleto: boolean;
  qtd_combos_sensiveis: number;  // combos REAIS frágeis ao hurdle (break-even na banda 25-35%)
  nome?: string | null;  // nome do cliente (profiles via customer_user_id) — UI mostra no lugar do código
}
export interface CockpitRollupSKU {
  sku: string;
  quantidade: number;
  receita: number;
  cm: number | null;
  encargo: number | null;
  encargo_total: number | null;
  evp: number | null;
  evp_teto: number | null;
  evp_incompleto: boolean;
  perda_garantida: boolean;
  cm_incompleto: boolean;
  qtd_combos_sensiveis: number;  // combos REAIS frágeis ao hurdle (break-even na banda 25-35%)
  descricao?: string | null;  // descrição do produto (omie_products) — UI mostra no lugar do código SKU
}
// Empresa DECOMPOSTA (capital parcial → um único evp seria mentira contábil; Codex 2026-06-23).
export interface CockpitEmpresaEVP {
  receita: number;
  cm: number | null;
  encargo: number | null;
  encargo_total: number | null;
  evp_conhecido: number | null;       // só capital completo (afirmável)
  evp_teto_total: number | null;      // upper bound de todas as células
  evp_perda_garantida: number | null; // Σ tetos ≤0 (piso de perda da fatia parcial-negativa)
  evp: number | null;                 // null se há qualquer fatia omitida/indisponível (não finge total)
  evp_incompleto: boolean;
  perda_garantida: boolean;
  cm_incompleto: boolean;
  qtd_combos_sensiveis: number;     // combos REAIS no fio da navalha (granularidade que o agregado robusto esconde)
  capital_conhecido: number | null; // Σ capital das células reais → deriva EVP a outros hurdles
}
export interface ValorCockpitResult {
  company: string;
  k: number | null;                 // hurdle (Ke); null quando ausente/inválido (não fabricado)
  hurdle_indisponivel?: boolean;    // sem Ke → EVP/encargo indisponíveis
  ttm: { inicio: string; fim: string };
  vazio?: boolean;
  motivo?: string;
  porCliente: CockpitRollupCliente[];
  porSKU: CockpitRollupSKU[];
  empresa: CockpitEmpresaEVP;
  recomendacoesCliente: Array<{ cliente: string; recomendacoes: CockpitRecomendacao[] }>;
  confianca: { nivel: 'alta' | 'media' | 'baixa'; motivos: string[] };
  cobertura_receita: number;
  cobertura_app_por_ar?: number;
  // pcts [0,1] por receita total elegível (transparência da omissão honesta do EVP otimista).
  evp_conhecido_receita_pct?: number;
  evp_omitido_otimista_receita_pct?: number;
  evp_perda_garantida_receita_pct?: number;
  sem_cm_receita_pct?: number;
  hurdle_banda?: { base: number; lo: number; hi: number } | null; // banda da sensibilidade (lo/base/hi → 25/30/35%)
  config: CockpitConfig;
}

// ═══════════════ A4 — Próxima Melhor Ação (contrato com fin-next-best-action) ═══════════════
export type StatusAcaoFila = 'financiar_ja' | 'financiar_condicional' | 'consertar_antes' | 'falta_dado' | 'nao_financiar';
export type TipoAcaoFila = 'consertar_valor' | 'liberar_caixa' | 'crescer' | 'benchmark';
export interface AcaoFila {
  empresa: string;
  descricao: string;
  tipo: TipoAcaoFila;
  impacto_eva: number | null;
  caixa_consumido: number | null;
  payback_meses: number | null;
  spread_positivo: boolean | null;
  confianca: 'alta' | 'media' | 'baixa';
  hurdle: number | null;
  status: StatusAcaoFila;
}
export interface ProximaAcaoResult {
  fila: AcaoFila[];
  caixa_por_empresa: Record<string, { disponivel: number; confianca: 'alta' | 'media' | 'baixa' }>;
  confianca: { nivel: 'alta' | 'media' | 'baixa'; motivos: string[] };
  gerado_em: string;
}

// ═══════════════ Custo Marginal de Funding (contrato com fin-funding) ═══════════════
import type { DecisaoTitulo, PlanoCobertura } from '@/lib/financeiro/funding-helpers';

export interface FundingInputs {
  fontes: {
    antecipacao: {
      taxa_desconto_mensal_perc: number;
      tarifa_fixa: number;
      tipo: 'desconto' | 'factoring';
      coobrigacao: boolean;
      ativo: boolean;
    };
    capital_giro: {
      cet_anual_perc: number;
      ativo: boolean;
    };
    cheque_especial: {
      cet_anual_perc: number;
      ativo: boolean;
    };
  };
  reserva_dias_min: number;
  gap_estrutural_semanas_min: number;
}

export interface FundingResult {
  company: string;
  gerado_em: string;
  cm_anual: number | null;
  tem_projecao: boolean;
  estrutural: boolean;
  reserva_rs: number;
  titulos: DecisaoTitulo[];
  confianca: { nivel: 'alta' | 'media' | 'baixa'; motivos: string[] };
  // sub-PR B: planejador de cobertura de gap + composição A4.
  caixa_livre: number | null;
  retorno_marginal: number | null;
  plano_cobertura: PlanoCobertura | null;
}

// ═══════════════ Otimizador Tributário — Comparador de Regime (contrato com fin-regime-tributario) ═══════════════
export type RegimeNome = 'simples' | 'presumido' | 'real';
export type StatusElegibilidade = 'elegivel' | 'sublimite_excedido' | 'inelegivel';
export type StatusRecomendacao = 'recomenda' | 'empate_tecnico' | 'manter' | 'incompleto';

export interface RegimeInputs {
  folha_cpp_anual: number | null;
  massa_fator_r_anual: number | null;
  encargo_patronal_pct: number | null;
  presuncao_irpj: number | null;
  presuncao_csll: number | null;
  credito_pis_cofins_estimado: number | null;
  receita_tributavel_pis_cofins_pct: number | null;
  anexo_simples: 'I' | 'II' | 'III' | 'IV' | 'V' | null;
}

export interface RegimeComparado {
  regime: RegimeNome;
  elegivel: boolean;
  status_elegibilidade: StatusElegibilidade;
  motivo_inelegivel: string | null;
  total_federal_cpp: number;
  aliquota_efetiva: number | null;
  detalhe: Record<string, number>;
  aproximado: boolean;
  flags: string[];
}

export interface RegimeEmpresaResult {
  empresa: string;
  regime_atual: RegimeNome;
  ttm: { ano_mes_fim: string; meses: number };
  comparados: RegimeComparado[];
  recomendado: RegimeNome | null;
  economia_anual: number | null;
  status: StatusRecomendacao;
  break_even: { margem_real_vs_presumido: number | null; fator_r: number };
  eixo_indireto: { icms_iss_ipi_simples: number | null; observacao: string };
  confianca: { nivel: 'alta' | 'media' | 'baixa'; motivos: string[] };
  regime_inputs: RegimeInputs;
}

export interface RegimeTributarioResult {
  por_empresa: RegimeEmpresaResult[];
  consolidado: { imposto_atual_total: number; imposto_otimizado_total: number; economia_total: number; confianca: 'alta' | 'media' | 'baixa' };
  gerado_em: string;
}
