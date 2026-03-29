// @ts-nocheck
import { supabase } from "@/integrations/supabase/client";
import type { Company } from "@/contexts/CompanyContext";

// ═══════════════ TYPES ═══════════════

export interface Fechamento {
  id: string;
  company: string;
  ano: number;
  mes: number;
  status: 'aberto' | 'em_revisao' | 'fechado' | 'reaberto';
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
  detalhes: any;
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

export interface FinPermissao {
  id: string;
  user_id: string;
  perfil: 'analista' | 'gerente' | 'controller' | 'cfo';
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

// ═══════════════ 1. FECHAMENTO MENSAL ═══════════════

export async function getFechamentos(company: Company | 'all', ano?: number): Promise<Fechamento[]> {
  let query = supabase
    .from("fin_fechamentos" as any)
    .select("*")
    .order("ano", { ascending: false })
    .order("mes", { ascending: false });

  if (company !== 'all') query = query.eq("company", company);
  if (ano) query = query.eq("ano", ano);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function getFechamentoLog(fechamentoId: string): Promise<FechamentoLog[]> {
  const { data, error } = await supabase
    .from("fin_fechamento_log" as any)
    .select("*")
    .eq("fechamento_id", fechamentoId)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return data || [];
}

export async function criarFechamento(company: Company, ano: number, mes: number): Promise<Fechamento> {
  // Check if already exists
  const { data: existing } = await supabase
    .from("fin_fechamentos" as any)
    .select("id, versao")
    .eq("company", company)
    .eq("ano", ano)
    .eq("mes", mes)
    .order("versao", { ascending: false })
    .limit(1);

  const nextVersao = existing && existing.length > 0 ? existing[0].versao + 1 : 1;

  const { data, error } = await supabase
    .from("fin_fechamentos" as any)
    .insert({
      company,
      ano,
      mes,
      status: 'aberto',
      versao: nextVersao,
    })
    .select()
    .single();

  if (error) throw error;

  // Log
  await supabase.from("fin_fechamento_log" as any).insert({
    fechamento_id: data.id,
    acao: 'criar',
    usuario_id: (await supabase.auth.getUser()).data.user?.id,
    detalhes: { versao: nextVersao },
  });

  return data;
}

export async function atualizarFechamento(
  id: string,
  acao: 'revisar' | 'fechar' | 'aprovar' | 'reabrir',
  detalhes?: { motivo?: string; notas?: string; snapshot_dre_id?: string }
): Promise<void> {
  const statusMap: Record<string, string> = {
    revisar: 'em_revisao',
    fechar: 'fechado',
    aprovar: 'fechado',
    reabrir: 'reaberto',
  };

  const userId = (await supabase.auth.getUser()).data.user?.id;
  const now = new Date().toISOString();

  const updates: any = {
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
    .from("fin_fechamentos" as any)
    .update(updates)
    .eq("id", id);

  if (error) throw error;

  await supabase.from("fin_fechamento_log" as any).insert({
    fechamento_id: id,
    acao,
    usuario_id: userId,
    detalhes: detalhes || {},
  });
}

// ═══════════════ 2. CONCILIAÇÃO BANCÁRIA ═══════════════

export async function getConciliacaoPendente(
  company: Company,
  omieNcodcc?: number
): Promise<ConciliacaoItem[]> {
  let query = supabase
    .from("fin_conciliacao" as any)
    .select("*")
    .eq("company", company)
    .in("status", ["pendente", "divergencia"])
    .order("mov_data", { ascending: false });

  if (omieNcodcc) query = query.eq("omie_ncodcc", omieNcodcc);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function resolverConciliacao(
  id: string,
  status: 'conciliado' | 'ignorado',
  observacao?: string
): Promise<void> {
  const userId = (await supabase.auth.getUser()).data.user?.id;
  const { error } = await supabase
    .from("fin_conciliacao" as any)
    .update({
      status,
      resolvido_por: userId,
      resolvido_em: new Date().toISOString(),
      observacao: observacao || null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) throw error;
}

// ═══════════════ 3. ELIMINAÇÕES INTERCOMPANY ═══════════════

export async function getEliminacoes(): Promise<EliminacaoRegra[]> {
  const { data, error } = await supabase
    .from("fin_eliminacoes_intercompany" as any)
    .select("*")
    .order("empresa_origem");
  if (error) throw error;
  return data || [];
}

export async function upsertEliminacao(regra: Omit<EliminacaoRegra, 'id'>): Promise<void> {
  const { error } = await supabase
    .from("fin_eliminacoes_intercompany" as any)
    .insert(regra);
  if (error) throw error;
}

export async function deleteEliminacao(id: string): Promise<void> {
  const { error } = await supabase
    .from("fin_eliminacoes_intercompany" as any)
    .delete()
    .eq("id", id);
  if (error) throw error;
}

// ═══════════════ 4. ORÇAMENTO ═══════════════

export async function getOrcamento(company: Company, ano: number): Promise<OrcamentoLinha[]> {
  const { data, error } = await supabase
    .from("fin_orcamento" as any)
    .select("*")
    .eq("company", company)
    .eq("ano", ano)
    .order("mes")
    .order("dre_linha");
  if (error) throw error;
  return data || [];
}

export async function upsertOrcamento(linhas: OrcamentoLinha[]): Promise<void> {
  const userId = (await supabase.auth.getUser()).data.user?.id;
  const rows = linhas.map(l => ({
    ...l,
    criado_por: userId,
    updated_at: new Date().toISOString(),
  }));
  const { error } = await supabase
    .from("fin_orcamento" as any)
    .upsert(rows, { onConflict: "company,ano,mes,dre_linha" });
  if (error) throw error;
}

// ═══════════════ 5. ANÁLISE DIMENSIONAL ═══════════════

export type Dimensao = 'categoria' | 'departamento' | 'centro_custo' | 'vendedor' | 'cliente' | 'fornecedor';

export async function getAnaliseDimensional(
  tipo: 'cr' | 'cp',
  company: Company | 'all',
  dimensao: Dimensao,
  ano?: number,
  mes?: number
): Promise<AnaliseDimensional[]> {
  const table = tipo === 'cr' ? 'fin_analise_cr_dimensoes' : 'fin_analise_cp_dimensoes';

  // Map dimension to column
  const dimCol: Record<Dimensao, string> = {
    categoria: 'categoria_descricao',
    departamento: 'departamento',
    centro_custo: 'centro_custo',
    vendedor: tipo === 'cr' ? 'vendedor_id' : 'nome_fornecedor',
    cliente: 'nome_cliente',
    fornecedor: 'nome_fornecedor',
  };

  const col = dimCol[dimensao] || 'categoria_descricao';
  const valorCol = tipo === 'cr' ? 'total_recebido' : 'total_pago';

  let query = supabase
    .from(table as any)
    .select("*");

  if (company !== 'all') query = query.eq("company", company);
  if (ano) query = query.eq("ano", ano);
  if (mes) query = query.eq("mes", mes);

  const { data, error } = await query;
  if (error) throw error;

  // Aggregate by dimension
  const map = new Map<string, AnaliseDimensional>();
  for (const row of data || []) {
    const key = row[col] || 'Não informado';
    const existing = map.get(key) || {
      company: row.company,
      ano: row.ano,
      mes: row.mes,
      dimensao,
      valor_dimensao: key,
      qtd_titulos: 0,
      total_documento: 0,
      total_pago_recebido: 0,
      total_saldo: 0,
    };
    existing.qtd_titulos += row.qtd_titulos || 0;
    existing.total_documento += row.total_documento || 0;
    existing.total_pago_recebido += row[valorCol] || 0;
    existing.total_saldo += row.total_saldo || 0;
    map.set(key, existing);
  }

  return Array.from(map.values()).sort((a, b) => b.total_documento - a.total_documento);
}

// ═══════════════ 6. PERMISSÕES ═══════════════

export async function getMinhaPermissao(): Promise<FinPermissao | null> {
  const userId = (await supabase.auth.getUser()).data.user?.id;
  if (!userId) return null;

  const { data, error } = await supabase
    .from("fin_permissoes" as any)
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) return null;
  return data;
}

export async function getTodasPermissoes(): Promise<(FinPermissao & { nome?: string })[]> {
  const { data, error } = await supabase
    .from("fin_permissoes" as any)
    .select("*")
    .order("perfil");
  if (error) throw error;

  // Enrich with names
  const userIds = (data || []).map((p: any) => p.user_id);
  if (userIds.length === 0) return data || [];

  const { data: profiles } = await supabase
    .from("profiles")
    .select("user_id, name")
    .in("user_id", userIds) as any;

  const nameMap = new Map((profiles || []).map((p: any) => [p.user_id, p.name]));
  return (data || []).map((p: any) => ({ ...p, nome: nameMap.get(p.user_id) || 'Desconhecido' }));
}

export async function upsertPermissao(perm: Omit<FinPermissao, 'id'>): Promise<void> {
  const concedidoPor = (await supabase.auth.getUser()).data.user?.id;
  const { error } = await supabase
    .from("fin_permissoes" as any)
    .upsert({ ...perm, concedido_por: concedidoPor, updated_at: new Date().toISOString() }, {
      onConflict: "user_id",
    });
  if (error) throw error;
}

export async function deletePermissao(userId: string): Promise<void> {
  const { error } = await supabase
    .from("fin_permissoes" as any)
    .delete()
    .eq("user_id", userId);
  if (error) throw error;
}

// ═══════════════ PERFIL DEFAULTS ═══════════════

export const PERFIL_DEFAULTS: Record<string, Partial<FinPermissao>> = {
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

export async function getSyncLogs(limit = 20): Promise<any[]> {
  const { data, error } = await supabase
    .from("fin_sync_log" as any)
    .select("*")
    .order("started_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}
