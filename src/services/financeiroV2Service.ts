import { supabase } from "@/integrations/supabase/client";
import type { Company } from "@/contexts/CompanyContext";
import type { Json } from "@/integrations/supabase/types";
import type {
  FinFechamentoRow,
  FinFechamentoInsert,
  FinFechamentoUpdate,
  FinFechamentoLogInsert,
  FinConciliacaoRow,
  FinConciliacaoUpdate,
  FinEliminacaoInsert,
  FinOrcamentoRow,
  FinOrcamentoInsert,
  FinPermissaoInsert,
  FinPermissaoRow,
  FinSyncLogRow,
  FinAnaliseCpDimensoesView,
  FinAnaliseCrDimensoesView,
} from "./financeiroTypes";

// ═══════════════ TYPES ═══════════════

export type FechamentoStatus = 'aberto' | 'em_revisao' | 'fechado' | 'reaberto';

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

export interface ConciliacaoItem {
  id: string;
  company: string;
  mov_data: string | null;
  mov_valor: number | null;
  mov_descricao: string | null;
  tipo_titulo: string | null;
  titulo_valor: number | null;
  status: string;
  tipo_match: string | null;
  diferenca: number | null;
  observacao: string | null;
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

export type FinPerfil = 'analista' | 'gerente' | 'controller' | 'cfo';

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
  detalhes?: { motivo?: string; notas?: string; snapshot_dre_id?: string }
): Promise<void> {
  const statusMap: Record<typeof acao, FechamentoStatus> = {
    revisar: 'em_revisao',
    fechar: 'fechado',
    aprovar: 'fechado',
    reabrir: 'reaberto',
  };

  const userId = (await supabase.auth.getUser()).data.user?.id ?? null;
  const now = new Date().toISOString();

  const updates: FinFechamentoUpdate = {
    status: statusMap[acao],
    updated_at: now,
  };

  if (acao === 'fechar') {
    updates.fechado_por = userId;
    updates.fechado_em = now;
    if (detalhes?.snapshot_dre_id) updates.snapshot_dre_id = detalhes.snapshot_dre_id;
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

// ═══════════════ 2. CONCILIAÇÃO BANCÁRIA ═══════════════

export async function getConciliacaoPendente(
  company: Company,
  omieNcodcc?: number
): Promise<ConciliacaoItem[]> {
  let query = supabase
    .from("fin_conciliacao")
    .select("*")
    .eq("company", company)
    .in("status", ["pendente", "divergencia"])
    .order("mov_data", { ascending: false });

  if (omieNcodcc) query = query.eq("omie_ncodcc", omieNcodcc);

  const { data, error } = await query;
  if (error) throw error;
  return (data || []).map((row: FinConciliacaoRow) => ({
    id: row.id,
    company: row.company,
    mov_data: row.mov_data,
    mov_valor: row.mov_valor,
    mov_descricao: row.mov_descricao,
    tipo_titulo: row.tipo_titulo,
    titulo_valor: row.titulo_valor,
    status: row.status,
    tipo_match: row.tipo_match,
    diferenca: row.diferenca,
    observacao: row.observacao,
  }));
}

export async function resolverConciliacao(
  id: string,
  status: 'conciliado' | 'ignorado',
  observacao?: string
): Promise<void> {
  const userId = (await supabase.auth.getUser()).data.user?.id ?? null;
  const patch: FinConciliacaoUpdate = {
    status,
    resolvido_por: userId,
    resolvido_em: new Date().toISOString(),
    observacao: observacao || null,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase
    .from("fin_conciliacao")
    .update(patch)
    .eq("id", id);
  if (error) throw error;
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

  let rows: DimRow[];
  if (tipo === 'cr') {
    let q = supabase.from("fin_analise_cr_dimensoes").select("*");
    if (company !== 'all') q = q.eq("company", company);
    if (ano) q = q.eq("ano", ano);
    if (mes) q = q.eq("mes", mes);
    const { data, error } = await q;
    if (error) throw error;
    rows = data ?? [];
  } else {
    let q = supabase.from("fin_analise_cp_dimensoes").select("*");
    if (company !== 'all') q = q.eq("company", company);
    if (ano) q = q.eq("ano", ano);
    if (mes) q = q.eq("mes", mes);
    const { data, error } = await q;
    if (error) throw error;
    rows = data ?? [];
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

export async function getTodasPermissoes(): Promise<(FinPermissao & { nome?: string })[]> {
  const { data, error } = await supabase
    .from("fin_permissoes")
    .select("*")
    .order("perfil");
  if (error) throw error;

  const rows = (data || []).map(rowToPermissao);
  if (rows.length === 0) return [];

  // Enrich with names
  const userIds = rows.map((p) => p.user_id);
  const { data: profiles } = await supabase
    .from("profiles")
    .select("user_id, name")
    .in("user_id", userIds);

  const nameMap = new Map((profiles || []).map((p) => [p.user_id, p.name]));
  return rows.map((p) => ({ ...p, nome: nameMap.get(p.user_id) || 'Desconhecido' }));
}

export async function upsertPermissao(perm: Omit<FinPermissao, 'id'>): Promise<void> {
  const concedidoPor = (await supabase.auth.getUser()).data.user?.id ?? null;
  const payload: FinPermissaoInsert = {
    user_id: perm.user_id,
    perfil: perm.perfil,
    empresas: perm.empresas,
    pode_sync: perm.pode_sync,
    pode_fechar_mes: perm.pode_fechar_mes,
    pode_aprovar_fechamento: perm.pode_aprovar_fechamento,
    pode_reabrir_fechamento: perm.pode_reabrir_fechamento,
    pode_editar_orcamento: perm.pode_editar_orcamento,
    pode_editar_mapping: perm.pode_editar_mapping,
    pode_eliminar_intercompany: perm.pode_eliminar_intercompany,
    pode_conciliar: perm.pode_conciliar,
    pode_exportar: perm.pode_exportar,
    pode_ver_dre: perm.pode_ver_dre,
    pode_ver_todas_empresas: perm.pode_ver_todas_empresas,
    concedido_por: concedidoPor,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase
    .from("fin_permissoes")
    .upsert(payload, { onConflict: "user_id" });
  if (error) throw error;
}

export async function deletePermissao(userId: string): Promise<void> {
  const { error } = await supabase
    .from("fin_permissoes")
    .delete()
    .eq("user_id", userId);
  if (error) throw error;
}

// ═══════════════ PERFIL DEFAULTS ═══════════════

export const PERFIL_DEFAULTS: Record<FinPerfil, Partial<FinPermissao>> = {
  analista: {
    pode_sync: false,
    pode_fechar_mes: false,
    pode_aprovar_fechamento: false,
    pode_reabrir_fechamento: false,
    pode_editar_orcamento: false,
    pode_editar_mapping: false,
    pode_eliminar_intercompany: false,
    pode_conciliar: true,
    pode_exportar: true,
    pode_ver_dre: true,
    pode_ver_todas_empresas: false,
  },
  gerente: {
    pode_sync: true,
    pode_fechar_mes: true,
    pode_aprovar_fechamento: false,
    pode_reabrir_fechamento: false,
    pode_editar_orcamento: false,
    pode_editar_mapping: true,
    pode_eliminar_intercompany: false,
    pode_conciliar: true,
    pode_exportar: true,
    pode_ver_dre: true,
    pode_ver_todas_empresas: false,
  },
  controller: {
    pode_sync: true,
    pode_fechar_mes: true,
    pode_aprovar_fechamento: true,
    pode_reabrir_fechamento: false,
    pode_editar_orcamento: true,
    pode_editar_mapping: true,
    pode_eliminar_intercompany: true,
    pode_conciliar: true,
    pode_exportar: true,
    pode_ver_dre: true,
    pode_ver_todas_empresas: true,
  },
  cfo: {
    pode_sync: true,
    pode_fechar_mes: true,
    pode_aprovar_fechamento: true,
    pode_reabrir_fechamento: true,
    pode_editar_orcamento: true,
    pode_editar_mapping: true,
    pode_eliminar_intercompany: true,
    pode_conciliar: true,
    pode_exportar: true,
    pode_ver_dre: true,
    pode_ver_todas_empresas: true,
  },
};

// ═══════════════ SYNC LOG (observabilidade) ═══════════════

export async function getSyncLogs(limit = 20): Promise<FinSyncLogRow[]> {
  const { data, error } = await supabase
    .from("fin_sync_log")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}
