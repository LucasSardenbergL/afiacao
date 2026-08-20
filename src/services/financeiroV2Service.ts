import { supabase } from "@/integrations/supabase/client";
import { fetchAllPages } from "@/lib/postgrest";
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

/**
 * Chave de ordenação TOTAL de cada matview dimensional: o `GROUP BY` dela, INTEIRO.
 *
 * Paginar exige ordem total — sem ela o plano escolhe a ordem de cada página e o offset
 * pula/duplica linha entre requests (o bug de volta, e intermitente). Estas matviews são
 * AGREGADAS e não têm `id`; a chave é o conjunto de colunas do `GROUP BY`, porque duas linhas
 * com os mesmos valores nele não podem coexistir — é o que agrupar significa.
 *
 * A unicidade aqui é IMPOSTA, não observada: as duas matviews têm índice UNIQUE
 * (`idx_fin_analise_c{p,r}_unique`) sobre exatamente estas colunas menos `categoria_descricao`
 * — o `REFRESH … CONCURRENTLY` do cron `fin-refresh-analise-dimensoes` exige um. Um superconjunto
 * de uma chave única é chave única, então esta lista é ordem total por construção do banco. (A
 * contagem `count(*) = count(DISTINCT (…))` de 2026-08-20 — 4.693 e 622 — só confirma o que o
 * índice já garante; era a prova FRACA, e o Codex apontou isso.)
 *
 * ⚠️ NÃO encurte para um prefixo "que também é único hoje": unicidade observada nos dados de
 * hoje não é ordem total amanhã, e o defeito que ela reintroduz é intermitente. O repo já
 * pagou por isso um degrau abaixo, em `getCategoriasCompetenciaRaw` — lá foi
 * `categoria_descricao` que empatava dentro de `categoria_codigo`.
 */
const CHAVE_TOTAL_CP = [
  'company', 'ano', 'mes', 'categoria_codigo', 'categoria_descricao', 'departamento',
  'centro_custo', 'nome_fornecedor', 'cnpj_cpf', 'tipo_documento', 'status_titulo',
] as const;
const CHAVE_TOTAL_CR = [
  'company', 'ano', 'mes', 'categoria_codigo', 'categoria_descricao', 'departamento',
  'centro_custo', 'vendedor_id', 'nome_cliente', 'cnpj_cpf', 'status_titulo',
] as const;

/** O mínimo do builder do PostgREST que a paginação usa — o `.rpc()` daqui já entra por `as never`. */
type LeituraOrdenavel = {
  order: (coluna: string, opts: { ascending: boolean; nullsFirst: boolean }) => LeituraOrdenavel;
  range: (de: number, ate: number) => PromiseLike<{ data: unknown; error: unknown }>;
};

/**
 * Encadeia um `.order()` por coluna da chave. `nullsFirst` é EXPLÍCITO de propósito: as colunas
 * de dimensão são nullable (`departamento`, `centro_custo` e `cnpj_cpf` vêm nulos em títulos sem
 * classificação) e o posicionamento dos nulos precisa ser o mesmo em TODAS as páginas — deixá-lo
 * no default do servidor amarra a estabilidade da paginação a algo que não está escrito aqui.
 */
function ordenarPorChaveTotal(builder: unknown, chave: readonly string[]): LeituraOrdenavel {
  return chave.reduce<LeituraOrdenavel>(
    (q, coluna) => q.order(coluna, { ascending: true, nullsFirst: false }),
    builder as LeituraOrdenavel,
  );
}

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
  // PAGINADAS, com ordem TOTAL antes do `.range` — a capa de 1.000 do PostgREST vale para
  // `.rpc()` e é SILENCIOSA (#1782, #1801). Medido em prod (2026-08-20, psql-ro, contando as
  // matviews que as RPCs devolvem via `SETOF`), no pior caso REAL da tela — que é o estado
  // INICIAL dela: mês = "todos" (`FinanceiroAnalytics.tsx` abre com `mes = null`) e ano
  // corrente, com a empresa podendo ser `all` (⇒ `p_company: null`):
  //
  //   cp: 877 linhas (ano 2025, todas as empresas) — 88% da capa. A série anual é monotônica
  //       e cresce ~14%/ano: 407 (2020) → 483 → 546 → 614 → 770 → 877 (2025). A próxima safra
  //       fechada rompe 1.000; a matview inteira já tem 4.693.
  //   cr: 138 linhas no pior ano. Folga de 7×, e ainda assim pagina: é o MESMO caller, o mesmo
  //       `rpcParams` e o mesmo `.reduce` de ordem — paginar só um ramo do if/else deixaria uma
  //       assimetria que o próximo leitor teria de re-medir para entender.
  //
  // O que o truncamento produziria aqui não é erro, é NÚMERO FABRICADO: o laço abaixo AGREGA
  // (`+=` de qtd_titulos e dos três totais) num Map por dimensão, então perder a cauda não
  // esvazia a tela — encolhe cada total em silêncio, e um "total de contas a pagar por
  // categoria" 12% menor é indistinguível de um mês mais fraco.
  //
  // FAIL-CLOSED de lado: o `?? []` que estava aqui cobria `data: null` SEM error (resposta
  // malformada, classe #1581) transformando-a em "nenhum título" — zero fabricado. `fetchAllPages`
  // LANÇA nesse caso (`data_null_sem_error`), e o caller já trata erro (o `throw` de antes).
  //
  // ⚠️ LIMITE CONHECIDO, que a paginação NÃO cura (achado do Codex nesta revisão): páginas são
  // requests HTTP distintos e não compartilham snapshot. O cron `fin-refresh-analise-dimensoes`
  // roda `REFRESH MATERIALIZED VIEW CONCURRENTLY` às 10h e 16h; um refresh que caia ENTRE duas
  // páginas pode fazer o offset pular ou repetir linha apesar da ordem total. Hoje o risco é
  // nulo na prática — 877 linhas cabem na 1ª página e o laço encerra sem 2ª requisição — e ele
  // nasce junto com o rompimento da capa, que é justamente o que esta paginação existe para
  // atender. Mesmo então, paginar é estritamente melhor que não paginar: o risco vira uma janela
  // de dois instantes por dia contra uma perda GARANTIDA de toda a cauda, todo dia. A cura de
  // verdade é agregar server-side (a RPC devolver o Map já somado, em vez de N linhas cruas) —
  // escopo próprio, deliberadamente fora deste.
  let rows: DimRow[];
  if (tipo === 'cr') {
    rows = await fetchAllPages<FinAnaliseCrDimensoesView>(
      (de, ate) =>
        ordenarPorChaveTotal(
          supabase.rpc('fin_analise_cr_dimensoes_rpc' as never, rpcParams as never),
          CHAVE_TOTAL_CR,
        ).range(de, ate) as unknown as PromiseLike<{
          data: FinAnaliseCrDimensoesView[] | null;
          error: unknown;
        }>,
      'fin_analise_cr_dimensoes_rpc/analise-dimensional',
    );
  } else {
    rows = await fetchAllPages<FinAnaliseCpDimensoesView>(
      (de, ate) =>
        ordenarPorChaveTotal(
          supabase.rpc('fin_analise_cp_dimensoes_rpc' as never, rpcParams as never),
          CHAVE_TOTAL_CP,
        ).range(de, ate) as unknown as PromiseLike<{
          data: FinAnaliseCpDimensoesView[] | null;
          error: unknown;
        }>,
      'fin_analise_cp_dimensoes_rpc/analise-dimensional',
    );
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
      // Ordem TOTAL no recorte. O grão da view inclui categoria_descricao (o GROUP BY da
      // migration 20260328200600 agrupa por ela TAMBÉM — achado Codex xhigh): duas
      // descrições do mesmo código/mês/origem empatariam e trocariam de posição entre
      // requests. Sem ordem total, offset entre páginas pula/duplica linha.
      .order('categoria_codigo', { ascending: true })
      .order('categoria_descricao', { ascending: true })
      .order('mes', { ascending: true })
      .order('origem', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    // data null SEM error = malformada, não fim (classe #1338→#1564): tratá-la como fim
    // entregava o drill de variância por categoria PARCIAL.
    if (data == null) throw new Error('fin_dre_competencia_base: data null sem error — malformada, não é fim');
    const rows = data;
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
      // data null SEM error = malformada, não página vazia (classe #1338→#1564): devolvê-la
      // ao coletarTitulosEntidade encerraria o lote como fim SEM ligar o flag `truncado`.
      if (data == null) throw new Error(`${tabela}: data null sem error — malformada, não é fim`);
      const rows = data as unknown as Array<Record<string, unknown>>;
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

