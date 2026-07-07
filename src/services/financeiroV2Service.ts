import { supabase } from "@/integrations/supabase/client";
import type { Company } from "@/contexts/CompanyContext";
import type { Json } from "@/integrations/supabase/types";
import type { DimRowRaw } from "@/lib/financeiro/orcamento-drill-helpers";
import { coletarTitulosEntidade, parseMesDataEmissao, type EntidadeRowRaw } from "@/lib/financeiro/orcamento-entidade-helpers";
import { parseSnapshotSemanas, type SnapshotEmpresa } from "@/lib/financeiro/cockpit-consolida-helpers";
import type {
  FinFechamentoRow,
  FinFechamentoInsert,
  FinFechamentoUpdate,
  FinFechamentoLogInsert,
  FinEliminacaoInsert,
  FinOrcamentoRow,
  FinOrcamentoInsert,
  FinPermissaoRow,
  FinAnaliseCpDimensoesView,
  FinAnaliseCrDimensoesView,
} from "./financeiroTypes";

// ═══════════════ TYPES ═══════════════

type FechamentoStatus = 'aberto' | 'em_revisao' | 'fechado' | 'reaberto';

export interface Fechamento {
  id: string;
  company: string;
  ano: number;
  mes: number;
  status: FechamentoStatus;
  versao: number;
  snapshot_dre_id: string | null;
  fechado_por: string | null;
  fechado_em: string | null;
  aprovado_por: string | null;
  aprovado_em: string | null;
  notas: string | null;
}

export interface FechamentoLog {
  id: string;
  acao: string;
  usuario_nome: string | null;
  detalhes: Json;
  created_at: string;
}

export interface EliminacaoRegra {
  id: string;
  empresa_origem: string;
  empresa_destino: string;
  tipo: string;
  match_por: string;
  cnpj_origem: string | null;
  cnpj_destino: string | null;
  descricao: string;
  ativo: boolean;
}

export interface OrcamentoLinha {
  id?: string;
  company: string;
  ano: number;
  mes: number;
  dre_linha: string;
  valor_orcado: number;
  notas?: string;
}

type FinPerfil = 'analista' | 'gerente' | 'controller' | 'cfo';

export interface FinPermissao {
  id: string;
  user_id: string;
  perfil: FinPerfil;
  empresas: string[];
  pode_sync: boolean;
  pode_fechar_mes: boolean;
  pode_aprovar_fechamento: boolean;
  pode_reabrir_fechamento: boolean;
  pode_editar_orcamento: boolean;
  pode_editar_mapping: boolean;
  pode_eliminar_intercompany: boolean;
  pode_conciliar: boolean;
  pode_exportar: boolean;
  pode_ver_dre: boolean;
  pode_ver_todas_empresas: boolean;
}

export interface AnaliseDimensional {
  company: string;
  ano: number;
  mes: number;
  dimensao: string;
  valor_dimensao: string;
  qtd_titulos: number;
  total_documento: number;
  total_pago_recebido: number;
  total_saldo: number;
}

// ── Mapping helpers (DB rows → narrowed app shapes) ───────────────────────

function rowToFechamento(row: FinFechamentoRow): Fechamento {
  return {
    id: row.id,
    company: row.company,
    ano: row.ano,
    mes: row.mes,
    status: row.status as FechamentoStatus,
    versao: row.versao,
    snapshot_dre_id: row.snapshot_dre_id,
    fechado_por: row.fechado_por,
    fechado_em: row.fechado_em,
    aprovado_por: row.aprovado_por,
    aprovado_em: row.aprovado_em,
    notas: row.notas,
  };
}

function rowToPermissao(row: FinPermissaoRow): FinPermissao {
  return {
    id: row.id,
    user_id: row.user_id,
    perfil: row.perfil as FinPerfil,
    empresas: row.empresas ?? [],
    pode_sync: row.pode_sync ?? false,
    pode_fechar_mes: row.pode_fechar_mes ?? false,
    pode_aprovar_fechamento: row.pode_aprovar_fechamento ?? false,
    pode_reabrir_fechamento: row.pode_reabrir_fechamento ?? false,
    pode_editar_orcamento: row.pode_editar_orcamento ?? false,
    pode_editar_mapping: row.pode_editar_mapping ?? false,
    pode_eliminar_intercompany: row.pode_eliminar_intercompany ?? false,
    pode_conciliar: row.pode_conciliar ?? false,
    pode_exportar: row.pode_exportar ?? false,
    pode_ver_dre: row.pode_ver_dre ?? false,
    pode_ver_todas_empresas: row.pode_ver_todas_empresas ?? false,
  };
}

function rowToOrcamento(row: FinOrcamentoRow): OrcamentoLinha {
  return {
    id: row.id,
    company: row.company,
    ano: row.ano,
    mes: row.mes,
    dre_linha: row.dre_linha,
    valor_orcado: row.valor_orcado,
    notas: row.notas ?? undefined,
  };
}

// ═══════════════ 1. FECHAMENTO MENSAL ═══════════════

export async function getFechamentos(company: Company | 'all', ano?: number): Promise<Fechamento[]> {
  let query = supabase
    .from("fin_fechamentos")
    .select("*")
    .order("ano", { ascending: false })
    .order("mes", { ascending: false });

  if (company !== 'all') query = query.eq("company", company);
  if (ano) query = query.eq("ano", ano);

  const { data, error } = await query;
  if (error) throw error;
  return (data || []).map(rowToFechamento);
}

export async function getFechamentoLog(fechamentoId: string): Promise<FechamentoLog[]> {
  const { data, error } = await supabase
    .from("fin_fechamento_log")
    .select("*")
    .eq("fechamento_id", fechamentoId)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return (data || []).map((row) => ({
    id: row.id,
    acao: row.acao,
    usuario_nome: row.usuario_nome,
    detalhes: row.detalhes ?? {},
    created_at: row.created_at ?? '',
  }));
}

export async function criarFechamento(company: Company, ano: number, mes: number): Promise<Fechamento> {
  // Check if already exists
  const { data: existing } = await supabase
    .from("fin_fechamentos")
    .select("id, versao")
    .eq("company", company)
    .eq("ano", ano)
    .eq("mes", mes)
    .order("versao", { ascending: false })
    .limit(1);

  const nextVersao = existing && existing.length > 0 ? existing[0].versao + 1 : 1;

  const insertPayload: FinFechamentoInsert = {
    company,
    ano,
    mes,
    status: 'aberto',
    versao: nextVersao,
  };

  const { data, error } = await supabase
    .from("fin_fechamentos")
    .insert(insertPayload)
    .select()
    .single();

  if (error) throw error;

  // Log
  const logPayload: FinFechamentoLogInsert = {
    fechamento_id: data.id,
    acao: 'criar',
    usuario_id: (await supabase.auth.getUser()).data.user?.id ?? null,
    detalhes: { versao: nextVersao },
  };
  await supabase.from("fin_fechamento_log").insert(logPayload);

  return rowToFechamento(data);
}

export async function atualizarFechamento(
  id: string,
  acao: 'revisar' | 'fechar' | 'aprovar' | 'reabrir',
  detalhes?: {
    motivo?: string;
    notas?: string;
    snapshot_dre_id?: string;
    snapshot_dre_caixa_id?: string;
    snapshot_dre_competencia_id?: string;
  }
): Promise<void> {
  const statusMap: Record<typeof acao, FechamentoStatus> = {
    revisar: 'em_revisao',
    fechar: 'fechado',
    aprovar: 'fechado',
    reabrir: 'reaberto',
  };

  const userId = (await supabase.auth.getUser()).data.user?.id ?? null;
  const now = new Date().toISOString();

  const updates: FinFechamentoUpdate & {
    snapshot_dre_caixa_id?: string;
    snapshot_dre_competencia_id?: string;
  } = {
    status: statusMap[acao],
    updated_at: now,
  };

  if (acao === 'fechar') {
    updates.fechado_por = userId;
    updates.fechado_em = now;
    if (detalhes?.snapshot_dre_id) updates.snapshot_dre_id = detalhes.snapshot_dre_id;
    // Phase 3: salvar FKs duplos (caixa + competência) explicitamente ou auto-detectar
    if (detalhes?.snapshot_dre_caixa_id) {
      updates.snapshot_dre_caixa_id = detalhes.snapshot_dre_caixa_id;
    }
    if (detalhes?.snapshot_dre_competencia_id) {
      updates.snapshot_dre_competencia_id = detalhes.snapshot_dre_competencia_id;
    }
    // Auto-detect: se caller não passou os FKs, query pelo company+ano+mes do fechamento
    if (!detalhes?.snapshot_dre_caixa_id || !detalhes?.snapshot_dre_competencia_id) {
      const { data: fech } = await supabase
        .from('fin_fechamentos')
        .select('company, ano, mes')
        .eq('id', id)
        .maybeSingle();
      if (fech) {
        const { data: snaps } = await supabase
          .from('fin_dre_snapshots')
          .select('id, regime')
          .eq('company', fech.company)
          .eq('ano', fech.ano)
          .eq('mes', fech.mes);
        for (const s of (snaps ?? []) as Array<{ id: string; regime: string }>) {
          if (s.regime === 'caixa' && !updates.snapshot_dre_caixa_id) {
            updates.snapshot_dre_caixa_id = s.id;
          }
          if (s.regime === 'competencia' && !updates.snapshot_dre_competencia_id) {
            updates.snapshot_dre_competencia_id = s.id;
          }
        }
      }
    }
  }
  if (acao === 'aprovar') {
    updates.aprovado_por = userId;
    updates.aprovado_em = now;
  }
  if (acao === 'reabrir') {
    updates.reaberto_por = userId;
    updates.reaberto_em = now;
    updates.motivo_reabertura = detalhes?.motivo || '';
  }
  if (detalhes?.notas) updates.notas = detalhes.notas;

  const { error } = await supabase
    .from("fin_fechamentos")
    .update(updates)
    .eq("id", id);

  if (error) throw error;

  const logPayload: FinFechamentoLogInsert = {
    fechamento_id: id,
    acao,
    usuario_id: userId,
    detalhes: (detalhes ?? {}) as Json,
  };
  await supabase.from("fin_fechamento_log").insert(logPayload);
}

// ═══════════════ 3. ELIMINAÇÕES INTERCOMPANY ═══════════════

export async function getEliminacoes(): Promise<EliminacaoRegra[]> {
  const { data, error } = await supabase
    .from("fin_eliminacoes_intercompany")
    .select("*")
    .order("empresa_origem");
  if (error) throw error;
  return (data || []).map((row) => ({
    id: row.id,
    empresa_origem: row.empresa_origem,
    empresa_destino: row.empresa_destino,
    tipo: row.tipo,
    match_por: row.match_por,
    cnpj_origem: row.cnpj_origem,
    cnpj_destino: row.cnpj_destino,
    descricao: row.descricao,
    ativo: row.ativo ?? true,
  }));
}

export async function upsertEliminacao(regra: Omit<EliminacaoRegra, 'id'>): Promise<void> {
  const payload: FinEliminacaoInsert = {
    empresa_origem: regra.empresa_origem,
    empresa_destino: regra.empresa_destino,
    tipo: regra.tipo,
    match_por: regra.match_por,
    cnpj_origem: regra.cnpj_origem,
    cnpj_destino: regra.cnpj_destino,
    descricao: regra.descricao,
    ativo: regra.ativo,
  };
  const { error } = await supabase
    .from("fin_eliminacoes_intercompany")
    .insert(payload);
  if (error) throw error;
}

export async function deleteEliminacao(id: string): Promise<void> {
  const { error } = await supabase
    .from("fin_eliminacoes_intercompany")
    .delete()
    .eq("id", id);
  if (error) throw error;
}

// ═══════════════ 4. ORÇAMENTO ═══════════════

export async function getOrcamento(company: Company, ano: number): Promise<OrcamentoLinha[]> {
  const { data, error } = await supabase
    .from("fin_orcamento")
    .select("*")
    .eq("company", company)
    .eq("ano", ano)
    .order("mes")
    .order("dre_linha");
  if (error) throw error;
  return (data || []).map(rowToOrcamento);
}

export async function upsertOrcamento(linhas: OrcamentoLinha[]): Promise<void> {
  const userId = (await supabase.auth.getUser()).data.user?.id ?? null;
  const rows: FinOrcamentoInsert[] = linhas.map((l) => ({
    company: l.company,
    ano: l.ano,
    mes: l.mes,
    dre_linha: l.dre_linha,
    valor_orcado: l.valor_orcado,
    notas: l.notas ?? null,
    criado_por: userId,
    updated_at: new Date().toISOString(),
  }));
  const { error } = await supabase
    .from("fin_orcamento")
    .upsert(rows, { onConflict: "company,ano,mes,dre_linha" });
  if (error) throw error;
}

// ═══════════════ 5. ANÁLISE DIMENSIONAL ═══════════════

export type Dimensao = 'categoria' | 'departamento' | 'centro_custo' | 'vendedor' | 'cliente' | 'fornecedor';

type DimRow = FinAnaliseCrDimensoesView | FinAnaliseCpDimensoesView;

export async function getAnaliseDimensional(
  tipo: 'cr' | 'cp',
  company: Company | 'all',
  dimensao: Dimensao,
  ano?: number,
  mes?: number
): Promise<AnaliseDimensional[]> {
  // Map dimension to column
  const dimColCr: Record<Dimensao, keyof FinAnaliseCrDimensoesView> = {
    categoria: 'categoria_descricao',
    departamento: 'departamento',
    centro_custo: 'centro_custo',
    vendedor: 'vendedor_id',
    cliente: 'nome_cliente',
    fornecedor: 'nome_cliente', // CR view has no fornecedor; fall back to cliente
  };
  const dimColCp: Record<Dimensao, keyof FinAnaliseCpDimensoesView> = {
    categoria: 'categoria_descricao',
    departamento: 'departamento',
    centro_custo: 'centro_custo',
    vendedor: 'nome_fornecedor',
    cliente: 'nome_fornecedor', // CP view has no cliente; fall back to fornecedor
    fornecedor: 'nome_fornecedor',
  };

  // Matviews têm REVOKE SELECT de `authenticated`; lemos via RPC SECURITY DEFINER
  // gated (fin_analise_c{r,p}_dimensoes_rpc), que retorna SETOF a matview (mesmo shape).
  const rpcParams = {
    p_company: company === 'all' ? null : company,
    p_ano: ano ?? null,
    p_mes: mes ?? null,
  };
  let rows: DimRow[];
  if (tipo === 'cr') {
    const { data, error } = await supabase.rpc(
      'fin_analise_cr_dimensoes_rpc' as never,
      rpcParams as never,
    );
    if (error) throw error;
    rows = (data as unknown as FinAnaliseCrDimensoesView[]) ?? [];
  } else {
    const { data, error } = await supabase.rpc(
      'fin_analise_cp_dimensoes_rpc' as never,
      rpcParams as never,
    );
    if (error) throw error;
    rows = (data as unknown as FinAnaliseCpDimensoesView[]) ?? [];
  }

  const col = (tipo === 'cr' ? dimColCr[dimensao] : dimColCp[dimensao]) as keyof DimRow;

  // Aggregate by dimension
  const map = new Map<string, AnaliseDimensional>();
  for (const row of rows) {
    const rawKey = row[col];
    const key = rawKey == null ? 'Não informado' : String(rawKey);
    const existing = map.get(key) || {
      company: row.company ?? '',
      ano: row.ano ?? 0,
      mes: row.mes ?? 0,
      dimensao,
      valor_dimensao: key,
      qtd_titulos: 0,
      total_documento: 0,
      total_pago_recebido: 0,
      total_saldo: 0,
    };
    existing.qtd_titulos += row.qtd_titulos ?? 0;
    existing.total_documento += row.total_documento ?? 0;
    existing.total_pago_recebido +=
      tipo === 'cr'
        ? (row as FinAnaliseCrDimensoesView).total_recebido ?? 0
        : (row as FinAnaliseCpDimensoesView).total_pago ?? 0;
    existing.total_saldo += row.total_saldo ?? 0;
    map.set(key, existing);
  }

  return Array.from(map.values()).sort((a, b) => b.total_documento - a.total_documento);
}

/**
 * Linhas CRUAS por (categoria_codigo, mês) em regime de COMPETÊNCIA (data_emissão) de
 * um ano — fonte do drill de variância por categoria (`drillLinha`).
 *
 * Lê `fin_dre_competencia_base` (CR+CP por data_emissão, status≠CANCELADO, soma
 * valor_documento) — a MESMA base que o `calcularDRE` competência usa para montar o
 * `fin_dre_snapshots`. Por isso reconcilia: drillar contra a matview dimensional (que
 * é por data_VENCIMENTO) acusaria resíduo falso por diferença de base temporal.
 *
 * Retorna linhas de AMBAS as origens (CR e CP): o `calcularDRE` classifica por CÓDIGO
 * independentemente do razão, então o drill soma por código sobre os dois (o helper
 * agrega). Filtra os meses fechados server-side e PAGINA (a view passa de 1000 linhas
 * fácil: categorias × meses × 2 origens).
 */
export async function getCategoriasCompetenciaRaw(
  company: Company,
  ano: number,
  meses: number[],
): Promise<DimRowRaw[]> {
  if (meses.length === 0) return [];
  const PAGE = 1000;
  const out: DimRowRaw[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('fin_dre_competencia_base')
      .select('categoria_codigo, categoria_descricao, mes, valor_total')
      .eq('company', company)
      .eq('ano', ano)
      .in('mes', meses)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = data ?? [];
    for (const r of rows) {
      out.push({
        categoria_codigo: r.categoria_codigo,
        categoria_descricao: r.categoria_descricao,
        mes: r.mes,
        valor: r.valor_total ?? 0,
      });
    }
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

/**
 * Títulos CRUS (por entidade) de uma linha de DRE em COMPETÊNCIA — fonte do drill v2
 * (concentração por fornecedor/cliente). Lê `fin_contas_pagar` (cp) / `fin_contas_receber`
 * (cr) com os MESMOS filtros da `fin_dre_competencia_base` → reconcilia com o total-por-
 * categoria do v1. Limita server-side ao horizonte FECHADO (senão o ano-1 buscaria 12
 * meses e truncaria perdendo o YTD). Chunked `.in()` (URL) + paginação estável (`.order id`)
 * + teto de coleta — toda a orquestração no helper testável `coletarTitulosEntidade`.
 */
export async function getTitulosEntidadeRaw(
  fonte: 'cp' | 'cr',
  company: Company,
  ano: number,
  meses: number[],
  codigos: string[],
): Promise<{ rows: EntidadeRowRaw[]; truncado: boolean }> {
  if (codigos.length === 0 || meses.length === 0) return { rows: [], truncado: false };
  const tabela = fonte === 'cp' ? 'fin_contas_pagar' : 'fin_contas_receber';
  const nomeCol = fonte === 'cp' ? 'nome_fornecedor' : 'nome_cliente';
  const maxMes = Math.max(...meses);
  const fimExcl =
    maxMes >= 12 ? `${ano + 1}-01-01` : `${ano}-${String(maxMes + 1).padStart(2, '0')}-01`;
  return coletarTitulosEntidade({
    codigos,
    chunkCodigos: 100,
    pageSize: 1000,
    max: 20000,
    fetchPagina: async (lote, offset, limit) => {
      const { data, error } = await supabase
        .from(tabela)
        .select(`id, cnpj_cpf, ${nomeCol}, data_emissao, valor_documento`)
        .eq('company', company)
        .not('data_emissao', 'is', null)
        .gte('data_emissao', `${ano}-01-01`)
        .lt('data_emissao', fimExcl)
        .neq('status_titulo', 'CANCELADO')
        .in('categoria_codigo', lote)
        .order('id', { ascending: true })
        .range(offset, offset + limit - 1);
      if (error) throw error;
      const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        entidade_id: (row.cnpj_cpf as string | null) ?? null,
        entidade_nome: (row[nomeCol] as string | null) ?? null,
        mes: parseMesDataEmissao((row.data_emissao as string | null) ?? null),
        valor: (row.valor_documento as number | null) ?? 0,
      }));
    },
  });
}

/**
 * Último snapshot de projeção 13s (cenário `realista`) por empresa, de `fin_projecao_snapshots`
 * (gravado pelo cron diário via fin-cashflow-engine). Fonte do Cockpit consolidado: a projeção
 * e o NCG vêm da engine A1 calibrada (não da RPC ingênua). `dados` (Json) = semanas[] — valida
 * `Array.isArray` e extrai {inicio,total_entradas,total_saidas,saldo_final}. Uma query por empresa.
 */
export async function getProjecaoSnapshotsCockpit(
  companies: Company[],
  cenario = 'realista',
): Promise<SnapshotEmpresa[]> {
  const results = await Promise.all(
    companies.map(async (company): Promise<SnapshotEmpresa | null> => {
      const { data, error } = await supabase
        .from('fin_projecao_snapshots')
        .select('company, snapshot_at, ncg, saldo_tesouraria, dados, id')
        .eq('company', company)
        .eq('cenario', cenario)
        .order('snapshot_at', { ascending: false })
        .order('id', { ascending: false }) // desempate determinístico (Codex P2)
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      // ausente ≠ zero: campo core inválido descarta a semana; saldo_inicial null/ausente → null
      // (NÃO 0 — Number(null)===0 seria fabricação). Lógica no helper puro testável.
      const semanas = parseSnapshotSemanas((data as { dados: unknown }).dados);
      return {
        company: (data.company as string) ?? company,
        snapshot_at: data.snapshot_at as string,
        ncg: (data.ncg as number | null) ?? null,
        saldo_tesouraria: (data.saldo_tesouraria as number | null) ?? null,
        semanas,
      };
    }),
  );
  return results.filter((r): r is SnapshotEmpresa => r !== null);
}

// ═══════════════ 5b. BALANÇO (Fleuriet) ═══════════════

export type BalancoInputRow = { company: string; data_ref: string; anc: number | null; pnc: number | null; pl: number | null };

/** Balanço mais recente por empresa (maior data_ref) de fin_balanco_inputs (RLS master-only). */
export async function getBalancoInputs(companies: Company[]): Promise<Record<string, BalancoInputRow>> {
  const out: Record<string, BalancoInputRow> = {};
  await Promise.all(companies.map(async (company) => {
    const { data, error } = await supabase
      .from('fin_balanco_inputs')
      .select('company, data_ref, ativo_nao_circulante, passivo_nao_circulante, patrimonio_liquido')
      .eq('company', company)
      .order('data_ref', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (data) out[company] = {
      company: data.company,
      data_ref: data.data_ref,
      anc: data.ativo_nao_circulante ?? null,
      pnc: data.passivo_nao_circulante ?? null,
      pl: data.patrimonio_liquido ?? null,
    };
  }));
  return out;
}

/** NCG (cenário realista) numa janela de ±margemDias ao redor da data do balanço — para casar por
 *  data (a classificação é as-of o balancete). Buscar ao redor da data_ref (não desde hoje) garante
 *  que balanços antigos achem o snapshot certo sem o cap cortar (Codex). Ordena desc; cap 60. */
export async function getNcgNaJanela(company: Company, dataRef: string, margemDias = 15): Promise<{ ncg: number | null; snapshot_at: string }[]> {
  const refMs = Date.parse(dataRef + 'T00:00:00Z');
  const desde = new Date(refMs - margemDias * 86400000).toISOString();
  const ate = new Date(refMs + margemDias * 86400000).toISOString();
  const { data, error } = await supabase
    .from('fin_projecao_snapshots')
    .select('ncg, snapshot_at')
    .eq('company', company)
    .eq('cenario', 'realista')
    .gte('snapshot_at', desde)
    .lte('snapshot_at', ate)
    .order('snapshot_at', { ascending: false })
    .limit(60);
  if (error) throw error;
  return (data ?? []).map((r) => ({ ncg: r.ncg ?? null, snapshot_at: r.snapshot_at }));
}

// ═══════════════ 6. PERMISSÕES ═══════════════

export async function getMinhaPermissao(): Promise<FinPermissao | null> {
  const userId = (await supabase.auth.getUser()).data.user?.id;
  if (!userId) return null;

  const { data, error } = await supabase
    .from("fin_permissoes")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (error || !data) return null;
  return rowToPermissao(data);
}

