// src/hooks/usePontoEquilibrio.ts
// F3 — Ponto de equilíbrio operacional na DRE (PEGN erro 7).
// Junta 12 snapshots de DRE (competência) + a classificação fixo/variavel/misto/nao_operacional
// (fin_dre_custo_tipo, master-only) e chama o helper PURO pontoEquilibrio. Overlay: NÃO reescreve
// a DRE nem o edge. A classificação é master-only (RLS) → v1 o card é master-gated na UI; widen p/
// staff via RPC SECURITY DEFINER é v2 (spec §7). Cliente tipado pelo types.ts; o vocabulário de
// fin_dre_custo_tipo.tipo (CHECK) é conferido na borda (paraCustoTipo).
import { useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { mensagemDeErro } from '@/lib/erro-mensagem';
import { exigirColunas } from '@/lib/linha-view';
import { numero, objeto, registro, type ObjetoJson } from '@/lib/financeiro/borda-json';
import { paraCustoTipo, type CustoTipoRow } from '@/lib/financeiro/borda-tabelas';
import { lerComposicaoDespesas } from '@/lib/financeiro/dre-borda';
import {
  pontoEquilibrio,
  somaCodigosPorPrefixo,
  despesasNoDRE,
  type MesDRE,
  type TipoCusto,
  type CustoCompartilhado,
  type PontoEquilibrioResult,
} from '@/lib/financeiro/ponto-equilibrio-helpers';

const STALE = 5 * 60_000; // snapshot e classificação mudam raramente

/** Prefixo omie dos códigos de folha/pessoal (Salários, FGTS, INSS, VA, férias… todos 2.03.*). */
const FAMILIA_FOLHA = ['2.03'];

/** Empresas cuja folha roda em OUTRA empresa do grupo → o PE exige rateio (§4 da spec F3 v2). */
export const EMPRESAS_COM_FOLHA_EXTERNA: Record<string, { origem: string; rotulo: string }> = {
  oben: { origem: 'colacor_sc', rotulo: 'folha' },
};

export interface CustoRateioRow {
  company: string;
  rotulo: string;
  valor_mensal_brl: number;
  origem_company: string;
  observacao: string;
  ativo: boolean;
  updated_at: string;
}

export type { CustoTipoRow };

/** Colunas da DRE que o ponto de equilíbrio soma: NULL LANÇA (ausente ≠ zero; em prod são 0 NULL). */
const COLUNAS_PE = [
  'receita_bruta', 'deducoes', 'cmv', 'despesas_operacionais', 'despesas_administrativas',
  'despesas_comerciais', 'despesas_financeiras',
] as const;

/** Últimos 12 snapshots de DRE (competência), mapeados p/ MesDRE. */
function useSnapshotsTTM(company: string | null) {
  return useQuery({
    queryKey: ['dre_snapshots_ttm', company],
    enabled: Boolean(company),
    staleTime: STALE,
    queryFn: async (): Promise<MesDRE[]> => {
      const { data, error } = await supabase
        .from('fin_dre_snapshots')
        .select(
          'ano,mes,receita_bruta,deducoes,cmv,despesas_operacionais,despesas_administrativas,despesas_comerciais,despesas_financeiras,detalhamento,resultado_provisorio',
        )
        .eq('company', company!)
        .eq('regime', 'competencia')
        .order('ano', { ascending: false })
        .order('mes', { ascending: false })
        .limit(12);
      if (error) throw error;
      return (data ?? []).map((row): MesDRE => {
        const onde = `fin_dre_snapshots ${company} ${row.ano}-${row.mes}`;
        exigirColunas(row, COLUNAS_PE, onde);
        // Só o que o PE lê do jsonb: despesas (obrigatório, R$ por código) e a composição (opcional).
        const detalhamento: ObjetoJson = objeto(row.detalhamento, `${onde}.detalhamento`);
        return {
          ano: row.ano,
          mes: row.mes,
          receita_bruta: row.receita_bruta,
          deducoes_col: row.deducoes,
          despesas: registro(numero)(detalhamento.despesas, `${onde}.detalhamento.despesas`),
          linha_cmv: row.cmv,
          linha_operacionais: row.despesas_operacionais,
          linha_administrativas: row.despesas_administrativas,
          linha_comerciais: row.despesas_comerciais,
          linha_financeiras: row.despesas_financeiras,
          composicao_despesas: lerComposicaoDespesas(
            detalhamento.composicao_despesas,
            `${onde}.detalhamento.composicao_despesas`,
          ),
          resultado_provisorio: row.resultado_provisorio,
        };
      });
    },
  });
}

/** Linhas da classificação (company + _default, company vence). fin_dre_custo_tipo é master-only. */
function useClassificacaoRows(company: string | null) {
  return useQuery({
    queryKey: ['dre_custo_tipo', company],
    enabled: Boolean(company),
    staleTime: STALE,
    queryFn: async (): Promise<CustoTipoRow[]> => {
      const { data, error } = await supabase
        .from('fin_dre_custo_tipo')
        .select('company,categoria_codigo,tipo,observacao')
        .in('company', [company!, '_default']);
      if (error) throw new Error(error.message);
      return (data ?? []).map(paraCustoTipo);
    },
  });
}

/** Resolve as linhas em Record<codigo, tipo> (company específico sobrepõe _default). */
function resolverClassificacao(rows: CustoTipoRow[], company: string | null): Record<string, TipoCusto> {
  const out: Record<string, TipoCusto> = {};
  for (const r of rows) if (r.company === '_default') out[r.categoria_codigo] = r.tipo;
  for (const r of rows) if (r.company === company) out[r.categoria_codigo] = r.tipo; // sobrepõe
  return out;
}

/** Linha ativa de rateio (company + rotulo). fin_custo_rateio é master-only (RLS). */
function useCustoRateio(company: string | null, rotulo: string) {
  return useQuery({
    queryKey: ['custo_rateio', company, rotulo],
    enabled: Boolean(company),
    staleTime: STALE,
    queryFn: async (): Promise<CustoRateioRow | null> => {
      const { data, error } = await supabase
        .from('fin_custo_rateio')
        .select('company,rotulo,valor_mensal_brl,origem_company,observacao,ativo,updated_at')
        .eq('company', company!)
        .eq('rotulo', rotulo)
        .eq('ativo', true)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data ?? null;
    },
  });
}

/** Hook principal: o resultado do ponto de equilíbrio (ou o motivo de degradação). */
export function usePontoEquilibrio(company: string | null) {
  const politica = company ? EMPRESAS_COM_FOLHA_EXTERNA[company] : undefined;
  const snaps = useSnapshotsTTM(company);
  const classif = useClassificacaoRows(company);
  const rateioQ = useCustoRateio(company, politica?.rotulo ?? 'folha');
  const isLoading = snaps.isLoading || classif.isLoading || (Boolean(politica) && rateioQ.isLoading);
  const error = snaps.error ?? classif.error ?? rateioQ.error;

  const data = useMemo<PontoEquilibrioResult | null>(() => {
    if (!snaps.data || !classif.data) return null;
    const row = rateioQ.data ?? null;
    const custoCompartilhado: CustoCompartilhado | null = row
      ? { valor_mensal: Number(row.valor_mensal_brl), origem: row.origem_company, rotulo: row.rotulo }
      : null;
    return pontoEquilibrio({
      meses: snaps.data,
      classificacao: resolverClassificacao(classif.data, company),
      custoCompartilhado,
      exigeCustoCompartilhado: Boolean(politica),
      custoCompartilhadoNoSnapshotTtm: somaCodigosPorPrefixo(snaps.data, FAMILIA_FOLHA),
    });
  }, [snaps.data, classif.data, rateioQ.data, company, politica]);

  return { data, isLoading, error, meses: snaps.data ?? [], rateio: rateioQ.data ?? null };
}

export interface CategoriaClassificar {
  codigo: string;
  descricao: string;
  valorTTM: number;
  pctDespesas: number;
  tipo: TipoCusto | null;
  observacao: string | null;
}

/** Lista rankeada (maior valor primeiro) das categorias de despesa p/ o master classificar. */
export function useDreCategoriasClassificar(company: string | null): {
  categorias: CategoriaClassificar[];
  isLoading: boolean;
} {
  const snaps = useSnapshotsTTM(company);
  const classif = useClassificacaoRows(company);
  const cats = useQuery({
    queryKey: ['fin_categorias_desc', company],
    enabled: Boolean(company),
    staleTime: STALE,
    queryFn: async (): Promise<Record<string, string>> => {
      const { data, error } = await supabase
        .from('fin_categorias')
        .select('omie_codigo,descricao')
        .eq('company', company!);
      if (error) throw error;
      const out: Record<string, string> = {};
      for (const r of data ?? []) {
        if (r.omie_codigo) out[r.omie_codigo] = r.descricao ?? '';
      }
      return out;
    },
  });

  const categorias = useMemo<CategoriaClassificar[]>(() => {
    if (!snaps.data) return [];
    const porCodigo = new Map<string, number>();
    for (const m of snaps.data) for (const [cod, v] of Object.entries(m.despesas)) porCodigo.set(cod, (porCodigo.get(cod) ?? 0) + v);
    const total = [...porCodigo.values()].reduce((a, b) => a + b, 0);
    const tipoDe = new Map<string, { tipo: TipoCusto; observacao: string | null }>();
    for (const r of classif.data ?? []) if (r.company === '_default') tipoDe.set(r.categoria_codigo, { tipo: r.tipo, observacao: r.observacao });
    for (const r of classif.data ?? []) if (r.company === company) tipoDe.set(r.categoria_codigo, { tipo: r.tipo, observacao: r.observacao });
    const descPorCod = cats.data ?? {};
    return [...porCodigo.entries()]
      .map(([codigo, valorTTM]) => ({
        codigo,
        descricao: descPorCod[codigo] ?? '',
        valorTTM,
        pctDespesas: total > 0 ? valorTTM / total : 0,
        tipo: tipoDe.get(codigo)?.tipo ?? null,
        observacao: tipoDe.get(codigo)?.observacao ?? null,
      }))
      .sort((a, b) => b.valorTTM - a.valorTTM);
  }, [snaps.data, classif.data, cats.data, company]);

  return { categorias, isLoading: snaps.isLoading || classif.isLoading || cats.isLoading };
}

/** Salva (upsert) a classificação de uma categoria. Master-only (RLS). updated_by/at pelo trigger. */
export function useSalvarDreClassificacao() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      company: string;
      categoria_codigo: string;
      tipo: TipoCusto;
      observacao?: string | null;
    }) => {
      const { error } = await supabase.from('fin_dre_custo_tipo').upsert(
        {
          company: vars.company,
          categoria_codigo: vars.categoria_codigo,
          tipo: vars.tipo,
          observacao: vars.observacao ?? null,
        },
        { onConflict: 'company,categoria_codigo' },
      );
      if (error) throw error;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['dre_custo_tipo', vars.company] });
      qc.invalidateQueries({ queryKey: ['fin_categorias_desc', vars.company] });
      toast.success('Classificação salva. Recalculando o ponto de equilíbrio…');
    },
    onError: (e) => {
      toast.error('Falha ao salvar classificação', {
        description: mensagemDeErro(e) ?? 'Erro sem mensagem — tente de novo ou avise a equipe.',
      });
    },
  });
}

/** Salva (upsert) o rateio de custo compartilhado. Master-only (RLS). updated_by/at pelo trigger. */
export function useSalvarCustoRateio() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      company: string;
      rotulo: string;
      valor_mensal_brl: number;
      origem_company: string;
      observacao: string;
      ativo?: boolean;
    }) => {
      const { error } = await supabase.from('fin_custo_rateio').upsert(
        {
          company: vars.company,
          rotulo: vars.rotulo,
          valor_mensal_brl: vars.valor_mensal_brl,
          origem_company: vars.origem_company,
          observacao: vars.observacao,
          ativo: vars.ativo ?? true,
        },
        { onConflict: 'company,rotulo' },
      );
      if (error) throw error;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['custo_rateio', vars.company, vars.rotulo] });
      toast.success('Rateio salvo. Recalculando o ponto de equilíbrio…');
    },
    onError: (e) => {
      toast.error('Falha ao salvar o rateio', { description: mensagemDeErro(e) ?? 'Erro sem mensagem — tente de novo ou avise a equipe.' });
    },
  });
}

export interface FolhaRefLinha {
  codigo: string;
  descricao: string;
  mediaMes: number;
  ambiguo: boolean;
}
/**
 * Retenções do empregado — INSS (2.03.06) e IRRF (2.03.08) — já embutidas no Salário bruto (2.03.01),
 * NÃO custo patronal extra (a CSC é Simples: sem INSS patronal; o lançado é a parte retida do funcionário).
 * Somá-las ao bruto dobraria → o `totalLimpoMes` do dialog as exclui. NÃO inclui o Adiantamento (2.03.02):
 * é a 2ª parcela do MESMO salário (dados de prod, Codex+Claude 2026-07-09), logo custo real.
 * Pinado em `ponto-equilibrio-folha-ambigua.test.ts`.
 */
export const FOLHA_AMBIGUA = new Set(['2.03.06', '2.03.08']);

/** Composição da folha (2.03.*) da empresa de origem, TTM, p/ o dialog dimensionar o rateio (referência, não input). */
export function useFolhaReferencia(origem: string): {
  linhas: FolhaRefLinha[];
  totalMes: number;
  totalLimpoMes: number;
  isLoading: boolean;
} {
  const snaps = useSnapshotsTTM(origem);
  const cats = useQuery({
    queryKey: ['fin_categorias_desc', origem],
    enabled: Boolean(origem),
    staleTime: STALE,
    queryFn: async (): Promise<Record<string, string>> => {
      const { data, error } = await supabase.from('fin_categorias').select('omie_codigo,descricao').eq('company', origem);
      if (error) throw error;
      const out: Record<string, string> = {};
      for (const r of data ?? [])
        if (r.omie_codigo) out[r.omie_codigo] = r.descricao ?? '';
      return out;
    },
  });

  const agg = useMemo(() => {
    if (!snaps.data) return { linhas: [] as FolhaRefLinha[], totalMes: 0, totalLimpoMes: 0 };
    const n = snaps.data.length || 1;
    const porCod = new Map<string, number>();
    for (const m of snaps.data)
      for (const [cod, v] of Object.entries(despesasNoDRE(m)))
        if (FAMILIA_FOLHA.some((p) => cod.startsWith(p))) porCod.set(cod, (porCod.get(cod) ?? 0) + v);
    const desc = cats.data ?? {};
    const linhas = [...porCod.entries()]
      .map(([codigo, ttm]) => ({
        codigo,
        descricao: desc[codigo] ?? '',
        mediaMes: ttm / n,
        ambiguo: FOLHA_AMBIGUA.has(codigo),
      }))
      .sort((a, b) => b.mediaMes - a.mediaMes);
    const totalMes = linhas.reduce((s, l) => s + l.mediaMes, 0);
    const totalLimpoMes = linhas.reduce((s, l) => s + (l.ambiguo ? 0 : l.mediaMes), 0);
    return { linhas, totalMes, totalLimpoMes };
  }, [snaps.data, cats.data]);

  return { ...agg, isLoading: snaps.isLoading || cats.isLoading };
}
